import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRODUCT_ID } from '../db/seed.js';
import { getState } from '../domain/state.js';
import type { SaleHub } from '../live/hub.js';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const who = z.object({ userId: z.string().trim().min(1).max(64), productId: z.string().min(1).default(PRODUCT_ID) });

export async function stateRoutes(app: FastifyInstance, opts: { hub: SaleHub }) {
  // open SSE streams; ended on shutdown so close() doesn't wait on them forever
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
  });

  /** The status page. Plain HTML + inline JS, no build step. ?user=alice picks who you are. */
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return readFile(PAGE, 'utf8');
  });

  /** Snapshot of everything the page shows. Also the polling fallback. */
  app.get('/state', async (req) => {
    const q = who.parse(req.query);
    return getState(q.userId, q.productId);
  });

  /**
   * Server-Sent Events: pushes a fresh state whenever any instance changes
   * the sale (Postgres LISTEN/NOTIFY), plus once on connect.
   */
  app.get('/events', async (req, reply) => {
    const q = who.parse(req.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    streams.add(res);
    let closed = false;
    let busy = false;
    let again = false;
    const push = async () => {
      if (closed) return;
      if (busy) {
        again = true; // coalesce: one more push after the current one
        return;
      }
      busy = true;
      try {
        const state = await getState(q.userId, q.productId);
        if (!closed) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      } catch (err) {
        req.log.warn(err, 'sse state failed');
      } finally {
        busy = false;
        if (again) {
          again = false;
          void push();
        }
      }
    };

    const unsubscribe = await opts.hub.subscribe(() => void push());
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      closed = true;
      streams.delete(res);
      clearInterval(heartbeat);
      unsubscribe();
    });
    await push();
  });
}
