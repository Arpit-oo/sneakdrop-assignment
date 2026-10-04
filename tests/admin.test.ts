import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';

const TOKEN = 'test-admin-token-123456';
const app = buildServer({ logger: false, adminToken: TOKEN });
const noAdmin = buildServer({ logger: false, adminToken: undefined });

const reset = (body: object, token?: string) =>
  app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });

beforeAll(async () => {
  await migrate();
  await Promise.all([app.ready(), noAdmin.ready()]);
});

beforeEach(async () => {
  await resetSale();
  await seed();
  await pool.query('UPDATE products SET total_stock = 20, hold_seconds = 300, max_per_user = 2 WHERE id = $1', [PRODUCT_ID]);
});

afterAll(async () => {
  await Promise.all([app.close(), noAdmin.close()]);
  await pool.end();
});

describe('POST /admin/reset', () => {
  it('does not exist without ADMIN_TOKEN', async () => {
    expect((await noAdmin.inject({ method: 'POST', url: '/admin/reset', payload: {} })).statusCode).toBe(404);
  });

  it('rejects missing or wrong token', async () => {
    expect((await reset({})).statusCode).toBe(401);
    expect((await reset({}, 'wrong-token-wrong-token')).statusCode).toBe(401);
  });

  it('wipes the sale and applies new rules', async () => {
    await app.inject({ method: 'POST', url: '/buy', payload: { userId: 'alice' } });
    const res = await reset({ stock: 2, holdSeconds: 30 }, TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reset: true, stock: 2, holdSeconds: 30, maxPerUser: 2 });
    const { rows } = await pool.query('SELECT held::int, sold::int, available::int FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
    expect(rows[0]).toEqual({ held: 0, sold: 0, available: 2 });
  });

  it('validates rules', async () => {
    expect((await reset({ stock: 0 }, TOKEN)).statusCode).toBe(400);
    expect((await reset({ holdSeconds: 1 }, TOKEN)).statusCode).toBe(400);
  });
});
