-- FR-73: moderated listing content versions. Additive only; public reads stay on listings.
SET lock_timeout = '3s';

ALTER TABLE listings ADD COLUMN content_version BIGINT NOT NULL DEFAULT 1;

CREATE TYPE listing_revision_status AS ENUM ('pending_review', 'approved', 'rejected', 'withdrawn');

CREATE TABLE listing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  base_content_version BIGINT NOT NULL CHECK (base_content_version > 0),
  proposed_condition listing_condition NOT NULL,
  proposed_replica_disclosure TEXT,
  proposed_title VARCHAR(150) NOT NULL,
  proposed_description TEXT,
  proposed_asking_price NUMERIC(12,2) NOT NULL CHECK (proposed_asking_price > 0),
  proposed_fabric_material VARCHAR(100),
  proposed_brand VARCHAR(100),
  proposed_color VARCHAR(50),
  proposed_embellishment_detail TEXT,
  status listing_revision_status NOT NULL DEFAULT 'pending_review',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE UNIQUE INDEX listing_revisions_one_pending_per_listing
  ON listing_revisions (listing_id) WHERE status = 'pending_review';
CREATE INDEX listing_revisions_review_queue
  ON listing_revisions (submitted_at, id) WHERE status = 'pending_review';
CREATE INDEX listing_revisions_seller_history
  ON listing_revisions (seller_id, listing_id, submitted_at DESC);

CREATE TABLE listing_revision_measurements (
  revision_id UUID NOT NULL REFERENCES listing_revisions(id) ON DELETE CASCADE,
  field_def_id UUID NOT NULL REFERENCES measurement_field_defs(id),
  value NUMERIC(6,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (revision_id, field_def_id)
);

RESET lock_timeout;
