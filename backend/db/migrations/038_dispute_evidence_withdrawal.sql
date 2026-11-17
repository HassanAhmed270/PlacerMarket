-- Up Migration
ALTER TYPE dispute_status ADD VALUE 'withdrawn';

ALTER TABLE disputes
  ADD COLUMN withdrawn_at TIMESTAMPTZ;

ALTER TABLE dispute_evidence
  ALTER COLUMN file_url DROP NOT NULL,
  ADD COLUMN note TEXT,
  ADD CONSTRAINT dispute_evidence_content_check CHECK (
    (file_url IS NOT NULL AND note IS NULL) OR
    (file_url IS NULL AND note IS NOT NULL
      AND char_length(btrim(note)) BETWEEN 3 AND 500)
  );

CREATE INDEX dispute_evidence_timeline_idx
  ON dispute_evidence (dispute_id, created_at, id);

-- Down Migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM disputes WHERE status = 'withdrawn')
     OR EXISTS (SELECT 1 FROM dispute_evidence WHERE file_url IS NULL) THEN
    RAISE EXCEPTION 'Cannot revert dispute workflow data after withdrawals or notes exist';
  END IF;
END;
$$;

DROP INDEX dispute_evidence_timeline_idx;
ALTER TABLE dispute_evidence
  DROP CONSTRAINT dispute_evidence_content_check,
  DROP COLUMN note,
  ALTER COLUMN file_url SET NOT NULL;
ALTER TABLE disputes DROP COLUMN withdrawn_at;

ALTER TABLE disputes ALTER COLUMN status DROP DEFAULT;
ALTER TABLE disputes ALTER COLUMN status TYPE TEXT USING status::TEXT;
DROP TYPE dispute_status;
CREATE TYPE dispute_status AS ENUM (
  'open', 'seller_responded', 'resolved_refund', 'resolved_release', 'resolved_other'
);
ALTER TABLE disputes
  ALTER COLUMN status TYPE dispute_status USING status::dispute_status,
  ALTER COLUMN status SET DEFAULT 'open';
