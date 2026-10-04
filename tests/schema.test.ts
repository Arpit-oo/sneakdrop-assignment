import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';

const STOCK = 20;

async function insertHold(userId: string) {
  return pool.query(
    `INSERT INTO holds (product_id, user_id, expires_at)
     VALUES ($1, $2, now() + interval '5 minutes') RETURNING id`,
    [PRODUCT_ID, userId],
  );
}

async function stock() {
  const { rows } = await pool.query('SELECT * FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
  return { held: Number(rows[0].held), sold: Number(rows[0].sold), available: Number(rows[0].available) };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await resetSale();
  await seed();
  await pool.query('UPDATE products SET total_stock = $1, max_per_user = 2 WHERE id = $2', [STOCK, PRODUCT_ID]);
});

afterAll(async () => {
  await pool.end();
});

describe('schema invariants (database-level safety net)', () => {
  it('migrations are idempotent', async () => {
    expect(await migrate()).toEqual([]);
  });

  it('starts with full stock', async () => {
    expect(await stock()).toEqual({ held: 0, sold: 0, available: STOCK });
  });

  it('never oversells: 500 concurrent raw inserts yield exactly 20 holds', async () => {
    const results = await Promise.allSettled(Array.from({ length: 500 }, (_, i) => insertHold(`user-${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const soldOut = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { hint?: string }).hint === 'SOLD_OUT',
    ).length;

    expect(ok).toBe(STOCK);
    expect(soldOut).toBe(500 - STOCK);
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
  });

  it('a user can have only one active hold', async () => {
    await insertHold('alice');
    await expect(insertHold('alice')).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('same user racing 50 inserts gets exactly one active hold', async () => {
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => insertHold('bob')));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });

  it('a user can own at most max_per_user pairs (paid + active)', async () => {
    for (let i = 0; i < 2; i++) {
      const { rows } = await insertHold('carol');
      await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [rows[0].id]);
    }
    await expect(insertHold('carol')).rejects.toMatchObject({ hint: 'LIMIT_REACHED' });
  });

  it('active -> paid does not consume extra stock', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const { rows } = await insertHold('dave');
    await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [rows[0].id]);
    expect(await stock()).toEqual({ held: 0, sold: 1, available: 0 });
  });

  it('expired hold returns pair to stock, and cannot be revived when stock is gone', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const { rows } = await insertHold('erin');
    await pool.query(`UPDATE holds SET status = 'expired', released_at = now() WHERE id = $1`, [rows[0].id]);
    expect((await stock()).available).toBe(1);

    await insertHold('frank'); // takes the freed pair
    await expect(
      pool.query(`UPDATE holds SET status = 'paid', paid_at = now(), released_at = NULL WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ hint: 'SOLD_OUT' });
  });

  it('status/timestamp consistency is enforced', async () => {
    const { rows } = await insertHold('gina');
    await expect(pool.query(`UPDATE holds SET status = 'paid' WHERE id = $1`, [rows[0].id])).rejects.toMatchObject({
      code: '23514', // check_violation: paid without paid_at
    });
  });

  it('one waiting-line entry per user; FIFO ids', async () => {
    const a = await pool.query(`INSERT INTO waitlist (product_id, user_id) VALUES ($1, 'u1') RETURNING id`, [PRODUCT_ID]);
    const b = await pool.query(`INSERT INTO waitlist (product_id, user_id) VALUES ($1, 'u2') RETURNING id`, [PRODUCT_ID]);
    expect(Number(b.rows[0].id)).toBeGreaterThan(Number(a.rows[0].id));
    await expect(
      pool.query(`INSERT INTO waitlist (product_id, user_id) VALUES ($1, 'u1')`, [PRODUCT_ID]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('duplicate webhook event_id is a no-op', async () => {
    const insert = () =>
      pool.query(
        `INSERT INTO payment_events (event_id, payment_id, type, payload)
         VALUES ('evt_1', 'pay_1', 'payment.succeeded', '{}') ON CONFLICT (event_id) DO NOTHING`,
      );
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0);
  });

  it('one order per hold and per payment', async () => {
    const { rows } = await insertHold('hank');
    await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [rows[0].id]);
    const order = (payment: string) =>
      pool.query(
        `INSERT INTO orders (hold_id, product_id, user_id, payment_id, amount_cents) VALUES ($1, $2, 'hank', $3, 19900)`,
        [rows[0].id, PRODUCT_ID, payment],
      );
    await order('pay_a');
    await expect(order('pay_b')).rejects.toMatchObject({ code: '23505' });
  });
});
