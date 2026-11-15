-- Up Migration
CREATE TABLE seller_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('initiated', 'paid', 'failed')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  initiated_by UUID NOT NULL REFERENCES users(id),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method payout_method_type,
  transfer_reference TEXT,
  paid_on DATE,
  paid_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  failure_reason TEXT,
  failed_by UUID REFERENCES users(id),
  failed_at TIMESTAMPTZ,
  CONSTRAINT seller_payouts_order_attempt_unique UNIQUE (order_id, attempt),
  CONSTRAINT seller_payouts_paid_fields_check CHECK (
    status <> 'paid' OR (
      method IS NOT NULL AND
      transfer_reference IS NOT NULL AND
      paid_on IS NOT NULL AND
      paid_by IS NOT NULL AND
      paid_at IS NOT NULL
    )
  ),
  CONSTRAINT seller_payouts_failed_fields_check CHECK (
    status <> 'failed' OR (
      failure_reason IS NOT NULL AND
      failed_by IS NOT NULL AND
      failed_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX seller_payouts_order_active_unique_idx
  ON seller_payouts (order_id)
  WHERE status IN ('initiated', 'paid');

CREATE INDEX seller_payouts_status_initiated_at_idx
  ON seller_payouts (status, initiated_at);

ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide', 'payout.record'
    ));

-- Down Migration
ALTER TABLE step_up_grants
  DROP CONSTRAINT step_up_grants_action_check,
  ADD CONSTRAINT step_up_grants_action_check
    CHECK (action IN (
      'payout.update', 'password.change', 'security.change', 'payout.force_release',
      'refund.request', 'refund.decide'
    ));

DROP TABLE IF EXISTS seller_payouts;
