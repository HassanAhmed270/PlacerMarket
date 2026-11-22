# HANDOFF.md — Poshaak: state, approved decisions, open questions, next actions

Written 2026-10-17 for the agent that continues this project. Longer resume
instructions: `DEVELOPMENT_HANDOFF.md`. Full state and architecture:
`MASTER_PROJECT_CONTEXT.md`. Poshaak is the single name of the project (it was
first called "Marketplace").

Current phase: Phase 5 backend complete (stages 5.1 to 5.8b merged to main at 0460ecc51c26da877f294177174ab7453b018da9, verified 2026-11-19). After Stage 6.0, expect backend unit 68 suites / 1021 tests and integration 47 suites / 579 tests. Frontend for Phase 5 flows and the owner's browser click-through are not done. Launch blockers, not gate blockers: payment gateway, legal clearance, courier, a real second Admin; the owner's browser click-through is still pending (Scenarios A and B passed on 2026-11-10; Scenario C through the new Buyer "Report a problem" screen, Scenario D and the notifications remain). Post-closure changes on main `4c011b0`: the Buyer problem-report screen (FR-43, FR-43a, FR-43b rows still unticked) and the one-origin session fix (FR-84); see `open-questions.md` Resolved 2026-11-10.
Stage 6.0 - hardening: commission changes require a `commission.update` step-up grant (migration 043) and write a `commission_percent_changed` audit event; payout hold release uses `order_payout_hold_released`; Moderator navigation hides Admin-only links. Verified: backend unit 68 suites / 1021 tests; integration 47 suites / 579 tests (three runs); frontend 66 tests, lint/build/bundle check passed (largest public route 76.6 KB gzip). Second-Admin script diagnosis is documented in the stage report.
Stage 6.1 - seller flows (frontend): additive seller and buyer order reads now expose latest return details, dispute id/action flags, and safe lost/refused delivery outcomes (`outcome`, `recordedAt` only). The seller screens cover return responses, dispute evidence and party evidence, buyer reviews and blind reveal, and lost/refused status; compact seller-list badges reuse the same flow labels. Verified: backend unit 68 suites / 1028 tests; integration 47 suites / 580 tests (three successful runs); frontend 86 tests, lint: 0 warnings, build/bundle check passed (largest public route 77.4 KB gzip). Buyer refusal-at-the-door self-service remains out of Phase 6; the Admin records refused/lost outcomes. The API still returns chargeback statuses to buyers and sellers, but seller and buyer screens do not render chargeback data.
Stage P5-S1 (2026-11-13): Settlement core implemented with 5% launch commission snapshotted at Buy, partial-refund settlement maths (FR-46, FR-46a, FR-47, FR-50, FR-50a), idempotent settlement recording with ledger entries, and migration 028.
Stage P5-S2a (2026-11-15): Payout lifecycle implemented with migration 029 (seller_payouts), release initiating attempt 1 without cash ledger, paid/failed/retry state transitions, Admin-only payout.record permission, money audit, and in-app/email notifications (FR-48, FR-49, FR-51, FR-65).
Stage P5-S2b (2026-11-15): Two-Admin approval is required strictly above the configured PKR threshold; retries need fresh approval and invalid thresholds fail closed. Unverified sellers' proceeds are held, reminded at 7/30/90 days, and listed for Admin decision at 180 days (migration 031); forfeiture is undecided and defaults to none. P7, P10, and P3 remain open.
Stage P5-S2b-3 (2026-11-15): Admin-only payout CSV export supports status/date filters, is capped at 5,000 rows, requires step-up, excludes seller contact and bank/wallet details, audits each export, and escapes formula-like values.
Stage P5-S2c (2026-11-16): Seller order read-only earnings, payout summary and held-funds flags are exposed to the seller order API, plus the admin payout-settings read endpoint. D1 note: the commission change has no step-up grant; hardening candidate.
Stage P5-S3: Seller earnings reads, Admin payout and held-funds screens, payout settings, seller earnings screens.
Stage P5-S4: Partial refunds with item/delivery split, dispute outcomes (`buyer_favor`, `seller_favor`, `split`), durable dispute hold.
Stage P5-S5a: Business dates use Asia/Karachi; refused delivery (record only); lost parcel (full refund, no clawback).
Stage P5-S5b: Return requests; chargebacks (platform absorbs, no clawback); refund-cap guard.
Stage P5-S6: Dispute evidence/withdrawal, Admin dispute queue, SLA reminders (3 business days, weekdays), cursor pagination fix.
Stage P5-S7: Two-way reviews (migrations 040, 041), blind reveal, reports, moderation queue; Moderator or Admin may hide, only Admin restores; average rating is null until 3 visible ratings.
Stage P5-S8: Settlement consistency job (migration 042, `consistency_findings`, append-only, detect and report only, every 10 minutes); log redaction.
Stage P5-S8b: Commission validation fix; test flake fixes; SEC-31 exception re-accepted until 2026-12-10.
Stage P5-S9b (merged to main): Collision-free test phone numbers after a rare `users_phone_key` flake seen on 2026-11-19.
Stage P5-S9c: Test phone numbers no longer depend on process id length (collision risk across test files removed).

