import { type Tx, withTx } from '../db/pool.js';
import type { PaymentEvent } from '../payments/events.js';
import { DomainError } from './errors.js';
import { availableStock, lockProduct, userUsage } from './product.js';
import { expireStaleHolds, promoteWaiting } from './release.js';

/**
 * What the webhook handler did with an event. Stored on payment_events.outcome
 * so every decision is auditable.
 */
export type Outcome =
  | 'duplicate_event' //            same event id seen before — nothing done
  | 'paid' //                       active hold -> paid, order created
  | 'late_paid' //                  hold had expired/cancelled, pair still free -> revived as paid
  | 'released' //                   payment failed on active hold -> pair to the line
  | 'ignored_pending' //            informational, never changes state
  | 'ignored_already_paid' //       success for the payment that already paid this hold
  | 'ignored_terminal' //           failed/pending after hold is already final (out of order)
  | 'ignored_unknown_hold'
  | 'ignored_amount_mismatch'
  | 'refund_required_late' //       paid after hold ended and pair is gone / user at limit
  | 'refund_required_double_charge'; // a second, different payment for an already-paid hold

type HoldRow = {
  id: string;
  product_id: string;
  user_id: string;
  status: 'active' | 'paid' | 'expired' | 'cancelled';
  expires_at: Date;
};

/**
 * Apply one webhook event. Whole thing is one transaction:
 *   1. record event in inbox (event_id PK) — duplicate => stop, no-op
 *   2. lock product (same lock order as everything else), lazy-expire
 *   3. lock hold, apply forward-only state machine
 *   4. store outcome
 * If anything throws, the inbox row rolls back too, so the provider's retry
 * gets processed for real — events are never "seen but not applied".
 *
 * Forward-only: paid is terminal. A late/stale pending or failed can never
 * undo a payment, whatever order events arrive in.
 */
export async function handlePaymentEvent(evt: PaymentEvent): Promise<Outcome> {
  return withTx(async (tx) => {
    const { rowCount: fresh } = await tx.query(
      `INSERT INTO payment_events (event_id, payment_id, hold_id, type, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [evt.id, evt.paymentId, evt.holdId, evt.type, JSON.stringify(evt), evt.occurredAt],
    );
    if (!fresh) return 'duplicate_event';

    const outcome = await applyEvent(tx, evt);
    await tx.query(`UPDATE payment_events SET processed_at = now(), outcome = $2 WHERE event_id = $1`, [
      evt.id,
      outcome,
    ]);
    return outcome;
  });
}

async function applyEvent(tx: Tx, evt: PaymentEvent): Promise<Outcome> {
  const { rows: found } = await tx.query<{ product_id: string }>('SELECT product_id FROM holds WHERE id = $1', [
    evt.holdId,
  ]);
  if (!found[0]) return 'ignored_unknown_hold';

  const product = await lockProduct(tx, found[0].product_id);
  // A success that arrives after the deadline must see the hold as expired
  // (and the pair possibly already given to the next in line).
  await expireStaleHolds(tx, product);

  const { rows } = await tx.query<HoldRow>(
    'SELECT id, product_id, user_id, status, expires_at FROM holds WHERE id = $1 FOR UPDATE',
    [evt.holdId],
  );
  const hold = rows[0];
  const { rows: price } = await tx.query<{ price_cents: number }>(
    'SELECT price_cents FROM products WHERE id = $1',
    [product.id],
  );

  if (evt.type === 'payment.pending') return 'ignored_pending';

  if (evt.type === 'payment.failed') {
    if (hold.status !== 'active') return 'ignored_terminal';
    await tx.query(`UPDATE holds SET status = 'cancelled', released_at = now() WHERE id = $1`, [hold.id]);
    await promoteWaiting(tx, product);
    return 'released';
  }

  // payment.succeeded
  if (evt.amountCents !== price[0].price_cents) return 'ignored_amount_mismatch';

  if (hold.status === 'paid') {
    const { rows: order } = await tx.query<{ payment_id: string }>(
      'SELECT payment_id FROM orders WHERE hold_id = $1',
      [hold.id],
    );
    if (order[0]?.payment_id === evt.paymentId) return 'ignored_already_paid';
    await recordRefund(tx, evt, 'double_charge');
    return 'refund_required_double_charge';
  }

  if (hold.status === 'active') {
    await markPaid(tx, hold, evt);
    return 'paid';
  }

  // Late: hold expired or was cancelled before the money arrived.
  // Revive only if a pair is free right now (line already had its chance —
  // promotion ran above) and the user is still under the limit. Else refund.
  const usage = await userUsage(tx, product.id, hold.user_id);
  if ((await availableStock(tx, product)) > 0 && usage.used < product.max_per_user) {
    await markPaid(tx, hold, evt);
    return 'late_paid';
  }
  await recordRefund(tx, evt, 'late');
  return 'refund_required_late';
}

/**
 * Owe the money back. Recorded in the webhook's own transaction, so a refund
 * is never forgotten; the provider is called after commit (processPendingRefunds).
 * payment_id is UNIQUE: duplicate deliveries can't create a second refund.
 */
async function recordRefund(tx: Tx, evt: PaymentEvent, reason: 'late' | 'double_charge') {
  await tx.query(
    `INSERT INTO refunds (payment_id, hold_id, amount_cents, reason)
     VALUES ($1, $2, $3, $4) ON CONFLICT (payment_id) DO NOTHING`,
    [evt.paymentId, evt.holdId, evt.amountCents, reason],
  );
}

async function markPaid(tx: Tx, hold: HoldRow, evt: PaymentEvent) {
  // DB trigger re-checks stock + limit for expired/cancelled -> paid.
  await tx.query(`UPDATE holds SET status = 'paid', paid_at = now(), released_at = NULL WHERE id = $1`, [hold.id]);
  await tx.query(
    `INSERT INTO orders (hold_id, product_id, user_id, payment_id, amount_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [hold.id, hold.product_id, hold.user_id, evt.paymentId, evt.amountCents],
  );
}

/**
 * Pay button: check the hold can be paid and return what to charge.
 * No lock — the webhook is the real decision point, this is only a friendly
 * early rejection.
 */
export async function prepareCheckout(holdId: string, userId: string): Promise<{ amountCents: number }> {
  const { rows } = await withTx((tx) =>
    tx.query<{ user_id: string; status: string; live: boolean; price_cents: number }>(
      `SELECT h.user_id, h.status, h.expires_at > now() AS live, p.price_cents
       FROM holds h JOIN products p ON p.id = h.product_id
       WHERE h.id = $1`,
      [holdId],
    ),
  );
  const h = rows[0];
  if (!h || h.user_id !== userId) throw new DomainError('HOLD_NOT_FOUND', 404, 'Hold not found');
  if (h.status === 'expired' || (h.status === 'active' && !h.live)) {
    throw new DomainError('HOLD_EXPIRED', 409, 'Hold expired');
  }
  if (h.status !== 'active') throw new DomainError('HOLD_NOT_ACTIVE', 409, `Hold is ${h.status}`, { status: h.status });
  return { amountCents: h.price_cents };
}
