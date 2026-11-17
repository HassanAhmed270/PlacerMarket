-- Up Migration
ALTER TABLE delivery_outcomes
  DROP CONSTRAINT delivery_outcomes_outcome_check,
  ADD CONSTRAINT delivery_outcomes_outcome_check
    CHECK (outcome IN ('refused', 'lost'));

ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin', 'delivery_lost'
    ));

-- Down Migration
ALTER TABLE refunds
  DROP CONSTRAINT refunds_trigger_check,
  ADD CONSTRAINT refunds_trigger_check
    CHECK (trigger IN (
      'system_cancel', 'system_expiry', 'system_handover_timeout',
      'manual_admin', 'dispute_admin'
    ));

ALTER TABLE delivery_outcomes
  DROP CONSTRAINT delivery_outcomes_outcome_check,
  ADD CONSTRAINT delivery_outcomes_outcome_check
    CHECK (outcome = 'refused');
