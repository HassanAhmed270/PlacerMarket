# Phase 1 gate report

**Report date: 2026-10-22.** This report maps the dated Phase 1 implementation
backlog in `Phases.md` and the Phase 1 stages in `PHASE1_PROGRESS.md`. It is an
evidence and handoff report, not a claim that every broader Phase 1/Phase 0
release gate is closed. Unfinished requirements remain unchecked in `specs.md`
and `security.md`. The local demo walkthrough could not run because its required
development database URL, valid JWT secret, and Redis service are unavailable.

## Backlog map

| Phase 1 item | Status | Evidence / remaining work |
|---|---|---|
| Seller application contract: profile name/phone/verified city; application stores reason and items-to-sell only | Done | `specs.md` FR-06; named PostgreSQL integration test in `test/integration/known-mismatches.test.js`; Stage 1 in `PHASE1_PROGRESS.md`. |
| Atomic seller approval/revocation role and profile state | Done | `specs.md` FR-07/FR-10; approval success, rollback, rejection and suspension PostgreSQL tests; Stage 1. |
| Seller application review placement under Admin → Users | Parked | `specs.md` FR-07b remains unchecked. API review exists; the exact frontend sub-tab placement is not implemented/evidenced. |
| Flexible measurement fields: required/active migration, administration and enforcement | Done | Migration `006_measurement_field_lifecycle.sql`; named PostgreSQL tests under FR-15a/FR-15d in `specs.md`; schema check passed; Stage 2. |
| Bank/Easypaisa/JazzCash payout mapping and protected detail writes | Done | `specs.md` FR-09a; unit tests for bank and both wallet methods, validation/masking/encryption, and PostgreSQL API/leak regression; Stage 6/9. |
| Payout encryption, versioned key provider and rotation command | Implemented; live custody/rotation check pending | Migration `007_payout_encryption_envelope.sql`; `test/unit/payout-encryption.test.js`; backend production dependency audit reports zero vulnerabilities. Offline key backup and a real rotation exercise remain in `LIVE_CHECKS.md`. |
| Authenticator enrollment gate before payout-detail writes | Done | `specs.md` FR-83c; enrollment-only session, TOTP, backup-code and PostgreSQL payout-gate tests; Stage 5/6. |
| Step-up protection, payout-change notice and Admin recent-change/hold visibility | Done | `specs.md` FR-83f, FR-09a and `security.md` SEC-35; named unit/PostgreSQL coverage; Stage 5/6/9. Real Redis rate-limit concurrency remains a live check. |
| Step-up grants, new-device notice, and single-use backup codes | Done for implemented scope | FR-83c/f integration coverage and `PHASE1_PROGRESS.md` Stage 5; fresh factor is action/session bound. Device list/revoke UI is explicitly deferred. |
| Manual seller identity verification and audit fields; no stored CNIC/document | Done | Migration `008_manual_identity_verification.sql`; FR-66/66a unit and PostgreSQL tests; `security.md` SEC-30; Stage 4/9. The owner’s manual operational procedure remains in `LIVE_CHECKS.md`. |
| First-payout identity guard and payout hold conditions | Done | FR-66 and FR-83l named settlement unit/PostgreSQL coverage; Stage 6/9. Manual recovery workflow exercise remains a live check. |
| FR-83k/FR-83l recovery policy and payout pause | Policy decided; implementation parked | Decision is recorded in `open-questions.md` and `specs.md`; the 24-hour Admin-only recovery, notices, session revocation, factor reset and payout pause/resolution workflow is not implemented. Manual owner-only procedure applies meanwhile. |
| Strictly-above-threshold email verification | Implemented and PostgreSQL-tested for current listing approval flow | `specs.md` FR-08a/08b/19b; named threshold/equality tests in `test/integration/known-mismatches.test.js`; email state remains separate from `id_verified`. Phase 2 revision approval must recheck threshold and registered-email state. |
| Seller/Admin account workspace | Implemented; browser-level check pending | Stage 7 in `PHASE1_PROGRESS.md`; `frontend` lint, 4 tests and build passed. No browser automation was run. |
| Development walkthrough harness | Implemented; service-backed demo blocked | `DEMO_RUN.md`; seed/smoke scripts are guarded and fake mail outbox is opt-in/non-production. Stage 9 could not run them because no development database URL/valid JWT secret/Redis. No demo account or transcript is claimed. |

## Verification evidence

- Backend unit suite: 38 suites, 441 tests passed (`npm.cmd test -- --runInBand`).
- PostgreSQL integration suite: 4 suites passed, 77 tests passed, 4 Redis-only
  tests skipped. A focused payout/identity PostgreSQL regression passed after
  the IBAN checksum change. Test database was the guarded local `testing_only`
  target.
- `npm.cmd run db:check-schema` passed.
- Backend production dependency audit and frontend dependency audit each
  reported zero vulnerabilities.
- Frontend lint passed, frontend tests passed (4), and production build passed
  (19 modules; 74.71 kB gzip JS).
- Vite returned HTTP 200 at `http://127.0.0.1:5173/`. This only verifies the
  frontend dev server; backend startup, CORS and the walkthrough were not
  verified. Backend startup correctly refused to run because
  `JWT_ACCESS_SECRET` lacked 32 bytes of configured key material.
- No live credentials are included in this report. See `DEMO_RUN.md` and
  `LIVE_CHECKS.md` for exact commands, boundaries and outstanding checks.

## Release-gate residuals

Phase 1 must not be described as a fully closed release gate yet. Among other
items, FR-07b is open; several catalog/listing and frontend rows remain
unchecked; SEC-11/12/13 and SEC-34 remain unchecked; FR-83k/83l recovery is not
implemented; real Redis concurrency, provider delivery, deployment secrets,
key custody/rotation, hosted CI, and browser-level checks are pending. These
are tracked in `specs.md`, `security.md`, `LIVE_CHECKS.md`, and `Phases.md`.
The approved implementation stages and local checks are complete as recorded;
the blocked local demo is not represented as a successful live walkthrough.

## Next actions

1. Provision a local development database URL, valid development JWT secret,
   and Redis endpoint without placing credentials in source control; run the
   documented guarded seed and smoke flow.
2. Close or explicitly defer the unchecked Phase 1 functional, frontend and
   security rows with owner decisions; implement the approved recovery workflow.
3. Complete the live checks in `LIVE_CHECKS.md` before real-user exposure.
4. Resolve the questions in `LISTING_REVISIONS_PLAN.md` before Phase 2 code or
   migrations. That document is proposed design only and does not authorize
   implementation.
