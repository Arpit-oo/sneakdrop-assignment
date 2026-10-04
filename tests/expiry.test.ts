import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';
import { buy } from '../src/domain/holds.js';
import { expireDue, startExpiryWorker } from '../src/workers/expiry.js';

const STOCK = 20;

async function stock() {
  const { rows } = await pool.query('SELECT * FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
  return { held: Number(rows[0].held), sold: Number(rows[0].sold), available: Number(rows[0].available) };
}

async function holdFor(userId: string): Promise<string> {
  const r = await buy(userId, PRODUCT_ID);
  if (r.kind !== 'held') throw new Error('expected hold');
  return r.hold.id;
}

const backdate = (id: string) =>
  pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

const statusOf = async (id: string) =>
  (await pool.query('SELECT status, released_at FROM holds WHERE id = $1', [id])).rows[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await migrate();
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
  await pool.end();
});

describe('expireDue (one sweep)', () => {
  it('does nothing when no hold is overdue', async () => {
    await holdFor('alice');
    expect(await expireDue()).toBe(0);
    expect(await stock()).toMatchObject({ held: 1 });
  });

  it('expires only overdue active holds and returns their pairs', async () => {
    const late1 = await holdFor('a');
    const late2 = await holdFor('b');
    const fresh = await holdFor('c');
    await Promise.all([backdate(late1), backdate(late2)]);

    expect(await expireDue()).toBe(2);
    expect(await statusOf(late1)).toMatchObject({ status: 'expired', released_at: expect.any(Date) });
    expect((await statusOf(fresh)).status).toBe('active');
    expect(await stock()).toEqual({ held: 1, sold: 0, available: STOCK - 1 });
  });

  it('never touches paid holds, even past their deadline', async () => {
    const id = await holdFor('alice');
    await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [id]);
    await backdate(id);
    expect(await expireDue()).toBe(0);
    expect((await statusOf(id)).status).toBe('paid');
  });

  it('5 workers sweeping at once expire each hold exactly once', async () => {
    const ids = await Promise.all(Array.from({ length: STOCK }, (_, i) => holdFor(`u${i}`)));
    await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second'`);

    const counts = await Promise.all(Array.from({ length: 5 }, () => expireDue()));
    // first sweep may be skipped by others (SKIP LOCKED), so a follow-up mops up
    const total = counts.reduce((a, b) => a + b, 0) + (await expireDue());
    expect(total).toBe(ids.length);
    expect(await stock()).toEqual({ held: 0, sold: 0, available: STOCK });
  });

  it('skips a product a buyer is currently locking, catches it next sweep', async () => {
    const id = await holdFor('alice');
    await backdate(id);

    const buyer = await pool.connect();
    try {
      await buyer.query('BEGIN');
      await buyer.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [PRODUCT_ID]);
      expect(await expireDue()).toBe(0); // returns immediately, does not block
      await buyer.query('COMMIT');
    } finally {
      buyer.release();
    }

    expect(await expireDue()).toBe(1);
    expect((await statusOf(id)).status).toBe('expired');
  });
});

describe('startExpiryWorker (background loop)', () => {
  it('with 1s holds: hold expires and stock returns without any request', async () => {
    await pool.query('UPDATE products SET hold_seconds = 1 WHERE id = $1', [PRODUCT_ID]);
    const id = await holdFor('alice');
    expect(await stock()).toMatchObject({ held: 1, available: STOCK - 1 });

    let expired = 0;
    const worker = startExpiryWorker({ intervalMs: 100, onExpired: (n) => (expired += n) });
    try {
      for (let i = 0; i < 40 && expired === 0; i++) await sleep(100);
    } finally {
      await worker.stop();
    }

    expect(expired).toBe(1);
    expect((await statusOf(id)).status).toBe('expired');
    expect(await stock()).toEqual({ held: 0, sold: 0, available: STOCK });
  });

  it('survives a failing sweep and keeps running', async () => {
    const errors: unknown[] = [];
    let expired = 0;
    // break the next sweep by renaming the table out from under it, then restore
    await pool.query('ALTER TABLE holds RENAME TO holds_tmp');
    const worker = startExpiryWorker({
      intervalMs: 50,
      onError: (e) => errors.push(e),
      onExpired: (n) => (expired += n),
    });
    try {
      for (let i = 0; i < 40 && errors.length === 0; i++) await sleep(50);
      await pool.query('ALTER TABLE holds_tmp RENAME TO holds');
      const id = await holdFor('alice');
      await backdate(id);
      for (let i = 0; i < 40 && expired === 0; i++) await sleep(50);
    } finally {
      await worker.stop();
      await pool.query('ALTER TABLE IF EXISTS holds_tmp RENAME TO holds');
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(expired).toBe(1);
  });

  it('stop() waits for an in-flight sweep and stops scheduling', async () => {
    const worker = startExpiryWorker({ intervalMs: 10 });
    await sleep(50);
    await worker.stop();
    const id = await holdFor('alice');
    await backdate(id);
    await sleep(100);
    expect((await statusOf(id)).status).toBe('active');
  });
});
