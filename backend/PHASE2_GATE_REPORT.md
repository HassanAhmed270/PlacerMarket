# Phase 2 gate report (2026-10-23)

Phase 2 is **not closed**. Implementation and local automated checks are
recorded below. The live demo and several frontend/live checks remain pending;
no push is claimed.

## Phase backlog mapping

| Phase 2 backlog item | State | Evidence / remaining work |
|---|---|---|
| Listing create/measurements, validation, seller lifecycle and moderation (FR-15–21a) | Done in implemented scope | `npm test` 39 suites/487 passed; PostgreSQL `known-mismatches.test.js` passed. Broader Phase 2/Phase 1 authorization audit remains open. |
| Temporary high-value registered-email gate (FR-08a, FR-19b) | Done in implemented scope | PostgreSQL `revisions.test.js` threshold/equality/recheck cases passed; full demo scenario remains unrun. Email proves address control only. |
| Manual first-payout identity gate (FR-66/66a) | Implemented earlier; gate evidence outside this phase | See Phase 1 gate report; no new live payout run. |
| Required three-to-six labeled listing images and moderator confirmation (FR-74/74a) | Done in implemented scope | PostgreSQL media and known-mismatches suites passed, including required count and photo confirmation/ownership checks. |
| Private originals, local storage adapter, worker WebP variants, replaceable watermark (FR-74b/74c) | Done in implemented scope | PostgreSQL `media.test.js`, unit `media.service.test.js`, and unit `worker.test.js` passed. Production shared storage/CDN remains live-check pending. |
| Content version and moderated listing revisions (FR-73/73e) | Done in implemented scope | Migration 012 and its schema table-count test update are in the Stage 2–5 checkpoint; PostgreSQL `revisions.test.js` passed concurrent submit/decision, rollback, threshold, and public-read checks. Production flag defaults off unless `LISTING_REVISIONS_ENABLED=1`. |
| Cached published content-version serving (FR-73a) | Parked | Current public detail reads the live listing row; version-aware cache/read model is not implemented. |
| Proposed version pointers/cache semantics/route cache walker (FR-73b–73d) | Parked / DISCUSS | Tagged proposals remain unresolved and were not built or ticked. |
| Direct-to-storage upload, CDN and final brand artwork (FR-74d) | Parked / DISCUSS | API upload path and local disk adapter are implemented; direct-to-storage and CDN are not. |
| Video and story/voice (FR-75–76a) | Deferred | Remain deferred to `END_OF_PHASES_REVIEW.md`. |
| Frontend structured measurements and descriptive listing fields | Implemented screen; verification pending | `ListingWorkspace.jsx` is included in the committed Stage 2–5 checkpoint. No named UI behavior test was added, so the corresponding prototype gap rows remain unchecked. |
| Frontend sell flow with labeled photos, 3–6 limit and moderation state | Implemented screen; verification pending | Workspace supports listing/photo flows; lint, 5 frontend tests and build pass. No named end-to-end UI assertion, so gap row remains unchecked. |
| Frontend authenticity evidence, verification explanation and Verified badge | Parked | Not established by the Phase 2 frontend checks; gap-analysis rows remain unchecked. |
| Frontend dedicated listing page/content cache/status behavior | Parked / DISCUSS | Public API detail exists, but cached-version/status behavior and associated UI remain unresolved. |
| Production storage, email/challenge provider, Redis, secret and CORS live checks | Live-check pending | See `LIVE_CHECKS.md`; demo environment was not available on this machine. |
| Stage 6 guarded demo walkthrough | Implemented, run pending | `scripts/demo-smoke.js` covers the flow but could not run without a dev DB URL and Redis. No demo transcript is available. |
| Jest 29 advisories | Owner-triaged; not a Phase 2 stop | 2026-10-22 decision recorded in `security.md`, `open-questions.md`, and `Phases.md`. Only a nonzero production audit in either package blocks. Jest 29→30 is queued immediately after Phase 2. |

## Checks run on this machine

- Backend unit: `npm.cmd test -- --runInBand` — 39 suites, 487 tests passed.
- Backend PostgreSQL integration: `npm.cmd run test:integration` with
  `TEST_DATABASE_URL` loaded from `backend/.env` — 6 suites, 94 tests passed;
  one suite skipped and 4 tests skipped because `TEST_REDIS_URL` is unavailable.
- Schema snapshot: `npm.cmd run db:check-schema` — passed.
- Frontend: `npm.cmd run lint` passed; `npm.cmd test` passed (5 tests);
  `npm.cmd run build` passed.
- Frontend dev server: `http://127.0.0.1:5173/` returned HTTP 200 and title
  `Poshaak`. Vite route fallback is not evidence that authenticated screens or
  API integration work.
- PostgreSQL `127.0.0.1:5432` accepted TCP. Redis `127.0.0.1:6379` did not.
- Production audits: `npm.cmd audit --omit=dev` returned 0 vulnerabilities in
  both backend and frontend. Full backend `npm.cmd audit` reported 28 high
  findings in the Jest 29 dev dependency chain; full frontend audit returned 0.
  This is consistent with the owner's SEC-31 triage; production dependency
  audit remains the only dependency stop condition.
- Demo seed was attempted and refused because `DEV_FAKES=1` was not configured;
  demo smoke and dev database migrations/seeds were not run. API startup exited
  with the missing JWT secret error; worker startup exited with
  `{ code: 'unknown' }`. Live backend CORS was not run. No demo transcript or
  demo accounts were produced.

## Git and remaining gate work

Current `main` was already three commits ahead of `origin/main` at task start.
The Stage 2–5 changes are in existing commit `5dfbe7b` as a combined checkpoint;
no reset, amend, or history rewrite was done. The deleted `.docx` files remain
outside any new staging/commit. The Phase 2 gate still requires the dev database
and Redis demo, live CORS verification, and remaining named frontend evidence
before any push.
