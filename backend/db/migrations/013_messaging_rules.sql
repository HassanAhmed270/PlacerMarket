ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'sold';

CREATE TABLE contact_info_block_attempts (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
