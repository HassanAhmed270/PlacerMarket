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
