import { pool } from '../db/pool.js';
import { DomainError } from './errors.js';

export type SaleState = {
  serverTime: string;
  product: {
    id: string;
    name: string;
    total: number;
    held: number;
    sold: number;
    available: number;
    waiting: number;
    holdSeconds: number;
    maxPerUser: number;
    priceCents: number;
  };
  me: {
    userId: string;
    hold: { id: string; expiresAt: string; source: 'direct' | 'waitlist' } | null;
    bought: number;
    position: number | null;
    lastPayment: { holdId: string; type: string; outcome: string | null; at: string } | null;
  };
};

/**
 * Everything the status page shows, in one read. Overdue-but-not-yet-swept
 * holds are reported as gone (expires_at > now()) so the page never shows a
 * countdown below zero; the worker/lazy expiry makes the DB match within ~1s.
 */
export async function getState(userId: string, productId: string): Promise<SaleState> {
  const { rows } = await pool.query(
    `SELECT
       now() AS server_time,
       p.id, p.name, p.total_stock, p.max_per_user, p.hold_seconds, p.price_cents,
       (SELECT COUNT(*)::int FROM holds WHERE product_id = p.id AND status = 'active' AND expires_at > now()) AS held,
       (SELECT COUNT(*)::int FROM holds WHERE product_id = p.id AND status = 'paid') AS sold,
       (SELECT COUNT(*)::int FROM waitlist WHERE product_id = p.id AND status = 'waiting') AS waiting,
       (SELECT json_build_object('id', id, 'expiresAt', expires_at, 'source', source) FROM holds
         WHERE product_id = p.id AND user_id = $2 AND status = 'active' AND expires_at > now()) AS hold,
       (SELECT COUNT(*)::int FROM holds WHERE product_id = p.id AND user_id = $2 AND status = 'paid') AS bought,
       (SELECT COUNT(*)::int FROM waitlist o, waitlist w
         WHERE w.product_id = p.id AND w.user_id = $2 AND w.status = 'waiting'
           AND o.product_id = p.id AND o.status = 'waiting' AND o.id <= w.id
         HAVING COUNT(*) > 0) AS position,
       (SELECT json_build_object('holdId', e.hold_id, 'type', e.type, 'outcome', e.outcome, 'at', e.received_at)
          FROM payment_events e JOIN holds h ON h.id = e.hold_id
         WHERE h.user_id = $2 AND h.product_id = p.id AND e.type <> 'payment.pending'
         ORDER BY e.received_at DESC LIMIT 1) AS last_payment
     FROM products p WHERE p.id = $1`,
    [productId, userId],
  );
  const r = rows[0];
  if (!r) throw new DomainError('PRODUCT_NOT_FOUND', 404, `Unknown product ${productId}`);
  return {
    serverTime: new Date(r.server_time).toISOString(),
    product: {
      id: r.id,
      name: r.name,
      total: r.total_stock,
      held: r.held,
      sold: r.sold,
      available: r.total_stock - r.held - r.sold,
      waiting: r.waiting,
      holdSeconds: r.hold_seconds,
      maxPerUser: r.max_per_user,
      priceCents: r.price_cents,
    },
    me: {
      userId,
      hold: r.hold,
      bought: r.bought,
      position: r.position,
      lastPayment: r.last_payment,
    },
  };
}
