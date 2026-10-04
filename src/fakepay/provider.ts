import { randomUUID } from 'node:crypto';
import type { PaymentEvent } from '../payments/events.js';
import { SIGNATURE_HEADER, sign } from '../payments/signature.js';

/**
 * Fake payment provider — behaves like a badly-behaved real one.
 * For each checkout it sends signed webhooks over real HTTP with:
 *   - random delay (0..maxDelayMs) per delivery
 *   - duplicates: same event (same id) delivered again later
 *   - reordering: the stale "payment.pending" delivered AFTER the final event
 *   - failures: some payments end in "payment.failed"
 *   - retries with backoff when our endpoint doesn't answer 2xx
 * It knows nothing about holds or stock — it only echoes holdId as metadata.
 */

export type Chaos = {
  maxDelayMs: number;
  duplicateRate: number;
  reorderRate: number;
  failRate: number;
};

export type Outcome = 'succeeded' | 'failed';
export type Delivery = { event: PaymentEvent; delayMs: number };

export type CheckoutInput = {
  holdId: string;
  amountCents: number;
  /** Force the result instead of rolling failRate (demo / tests). */
  outcome?: Outcome;
};

export type FakePayOptions = {
  webhookUrl: string;
  secret: string;
  chaos: Chaos;
  rng?: () => number;
  maxAttempts?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

/**
 * Pure: decide which events go out and when. Kept separate from sending so
 * tests can assert the chaos shape without timers or HTTP.
 */
export function planDeliveries(
  input: CheckoutInput & { paymentId: string },
  chaos: Chaos,
  rng: () => number = Math.random,
  now = Date.now(),
): Delivery[] {
  const outcome: Outcome = input.outcome ?? (rng() < chaos.failRate ? 'failed' : 'succeeded');
  const base = { paymentId: input.paymentId, holdId: input.holdId, amountCents: input.amountCents };

  const pending: PaymentEvent = {
    ...base,
    id: `evt_${randomUUID()}`,
    type: 'payment.pending',
    occurredAt: new Date(now).toISOString(),
  };
  const final: PaymentEvent = {
    ...base,
    id: `evt_${randomUUID()}`,
    type: `payment.${outcome}`,
    occurredAt: new Date(now + 1).toISOString(),
  };

  const delay = () => Math.floor(rng() * chaos.maxDelayMs);
  const finalDelay = delay();
  const reorder = rng() < chaos.reorderRate;
  // in order: pending strictly before final. reordered: pending strictly after.
  const pendingDelay = reorder ? finalDelay + 1 + delay() : Math.floor(finalDelay * rng());

  const out: Delivery[] = [
    { event: pending, delayMs: pendingDelay },
    { event: final, delayMs: finalDelay },
  ];
  if (rng() < chaos.duplicateRate) out.push({ event: final, delayMs: finalDelay + 1 + delay() });
  return out.sort((a, b) => a.delayMs - b.delayMs);
}

export class FakePay {
  private inflight = new Set<Promise<void>>();
  private readonly rng: () => number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: FakePayOptions) {
    this.rng = opts.rng ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  /** Start a payment. Returns immediately; webhooks follow asynchronously. */
  checkout(input: CheckoutInput): { paymentId: string; deliveries: Delivery[] } {
    const paymentId = `pay_${randomUUID()}`;
    const deliveries = planDeliveries({ ...input, paymentId }, this.opts.chaos, this.rng);
    for (const d of deliveries) this.track(this.deliverLater(d));
    return { paymentId, deliveries };
  }

  /**
   * Refund a payment (synchronous API call, like a real provider's refund
   * endpoint). Idempotent on idempotencyKey: asking twice returns the same refund.
   */
  private refunds = new Map<string, { refundId: string; paymentId: string; amountCents: number }>();
  async refund(input: { paymentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string }> {
    const existing = this.refunds.get(input.idempotencyKey);
    if (existing) return { refundId: existing.refundId };
    const refundId = `re_${randomUUID()}`;
    this.refunds.set(input.idempotencyKey, { refundId, paymentId: input.paymentId, amountCents: input.amountCents });
    return { refundId };
  }

  /** Every refund this provider has issued (tests / demos). */
  issuedRefunds() {
    return [...this.refunds.values()];
  }

  /** Send one event right now (with retries). Also used by tests to replay. */
  async send(event: PaymentEvent): Promise<number> {
    const body = JSON.stringify(event);
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(this.opts.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(body, this.opts.secret) },
          body,
        });
        lastStatus = res.status;
        await res.arrayBuffer();
        if (res.ok) return res.status;
        if (res.status >= 400 && res.status < 500) break; // our request is wrong; retrying won't help
      } catch {
        lastStatus = 0; // network error -> retry
      }
      await sleep(100 * 2 ** (attempt - 1));
    }
    this.opts.log?.('webhook delivery gave up', { eventId: event.id, status: lastStatus });
    return lastStatus;
  }

  /** Resolves when every scheduled delivery has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async deliverLater(d: Delivery): Promise<void> {
    await sleep(d.delayMs);
    await this.send(d.event);
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
