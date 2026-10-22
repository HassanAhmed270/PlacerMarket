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
