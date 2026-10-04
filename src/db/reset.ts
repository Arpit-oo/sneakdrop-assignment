import { pathToFileURL } from 'node:url';
import { pool } from './pool.js';

/** Wipe all sale activity (holds, orders, line, webhook log, refunds). Keeps products. */
export async function resetSale(): Promise<void> {
  await pool.query('TRUNCATE refunds, payment_events, orders, waitlist, holds RESTART IDENTITY CASCADE');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetSale()
    .then(() => {
      console.log('sale data cleared');
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
