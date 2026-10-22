# agent.md — Poshaak backend router

Read this file first for **where things are**. Read `rules.md` for **how to
behave** — spec discipline, ownership rules, testing/commit requirements.
Both apply on every task, no exceptions. Plain Node.js + Express 5, plain
JavaScript (no TypeScript, no DI framework). This is a **website backend**
(React+Vite frontend) — not a native app; no app-store/PWA work is in scope.

**Project name:** Poshaak is the single, current name (earlier files and chats
say "Marketplace" — same project). **Reading order for a new session:**
`HANDOFF.md` → `DEVELOPMENT_HANDOFF.md` → `MASTER_PROJECT_CONTEXT.md` → this file → `rules.md`
→ `Phases.md` → `security.md` → `specs.md` → `open-questions.md`.

## Phase status — implemented foundation and planned follow-up

**Phase 1 implementation handoff (2026-10-22):** seller onboarding, measurement
administration, payout protection, manual identity verification, account UI,
and the guarded demo harness are recorded in `PHASE1_PROGRESS.md`; current
evidence and residuals are mapped in `PHASE1_GATE_REPORT.md`. Local unit,
PostgreSQL, schema, audit, lint, frontend test, and build checks passed as listed
there. The service-backed demo is blocked by missing development DB/JWT/Redis
configuration; provider, key-custody, real-Redis, browser, and deployment checks
remain open. Phase 1 is not a closed release gate. `LISTING_REVISIONS_PLAN.md`
is proposed Phase 2 design only; resolve its questions before coding.

Decided in the scale/escrow/auth program (see `specs.md` sections 13–20 and
`MASTER_PROJECT_CONTEXT.md`): Phase 0b now has `worker.js`, `lib/queue.js`
(PostgreSQL queue with transactional notification enqueue), and a Redis
connection lifecycle. Payment webhook inbox, object storage and the
image/video/story pipeline, a CDN and cache headers, PgBouncer,
the `listing_search` table and
suggestions, worker-generated HTML snapshots, JWT auth with two-factor login,
escrow payments through a gateway, versioned listing content, encrypted
CNIC/payout fields and append-only ledger tables. Phase 0 authentication now
includes validated Argon2id registration, buyer and pre-enrollment seller email-code login, staff TOTP,
durable rotating refresh sessions, self-service password reset, and one-time
TOTP-enrolled admin bootstrap. Email verification, strict high-value approval
gating and signup/login/reset/message/offer limits are implemented. Live
provider delivery, real-Redis verification and deployment checks remain pending.
Seller TOTP enrollment, backup codes, action-bound step-up, payout encryption,
payout change notice/hold gates, first-payout identity guard, and the Stage 7
seller/Admin workspace are implemented. PostgreSQL payout regression is pending
an available `TEST_DATABASE_URL`; account recovery and passkey fallback remain
parked.
The COD-era harness
described below remains the baseline for the rest of the system.

Runtime configuration is centralized in `src/config.js`; credential-dependent
interfaces live under `src/lib/adapters/`. Production requires configured
provider credentials and rejects placeholders/fakes. Non-production fakes
require explicit adapter selection and `ALLOW_FAKE_ADAPTERS=true` or the
development-only `DEV_FAKES=1`; the latter adds a temporary-file email outbox
and `/api/dev/outbox` only in non-production. Demo database seeding requires a
localhost database name containing `demo`, `dev`, or `local`. Live checks are
tracked in `LIVE_CHECKS.md`.

Payout encryption uses `src/lib/keyProvider.js` and
`src/lib/payoutEncryption.js`. The environment key map is JSON from stable key
IDs to base64-encoded 32-byte keys; `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID` selects
the write key. `npm run keys:rotate` re-encrypts stored seller envelopes with
the active key while keeping old keys available for reads. Never log envelopes
or key material; operators retain old keys through the documented rollback
window and maintain an offline master-key backup.

Manual identity verification is owned by `users.service.js`; the Admin facade
delegates there and route permission `seller_identity.verify` is Admin-only.
`src/lib/adapters/identityVerifier.js` provides the manual-admin adapter and a
test fake that requires `DEV_FAKES=1`; verification accepts only a short note
and records audit metadata without retaining identity documents or numbers.