## 0. Inspect before you propose anything

1. Extract the ZIP. In `backend/` run `npm install`, then `npm test` — expect
   After Stage 6.0, expect backend unit 68 suites / 1021 tests and integration
   47 suites / 579 tests; `npm audit --omit=dev` shows only the 3 known moderate
   node-pg-migrate findings (owner exception SEC-31).
2. Read, in order: this file, `DEVELOPMENT_HANDOFF.md`, `MASTER_PROJECT_CONTEXT.md`,
   `agent.md`, `rules.md`, `Phases.md`, `security.md`, `specs.md`, `open-questions.md`.
3. Compare what you find with section 1 below and tell the human about any
   difference **before** proposing changes. Do not change application code (`src/`,
   `db/`, `hooks/`, `test/`) unless a change is necessary and you can justify it.
4. Follow `rules.md`: stop and ask on `(OPEN)`/`(DISCUSS)` rows and real ambiguity,
   log them in `open-questions.md`; SEO work is discussion-gated; the human's
   latest decision wins over any recommendation.

## 1. Project state (refreshed 2026-10-21)

- This checkout includes the backend, React/Vite frontend, PostgreSQL queue,
  migration runner, and real-PostgreSQL tests. Phase 0 auth and frontend auth
  remain unfinished. See `PHASE0_PROGRESS.md` for staged evidence.
- Phase 0 owner decisions and gate changes dated 2026-10-21 are in
  `Phases.md`, `specs.md`, `security.md`, and `open-questions.md`.

## 2. Decisions approved through 2026-10-21 (recorded in the files named)

- **FR-83d, buyer email codes:** six digits; five-minute expiry; single use; only a
  hash stored; **at most 3 verification attempts per code**; resend cooldown and
  email-sending caps (values still to be set); identical responses whether or not the
  account exists.
- **FR-84a, token lifetimes (configurable defaults):** access token 15 minutes, in
  memory; buyer refresh token 30-day absolute and 7-day inactivity; staff refresh
  token 8-hour absolute and 30-minute inactivity; rotate after every successful
  refresh; reuse of an old refresh token revokes its family and requires sign-in;
  enforced server-side. Refresh-cookie design and CSRF scope: FR-84 (httpOnly,
  Secure, SameSite=Strict, refresh endpoint only; second factor at sign-in only).
- **FR-83h, Phase 0 two-factor scope:** email code for buyers, authenticator app for
  admins and moderators, passkeys later.
- **FR-77f / FR-79c, queue:** verify the library against the actual PostgreSQL and
  PgBouncer configuration before committing (claiming, concurrent workers,
  transactions, retries, pooling); direct worker connections only if the library needs
  them; if incompatible, choose a compatible architecture; a transactional outbox or
  equivalent keeps an order and its job consistent; jobs are retryable and
  duplicate-safe.
- **FR-79h, hosting:** Render for initial hosting; PostgreSQL hosting, Redis, CDN,
  storage and connection configuration are chosen later; verify backups, secrets,
  security settings, database limits, monitoring and recovery before deployment.
