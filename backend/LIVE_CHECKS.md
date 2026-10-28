# Live checks before launch

Phase 1, Phase 2 and Phase 3 evidence and remaining implementation-gate items
are mapped in `PHASE1_GATE_REPORT.md`, `PHASE2_GATE_REPORT.md` and
`PHASE3_GATE_REPORT.md`. On 2026-10-23,
the configured development database and JWT secret were used; migrations,
seeds, API, worker, and Vite started. Redis at 127.0.0.1:6379 was reachable.
Vite route fallbacks returned HTTP 200, and a live local API CORS preflight
returned 204 with the configured exact origin. The 14-step local demo passed
using Redis logical DB 2. Integration passed with the guarded
`TEST_DATABASE_URL` and `TEST_REDIS_URL`. See `DEMO_RUN.md` for exact results.

Fake adapters and local integration tests do not satisfy these checks. Never
put live credentials in this file, source control, test output, or logs.

## Phase 3 checks (2026-10-25)

The backend unit/smoke suite passed 46 suites/581 tests; frontend tests passed
16/16; lint, production build and the public-bundle budget check passed. The
guarded PostgreSQL integration suite did not reach test execution because
`TEST_DATABASE_URL` was unset. This is not evidence that integration passed;
rerun with the specifically approved guarded test database before closing
integration-dependent Phase 3 items. See `PHASE3_GATE_REPORT.md`.

- [ ] Select a production CDN provider and verify its cache headers, immutable
  hashed-media behavior, purge adapter and purge delivery.
- [ ] Verify the production snapshot serving model: identical generated HTML
  for crawlers and users (no cloaking), SPA takeover, snapshot refresh on the
  approved listing events, and live canonical/robots/sitemap behavior.
- [ ] Verify production listing/status and search/category freshness against
  the 10-second and 60-second limits; confirm origin/CDN behavior and cache
  invalidation under deployment routing.
- [ ] Complete the guarded integration rerun for Phase 3 using the approved
  test database and Redis endpoints; do not place endpoint credentials or
  values in this checklist or logs.

## Phase 4 payment and delivery launch checks

- [ ] Select the live payment gateway provider; verify its production account,
  approved buyer methods, adapter behavior, settlement reporting, and support
  process.
- [ ] Provision and test the provider sandbox with non-production credentials;
  verify hosted checkout, success/failure, duplicate and late events, and refunds.
- [ ] Obtain legal clearance for holding customer funds and approve the customer-
  facing payment, cancellation, delivery, and refund terms before enabling payments.
- [ ] Verify webhook signatures against the selected provider using the original
  raw request bytes; test invalid signatures, stale/replayed events, and duplicate
  delivery in the provider sandbox.
- [ ] Keep `PAYMENTS_ENABLED` false in production until provider, legal, security,
  operational, and deployment gates are reviewed and approved.
- [ ] If D2 is confirmed, provision two distinct real Admins with separate
  accounts and enrolled authenticators; verify the enablement gate and recovery
  procedure before `PAYMENTS_ENABLED` can be enabled.
- [ ] Confirm and document the one-courier launch arrangement, manual pickup and
  handover process, tracking-number handling, delivery-status source, and lost /
  refused-delivery escalation path.

- [ ] Email primary and secondary providers selected; verify real delivery,
  provider authentication, retry behavior, rate limits, and failover.
- [ ] Verify queued email delivery with the selected provider, including retry
  and failure behavior; production currently has no live sender implementation.
- [ ] Challenge verifier selected; verify the soft per-IP challenge signal and
  confirm the fake adapter cannot be selected in production.
- [ ] Verify Redis limit counters under deployed concurrent traffic,
  eviction/failover, and proxy IP forwarding. Local concurrency checks passed;
  the limiter currently fails closed when Redis is unavailable.
- [x] Run the seller authenticator/step-up endpoint limit under real Redis
  concurrency (`FR-83f`); `test/integration/rate-limit.test.js` passed with
  local `TEST_REDIS_URL`. Deployed Redis behavior remains pending.
- [ ] Production secrets and required credential variables provisioned through
  the hosting secret store; startup rejects missing values and placeholders.
- [ ] Provision and document rotation for `EMAIL_QUEUE_ENCRYPTION_SECRET`; queued
  codes are encrypted at rest and expire independently after five minutes.
- [ ] Select and provision a durable, shared production media storage backend;
  local-disk storage is for single-host development only. Verify signed private
  reads, lifecycle/backup policy, and worker/web access before enabling uploads.
- [x] Run the Phase 2 end-to-end demo against the configured localhost database
  and local Redis; the full 14-step walkthrough passed. This is local evidence;
  hosted providers/storage remain unverified. See transcript in `DEMO_RUN.md`.
- [x] Verify local backend CORS headers from the configured Vite origin;
  `DEMO_RUN.md` records the 204 preflight and exact allowed origin. Production
  domain/proxy CORS behavior remains pending.
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