Seller authenticator state and step-up grants are owned by `users.service.js`.
Sellers without TOTP must complete password plus email-code login before an
enrollment-only session can access authenticator setup/confirmation,
logout and refresh. Step-up grants are bound to an active session and action;
consume them before performing the corresponding protected operation. New
device identities are HMAC-hashed and new-device notices are queued through the
existing encrypted email queue. See `PHASE1_PROGRESS.md` for route contracts.

`npm run admin:create` is an interactive, one-time bootstrap. It requires
`STAFF_TOTP_ENCRYPTION_SECRET` from the deployment secret store and asks the
operator to confirm TOTP enrollment. Never put that key in `.env.example` or
source control. Frontend auth routes are under `/login`, `/register`,
`/forgot-password`, and `/reset-password`; the authenticated seller/Admin
workspace is at `/account`. Access tokens stay in module memory. The frontend
uses the real API; `VITE_DEV_FAKES=1` shows the development-fakes banner.

**SEO-GATE:** work touching titles, meta descriptions, headings, alt text,
keywords, structured data, URLs/slugs, canonical/robots rules, the sitemap or
snapshot templates is discussion-gated — stop and ask the human (`rules.md`
Section 10; rows FR-82 to FR-82d are tagged `(DISCUSS)`).

## Rule zero: one table, one owner

Every table in schema.sql is owned by exactly one `modules/*.service.js`
file. **Writes** to a table you don't own are never allowed — call the
owning service's exported function. **Reads** of a single row from a table
you don't own should also go through the owner; direct read-only
`SELECT`/`JOIN` on another module's table is allowed only for multi-table
list/queue views and notification-recipient lookups, each marked with a
`// cross-module read: <table> (owned by <module>)` comment (full wording
in `rules.md` Section 2). `admin.service.js` owns no tables at all (see its
own section below).

Existing code that predates this wording and still does an unmarked
single-row cross-module read (to be routed through the owner or marked
later): `disputes.service.fileDispute()` (reads `orders`),
`orders.service.createBagEntry()` (reads `conversations`),
`listings.service.getModerationQueue()` (subquery on `platform_settings`).

## Module → file → spec map

