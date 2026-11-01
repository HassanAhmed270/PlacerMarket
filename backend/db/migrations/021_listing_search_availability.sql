-- Up Migration
ALTER TABLE listing_search
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS is_sold BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE listing_search search
SET reserved_until = (
      SELECT max(reservation.expires_at)
      FROM reservations reservation
      WHERE reservation.listing_id = search.listing_id
        AND reservation.status = 'active'
    ),
    is_sold = (
      EXISTS (
        SELECT 1
        FROM reservations reservation
        JOIN orders reservation_order ON reservation_order.reservation_id = reservation.id
        WHERE reservation.listing_id = search.listing_id
          AND reservation.status = 'paid'
          AND reservation_order.status <> 'cancelled'
      )
      OR EXISTS (
        SELECT 1 FROM orders legacy_order
        WHERE legacy_order.listing_id = search.listing_id
          AND legacy_order.status IN ('delivered', 'held', 'completed')
      )
    );

-- Down Migration
ALTER TABLE listing_search
  DROP COLUMN IF EXISTS is_sold,
  DROP COLUMN IF EXISTS reserved_until;
