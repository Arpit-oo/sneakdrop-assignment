# Progress Log

Plan: [PLAN.md](PLAN.md). UI (Phase 6) deferred — backend first.

## Status
| Phase | State |
|---|---|
| 0 Setup | ✅ done |
| 1 Data model | ✅ done |
| 2 Buy/hold API | ✅ done |
| 3 Expiry worker | ✅ done |
| 4 Waiting line | ✅ done |
| 5 Fake pay + webhook | ✅ done |
| 6 UI page | ✅ done |
| 7 Load test/proof | ✅ done |
| 8 Docs + video | 🟡 docs done, video pending |

---

## 2026-09-30 — Phase 0: Setup
- Node 22 + TS (ESM), Fastify 5, pg, zod, dotenv, vitest, tsx.
- `docker-compose.yml`: Postgres 16 on host port **5433**. Init script creates `sneakdrop_test` DB.
- `.env.example` → `.env`: DATABASE_URL, TEST_DATABASE_URL, PORT, STOCK, HOLD_SECONDS, MAX_PER_USER, WEBHOOK_SECRET.
- `src/config.ts` — zod-validated env.
- `src/db/pool.ts` — pg pool + `withTx()` helper (BEGIN/COMMIT/ROLLBACK).
- `src/server.ts` — Fastify, `GET /health` → `{ok:true}` ✅ verified.
- Scripts: `dev`, `start`, `migrate`, `seed`, `db:reset`, `test`, `typecheck`.

## 2026-09-30 — Phase 1: Data model
File: `src/db/migrations/001_init.sql`
- `products` — total_stock, max_per_user, hold_seconds, price_cents (rules live in DB, seeded from env).
- `holds` — status `active|paid|expired|cancelled`, source `direct|waitlist`, expires_at. CHECKs tie status ↔ paid_at/released_at.
  - partial unique `(product_id,user_id) WHERE active` → 1 hold/user.
- `orders` — `hold_id UNIQUE`, `payment_id UNIQUE` → no double order.
- `waitlist` — BIGSERIAL id = FIFO; partial unique 1 waiting entry/user.
- `payment_events` — `event_id PK` → webhook dedupe; `outcome` column for audit.
- `product_stock` view — held/sold/available derived from holds (no counter to drift).
- **Trigger `enforce_hold_limits`** (safety net): locks product row, rejects `SOLD_OUT` / `LIMIT_REACHED` on any insert/transition into active|paid. DB refuses oversell even if app buggy.
- `src/db/migrate.ts` — runner, `schema_migrations` table, advisory lock, per-file txn.
- `src/db/seed.ts` — upsert product `sneaker-001`. `src/db/reset.ts` — truncate sale data.

Tests `tests/schema.test.ts` — **12/12 pass**:
- 500 concurrent inserts → exactly 20 holds, 480 SOLD_OUT
- same user 50 racing inserts → 1 hold
- max 2 per user, active→paid no extra stock, expired frees stock & can't revive when gone
- CHECK consistency, waitlist FIFO/unique, webhook dedupe, one order per hold/payment
- `tsc --noEmit` clean.

### Decisions
- Stock derived, not counted → single source of truth.
- Enforcement in DB (trigger + unique idx), app logic on top gives nice errors.
- User id = plain text (no auth), documented later in NOTES.md.

## 2026-10-03 — Phase 2: Buy/hold API
- `src/app.ts` — `buildServer()` split from `src/server.ts` (listen only) → tests use `app.inject`. Central error handler: DomainError → its status, ZodError → 400, else 500.
- `src/domain/errors.ts` — `DomainError(code,status)`; `fromDbError` maps trigger hints SOLD_OUT/LIMIT_REACHED + unique idx → clean 409.
- `src/domain/holds.ts`
  - `buy()` one txn: lock product `FOR UPDATE` → `expireStaleHolds` (lazy) → ALREADY_HOLDING / LIMIT_REACHED → derived stock → insert hold, `expires_at = now() + hold_seconds` (DB clock).
  - `cancelHold()` owner-only (404 for others → no probing), lock product (same lock order), → `cancelled`; 409 HOLD_EXPIRED / HOLD_NOT_ACTIVE.
  - `lockProduct`, `expireStaleHolds`, `availableStock` exported for Phase 3/4. Promotion hook points marked `Phase 4`.
