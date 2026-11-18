-- Up Migration
ALTER TABLE review_moderation_events
  DROP CONSTRAINT review_moderation_events_review_id_fkey,
  DROP CONSTRAINT review_moderation_events_actor_id_fkey;

-- Down Migration
ALTER TABLE review_moderation_events
  ADD CONSTRAINT review_moderation_events_review_id_fkey
    FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE SET NULL,
  ADD CONSTRAINT review_moderation_events_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;
