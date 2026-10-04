import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';
import { type Chaos, FakePay, planDeliveries } from '../src/fakepay/provider.js';
import type { PaymentEvent } from '../src/payments/events.js';
import { processPendingRefunds } from '../src/domain/refunds.js';
import { SIGNATURE_HEADER, sign, verify } from '../src/payments/signature.js';

const STOCK = 20;
const PRICE = 19900;
const E2E_PORT = 3917;
const QUIET: Chaos = { maxDelayMs: 0, duplicateRate: 0, reorderRate: 0, failRate: 0 };

// Separate fakepay per scenario; the default app's provider is never used to deliver.
const app = buildServer({ logger: false });

const buyAs = async (userId: string) => (await app.inject({ method: 'POST', url: '/buy', payload: { userId } })).json();
const joinAs = (userId: string) => app.inject({ method: 'POST', url: '/waitlist', payload: { userId } });

function event(holdId: string, type: PaymentEvent['type'], over: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    id: `evt_${randomUUID()}`,
    type,
    paymentId: 'pay_1',
    holdId,
    amountCents: PRICE,
    occurredAt: new Date().toISOString(),
    ...over,
  };
}

function deliver(evt: PaymentEvent, opts: { secret?: string; signature?: string } = {}) {
  const body = JSON.stringify(evt);
  return app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: opts.signature ?? sign(body, opts.secret ?? config.WEBHOOK_SECRET),
    },
    payload: body,
  });
}
const outcomeOf = async (evt: PaymentEvent) => (await deliver(evt)).json().outcome as string;

const holdStatus = async (id: string) =>
  (await pool.query('SELECT status, paid_at, released_at FROM holds WHERE id = $1', [id])).rows[0];
const orderCount = async (holdId?: string) =>
  Number(
    (
      await pool.query(
        `SELECT COUNT(*) FROM orders ${holdId ? 'WHERE hold_id = $1' : ''}`,
        holdId ? [holdId] : [],
      )
    ).rows[0].count,
  );
const backdate = (id: string) =>
  pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

async function stock() {
  const { rows } = await pool.query('SELECT * FROM product_stock WHERE product_id = $1', [PRODUCT_ID]);
  return { held: Number(rows[0].held), sold: Number(rows[0].sold), available: Number(rows[0].available) };
}

beforeAll(async () => {
  await migrate();
  await app.ready();
});

beforeEach(async () => {
  await resetSale();
  await seed();
  await pool.query(
    'UPDATE products SET total_stock = $1, max_per_user = 2, hold_seconds = 300, price_cents = $2 WHERE id = $3',
    [STOCK, PRICE, PRODUCT_ID],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('signature', () => {
  const body = '{"a":1}';
  it('accepts a correct signature', () => {
    expect(verify(sign(body, 's3cret'), body, 's3cret')).toBe(true);
  });
  it('rejects tampered body, wrong secret, missing / malformed header', () => {
    const sig = sign(body, 's3cret');
    expect(verify(sig, '{"a":2}', 's3cret')).toBe(false);
    expect(verify(sig, body, 'other')).toBe(false);
    expect(verify(undefined, body, 's3cret')).toBe(false);
    expect(verify('garbage', body, 's3cret')).toBe(false);
    expect(verify('t=1,v1=zz', body, 's3cret')).toBe(false);
  });
  it('rejects old timestamps (replay)', () => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    expect(verify(sign(body, 's3cret', t), body, 's3cret')).toBe(false);
  });
});

describe('POST /webhooks/payment — basics', () => {
  it('bad signature -> 401, nothing recorded', async () => {
    const h = await buyAs('alice');
    const res = await deliver(event(h.holdId, 'payment.succeeded'), { secret: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect((await pool.query('SELECT COUNT(*) FROM payment_events')).rows[0].count).toBe('0');
    expect((await holdStatus(h.holdId)).status).toBe('active');
  });

  it('malformed payload -> 400', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/payment',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body, config.WEBHOOK_SECRET) },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('success on active hold -> paid + one order', async () => {
    const h = await buyAs('alice');
    const res = await deliver(event(h.holdId, 'payment.succeeded'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, outcome: 'paid' });
    expect(await holdStatus(h.holdId)).toMatchObject({ status: 'paid', paid_at: expect.any(Date), released_at: null });
    expect(await orderCount(h.holdId)).toBe(1);
    expect(await stock()).toEqual({ held: 0, sold: 1, available: STOCK - 1 });
  });

  it('unknown hold -> 200 ignored (provider must stop retrying)', async () => {
    expect(await outcomeOf(event(randomUUID(), 'payment.succeeded'))).toBe('ignored_unknown_hold');
  });

  it('wrong amount -> not paid', async () => {
    const h = await buyAs('alice');
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded', { amountCents: 1 }))).toBe('ignored_amount_mismatch');
    expect((await holdStatus(h.holdId)).status).toBe('active');
  });

  it('every decision is stored on the event', async () => {
    const h = await buyAs('alice');
    const evt = event(h.holdId, 'payment.succeeded');
    await deliver(evt);
    const { rows } = await pool.query('SELECT outcome, processed_at FROM payment_events WHERE event_id = $1', [evt.id]);
    expect(rows[0]).toMatchObject({ outcome: 'paid', processed_at: expect.any(Date) });
  });
});

describe('duplicates', () => {
  it('same event 10x at once -> applied once, one order', async () => {
    const h = await buyAs('alice');
    const evt = event(h.holdId, 'payment.succeeded');
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => outcomeOf(evt)));
    expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate_event')).toHaveLength(9);
    expect(await orderCount()).toBe(1);
  });

  it('same payment re-sent under a new event id -> no second order', async () => {
    const h = await buyAs('alice');
    await deliver(event(h.holdId, 'payment.succeeded'));
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded'))).toBe('ignored_already_paid');
    expect(await orderCount()).toBe(1);
  });

  it('a second, different payment for a paid hold -> flagged for refund, no order', async () => {
    const h = await buyAs('alice');
    await deliver(event(h.holdId, 'payment.succeeded', { paymentId: 'pay_A' }));
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded', { paymentId: 'pay_B' }))).toBe(
      'refund_required_double_charge',
    );
    expect(await orderCount()).toBe(1);
  });
});

