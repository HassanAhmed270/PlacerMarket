# Phase 0 gate report

**Date:** 2026-10-21  
**Current phase:** Phase 0 (unchanged)  
**Gate status:** implementation stages 0–10 are complete. Phase 0 is not release-ready because real Redis, live providers, production hosting checks, several security rows, and the hosted CI run still need evidence.

## Gate items from `Phases.md`

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Backend 0a, 0b, 0c, with real PostgreSQL integration tests | **Partial** | Backend unit and PostgreSQL integration suites pass locally; 2 Redis integration tests were skipped because no local Redis service was available. Remaining unchecked Phase 0 security rows are listed below. |
| Frontend scaffold and login flow | **Done locally** | Login supports buyer email code and staff TOTP; registration, forgot/reset, in-memory access token and cookie refresh are implemented. Lint, tests and production build pass. The existing public catalog page was left intact. |
| Security rows listed by the Phase 0 gate | **Partial** | Ticked rows with named evidence: SEC-03/04/05/07/09/10/22/23/25/28/38. Other security rows remain unticked; see `security.md`. |
| Owner decisions | **Implemented or explicitly parked** | Approved FR-83d/84b/83g/84a values and scope are implemented. FR-83b/c/f/k and Phase 6 WAF remain parked. |
| Unit/integration suites and production dependency audits | **Local pass, Redis partial** | Unit suite and all available PostgreSQL integration suites pass. Real Redis tests were skipped locally. Both production dependency audits report zero vulnerabilities. |

## Stage completion

| Stage | Status | Evidence |
|---|---|---|
| 0. Preflight and record | Done | Owner decisions and strict `>` threshold are recorded; fix-pass commit exists. |
| 1. Configuration foundation | Done | Production configuration validation, environment settings and explicit fake adapter opt-in. |
| 2. Passwords and registration | Done | Bounded Argon2id worker pool, benchmark script, validation, migration 003. |
| 3. Rate limits | Implemented; real Redis check pending | Redis Lua limiters cover signup/login/reset and offer/message writes; email code send counters are atomic. Local Redis integration tests skipped. |
| 4. Email and verification | Implemented; provider check pending | Encrypted pg-boss email payloads, address verification, login-factor code services and high-value email gate. No live provider has been selected. |
| 5. Login and sessions | Done in code | Buyer email factor, staff TOTP, strict JWT, secure refresh cookie, rotation/reuse family revocation, logout and current suspension checks. |
| 6. Forgot password | Done in code | Uniform request response, hashed single-use token, configurable 30-minute default, password update, session revocation and queued notice. |
| 7. Admin bootstrap | Done in code | Interactive `npm run admin:create`, Argon2id password, confirmed TOTP, encrypted secret and advisory-locked one-time creation. |
| 8. Hardening audit | Partial | Evidence-backed rows are ticked; broader API authorization/input/logging and deployment controls remain unchecked. |
| 9. Frontend | Done locally | Account routes, buyer/staff factors and reset views; mock is explicit, labeled, and production builds reject it. |
| 10. CI | Workflow added | `.github/workflows/phase0.yml` runs PostgreSQL 18 and Redis jobs plus frontend checks. GitHub-hosted workflow has not run from this workspace. |
| 11. Final gate report | Done | This report records local results and open gates. |

## Database migrations

- `003_auth_foundation.sql` — auth timestamps, refresh sessions, email codes, password reset tokens and staff TOTP credentials.
- `004_email_code_purpose.sql` — distinguishes login and address-verification codes and constrains active verification codes.
- `005_staff_totp_replay_guard.sql` — stores the last accepted TOTP step to prevent code replay.

The schema snapshot was regenerated and `npm run db:check-schema` passed.

## Exact local commands and results

### Backend unit tests

Command:

```text
npm.cmd test -- --runInBand
```

Raw Jest result:

```text
Test Suites: 32 passed, 32 total
Tests:       348 passed, 348 total
Snapshots:   0 total
```

### Backend integration tests

Command (loads the workspace `.env` so `TEST_DATABASE_URL` is available):

```text
node --env-file-if-exists=.env --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --config test/integration/jest.config.js
```

Raw Jest result:

```text
Integration database: PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit
Test Suites: 1 skipped, 4 passed, 4 of 5 total
Tests:       2 skipped, 67 passed, 69 total
```

The skipped suite contains the two real-Redis concurrency tests, including the email-code address cap. `TEST_REDIS_URL` and a local Redis service were unavailable. PostgreSQL integration tests cover auth registration, one-use email codes, concurrent refresh reuse, staff TOTP replay prevention, reset-token reuse, one-time admin bootstrap, suspension checks, and existing marketplace behavior.

### Schema snapshot

Command:

```text
npm.cmd run db:check-schema
```

