-- Sneaker drop core schema.
-- Invariant: for each product, (active holds + paid holds) <= total_stock.
-- Available stock is DERIVED from holds, never stored as a counter, so it cannot drift.

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  name          TEXT        NOT NULL,
  total_stock   INT         NOT NULL CHECK (total_stock >= 0),
  max_per_user  INT         NOT NULL CHECK (max_per_user > 0),
  hold_seconds  INT         NOT NULL CHECK (hold_seconds > 0),
  price_cents   INT         NOT NULL CHECK (price_cents >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A hold reserves exactly one pair for one user.
--   active    -> reserved, waiting for payment, until expires_at
--   paid      -> terminal, pair sold
--   expired   -> terminal, pair returned to stock
--   cancelled -> terminal, user released it or payment failed
CREATE TABLE holds (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   TEXT        NOT NULL REFERENCES products(id),
  user_id      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paid', 'expired', 'cancelled')),
  source       TEXT        NOT NULL DEFAULT 'direct'
                           CHECK (source IN ('direct', 'waitlist')),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ,
  released_at  TIMESTAMPTZ,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status IN ('expired', 'cancelled')) = (released_at IS NOT NULL))
);

-- Rule 2a: a user holds at most one pair at a time (per product).
CREATE UNIQUE INDEX holds_one_active_per_user
  ON holds (product_id, user_id) WHERE status = 'active';

-- Expiry worker scans this.
CREATE INDEX holds_active_expiry ON holds (expires_at) WHERE status = 'active';
CREATE INDEX holds_user ON holds (user_id);

-- One order per paid hold. payment_id unique => a payment can never create two orders.
CREATE TABLE orders (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_id      UUID        NOT NULL UNIQUE REFERENCES holds(id),
  product_id   TEXT        NOT NULL REFERENCES products(id),
  user_id      TEXT        NOT NULL,
  payment_id   TEXT        NOT NULL UNIQUE,
  amount_cents INT         NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Waiting line. BIGSERIAL id gives strict FIFO order.
--   waiting  -> in line
--   promoted -> got a hold (promoted_hold_id)
--   left     -> user left, or was skipped (e.g. hit purchase limit)
CREATE TABLE waitlist (
  id               BIGSERIAL   PRIMARY KEY,
  product_id       TEXT        NOT NULL REFERENCES products(id),
  user_id          TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'waiting'
                               CHECK (status IN ('waiting', 'promoted', 'left')),
  promoted_hold_id UUID        REFERENCES holds(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'promoted') = (promoted_hold_id IS NOT NULL))
);

-- One place in line per user per product.
CREATE UNIQUE INDEX waitlist_one_waiting_per_user
  ON waitlist (product_id, user_id) WHERE status = 'waiting';
CREATE INDEX waitlist_fifo ON waitlist (product_id, id) WHERE status = 'waiting';

-- Webhook inbox. event_id primary key makes duplicate deliveries a no-op.
CREATE TABLE payment_events (
  event_id     TEXT        PRIMARY KEY,
  payment_id   TEXT        NOT NULL,
  hold_id      UUID,
  type         TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  occurred_at  TIMESTAMPTZ,            -- provider's timestamp (for ordering)
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  outcome      TEXT                    -- what we did: applied / ignored_* / refund_required ...
);
CREATE INDEX payment_events_payment ON payment_events (payment_id);

-- Convenience view for reads (status page). Writes compute this inside a locked txn.
CREATE VIEW product_stock AS
SELECT p.id AS product_id,
       p.total_stock,
       COUNT(h.id) FILTER (WHERE h.status = 'active') AS held,
       COUNT(h.id) FILTER (WHERE h.status = 'paid')   AS sold,
       p.total_stock - COUNT(h.id) FILTER (WHERE h.status IN ('active', 'paid')) AS available
FROM products p
LEFT JOIN holds h ON h.product_id = p.id
GROUP BY p.id;

-- ---------------------------------------------------------------------------
-- Defense in depth: the database itself refuses to oversell or exceed the
-- per-user limit, even if application code has a bug.
-- The trigger locks the product row, so concurrent writers serialize here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION enforce_hold_limits() RETURNS trigger AS $$
DECLARE
  p          products%ROWTYPE;
  consumed   INT;
  user_count INT;
BEGIN
  -- Only a transition INTO a stock-consuming state needs checking.
  -- active -> paid keeps the same pair, so it is free.
  IF NEW.status NOT IN ('active', 'paid') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'paid') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO p FROM products WHERE id = NEW.product_id FOR UPDATE;

  SELECT COUNT(*) INTO consumed
  FROM holds
  WHERE product_id = NEW.product_id AND status IN ('active', 'paid') AND id <> NEW.id;

  IF consumed >= p.total_stock THEN
    RAISE EXCEPTION 'sold out: % of % pairs taken', consumed, p.total_stock
      USING ERRCODE = 'P0001', HINT = 'SOLD_OUT';
  END IF;

  SELECT COUNT(*) INTO user_count
  FROM holds
  WHERE product_id = NEW.product_id AND user_id = NEW.user_id
    AND status IN ('active', 'paid') AND id <> NEW.id;

  IF user_count >= p.max_per_user THEN
    RAISE EXCEPTION 'user % reached limit of %', NEW.user_id, p.max_per_user
      USING ERRCODE = 'P0001', HINT = 'LIMIT_REACHED';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER holds_enforce_limits
  BEFORE INSERT OR UPDATE OF status ON holds
  FOR EACH ROW EXECUTE FUNCTION enforce_hold_limits();
