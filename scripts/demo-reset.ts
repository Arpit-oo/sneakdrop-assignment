/**
 * Fresh sale for a demo, in one command that works in any shell:
 *
 *   npm run demo:reset              # 2 pairs, 30-second holds
 *   npm run demo:reset -- 20 300    # back to normal: 20 pairs, 5-minute holds
 *
 * Wipes holds / orders / line / payment events / refunds in DATABASE_URL and
 * sets the product rules. Open pages refresh on their own.
 */
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';

const [stock = 2, holdSeconds = 30, maxPerUser = 2] = process.argv.slice(2).map(Number);

async function main() {
  await migrate();
  await seed();
  await resetSale();
  await pool.query(
    'UPDATE products SET total_stock = $2, hold_seconds = $3, max_per_user = $4 WHERE id = $1',
    [PRODUCT_ID, stock, holdSeconds, maxPerUser],
  );
  await pool.query(`SELECT pg_notify('sale_changed', '')`);
  console.log(`fresh sale: ${stock} pairs · ${holdSeconds}s holds · max ${maxPerUser} per person`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
