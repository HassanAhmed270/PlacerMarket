-- Up Migration
ALTER TABLE order_exceptions
  DROP CONSTRAINT order_exceptions_kind_check,
  ADD CONSTRAINT order_exceptions_kind_check
    CHECK (kind IN ('late_handover_after_auto_cancel', 'handover_after_cancel')),
  ADD CONSTRAINT order_exceptions_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES users(id);

-- Down Migration
ALTER TABLE order_exceptions
  DROP CONSTRAINT order_exceptions_resolved_by_fkey,
  DROP CONSTRAINT order_exceptions_kind_check,
  ADD CONSTRAINT order_exceptions_kind_check
    CHECK (kind IN ('late_handover_after_auto_cancel'));
