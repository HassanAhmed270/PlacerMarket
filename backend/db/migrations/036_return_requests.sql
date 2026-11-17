-- Up Migration
ALTER TABLE payout_holds
  ADD COLUMN state_before_pause payout_hold_state;

CREATE TABLE return_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  buyer_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'seller_responded', 'approved', 'rejected')),
  seller_note TEXT CHECK (
    seller_note IS NULL OR char_length(btrim(seller_note)) BETWEEN 3 AND 300
  ),
  decided_by UUID REFERENCES users(id),
  decision_note TEXT CHECK (
    decision_note IS NULL OR char_length(btrim(decision_note)) BETWEEN 3 AND 300
  ),
  seller_at_fault BOOLEAN NOT NULL DEFAULT FALSE,
  refund_id UUID REFERENCES refunds(id),
  responded_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'seller_responded' OR seller_note IS NOT NULL),
  CHECK (status NOT IN ('approved', 'rejected') OR (
    decided_by IS NOT NULL AND decision_note IS NOT NULL AND decided_at IS NOT NULL
  )),
  CHECK (status <> 'approved' OR refund_id IS NOT NULL)
);

CREATE UNIQUE INDEX return_requests_one_open_per_order_idx
  ON return_requests (order_id)
  WHERE status IN ('requested', 'seller_responded');

CREATE INDEX return_requests_buyer_created_idx
  ON return_requests (buyer_id, created_at DESC, id DESC);

ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin', 'delivery_lost', 'return_admin'
    ));

-- Down Migration
ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin', 'delivery_lost'
    ));

DROP INDEX return_requests_buyer_created_idx;
DROP INDEX return_requests_one_open_per_order_idx;
DROP TABLE return_requests;
ALTER TABLE payout_holds DROP COLUMN state_before_pause;
