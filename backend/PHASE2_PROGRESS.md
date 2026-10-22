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
