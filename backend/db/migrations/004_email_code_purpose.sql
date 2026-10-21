-- Expand-only distinction between login-factor codes and address verification.
ALTER TABLE email_login_codes
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'
    CHECK (purpose IN ('login', 'verify_email'));

CREATE UNIQUE INDEX email_login_codes_one_active_verification_idx
  ON email_login_codes (user_id, purpose)
  WHERE purpose = 'verify_email' AND consumed_at IS NULL;
