/**
 * Load test + proof of correctness.
 *
 *   npm run load                       # spawns 2 API instances, 5000 buyers
 *   USERS=10000 INSTANCES=3 npm run load
 *   BASE_URLS=http://localhost:3000 npm run load   # hit servers you started yourself
 *
 * Steps:
 *   1. reset sale data in DATABASE_URL (skip with NO_RESET=1), shorten holds so expiry happens
 *   2. start INSTANCES API servers on the same DB (each with its own expiry worker + fake provider)
 *   3. burst: USERS different people click Buy at once, spread round-robin over instances
 *   4. WAITERS of the losers join the line
 *   5. every hold owner: pays (PAY_RATE) / cancels (CANCEL_RATE) / walks away (rest, hold expires);
 *      promoted waiters get the same treatment as their holds appear
 *   6. wait until no holds are active and webhooks went quiet
 *   7. check invariants straight from the database, print a summary, exit 1 if anything is off
 *
 * WARNING: wipes holds / orders / waitlist / payment events in the target database.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { resetSale } from '../src/db/reset.js';
import { PRODUCT_ID, seed } from '../src/db/seed.js';

const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));

const USERS = env('USERS', 5000);
const CONCURRENCY = env('CONCURRENCY', 500);
const INSTANCES = env('INSTANCES', 2);
const BASE_PORT = env('LOAD_BASE_PORT', 3101);
const WAITERS = env('WAITERS', 100);
const PAY_RATE = env('PAY_RATE', 0.6);
const CANCEL_RATE = env('CANCEL_RATE', 0.15);
const HOLD_SECONDS = env('LOAD_HOLD_SECONDS', 10);
const TIMEOUT_S = env('TIMEOUT_S', 180);
const EXTERNAL = process.env.BASE_URLS?.split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = Math.random;

// ---------------------------------------------------------------- instances

const children: ChildProcess[] = [];

async function startInstances(): Promise<string[]> {
  if (EXTERNAL?.length) return EXTERNAL;
  const urls: string[] = [];
  for (let i = 0; i < INSTANCES; i++) {
    const port = BASE_PORT + i;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        LOG_LEVEL: 'error',
        WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/payment`,
        EXPIRY_INTERVAL_MS: '500',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(child);
    urls.push(`http://127.0.0.1:${port}`);
  }
  for (const url of urls) {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 100) throw new Error(`${url} did not start`);
      await sleep(200);
    }
  }
  return urls;
}

function stopInstances() {
  for (const c of children) c.kill();
}

// ---------------------------------------------------------------- http + stats

type Call = { status: number; ms: number; body: any };
const latencies: Record<string, number[]> = {};
const statuses: Record<string, Record<string, number>> = {};

async function call(label: string, url: string, method: string, body?: unknown): Promise<Call> {
  const t0 = performance.now();
  let status = 0;
  let json: any;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    json = await res.json().catch(() => undefined);
  } catch {
    status = 0; // network error
  }
  const ms = performance.now() - t0;
  (latencies[label] ??= []).push(ms);
  const s = (statuses[label] ??= {});
  const key = status === 200 && json?.soldOut ? '200 soldOut' : status === 409 ? `409 ${json?.error}` : String(status);
  s[key] = (s[key] ?? 0) + 1;
  return { status, ms, body: json };
}

async function runPool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// ---------------------------------------------------------------- scenario

async function main() {
  const t0 = performance.now();
  await migrate();
  if (!process.env.NO_RESET) await resetSale();
  await seed();
  await pool.query('UPDATE products SET hold_seconds = $1 WHERE id = $2', [HOLD_SECONDS, PRODUCT_ID]);
  const { rows: prod } = await pool.query('SELECT total_stock, max_per_user FROM products WHERE id = $1', [
    PRODUCT_ID,
  ]);
  const { total_stock: STOCK, max_per_user: MAX } = prod[0];

  const urls = await startInstances();
  const pick = (i: number) => urls[i % urls.length];
  const perInstance: Record<string, number> = {};
  console.log(`\n${urls.length} instance(s): ${urls.join(', ')}`);
  console.log(`burst: ${USERS} buyers, concurrency ${CONCURRENCY}, stock ${STOCK}, hold ${HOLD_SECONDS}s\n`);

  // 3. burst
  const users = Array.from({ length: USERS }, (_, i) => `load-${i}`);
  const winners: { user: string; holdId: string; base: string }[] = [];
  const losers: string[] = [];
  const burstStart = performance.now();
  await runPool(users, CONCURRENCY, async (user, i) => {
    const base = pick(i);
    const r = await call('buy (burst)', `${base}/buy`, 'POST', { userId: user });
    if (r.status === 201) {
      winners.push({ user, holdId: r.body.holdId, base });
      perInstance[base] = (perInstance[base] ?? 0) + 1;
    } else if (r.body?.soldOut) losers.push(user);
  });
  const burstSeconds = (performance.now() - burstStart) / 1000;

  // 4. some losers queue up
  await runPool(losers.slice(0, WAITERS), 50, async (user, i) => {
    await call('join line', `${pick(i)}/waitlist`, 'POST', { userId: user });
  });

  // 5. decide fate of each hold, including ones handed to waiters later
  const handled = new Set<string>();
  const fate: Record<string, number> = { pay: 0, cancel: 0, abandon: 0 };
  const act = async (h: { user: string; holdId: string; base: string }) => {
    handled.add(h.holdId);
    const r = rnd();
    if (r < PAY_RATE) {
      fate.pay++;
      await call('pay', `${h.base}/holds/${h.holdId}/pay`, 'POST', { userId: h.user });
    } else if (r < PAY_RATE + CANCEL_RATE) {
      fate.cancel++;
      await call('cancel', `${h.base}/holds/${h.holdId}`, 'DELETE', { userId: h.user });
    } else {
      fate.abandon++; // just walk away; expiry worker frees it
    }
  };
  await Promise.all(winners.map(act));

  // 6. keep acting on promoted holds until everything settles
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let lastEvents = -1;
  let quietSince = Date.now();
  for (;;) {
    const { rows: active } = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM holds WHERE status = 'active'`,
    );
    const fresh = active.filter((h) => !handled.has(h.id));
    await Promise.all(fresh.map((h, i) => act({ user: h.user_id, holdId: h.id, base: pick(i) })));

    const { rows: ev } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM payment_events');
    if (ev[0].n !== lastEvents) {
      lastEvents = ev[0].n;
      quietSince = Date.now();
    }
    const quietMs = Date.now() - quietSince;
    // done: nothing active, and no webhook for longer than the provider's max delay + retries
    if (active.length === 0 && quietMs > config.FAKEPAY_MAX_DELAY_MS * 2 + 2000) break;
    if (Date.now() > deadline) {
      console.warn('timeout waiting for sale to settle');
      break;
    }
    await sleep(500);
  }

  // 7. verify
  const q = async (sql: string) => (await pool.query(sql, [PRODUCT_ID])).rows[0];
  const s = await q(`SELECT held::int, sold::int, available::int FROM product_stock WHERE product_id = $1`);
  const inv = await q(`
    SELECT
      (SELECT COUNT(*)::int FROM orders WHERE product_id = $1) AS orders,
      (SELECT COUNT(*)::int FROM holds WHERE product_id = $1 AND status = 'paid') AS paid_holds,
      (SELECT COUNT(*)::int FROM holds h WHERE h.product_id = $1 AND h.status = 'paid'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.hold_id = h.id)) AS paid_without_order,
      (SELECT COUNT(*)::int FROM orders o JOIN holds h ON h.id = o.hold_id
         WHERE o.product_id = $1 AND h.status <> 'paid') AS order_without_paid,
      (SELECT COALESCE(MAX(c), 0)::int FROM (SELECT COUNT(*) c FROM orders WHERE product_id = $1 GROUP BY user_id) x)
        AS max_orders_per_user,
      (SELECT COUNT(*)::int FROM payment_events WHERE outcome IS NULL) AS unprocessed_events,
      (SELECT COUNT(*)::int FROM holds WHERE product_id = $1) AS holds_total,
      (SELECT COUNT(*)::int FROM holds WHERE product_id = $1 AND source = 'waitlist') AS holds_from_line
  `);
  const outcomes = (
    await pool.query<{ outcome: string; n: number }>(
      'SELECT outcome, COUNT(*)::int AS n FROM payment_events GROUP BY 1 ORDER BY 2 DESC',
    )
  ).rows;
  const line = (
    await pool.query<{ k: string; n: number }>(
      `SELECT status || COALESCE(' (' || left_reason || ')', '') AS k, COUNT(*)::int AS n
       FROM waitlist WHERE product_id = $1 GROUP BY 1 ORDER BY 1`,
      [PRODUCT_ID],
    )
  ).rows;

  const checks: [string, boolean, string][] = [
    // If the burst outlasts a hold, expired pairs get re-sold mid-burst, so "exactly STOCK" only
    // applies when it doesn't. Oversell is still checked below either way.
    burstSeconds < HOLD_SECONDS
      ? ['burst: exactly STOCK holds granted', winners.length === STOCK, `${winners.length} / ${STOCK}`]
      : ['burst: holds granted (burst > hold time)', true, `${winners.length}, re-sold after expiry`],
    ['burst: no errors (5xx / network)', !Object.keys(statuses['buy (burst)'] ?? {}).some((k) => k === '0' || k.startsWith('5')), JSON.stringify(statuses['buy (burst)'])],
    ['never oversold: held + sold <= stock', s.held + s.sold <= STOCK, `${s.held} + ${s.sold} <= ${STOCK}`],
    ['orders == paid holds', inv.orders === inv.paid_holds, `${inv.orders} == ${inv.paid_holds}`],
    ['no paid hold without order', inv.paid_without_order === 0, String(inv.paid_without_order)],
    ['no order without paid hold', inv.order_without_paid === 0, String(inv.order_without_paid)],
    [`nobody bought more than ${MAX}`, inv.max_orders_per_user <= MAX, `max ${inv.max_orders_per_user}`],
    ['every webhook event processed', inv.unprocessed_events === 0, String(inv.unprocessed_events)],
    ['sale settled (no active holds)', s.held === 0, `${s.held} active`],
  ];

  // ------------------------------------------------------------ report
  const row = (cols: (string | number)[], w: number[]) =>
    cols.map((c, i) => String(c).padEnd(w[i])).join('  ');

  console.log('── requests ──────────────────────────────────────────────');
  console.log(row(['endpoint', 'count', 'p50 ms', 'p95 ms', 'p99 ms', 'results'], [14, 6, 7, 7, 7, 0]));
  for (const [label, xs] of Object.entries(latencies)) {
    console.log(
      row(
        [label, xs.length, pct(xs, 50).toFixed(0), pct(xs, 95).toFixed(0), pct(xs, 99).toFixed(0), JSON.stringify(statuses[label])],
        [14, 6, 7, 7, 7, 0],
      ),
    );
  }
  console.log(`burst throughput: ${(USERS / burstSeconds).toFixed(0)} req/s over ${burstSeconds.toFixed(2)}s`);
  console.log(`holds won per instance: ${JSON.stringify(perInstance)}`);

  console.log('\n── sale ──────────────────────────────────────────────────');
  console.log(`stock ${STOCK} | sold ${s.sold} | held ${s.held} | available ${s.available}`);
  console.log(`holds created ${inv.holds_total} (from line: ${inv.holds_from_line}) | fates: ${JSON.stringify(fate)}`);
  console.log(`line: ${line.map((l) => `${l.k}=${l.n}`).join(', ') || '—'}`);
  console.log(`webhook outcomes: ${outcomes.map((o) => `${o.outcome}=${o.n}`).join(', ')}`);

  console.log('\n── invariants ────────────────────────────────────────────');
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
  const failed = checks.filter((c) => !c[1]).length;
  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'ALL CHECKS PASSED'} in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
  return failed ? 1 : 0;
}

main()
  .then(async (code) => {
    stopInstances();
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    stopInstances();
    await pool.end().catch(() => {});
    process.exit(1);
  });
