-- Up Migration
ALTER TABLE refunds
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN last_attempt_at TIMESTAMPTZ,
  ADD COLUMN needs_attention_at TIMESTAMPTZ;

CREATE INDEX refunds_failed_needs_attention_idx
  ON refunds (needs_attention_at)
  WHERE status = 'failed' AND needs_attention_at IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS refunds_failed_needs_attention_idx;
ALTER TABLE refunds
  DROP COLUMN IF EXISTS needs_attention_at,
  DROP COLUMN IF EXISTS last_attempt_at,
  DROP COLUMN IF EXISTS last_error_code,
  DROP COLUMN IF EXISTS attempt_count;
