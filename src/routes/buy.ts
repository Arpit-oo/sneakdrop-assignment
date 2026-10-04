import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRODUCT_ID } from '../db/seed.js';
import { buy, cancelHold } from '../domain/holds.js';

// No real auth in this assignment: the caller says who they are.
const userId = z.string().trim().min(1).max(64);

const buyBody = z.object({ userId, productId: z.string().min(1).default(PRODUCT_ID) });
const cancelBody = z.object({ userId });
const holdParams = z.object({ id: z.string().uuid() });

export async function buyRoutes(app: FastifyInstance) {
  app.post('/buy', async (req, reply) => {
    const body = buyBody.parse(req.body);
    const result = await buy(body.userId, body.productId);
    if (result.kind === 'sold_out') {
      return reply.code(200).send({ soldOut: true, canJoinWaitlist: result.canJoinWaitlist, position: result.position });
    }
    const { hold } = result;
    return reply.code(201).send({ holdId: hold.id, status: hold.status, expiresAt: hold.expiresAt });
  });

  app.delete('/holds/:id', async (req) => {
    const { id } = holdParams.parse(req.params);
    const body = cancelBody.parse(req.body ?? {});
    const hold = await cancelHold(id, body.userId);
    return { holdId: hold.id, status: hold.status };
  });
}
