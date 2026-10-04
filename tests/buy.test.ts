import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';

const STOCK = 20;
const app = buildServer({ logger: false });

const buyAs = (userId: string) => app.inject({ method: 'POST', url: '/buy', payload: { userId } });
const cancelAs = (holdId: string, userId: string) =>
  app.inject({ method: 'DELETE', url: `/holds/${holdId}`, payload: { userId } });

async function stock() {
  const { rows } = await pool.query('SELECT * FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
  return { held: Number(rows[0].held), sold: Number(rows[0].sold), available: Number(rows[0].available) };
}

/** Simulate a successful payment (Phase 5 does this via webhook). */
async function markPaid(holdId: string) {
  await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [holdId]);
}

/** Push a hold's deadline into the past without waiting 5 minutes. */
async function backdate(holdId: string) {
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [holdId]);
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

describe('POST /buy', () => {
  it('creates a 5 minute hold', async () => {
    const res = await buyAs('alice');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'active', holdId: expect.any(String) });
    // measured against the DB clock (the one the app uses), not this machine's
    const { rows } = await pool.query('SELECT extract(epoch FROM expires_at - now())::float AS s FROM holds WHERE id = $1', [body.holdId]);
    const secondsLeft = rows[0].s;
    expect(secondsLeft).toBeGreaterThan(290);
    expect(secondsLeft).toBeLessThanOrEqual(301);
    expect(await stock()).toEqual({ held: 1, sold: 0, available: STOCK - 1 });
  });

  it('rejects missing / blank userId with 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/buy', payload: {} })).statusCode).toBe(400);
    expect((await buyAs('   ')).statusCode).toBe(400);
  });

  it('unknown product -> 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/buy', payload: { userId: 'a', productId: 'nope' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PRODUCT_NOT_FOUND');
  });

  it('second buy while holding -> 409 ALREADY_HOLDING with existing hold', async () => {
    const first = (await buyAs('alice')).json();
    const res = await buyAs('alice');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'ALREADY_HOLDING', holdId: first.holdId });
  });

  it('same user clicking 50 times at once gets exactly one hold', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => buyAs('spammer')));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(49);
    expect(await stock()).toMatchObject({ held: 1 });
  });

  it('max 2 pairs per person: third purchase blocked', async () => {
    const h1 = (await buyAs('bob')).json();
    await markPaid(h1.holdId);
    const h2 = (await buyAs('bob')).json();
    await markPaid(h2.holdId);

    const res = await buyAs('bob');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('LIMIT_REACHED');
    expect(await stock()).toEqual({ held: 0, sold: 2, available: STOCK - 2 });
  });

  it('cancelled / expired holds do not count toward the limit', async () => {
    const h1 = (await buyAs('bob')).json();
    await markPaid(h1.holdId);
    const h2 = (await buyAs('bob')).json();
    await cancelAs(h2.holdId, 'bob');
    const h3 = (await buyAs('bob')).json();
    await backdate(h3.holdId);
    expect((await buyAs('bob')).statusCode).toBe(201);
  });

  it('when sold out returns soldOut + canJoinWaitlist', async () => {
    await Promise.all(Array.from({ length: STOCK }, (_, i) => buyAs(`u${i}`)));
    const res = await buyAs('late');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ soldOut: true, canJoinWaitlist: true });
  });

  it('after sell-out, holder / limit-reached user still get their own answer (not soldOut)', async () => {
    await pool.query('UPDATE products SET total_stock = 2, max_per_user = 1 WHERE id = $1', [PRODUCT_ID]);
    const a = (await buyAs('holder')).json();
    const b = (await buyAs('payer')).json();
    await markPaid(b.holdId);
    expect((await buyAs('holder')).json()).toMatchObject({ error: 'ALREADY_HOLDING', holdId: a.holdId });
    expect((await buyAs('payer')).json()).toMatchObject({ error: 'LIMIT_REACHED' });
    expect((await buyAs('nobody')).json()).toEqual({ soldOut: true, canJoinWaitlist: true });
  });

  it('lazily expires stale holds so their pairs can be bought', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const stale = (await buyAs('slowpoke')).json();
    expect((await buyAs('alice')).json()).toMatchObject({ soldOut: true });

    await backdate(stale.holdId);
    expect((await buyAs('alice')).statusCode).toBe(201);

    const { rows } = await pool.query('SELECT status FROM holds WHERE id = $1', [stale.holdId]);
    expect(rows[0].status).toBe('expired');
  });

  it('user whose hold expired can buy again', async () => {
    const h = (await buyAs('alice')).json();
    await backdate(h.holdId);
    expect((await buyAs('alice')).statusCode).toBe(201);
  });

  it('5000 different users at once -> exactly 20 holds, never oversold', async () => {
    const N = 5000;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => buyAs(`crowd-${i}`)));

    const held = results.filter((r) => r.statusCode === 201);
    const soldOut = results.filter((r) => r.statusCode === 200 && r.json().soldOut === true);
    expect(held).toHaveLength(STOCK);
    expect(soldOut).toHaveLength(N - STOCK);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });

    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS users FROM holds WHERE status = 'active'`,
    );
    expect(rows[0].users).toBe(STOCK);
  }, 120_000);
});

describe('DELETE /holds/:id', () => {
  it('owner cancels -> pair returns to stock', async () => {
    const h = (await buyAs('alice')).json();
    const res = await cancelAs(h.holdId, 'alice');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ holdId: h.holdId, status: 'cancelled' });
    expect(await stock()).toEqual({ held: 0, sold: 0, available: STOCK });
  });

  it('freed pair is immediately buyable when sold out', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const h = (await buyAs('alice')).json();
    expect((await buyAs('bob')).json()).toMatchObject({ soldOut: true });
    await cancelAs(h.holdId, 'alice');
    expect((await buyAs('bob')).statusCode).toBe(201);
  });

  it("someone else's hold -> 404 (no probing)", async () => {
    const h = (await buyAs('alice')).json();
    const res = await cancelAs(h.holdId, 'mallory');
    expect(res.statusCode).toBe(404);
    expect(await stock()).toMatchObject({ held: 1 });
  });

  it('unknown / malformed id -> 404 / 400', async () => {
    expect((await cancelAs('00000000-0000-0000-0000-000000000000', 'alice')).statusCode).toBe(404);
    expect((await cancelAs('not-a-uuid', 'alice')).statusCode).toBe(400);
  });

  it('cancel twice -> 409 HOLD_NOT_ACTIVE', async () => {
    const h = (await buyAs('alice')).json();
    await cancelAs(h.holdId, 'alice');
    const res = await cancelAs(h.holdId, 'alice');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'HOLD_NOT_ACTIVE', status: 'cancelled' });
  });

  it('cancel after deadline -> 409 HOLD_EXPIRED', async () => {
    const h = (await buyAs('alice')).json();
    await backdate(h.holdId);
    const res = await cancelAs(h.holdId, 'alice');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('HOLD_EXPIRED');
  });

  it('cannot cancel a paid hold', async () => {
    const h = (await buyAs('alice')).json();
    await markPaid(h.holdId);
    const res = await cancelAs(h.holdId, 'alice');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'HOLD_NOT_ACTIVE', status: 'paid' });
  });
});
