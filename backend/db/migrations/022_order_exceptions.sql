-- Up Migration
CREATE TABLE order_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('late_handover_after_auto_cancel')),
  courier_pickup_at TIMESTAMPTZ,
  note TEXT NOT NULL,
  recorded_by UUID NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT
);

CREATE UNIQUE INDEX order_exceptions_one_unresolved_kind_idx
  ON order_exceptions (order_id, kind)
  WHERE resolved_at IS NULL;

-- Down Migration
DROP TABLE order_exceptions;
