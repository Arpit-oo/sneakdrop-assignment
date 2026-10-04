import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { pool } from './pool.js';

export const PRODUCT_ID = 'sneaker-001';

/** Upsert the single limited product using sale rules from env. */
export async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO products (id, name, total_stock, max_per_user, hold_seconds, price_cents)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       total_stock  = EXCLUDED.total_stock,
       max_per_user = EXCLUDED.max_per_user,
       hold_seconds = EXCLUDED.hold_seconds,
       price_cents  = EXCLUDED.price_cents`,
    [PRODUCT_ID, 'Limited Drop Sneaker', config.STOCK, config.MAX_PER_USER, config.HOLD_SECONDS, 19900],
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => {
      console.log(`seeded ${PRODUCT_ID}: stock=${config.STOCK} hold=${config.HOLD_SECONDS}s max/user=${config.MAX_PER_USER}`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
