# Live checks before launch

Fake adapters and local integration tests do not satisfy these checks. Never
put live credentials in this file, source control, test output, or logs.

- [ ] Email primary and secondary providers selected; verify real delivery,
  provider authentication, retry behavior, rate limits, and failover.
- [ ] Challenge verifier selected; verify the soft per-IP challenge signal and
  confirm the fake adapter cannot be selected in production.
- [ ] Production secrets and required credential variables provisioned through
  the hosting secret store; startup rejects missing values and placeholders.
- [ ] Staff TOTP encryption key provisioned outside PostgreSQL/source control;
  document secure rotation and recovery before enrollment is enabled.
- [ ] Re-run the Argon2 benchmark on each production-sized host; verify latency,
  memory headroom at the configured worker concurrency, and saturation behavior.
- [ ] Refresh-cookie, HTTPS, CORS, origin validation, and production domain
  behavior verified against the deployed host.
- [ ] Queue worker and database behavior checked against the deployed
  PgBouncer transaction-pool configuration before Phase 6.
