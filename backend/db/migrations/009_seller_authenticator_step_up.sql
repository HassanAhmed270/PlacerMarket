-- FR-83c / FR-83f: seller TOTP credentials, one-use recovery codes, bound
-- step-up grants, and privacy-preserving known-device fingerprints.
ALTER TABLE auth_sessions
  ADD COLUMN device_hash TEXT,
  ADD COLUMN enrollment_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE seller_totp_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  last_used_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seller_totp_backup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX seller_totp_backup_codes_active_idx ON seller_totp_backup_codes(user_id, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE step_up_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('payout.update', 'password.change', 'security.change', 'payout.force_release')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX step_up_grants_active_idx ON step_up_grants(user_id, session_id, action, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE known_auth_devices (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);
