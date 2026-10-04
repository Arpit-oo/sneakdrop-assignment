# Sneaker Drop — Execution Plan

## Goal
Sell exactly 20 pairs under thousands of concurrent Buy clicks. Never oversell. Holds expire after 5 min, waitlist auto-promotes, fake payment webhooks are late/duplicated/out-of-order, one plain page shows live state.

## Core invariant
`held + sold <= 20` at all times, enforced by the **database**, not app code.
Every state change = one atomic DB transaction with conditional writes. App servers stay stateless, so N instances are safe.

## Stack (recommended)
| Piece | Choice | Why |
|---|---|---|
| Runtime | Node 20 + TypeScript + Fastify | fast, simple, one language front+back |
| DB | PostgreSQL 16 (docker-compose) | row locks, `FOR UPDATE SKIP LOCKED`, partial unique indexes, real transactions |
| DB access | `pg` + raw SQL (or Kysely) | concurrency logic must be visible, no ORM magic |
| Realtime | Server-Sent Events + polling fallback | plain page, one-way push is enough |
| Tests | Vitest + custom load script (autocannon / Promise.all of 5000 requests) | prove no oversell |

No Redis needed. Postgres alone gives correctness; fewer moving parts = easier to explain in video.

---

## Phase 0 — Setup (~1h)
- Fork repo, clone fork.
- `docker-compose.yml` with Postgres.
- Node/TS project in `src/`: fastify, pg, zod, vitest, tsx.
- `.env.example` (DATABASE_URL, PORT, HOLD_SECONDS=300, STOCK=20, MAX_PER_USER=2, WEBHOOK_SECRET).
- Scripts: `npm run dev`, `npm run migrate`, `npm run seed`, `npm test`, `npm run load`.

**Done when:** `docker compose up -d && npm run dev` serves `/health`.

## Phase 1 — Data model (~1–2h)
```sql
products(id, name, total_stock INT)                      -- 1 row, total_stock = 20

holds(
  id UUID PK, user_id, product_id,
  status TEXT CHECK (status IN ('active','paid','expired','cancelled')),
  expires_at TIMESTAMPTZ, created_at, paid_at
)
-- rule 2a: max 1 active hold per user
CREATE UNIQUE INDEX one_active_hold ON holds(user_id) WHERE status = 'active';

orders(id, user_id, hold_id UNIQUE, payment_id UNIQUE, created_at)
-- rule 2b: max 2 purchases → counted in txn under user lock

waitlist(
  id BIGSERIAL PK,         -- FIFO order
  user_id, product_id,
  status TEXT CHECK (status IN ('waiting','promoted','left')),
  created_at
)
CREATE UNIQUE INDEX one_wait_entry ON waitlist(user_id) WHERE status = 'waiting';

payment_events(            -- webhook inbox, idempotency
  event_id TEXT PK,        -- provider's id; duplicate insert = no-op
  hold_id, type, payload JSONB, received_at, processed_at
)
```
Stock is **derived**: `available = total_stock - count(holds where status in ('active','paid'))`. Computed inside txn after locking product row → single source of truth, no counter drift.

**Done when:** migrations run, seed creates product with 20.

## Phase 2 — Hold / Buy logic (the critical part, ~3h)
`POST /buy {userId}` in one transaction:
1. `SELECT ... FROM products WHERE id=$1 FOR UPDATE` — serializes buyers on this row (20 items, contention fine; lock held ms).
2. Lazily expire stale holds (`status='active' AND expires_at < now()` → `expired`) and run promotion (Phase 4) before deciding.
3. Reject if user has active hold (unique index is backup) → `409 ALREADY_HOLDING`.
4. Reject if user's `paid holds + active` ≥ 2 → `409 LIMIT_REACHED`.
5. Count active+paid; if < 20 → insert hold, `expires_at = now() + 5min` → `201 {holdId, expiresAt}`.
6. Else → `200 {soldOut: true, canJoinWaitlist: true}`.

Also: `DELETE /holds/:id` (user cancels → frees pair → triggers promotion).

Use DB `now()` everywhere, never app clock (multi-instance clock skew).

**Done when:** unit tests pass; load test of 5000 concurrent buys from 5000 users yields exactly 20 active holds.

## Phase 3 — Expiry worker (~1–2h)
- Background loop every 1s (setInterval, or `pg_cron` optional):
  ```sql
  SELECT id FROM holds WHERE status='active' AND expires_at < now()
  FOR UPDATE SKIP LOCKED LIMIT 100
  ```
  mark `expired`, then promote waitlist for each freed pair — same txn.
- `SKIP LOCKED` → multiple workers/instances safe, no double processing.
- Lazy expiry in Phase 2 covers worker downtime; worker gives timely push to waitlist.

**Done when:** test with `HOLD_SECONDS=2` shows hold expires and stock returns.

## Phase 4 — Waiting line (~2h)
- `POST /waitlist {userId}` — only if sold out (available = 0), user not holding, under limit. Returns position.
- `DELETE /waitlist` — leave line.
- **Promotion** (`promoteNext(tx)`), called whenever a pair frees (expiry, cancel, payment failure):
  ```sql
  SELECT * FROM waitlist WHERE status='waiting'
  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
  ```
  - skip & mark `left` if user now at purchase limit or already holding
  - else create hold with fresh 5 min, mark entry `promoted`
  - loop while stock > 0
