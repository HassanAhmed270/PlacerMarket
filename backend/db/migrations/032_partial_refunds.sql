-- Up Migration
ALTER TABLE refunds
  ADD COLUMN item_amount NUMERIC(12,2),
  ADD COLUMN delivery_fee_amount NUMERIC(12,2),
  ADD COLUMN seller_at_fault BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN decided_by UUID REFERENCES users(id),
  ADD CONSTRAINT refunds_split_amounts_check
    CHECK (
      (item_amount IS NULL AND delivery_fee_amount IS NULL)
      OR (
        item_amount IS NOT NULL
        AND delivery_fee_amount IS NOT NULL
        AND item_amount >= 0
        AND delivery_fee_amount >= 0
        AND item_amount + delivery_fee_amount = amount
      )
    );

-- Down Migration
ALTER TABLE refunds
  DROP CONSTRAINT IF EXISTS refunds_split_amounts_check,
  DROP COLUMN IF EXISTS decided_by,
  DROP COLUMN IF EXISTS seller_at_fault,
  DROP COLUMN IF EXISTS delivery_fee_amount,
  DROP COLUMN IF EXISTS item_amount;
