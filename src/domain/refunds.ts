import { withTx } from '../db/pool.js';

export type RefundGateway = {
  refund(input: { paymentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string }>;
};

/**
 * Send every pending refund to the payment provider. Each one is locked with
 * SKIP LOCKED, so several instances can run this at once without refunding
 * twice; the payment id doubles as the provider idempotency key, so even a
 * crash between "provider refunded" and "we committed" is safe to retry.
 * A refund that fails stays pending and is retried on the next run.
 */
export async function processPendingRefunds(gateway: RefundGateway, limit = 50): Promise<number> {
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const refunded = await withTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; payment_id: string; amount_cents: number }>(
        `SELECT id, payment_id, amount_cents FROM refunds
         WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const r = rows[0];
      if (!r) return null;
      const { refundId } = await gateway.refund({
        paymentId: r.payment_id,
        amountCents: r.amount_cents,
        idempotencyKey: `refund:${r.payment_id}`,
      });
      await tx.query(
        `UPDATE refunds SET status = 'refunded', provider_refund_id = $2, refunded_at = now() WHERE id = $1`,
        [r.id, refundId],
      );
      return refundId;
    });
    if (!refunded) break;
    done++;
  }
  return done;
}