describe('out of order', () => {
  it('pending after success -> stays paid', async () => {
    const h = await buyAs('alice');
    await deliver(event(h.holdId, 'payment.succeeded'));
    expect(await outcomeOf(event(h.holdId, 'payment.pending'))).toBe('ignored_pending');
    expect((await holdStatus(h.holdId)).status).toBe('paid');
  });

  it('pending then success -> paid', async () => {
    const h = await buyAs('alice');
    expect(await outcomeOf(event(h.holdId, 'payment.pending'))).toBe('ignored_pending');
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded'))).toBe('paid');
  });

  it('failed after success -> stays paid (paid is terminal)', async () => {
    const h = await buyAs('alice');
    await deliver(event(h.holdId, 'payment.succeeded'));
    expect(await outcomeOf(event(h.holdId, 'payment.failed'))).toBe('ignored_terminal');
    expect((await holdStatus(h.holdId)).status).toBe('paid');
    expect(await stock()).toMatchObject({ sold: 1 });
  });
});

describe('failed payment', () => {
  it('releases the hold and gives the pair to the next in line', async () => {
    const holds: string[] = [];
    for (let i = 0; i < STOCK; i++) holds.push((await buyAs(`h${i}`)).holdId);
    await joinAs('waiter');

    expect(await outcomeOf(event(holds[0], 'payment.failed'))).toBe('released');
    expect(await holdStatus(holds[0])).toMatchObject({ status: 'cancelled', released_at: expect.any(Date) });
    const { rows } = await pool.query(`SELECT source FROM holds WHERE user_id = 'waiter' AND status = 'active'`);
    expect(rows[0]).toEqual({ source: 'waitlist' });
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
  });
});

