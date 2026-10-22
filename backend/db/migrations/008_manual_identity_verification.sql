-- FR-66 / FR-08a: audit the manual Admin identity check without retaining
-- identity numbers or documents.
ALTER TABLE seller_profiles
  ADD COLUMN verified_by UUID REFERENCES users(id),
  ADD COLUMN verified_at TIMESTAMPTZ,
  ADD COLUMN verification_note TEXT;
