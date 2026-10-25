-- FR-81a, FR-82b: worker-generated public HTML and crawler documents.
CREATE TABLE page_snapshots (
  path TEXT PRIMARY KEY,
  page_type TEXT NOT NULL CHECK (
    page_type IN ('home', 'main_category', 'sub_category', 'category_city', 'listing', 'sitemap', 'robots')
  ),
  html TEXT NOT NULL,
  status_code SMALLINT NOT NULL DEFAULT 200 CHECK (status_code BETWEEN 200 AND 599),
  noindex BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX page_snapshots_type_idx ON page_snapshots (page_type, path);
