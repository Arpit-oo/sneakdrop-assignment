import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { pool, withTx } from '../db/pool.js';
import { tryLockProduct } from '../domain/product.js';
import { expireStaleHolds } from '../domain/release.js';

/**
 * One sweep: expire every overdue hold, product by product, and hand the
 * freed pairs to the waiting line in the same transaction.
 *
 * Locks the PRODUCT row (not individual holds) so it uses the same lock order
 * as buy/cancel (product -> holds -> waitlist) — no deadlocks. SKIP LOCKED: if a buyer or another worker instance
 * already holds a product's lock, skip it — that transaction runs lazy expiry
 * itself, and the next sweep will retry. So N workers never block or double-process.
 *
 * Returns number of holds expired.
 */
export async function expireDue(): Promise<number> {
  const { rows: due } = await pool.query<{ product_id: string }>(
    `SELECT DISTINCT product_id FROM holds WHERE status = 'active' AND expires_at <= now()`,
  );

  let expired = 0;
  for (const { product_id } of due) {
    expired += await withTx(async (tx) => {
      const product = await tryLockProduct(tx, product_id);
      if (!product) return 0; // someone else is working on this product right now
      return (await expireStaleHolds(tx, product)).expired;
    });
  }
  return expired;
}

export type ExpiryWorker = { stop: () => Promise<void> };

/**
 * Run expireDue every intervalMs. Sweeps never overlap: the next one is
 * scheduled only after the previous finishes. Errors are logged, loop survives.
 */
export function startExpiryWorker(
  opts: { intervalMs?: number; onExpired?: (n: number) => void; onError?: (err: unknown) => void } = {},
): ExpiryWorker {
  const intervalMs = opts.intervalMs ?? config.EXPIRY_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const tick = () => {
    running = expireDue()
      .then((n) => {
        if (n > 0) opts.onExpired?.(n);
      })
      .catch((err) => (opts.onError ?? console.error)(err))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

// Standalone: `npm run worker` — run the sweeper as its own process.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = startExpiryWorker({
    onExpired: (n) => console.log(`expired ${n} hold(s)`),
  });
  console.log(`expiry worker running every ${config.EXPIRY_INTERVAL_MS}ms`);
  const shutdown = async () => {
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