describe('late payment (arrives after the hold ended)', () => {
  it('pair still free -> accepted, hold revived as paid', async () => {
    const h = await buyAs('alice');
    await backdate(h.holdId);
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded'))).toBe('late_paid');
    expect(await holdStatus(h.holdId)).toMatchObject({ status: 'paid', released_at: null });
    expect(await orderCount(h.holdId)).toBe(1);
  });

  it('pair already given to next in line -> refund, no oversell', async () => {
    const holds: string[] = [];
    for (let i = 0; i < STOCK; i++) holds.push((await buyAs(`h${i}`)).holdId);
    await joinAs('waiter');
    await backdate(holds[0]);

    expect(await outcomeOf(event(holds[0], 'payment.succeeded'))).toBe('refund_required_late');
    expect((await holdStatus(holds[0])).status).toBe('expired');
    expect(await orderCount()).toBe(0);
    expect(await stock()).toEqual({ held: STOCK, sold: 0, available: 0 });
  });

  it('pair bought by someone else meanwhile -> refund', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const h = await buyAs('alice');
    await backdate(h.holdId);
    await buyAs('bob'); // lazily expires alice, bob takes the pair
    expect(await outcomeOf(event(h.holdId, 'payment.succeeded'))).toBe('refund_required_late');
    expect(await stock()).toEqual({ held: 1, sold: 0, available: 0 });
  });

  it('user already at limit -> refund', async () => {
    await pool.query('UPDATE products SET max_per_user = 1 WHERE id = $1', [PRODUCT_ID]);
    const h1 = await buyAs('alice');
    await backdate(h1.holdId);
    const h2 = await buyAs('alice'); // new hold, then paid
    await deliver(event(h2.holdId, 'payment.succeeded', { paymentId: 'pay_2' }));
    expect(await outcomeOf(event(h1.holdId, 'payment.succeeded', { paymentId: 'pay_1' }))).toBe(
      'refund_required_late',
    );
    expect(await orderCount()).toBe(1);
  });

  it('cancelled hold, then failed arrives -> ignored', async () => {
    const h = await buyAs('alice');
    await app.inject({ method: 'DELETE', url: `/holds/${h.holdId}`, payload: { userId: 'alice' } });
    expect(await outcomeOf(event(h.holdId, 'payment.failed'))).toBe('ignored_terminal');
  });
});

describe('POST /holds/:id/pay', () => {
  it('returns 202 + paymentId for own active hold', async () => {
    const h = await buyAs('alice');
    const res = await app.inject({ method: 'POST', url: `/holds/${h.holdId}/pay`, payload: { userId: 'alice' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ paymentId: expect.stringMatching(/^pay_/), amountCents: PRICE });
  });

  it('rejects other user (404), expired (409), paid (409)', async () => {
    const h = await buyAs('alice');
    const pay = (userId: string) =>
      app.inject({ method: 'POST', url: `/holds/${h.holdId}/pay`, payload: { userId } });
    expect((await pay('mallory')).statusCode).toBe(404);

    await deliver(event(h.holdId, 'payment.succeeded'));
    expect((await pay('alice')).json()).toMatchObject({ error: 'HOLD_NOT_ACTIVE', status: 'paid' });

    const h2 = await buyAs('alice');
    await backdate(h2.holdId);
    const res = await app.inject({ method: 'POST', url: `/holds/${h2.holdId}/pay`, payload: { userId: 'alice' } });
    expect(res.json().error).toBe('HOLD_EXPIRED');
  });
});

describe('refunds', () => {
  const refundsFor = async (paymentId: string) =>
    (await pool.query('SELECT reason, status, provider_refund_id, amount_cents FROM refunds WHERE payment_id = $1', [paymentId])).rows;

  it('late payment with the pair gone is actually refunded through the provider', async () => {
    await pool.query('UPDATE products SET total_stock = 1 WHERE id = $1', [PRODUCT_ID]);
    const h = await buyAs('alice');
    await backdate(h.holdId);
    await buyAs('bob');
    await deliver(event(h.holdId, 'payment.succeeded', { paymentId: 'pay_late' }));
    expect(await refundsFor('pay_late')).toEqual([
      { reason: 'late', status: 'refunded', provider_refund_id: expect.stringMatching(/^re_/), amount_cents: PRICE },
    ]);
  });

  it('double charge is refunded once, even if the webhook is re-sent', async () => {
    const h = await buyAs('alice');
    await deliver(event(h.holdId, 'payment.succeeded', { paymentId: 'pay_A' }));
    const second = event(h.holdId, 'payment.succeeded', { paymentId: 'pay_B' });
    await Promise.all([deliver(second), deliver(second), deliver({ ...second, id: 'evt_resend' })]);
    const rows = await refundsFor('pay_B');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'double_charge', status: 'refunded' });
    expect(await refundsFor('pay_A')).toEqual([]);
  });

  it('provider down -> refund stays pending, retried later, never sent twice', async () => {
    const h = await buyAs('alice');
    await pool.query(
      `INSERT INTO refunds (payment_id, hold_id, amount_cents, reason) VALUES ('pay_x', $1, $2, 'late')`,
      [h.holdId, PRICE],
    );
    const down = { refund: async () => { throw new Error('provider 503'); } };
    await expect(processPendingRefunds(down)).rejects.toThrow('provider 503');
    expect((await refundsFor('pay_x'))[0].status).toBe('pending');

    const calls: string[] = [];
    const up = { refund: async (i: { idempotencyKey: string }) => { calls.push(i.idempotencyKey); return { refundId: 're_ok' }; } };
    const [a, b] = await Promise.all([processPendingRefunds(up), processPendingRefunds(up)]);
    expect(a + b).toBe(1);
    expect(calls).toEqual(['refund:pay_x']);
    expect((await refundsFor('pay_x'))[0]).toMatchObject({ status: 'refunded', provider_refund_id: 're_ok' });
  });

  it('fake provider refund is idempotent on its key', async () => {
    const fp = new FakePay({ webhookUrl: 'http://127.0.0.1:1/none', secret: 's', chaos: QUIET });
    const a = await fp.refund({ paymentId: 'p', amountCents: 1, idempotencyKey: 'k' });
    const b = await fp.refund({ paymentId: 'p', amountCents: 1, idempotencyKey: 'k' });
    expect(a).toEqual(b);
    expect(fp.issuedRefunds()).toHaveLength(1);
  });
});

