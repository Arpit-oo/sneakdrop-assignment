import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { resetSale } from '../db/reset.js';
import { PRODUCT_ID } from '../db/seed.js';

const resetBody = z
  .object({
    stock: z.number().int().min(1).max(10_000).optional(),
    holdSeconds: z.number().int().min(5).max(3600).optional(),
    maxPerUser: z.number().int().min(1).max(100).optional(),
  })
  .default({});

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Operator endpoint for running a fresh sale (e.g. before a demo) on a hosted
 * instance without shell access. Only registered when ADMIN_TOKEN is set.
 *
 *   curl -X POST $URL/admin/reset -H "authorization: Bearer $ADMIN_TOKEN" \
 *        -H 'content-type: application/json' -d '{"stock":2,"holdSeconds":30}'
 */
export async function adminRoutes(app: FastifyInstance, opts: { token: string }) {
  app.post('/admin/reset', async (req, reply) => {
    if (!authorized(req.headers.authorization, opts.token)) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    const body = resetBody.parse(req.body ?? {});
    await resetSale();
    const { rows } = await pool.query(
      `UPDATE products SET
         total_stock  = COALESCE($2, total_stock),
         hold_seconds = COALESCE($3, hold_seconds),
         max_per_user = COALESCE($4, max_per_user)
       WHERE id = $1
       RETURNING total_stock, hold_seconds, max_per_user`,
      [PRODUCT_ID, body.stock ?? null, body.holdSeconds ?? null, body.maxPerUser ?? null],
    );
    // TRUNCATE and products updates don't fire the change triggers: tell open pages ourselves
    await pool.query(`SELECT pg_notify('sale_changed', '')`);
    req.log.warn({ rules: rows[0] }, 'sale reset by admin');
    return { reset: true, stock: rows[0].total_stock, holdSeconds: rows[0].hold_seconds, maxPerUser: rows[0].max_per_user };
  });
}
