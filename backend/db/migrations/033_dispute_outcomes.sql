-- Up Migration
ALTER TABLE disputes
  ADD COLUMN outcome TEXT
    CHECK (outcome IN ('buyer_favor', 'seller_favor', 'split'));

ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin'
    ));

-- Down Migration
ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin'
    ));

ALTER TABLE disputes
  DROP COLUMN outcome;
