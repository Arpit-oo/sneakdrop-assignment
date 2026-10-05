# Sneaker Drop — Notes

[![ci](https://github.com/Arpit-oo/sneakdrop-assignment/actions/workflows/ci.yml/badge.svg)](https://github.com/Arpit-oo/sneakdrop-assignment/actions/workflows/ci.yml)

20 pairs, thousands of simultaneous Buy clicks, never oversell.

**Core idea:** the database is the only source of truth, and every decision that touches stock happens inside one Postgres transaction that holds a lock on the product row. API servers keep no state, so you can run as many as you like.

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Docker | any recent version | the only thing needed for the quick start |
| Node.js | 20+ (built and tested on 22) | only for local development, tests and the load test |

No other services are needed (no Redis, no queue). Postgres runs on **localhost:5433**, so it won't clash with a local Postgres on 5432.

## Quick start (one command)

```bash
docker compose up --build
```

This starts Postgres and the app, runs the migrations, creates the product (20 pairs), and serves **http://localhost:3000/?user=alice**. Open a second tab as `?user=bob` to watch it update live.
- Use a different port: `APP_PORT=8080 docker compose up --build`.
- Run a quicker demo sale: `STOCK=2 HOLD_SECONDS=30 docker compose up --build`.

## Hosted

**Live: https://sneakdrop-3otn.onrender.com/?user=alice** (open a second tab with `?user=bob`, add `&demo=1` for the "make this payment fail" switch). Free tier, so the first visit after idling can take ~30 s.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Arpit-oo/sneakdrop-assignment)

`render.yaml` sets up the app (from the same `Dockerfile`) plus a managed Postgres 16. The app migrates and seeds itself on start.
- Free tier: the app sleeps after ~15 minutes idle, so the first request takes ~30 s.
- Free Render Postgres expires after 30 days.

Not Vercel, on purpose. This app needs three always-on pieces:
- an always-on process (the expiry worker)
- a long-lived database listener + streaming connections (live push)
- a payment simulator that answers seconds after the request

Serverless functions don't provide those.

## How to run for development

```bash
cp .env.example .env
docker compose up -d --wait db  # only Postgres 16 (+ a second database for tests)
npm install
npm run migrate                 # create tables
npm run seed                    # create the product with 20 pairs
npm run dev                     # http://localhost:3000
```

Open **http://localhost:3000/?user=alice** and another tab with **?user=bob** to watch the sale update live.
Check the API is up: `curl localhost:3000/health` → `{"ok":true}`

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload. Also runs the expiry worker and the fake payment provider |
| `npm start` | Same without reload |
| `npm run worker` | Expiry worker on its own (use with `EXPIRY_INTERVAL_MS=0` on the API) |
| `npm run migrate` | Apply SQL migrations (safe to run again) |
| `npm run seed` | Create or update the product from `STOCK` / `HOLD_SECONDS` / `MAX_PER_USER` |
| `npm run demo:reset` | Fresh demo sale: 2 pairs, 30 s holds (`npm run demo:reset -- 20 300` for normal). Works in any shell |
| `npm run db:reset` | Delete all sale activity (holds, orders, line, payment events). Keeps the product |
| `npm test` | 98 tests against a real Postgres (`sneakdrop_test` database) |
| `npm run load` | Load test + correctness check (see below). **Wipes sale data in `DATABASE_URL`** |
| `npm run typecheck` | `tsc --noEmit` |

### Environment variables (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://sneak:sneak@localhost:5433/sneakdrop` | Main database |
| `TEST_DATABASE_URL` | `…/sneakdrop_test` | Used by `npm test` only |
| `PORT` | `3000` | API port |
| `LOG_LEVEL` | `info` | `error` keeps logs quiet |
| `STOCK` | `20` | Pairs for sale (applied by `npm run seed`) |
| `HOLD_SECONDS` | `300` | How long a hold lasts (applied by `npm run seed`) |
| `MAX_PER_USER` | `2` | Max pairs one person can buy (applied by `npm run seed`) |
| `EXPIRY_INTERVAL_MS` | `1000` | How often the expiry worker runs. `0` = don't run it inside the API |
| `WEBHOOK_SECRET` | `change-me` | Shared secret used to sign and check payment webhooks (warns at startup if left default in production) |
| `ADMIN_TOKEN` | unset | Enables `POST /admin/reset` (see API). Unset = the route doesn't exist |
| `WEBHOOK_URL` | `http://localhost:$PORT/webhooks/payment` | Where the fake provider sends webhooks |
| `FAKEPAY_MAX_DELAY_MS` | `3000` | Each webhook is delayed by a random 0..N ms |
| `FAKEPAY_DUPLICATE_RATE` | `0.3` | Chance the final event is sent twice |
| `FAKEPAY_REORDER_RATE` | `0.2` | Chance the old "pending" event arrives after the final one |
| `FAKEPAY_FAIL_RATE` | `0.1` | Chance a payment fails |

Rule values are stored on the product row in the database. After changing `STOCK`, `HOLD_SECONDS` or `MAX_PER_USER`, run `npm run seed` again.

There's no login. Every request just says who the user is (`userId`), which is enough for this exercise (see "Trade-offs" below).

---

## API

| Method & path | Body / query | Responses |
|---|---|---|
| `POST /buy` | `{userId}` | `201 {holdId, status, expiresAt}` · `200 {soldOut:true, canJoinWaitlist, position?}` · `409 ALREADY_HOLDING` (includes your current hold) · `409 LIMIT_REACHED` |
| `DELETE /holds/:id` | `{userId}` | `200 {status:"cancelled"}` · `404` (not found, or not yours) · `409 HOLD_EXPIRED` / `HOLD_NOT_ACTIVE` |
| `POST /holds/:id/pay` | `{userId, outcome?}` | `202 {paymentId, amountCents}`, and the result arrives later by webhook. `outcome: "succeeded"\|"failed"` forces the result for demos |
| `POST /waitlist` | `{userId}` | `201 {position}` · `200 {position}` (already in line) · `409 NOT_SOLD_OUT` / `ALREADY_HOLDING` / `LIMIT_REACHED` |
| `DELETE /waitlist` | `{userId}` | `200` · `404 NOT_IN_LINE` |
| `GET /waitlist/position` | `?userId=` | `200 {position}` · `404` |
| `POST /webhooks/payment` | signed provider event | `200 {outcome}` · `401` bad signature · `400` bad body |
| `POST /fakepay/checkout` | `{holdId, amountCents, outcome?}` | The fake provider's own API, for chaos demos |
| `GET /` | `?user=` | Status page |
| `GET /state` | `?userId=` | Everything the page shows: stock counts, your hold, bought, place in line, last payment |
| `GET /events` | `?userId=` | Server-Sent Events stream: pushes a fresh `state` whenever anything changes |
| `GET /health` | | `{ok:true}` |
| `POST /admin/reset` | header `authorization: Bearer $ADMIN_TOKEN`, body `{stock?, holdSeconds?, maxPerUser?}` | Wipes sale activity and applies new rules. Open pages refresh. Only exists when `ADMIN_TOKEN` is set |

Example session:

```bash
J='content-type: application/json'
curl -s -XPOST localhost:3000/buy -H "$J" -d '{"userId":"alice"}'
# {"holdId":"…","status":"active","expiresAt":"…"}
curl -s -XPOST localhost:3000/holds/<holdId>/pay -H "$J" -d '{"userId":"alice"}'
# {"paymentId":"pay_…","amountCents":19900,"status":"processing"}   → webhook lands 0–3 s later
```

---

## Architecture

```
          many API instances (stateless)                       PostgreSQL 16
 ┌───────────────────────────────────────────┐        ┌───────────────────────────────┐
 │ Fastify routes                             │        │ products  (1 row = the lock)  │
 │  /buy /holds /waitlist /webhooks /fakepay  │──SQL──▶│ holds     active|paid|expired │
 │                                            │        │           |cancelled          │
 │ domain/  holds · waitlist · payments       │        │ orders    hold_id UNIQUE      │
 │          release (expire + promote line)   │        │ waitlist  BIGSERIAL = FIFO    │
 │                                            │        │ payment_events  event_id PK   │
 │ workers/expiry   every 1 s, SKIP LOCKED    │        │ trigger: refuses oversell     │
 │ fakepay/provider ── signed HTTP webhooks ──┼──┐     └───────────────────────────────┘
 └───────────────────────────────────────────┘  │
                     ▲                          │  delayed, duplicated, reordered, failing
                     └──── POST /webhooks/payment ◀┘
```

```
src/
  app.ts, server.ts         Fastify setup, error handling, startup/shutdown
  config.ts                 env settings, checked with zod
  db/                       pool + withTx, migrations, migrate/seed/reset
  domain/
    product.ts              lockProduct, availableStock, userUsage
    release.ts              expireStaleHolds + promoteWaiting (pair freed → line)
    holds.ts                buy, cancelHold, sold-out fast path
    waitlist.ts             join, leave, position
    payments.ts             webhook state machine, prepareCheckout
    state.ts                one-query snapshot for the status page
  live/hub.ts               LISTEN sale_changed → push to open pages
  web/index.html            status page (plain HTML + JS, no build step)
  payments/                 event schema, HMAC signature
  fakepay/provider.ts       chaotic fake payment company
  routes/                   HTTP layer only
  workers/expiry.ts         background expiry
tests/                      98 integration tests against real Postgres
scripts/load.ts             load test + correctness check
```

---

## How each rule is enforced

### Never sell more than 20

- **Stock is calculated, not stored.** `available = total_stock − count(holds that are active or paid)`. There's no counter that can drift away from the holds table.
- **Every stock decision runs in one transaction that first locks the product row** (`SELECT … FOR UPDATE`). This covers buy, cancel, expiry, promotion from the line, and payment webhooks. Decisions for the product happen strictly one at a time. Each lock is held for milliseconds, and with 20 pairs, queuing on that one row is the intended behaviour.
- **Database safety net.** A trigger on `holds` locks the product and rejects any insert or status change that would push active+paid above the stock or above the per-user limit. Even buggy app code can't oversell. A test fires 500 raw `INSERT`s at once, bypassing the app, and exactly 20 succeed.
- **Fast "sold out" answer.** Once sold out, most clicks are "no". These are answered with a single read that takes no lock. That's safe because nothing is written and the answer is just a snapshot a few ms old. Any case that could change the answer (an overdue hold, or a user who already holds or has bought) goes through the locked path. Without this, the load test managed 96 req/s. With it, 556–663 req/s.
- **Times come from the database (`now()`)**, never from an app server's clock, so instances with slightly different clocks can't disagree.

### Rule 1: 5-minute hold, unpaid pairs go back

- A hold gets `expires_at = now() + hold_seconds`.
- **Two ways a hold expires:**
  1. **Lazily:** every transaction that touches stock first expires overdue holds. If the worker is down, a stuck hold still can't block a sale.
  2. **Expiry worker** (every 1 s): for each product with overdue holds it does `SELECT … FOR UPDATE SKIP LOCKED`. If another instance or a buyer already holds the lock, it skips that product, because that transaction does the lazy expiry itself. Any number of workers can run without blocking each other or processing the same hold twice.

### Rule 2: one hold at a time, max 2 bought

- Checked inside the locked transaction, so the user gets a clear `409`.
- Also enforced by the database:
  - a partial unique index allows one `active` hold per user
  - the trigger enforces the limit of 2
- A user clicking Buy 50 times at once gets exactly 1 hold.

### Rule 3: waiting line

- You can join only when sold out. The line is FIFO by `BIGSERIAL` id, one place per user. Position = number of people waiting ahead of you + 1.
- **Promotion happens in the same transaction that frees the pair** (expiry, cancel, failed payment). So no moment exists where a pair is free while someone is waiting, and a direct buyer can never jump the line.
- Each promoted user gets a fresh hold of the full length. If they don't pay, it expires and the next person gets it.
- If the next person can no longer take a pair (they're already holding one, or already bought 2), they're removed from the line with a recorded reason (`skipped_holding` / `skipped_limit`) and the pair goes to the person after them.
- **Lock order is always product → holds → waitlist**, so there are no deadlocks. Leaving the line also takes the product lock, so a leave and a promotion of the same person can't both succeed.

### Rule 4: messy fake payments

**Fake provider** (`src/fakepay/provider.ts`). It knows nothing about stock; it just echoes `holdId` back as metadata, like Stripe metadata. For each payment it sends a `payment.pending` event and a final `payment.succeeded` or `payment.failed` event. Each webhook goes over real HTTP, signed Stripe-style (`x-fakepay-signature: t=…,v1=HMAC-SHA256(secret, "t.body")`), and it:
- delays each one randomly
- sometimes sends the final event twice (same event id)
- sometimes delivers the stale `pending` after the final event
- sometimes makes the payment fail
- retries with backoff if our endpoint doesn't answer 2xx

**Webhook handler** (`src/domain/payments.ts`). Each event is processed in one transaction:
1. Check the signature (+ 5 min replay window). Bad → `401`, nothing stored.
2. `INSERT INTO payment_events … ON CONFLICT (event_id) DO NOTHING`. Already seen → stop (`duplicate_event`).
3. Lock product → expire overdue holds (+ promote line) → lock the hold row.
4. Apply a **forward-only** state machine. `paid` is final, so an event arriving late or out of order can never undo a payment.
5. Store what was decided on the event row (`outcome`) and return `200` so the provider stops retrying.

If anything fails midway, the inbox row rolls back too, and the provider's retry gets processed properly.

| Hold is | Event | Result (`outcome`) |
|---|---|---|
| anything | pending | nothing (`ignored_pending`) |
| active | succeeded | **paid**, order created (`paid`) |
| paid | succeeded, same payment | nothing (`ignored_already_paid`) |
| paid | succeeded, *different* payment (double click on Pay) | no 2nd order, **refunded** (`refund_required_double_charge`) |
| expired / cancelled | succeeded, pair still free and user under limit | revived as **paid** (`late_paid`) |
| expired / cancelled | succeeded, pair gone or user at limit | **refunded** (`refund_required_late`), no oversell |
| active | failed | hold released, pair goes to the line (`released`) |
| not active | failed | nothing (`ignored_terminal`) |
| — | wrong amount / unknown hold | nothing (`ignored_amount_mismatch` / `ignored_unknown_hold`) |

Also, `orders.hold_id` and `orders.payment_id` are both `UNIQUE`, so the database can't create two orders for one hold or one payment.

**Refunds** (`src/domain/refunds.ts`, migration 004):
1. When a payment must be returned, a `refunds` row is written **in the same transaction** as the webhook, so a refund can't be forgotten.
2. After commit, the app calls the fake provider's refund API.
3. Safety:
   - `payment_id` is `UNIQUE`, so duplicate webhooks never refund twice.
   - Pending refunds are picked with `FOR UPDATE SKIP LOCKED`, so two instances never send the same one.
   - The payment id is sent as the provider's idempotency key, so retrying after a crash is safe.
   - If the provider is down, the refund stays `pending` and is retried on the next refund run.

### Rule 5: status page

`GET /?user=alice` serves a single plain HTML page with inline JS and no build step. Who you are comes from `?user=` (you can change it in the header).

**One action panel** at the top is the only place you act. Its colour, big figure and buttons change with your state:

| state | panel | big figure | buttons |
|---|---|---|---|
| on sale | white | price | hold a pair |
| holding | orange (red under 1 min) | your countdown + bar | pay / release it |
| sold out | black | 0 | join the line |
| in line | blue | #position | leave the line |
| paid | teal | "yours." | hold another / join the line for another |
| failed or expired | red | "gone." | try again |

Below it, three tiles with no buttons: **pairs left**, **people waiting**, **pairs you've bought (x / 2)**. Then a 20-square board (each pair sold / held / free) and a **feed of what happened to you** (kept for the browser session).

**Extras:**
- The countdown shows in the browser tab title, so you can see it from other tabs.
- Results (pair held, promoted from the line, paid, failed, time ran out) and the 60 / 30 / 10 second warnings are announced to screen readers.
- Add `?demo=1` to show a "make this payment fail" checkbox for demos. It resets on every new hold.

**How it stays live:**
1. A statement-level trigger on `holds`, `waitlist` and `payment_events` runs `pg_notify('sale_changed')` (migration 003).
2. Each API instance keeps one `LISTEN` connection open. It's opened on the first page view, so tests and workers never open it.
3. When a notification arrives, the instance waits ~100 ms to batch changes, then pushes fresh state to each of its open pages over **Server-Sent Events**.
4. Because the notification goes through Postgres, a change made through *any* instance (or the expiry worker, or raw SQL) reaches every page.
5. If the stream drops, the page polls `GET /state` every 2 s until it reconnects. The header pill shows `live` / `polling` / `offline`.

**Countdown:** it ticks in the browser from the server's `expiresAt`. The page corrects for the browser's clock being off using `serverTime` from each update. Holds past their deadline are never shown as active, even in the ~1 s before the worker marks them expired.

Look is borrowed from a previous project of mine: warm paper background, Bricolage Grotesque + Fraunces numbers, coloured tiles. It works on phones too.

---

## Tests

CI (GitHub Actions, `.github/workflows/ci.yml`) runs the typecheck and all tests against a real Postgres on every push. It also builds the Docker image and smoke-tests `docker compose up`.

`npm test` runs 98 integration tests against real Postgres (no mocks for the database):

| File | Covers |
|---|---|
| `schema.test.ts` | DB safety net alone: 500 raw concurrent inserts → 20 holds, unique/limit/check constraints, webhook dedupe |
| `admin.test.ts` | admin reset: absent without token, 401 on bad token, wipes + applies rules, validation |
| `state.test.ts` | `/state` snapshot (incl. overdue holds hidden), page served, SSE pushes on own and foreign writes (NOTIFY trigger) |
| `buy.test.ts` | 5000 users at once through HTTP → exactly 20 holds, same user ×50 → 1 hold, limit of 2, lazy expiry, cancel rules, sold-out fast path |
| `expiry.test.ts` | worker expires only overdue holds, 5 workers at once → each hold expired exactly once, skips locked product, survives errors |
| `waitlist.test.ts` | FIFO promotion (20 held, 3 waiting, 2 expire → first 2 get pairs), cancel/lazy/failed → line first, skipping, 200 joins at once, leave racing promotion |
| `payments.test.ts` | signature, duplicates (×10 at once), reordered, failed, late (revive / refund), double payment, refunds (sent once, idempotent, retried when provider is down), **end-to-end over real HTTP through the chaotic provider** |

## Load test

`npm run load` starts 2 API servers on the same database (each with its own expiry worker and fake provider), then:
1. 5000 different users click Buy at once.
2. 100 losers join the line.
3. Hold owners pay (60%), cancel (15%), or walk away.
4. It keeps going until promoted people are handled and the sale settles.
5. It checks the invariants straight from the database and exits non-zero if any check fails.

Holds are shortened to 10 s so expiry happens during the run.

Knobs: `USERS`, `INSTANCES`, `CONCURRENCY`, `WAITERS`, `PAY_RATE`, `CANCEL_RATE`, `LOAD_HOLD_SECONDS`, or `BASE_URLS=http://…` to test servers you started yourself.

Sample run (Docker Desktop on Windows, laptop):

```
2 instance(s): http://127.0.0.1:3101, http://127.0.0.1:3102
burst: 5000 buyers, concurrency 500, stock 20, hold 10s

endpoint        count   p50 ms   p95 ms   p99 ms   results
buy (burst)     5000    699      2718     3154     {"201":20,"200 soldOut":4980}
burst throughput: 556 req/s over 8.99s

stock 20 | sold 20 | held 0 | available 0
holds created 59 (from line: 39) | fates: {"pay":37,"cancel":5,"abandon":17}
webhook outcomes: ignored_pending=35, paid=20, refund_required_late=11, released=3, ignored_terminal=1

PASS  burst: exactly STOCK holds granted     20 / 20
PASS  burst: no errors (5xx / network)       {"201":20,"200 soldOut":4980}
PASS  never oversold: held + sold <= stock   0 + 20 <= 20
PASS  orders == paid holds                   20 == 20
PASS  no paid hold without order             0
PASS  no order without paid hold             0
PASS  nobody bought more than 2              max 1
PASS  every webhook event processed          0
PASS  sale settled (no active holds)         0 active
ALL CHECKS PASSED
```

With 10,000 users on 3 instances: 663 req/s, all checks pass.

---

## Design decisions & trade-offs

| Decision | Why | Cost |
|---|---|---|
| Postgres row lock, no Redis | One source of truth, real transactions, easy to reason about and explain | All writes for one product take turns through one row lock. Fine for 20 pairs (each write takes ms, and sold-out reads skip the lock). A drop with thousands of units would split stock into buckets |
| Stock calculated from holds | Can't drift; a hold's status *is* the stock | One `COUNT` per decision (cheap: one row per hold ever made) |
| Trigger as safety net | Even buggy code or manual SQL can't oversell | Same rules exist in two places (app gives nice errors, DB guarantees) |
| Lazy expiry + worker | Correct even if the worker dies; worker keeps the line moving promptly | Two code paths call the same function |
| Line joinable only when sold out | Otherwise "join line" vs "buy" is confusing; when pairs are free you just buy | — |
| Failed payment releases the hold immediately | Pair goes to the next person instead of being camped on | User must click Buy again to retry (if pairs/line allow) |
| Late payment: accept if possible, else refund | Never oversells; no money lost silently | Pending refunds are retried only when the next refund-triggering webhook arrives (a real system would add a small retry job) |
| Fake provider runs inside the API process | Simple to run (one command) | Webhooks still travel over real signed HTTP with retries, so the app code is the same as with a separate service. Pending webhooks are lost if the process is killed (a real provider would retry them) |
| No auth (`userId` in requests) | Not part of the exercise | Anyone can act as anyone. Real version: session/JWT, and `userId` taken from it |
| Fastify + raw SQL (`pg`) | Concurrency logic stays visible: every lock and condition is in the SQL | More SQL to write than with an ORM |
