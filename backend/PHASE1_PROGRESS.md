# Phase 1 progress

Resume at the first incomplete stage. Completed stages are not repeated.

## Stage 0 — PREFLIGHT — complete (2026-10-22)

- **Files:** `test/integration/rate-limit.test.js`, `DEVELOPMENT_HANDOFF.md`, and
  this checkpoint.
- **Migrations:** none.
- **Change:** corrected the concurrent email-code send test to expect exactly one
  send during the 60-second cooldown; added separate tests for a burst of eight
  and sequential sends with a one-second cooldown and cap of three. The limiter
  implementation was not changed.
- **Verification:** `npm.cmd test -- --runInBand` — 32 suites / 348 tests passed.
  `npm.cmd run test:integration` — 4 suites / 67 tests passed on PostgreSQL
  18.6; the real-Redis suite was skipped (3 tests) because `TEST_REDIS_URL` is
  unset and no local Redis endpoint was reachable at `127.0.0.1:6379`.
- **Git:** began on `main`, aligned with `origin/main`; the only pre-existing
  changes are two staged/deleted `.docx` files, preserved outside commits.
- **Parked:** hosted CI, real-Redis integration, and production/live checks remain
  open. Nothing is exposed to real users until these residuals and applicable
  Phase 1 gate checks are closed.
- **Provisional assumptions:** none introduced in this stage.
- **Live checks:** see `LIVE_CHECKS.md`; none executed.
- **Dated amendment:** the owner authorized Phase 1 on 2026-10-21 with Phase 0
  residuals carried as open items; recorded in `DEVELOPMENT_HANDOFF.md`.
- **Next:** Stage 1 — SELLER APPLICATION + APPROVAL.

## Stage 1 — SELLER APPLICATION + APPROVAL — complete (2026-10-22)

- **Files:** `src/modules/users.service.js`, `src/modules/admin.service.js`,
  `src/routes/users.routes.js`, `src/routes/admin.routes.js`,
  `test/integration/known-mismatches.test.js`, `specs.md`, `open-questions.md`,
  `Phases.md`, and this checkpoint.
- **Migrations:** none; existing application/profile columns were sufficient.
- **Behavior:** applications store only reason and items-to-sell; name, phone and
  city are read from the profile. Submission requires a configured city. Review
  is limited to pending applications; approval updates application, seller role,
  and seller-profile approval inside one transaction. Suspension clears profile
  approval and timestamp in the same transaction as the user suspension.
- **Verification:** full `npm.cmd test -- --runInBand` — 32 suites / 361 tests
  passed after the spec checkbox update. PostgreSQL 18.6 focused integration run
  — 1 suite / 57 tests passed, including FR-06, FR-07, FR-07a, FR-07b and FR-10
  tests and an injected failure proving approval rollback. The first full
  integration attempt found an outdated duplicate-submission fixture test; it
  was replaced by a profile-backed queue test, and the affected suite then
  passed. Full integration will be rerun at the final verification stage.
- **Rows ticked:** FR-06, FR-07, FR-07a, FR-08, FR-10; see named tests in
  `specs.md`.
- **Parked:** FR-07b's Admin → Users navigation placement is in the frontend
  stage; no security-critical ambiguity arose.
- **Provisional assumptions:** one pending application per account; resubmission
  inserts a linked row; both text fields are non-empty. Logged in
  `open-questions.md` for owner confirmation.
- **Live checks:** none required for this backend stage; production checks remain
  open in `LIVE_CHECKS.md`.
- **Next:** Stage 2 — MEASUREMENTS.

## Stage 2 — MEASUREMENTS — complete (2026-10-22)

- **Files:** `db/migrations/006_measurement_field_lifecycle.sql`, generated
  `schema.sql`, `src/modules/catalog.service.js`, `src/modules/listings.service.js`,
  `src/routes/catalog.routes.js`, `src/lib/roles.js`, unit and PostgreSQL
  integration tests, `agent.md`, `SCHEMA_CODE_AUDIT.md`, `specs.md`, `Phases.md`,
  and this checkpoint.
- **Migrations:** `001_initial_schema.sql`, `002_pgboss_schema.sql`,
  `003_auth_foundation.sql`, `004_email_code_purpose.sql`,
  `005_staff_totp_replay_guard.sql` (existing); `006_measurement_field_lifecycle.sql`
  (added). Snapshot regenerated.
