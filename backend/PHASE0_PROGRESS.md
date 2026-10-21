# Phase 0 progress

Resume at the first incomplete stage. Completed stages are not repeated.

## Stage 0 — PREFLIGHT + RECORD — complete (2026-10-21)

- **Files:** `.gitignore`, `backend/AGENTS.md`, `DEVELOPMENT_HANDOFF.md`,
  `HANDOFF.md`, `LIVE_CHECKS.md`, `MASTER_PROJECT_CONTEXT.md`, `Phases.md`,
  `README.md`, `agent.md`, `open-questions.md`, `security.md`, `specs.md`,
  `src/modules/users.service.js`, `src/modules/listings.service.js`,
  `test/integration/known-mismatches.test.js`.
- **Migrations:** none. No schema changed.
- **Threshold correction:** `users.isIdVerificationRequired` and
  `listings.getModerationQueue` now use strictly greater than the configured
  threshold. The integration test named `FR-08a: email verification is required
  strictly above the configured threshold` verifies equality and threshold + 1
  for both the service result and moderation-queue flag.
- **Verification:** `npm.cmd test -- --runInBand` — 24 suites, 279 tests passed;
  `npm.cmd run test:integration` — 4 suites, 59 tests passed on PostgreSQL 18.6;
  `npm.cmd run db:check-schema` — passed; frontend `npm.cmd run lint` — passed,
  `npm.cmd test` — 2 tests passed, `npm.cmd run build` — passed; backend and
  frontend `npm.cmd audit --omit=dev` — 0 vulnerabilities each.
- **Fix-pass commit:** `cf5cfee chore: complete Phase 0 fix-pass validation`.
  It contains the verified fix-pass source/docs only. The two decision-document
  files were not included or edited.
- **Parked:** FR-83k recovery after loss of all factors (factor reset, replacement,
  bypass authority and delay); FR-83b passkey fallback behavior; FR-83c seller
  factor requirements; FR-83f step-up/device/backup-code policy. The 72-hour
  payout lock, 24-hour recovery delay, and listing-revision lifecycle names remain
  unapproved proposals. First-admin TOTP enrollment is already confirmed by FR-84.
- **Provisional assumptions:** none.
- **Live checks added:** `LIVE_CHECKS.md` records provider delivery/failover,
  challenge verifier, production credentials, staff TOTP key, deployed cookie/
  origin behavior, and PgBouncer checks. No live provider credentials were used.
- **Next:** Stage 1 — CONFIG FOUNDATION.

## Stage 1 — CONFIG FOUNDATION — complete (2026-10-21)

- **Files:** `.env.example`, `src/config.js`, `src/server.js`,
  `src/lib/adapters/emailSender.js`, `src/lib/adapters/challengeVerifier.js`,
  `test/unit/config.test.js`, `test/unit/credential-adapters.test.js`,
  `test/unit/server.test.js`, `DEVELOPMENT_HANDOFF.md`,
  `MASTER_PROJECT_CONTEXT.md`, `Phases.md`, `README.md`, `agent.md`,
  `open-questions.md`, `security.md`.
- **Migrations:** none.
- **Verification:** `npm.cmd test -- --runInBand` — 26 suites, 290 tests passed;
  `npm.cmd run test:integration` — 4 suites, 59 tests passed on PostgreSQL 18.6;
  `npm.cmd run db:check-schema` — passed. Targeted config/adapter/server run:
  3 suites, 14 tests passed before the full suite.
- **Parked:** FR-83k, FR-83b, FR-83c, and FR-83f remain security-critical
  decisions. Email and challenge live providers are not selected.
- **Provisional assumptions:** general limiter defaults and Argon2id starting
  parameters/pool cap are documented in `open-questions.md`; Stage 2 benchmark
  will choose hash parameters.
- **Live checks:** provider credential and delivery checks remain listed in
  `LIVE_CHECKS.md`.
- **Next:** Stage 2 — PASSWORDS + REGISTRATION.

## Stage 2 — PASSWORDS + REGISTRATION — complete (2026-10-21)

- **Files:** `package.json`, `package-lock.json`, `.env.example`,
  `db/migrations/003_auth_foundation.sql`, generated `schema.sql`,
  `scripts/benchmark-argon2.js`, `src/config.js`, `src/lib/authValidation.js`,
  `src/lib/passwordHashPool.js`, `src/lib/passwordHashWorker.js`,
  `src/modules/users.service.js`, `src/routes/users.routes.js`, unit/smoke/
  integration tests for auth and migrations, `DEVELOPMENT_HANDOFF.md`,
  `LIVE_CHECKS.md`, `MASTER_PROJECT_CONTEXT.md`, `Phases.md`, `README.md`,
  `open-questions.md`, `security.md`, and `specs.md`.
