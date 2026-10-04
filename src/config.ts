import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STOCK: z.coerce.number().int().positive().default(20),
  HOLD_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_PER_USER: z.coerce.number().int().positive().default(2),
  WEBHOOK_SECRET: z.string().min(1).default('change-me'),
  // Expiry sweep period. 0 = don't run the worker inside the API process.
  EXPIRY_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),

  // Fake payment provider. Where it delivers webhooks (default: this server).
  WEBHOOK_URL: z.string().url().optional(),
  // Chaos knobs: webhook delay up to N ms, chance of duplicate delivery,
  // chance a stale "pending" arrives after the final event, chance payment fails.
  FAKEPAY_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),
  FAKEPAY_DUPLICATE_RATE: z.coerce.number().min(0).max(1).default(0.3),
  FAKEPAY_REORDER_RATE: z.coerce.number().min(0).max(1).default(0.2),
  FAKEPAY_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