- **Behavior:** required and active flags persist; admins can add, rename,
  reorder and retire definitions. Omitted unreferenced fields are deleted;
  referenced fields are marked inactive and retain old values. Public definitions
  and listing creation use active fields only. Creation rejects missing required
  fields. Catalog editing and listing creation lock their sub-category row to
  serialize definition changes with newly created listing measurements.
- **Verification:** full `npm.cmd test -- --runInBand` — 33 suites / 369 tests
  passed. PostgreSQL 18.6 focused integration — 1 suite / 58 tests passed.
  Targeted catalog permission, role, migration snapshot, and FR-comment checks —
  4 suites / 127 tests passed. `npm.cmd run db:check-schema` passed.
- **Rows ticked:** FR-15a, with named PostgreSQL tests in `specs.md`.
- **Parked:** none for the measurement contract; Admin catalog edits use the
  Admin-only `catalog.manage` permission.
- **Provisional assumptions:** none introduced in this stage.
- **Live checks:** none required for this backend stage; deployment checks remain
  open in `LIVE_CHECKS.md`.
- **Next:** Stage 3 — KEY PROVIDER + ENCRYPTION.

## Stage 3 — KEY PROVIDER + ENCRYPTION — complete (2026-10-22)

- **Files:** migration `db/migrations/007_payout_encryption_envelope.sql`,
  generated `schema.sql`, `src/lib/keyProvider.js`,
  `src/lib/payoutEncryption.js`, `src/config.js`,
  `scripts/rotate-payout-keys.js`, `package.json`, `.env.example`,
  `test/unit/payout-encryption.test.js`, `test/unit/config.test.js`, migration
  snapshot test, `agent.md`, `open-questions.md`, `specs.md`, `security.md`,
  `LIVE_CHECKS.md`, `Phases.md`, and this checkpoint.
- **Migrations:** 001 `initial_schema`, 002 `pgboss_schema`, 003
  `auth_foundation`, 004 `email_code_purpose`, 005
  `staff_totp_replay_guard`, 006 `measurement_field_lifecycle`, 007
  `payout_encryption_envelope`. Snapshot regenerated; legacy plaintext columns
  remain untouched pending the payout stage.
- **Behavior:** AES-256-GCM uses random 12-byte nonces, seller-ID AAD, versioned
  key IDs and base64url envelope fields. Production config requires a valid
  active key and every key is exactly 32 bytes. `npm run keys:rotate` scans
  bounded batches, decrypts with the recorded key and conditionally replaces
  envelopes with the active key. No provider or dependency was added.
- **Verification:** focused key-provider/config/snapshot tests — 3 suites / 13
  tests passed. Full `npm.cmd test -- --runInBand` — 34 suites / 374 tests
  passed; `npm.cmd run db:check-schema` passed. Full PostgreSQL 18.6 integration
  run — 4 suites passed / 1 suite skipped, 73 tests passed / 3 skipped. Redis
  integration tests remain skipped because `TEST_REDIS_URL` is unset and no
  local Redis service was available. The initial integration command omitted
  loading `.env` and correctly stopped at the test-database guard; rerun with
  Node `--env-file-if-exists=.env` passed.
- **Rows ticked:** FR-79f and SEC-30; tests named in `specs.md` and `security.md`.
- **Parked:** offline master-key backup and deployment rotation exercise are
  live checks. No security-critical ambiguity remains for this adapter.
- **Provisional assumptions:** key env format is JSON key-ID-to-base64 mapping,
  recorded in `open-questions.md` for owner confirmation.
- **Live checks:** `LIVE_CHECKS.md` tracks offline key backup, staged rotation,
  rollback window, and old-key removal.
- **Next:** Stage 4 — ID VERIFICATION.

## Stage 4 — ID VERIFICATION — complete (2026-10-22)

- **Files:** migration `db/migrations/008_manual_identity_verification.sql`,
  generated `schema.sql`, `src/lib/adapters/identityVerifier.js`,
  `src/modules/users.service.js`, `src/modules/admin.service.js`,
  `src/routes/admin.routes.js`, `src/lib/roles.js`, integration and unit tests,
  `src/config.js`, `agent.md`, `specs.md`, `security.md`, `Phases.md`, and this
  checkpoint.
