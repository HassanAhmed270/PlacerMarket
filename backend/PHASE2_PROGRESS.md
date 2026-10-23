# Phase 2 progress

Resume at the first incomplete stage. Do not repeat completed stages.

## Stage 0 — FIX PASS — complete (2026-10-23)

- **Files:** `scripts/demo-seed.js`, `scripts/demo-smoke.js`,
  `src/modules/users.service.js`, `src/middleware/auth.js`,
  `src/routes/users.routes.js`, `src/server.js`, `worker.js`,
  `test/unit/demo-seed.test.js`, `test/unit/users.auth.routes.test.js`,
  `test/unit/users.service.test.js`, `test/unit/worker.test.js`,
  `frontend/index.html`, `frontend/src/AccountWorkspace.jsx`, `DEMO_RUN.md`,
  `agent.md`, `open-questions.md`, `specs.md`, `security.md`, and this file.
- **Migrations:** none.
- **Changes:** sellers without TOTP now need password plus the same email-code
  login factor as buyers before getting an enrollment-only session; an ordinary
  session receives a clear sign-in-again error for authenticator setup. The demo
  env writer preserves JSON for Node's env-file parser, and the smoke flow signs
  in again after seller approval. Production worker startup validates payout
  keys and the server logs the safe validation error. The frontend page title is
  Poshaak. Existing strict threshold and email-versus-identity regressions were
  confirmed present.
- **Verification:** backend unit suite: 38 suites / 445 tests passed. Targeted
  Stage 0 suite: 5 suites / 39 tests passed. Frontend lint passed, frontend test
  passed (4 tests), frontend build passed. `npm audit --omit=dev`: 0
  vulnerabilities. `git diff --check` passed.
- **Integration baseline:** not run because `TEST_DATABASE_URL` is unset; the
  integration harness refuses to start without it. `TEST_REDIS_URL` is also
  unset. No integration result is claimed for this stage.
- **Parked:** Phase 2 implementation stages 1–7; PostgreSQL and Redis
  integration; hosted and production live checks; demo run remains pending the
  local database, Redis, and app configuration listed in `DEMO_RUN.md`.
- **Provisional assumptions:** none introduced.
- **Live checks:** none executed; see `LIVE_CHECKS.md`.
- **Git:** started on `main` at `1e53551`; preserved the two pre-existing
  staged/deleted `.docx` files outside the stage commit.
- **Next:** Stage 1 — listing core repairs.

## Stage 1 — LISTING CORE REPAIRS — complete (2026-10-23)

- **Files changed:** `src/modules/listings.service.js`,
  `src/modules/discovery.service.js`, `src/routes/listings.routes.js`,
  `test/unit/listings.service.test.js`,
  `test/integration/known-mismatches.test.js`, `SCHEMA_CODE_AUDIT.md`,
  `specs.md`, `open-questions.md`.
- **Migrations:** none; the listing schema supports these changes.
- **Changes:** title and create-payload validation; measurement
  definition resolution by exact name or ID with active/required checks;
  reviewer attribution; immediate pause/resume/removal; edit rejection for
  previously published records; seller-city filtering; public `display_alias`;
-  stricter queue threshold coverage. Retired the held-pending helper and route.
- **Verification:** backend unit suite: 38 suites / 450 tests passed. Backend
  integration: 4 suites passed, 83 tests passed, 4 skipped; one Redis-dependent
  suite skipped because `TEST_REDIS_URL` is unset. `git diff --check` passed.
- **Parked:** Phase 2 Stages 2–7 remain unstarted.
- **Provisional assumptions:** none. The task explicitly selects seller
  registered city for `cityId` and requests `display_alias` on the public card;
  these are recorded in `open-questions.md` and `specs.md`.
- **Live checks:** none executed.
- **Next:** Stage 2 — storage adapter and media.

## Stage 2 — STORAGE ADAPTER + MEDIA — complete (2026-10-23)

- **Files:** `db/migrations/011_listing_media.sql`, generated `schema.sql`,
  `src/lib/storage/` (local-disk and explicit fake adapters),
  `src/modules/media.service.js`, `src/routes/media.routes.js`, route/app and
  worker wiring, runtime media signing-secret validation, `sharp@0.35.5`,
  unit and PostgreSQL media tests, `agent.md`, and `LIVE_CHECKS.md`.
- **Migrations:** 011 expands `listing_images` for slots, processing state,
  private original and variant keys, content hash, and moderation audit fields.
- **Changes:** API upload accepts JPEG/PNG only after magic-byte validation,
  uses random private original keys, enforces a Redis-backed 20-per-day seller
  cap and 5 MiB body limit, and enqueues idempotent pg-boss work in the row
  transaction. The worker strips metadata by re-encoding into watermarked WebP
  thumbnail/medium/large/social files. Public reads require a published row
  and immutable variant hash; owner signed reads expire within five minutes.
  `sharp@0.35.5` is exact-pinned after its 2026-10-04 publish date and its
  production dependency audit reported zero vulnerabilities.
