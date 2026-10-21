-- Expand-only authentication foundations for FR-01, FR-02, FR-83d, FR-84.
ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD COLUMN password_changed_at TIMESTAMPTZ;

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_by_session_id UUID REFERENCES auth_sessions(id),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id, created_at);

CREATE TABLE email_login_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_attempt_id UUID NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email_digest TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts_used SMALLINT NOT NULL DEFAULT 0 CHECK (attempts_used BETWEEN 0 AND 3),
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX email_login_codes_attempt_idx ON email_login_codes (login_attempt_id, created_at DESC);
CREATE INDEX email_login_codes_address_idx ON email_login_codes (email_digest, created_at DESC);
CREATE UNIQUE INDEX email_login_codes_one_active_attempt_idx ON email_login_codes (login_attempt_id)
  WHERE consumed_at IS NULL;

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);

CREATE TABLE staff_totp_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