- **FR-83e / FR-83a, email:** Nodemailer as the common sending interface where
  appropriate (it is the interface, not the provider); providers behind an adapter;
  HTTPS-API-compatible delivery preferred for the initial Render deployment; a
  secondary provider as fallback with failover implemented and tested before
  production; providers selected before the first real login.
- Earlier decisions (escrow, scale program, SEC list, rules): `MASTER_PROJECT_CONTEXT.md`.

## 3. Still open, with deadlines (full list: `open-questions.md`)

| Question | Deadline |
|---|---|
| Resend-cooldown and email-sending-cap values (FR-83d) | when the Phase 0c login is built |
| Queue library verification against PostgreSQL + PgBouncer (FR-77f) | before a library is committed (start of Phase 0b) |
| SEC-07: per-request status check, or accept up to 15 minutes for a suspended user | before Phase 0c |
| Remaining email proposals (FR-83i, FR-83j); choose email provider(s) | before the first real login |
| PostgreSQL hosting, Redis, CDN, storage, connection configuration; the Render pre-deployment checks; database plan vs the FR-79 targets | before the first deployment |
| Account recovery; key management for encrypted fields; confirm FR-83b/83c/83f | Phase 1 |
| Returns, refunds, disputes (incl. lost parcel, FR-72e, FR-45g), policies | deferred by the human to a later discussion |

## 4. Checks completed in this round

- Phase 4 Stage 22 evidence is recorded in [PHASE4_GATE_REPORT.md](./PHASE4_GATE_REPORT.md).

- Every FR and SEC code cited in the nine documents exists (script): **passed**.
- Search for outdated or conflicting values (old attempt count, old lifetimes, old
  queue/PgBouncer wording, old hosting/email blocker wording): found and fixed two stale
  sentences; **no remaining conflicts found** by the searches.
- Queue strategy, refresh-token rules and email architecture agree across the relevant
  files (checked by search): **passed**.
- `npm test`: **192 passed, 0 failed, 12 suites**. `npm audit --omit=dev`: 0 vulnerabilities.
- Two Render facts were checked against Render's own pages on 2026-10-17: free web
  services block outbound SMTP ports; free PostgreSQL has no recovery capability.

**Not run:** any test against a real Postgres or PgBouncer (none exist yet); the queue
library compatibility check; any provider or deployment verification; the git hooks
(not touched this round); the application against Render itself.

## 5. Immediate next actions

1. Inspect (section 0) and report any difference to the human.
2. Get the human's choice on the SEC-07 question and the cooldown/cap values.
3. Start Phase 0a: the real-Postgres test setup (`embedded-postgres`, verified on Linux
   only), the migration runner, and the four schema/code mismatches in `agent.md`.
4. At the start of Phase 0b, run the queue-library check (FR-77f) before choosing.

## 6. Continuation prompt

> Continue Poshaak from `HANDOFF.md` in the attached ZIP. First inspect the files: run
> `npm install && npm test` in `backend/` (expect 192 tests in 12 suites), read the
> documents in the order `HANDOFF.md` lists, and tell me any difference from its section 1.
> Do not change application code or propose changes until I confirm. Follow `rules.md`
> (stop and ask on OPEN/DISCUSS rows; SEO is discussion-gated). Then ask me for the two
> open Phase 0 answers (SEC-07 and the cooldown/cap values) and start Phase 0a.

## 7. Package contents and exclusions

The whole project under `backend/` (documents, `src/`, `db/`, `hooks/`, `test/`,
`package.json` and lockfile). Excluded: `node_modules/`, any `.env`, credentials, keys,
tokens, private user data. `.env.example` contains placeholders only.

## 8. Working model (added 2026-10-18)

You decide; a Claude conversation (another account, with access to the repo) plans,
discusses and reviews; the Codex agent in your editor implements. `AGENTS.md` is read
by Codex automatically; `WORKFLOW.md` describes the loop, who edits which files, a
task-prompt template, a ready first task for Phase 0a and the review checklist. The
repo documents are the only memory shared between the two Claude accounts — keep them
current. Receiving Claude: write the next task prompt from `Phases.md`, then review what
Codex pushes against `WORKFLOW.md`.
