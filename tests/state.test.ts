import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';
import type { SaleState } from '../src/domain/state.js';

const STOCK = 20;
const app = buildServer({ logger: false });
let base = '';

const buyAs = async (userId: string) => (await app.inject({ method: 'POST', url: '/buy', payload: { userId } })).json();
const stateOf = async (userId: string) =>
  (await app.inject({ method: 'GET', url: `/state?userId=${userId}` })).json() as SaleState;

/** Read SSE "state" events from /events as they arrive. */
async function openStream(userId: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/events?userId=${userId}`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    res,
    async next(timeoutMs = 3000): Promise<SaleState> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (chunk.includes('event: state') && data) return JSON.parse(data.slice(6));
          continue;
        }
        if (Date.now() > deadline) throw new Error('no SSE event in time');
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no SSE event in time')), deadline - Date.now())),
        ]);
        if (done) throw new Error('stream closed');
        buf += decoder.decode(value, { stream: true });
      }
    },
    close: () => ctrl.abort(),
  };
}

beforeAll(async () => {
  await migrate();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
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

describe('GET /', () => {
  it('serves the status page', async () => {
    const res = await app.inject({ method: 'GET', url: '/?user=alice' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('sneakdrop');
  });
});

describe('GET /state', () => {
  it('fresh sale', async () => {
    const s = await stateOf('alice');
    expect(s.product).toMatchObject({ total: STOCK, held: 0, sold: 0, available: STOCK, waiting: 0, maxPerUser: 2 });
    expect(s.me).toEqual({ userId: 'alice', hold: null, bought: 0, position: null, lastPayment: null });
    expect(Date.parse(s.serverTime)).not.toBeNaN();
  });

  it('shows my hold, others only as counts', async () => {
    const h = await buyAs('alice');
    await buyAs('bob');
    const s = await stateOf('alice');
    expect(s.product).toMatchObject({ held: 2, available: STOCK - 2 });
    expect(s.me.hold).toMatchObject({ id: h.holdId, source: 'direct' });
    expect((await stateOf('carol')).me.hold).toBeNull();
  });

  it('place in line + bought count + last payment', async () => {
    for (let i = 0; i < STOCK; i++) await buyAs(`h${i}`);
    await app.inject({ method: 'POST', url: '/waitlist', payload: { userId: 'w1' } });
    await app.inject({ method: 'POST', url: '/waitlist', payload: { userId: 'w2' } });
    expect((await stateOf('w2')).me.position).toBe(2);
    expect((await stateOf('w2')).product.waiting).toBe(2);

    const { rows } = await pool.query(`SELECT id FROM holds WHERE user_id = 'h0'`);
    await pool.query(`UPDATE holds SET status = 'paid', paid_at = now() WHERE id = $1`, [rows[0].id]);
    await pool.query(
      `INSERT INTO payment_events (event_id, payment_id, hold_id, type, payload, outcome)
       VALUES ('e1', 'p1', $1, 'payment.succeeded', '{}', 'paid')`,
      [rows[0].id],
    );
    const s = await stateOf('h0');
    expect(s.me.bought).toBe(1);
    expect(s.me.lastPayment).toMatchObject({ holdId: rows[0].id, type: 'payment.succeeded', outcome: 'paid' });
  });

  it('overdue hold is not shown even before the worker sweeps it', async () => {
    const h = await buyAs('alice');
    await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.holdId]);
    const s = await stateOf('alice');
    expect(s.me.hold).toBeNull();
    expect(s.product.available).toBe(STOCK);
  });

  it('missing userId -> 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/state' })).statusCode).toBe(400);
  });
});

describe('GET /events (SSE)', () => {
  it('sends state on connect, then pushes when anything changes', async () => {
    const stream = await openStream('alice');
    try {
      expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
      const first = await stream.next();
      expect(first.product.available).toBe(STOCK);

      await buyAs('bob'); // someone else's action -> alice's page updates
      let s = await stream.next();
      while (s.product.available !== STOCK - 1) s = await stream.next();
      expect(s.me.hold).toBeNull();

      await buyAs('alice');
      s = await stream.next();
      while (!s.me.hold) s = await stream.next();
      expect(s.product.available).toBe(STOCK - 2);
    } finally {
      stream.close();
    }
  });

  it('push arrives for writes made by a different process (raw SQL, NOTIFY trigger)', async () => {
    const stream = await openStream('alice');
    try {
      await stream.next();
      await pool.query(
        `INSERT INTO holds (product_id, user_id, expires_at) VALUES ($1, 'elsewhere', now() + interval '5 minutes')`,
        [PRODUCT_ID],
      );
      let s = await stream.next();
      while (s.product.held !== 1) s = await stream.next();
      expect(s.product.available).toBe(STOCK - 1);
    } finally {
      stream.close();
    }
  });
});
