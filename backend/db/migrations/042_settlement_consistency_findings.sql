-- Up Migration
CREATE TABLE consistency_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name TEXT NOT NULL CHECK (check_name IN (
    'payment_capture_ledger',
    'successful_refund_ledger',
    'paid_payout_ledger',
    'order_ledger_sum',
    'refund_cap',
    'paid_payout_active_hold'
  )),
  subject_id UUID NOT NULL,
  business_date DATE NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT consistency_findings_check_subject_day_unique
    UNIQUE (check_name, subject_id, business_date)
);

CREATE INDEX consistency_findings_created_at_id_idx
  ON consistency_findings (created_at DESC, id DESC);

CREATE TRIGGER consistency_findings_no_update_delete
  BEFORE UPDATE OR DELETE ON consistency_findings
  FOR EACH ROW
  EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER consistency_findings_no_truncate
  BEFORE TRUNCATE ON consistency_findings
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_append_only_mutation();

-- Down Migration
DROP TABLE IF EXISTS consistency_findings;
