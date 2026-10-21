# Live checks before launch

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
- [ ] Production secrets and required credential variables provisioned through
  the hosting secret store; startup rejects missing values and placeholders.
- [ ] Provision and document rotation for `EMAIL_QUEUE_ENCRYPTION_SECRET`; queued
  codes are encrypted at rest and expire independently after five minutes.
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
