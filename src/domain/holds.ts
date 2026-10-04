import { pool, withTx } from '../db/pool.js';
import { DomainError, fromDbError } from './errors.js';
import { availableStock, lockProduct, userUsage } from './product.js';
import { expireStaleHolds, promoteWaiting } from './release.js';
import { positionOf } from './waitlist.js';

export type Hold = {
  id: string;
  productId: string;
  userId: string;
  status: 'active' | 'paid' | 'expired' | 'cancelled';
  source: 'direct' | 'waitlist';
  expiresAt: Date;
};

export type BuyResult =
  | { kind: 'held'; hold: Hold }
  | { kind: 'sold_out'; canJoinWaitlist: boolean; position?: number };

type HoldRow = {
  id: string;
  product_id: string;
  user_id: string;
  status: Hold['status'];
  source: Hold['source'];
  expires_at: Date;
};

const HOLD_COLS = 'id, product_id, user_id, status, source, expires_at';

const toHold = (r: HoldRow): Hold => ({
  id: r.id,
  productId: r.product_id,
  userId: r.user_id,
  status: r.status,
  source: r.source,
  expiresAt: r.expires_at,
});

/**
 * Buy button. One transaction:
 *   lock product -> expire stale holds (+ promote line) -> check user rules
 *   -> check stock -> insert hold.
 * Because freed pairs go to the line first, a direct buyer only ever sees
 * stock > 0 when nobody is waiting — no line-jumping.
 * All times come from the DB clock (now()), never the app server's.
 */
export async function buy(userId: string, productId: string): Promise<BuyResult> {
  const fast = await soldOutFastPath(userId, productId);
  if (fast) return fast;
  try {
    return await withTx(async (tx) => {
      const product = await lockProduct(tx, productId);
      await expireStaleHolds(tx, product);

      const usage = await userUsage(tx, productId, userId);
      if (usage.active) {
        throw new DomainError('ALREADY_HOLDING', 409, 'You already hold a pair', {
          holdId: usage.active.id,
          expiresAt: usage.active.expires_at,
        });
      }
      if (usage.used >= product.max_per_user) {
        throw new DomainError('LIMIT_REACHED', 409, `Limit is ${product.max_per_user} pairs per person`);
      }

      if ((await availableStock(tx, product)) <= 0) {
        const position = await positionOf(tx, productId, userId);
        return position === undefined
          ? { kind: 'sold_out', canJoinWaitlist: true }
          : { kind: 'sold_out', canJoinWaitlist: false, position };
      }

      const { rows } = await tx.query<HoldRow>(
        `INSERT INTO holds (product_id, user_id, source, expires_at)
         VALUES ($1, $2, 'direct', now() + make_interval(secs => $3))
         RETURNING ${HOLD_COLS}`,
        [productId, userId, product.hold_seconds],
      );
      return { kind: 'held', hold: toHold(rows[0]) };
    });
  } catch (err) {
    throw fromDbError(err) ?? err;
  }
}

/**
 * Once sold out, almost every click is a "no". Answer those with one read —
 * no transaction, no product lock — so thousands of late clicks don't queue
 * behind the lock. Safe because a "sold out" reply only reports a snapshot a
 * moment old; nothing is written. Anything that could change the answer
 * (overdue hold to expire, user already has pairs, stock free) falls through
 * to the locked path.
 */
async function soldOutFastPath(userId: string, productId: string): Promise<BuyResult | undefined> {
  const { rows } = await pool.query<{ sold_out: boolean; position: number | null }>(
    `SELECT
       p.total_stock <= (SELECT COUNT(*) FROM holds
                         WHERE product_id = p.id AND status IN ('active', 'paid'))
       AND NOT EXISTS (SELECT 1 FROM holds
                       WHERE product_id = p.id AND status = 'active' AND expires_at <= now())
       AND NOT EXISTS (SELECT 1 FROM holds
                       WHERE product_id = p.id AND user_id = $2 AND status IN ('active', 'paid'))
         AS sold_out,
       (SELECT COUNT(*)::int FROM waitlist o, waitlist w
        WHERE w.product_id = p.id AND w.user_id = $2 AND w.status = 'waiting'
          AND o.product_id = p.id AND o.status = 'waiting' AND o.id <= w.id
        HAVING COUNT(*) > 0) AS position
     FROM products p WHERE p.id = $1`,
    [productId, userId],
  );
  const r = rows[0];
  if (!r?.sold_out) return undefined;
  return r.position === null
    ? { kind: 'sold_out', canJoinWaitlist: true }
    : { kind: 'sold_out', canJoinWaitlist: false, position: r.position };
}

/**
 * User gives a held pair back. Only the owner can cancel, only while active.
 * Product lock first (same lock order as buy), then the freed pair goes to the line.
 */
export async function cancelHold(holdId: string, userId: string): Promise<Hold> {
  return withTx(async (tx) => {
    const { rows: found } = await tx.query<HoldRow>(`SELECT ${HOLD_COLS} FROM holds WHERE id = $1`, [holdId]);
    // Same response for "missing" and "someone else's" so hold ids can't be probed.
    if (!found[0] || found[0].user_id !== userId) {
      throw new DomainError('HOLD_NOT_FOUND', 404, 'Hold not found');
    }

    const product = await lockProduct(tx, found[0].product_id);
    await expireStaleHolds(tx, product);

    const { rows } = await tx.query<HoldRow>(
      `UPDATE holds SET status = 'cancelled', released_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING ${HOLD_COLS}`,
      [holdId],
    );
    if (!rows[0]) {
      const { rows: now } = await tx.query<{ status: Hold['status'] }>(
        'SELECT status FROM holds WHERE id = $1',
        [holdId],
      );
      const status = now[0].status;
      throw status === 'expired'
        ? new DomainError('HOLD_EXPIRED', 409, 'Hold already expired')
        : new DomainError('HOLD_NOT_ACTIVE', 409, `Hold is ${status}`, { status });
    }

    await promoteWaiting(tx, product);
    return toHold(rows[0]);
  });
}