- Position = `count(waiting entries with id < mine) + 1`.

**Edge cases:** promoted user never pays → expires → next in line. Paid users never re-enter. User in line can't also Buy directly (or can — decide & document; recommend: Buy blocked while sold out anyway).

**Done when:** test: 20 holds, 3 in line, expire 2 → first 2 in line get holds in FIFO order, #3 moves to position 1.

## Phase 5 — Fake payment provider + webhook (~3h)
**Fake provider** (separate module / route prefix `/fakepay`, can run as separate process):
- `POST /fakepay/checkout {holdId, amount}` → returns `paymentId`, schedules webhook.
- Chaos config (env/query flags): random delay 0–10s, 30% duplicate send, 20% send `payment.pending` after `payment.succeeded` (out-of-order), occasional `payment.failed`.
- Signs body with HMAC(WEBHOOK_SECRET) like Stripe.

**App webhook** `POST /webhooks/payment`:
1. Verify HMAC signature → 401 if bad.
2. `INSERT INTO payment_events(event_id,...) ON CONFLICT DO NOTHING` — duplicate → return 200 immediately (idempotent).
3. In txn, lock the hold row `FOR UPDATE`, apply state machine:
   | Hold status | event | Action |
   |---|---|---|
   | active | succeeded | → `paid`, insert order |
   | paid | succeeded (dup, new event_id) | no-op (order.hold_id UNIQUE) |
   | paid | pending/failed (late, out of order) | ignore — terminal state wins |
   | active | failed | → `cancelled`, promote waitlist |
   | expired | succeeded (**late**) | if stock free & user under limit → revive to `paid`; else record `refund_required` and flag |
4. Always return 200 after recording so provider stops retrying.

Monotonic rule: `paid` is terminal; state only moves forward. Out-of-order events can't regress it.

**Late-payment decision (document in NOTES.md):** best-effort accept if stock available, else auto-refund via fake provider. Honest tradeoff; oversell never allowed.

**Done when:** tests replaying duplicate, reordered, and late events all end in consistent state, no oversell.

## Phase 6 — Status page (~2h)
- `GET /` → plain HTML, user id from `?user=alice` (or cookie; no real auth needed — say so in notes).
- Shows: **pairs left**, **your hold countdown** (client-side ticking from server `expiresAt`, re-synced on push), **your place in line**, purchased count, buttons: Buy / Pay (calls fakepay) / Cancel / Join line / Leave line.
- `GET /events?user=` SSE stream: pushes on stock change, promotion, payment result. Use Postgres `LISTEN/NOTIFY` so all instances broadcast.
- Fallback poll `GET /state?user=` every 2s.

**Done when:** open 3 tabs as 3 users, watch counts move live.

## Phase 7 — Proof: tests + load test (~2–3h)
- Unit/integration (Vitest against real Postgres, test DB):
  - concurrent buy 5000 → 20 holds exactly
  - same user 50 parallel buys → 1 hold
  - 3rd purchase blocked
  - expiry returns stock; promotion FIFO
  - webhook dup / out-of-order / late / bad signature
- `npm run load` script: spawn N users hitting `/buy`, then pay randomly, let rest expire; final assertion: `sold <= 20`, `orders count == paid holds`, every user ≤ 2.
- Optional: run 2 app instances behind same DB to show horizontal safety.

**Done when:** all green; load script prints summary table used in video.

## Phase 8 — Docs + recording (~1–2h)
- `NOTES.md`: requirements (Docker, Node 20), run steps, env vars, architecture diagram (ASCII), design decisions & tradeoffs (why DB locks, lazy+worker expiry, late-payment policy, no auth), how to run tests/load test/chaos flags.
- Loom (~5–8 min): problem (51 sold vs 20) → invariant → live demo 3 tabs → load test output → webhook chaos demo → tradeoffs.
- Push to fork.

---

## Folder layout
```
src/
  server.ts          fastify bootstrap
  db/ migrations/, pool.ts
  domain/ holds.ts, waitlist.ts, payments.ts   (pure txn logic)
  routes/ buy.ts, waitlist.ts, webhooks.ts, state.ts, sse.ts
  workers/ expiry.ts
  fakepay/ provider.ts   (chaos webhook sender)
  web/ index.html
tests/
scripts/ load.ts
docker-compose.yml
NOTES.md
```

## Key risks & mitigations
| Risk | Mitigation |
|---|---|
| Oversell under race | product row `FOR UPDATE` + derived stock in txn |
| Double hold per user | partial unique index + in-txn check |
| Duplicate webhook | `payment_events` PK on event_id; order.hold_id UNIQUE |
| Out-of-order webhook | forward-only state machine, terminal `paid` |
| Late webhook after expiry | revive-if-possible else refund; logged |
| Worker crash | lazy expiry on each request |
| Multiple app instances | all state in DB, `SKIP LOCKED`, LISTEN/NOTIFY |
| Clock skew | DB `now()` only |

## Estimate
~16–20h total. Phases 2, 4, 5 = core grading surface; spend most care there.
