-- FR-79f: expandable encrypted payout payload storage; the legacy plaintext
-- columns remain untouched until the payout UI migration is ready.
ALTER TABLE seller_profiles
  ADD COLUMN payout_details_encrypted JSONB;
