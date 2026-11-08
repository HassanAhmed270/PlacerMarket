-- Up Migration
CREATE INDEX refunds_manual_requested_page_idx
  ON refunds (requested_at DESC, id DESC)
  WHERE trigger = 'manual_admin';

-- Down Migration
DROP INDEX refunds_manual_requested_page_idx;
