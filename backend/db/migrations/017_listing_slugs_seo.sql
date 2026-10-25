-- FR-82, FR-82a, FR-82c: expand-only listing URL and SEO metadata.
SET lock_timeout = '3s';

ALTER TABLE listings
  ADD COLUMN short_id TEXT GENERATED ALWAYS AS (substr(replace(id::text, '-', ''), 1, 12)) STORED,
  ADD COLUMN slug TEXT GENERATED ALWAYS AS (
    coalesce(
      nullif(trim(both '-' from lower(regexp_replace(title, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
      'listing'
    )
  ) STORED,
  ADD COLUMN seo_choice TEXT NOT NULL DEFAULT 'recommended'
    CHECK (seo_choice IN ('recommended', 'custom')),
  ADD COLUMN seo_title VARCHAR(60),
  ADD COLUMN seo_description VARCHAR(155),
  ADD CONSTRAINT listings_custom_seo_text_required
    CHECK (seo_choice <> 'custom' OR (seo_title IS NOT NULL AND seo_description IS NOT NULL));

CREATE UNIQUE INDEX listings_short_id_unique ON listings (short_id);

ALTER TABLE listing_revisions
  ADD COLUMN proposed_seo_choice TEXT NOT NULL DEFAULT 'recommended'
    CHECK (proposed_seo_choice IN ('recommended', 'custom')),
  ADD COLUMN proposed_seo_title VARCHAR(60),
  ADD COLUMN proposed_seo_description VARCHAR(155),
  ADD CONSTRAINT listing_revisions_custom_seo_text_required
    CHECK (proposed_seo_choice <> 'custom'
      OR (proposed_seo_title IS NOT NULL AND proposed_seo_description IS NOT NULL));

RESET lock_timeout;