- **Migrations:** `003_auth_foundation.sql` (expand-only): user email/password
  timestamps and `auth_sessions`, `email_login_codes`, `password_reset_tokens`,
  and `staff_totp_credentials` tables. Snapshot regenerated; `db:check-schema`
  passed.
- **Verification:** backend unit 27 suites / 295 tests passed; PostgreSQL
  integration 4 suites / 60 tests passed on PostgreSQL 18.6; `npm audit
  --omit=dev` found 0 vulnerabilities. `npm run password:benchmark` selected
  65,536 KiB / t=3 / p=1 (213 ms median; three repetitions; target 250 ms).
- **Rows ticked:** FR-01 (buyer registration). SEC-01 has passing hash/response
  tests but remains unticked until production TLS hosting is verified. SEC-16
  remains unticked because route validation is not complete across all API routes.
- **Parked:** FR-83k, FR-83b, FR-83c, FR-83f; login/session issuance remains
  for later Phase 0 stages; email/challenge providers remain live-check pending.
- **Provisional assumptions:** general rate-limit limits, worker-pool cap 4,
  12–128 character password length, and E.164 phone validation are recorded in
  `open-questions.md`. The benchmark reflects this development machine only.
- **Live checks:** repeat Argon2 benchmark on production-sized host and verify
  memory headroom/saturation; other provider checks remain in `LIVE_CHECKS.md`.
- **Next:** Stage 3 — RATE LIMITS.

## Stage 3 — RATE LIMITS — implementation complete; Redis integration pending (2026-10-21)

- **Files:** `src/lib/redis.js`, `src/middleware/rateLimit.js`,
  `src/routes/users.routes.js`, `src/routes/negotiation.routes.js`,
  `test/unit/rate-limit.test.js`, `test/integration/rate-limit.test.js`, smoke
  tests, `.env.example`, `LIVE_CHECKS.md`, `MASTER_PROJECT_CONTEXT.md`,
  `DEVELOPMENT_HANDOFF.md`, `README.md`, `open-questions.md`, `security.md`,
  `specs.md`, and this checkpoint.
- **Migrations:** none.
- **Behavior:** atomic Redis Lua fixed-window counters enforce IP/account limits
  on signup/login and existing offer/message writes. Redis failure returns 503;
  429 responses are generic. Reset limiter and email-code IP challenge signal
  are exposed for their upcoming routes. The challenge signal does not block.
- **Verification:** `npm.cmd test -- --runInBand` — 28 suites, 300 tests passed;
  `npm.cmd run db:check-schema` — passed; integration run with the local `.env`
  loaded — 4 suites / 60 tests passed on PostgreSQL 18.6, with the real-Redis
  limiter suite skipped because `TEST_REDIS_URL` and a Redis service are absent.
  Do not mark SEC-08, SEC-24, or FR-84b complete based on the unit fake.
- **Rows ticked:** none. SEC-08, SEC-24 and FR-84b remain unticked until missing
  routes and real Redis integration evidence are complete.
- **Parked:** FR-83k, FR-83b, FR-83c, FR-83f as recorded above; no new security
  decision was needed.
- **Provisional assumptions:** configurable hourly limits remain provisional;
  fixed-window counter behavior is documented in `open-questions.md`.
- **Live checks added:** production Redis concurrency, eviction/failover, and
  trusted proxy IP forwarding added to `LIVE_CHECKS.md`.
- **Next:** Stage 4 — EMAIL + VERIFICATION (with the Redis test prerequisites
  still to be supplied for final verification).

## Stage 4 — EMAIL + VERIFICATION — implementation complete; provider/Redis checks pending (2026-10-21)

- **Files:** `db/migrations/004_email_code_purpose.sql`, generated `schema.sql`,
  `.env.example`, `src/config.js`, `src/lib/emailQueuePayload.js`,
  `src/lib/emailCodeDelivery.js`, `src/lib/queue.js`, `src/modules/users.service.js`,
  `src/modules/listings.service.js`, `src/routes/users.routes.js`, `worker.js`,
  email/code/queue/config/worker and real-Postgres integration tests, plus
  `agent.md`, `open-questions.md`, `specs.md`, `security.md`, `LIVE_CHECKS.md`,
  `README.md`, `MASTER_PROJECT_CONTEXT.md`, `DEVELOPMENT_HANDOFF.md`, and this file.