- **Migrations:** 001 `initial_schema`, 002 `pgboss_schema`, 003
  `auth_foundation`, 004 `email_code_purpose`, 005
  `staff_totp_replay_guard`, 006 `measurement_field_lifecycle`, 007
  `payout_encryption_envelope`, 008 `manual_identity_verification`. Snapshot
  regenerated.
- **Behavior:** Admin-only `POST /api/admin/sellers/:id/identity-verification`
  accepts a short note and rejects extra data (including CNIC/document fields).
  `users.service.js` delegates to manual-admin `IdentityVerifier` and records
  `id_verified`, `verified_by`, `verified_at`, and `verification_note` in one
  database transaction. The fake requires `DEV_FAKES=1` and production rejects
  that setting. Email verification does not set identity verification.
- **Threshold check:** existing `isIdVerificationRequired` and moderation
  queue use strict `>`; equality and above-threshold behavior are covered by
  named PostgreSQL tests in `specs.md`.
- **Verification:** focused identity adapter, Admin permission/input,
  production config, and migration snapshot tests — 4 suites / 37 tests passed.
  Full `npm.cmd test -- --runInBand` — 35 suites / 384 tests passed;
  `npm.cmd run db:check-schema` passed. Full PostgreSQL 18.6 integration run —
  4 suites passed / 1 suite skipped, 74 passed / 3 skipped. Redis tests remain
  skipped because `TEST_REDIS_URL` is unset and no Redis service is available.
- **Rows ticked:** FR-66a and FR-08b; FR-66 payout refusal remains Stage 6.
  Tests named in `specs.md`.
- **Parked:** no ID provider was selected or implemented. No CNIC number or
  document is collected or stored.
- **Provisional assumptions:** manual identity note is required, trimmed and
  limited to 500 characters; admin must complete the check before calling the
  route.
- **Live checks:** manual Admin procedure is tracked in `LIVE_CHECKS.md`.
- **Next:** Stage 5 — SELLER AUTHENTICATOR, BACKUP CODES, STEP-UP, NEW-DEVICE
  NOTICE.

## Stage 5 — SELLER AUTHENTICATOR, BACKUP CODES, STEP-UP, NEW-DEVICE NOTICE — implemented; gate pending (2026-10-22)

- **Files:** migration `db/migrations/009_seller_authenticator_step_up.sql`,
  generated `schema.sql`, `src/config.js`, `src/middleware/auth.js`,
  `src/middleware/rateLimit.js`, `src/modules/users.service.js`,
  `src/routes/users.routes.js`, `src/routes/payout.routes.js`,
  `src/lib/roles.js`, `.env.example`, unit/integration tests,
  `agent.md`, `open-questions.md`, `specs.md`, `security.md`, `Phases.md`, and
  this checkpoint.
- **Migrations:** 001 `initial_schema`, 002 `pgboss_schema`, 003
  `auth_foundation`, 004 `email_code_purpose`, 005
  `staff_totp_replay_guard`, 006 `measurement_field_lifecycle`, 007
  `payout_encryption_envelope`, 008 `manual_identity_verification`, 009
  `seller_authenticator_step_up`. Snapshot regenerated.
- **Behavior:** seller TOTP setup returns an `otpauth://` URI and secret once;
  confirmation stores encrypted secret and ten hashed 96-bit backup codes,
  returned only once. Sellers without TOTP receive an enrollment-only session
  restricted to enrollment, confirmation, logout and refresh; confirmation
  upgrades that session. Enabled sellers use TOTP at login. Step-up grants are
  single-use, action/user/session-bound and limited to 300 seconds by default,
  hard maximum 900 seconds. TOTP replay checks and atomic backup-code
  consumption are enforced in PostgreSQL. Password changes, authenticator
  disable, and Admin force-release consume matching step-up grants. New device
  fingerprints are HMAC-hashed and a first-seen device queues an encrypted
  email notice. New security routes use a Redis-backed limiter.
