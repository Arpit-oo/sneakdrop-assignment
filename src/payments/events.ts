import { z } from 'zod';

/** Webhook payload sent by the fake provider (shape modelled on Stripe events). */
export const paymentEventSchema = z.object({
  id: z.string().min(1).max(100), // event id — unique per delivery attempt *content*, reused on resend
  type: z.enum(['payment.pending', 'payment.succeeded', 'payment.failed']),
  paymentId: z.string().min(1).max(100),
  holdId: z.string().uuid(), // our metadata, echoed back by the provider
  amountCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type PaymentEventType = PaymentEvent['type'];
