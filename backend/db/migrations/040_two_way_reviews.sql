-- Up Migration
ALTER TABLE reviews RENAME COLUMN comment TO body;

ALTER TABLE reviews
  ADD COLUMN direction TEXT,
  ADD COLUMN item_rating SMALLINT,
  ADD COLUMN state TEXT NOT NULL DEFAULT 'visible',
  ADD COLUMN revealed_at TIMESTAMPTZ,
  ADD COLUMN hidden_by UUID REFERENCES users(id),
  ADD COLUMN hidden_reason TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE reviews r
   SET direction = CASE
     WHEN r.reviewer_id = o.buyer_id AND r.reviewee_id = o.seller_id THEN 'buyer_to_seller'
     WHEN r.reviewer_id = o.seller_id AND r.reviewee_id = o.buyer_id THEN 'seller_to_buyer'
   END,
       revealed_at = r.created_at
  FROM orders o
 WHERE o.id = r.order_id;

ALTER TABLE reviews
  ALTER COLUMN direction SET NOT NULL,
  ADD CONSTRAINT reviews_direction_check
    CHECK (direction IN ('buyer_to_seller', 'seller_to_buyer')),
  ADD CONSTRAINT reviews_item_rating_check
    CHECK (item_rating IS NULL OR item_rating BETWEEN 1 AND 5),
  ADD CONSTRAINT reviews_item_rating_direction_check
    CHECK (item_rating IS NULL OR direction = 'buyer_to_seller'),
  ADD CONSTRAINT reviews_state_check
    CHECK (state IN ('hidden_until_reveal', 'visible', 'hidden_by_admin')),
  ADD CONSTRAINT reviews_hidden_metadata_check
    CHECK (
      (state = 'hidden_by_admin' AND hidden_by IS NOT NULL AND hidden_reason IS NOT NULL)
      OR (state <> 'hidden_by_admin' AND hidden_by IS NULL AND hidden_reason IS NULL)
    ),
  ADD CONSTRAINT reviews_order_direction_unique UNIQUE (order_id, direction);

CREATE INDEX reviews_reviewee_cursor_idx
  ON reviews (reviewee_id, direction, state, created_at DESC, id DESC);
CREATE INDEX reviews_order_direction_state_idx
  ON reviews (order_id, direction, state);

CREATE FUNCTION enforce_review_direction_parties()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_buyer UUID;
  order_seller UUID;
BEGIN
  SELECT buyer_id, seller_id
    INTO order_buyer, order_seller
    FROM orders
   WHERE id = NEW.order_id;

  IF NOT FOUND OR NOT (
    (NEW.direction = 'buyer_to_seller'
      AND NEW.reviewer_id = order_buyer AND NEW.reviewee_id = order_seller)
    OR
    (NEW.direction = 'seller_to_buyer'
      AND NEW.reviewer_id = order_seller AND NEW.reviewee_id = order_buyer)
  ) THEN
    RAISE EXCEPTION 'Review direction must match the order participants'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reviews_direction_parties_trigger
  BEFORE INSERT OR UPDATE OF order_id, reviewer_id, reviewee_id, direction ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION enforce_review_direction_parties();

CREATE TABLE review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, reporter_id)
);

CREATE INDEX review_reports_created_idx
  ON review_reports (created_at DESC, id DESC);

CREATE TABLE review_moderation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('hide', 'restore')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX review_moderation_events_review_idx
  ON review_moderation_events (review_id, created_at DESC, id DESC);

CREATE TRIGGER review_moderation_events_no_update_delete
  BEFORE UPDATE OR DELETE ON review_moderation_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER review_moderation_events_no_truncate
  BEFORE TRUNCATE ON review_moderation_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_append_only_mutation();

INSERT INTO platform_settings (key, value)
VALUES ('review_window_days', '14')
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM platform_settings
 WHERE key = 'review_window_days' AND value = '14' AND updated_by IS NULL;

DROP TRIGGER review_moderation_events_no_truncate ON review_moderation_events;
DROP TRIGGER review_moderation_events_no_update_delete ON review_moderation_events;
DROP TABLE review_moderation_events;
DROP INDEX review_reports_created_idx;
DROP TABLE review_reports;
DROP TRIGGER reviews_direction_parties_trigger ON reviews;
DROP FUNCTION enforce_review_direction_parties();
DROP INDEX reviews_order_direction_state_idx;
DROP INDEX reviews_reviewee_cursor_idx;
ALTER TABLE reviews
  DROP CONSTRAINT reviews_order_direction_unique,
  DROP CONSTRAINT reviews_hidden_metadata_check,
  DROP CONSTRAINT reviews_state_check,
  DROP CONSTRAINT reviews_item_rating_direction_check,
  DROP CONSTRAINT reviews_item_rating_check,
  DROP CONSTRAINT reviews_direction_check,
  DROP COLUMN updated_at,
  DROP COLUMN hidden_reason,
  DROP COLUMN hidden_by,
  DROP COLUMN revealed_at,
  DROP COLUMN state,
  DROP COLUMN item_rating,
  DROP COLUMN direction;
ALTER TABLE reviews RENAME COLUMN body TO comment;
