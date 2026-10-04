import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { handlePaymentEvent, prepareCheckout } from '../domain/payments.js';
import { processPendingRefunds } from '../domain/refunds.js';
import type { FakePay } from '../fakepay/provider.js';
import { paymentEventSchema } from '../payments/events.js';
import { SIGNATURE_HEADER, verify } from '../payments/signature.js';

const holdParams = z.object({ id: z.string().uuid() });
const payBody = z.object({
  userId: z.string().trim().min(1).max(64),
  // demo/testing: force the fake provider's result
  outcome: z.enum(['succeeded', 'failed']).optional(),
});
const checkoutBody = z.object({
  holdId: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  outcome: z.enum(['succeeded', 'failed']).optional(),
});

export async function paymentRoutes(app: FastifyInstance, opts: { fakepay: FakePay }) {
  /** Pay button: start a checkout with the (fake) provider. Result comes via webhook. */
  app.post('/holds/:id/pay', async (req, reply) => {
    const { id } = holdParams.parse(req.params);
    const body = payBody.parse(req.body);
    const { amountCents } = await prepareCheckout(id, body.userId);
    const { paymentId } = opts.fakepay.checkout({ holdId: id, amountCents, outcome: body.outcome });
    return reply.code(202).send({ paymentId, amountCents, status: 'processing' });
  });

  /** The provider's own API, exposed for manual chaos demos (curl a payment for any hold). */
  app.post('/fakepay/checkout', async (req, reply) => {
    const body = checkoutBody.parse(req.body);
    const { paymentId, deliveries } = opts.fakepay.checkout(body);
    return reply.code(202).send({
      paymentId,
      deliveries: deliveries.map((d) => ({ eventId: d.event.id, type: d.event.type, delayMs: d.delayMs })),
    });
  });

  // Webhook needs the exact raw bytes to check the HMAC, so parse JSON ourselves.
  // Encapsulated: this parser only applies to routes in this nested plugin.
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    hook.post('/webhooks/payment', async (req, reply) => {
      const raw = req.body as string;
      if (!verify(req.headers[SIGNATURE_HEADER] as string | undefined, raw, config.WEBHOOK_SECRET)) {
        return reply.code(401).send({ error: 'BAD_SIGNATURE' });
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'BAD_JSON' });
      }
      const evt = paymentEventSchema.parse(json);
      const outcome = await handlePaymentEvent(evt);
      req.log.info({ eventId: evt.id, type: evt.type, holdId: evt.holdId, outcome }, 'payment event');
      if (outcome.startsWith('refund_required')) {
        // recorded in the webhook txn; now actually send the money back
        const n = await processPendingRefunds(opts.fakepay).catch((err) => {
          req.log.error(err, 'refund failed; stays pending and is retried on the next refund');
          return 0;
        });
        req.log.info({ refunded: n }, 'refunds sent');
      }
      // Always 200 once recorded (even ignored/refund) so the provider stops retrying.
      return { received: true, outcome };
    });
  });
}