- **Verification so far:** 6 focused unit suites / 31 tests passed; focused
  PostgreSQL FR-83c/f integration test passed, including single-use concurrent
  grant/code use, password change, authenticator disable, seller TOTP login,
  enrollment-session upgrade, and one new-device notification. Full
  `npm.cmd test -- --runInBand` — 36 suites / 397 tests passed;
  `npm.cmd run db:check-schema` passed. Full PostgreSQL 18.6 integration run —
  4 suites passed / 1 suite skipped, 76 passed / 4 skipped. The first full
  integration run found a stale 30-table snapshot assertion; it was updated to
  assert the 34-table schema through migration 009 and its focused suite passed.
  Redis-specific concurrency remains unverified because `TEST_REDIS_URL` is
  unset and local Redis is unavailable.
- **Rows:** FR-83c and FR-83f remain unchecked until Stage 6 also gates and
  notifies payout changes. SEC-35 remains unchecked for the same reason. The
  password and force-release paths are independently covered by named tests.
- **Parked:** device list/revoke UI and admin-assisted recovery remain deferred;
  no passkey or email-change endpoint added.
- **Provisional assumptions:** 5-minute step-up TTL (max 15 minutes),
  HMAC-hashed `X-Device-ID` with user-agent fallback, and note in
  `open-questions.md`.
- **Live checks:** real Redis concurrency; real email-provider delivery and
  deployed TOTP key custody remain in `LIVE_CHECKS.md`.
- **Next:** Stage 6 — PAYOUT DETAILS.

## Stage 6 — payout details (implementation checkpoint; PostgreSQL verification pending)

- **Implemented:** migration `010_payout_controls.sql`; method-specific bank,
  Easypaisa and JazzCash validation; session-bound `payout.update` grants and
  enrolled seller TOTP requirement; encrypted-at-rest details and last-four
  projection; generic encrypted email queue notice on every change; Admin-only
  masked payout queue, configurable seven-day changed flag, and audited hold
  set/clear; payout initiation checks identity verification, authenticator,
  hold state and current encrypted details. `keys:rotate` also encrypts and
  scrubs legacy plaintext payout columns, marking those profiles for update.
- **Verification:** at the Stage 6 checkpoint, full backend unit suite passed
  (36 suites / 422 tests), focused payout units passed, and schema snapshot
  matched. Stage 9 then ran the complete PostgreSQL suite: 4 suites passed,
  77 tests passed, 4 Redis-only tests skipped; the FR-09a/SEC-30/35 leak/API
  regression passed. Extra IBAN-checksum and wallet-method tests are covered by
  the current full backend unit suite (38 suites / 439 tests). Redis concurrency
  and live email delivery remain separate live checks.
- **Schema audit:** the earlier `42703` mismatch in `updateSellerPayoutMethod`
  is repaired and the PostgreSQL payout regression passes. The stale pre-repair
  error pin was updated to assert that obsolete method values fail validation.
- **Rows:** FR-09a, FR-66, FR-83c/f and SEC-30/35 are checked with named tests;
  SEC-30's offline master-key backup remains an owner live check.
- **Live checks:** real Redis concurrency, email provider delivery, and offline
  key backup/rotation exercise remain open.

## Stage 7 — seller and Admin frontend workspace

- **Implemented:** authenticated workspace at `/account`; seller application
  status/form, authenticator enrollment with secret and `otpauth://` text,
  one-time backup-code screen, authenticator step-up prompt and payout form;
  Admin application review, manual ID verification, payout recent-change and
  hold display/actions. Access tokens stay in module memory and protected API
  calls attach bearer auth. API calls are real; an explicit development fake
  banner is shown when `VITE_DEV_FAKES=1`. Existing public catalog markup is
  unchanged; QR rendering remains later work.
- **Verification:** frontend `npm.cmd run lint` clean; `npm.cmd test` passes
  (4 tests), including the FR-83c/f in-memory-token API test; `npm.cmd run build`
  succeeds (19 modules; 74.71 kB gzip JS). No frontend dependencies added.
- **Rows:** no additional specs checkbox ticked; UI/API behavior is not yet
  covered by browser-level tests.
- **Next:** Stage 8 development-only email outbox, seed and scripted smoke flow.

## Stage 8 — development demo harness