- `src/routes/buy.ts` — `POST /buy {userId, productId?}` → 201 `{holdId,status,expiresAt}` | 200 `{soldOut,canJoinWaitlist}` | 409. `DELETE /holds/:id {userId}`.

Tests `tests/buy.test.ts` — **18 new, 30/30 total pass**, typecheck clean:
- 5000 users concurrent via HTTP → exactly 20 holds, 4980 soldOut, 0 errors
- same user 50 parallel → 1 hold
- limit 2 (paid counts; cancelled/expired don't), lazy expiry frees stock, expired user re-buys
- cancel: stock returns, others' hold 404, twice 409, after deadline 409, paid 409
- live server smoke: buy → 201, repeat → 409 ALREADY_HOLDING.

### Decisions
- Sold out = 200 (not error) — normal outcome, UI offers waitlist.
- ALREADY_HOLDING returns existing holdId/expiresAt → idempotent-ish retry for double clicks.

## 2026-10-03 — Phase 3: Expiry worker
- `src/workers/expiry.ts`
  - `expireDue()` one sweep: find products w/ overdue holds → per product txn: `SELECT products ... FOR UPDATE SKIP LOCKED` → reuse `expireStaleHolds`.
  - **Deviation from plan:** locks product row (not hold rows w/ SKIP LOCKED). Reason: same lock order as buy/cancel (product → holds) → no deadlock once Phase 4 promotion needs product lock in same txn. Locked product skipped → that txn lazy-expires itself; next sweep retries.
  - `startExpiryWorker({intervalMs})` — setTimeout chain, sweeps never overlap, errors logged + loop survives, `stop()` awaits in-flight sweep.
  - Standalone: `npm run worker`.
- `src/server.ts` starts worker in-process (`EXPIRY_INTERVAL_MS`, default 1000, 0 = off) + graceful shutdown (SIGINT/SIGTERM).
- `config.ts` / `.env(.example)`: `EXPIRY_INTERVAL_MS`.

Tests `tests/expiry.test.ts` — **8 new, 38/38 total pass**, typecheck clean:
- only overdue active holds expire; paid never touched
- 5 concurrent sweeps → each hold expired exactly once
- product locked by buyer → sweep skips w/o blocking, next sweep catches
- loop w/ 1s holds → expires w/o any request, stock back
- loop survives failing sweep; stop() halts scheduling
- live: seed HOLD_SECONDS=2, buy → log `holds expired: 1`, stock 20/20.

## 2026-10-03 — Phase 4: Waiting line
- Refactor: `src/domain/product.ts` (lockProduct, tryLockProduct, availableStock, userUsage) + `src/domain/release.ts` (expireStaleHolds, promoteWaiting) — breaks holds↔waitlist import cycle.
- `release.ts`
  - `expireStaleHolds(tx, product)` → `{expired, promoted}`; promotes when anything expired.
  - `promoteWaiting(tx, product)` — while free > 0: oldest `waiting` entry → skip+`left` if holding (`skipped_holding`) or at limit (`skipped_limit`), else insert hold `source='waitlist'` fresh hold_seconds, entry → `promoted`.
  - Runs in SAME txn as the freeing (expiry / cancel / lazy expiry in buy/join) under product lock → direct buyer never sees freed stock while line non-empty. No line-jumping.
- Lock order everywhere: product → holds → waitlist. Leave also takes product lock (avoids READ COMMITTED FOR UPDATE recheck skipping row / race w/ promotion).
- `src/domain/waitlist.ts` — `joinWaitlist` (only when sold out → else 409 NOT_SOLD_OUT; holding/limit 409; rejoin idempotent → same position), `leaveWaitlist` (404 NOT_IN_LINE), `positionOf` = count waiting w/ id ≤ mine.
- `buy()` sold-out reply now: `canJoinWaitlist:false, position` if already in line.
- `cancelHold()` promotes after cancel. Worker uses `tryLockProduct` + release module.
- Migration `002_waitlist_reason.sql` — `waitlist.left_reason` (user_left|skipped_limit|skipped_holding) + CHECK left ⇔ reason.
- Routes `src/routes/waitlist.ts`: `POST /waitlist` (201 new / 200 already), `DELETE /waitlist`, `GET /waitlist/position?userId=`.

Tests `tests/waitlist.test.ts` — **17 new, 55/55 total pass**, typecheck clean:
- plan done-when: 20 held, 3 in line, 2 expire → a,b promoted FIFO, c → position 1
- fresh 5 min on promotion; cancel → instant promotion, direct buyer soldOut; lazy path same
- promoted never pays → next; empty line → open sale
- skip invalid entries (limit / holding); 20 freed at once → strict order
- 200 concurrent joins → positions 1..200; leave+promotion race ×10 → consistent
- live: stock=1, alice holds, bob joins, alice cancels → bob holds (source waitlist).

### Decisions
- Line only joinable when sold out. User in line can't double-join; Buy shows place.
- Skipped users removed (not kept for later) — recorded w/ reason, UI can explain.

## 2026-10-03 — Phase 5: Fake payment provider + webhook
- `src/payments/signature.ts` — Stripe-style `x-fakepay-signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`, timing-safe compare, 300s replay tolerance.
- `src/payments/events.ts` — zod event schema `{id, type: pending|succeeded|failed, paymentId, holdId, amountCents, occurredAt}`.
- `src/fakepay/provider.ts` — `FakePay`
  - `planDeliveries()` pure: pending + final; random delay; reorder → stale pending AFTER final; duplicate → same event id resent; failRate.
  - real HTTP delivery, retry w/ backoff on 5xx/network (stop on 4xx), `idle()` for tests/shutdown.
  - In-process (knows nothing about holds; holdId = echoed metadata). Webhooks still go over real signed HTTP.
- `src/domain/payments.ts` — `handlePaymentEvent` ONE txn: inbox insert `ON CONFLICT DO NOTHING` (dup → stop) → lock product → lazy expire (+promote) → lock hold → forward-only state machine → store outcome. Crash mid-way rolls back inbox row → retry processes for real.
  | hold | event | outcome |
  |---|---|---|
  | any | pending | ignored_pending |
  | active | succeeded | paid + order |
  | paid | succeeded same payment | ignored_already_paid |
  | paid | succeeded other payment | refund_required_double_charge |
  | expired/cancelled | succeeded, pair free + under limit | late_paid (revived) |
  | expired/cancelled | succeeded, pair gone / at limit | refund_required_late |
  | active | failed | released → cancelled + promote line |
  | not active | failed | ignored_terminal |
  | — | wrong amount / unknown hold | ignored_amount_mismatch / ignored_unknown_hold |
  - `prepareCheckout` — friendly pre-check (owner, active, not past deadline).
- `src/routes/payments.ts` — `POST /holds/:id/pay {userId, outcome?}` → 202 `{paymentId}`; `POST /fakepay/checkout` (manual chaos demo); `POST /webhooks/payment` (raw-body parser scoped to plugin, 401 bad sig, 400 bad payload, always 200 once recorded).
- `app.ts` — `buildServer({fakepay?})`, `defaultFakePay()` from config, onClose waits for in-flight webhooks.
- Config/env: `WEBHOOK_URL`, `FAKEPAY_MAX_DELAY_MS`, `FAKEPAY_DUPLICATE_RATE`, `FAKEPAY_REORDER_RATE`, `FAKEPAY_FAIL_RATE`.

Tests `tests/payments.test.ts` — **26 new, 81/81 total pass (2 runs)**, typecheck clean:
- signature valid/tampered/wrong secret/malformed/replay; 401 stores nothing; 400 bad payload
- same event 10× concurrent → 1 order; new event id same payment → no 2nd order; 2nd payment → refund flag
- pending after success, failed after success → stays paid
- failed → pair to waitlist; late success revive / refund (line got it, someone bought it, user at limit)
- pay route 202 / 404 / 409; chaos plan shape
- **E2E real HTTP**: 20 holds, 5 waiting, everyone double-clicks Pay, provider 50% dup / 50% reorder / 30% fail → orders == paid holds, no dup orders, ≤2/user, held+sold ≤ 20, every event processed.
- live: dup=1 reorder=1 → paid, duplicate_event, ignored_pending; 1 order.

### Decisions
- Failed payment releases hold immediately (pair → line), not "retry until expiry". Simpler, stops camping. Retry = buy again.
- Late payment: accept if pair still free & under limit, else `refund_required_*` recorded on event (no real refund call — documented).
- Double click Pay = 2 payments → 2nd flagged refund_required_double_charge, never 2 orders.

## 2026-10-03 — Phase 7: Load test / proof
- `scripts/load.ts` (`npm run load`) — resets sale in DATABASE_URL, sets hold to `LOAD_HOLD_SECONDS` (10), spawns `INSTANCES` (2) API servers on same DB (`node --import tsx`, ports 3101+, each own expiry worker + fake provider), then:
  burst `USERS` (5000) buyers @ `CONCURRENCY` (500) round-robin → `WAITERS` (100) losers join line → each hold: pay `PAY_RATE` .6 / cancel .15 / abandon → keeps acting on promoted holds until no active holds + webhooks quiet → invariants from DB → summary table, exit 1 on fail.
  `BASE_URLS=...` to hit own servers instead. Env knobs documented in file header.
- Invariants checked: burst grants exactly STOCK (when burst < hold time), no 5xx/network errors, held+sold ≤ stock, orders == paid holds, no paid w/o order / order w/o paid, ≤ max per user, every webhook processed, sale settled.
- `LOG_LEVEL` config (spawned instances run at `error`).

### Perf fix found by load test
- First run: burst **96 req/s**, p50 5s — every Buy took product lock even when sold out → fully serialized. Burst (52s) outlasted 4s holds → 260 holds granted over time (not oversell, but bad).
- Fix: `soldOutFastPath()` in `holds.ts` — one lock-free read: sold out AND no overdue holds AND user has no pairs → answer soldOut (+ position) without txn. Anything else → locked path. Safe: read-only, reply reflects snapshot ms old.
- After: **556 req/s**, p50 699ms (5000 users / 2 inst); **663 req/s** (10000 / 3 inst). Docker-on-Windows DB.
- New test: after sell-out, holder still gets ALREADY_HOLDING, limit user LIMIT_REACHED (not soldOut). **82/82 pass.**

### Results (for video)
| run | burst | holds in burst | sold | orders==paid | max/user | late refunds | verdict |
|---|---|---|---|---|---|---|---|
| 5000 users, 2 inst | 556 req/s, p99 3.2s | 20 / 20 | 20 | 20==20 | 1 | 11 | ALL PASS |
| 10000 users, 3 inst | 663 req/s, p99 2.9s | 40 (burst 15s > 10s hold → re-sold) | 20 | 20==20 | 1 | 0 | ALL PASS |

Note: script acts on initial holds only after burst + line join → slow bursts make some initial holds expire before Pay → `409 HOLD_EXPIRED` / `refund_required_late` in summary. Realistic, exercises late path.

## 2026-10-03 — Phase 8: Docs
- `notes.md` → `NOTES.md` (README asks for NOTES.md; `git mv -f` staged — Windows is case-insensitive). Not committed.
- NOTES.md: requirements, run steps, all commands, env var table, API table + curl, architecture ASCII + layout, rule-by-rule enforcement, webhook state machine table, tests table, load test sample output, trade-offs table. "Rule 5: status page" = placeholder until Phase 6.

### Video outline (~6–8 min)
1. Problem (30s): 51 sold vs 20. Invariant: held + sold ≤ 20, enforced by DB.
2. Design (1.5m): product row lock + derived stock + trigger safety net; lock order; lazy+worker expiry; promotion in same txn → no line-jumping.
3. Live demo (2m): 3 tabs (needs Phase 6 UI) — buy, countdown, sell out, join line, cancel → promotion, pay.
4. Chaos payments (1.5m): `FAKEPAY_DUPLICATE_RATE=1 FAKEPAY_REORDER_RATE=1` → log shows paid / duplicate_event / ignored_pending; state machine table; late payment revive vs refund.
5. Proof (1m): `npm test` 90 green; `npm run load` table — 5000 users, 2 instances, ALL CHECKS PASSED; mention 96 → 556 req/s fast-path fix.
6. Trade-offs (30s): single-row lock ceiling, no auth, refunds recorded only, in-process provider.

## 2026-10-03 — Phase 6: Status page
- Theme from `C:\code\et` (pavan web app): paper #f5f0e6 + grain, Bricolage Grotesque / Fraunces display numbers, 28px bento tiles (orange / white / blue / teal / charcoal), tilted stickers, pill buttons, uppercase eyebrows.
- `src/web/index.html` — single file, inline CSS+JS, Google Fonts. Tiles: pairs left (→ charcoal + red sticker when sold out), hold countdown + bar (red < 60s) + Pay / Release / "fail it", line position + join/leave, bought x/2, Buy strip (first on mobile), 20-slot board, personal activity feed derived from state diffs. `?user=` + header input; footer link opens another user.
- `src/domain/state.ts` — `getState()` one query: counts, my hold (only if not past deadline), bought, position, last non-pending payment event.
- Migration `003_notify.sql` — statement-level triggers on holds / waitlist / payment_events → `pg_notify('sale_changed')`.
- `src/live/hub.ts` — `SaleHub`: lazy single LISTEN conn per instance, 100ms debounce, reconnect on error.
- `src/routes/state.ts` — `GET /` page, `GET /state`, `GET /events` SSE (initial push + on notify, per-stream coalescing, 15s heartbeat, streams ended in preClose).
- Client: EventSource; on error → poll /state every 2s; header pill live/polling/offline; clock offset from serverTime.

Tests `tests/state.test.ts` — **8 new, 90/90 pass**: state shapes, overdue hold hidden, 400, page served, SSE initial + push on another user's buy + push on raw-SQL write.
Browser check (Playwright): alice buy → countdown; stock=2, carol joins line, alice releases → carol page flips to "from line" live; carol pays → "payment confirmed", 1/2; 390px layout OK. Fixed during check: `[hidden]` overridden by button display, invisible sold-out sticker, stale message, favicon 404.

## 2026-10-04 — Impeccable critique + polish (status page)
- Critique (2 agents: design review + detector/browser): **25/40**. P0: phone hid timer + Pay while holding. P1: results wiped / not announced; orange Buy dominant when sold out; demo "fail it" checkbox in payment path, never reset. P2: urgency, orange-on-light contrast 2.5:1, invisible focus ring on blue, 10px text, `width` animation. Snapshot `.impeccable/critique/`.
- Chosen: one action panel, all issues, demo toggle behind `?demo=1`.
- Polish `src/web/index.html`:
  - Action panel replaces hold tile + buy strip. Modes open / hold / urgent / soldout / line / paid / done / lost. Fixed min-height (no layout jump). Figure settles in on change (single motion moment).
  - Tiles evidence-only (no buttons), line tile = people waiting.
  - Results kept in panel until "ok"; also restored on reload if last payment < 2 min old.
  - aria-live assertive announcements (held, promoted, paid, failed, expired, moved up, 60/30/10s).
  - Tab title countdown / "#n in line".
  - Contrast: `--orange-ink #c2410c` for text, `--red #dc2626` under white. Focus ring 3px, per-panel colour. Text ≥11px. Bar = `transform: scaleX`. `<main>`, 44px input + footer link. `::selection` / caret themed. Feed in sessionStorage. Copy: "hold a pair", no dev jargon. Hover lift removed from non-interactive tiles.
- Verified in browser 1440 + 390: open, hold, sold out, line, promoted, paying, paid, urgent, failed; 0 console errors, no overflow; phone page 2078 → 1454px. Detector after: remaining = pinned style (Fraunces, cream), cursor transition, "live" pill padding (false positive). 90/90 tests.
