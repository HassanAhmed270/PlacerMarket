-- Up Migration
-- SEC-12 conversation access, staff audit, and notifications.
ALTER TABLE messages
  ADD COLUMN read_at TIMESTAMPTZ;

ALTER TABLE notifications
  ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX notifications_user_dedupe_key
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX messages_conversation_activity
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX messages_unread_by_conversation
  ON messages (conversation_id, sender_id, created_at)
  WHERE read_at IS NULL;

CREATE TABLE conversation_staff_read_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  staff_user_id UUID NOT NULL REFERENCES users(id),
  reference_type VARCHAR(20) NOT NULL CHECK (reference_type IN ('dispute', 'report')),
  reference_id VARCHAR(100) NOT NULL CHECK (length(trim(reference_id)) > 0),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversation_staff_read_audit_conversation
  ON conversation_staff_read_audit (conversation_id, read_at DESC);

CREATE TABLE conversation_email_throttles (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
  last_queued_at TIMESTAMPTZ NOT NULL,
  last_message_id UUID NOT NULL REFERENCES messages(id)
);

-- Down Migration
DROP TABLE conversation_email_throttles;
DROP TABLE conversation_staff_read_audit;
DROP INDEX messages_unread_by_conversation;
DROP INDEX messages_conversation_activity;
DROP INDEX notifications_user_dedupe_key;
ALTER TABLE notifications DROP COLUMN dedupe_key;
ALTER TABLE messages DROP COLUMN read_at;
