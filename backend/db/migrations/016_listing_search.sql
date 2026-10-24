-- Up Migration
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE listings
  ADD COLUMN search_version BIGINT NOT NULL DEFAULT 1;

CREATE TABLE listing_search (
  listing_id UUID PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  search_version BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  main_category_id UUID NOT NULL,
  main_category TEXT NOT NULL,
  sub_category_id UUID NOT NULL,
  sub_category TEXT NOT NULL,
  condition TEXT NOT NULL,
  asking_price NUMERIC(12,2) NOT NULL,
  seller_city_id UUID,
  seller_city TEXT,
  color_id UUID,
  color TEXT,
  fabric_id UUID,
  fabric TEXT,
  brand_id UUID,
  brand TEXT,
  embellishment_detail TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  is_reserved BOOLEAN NOT NULL DEFAULT FALSE,
  search_text TEXT NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, search_text)
  ) STORED
);

CREATE INDEX listing_search_vector_idx
  ON listing_search USING GIN (search_vector);
CREATE INDEX listing_search_trigram_idx
  ON listing_search USING GIN (search_text gin_trgm_ops);
CREATE INDEX listing_search_newest_idx
  ON listing_search (published_at DESC, listing_id);
CREATE INDEX listing_search_price_asc_idx
  ON listing_search (asking_price ASC, published_at DESC, listing_id);
CREATE INDEX listing_search_price_desc_idx
  ON listing_search (asking_price DESC, published_at DESC, listing_id);

CREATE TABLE search_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_term VARCHAR(100) NOT NULL CHECK (length(trim(source_term)) > 0),
  normalized_source_term TEXT GENERATED ALWAYS AS (lower(trim(source_term))) STORED,
  target_term VARCHAR(100) NOT NULL CHECK (length(trim(target_term)) > 0),
  normalized_target_term TEXT GENERATED ALWAYS AS (lower(trim(target_term))) STORED,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT search_synonyms_pair_unique UNIQUE (normalized_source_term, normalized_target_term)
);

CREATE INDEX search_synonyms_source_idx
  ON search_synonyms (normalized_source_term, normalized_target_term);

-- Down Migration
DROP TABLE search_synonyms;
DROP TABLE listing_search;
ALTER TABLE listings DROP COLUMN search_version;
