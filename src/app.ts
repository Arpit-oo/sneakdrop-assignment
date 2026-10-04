import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { DomainError } from './domain/errors.js';
import { FakePay } from './fakepay/provider.js';
import { SaleHub } from './live/hub.js';
import { adminRoutes } from './routes/admin.js';
import { buyRoutes } from './routes/buy.js';
import { paymentRoutes } from './routes/payments.js';
import { stateRoutes } from './routes/state.js';
import { waitlistRoutes } from './routes/waitlist.js';

export function defaultFakePay(log?: (msg: string, data?: Record<string, unknown>) => void) {
  return new FakePay({
    webhookUrl: config.WEBHOOK_URL ?? `http://127.0.0.1:${config.PORT}/webhooks/payment`,
    secret: config.WEBHOOK_SECRET,
    chaos: {
      maxDelayMs: config.FAKEPAY_MAX_DELAY_MS,
      duplicateRate: config.FAKEPAY_DUPLICATE_RATE,
      reorderRate: config.FAKEPAY_REORDER_RATE,
      failRate: config.FAKEPAY_FAIL_RATE,
    },
    log,
  });
}

export function buildServer(opts: { logger?: boolean; fakepay?: FakePay; adminToken?: string } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    trustProxy: true, // behind Render's / any load balancer: real client IP in logs
  });
  const fakepay = opts.fakepay ?? defaultFakePay((msg, data) => app.log.warn(data, msg));
  const hub = new SaleHub();

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.details });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'BAD_REQUEST', issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL' });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.register(buyRoutes);
  app.register(waitlistRoutes);
  app.register(paymentRoutes, { fakepay });
  app.register(stateRoutes, { hub });
  const adminToken = 'adminToken' in opts ? opts.adminToken : config.ADMIN_TOKEN;
  if (adminToken) app.register(adminRoutes, { token: adminToken });

  // let in-flight fake webhooks finish before the pool closes
  app.addHook('onClose', async () => {
    await fakepay.idle();
    await hub.close();
  });

  return app;
}
