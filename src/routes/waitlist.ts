import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRODUCT_ID } from '../db/seed.js';
import { DomainError } from '../domain/errors.js';
import { getPosition, joinWaitlist, leaveWaitlist } from '../domain/waitlist.js';

const userId = z.string().trim().min(1).max(64);
const productId = z.string().min(1).default(PRODUCT_ID);
const who = z.object({ userId, productId });

export async function waitlistRoutes(app: FastifyInstance) {
  app.post('/waitlist', async (req, reply) => {
    const body = who.parse(req.body);
    const { position, alreadyWaiting } = await joinWaitlist(body.userId, body.productId);
    return reply.code(alreadyWaiting ? 200 : 201).send({ position });
  });

  app.delete('/waitlist', async (req) => {
    const body = who.parse(req.body ?? {});
    await leaveWaitlist(body.userId, body.productId);
    return { left: true };
  });

  app.get('/waitlist/position', async (req) => {
    const q = who.parse(req.query);
    const position = await getPosition(q.userId, q.productId);
    if (position === undefined) throw new DomainError('NOT_IN_LINE', 404, 'You are not in line');
    return { position };
  });
}
