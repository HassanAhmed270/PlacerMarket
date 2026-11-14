-- Up Migration
ALTER TABLE reservations
  ADD COLUMN commission_percent_snapshot NUMERIC(5,2);

UPDATE reservations
  SET commission_percent_snapshot = COALESCE((SELECT value::numeric FROM platform_settings WHERE key = 'commission_percent'), 10.00);

ALTER TABLE reservations
  ALTER COLUMN commission_percent_snapshot SET NOT NULL,
  ADD CONSTRAINT reservations_commission_percent_snapshot_range
    CHECK (commission_percent_snapshot >= 0 AND commission_percent_snapshot <= 100);

ALTER TABLE settlements
  ADD COLUMN refunded_item_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

UPDATE platform_settings
  SET value = '5'
  WHERE key = 'commission_percent' AND value = '10';

-- Down Migration
UPDATE platform_settings
  SET value = '10'
  WHERE key = 'commission_percent' AND value = '5';

ALTER TABLE settlements
  DROP COLUMN IF EXISTS refunded_item_amount;

ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS reservations_commission_percent_snapshot_range,
  DROP COLUMN IF EXISTS commission_percent_snapshot;
