import type { Tx } from '../db/pool.js';
import { DomainError } from './errors.js';

export type ProductRow = { id: string; total_stock: number; max_per_user: number; hold_seconds: number };

const COLS = 'id, total_stock, max_per_user, hold_seconds';

/**
 * Lock the product row. Every write that consumes or frees stock, or touches
 * the waiting line, takes this lock first — so stock decisions for one product
 * happen strictly one at a time, always in the same order (product -> holds ->
 * waitlist), which rules out deadlocks. Held for milliseconds.
 */
export async function lockProduct(tx: Tx, productId: string): Promise<ProductRow> {
  const { rows } = await tx.query<ProductRow>(`SELECT ${COLS} FROM products WHERE id = $1 FOR UPDATE`, [
    productId,
  ]);
  if (!rows[0]) throw new DomainError('PRODUCT_NOT_FOUND', 404, `Unknown product ${productId}`);
  return rows[0];
}

/** Same as lockProduct but returns undefined instead of waiting if someone else holds it. */
export async function tryLockProduct(tx: Tx, productId: string): Promise<ProductRow | undefined> {
  const { rows } = await tx.query<ProductRow>(
    `SELECT ${COLS} FROM products WHERE id = $1 FOR UPDATE SKIP LOCKED`,
    [productId],
  );
  return rows[0];
}

/** Pairs not held or sold. Caller must hold the product lock for this to be stable. */
export async function availableStock(tx: Tx, product: ProductRow): Promise<number> {
  const { rows } = await tx.query<{ consumed: number }>(
    `SELECT COUNT(*)::int AS consumed FROM holds
     WHERE product_id = $1 AND status IN ('active', 'paid')`,
    [product.id],
  );
  return product.total_stock - rows[0].consumed;
}

/** User's pairs that count toward the limit, split by state. */
export async function userUsage(tx: Tx, productId: string, userId: string) {
  const { rows } = await tx.query<{ id: string; status: 'active' | 'paid'; expires_at: Date }>(
    `SELECT id, status, expires_at FROM holds
     WHERE product_id = $1 AND user_id = $2 AND status IN ('active', 'paid')`,
    [productId, userId],
  );
  return { active: rows.find((r) => r.status === 'active'), used: rows.length };
}