- **Migrations:** `004_email_code_purpose.sql` adds a purpose discriminator and
  one-active-address-verification constraint to `email_login_codes`; snapshot
  regenerated through the ordered migration generator.
- **Behavior:** email verification uses configurable six-digit, five-minute,
  single-use codes; HMAC hashes and HMAC address digests; three attempts per
  code; atomic 60-second resend, 5/hour and 10/day address caps; and a
  configurable 10-failures/hour, 15-minute lock. Unknown addresses get the same
  accepted API response and message type. Email content is AES-GCM encrypted in
  pg-boss, then decrypted by the email worker. Email proof never sets seller ID
  verification; it gates high-value listing approval only.
- **Verification:** `npm.cmd test -- --runInBand` — 30 suites / 322 tests passed;
  integration with `.env` loaded — 4 suites / 63 tests passed on PostgreSQL
  18.6; real-Redis limiter suite skipped because `TEST_REDIS_URL` is absent;
  `npm.cmd run db:check-schema` — passed. Tests include `FR-83d` code hashing,
  queue encryption, resend caps, attempts/lock, route anti-enumeration,
  concurrent single-use confirmation, and FR-08a/FR-19b approval behavior.
- **Rows ticked:** FR-08a and FR-19b, justified by the two named passing
  PostgreSQL integration tests above. FR-83a/FR-83d remain unticked because
  `authenticate()` does not yet invoke the login-attempt-bound code methods,
  and real Redis verification is still pending.
- **Parked:** FR-83k, FR-83b, FR-83c, FR-83f; no new security-critical choice
  was needed. Live email provider selection and delivery remain pending.
- **Provisional assumptions:** general hourly limits and pool cap remain
  provisional; email-code limits and durations are owner-approved and configurable.
- **Live checks added:** select/test real provider and verify encrypted-key
  rotation, queue retry/failure behavior, Redis concurrency and deployed proxy.
- **Next:** Stage 5 — LOGIN + SESSIONS.

## Stage 5 — LOGIN + SESSIONS — implementation complete; live checks pending (2026-10-21)

- **Files:** `src/config.js`, `src/lib/jwt.js`, `src/lib/totp.js`,
  `src/middleware/auth.js`, `src/middleware/rateLimit.js`,
  `src/modules/users.service.js`, `src/routes/users.routes.js`,
  migration `005_staff_totp_replay_guard.sql`, generated `schema.sql`, and
  auth/TOTP/config/migration unit and PostgreSQL integration tests.
- **Migrations:** `005_staff_totp_replay_guard.sql` stores the last accepted
  TOTP time step to prevent replay; schema snapshot regenerated.
- **Behavior:** buyer login verifies Argon2id then sends an attempt-bound email
  code; staff login requires password plus encrypted TOTP. Access JWTs use
  pinned HS256, issuer/audience/expiry and a durable session ID. Refresh cookies
  are Secure/HttpOnly/SameSite=Strict and scoped to refresh; refresh rotates
  hashed tokens, enforces absolute and idle limits, and reuse revokes the family.
  Logout revokes the current family. Every bearer request rechecks session,
  suspension and role state in PostgreSQL.
- **Verification:** full backend unit suite — 32 suites / 335 tests passed at
  this checkpoint; full PostgreSQL integration suite — 4 suites / 67 tests
  passed, one real-Redis suite skipped because local `TEST_REDIS_URL` is absent.
  Focused auth route/TOTP/JWT/config/migration run — 7 suites / 29 tests passed;
  `db:check-schema` passed. Final counts are recorded in
  `PHASE0_GATE_REPORT.md`.
- **Rows ticked:** FR-84a and SEC-03/04/05/07/38 have named passing tests.
  SEC-02 remains unticked pending a reviewed key-rotation
  runbook; SEC-08/24 remain unticked pending real Redis and broader scope.
- **Parked:** FR-83k recovery after loss of factors; FR-83b passkey fallback;
  FR-83c seller factor policy; FR-83f step-up/device/backup rules.
- **Live checks:** email/challenge provider delivery, deployed refresh-cookie and
  Origin behavior, staff TOTP key management, production TLS and real Redis.
- **Next:** Stage 6 — FORGOT-PASSWORD.

## Stage 6 — FORGOT-PASSWORD — implementation complete; email provider pending (2026-10-21)

- **Files:** `src/modules/users.service.js`, `src/lib/emailCodeDelivery.js`,
  `src/lib/authValidation.js`, `src/routes/users.routes.js`, config and
  `.env.example`, reset route/service/integration tests.
