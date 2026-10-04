import { type Tx, withTx } from '../db/pool.js';
import { DomainError } from './errors.js';
import { availableStock, lockProduct, userUsage } from './product.js';
import { expireStaleHolds } from './release.js';

/** 1-based place in line, or undefined if not waiting. */
export async function positionOf(tx: Tx, productId: string, userId: string): Promise<number | undefined> {
  const { rows } = await tx.query<{ position: number }>(
    `SELECT (SELECT COUNT(*)::int FROM waitlist o
             WHERE o.product_id = w.product_id AND o.status = 'waiting' AND o.id <= w.id) AS position
     FROM waitlist w
     WHERE w.product_id = $1 AND w.user_id = $2 AND w.status = 'waiting'`,
    [productId, userId],
  );
  return rows[0]?.position;
}

export type JoinResult = { position: number; alreadyWaiting: boolean };

/**
 * Join the line. Only when sold out — if a pair is free, buy it instead.
 * Joining twice is harmless: returns the existing place.
 */
export async function joinWaitlist(userId: string, productId: string): Promise<JoinResult> {
  return withTx(async (tx) => {
    const product = await lockProduct(tx, productId);
    await expireStaleHolds(tx, product);

    const existing = await positionOf(tx, productId, userId);
    if (existing !== undefined) return { position: existing, alreadyWaiting: true };

    const usage = await userUsage(tx, productId, userId);
    if (usage.active) throw new DomainError('ALREADY_HOLDING', 409, 'You already hold a pair');
    if (usage.used >= product.max_per_user) {
      throw new DomainError('LIMIT_REACHED', 409, `Limit is ${product.max_per_user} pairs per person`);
    }
    if ((await availableStock(tx, product)) > 0) {
      throw new DomainError('NOT_SOLD_OUT', 409, 'Pairs are available — buy one directly');
    }

    await tx.query('INSERT INTO waitlist (product_id, user_id) VALUES ($1, $2)', [productId, userId]);
    return { position: (await positionOf(tx, productId, userId))!, alreadyWaiting: false };
  });
}

/** Leave the line. Takes the product lock so it can't race a promotion of the same entry. */
export async function leaveWaitlist(userId: string, productId: string): Promise<void> {
  await withTx(async (tx) => {
    await lockProduct(tx, productId);
    const { rowCount } = await tx.query(
      `UPDATE waitlist SET status = 'left', left_reason = 'user_left', updated_at = now()
       WHERE product_id = $1 AND user_id = $2 AND status = 'waiting'`,
      [productId, userId],
    );
    if (!rowCount) throw new DomainError('NOT_IN_LINE', 404, 'You are not in line');
  });
}

/** Read-only position lookup (no lock needed — a snapshot is fine for display). */
export async function getPosition(userId: string, productId: string): Promise<number | undefined> {
  return withTx((tx) => positionOf(tx, productId, userId));
}
