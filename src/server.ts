import { buildServer, defaultFakePay } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { processPendingRefunds } from './domain/refunds.js';
import { type ExpiryWorker, startExpiryWorker } from './workers/expiry.js';

const fakepay = defaultFakePay((msg, data) => app.log.warn(data, msg));
const app = buildServer({ fakepay });

if (process.env.NODE_ENV === 'production' && config.WEBHOOK_SECRET === 'change-me') {
  app.log.warn('WEBHOOK_SECRET is the default value; set a real secret in production');
}

let worker: ExpiryWorker | undefined;
if (config.EXPIRY_INTERVAL_MS > 0) {
  worker = startExpiryWorker({
    onExpired: (n) => app.log.info({ expired: n }, 'holds expired'),
    onError: (err) => app.log.error(err, 'expiry sweep failed'),
  });
}

// Refunds normally go out right after the webhook that triggered them; this
// catches any that failed (provider down) so none stay pending forever.
const refundRetry = setInterval(() => {
  processPendingRefunds(fakepay)
    .then((n) => n && app.log.info({ refunded: n }, 'pending refunds retried'))
    .catch((err) => app.log.error(err, 'refund retry failed'));
}, 30_000);

const shutdown = async () => {
  clearInterval(refundRetry);
  await worker?.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
