-- Up Migration
ALTER TABLE order_exceptions
  DROP CONSTRAINT order_exceptions_kind_check,
  ADD CONSTRAINT order_exceptions_kind_check
    CHECK (kind IN (
      'late_handover_after_auto_cancel',
      'handover_after_cancel',
      'dispute_refund_required'
    ));

-- Down Migration
ALTER TABLE order_exceptions
  DROP CONSTRAINT order_exceptions_kind_check,
  ADD CONSTRAINT order_exceptions_kind_check
    CHECK (kind IN ('late_handover_after_auto_cancel', 'handover_after_cancel'));
