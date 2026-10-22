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
