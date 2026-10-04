import { buildServer } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { type ExpiryWorker, startExpiryWorker } from './workers/expiry.js';

const app = buildServer();

let worker: ExpiryWorker | undefined;
if (config.EXPIRY_INTERVAL_MS > 0) {
  worker = startExpiryWorker({
    onExpired: (n) => app.log.info({ expired: n }, 'holds expired'),
    onError: (err) => app.log.error(err, 'expiry sweep failed'),
  });
}

const shutdown = async () => {
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
