-- Up Migration
ALTER TABLE refunds
  DROP CONSTRAINT refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('requested', 'approved', 'pending', 'succeeded', 'failed', 'reversed', 'rejected', 'expired')),
  ADD COLUMN decided_at TIMESTAMPTZ,
  DROP CONSTRAINT refunds_manual_approval_identity,
  ADD CONSTRAINT refunds_manual_approval_identity
    CHECK (
      trigger <> 'manual_admin'
      OR (
        requested_by IS NOT NULL
        AND (
          status NOT IN ('approved', 'pending', 'succeeded', 'reversed', 'rejected', 'expired')
          OR approved_by IS NOT NULL
        )
        AND (
          status NOT IN ('approved', 'pending', 'succeeded', 'reversed', 'rejected')
          OR approved_by <> requested_by
        )
      )
    );

COMMENT ON COLUMN refunds.approved_by IS
  'Manual-refund decision maker: approver/rejecter; also records the Admin who observed and finalized expiry.';

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide'
    ));

CREATE INDEX refunds_open_manual_order_idx
  ON refunds (order_id)
  WHERE trigger = 'manual_admin' AND status IN ('requested', 'approved', 'pending', 'failed');

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

-- Down Migration
DROP INDEX refunds_open_manual_order_idx;
COMMENT ON COLUMN refunds.approved_by IS NULL;

ALTER TABLE refunds
  DROP CONSTRAINT refunds_status_check,
  ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('requested', 'approved', 'pending', 'succeeded', 'failed', 'reversed')),
  DROP CONSTRAINT refunds_manual_approval_identity,
  ADD CONSTRAINT refunds_manual_approval_identity
    CHECK (
      trigger <> 'manual_admin'
      OR (
        requested_by IS NOT NULL
        AND (
          status NOT IN ('approved', 'pending', 'succeeded', 'reversed')
          OR (approved_by IS NOT NULL AND approved_by <> requested_by)
        )
      )
    ),
  DROP COLUMN decided_at;

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN ('payout.update', 'password.change', 'security.change', 'payout.force_release'));

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
      AND status IN ('requested', 'approved', 'pending', 'succeeded')
      AND id IS DISTINCT FROM NEW.id;

  new_refund_amount := CASE
    WHEN NEW.status IN ('requested', 'approved', 'pending', 'succeeded') THEN NEW.amount
    ELSE 0
  END;

  IF existing_refund_amount + new_refund_amount > payment_amount THEN
    RAISE EXCEPTION 'Refund amount exceeds the payment amount'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