- **Verification:** focused media/config/worker unit suites passed 16 tests;
  schema snapshot generation and `db:check-schema` passed. Full PostgreSQL run
  after Stage 2/3 implementation: 4 suites passed, 85 tests passed, 4 skipped;
  one Redis-dependent suite remains skipped without `TEST_REDIS_URL`. The
  standalone upload test processes a real PNG and verifies public/private read
  behavior. The full backend unit suite is being rerun after fixes to the
  migration inventory and slot mocks.
- **Parked:** production durable/shared media backend selection and CDN/live
  checks; S3/KMS code remains excluded. Direct-to-storage upload is deferred;
  current API upload path is provisional per the task.
- **Provisional assumptions:** daily cap is 20 uploads per seller per 24-hour
  Redis window; root defaults to a local directory outside the web root.
- **Live checks:** production media storage provisioning is unchecked in
  `LIVE_CHECKS.md`.
- **Next:** Stage 3 — photo moderation.

## Stages 3-5 — moderation, revisions, workspace — implemented (2026-10-23)

- **Stage 3:** required photo slots and moderator confirmation/rejection are
  implemented in the listing service and API. Evidence: passing PostgreSQL
  integration tests `FR-74a, SEC-12: photo moderation confirms labels, records
  reviewer, and denies seller BOLA` and listing submission/approval checks.
- **Stage 4:** migration 012, listing revision service/routes, one-pending
  constraint, atomic approval, threshold recheck and public live-row behavior
  are implemented. The schema table-count test was updated in the same
  checkpoint as migration 012. Evidence: `npm run test:integration` passed
  `test/integration/revisions.test.js`, including concurrent submission and
  transition, rollback, threshold, and public privacy cases. Production
  `LISTING_REVISIONS_ENABLED` defaults off; enablement requires the explicit
  value `1`.
- **Stage 5:** seller listing and moderator workspace screens are implemented.
  Evidence: frontend lint, 5 frontend tests, and Vite production build passed.
- **Parked:** cached content-version reads (FR-73a), tagged FR-73b-d, direct to
  storage uploads/CDN (FR-74d), optional media/video/story scope, and live
  production storage/CORS checks. Frontend Phase 2 gap-analysis rows remain
  unchecked because they do not yet have passing tests naming the UI behavior.

## Stage 6 — demo — complete locally (2026-10-23)

- `scripts/demo-smoke.js` now exercises registration/email confirmation and
  re-login after seller approval, generated PNG uploads to all three required
  slots, worker variants, moderator photo confirmation and listing approval,
  safe public detail, above-threshold unverified-email refusal, a concurrent
  double-submit, unchanged pending public content, and approved price/version
  update. It prints no secret, code, or storage key.
- **Machine verification:** used the final `.env` `DATABASE_URL` (localhost,
  database `poshaak_demo`) and `JWT_ACCESS_SECRET`; neither value is printed.
  Migrations 001–012, `db:seed`, and `demo:seed` completed. Redis at
  `127.0.0.1:6379` was reachable; API and worker started. Vite routes returned
  HTTP 200 and the API CORS preflight returned 204 with the configured Vite
  origin. The full 14-step smoke passed using Redis logical DB 2 to avoid the
  existing hourly counters in DB 0. Transcript is in `DEMO_RUN.md`.
- **Suite results:** backend unit 39 suites/487 passed; focused media unit test
  1 suite/4 passed. Integration passed 7 suites/98 tests with guarded
  `TEST_DATABASE_URL` and local `TEST_REDIS_URL`. `db:check-schema`, frontend
  lint, 5 frontend tests and build passed. Both production-only audits
  returned 0 vulnerabilities. Full backend audit reported 28 high-severity
  findings in the Jest 29 dev chain; full frontend audit returned 0. Owner-
  triaged findings remain non-blocking under SEC-31.

## Stage 7 — docs and gate — recorded (2026-10-23)

- Updated `agent.md`, `open-questions.md`, `specs.md`, `security.md`,
  `Phases.md`, `LIVE_CHECKS.md`, `MASTER_PROJECT_CONTEXT.md`,
  `DEVELOPMENT_HANDOFF.md`, `DEMO_RUN.md`, and the revisions plan status.
- `PHASE2_GATE_REPORT.md` maps every Phase 2 backlog item to evidence, parked,
  live-check pending, or deferred. Phase 2 gate remains open; no release or push
  is claimed. Git history already contains a combined Stage 2-5 checkpoint and
  two earlier Phase 2 commits; no history rewrite was performed. The two
  deleted `.docx` worktree entries remain excluded.
- **SEC-31:** owner decision dated 2026-10-22 recorded: retain Jest 29 through
  Phase 2; its 33 dev advisories are triaged and do not stop work. A nonzero
  production audit (`npm audit --omit=dev`) in either package is the only
  dependency stop condition. Jest 29 -> 30 is queued right after Phase 2.
- **Next:** finish remaining hosted-provider, production storage/secrets, and
  UI behavior evidence before evaluating the Phase 2 gate.