- **Migrations:** none; uses `password_reset_tokens` from
  `003_auth_foundation.sql`.
- **Behavior:** reset requests return the same 202 response for known/unknown
  addresses. Tokens are random, single-use and stored only as SHA-256 digests;
  expiry is configurable with a 30-minute default. Success hashes the new
  password, consumes the token, revokes all sessions and queues a notice.
- **Verification:** FR-83g PostgreSQL integration test exercises concurrent
  reuse, password replacement, session revocation and notification enqueue;
  route tests cover uniform response and strict body allowlists. Full backend
  suites recorded in the final report.
- **Provisional:** 30-minute expiry is owner-approved as a configurable value;
  general reset rate-limit defaults remain provisional.
- **Live check:** deliver reset and password-change emails through selected
  providers; check retry/failover.
- **Next:** Stage 7 — ADMIN BOOTSTRAP.

## Stage 7 — ADMIN BOOTSTRAP — implementation complete; deployment key pending (2026-10-21)

- **Files:** `scripts/create-admin.js`, `package.json`,
  `src/modules/users.service.js`, `src/lib/totp.js`, and PostgreSQL integration
  coverage.
- **Migrations:** none beyond migration 005.
- **Behavior:** `npm run admin:create` prompts for account details, requires
  the operator to enroll and confirm an authenticator code, hashes the password
  with the bounded Argon2id pool, encrypts TOTP material at rest, and uses an
  advisory transaction lock to make bootstrap one-time even under concurrency.
  No endpoint or default credential exists.
- **Verification:** named FR-84/SEC-09/10 PostgreSQL test proves encrypted
  enrollment and rejects rerun. Full backend integration result is in final
  report.
- **Rows ticked:** SEC-09/10, with tests named in the preceding bullet.
- **Live check:** provision `STAFF_TOTP_ENCRYPTION_SECRET` through the hosting
  secret store and complete first-admin enrollment on the deployed database.
- **Next:** Stage 8 — HARDENING AUDIT.

## Stage 8 — HARDENING AUDIT — verified items ticked; remaining scope recorded (2026-10-21)

- **Evidence:** JWT tests name SEC-02/03; auth routes and frontend transport test
  SEC-04/05; PostgreSQL suspension/session tests name SEC-07; Redis unit tests
  name SEC-08 but the real Redis test is skipped locally; auth and reset route
  validators reject extra fields; smoke tests name SEC-16/25; CORS and error
  handler tests name SEC-22/28; session integration tests name SEC-38.
- **Rows ticked:** SEC-03/04/05/07/09/10/22/23/25/28/38 only. SEC-02 awaits a
  reviewed key-rotation plan, SEC-08/24 await local/hosted real Redis evidence,
  SEC-01 awaits production TLS, SEC-16/27/29 require broader API audit evidence.
  SEC-15 remains a review-only audit item.
- **Next:** Stage 9 — FRONTEND.

## Stage 9 — FRONTEND — auth screens implemented; real provider checks pending (2026-10-21)

- **Files:** `frontend/src/App.jsx`, `src/App.css`, `src/lib/api.js`, API tests,
  `vite.config.js`, and `.env.example`.
- **Behavior:** login supports buyer email code and staff TOTP, registration,
  forgot/reset password, bearer requests and cookie-only refresh. Access tokens
  remain in React memory. The existing public catalog page remains unchanged.
  An explicit `VITE_AUTH_MOCK=true` development mock is labeled in the UI;
  production builds refuse that setting.
- **Verification:** frontend lint passed; 3 Node tests passed; production Vite
  build passed. Audit found 0 production vulnerabilities.
- **Live check:** exercise login, email delivery, refresh and deep links against
  deployed frontend/API origins; provider challenge widget integration remains
  pending with provider selection.
- **Next:** Stage 10 — CI.

## Stage 10 — CI — workflow added; hosted run pending (2026-10-21)

- **Files:** `.github/workflows/phase0.yml`.
- **Behavior:** GitHub Actions provisions PostgreSQL 18 and Redis, runs backend
  unit/integration/schema/audit jobs and frontend lint/test/build/audit jobs.
- **Verification:** equivalent local suites passed except the real Redis suite
  (skipped because the local environment has no Redis service). The GitHub-hosted
  workflow has not run from this workspace; report any earlier hosted failure
  as unverified because no hosted logs are available.
- **Next:** Stage 11 — FINAL GATE REPORT.
