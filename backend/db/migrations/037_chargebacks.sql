-- Up Migration
CREATE TABLE chargebacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  reference TEXT NOT NULL CHECK (char_length(btrim(reference)) BETWEEN 3 AND 100),
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 3 AND 300),
  recorded_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  resolved_by UUID REFERENCES users(id),
  resolution_note TEXT CHECK (
    resolution_note IS NULL OR char_length(btrim(resolution_note)) BETWEEN 3 AND 300
  ),
  refund_id UUID NOT NULL UNIQUE REFERENCES refunds(id),
  payout_after_payment BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT chargebacks_order_reference_unique UNIQUE (order_id, reference),
  CHECK (status = 'open' OR (
    resolved_by IS NOT NULL AND resolution_note IS NOT NULL AND resolved_at IS NOT NULL
  ))
);

CREATE INDEX chargebacks_order_created_idx
  ON chargebacks (order_id, created_at DESC, id DESC);
CREATE INDEX chargebacks_status_created_idx
  ON chargebacks (status, created_at DESC, id DESC);

ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin', 'delivery_lost', 'return_admin', 'chargeback'
    )),
  DROP CONSTRAINT refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN (
      'requested', 'approved', 'pending', 'succeeded', 'failed', 'reversed',
      'rejected', 'expired', 'voided'
    ));

CREATE OR REPLACE FUNCTION enforce_refund_payment_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payment_order_id UUID;
  payment_amount NUMERIC(12,2);
  payment_currency TEXT;
  existing_refund_amount NUMERIC;
  new_refund_amount NUMERIC;
BEGIN
  SELECT order_id, amount, currency
    INTO payment_order_id, payment_amount, payment_currency
    FROM payments
    WHERE id = NEW.payment_id
    FOR UPDATE;

  IF NOT FOUND OR NEW.order_id IS DISTINCT FROM payment_order_id THEN
    RAISE EXCEPTION 'Refund order must match its payment order'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM payment_currency THEN
    RAISE EXCEPTION 'Refund currency must match its payment currency'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.amount > payment_amount THEN
    RAISE EXCEPTION 'Refund amount exceeds the payment amount'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO existing_refund_amount
    FROM refunds
    WHERE payment_id = NEW.payment_id
      AND (
        status IN ('requested', 'approved', 'pending', 'failed', 'succeeded')
        OR (trigger = 'chargeback' AND status <> 'voided')
      )
      AND id IS DISTINCT FROM NEW.id;

  new_refund_amount := CASE
    WHEN NEW.status = 'voided' THEN 0
    WHEN NEW.status IN ('requested', 'approved', 'pending', 'failed', 'succeeded')
         OR NEW.trigger = 'chargeback' THEN NEW.amount
    ELSE 0
  END;

  IF existing_refund_amount + new_refund_amount > payment_amount THEN
    RAISE EXCEPTION 'Refund amount exceeds the payment amount'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Down Migration
DROP INDEX chargebacks_status_created_idx;
DROP INDEX chargebacks_order_created_idx;
DROP TABLE chargebacks;

ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin', 'delivery_lost', 'return_admin'
    )),
  DROP CONSTRAINT refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN (
      'requested', 'approved', 'pending', 'succeeded', 'failed', 'reversed',
      'rejected', 'expired'
    ));

CREATE OR REPLACE FUNCTION enforce_refund_payment_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payment_order_id UUID;
  payment_amount NUMERIC(12,2);
  existing_refund_amount NUMERIC;
  new_refund_amount NUMERIC;
BEGIN
  SELECT order_id, amount
    INTO payment_order_id, payment_amount
    FROM payments
    WHERE id = NEW.payment_id
    FOR UPDATE;

  IF NOT FOUND OR NEW.order_id IS DISTINCT FROM payment_order_id THEN
    RAISE EXCEPTION 'Refund order must match its payment order'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO existing_refund_amount
    FROM refunds
    WHERE payment_id = NEW.payment_id
      AND status IN ('requested', 'approved', 'pending', 'failed', 'succeeded')
      AND id IS DISTINCT FROM NEW.id;

  new_refund_amount := CASE
    WHEN NEW.status IN ('requested', 'approved', 'pending', 'failed', 'succeeded') THEN NEW.amount
    ELSE 0
  END;

  IF existing_refund_amount + new_refund_amount > payment_amount THEN
    RAISE EXCEPTION 'Refund amount exceeds the payment amount'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
