-- Up Migration
ALTER TYPE order_status ADD VALUE 'reserved';
ALTER TYPE order_status ADD VALUE 'payment_pending';
ALTER TYPE order_status ADD VALUE 'funded';

CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id),
  buyer_id UUID NOT NULL REFERENCES users(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'paid', 'expired', 'cancelled', 'released')),
  item_price_snapshot NUMERIC(12,2) NOT NULL CHECK (item_price_snapshot > 0),
  delivery_fee_snapshot NUMERIC(12,2) NOT NULL CHECK (delivery_fee_snapshot >= 0),
  total_amount_snapshot NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  city_id UUID NOT NULL REFERENCES cities(id),
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  postal_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  CONSTRAINT reservations_paid_requires_timestamp
    CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT reservations_total_matches_snapshot
    CHECK (total_amount_snapshot = item_price_snapshot + delivery_fee_snapshot)
);

CREATE UNIQUE INDEX reservations_one_live_or_sold_per_listing
  ON reservations (listing_id)
  WHERE status IN ('active', 'paid');

CREATE INDEX reservations_active_buyer_expiry
  ON reservations (buyer_id, expires_at)
  WHERE status = 'active';

CREATE INDEX reservations_active_expiry
  ON reservations (expires_at)
  WHERE status = 'active';

CREATE TABLE supported_delivery_cities (
  city_id UUID PRIMARY KEY REFERENCES cities(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE orders
  ALTER COLUMN accepted_offer_id DROP NOT NULL,
  ADD COLUMN reservation_id UUID UNIQUE REFERENCES reservations(id),
  ADD COLUMN funded_at TIMESTAMPTZ,
  ADD COLUMN handover_deadline_at TIMESTAMPTZ,
  ADD COLUMN handed_over_at TIMESTAMPTZ,
  ADD COLUMN courier_pickup_at TIMESTAMPTZ,
  ADD COLUMN handover_recorded_at TIMESTAMPTZ,
  ADD CONSTRAINT orders_handover_deadline_matches_funding
    CHECK (
      funded_at IS NULL OR handover_deadline_at IS NULL
      OR handover_deadline_at = funded_at + INTERVAL '72 hours'
    );

CREATE FUNCTION enforce_order_reservation_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_item_price NUMERIC(12,2);
  reservation_delivery_fee NUMERIC(12,2);
  reservation_listing_id UUID;
  reservation_buyer_id UUID;
  reservation_seller_id UUID;
BEGIN
  IF NEW.reservation_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item_price_snapshot, delivery_fee_snapshot, listing_id, buyer_id, seller_id
    INTO reservation_item_price, reservation_delivery_fee, reservation_listing_id,
         reservation_buyer_id, reservation_seller_id
    FROM reservations
    WHERE id = NEW.reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order reservation does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.listing_id IS DISTINCT FROM reservation_listing_id
     OR NEW.buyer_id IS DISTINCT FROM reservation_buyer_id
     OR NEW.seller_id IS DISTINCT FROM reservation_seller_id THEN
    RAISE EXCEPTION 'Order listing, buyer, and seller must match the reservation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.agreed_item_price IS DISTINCT FROM reservation_item_price
     OR NEW.delivery_fee IS DISTINCT FROM reservation_delivery_fee THEN
    RAISE EXCEPTION 'Order amounts must match the reservation snapshot'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_reservation_snapshot_guard
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_reservation_snapshot();

CREATE FUNCTION prevent_reservation_snapshot_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
       NEW.listing_id,
       NEW.buyer_id,
       NEW.seller_id,
       NEW.item_price_snapshot,
       NEW.delivery_fee_snapshot,
       NEW.total_amount_snapshot,
       NEW.currency,
       NEW.recipient_name,
       NEW.recipient_phone,
       NEW.city_id,
       NEW.address_line1,
       NEW.address_line2,
       NEW.postal_code
     ) IS DISTINCT FROM ROW(
       OLD.listing_id,
       OLD.buyer_id,
       OLD.seller_id,
       OLD.item_price_snapshot,
       OLD.delivery_fee_snapshot,
       OLD.total_amount_snapshot,
       OLD.currency,
       OLD.recipient_name,
       OLD.recipient_phone,
       OLD.city_id,
       OLD.address_line1,
       OLD.address_line2,
       OLD.postal_code
     ) THEN
    RAISE EXCEPTION 'Reservation snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_snapshot_immutable
  BEFORE UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_reservation_snapshot_update();

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  provider_reference TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'late', 'refunded', 'partially_refunded')
  ),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (gateway_fee >= 0),
  gateway_fee_currency TEXT NOT NULL CHECK (gateway_fee_currency = 'PKR'),
  idempotency_key TEXT NOT NULL UNIQUE,
  hosted_checkout_reference TEXT,
  hosted_checkout_url TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  succeeded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payments_provider_payment_id_unique
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX payments_provider_reference_unique
  ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE UNIQUE INDEX payments_one_succeeded_per_order
  ON payments (order_id)
  WHERE status = 'succeeded';

CREATE INDEX payments_order_id_idx ON payments (order_id);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  trigger TEXT NOT NULL CHECK (
    trigger IN ('system_cancel', 'system_expiry', 'system_handover_timeout', 'manual_admin')
  ),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'pending', 'succeeded', 'failed', 'reversed')),
  provider_refund_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reason TEXT,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_manual_approval_identity
    CHECK (
      trigger <> 'manual_admin'
      OR (
        requested_by IS NOT NULL
        AND (
          status NOT IN ('approved', 'pending', 'succeeded', 'reversed')
          OR (approved_by IS NOT NULL AND approved_by <> requested_by)
        )
      )
    )
);

CREATE INDEX refunds_payment_id_idx ON refunds (payment_id);
CREATE INDEX refunds_order_id_idx ON refunds (order_id);

CREATE FUNCTION enforce_refund_payment_cap()
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

CREATE TRIGGER refunds_payment_cap_guard
  BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refund_payment_cap();

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  payment_id UUID REFERENCES payments(id),
  refund_id UUID REFERENCES refunds(id),
  currency TEXT NOT NULL CHECK (currency = 'PKR'),
  amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  entry_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_order_id_idx ON ledger_entries (order_id);
CREATE INDEX ledger_entries_payment_id_idx ON ledger_entries (payment_id);

CREATE FUNCTION reject_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE webhook_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  raw_body BYTEA NOT NULL,
  signature_metadata JSONB NOT NULL,
  timestamp_metadata JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  payment_id UUID REFERENCES payments(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT webhook_inbox_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE TABLE money_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  order_id UUID REFERENCES orders(id),
  payment_id UUID REFERENCES payments(id),
  refund_id UUID REFERENCES refunds(id),
  requested_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  reason TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX money_audit_events_order_id_idx ON money_audit_events (order_id);

CREATE TRIGGER money_audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON money_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER money_audit_events_no_truncate
  BEFORE TRUNCATE ON money_audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_append_only_mutation();
