-- FR-09a / SEC-35 / FR-83l: sanitized payout display metadata and audited
-- seller-level administrative holds. Legacy plaintext columns remain for
-- expand-only compatibility and are scrubbed by keys:rotate.
ALTER TABLE seller_profiles
  ADD COLUMN payout_last4 VARCHAR(4),
  ADD COLUMN payout_changed_at TIMESTAMPTZ,
  ADD COLUMN payout_needs_update BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN payout_hold_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN payout_hold_reason TEXT,
  ADD COLUMN payout_hold_set_by UUID REFERENCES users(id),
  ADD COLUMN payout_hold_set_at TIMESTAMPTZ,
  ADD COLUMN payout_hold_cleared_by UUID REFERENCES users(id),
  ADD COLUMN payout_hold_cleared_at TIMESTAMPTZ,
  ADD COLUMN payout_hold_clear_reason TEXT;
