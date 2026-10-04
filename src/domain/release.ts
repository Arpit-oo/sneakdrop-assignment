import type { Tx } from '../db/pool.js';
import { availableStock, type ProductRow, userUsage } from './product.js';

/**
 * Everything that happens when pairs come back: expire overdue holds, then hand
 * free pairs to the waiting line. Runs in the caller's transaction (buy, cancel,
 * join line, expiry worker, failed payment) under the product lock, so between
 * "pair freed" and "next in line gets it" no direct buyer can sneak in.
 */

export type Promotion = { waitlistId: string; userId: string; holdId: string; expiresAt: Date };

/**
 * Lazily expire holds whose time is up, then promote the line. Runs inside
 * every stock decision so a dead/slow expiry worker can never keep pairs locked
 * past their deadline. Caller must hold the product lock.
 */
export async function expireStaleHolds(
  tx: Tx,
  product: ProductRow,
): Promise<{ expired: number; promoted: Promotion[] }> {
  const { rowCount } = await tx.query(
    `UPDATE holds SET status = 'expired', released_at = now()
     WHERE product_id = $1 AND status = 'active' AND expires_at <= now()`,
    [product.id],
  );
  const expired = rowCount ?? 0;
  return { expired, promoted: expired > 0 ? await promoteWaiting(tx, product) : [] };
}

/**
 * Hand every free pair to the waiting line, first come first served.
 * Caller must hold the product lock. Entries whose user can't take a pair
 * (already holding / at limit) are skipped and removed from the line.
 */
export async function promoteWaiting(tx: Tx, product: ProductRow): Promise<Promotion[]> {
  const promoted: Promotion[] = [];
  let free = await availableStock(tx, product);

  while (free > 0) {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM waitlist
       WHERE product_id = $1 AND status = 'waiting'
       ORDER BY id LIMIT 1`,
      [product.id],
    );
    const next = rows[0];
    if (!next) break; // line empty: pair stays on open sale

    const usage = await userUsage(tx, product.id, next.user_id);
    const skip = usage.active ? 'skipped_holding' : usage.used >= product.max_per_user ? 'skipped_limit' : null;
    if (skip) {
      await tx.query(
        `UPDATE waitlist SET status = 'left', left_reason = $2, updated_at = now() WHERE id = $1`,
        [next.id, skip],
      );
      continue;
    }

    const { rows: hold } = await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO holds (product_id, user_id, source, expires_at)
       VALUES ($1, $2, 'waitlist', now() + make_interval(secs => $3))
       RETURNING id, expires_at`,
      [product.id, next.user_id, product.hold_seconds],
    );
    await tx.query(
      `UPDATE waitlist SET status = 'promoted', promoted_hold_id = $2, updated_at = now() WHERE id = $1`,
      [next.id, hold[0].id],
    );
    promoted.push({ waitlistId: next.id, userId: next.user_id, holdId: hold[0].id, expiresAt: hold[0].expires_at });
    free--;
  }
  return promoted;
}
