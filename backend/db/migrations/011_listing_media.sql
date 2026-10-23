-- FR-74: expand listing image storage for private originals and processed variants.
ALTER TABLE listing_images
  ADD COLUMN slot VARCHAR(16),
  ADD COLUMN processing_state VARCHAR(16) NOT NULL DEFAULT 'ready'
    CHECK (processing_state IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN original_key TEXT,
  ADD COLUMN thumbnail_key TEXT,
  ADD COLUMN medium_key TEXT,
  ADD COLUMN large_key TEXT,
  ADD COLUMN social_key TEXT,
  ADD COLUMN content_hash CHAR(64),
  ADD COLUMN label_confirmed_by UUID REFERENCES users(id),
  ADD COLUMN label_confirmed_at TIMESTAMPTZ,
  ADD COLUMN label_rejected_by UUID REFERENCES users(id),
  ADD COLUMN label_rejected_at TIMESTAMPTZ,
  ADD COLUMN label_rejected_reason TEXT;

CREATE UNIQUE INDEX listing_images_slot_unique
  ON listing_images (listing_id, slot)
  WHERE slot IS NOT NULL;
CREATE INDEX listing_images_processing_idx
  ON listing_images (processing_state, id)
  WHERE processing_state IN ('pending', 'failed');