- **Implemented:** explicit non-production `DEV_FAKES=1` enables the durable
  worker email sender to append decrypted demo messages to an OS-temp JSONL
  outbox and mounts `GET/DELETE /api/dev/outbox`; neither is mounted/created
  with the flag off. Production rejects the flag. `demo:seed` writes local
  generated credentials to ignored `backend/.demo.env`, seeds a TOTP Admin,
  seller-candidate buyer, Lahore demo city, category/subcategory and required
  measurement field. Its target guard accepts only localhost database names
  containing `demo`, `dev`, or `local`, and rejects test targets. `demo:smoke`
  performs the API email-code/login/application/approval/authenticator/step-up/
  payout/identity/admin-view flow and checks the payout guard before/after ID.
- **Verification:** focused backend tests pass (5 suites / 25 tests), including
  outbox opt-in/prod rejection/temp-path containment, seed target guard,
  runtime fake configuration, and the outbox endpoint's absence without opt-in.
  Demo seed/smoke have not run against services yet; Stage 9 will report exact
  PostgreSQL/Redis availability and any blocked commands.
- **Files:** `src/lib/adapters/devEmailOutbox.js`, `src/routes/dev.routes.js`,
  `worker.js`, `app.js`, `config.js`, `scripts/demo-seed.js`,
  `scripts/demo-smoke.js`, package scripts, tests, `.env.example`, `.gitignore`,
  and `agent.md`.
- **Parked/live:** fake email outbox is not real delivery; manual Admin ID
  verification in the smoke flow is a development demonstration, not a real
  verification provider. Live checks remain in `LIVE_CHECKS.md`.
- **Next:** Stage 9 run the full suites, service-backed demo, HTTP checks, and
  both package audits/builds where the local environment permits.

## Stage 9 — run everything and show it (verification complete; live demo blocked)

- **Checks run:** backend `npm.cmd test -- --runInBand` — 38 suites / 439
  tests passed; PostgreSQL integration — 4 suites passed, 77 passed / 4 Redis
  tests skipped; `npm.cmd run db:check-schema` passed; backend production audit
  and frontend full audit each report 0 vulnerabilities. Frontend lint is clean,
  tests pass (4), and production build succeeds (19 modules; JS 74.71 kB gzip).
- **Machine:** PostgreSQL 18.6 service is running and local port 5432 responds.
  Redis is absent at 127.0.0.1:6379, and no Redis/psql/docker executable was
  found on PATH. `DEMO_DATABASE_URL`, `DATABASE_URL`, and `REDIS_URL` are not
  configured in the backend environment. Backend startup was attempted and
  stopped safely with `JWT_ACCESS_SECRET must contain at least 32 bytes of
  externally configured key material.` No development database migration or
  seed was attempted. The guarded integration suite used its `testing_only`
  database and passed.
- **What ran live:** Vite served `http://127.0.0.1:5173/` with HTTP 200 and the
  existing HTML title `frontend`. Backend HTTP/CORS and demo walkthrough could
  not run because startup configuration and Redis were unavailable. No demo
  transcript or demo account exists on this machine; exact setup commands,
  expected fake/real boundaries and observed output are in `DEMO_RUN.md`.
- **Earlier command correction:** one initial integration invocation omitted
  Jest's `--experimental-vm-modules` flag and failed while loading pg-boss; the
  correctly flagged full integration rerun passed. The known-mismatch suite's
  stale payout `42703` pin was updated to assert obsolete method validation;
  the valid payout API/leak test passes against PostgreSQL.
- **Rows:** FR-09a, FR-66, FR-83c/f, SEC-30/35 now have named passing unit and
  PostgreSQL tests. SEC-30 offline backup remains a live check. Redis-only
  concurrency checks remain skipped.
- **Next:** Stage 10 — document-only listing revision plan.

## Stage 10 — Phase 2 listing revision plan (document only)

- **Delivered:** `LISTING_REVISIONS_PLAN.md` proposes the side-copy design,
  illustrative table/status/index SQL, atomic approval guarded by
  `content_version`, rejection behavior, permissions and notifications,
  migration/rollback sequence, PostgreSQL concurrency tests, dependencies,
  bounded tasks, and owner questions with recommendations.
- **Scope:** no application code, schema, migration, specification checkbox,
  or product decision changed in this stage. The plan is explicitly proposed;
  FR-73b–d and field-scope questions remain subject to owner resolution.
- **Next:** Stage 11 — consolidate Phase 1 handoff and gate evidence, then run
  final checks and push the staged commits once.
