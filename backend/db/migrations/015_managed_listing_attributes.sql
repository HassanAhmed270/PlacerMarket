-- Up Migration
CREATE TABLE managed_catalog_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_type TEXT NOT NULL CHECK (attribute_type IN ('color', 'fabric', 'brand')),
  value VARCHAR(100) NOT NULL CHECK (length(trim(value)) > 0),
  normalized_value TEXT GENERATED ALWAYS AS (lower(trim(value))) STORED,
  status TEXT NOT NULL DEFAULT 'pending_custom'
    CHECK (status IN ('approved', 'pending_custom', 'rejected')),
  created_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT managed_catalog_values_type_value_unique UNIQUE (attribute_type, normalized_value)
);

CREATE INDEX managed_catalog_values_review_queue
  ON managed_catalog_values (created_at, id) WHERE status = 'pending_custom';
CREATE INDEX managed_catalog_values_approved
  ON managed_catalog_values (attribute_type, normalized_value) WHERE status = 'approved';

ALTER TABLE listings
  ADD COLUMN color_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN fabric_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN brand_id UUID REFERENCES managed_catalog_values(id);

ALTER TABLE listing_revisions
  ADD COLUMN proposed_color_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN proposed_fabric_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN proposed_brand_id UUID REFERENCES managed_catalog_values(id);

INSERT INTO managed_catalog_values (attribute_type, value, status) VALUES
  ('color', 'Black', 'approved'),
  ('color', 'White', 'approved'),
  ('color', 'Navy Blue', 'approved'),
  ('color', 'Red', 'approved'),
  ('color', 'Green', 'approved'),
  ('color', 'Maroon', 'approved'),
  ('color', 'Pink', 'approved'),
  ('color', 'Purple', 'approved'),
  ('color', 'Yellow', 'approved'),
  ('color', 'Orange', 'approved'),
  ('color', 'Brown', 'approved'),
  ('color', 'Beige', 'approved'),
  ('color', 'Grey', 'approved'),
  ('color', 'Gold', 'approved'),
  ('color', 'Silver', 'approved'),
  ('color', 'Teal', 'approved'),
  ('color', 'Turquoise', 'approved'),
  ('color', 'Cream', 'approved'),
  ('color', 'Multicolor', 'approved'),
  ('color', 'Off-white', 'approved'),
  ('fabric', 'Cotton', 'approved'),
  ('fabric', 'Silk', 'approved'),
  ('fabric', 'Chiffon', 'approved'),
  ('fabric', 'Lawn', 'approved'),
  ('fabric', 'Linen', 'approved'),
  ('fabric', 'Khaddar', 'approved'),
  ('fabric', 'Khadi', 'approved'),
  ('fabric', 'Velvet', 'approved'),
  ('fabric', 'Georgette', 'approved'),
  ('fabric', 'Organza', 'approved'),
  ('fabric', 'Net', 'approved'),
  ('fabric', 'Satin', 'approved'),
  ('fabric', 'Denim', 'approved'),
  ('fabric', 'Wool', 'approved'),
  ('fabric', 'Polyester', 'approved')
ON CONFLICT (attribute_type, normalized_value) DO NOTHING;

WITH legacy_values AS (
  SELECT 'color'::TEXT AS attribute_type, color AS value FROM listings
  UNION ALL SELECT 'fabric', fabric_material FROM listings
  UNION ALL SELECT 'brand', brand FROM listings
  UNION ALL SELECT 'color', proposed_color FROM listing_revisions
  UNION ALL SELECT 'fabric', proposed_fabric_material FROM listing_revisions
  UNION ALL SELECT 'brand', proposed_brand FROM listing_revisions
)
INSERT INTO managed_catalog_values (attribute_type, value, status)
SELECT DISTINCT legacy.attribute_type, trim(legacy.value), 'pending_custom'
FROM legacy_values legacy
WHERE legacy.value IS NOT NULL
  AND length(trim(legacy.value)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM managed_catalog_values existing
    WHERE existing.attribute_type = legacy.attribute_type
      AND existing.normalized_value = lower(trim(legacy.value))
  )
ON CONFLICT (attribute_type, normalized_value) DO NOTHING;

UPDATE listings listing SET color_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'color' AND value.normalized_value = lower(trim(listing.color))
  AND listing.color IS NOT NULL AND listing.color_id IS NULL;
UPDATE listings listing SET fabric_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'fabric' AND value.normalized_value = lower(trim(listing.fabric_material))
  AND listing.fabric_material IS NOT NULL AND listing.fabric_id IS NULL;
UPDATE listings listing SET brand_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'brand' AND value.normalized_value = lower(trim(listing.brand))
  AND listing.brand IS NOT NULL AND listing.brand_id IS NULL;

UPDATE listing_revisions revision SET proposed_color_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'color' AND value.normalized_value = lower(trim(revision.proposed_color))
  AND revision.proposed_color IS NOT NULL AND revision.proposed_color_id IS NULL;
UPDATE listing_revisions revision SET proposed_fabric_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'fabric' AND value.normalized_value = lower(trim(revision.proposed_fabric_material))
  AND revision.proposed_fabric_material IS NOT NULL AND revision.proposed_fabric_id IS NULL;
UPDATE listing_revisions revision SET proposed_brand_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'brand' AND value.normalized_value = lower(trim(revision.proposed_brand))
  AND revision.proposed_brand IS NOT NULL AND revision.proposed_brand_id IS NULL;

CREATE INDEX listings_color_id ON listings (color_id) WHERE color_id IS NOT NULL;
CREATE INDEX listings_fabric_id ON listings (fabric_id) WHERE fabric_id IS NOT NULL;
CREATE INDEX listings_brand_id ON listings (brand_id) WHERE brand_id IS NOT NULL;

-- Down Migration
DROP INDEX listings_brand_id;
DROP INDEX listings_fabric_id;
DROP INDEX listings_color_id;
ALTER TABLE listing_revisions
  DROP COLUMN proposed_brand_id,
  DROP COLUMN proposed_fabric_id,
  DROP COLUMN proposed_color_id;
ALTER TABLE listings
  DROP COLUMN brand_id,
  DROP COLUMN fabric_id,
  DROP COLUMN color_id;
DROP TABLE managed_catalog_values;
