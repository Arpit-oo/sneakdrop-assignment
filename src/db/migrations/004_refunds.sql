-- Money we owe back: a payment that arrived after its pair was gone, or a
-- second payment for an already-paid hold. One row per payment (payment_id
-- UNIQUE), so duplicate webhooks can never refund twice.
--   pending  -> recorded in the webhook transaction, provider not called yet
--   refunded -> provider confirmed, provider_refund_id set
CREATE TABLE refunds (
  id                 BIGSERIAL   PRIMARY KEY,
  payment_id         TEXT        NOT NULL UNIQUE,
  hold_id            UUID        NOT NULL REFERENCES holds(id),
  amount_cents       INT         NOT NULL CHECK (amount_cents >= 0),
  reason             TEXT        NOT NULL CHECK (reason IN ('late', 'double_charge')),
  status             TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded')),
  provider_refund_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at        TIMESTAMPTZ,
  CHECK ((status = 'refunded') = (provider_refund_id IS NOT NULL AND refunded_at IS NOT NULL))
);
CREATE INDEX refunds_pending ON refunds (id) WHERE status = 'pending';
