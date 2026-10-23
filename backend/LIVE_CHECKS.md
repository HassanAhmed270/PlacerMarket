# Live checks before launch

Phase 1 local evidence and remaining implementation-gate items are mapped in
`PHASE1_GATE_REPORT.md`. Stage 9 did not execute the service-backed demo:
PostgreSQL service exists, but an app `DEMO_DATABASE_URL`/`DATABASE_URL`, valid
JWT secret, and Redis were unavailable. `DEMO_RUN.md` contains the guarded
commands and observed limits. Do not treat the frontend Vite HTTP 200 as a
backend or end-to-end demo check.

Fake adapters and local integration tests do not satisfy these checks. Never
put live credentials in this file, source control, test output, or logs.

- [ ] Email primary and secondary providers selected; verify real delivery,
  provider authentication, retry behavior, rate limits, and failover.
- [ ] Verify queued email delivery with the selected provider, including retry
  and failure behavior; production currently has no live sender implementation.
- [ ] Challenge verifier selected; verify the soft per-IP challenge signal and
  confirm the fake adapter cannot be selected in production.
- [ ] Verify Redis limit counters under concurrent traffic, eviction/failover,
  and deployed proxy IP forwarding; the limiter currently fails closed when
  Redis is unavailable.
- [ ] Run the seller authenticator/step-up endpoint limit under real Redis
  concurrency (`FR-83f`); the local integration test is skipped without
  `TEST_REDIS_URL`.
- [ ] Production secrets and required credential variables provisioned through
  the hosting secret store; startup rejects missing values and placeholders.
- [ ] Provision and document rotation for `EMAIL_QUEUE_ENCRYPTION_SECRET`; queued
  codes are encrypted at rest and expire independently after five minutes.
- [ ] Select and provision a durable, shared production media storage backend;
  local-disk storage is for single-host development only. Verify signed private
  reads, lifecycle/backup policy, and worker/web access before enabling uploads.
- [ ] Staff TOTP encryption key provisioned outside PostgreSQL/source control;
  document secure rotation and recovery before enrollment is enabled. First
  admin bootstrap consumes its confirmation code; wait for the next 30-second
  TOTP step before first login.
- [ ] Document and exercise JWT signing-key rotation, including access-token
  invalidation, session continuity, and rollback before production rollout.
- [ ] Re-run the Argon2 benchmark on each production-sized host; verify latency,
  memory headroom at the configured worker concurrency, and saturation behavior.
- [ ] Refresh-cookie, HTTPS, CORS, origin validation, and production domain
  behavior verified against the deployed host.
- [ ] Execute first-admin bootstrap on the deployment database and verify the
  TOTP secret is stored encrypted and the operator has the only copy.
- [ ] Queue worker and database behavior checked against the deployed
  PgBouncer transaction-pool configuration before Phase 6.
- [ ] Owner creates and verifies an offline master-key backup for payout-field
  encryption; confirm access, secure storage and recovery without placing the
  backup in source control, the database or logs.
- [ ] Exercise payout-key rotation with a current backup: deploy new key ID and
  key alongside old keys, switch `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID`, run
  `npm run keys:rotate`, verify no ciphertext references the old key, then
  remove the old key only after the rollback window closes.
- [ ] On a copy of the pre-Phase-1 database, exercise `npm run keys:rotate`
  against legacy plaintext payout columns; confirm those columns are nulled,
  legacy values are encrypted, affected sellers are marked `payout_needs_update`,
  and the old key is retained until the rollback window closes.
- [ ] Document and exercise the manual Admin identity-verification procedure:
  verify identity without retaining a CNIC number or document, submit only a
  short note through the Admin route, confirm verified_by/verified_at are set,
  and confirm first-payout gating checks id_verified rather than email.
