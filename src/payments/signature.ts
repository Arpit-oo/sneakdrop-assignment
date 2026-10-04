import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-style webhook signature:  header = "t=<unix seconds>,v1=<hex hmac>"
 * where hmac = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * Timestamp is signed too, so an old captured request can't be replayed later.
 */
export const SIGNATURE_HEADER = 'x-fakepay-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

const hmac = (secret: string, t: number, body: string) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export function sign(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmac(secret, t, body)}`;
}

export function verify(
  header: string | undefined,
  body: string,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const given = parts.v1;
  if (!Number.isInteger(t) || !given || !/^[0-9a-f]{64}$/.test(given)) return false;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;

  return timingSafeEqual(Buffer.from(hmac(secret, t, body), 'hex'), Buffer.from(given, 'hex'));
}
