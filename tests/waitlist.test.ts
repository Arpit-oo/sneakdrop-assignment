import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';
import { expireDue } from '../src/workers/expiry.js';

const STOCK = 20;
const app = buildServer({ logger: false });

const buyAs = (userId: string) => app.inject({ method: 'POST', url: '/buy', payload: { userId } });
const joinAs = (userId: string) => app.inject({ method: 'POST', url: '/waitlist', payload: { userId } });
const leaveAs = (userId: string) => app.inject({ method: 'DELETE', url: '/waitlist', payload: { userId } });
const cancelAs = (holdId: string, userId: string) =>
  app.inject({ method: 'DELETE', url: `/holds/${holdId}`, payload: { userId } });
const positionOf = async (userId: string) => {
  const res = await app.inject({ method: 'GET', url: `/waitlist/position?userId=${userId}` });
  return res.statusCode === 200 ? (res.json().position as number) : undefined;
};

const backdate = (holdId: string) =>
  pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [holdId]);
const markPaid = (holdId: string) =>
  pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [holdId]);

/** Active hold of user, if any. */
async function activeHold(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, source FROM holds WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows[0] as { id: string; source: string } | undefined;
}

async function entry(userId: string) {
  const { rows } = await pool.query(
    `SELECT status, left_reason, promoted_hold_id FROM waitlist WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows[0];
}

async function stock() {
  const { rows } = await pool.query('SELECT * FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
  return { held: Number(rows[0].held), sold: Number(rows[0].sold), available: Number(rows[0].available) };
}

/** Sell out: one hold per user h0..h19. Returns hold ids by user. */
async function sellOut(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (let i = 0; i < STOCK; i++) ids[`h${i}`] = (await buyAs(`h${i}`)).json().holdId;
  return ids;
}

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  await resetSale();
  await seed();
  await pool.query(
    'UPDATE products SET total_stock = $1, max_per_user = 2, hold_seconds = 300 WHERE id = $2',
    [STOCK, PRODUCT_ID],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('joining / leaving the line', () => {
  it('cannot join while pairs are available', async () => {
    const res = await joinAs('alice');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NOT_SOLD_OUT');
  });

  it('join when sold out -> FIFO positions; joining again keeps place', async () => {
    await sellOut();
    expect((await joinAs('a')).json()).toEqual({ position: 1 });
    expect((await joinAs('b')).json()).toEqual({ position: 2 });
    const c = await joinAs('c');
    expect(c.statusCode).toBe(201);
    expect(c.json()).toEqual({ position: 3 });

    const again = await joinAs('a');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ position: 1 });
  });

  it('someone holding a pair cannot join', async () => {
    await sellOut();
    const res = await joinAs('h0');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ALREADY_HOLDING');
  });

  it('someone at the purchase limit cannot join', async () => {
    await pool.query('UPDATE products SET max_per_user = 1 WHERE id = $1', [PRODUCT_ID]);
    const ids = await sellOut();
    await markPaid(ids.h0);
    const res = await joinAs('h0');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('LIMIT_REACHED');
  });

  it('Buy while in line (still sold out) shows place, not a second join offer', async () => {
    await sellOut();
    await joinAs('a');
    await joinAs('b');
    expect((await buyAs('b')).json()).toEqual({ soldOut: true, canJoinWaitlist: false, position: 2 });
  });

  it('leaving moves everyone behind up', async () => {
    await sellOut();
    await joinAs('a');
    await joinAs('b');
    await joinAs('c');
    expect((await leaveAs('a')).statusCode).toBe(200);
    expect(await positionOf('a')).toBeUndefined();
    expect(await positionOf('b')).toBe(1);
    expect(await positionOf('c')).toBe(2);
    expect(await entry('a')).toMatchObject({ status: 'left', left_reason: 'user_left' });
  });

  it('leave when not in line -> 404', async () => {
    const res = await leaveAs('ghost');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_IN_LINE');
  });

  it('200 people join at once -> positions 1..200, no duplicates', async () => {
    await sellOut();
    const res = await Promise.all(Array.from({ length: 200 }, (_, i) => joinAs(`w${i}`)));
    const positions = res.map((r) => r.json().position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
});

describe('promotion (freed pair -> next in line)', () => {
  it('20 held, 3 in line, 2 expire -> first 2 get holds in order, #3 moves to 1', async () => {
    const ids = await sellOut();
    await joinAs('a');
    await joinAs('b');
    await joinAs('c');

    await backdate(ids.h0);
    await backdate(ids.h1);
    expect(await expireDue()).toBe(2);

    expect(await activeHold('a')).toMatchObject({ source: 'waitlist' });
    expect(await activeHold('b')).toMatchObject({ source: 'waitlist' });
    expect(await activeHold('c')).toBeUndefined();
    expect(await positionOf('c')).toBe(1);
    expect(await entry('a')).toMatchObject({ status: 'promoted', promoted_hold_id: (await activeHold('a'))!.id });
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
  });

  it('promoted hold gets a fresh 5 minutes', async () => {
    const ids = await sellOut();
    await joinAs('a');
    await backdate(ids.h0);
    await expireDue();
    const { rows } = await pool.query(
      `SELECT extract(epoch FROM expires_at - now())::int AS secs FROM holds WHERE user_id = 'a'`,
    );
    expect(rows[0].secs).toBeGreaterThan(290);
  });

  it('cancel hands the pair to the line immediately — direct buyer gets nothing', async () => {
    const ids = await sellOut();
    await joinAs('a');
    await cancelAs(ids.h5, 'h5');
    expect(await activeHold('a')).toMatchObject({ source: 'waitlist' });
    expect((await buyAs('sneaky')).json()).toMatchObject({ soldOut: true });
  });

  it('lazy path: buyer arriving after a deadline triggers promotion, line still wins', async () => {
    const ids = await sellOut();
    await joinAs('a');
    await backdate(ids.h0); // no worker run
    expect((await buyAs('sneaky')).json()).toMatchObject({ soldOut: true });
    expect(await activeHold('a')).toMatchObject({ source: 'waitlist' });
  });

  it('promoted user never pays -> hold expires -> next in line', async () => {
    const ids = await sellOut();
    await joinAs('a');
    await joinAs('b');
    await backdate(ids.h0);
    await expireDue();
    const aHold = (await activeHold('a'))!;

    await backdate(aHold.id);
    await expireDue();
    expect(await activeHold('a')).toBeUndefined();
    expect(await activeHold('b')).toMatchObject({ source: 'waitlist' });
  });

  it('line empty -> freed pair goes back to open sale', async () => {
    const ids = await sellOut();
    await cancelAs(ids.h0, 'h0');
    expect(await stock()).toMatchObject({ available: 1 });
    expect((await buyAs('walkin')).statusCode).toBe(201);
  });

  it('skips people who can no longer take a pair, gives it to the next', async () => {
    const ids = await sellOut();
    await pool.query('UPDATE products SET max_per_user = 1 WHERE id = $1', [PRODUCT_ID]);
    await markPaid(ids.h1);
    // Entries that became invalid after joining (inserted directly to simulate)
    await pool.query(
      `INSERT INTO waitlist (product_id, user_id) VALUES ($1, 'h1'), ($1, 'h2'), ($1, 'ok')`,
      [PRODUCT_ID],
    );

    await cancelAs(ids.h0, 'h0');

    expect(await entry('h1')).toMatchObject({ status: 'left', left_reason: 'skipped_limit' });
    expect(await entry('h2')).toMatchObject({ status: 'left', left_reason: 'skipped_holding' });
    expect(await activeHold('ok')).toMatchObject({ source: 'waitlist' });
  });

  it('many pairs freed at once go strictly in line order', async () => {
    await sellOut();
    for (let i = 0; i < 30; i++) await joinAs(`w${i}`);
    await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE status = 'active'`);
    expect(await expireDue()).toBe(STOCK);

    for (let i = 0; i < STOCK; i++) expect(await activeHold(`w${i}`)).toBeDefined();
    for (let i = STOCK; i < 30; i++) expect(await positionOf(`w${i}`)).toBe(i - STOCK + 1);
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
  });

  it('leave racing promotion: entry ends either promoted or left, never both, never lost', async () => {
    for (let round = 0; round < 10; round++) {
      await resetSale();
      const ids = await sellOut();
      await joinAs('a');
      await joinAs('b');
      await Promise.all([leaveAs('a'), cancelAs(ids.h0, 'h0')]);

      const a = await entry('a');
      const aHold = await activeHold('a');
      if (a.status === 'promoted') {
        expect(aHold).toBeDefined();
        expect(await positionOf('b')).toBe(1);
      } else {
        expect(a).toMatchObject({ status: 'left', left_reason: 'user_left' });
        expect(aHold).toBeUndefined();
        expect(await activeHold('b')).toBeDefined();
      }
      expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
    }
  });
});