| Module (specs.md #) | FR range | Service file | Tables owned |
|---|---|---|---|
| 1. Identity & Users | FR-01–10 | `modules/users.service.js` | cities, users, seller_applications, seller_profiles, auth_sessions, email_login_codes, password_reset_tokens, staff_totp_credentials |
| 2. Catalog | FR-11–14a | `modules/catalog.service.js` | main_categories, sub_categories, measurement_field_defs |
| 3. Listings | FR-15–21a | `modules/listings.service.js` | listings, listing_measurements, listing_images, listing_evidence |
| 4. Search & Discovery | FR-22–27b | `modules/discovery.service.js` | favorites (listing images read via listings.service.js; reviews read via orders.service.js) |
| 5. Messaging & Negotiation | FR-28–31 | `modules/negotiation.service.js` | conversations, messages, offers |
| 6. Orders | FR-32–34 | `modules/orders.service.js` | orders, reviews (FR-27b lives here, not in module 4) |
| 7. Payments & COD (escrow replaces COD; the code is still COD-shaped) | FR-36–38 | `modules/payments.service.js` | cod_collections (also owns FR-41a reconciliation — see correction note below) |
| 8. Delivery | FR-39–42 | `modules/delivery.service.js` | delivery_partners, delivery_status_log |
| 9. Disputes, Returns & Refunds | FR-43–45a | `modules/disputes.service.js` | disputes, dispute_evidence |
| 9a. Payout Hold Window | FR-45b–45h | `modules/payout.service.js` | payout_holds |
| 10. Commission & Settlement | FR-46–50a | `modules/settlement.service.js` | platform_settings, settlements |
| 11. Notifications | FR-51 | `modules/notifications.service.js` | notifications |
| 12. Administration | FR-52–59 | `modules/admin.service.js` | **none** — thin orchestration only |

Root-level, not tied to one module:
- `db.service.js` — the only file that imports `pg` directly; exports `read`, `write`, compatibility `query`, `many`, `one`, `withTransaction` (one planned, named exception: `lib/queue.js`, `rules.md` Section 11).
- `lib/errors.js` — shared error classes (`NotYetSpecifiedError`, `NotImplementedError`, `NotFoundError`, `ValidationError`, `ForbiddenError`) — which to use when is in `rules.md` Section 4.
- `lib/events.js` — the only place event-name strings are defined.
- `lib/eventBus.js` — shared in-process `EventEmitter` (notification decoupling — user's chosen pattern over direct calls).
- `lib/roles.js` — FR-05a Admin vs. Moderator/Ops permission matrix.
- `middleware/auth.js`, `middleware/errorHandler.js` — route-layer plumbing.
- `routes/*.routes.js` — one per module, thin: parse request → call service → shape response. **No controllers layer** (confirmed decision — routes call services directly).

## Don't guess — the 5 OPEN items and how each is actually handled in code

Only 2 of the 5 have a hard runtime guard. The other 3 already have a
working interim default (per schema.sql's own implementation notes) — don't
add a guard where one isn't needed, and don't remove the two that exist.

| FR | What's open | How the code handles it right now |
|---|---|---|
| **FR-33b** | COD refusal-at-the-door flow — undefined | `orders.service.handleRefusalAtDoor()` throws `NotYetSpecifiedError('FR-33b', ...)` unconditionally. Do not implement a guess. |
| **FR-45a** | Dispute resolution granularity (partial refund) — undefined | `disputes.service.resolveDispute()` throws `NotYetSpecifiedError('FR-45a', ...)` if the amount is anything other than 0 or the full order total. Binary resolution works normally. |
| **FR-50a** | Settlement math for a partial refund — blocked on FR-45a | `settlement.service.calculateSettlement()` carries the same guard defensively, fed by `resolutionAmountToBuyer` passed in from `payout.service.js` (not queried directly — see "Cross-module dependency map" below). |
| **FR-18a** | Verified-badge criteria — undefined | **No guard.** `listings.service.setVerifiedBadge()` is a plain manual boolean a moderator sets after reviewing evidence — that IS the decided interim behavior. |
| **FR-08b** | High-value listing pending registered-email verification under the temporary policy | Address verification is implemented in Phase 0 through an encrypted queue and single-use codes; live provider delivery remains pending. Current listing code blocks publication above the configured threshold. No manual identity-review path or `held_pending_id` status is used. Email verification confirms control of the address, not legal identity, and must not set `seller_profiles.id_verified`. |

`FR-40a` (delivery partner count/city assignment) isn't in the table above
because it has no guard either — `delivery_partners.city_id` is nullable on
purpose so the schema works whichever way this eventually gets decided.

## Cross-module dependency map (the parts that aren't obvious from one file)

- **FR-48 / FR-66 / FR-83l payout gate:** `settlement.routes.js` injects
  `users.service.assertPayoutAllowed` into `settlement.service.initiateSellerPayout`;
  the settlement module does not require the users module, avoiding a cycle.
- **DEV_FAKES email:** `worker.js` uses `lib/adapters/devEmailOutbox.js` only
  when explicitly opted in outside production. `app.js` conditionally mounts
  `GET/DELETE /api/dev/outbox`; the message file is kept under the OS temp dir.

- **FR-45f (force-release gate)**: `payout.service.forceReleasePayoutEarly()`
  calls `disputes.service.hasOpenDispute()` **synchronously, directly** —
  never via the event bus. This gates an admin decision inside one request;
  it must not depend on whether an async event has been processed.
- **FR-45g (auto-pause on dispute filed)**: the opposite case —
  `payout.service.js` listens for `events.DISPUTE_FILED` on the event bus
  and reactively pauses the hold. This IS appropriate here because it's a
  side effect, not a gate on an in-flight decision. If you're adding new
  cross-module behavior, use this same test: gating a decision in the same
  request → direct call; reacting to something that already happened →
  event.
- **FR-50a guard**: `settlement.service.js` deliberately does NOT require
  `disputes.service.js` (would create a circular require with
  `disputes.service.js` → `settlement.service.js` for the complaint-window
  setting). Instead `payout.service.releasePayout()` reads the resolved
  amount via `disputes.service.getResolvedResolutionAmount()` and passes it
  into `settlement.service.calculateSettlement()` as a parameter.
- **Notifications**: every other service just does
  `eventBus.emit(events.SOMETHING, payload)` and knows nothing about
  `notifications.service.js`. That file is the only listener; it resolves
  the recipient user id(s) itself (see its `registerListeners()`). Its
  listeners are registered as a **require-time side effect** — `app.js`
  requires it explicitly so this isn't hidden.
- **`admin.service.js`** owns no tables and should stay that way. If you
  catch yourself writing a SQL query in this file, the logic belongs in the
  owning module's service file instead — `admin.service.js` only calls
  straight through. It does NOT check permissions: those live on each
  route in `routes/admin.routes.js` (`requirePermission()` against
  `lib/roles.js`), per `rules.md` Section 5.
- **`platform_settings`** (owned by `settlement.service.js`) is really
  global app config, not just commission settings. `users.service.js`
  reads `high_value_threshold_pkr`, `disputes.service.js` reads
  `complaint_window_days`, `payout.service.js` reads `payout_hold_days` —
  all via `settlement.getSetting(key)`.

## Corrections vs. earlier discussion (so you don't get confused by old chat context)

- FR-41a (cash-remittance reconciliation) lives in `payments.service.js`
  (on the `cod_collections` table), not `delivery.service.js` — confirmed
  against schema.sql's actual column placement.

## Authentication foundation and dependency rationale

- `authValidation.js` validates and allowlists registration/login inputs at the
  route boundary. `passwordHashPool.js` runs both Argon2id hash and verify calls
  in bounded Node worker threads; it rejects saturation as HTTP 503.
- `argon2@0.45.1` is pinned exactly. The upstream package supports Argon2id and
  PHC hashes, declares Node `>=16.17.0` (compatible with this project's Node
  `>=22.12.0`), and the stable release was published more than 14 days before
  this task. Native work stays inside the bounded worker pool. Upstream:
  [node-argon2 v0.45.1](https://github.com/ranisalt/node-argon2/tree/v0.45.1).
- `db/migrations/003_auth_foundation.sql` adds session-family, email-code,
  password-reset, and encrypted staff-TOTP persistence plus user timestamps.
  Password reset, staff TOTP login, and one-time admin bootstrap consume these tables in Phase 0.
- `npm run password:benchmark` selected 65,536 KiB / time cost 3 / parallelism
  1 at 213 ms median on this development machine. Re-benchmark on the production
  host; the worker-pool cap remains provisional.
- Email verification persistence is owned by `users.service.js`. Codes are
  HMACed with the JWT secret; queued email content uses AES-GCM with
  `EMAIL_QUEUE_ENCRYPTION_SECRET`. The worker consumes the `email` pg-boss queue.
  The explicit fake sender is opt-in; no live provider implementation is selected.

## Files outside src/ — what they're for

- `specs.md`, `schema.sql` — bundled at repo root (not just referenced) so
  this repo is self-contained; agent.md's table above is the index into
  both, but read the actual FR text / column definitions in these files for
  anything the table doesn't cover.
- `rules.md` — the standing behavioral rules (spec/ownership/testing/commit
  discipline). Read it alongside this file, not instead of it.
- `security.md` — the security checklist (checkbox rows, each with what
  enforces it and its verified status today). `rules.md` Section 9 makes it
  binding. Several rows currently FAIL on the existing code — they are the
  honest list of what's unsafe, not a to-do you can skip.
- `Phases.md` — the build order: backend and frontend tracks in parallel, a
  gate per phase, the escrow decisions, external dependencies. Read its
  "Current phase" line and work only on that phase's rows.
- `MASTER_PROJECT_CONTEXT.md` — the full project state: architecture, what is
  built vs planned, decisions register, verification results.
  `DEVELOPMENT_HANDOFF.md` — how a new Claude conversation resumes from here.
- `AGENTS.md` — the implementer rules Codex reads automatically; `WORKFLOW.md` — the
  loop between the human, the Claude window and Codex, and the review checklist.
- `.gitattributes` — forces LF line endings (the git hooks break with CRLF).
- `db/migrate.js`, `db/seed.js` — see README.md "Setup". `db/seed.js`
  specifically seeds `platform_settings` — skipping it means
  `settlement.getSetting()` throws `NotFoundError` for several functions
  across users/disputes/payout/settlement.
- `test/unit/`, `test/smoke/` — Jest. `test/unit/disputes.service.test.js`
  and `test/unit/settlement.service.test.js` are the template for testing a
  DB-touching function via a mocked `db.service.js` — copy that pattern
  when you add real logic to a module that doesn't have tests yet.
- `hooks/` — `commit-msg` and `pre-commit` git hooks enforcing the commit
  rules in `rules.md` Section 8; `hooks/lib/fr.js` holds the pure logic,
  shared with `test/unit/specs-checkboxes.test.js` so the hook and the test
  can't drift apart.
- `.env.example` — copy to `.env`; package scripts load it using Node's
  `--env-file-if-exists`. Direct `node` invocations must pass an env-file flag
  or use exported environment variables.

## Known gaps to close before this is production-ready (not hallucinated as "done")

- **Authentication implementation is complete for confirmed Phase 0 buyer/staff flows.** Login verifies Argon2id and the required email/TOTP factor; durable rotating sessions, reset, current suspension checks and one-time TOTP admin bootstrap have tests. Live provider, Redis and deployment checks remain pending. Seller factors and step-up are implemented; recovery and passkey fallback remain parked in `open-questions.md`. Argon2id, bounded hashing, Redis limiters,
  and Phase 6 WAF deferral are owner-approved for Phase 0.
- **No `dotenv` wired in.** `.env.example` documents the required vars but
  nothing in `src/server.js` actually loads a `.env` file — either add
  `require('dotenv').config()` there or rely on real env vars being
  exported some other way.
- **`lib/roles.js` is missing a few permissions** that route files had to
  reference: `catalog.manage` (used a stand-in Admin-only gate in
  `catalog.routes.js`) and `payout.force_release` (`payout.routes.js` and
  `settlement.routes.js` reuse `user.suspend` as an Admin-only stand-in).
  Add these properly instead of leaving the stand-ins in place.
- **FR-32b** (bag/checkout single-item-at-a-time) is not enforced anywhere
  — `orders.service.checkoutFromBag()` has a TODO instead of a guess, since
  specs.md doesn't say precisely what's constrained (one bag entry total
  per buyer? one in-progress checkout at a time? something else?).
- **FR-59** (advertising/analytics) has no real implementation —
  `admin.service.getAdvertisingOverview()` is a placeholder; schema.sql
  itself notes `ad_campaigns` isn't modeled yet.
- `payout.service.checkAndReleaseDuePayouts()` is written to be called by a
  cron/worker — nothing schedules it yet. `payout.routes.js` exposes it as
  a POST route ONLY for manual testing during development.
- **Migration runner foundation:** `db/migrate.js` uses pinned
  `node-pg-migrate@9.0.0` (Node.js >=20.11.0). It fits this plain-`pg`
  PostgreSQL project: it tracks ordered SQL migrations and provides the
  PostgreSQL advisory lock without introducing an ORM. Ordered SQL migrations,
  migration history, transactional application and an advisory lock. A
  legacy schema is never replayed by normal migration; `npm run
  db:migrate:baseline` checks expected tables, columns and enum labels and
  records the initial migration without changing application rows.
  `schema.sql` is generated with `npm run db:generate-schema`; check it with
  `npm run db:check-schema`. This is the runner foundation, not the full
  FR-79b gate: expand/switch/contract reviews, concurrent-index handling,
  worker backfills and old/new application compatibility checks remain.
- **FR-79c partial:** the web pool is bounded and has connection, statement,
  idle-transaction and lock timeouts; pool-acquisition timeouts map to 503.
  PgBouncer and deployed transaction-pool verification remain Phase 6 work.
- Queue integration tests passed on 2026-10-20 against the owner-specified
  `testing_only` database after verifying its PostgreSQL service identity and
  the unchanged destructive-test guard. They cover durable enqueue, rollback,
  FIFO, retry and terminal dead-letter listing. Do not mark FR-77/77a/77d complete
  without reviewing all acceptance criteria. The Phase 0b selection is pinned
  to pg-boss 12.38.0; see `Phases.md` and `open-questions.md` for the stage-only
  FR-77f resolution and open deployment verification.
- Redis is connected by the web and worker entry points; cache and rate-limit
  consumers are not implemented in this stage yet. Scheduled job processing is
  enabled in the worker but no Phase 0b recurring job is registered.
- **FR-77c observability is partial.** The admin queue-health response exposes
  queue depth, oldest ready-job age, created/completed/terminal-failure deltas,
  dead-letter count, and request ID correlation on HTTP-enqueued jobs. Retry
  attempt rate is not tracked: pg-boss's persisted deltas count terminal
  failures, not retry attempts. Payment/reservation reconciliation sweeps and
  external-service rate limits remain tied to their later feature phases.
- **Discovery gaps:** FR-24 city filtering remains unresolved because
  listings have no city column; see `open-questions.md`. Do not treat seller
  city as listing city without a decision.
- **Schema/code mismatch audit:** see [`SCHEMA_CODE_AUDIT.md`](SCHEMA_CODE_AUDIT.md)
  for the full service-SQL comparison, classifications, evidence, passing
  regression tests, and remaining expected-failure probes. Phase 0a-2a repaired
  the audited users/catalog SQL covered there; other phase rows remain unfixed.
  The unit tests mock `db.service`, so use the real-Postgres integration harness
  before trusting SQL behavior.
- **FR-15a measurement definitions:** migration `006_measurement_field_lifecycle.sql`
  adds `required` and `is_active`. Catalog editing is additive/update-based;
  referenced omitted definitions are retired, and listing creation locks the
  sub-category while enforcing active required fields. The real-Postgres
  regression tests are in `test/integration/known-mismatches.test.js`.
- **Real-Postgres integration harness:** set `TEST_DATABASE_URL` to the
  specifically owner-approved `testing_only` database, or a disposable
  PostgreSQL database whose decoded name contains `test` as a complete
  underscore-/hyphen-delimited token (`poshaak_test`, not `latest` or
  `poshaak_prod`). By default only `localhost`, `127.0.0.1`, and `::1` are
  accepted. Remote test databases require the explicit
  `TEST_DATABASE_ALLOW_REMOTE=1` override; treat that as permission to run the
  destructive harness against the named remote test database. Unix-socket URLs
  are unsupported. Before any connection or SQL, global setup validates both
  database name and host.
- **Integration schema-reset lock:** a lock-holder child process acquires a
  PostgreSQL session advisory lock on one dedicated live `Client` connection
  before the setup pool can drop `public`. A second run fails fast before reset
  if that lock is held. Jest global setup and teardown do not share a connection:
  setup writes a random-token localhost control endpoint to a temp state file;
  global teardown asks that child to close its client, which releases the lock,
  then waits for the state file to disappear. Setup failures release/terminate
  the exact child it started. Plain `npm test` ignores integration tests and
  does not connect to PostgreSQL.
- **Escrow replaces COD (decided 2026-10-13); `specs.md` was revised on
  2026-10-14, but the CODE and `schema.sql` still describe COD.** Modules 7
  (payments), 9a (payout hold) and 10 (settlement), `cod_collections` and the
  COD-era `delivery`/`orders` behavior are rewritten in Phases 4–5
  (`Phases.md`). Don't extend any COD path (`cod_collections`,
  `confirmCodCollection`, cash reconciliation).
- **Express 5 specifics.** Async errors reach the error handler without a wrapper;
  `req.body` is `{}` for body-less requests only because of a one-line shim in
  `app.js` (Express 5 leaves it undefined). Library, data-access and load
  conventions: `rules.md` Section 12.
- **Security gaps are tracked in `security.md`**, not here (auth is
  unbuilt, authorization holes on payments/delivery routes, response and
  error leaks, no helmet/CORS/rate limiting).
- **Git hooks are local-only.** `--no-verify` skips them and there is no CI,
  so a bypass is not caught anywhere. They also assume this folder is the
  repo root (`specs.md`/`test/` at the top level) — if the repo root ends up
  being a parent folder, the paths in `hooks/pre-commit` need adjusting.
  "One commit per FR" (rules.md Section 8) is not enforced at all.
- **Test coverage is partial by design** — it proves the FR-45a/FR-50a
  guards, the FR-05a permission matrix, and the mocked-db pattern; most
  `modules/*.service.js` functions have no test yet. Extend as you build
  out real logic, don't treat "tests exist" as "this module is covered."
