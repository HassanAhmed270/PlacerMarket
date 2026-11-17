-- Up Migration
ALTER TABLE disputes
  ADD COLUMN sla_reminded_at TIMESTAMPTZ;

INSERT INTO platform_settings (key, value)
VALUES ('dispute_sla_business_days', '3')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX disputes_queue_cursor_idx
  ON disputes (created_at, id);

CREATE INDEX disputes_sla_candidates_idx
  ON disputes (created_at, id)
  WHERE status IN ('open', 'seller_responded') AND sla_reminded_at IS NULL;

-- Down Migration
DROP INDEX disputes_sla_candidates_idx;
DROP INDEX disputes_queue_cursor_idx;
ALTER TABLE disputes DROP COLUMN sla_reminded_at;
DELETE FROM platform_settings
WHERE key = 'dispute_sla_business_days'
  AND value = '3'
  AND updated_by IS NULL;
