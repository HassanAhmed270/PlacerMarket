-- Expand-only TOTP replay protection; one accepted counter value per credential.
ALTER TABLE staff_totp_credentials
  ADD COLUMN last_used_step BIGINT;