Raw output:

```text
> poshaak-backend@0.1.0 db:check-schema
> node db/generate-schema-snapshot.js --check
```

Exit status: 0.

### Production dependency audits

Commands: `npm.cmd audit --omit=dev` from `backend/` and `frontend/`.

Raw output for each package:

```text
found 0 vulnerabilities
```

### Frontend checks

Commands: `npm.cmd run lint`, `npm.cmd test`, and `npm.cmd run build` from `frontend/`.

Raw lint output:

```text
> frontend@0.0.0 lint
> oxlint
```

Raw test result:

```text
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Production build result:

```text
vite v8.3.4 building client environment for production...
✓ 18 modules transformed.
✓ built in 389ms
```

The explicit production-mock refusal was also checked by running the production build with `VITE_AUTH_MOCK=true`; Vite exited nonzero with `VITE_AUTH_MOCK is development-only and cannot be enabled in production builds.`

## Ticked rows and tests

Specs rows ticked: FR-83g (reset route and PostgreSQL single-use/revocation test), FR-83h (TOTP and bootstrap tests), FR-84/84a (session rotation/reuse integration test), and FR-84c (configuration/adapter tests).

Security rows ticked: SEC-03 (`test/unit/jwt.test.js`), SEC-04/05 (`test/unit/users.auth.routes.test.js`, `frontend/src/lib/api.test.js`), SEC-07 (`test/integration/known-mismatches.test.js`), SEC-09/10 (TOTP/bootstrap PostgreSQL tests), SEC-22 (`test/unit/http-hardening.test.js`), SEC-23/25 (`test/smoke/app.test.js`), SEC-28 (`test/unit/http-hardening.test.js`), SEC-38 (`test/integration/known-mismatches.test.js`).

Still unticked include SEC-01 pending production TLS, SEC-02 pending an approved key-rotation runbook, SEC-06 pending a dedicated storage test/review, SEC-08/24 pending Redis execution and wider limiter scope, SEC-11–21 broader authorization/validation findings, SEC-26/27/29 broader secret/log/response audit, and SEC-30–37 deployment and later-phase controls. The payout job logger currently includes an error object, so SEC-27 remains unticked.

## Provisional assumptions

- Password length 12–128 and international phone format remain provisional owner-confirmation items.
- General hourly limiter defaults remain provisional: login 30/10, signup 5/3, reset 10/5, offers 60/30 and messages 120/60 per IP/account.
- Password worker cap 4 and the local benchmark selection (65,536 KiB, time cost 3, parallelism 1; 213 ms median on the development machine) require production-sized host measurements.
- Password-reset expiry defaults to 1,800 seconds and remains marked provisional in `open-questions.md`.
- Email/challenge adapter provider choices and the live challenge integration are unselected.

## Parked decisions and explicit deferrals

- FR-83k: recovery after loss of all factors, factor replacement, bypass authority and any delay; manual owner-only handling remains in force.
- FR-83b: passkey fallback/ranking and related UX.
- FR-83c: seller factor requirements.
- FR-83f: step-up, device management, notices and backup codes.
- FR-45g 72-hour payout lock, the 24-hour recovery delay, listing-revision lifecycle names, and WAF/bot protection (Phase 6) remain unapproved/deferred.
- No payment, listing revisions, video/story, object storage, or passkey implementation was added.

## Live checks and work not run or verified

`LIVE_CHECKS.md` tracks provider selection/delivery/failover, challenge quality, real Redis concurrency and proxy IP forwarding, production secret provisioning and key rotation, Argon2 capacity on production hosts, HTTPS/CORS/cookie behavior, first-admin deployment enrollment, and PgBouncer compatibility.

- The GitHub-hosted workflow was not run; no hosted logs were available to explain any earlier hosted failure.
- The real Redis integration tests were skipped locally; the new GitHub workflow is configured to run them with its Redis service.
- No live email or challenge provider was configured or tested; real login/reset delivery is not verified.
- No production deployment, HTTPS/TLS, hosting secret rotation, refresh-cookie domain/origin, or first-admin deployment enrollment was performed.
- The Argon2 benchmark was not repeated in this final pass; the Stage 2 development-machine result is recorded above.
- No WAF, payment, revision, video/story, object-storage or passkey work was run, by Phase 0 scope/deferral.

## Git and push

Local commits created for this continuation:

```text
b8eb018 chore: record Phase 0 gate evidence and CI workflow
3cae4db FR-83h: add encrypted staff TOTP primitives
705e47b FR-84: add frontend authentication flows
45ad51a FR-83g: complete authentication, reset, and admin bootstrap
```

The one-time push is the final repository action after this report. Its result is recorded in the final assistant report. The pre-existing owner Word documents are preserved and excluded from implementation commits.