describe('fake provider chaos plan', () => {
  const plan = (chaos: Chaos, n = 300) =>
    Array.from({ length: n }, () =>
      planDeliveries({ holdId: randomUUID(), amountCents: PRICE, paymentId: 'p' }, chaos),
    );

  it('quiet: pending then final, once each', () => {
    for (const d of plan(QUIET, 20)) {
      expect(d.map((x) => x.event.type)).toEqual(['payment.pending', 'payment.succeeded']);
    }
  });

  it('full chaos: every payment duplicated + reordered + failed', () => {
    for (const d of plan({ maxDelayMs: 100, duplicateRate: 1, reorderRate: 1, failRate: 1 }, 50)) {
      expect(d[0].event.type).toBe('payment.failed'); // final first, stale pending comes later
      const finals = d.filter((x) => x.event.type === 'payment.failed');
      expect(finals).toHaveLength(2);
      expect(finals[0].event.id).toBe(finals[1].event.id); // duplicate = same event id
      expect(d.find((x) => x.event.type === 'payment.pending')!.delayMs).toBeGreaterThan(d[0].delayMs);
    }
  });
});

describe('end to end over real HTTP with chaos', () => {
  it('everyone pays through a chaotic provider -> consistent, never oversold', async () => {
    const fakepay = new FakePay({
      webhookUrl: `http://127.0.0.1:${E2E_PORT}/webhooks/payment`,
      secret: config.WEBHOOK_SECRET,
      chaos: { maxDelayMs: 300, duplicateRate: 0.5, reorderRate: 0.5, failRate: 0.3 },
    });
    const live = buildServer({ logger: false, fakepay });
    await live.listen({ port: E2E_PORT, host: '127.0.0.1' });
    try {
      const holds: { user: string; holdId: string }[] = [];
      for (let i = 0; i < STOCK; i++) holds.push({ user: `u${i}`, holdId: (await buyAs(`u${i}`)).holdId });
      for (let i = 0; i < 5; i++) await joinAs(`w${i}`);

      // everyone clicks Pay twice (double click => two separate payments)
      await Promise.all(
        holds.flatMap(({ user, holdId }) =>
          [1, 2].map(() =>
            live.inject({ method: 'POST', url: `/holds/${holdId}/pay`, payload: { userId: user } }),
          ),
        ),
      );
      await fakepay.idle();

      const { rows: events } = await pool.query('SELECT outcome FROM payment_events');
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.outcome !== null)).toBe(true); // every recorded event was processed

      // invariants
      const s = await stock();
      expect(s.held + s.sold).toBeLessThanOrEqual(STOCK);
      const { rows: inv } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM orders) AS orders,
          (SELECT COUNT(*)::int FROM holds WHERE status = 'paid') AS paid,
          (SELECT COUNT(*)::int FROM (SELECT hold_id FROM orders GROUP BY hold_id HAVING COUNT(*) > 1) x) AS dup_orders,
          (SELECT COALESCE(MAX(c), 0)::int FROM (SELECT COUNT(*) c FROM holds
             WHERE status IN ('active','paid') GROUP BY user_id) x) AS max_per_user`);
      expect(inv[0].orders).toBe(inv[0].paid);
      expect(inv[0].dup_orders).toBe(0);
      expect(inv[0].max_per_user).toBeLessThanOrEqual(2);
      expect(s.sold).toBeGreaterThan(0);
    } finally {
      await live.close();
    }
  }, 60_000);
});
