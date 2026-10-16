# agent.md — Poshaak backend router

Read this file first for **where things are**. Read `rules.md` for **how to
behave** — spec discipline, ownership rules, testing/commit requirements.
Both apply on every task, no exceptions. Plain Node.js + Express 5, plain
JavaScript (no TypeScript, no DI framework). This is a **website backend**
(React+Vite frontend) — not a native app; no app-store/PWA work is in scope.

**Project name:** Poshaak is the single, current name (earlier files and chats
say "Marketplace" — same project). **Reading order for a new session:**
`DEVELOPMENT_HANDOFF.md` → `MASTER_PROJECT_CONTEXT.md` → this file → `rules.md`
→ `Phases.md` → `security.md` → `specs.md` → `open-questions.md`.

## Planned, NOT built — don't assume any of this exists

Decided in the scale/escrow/auth program (see `specs.md` sections 13–20 and
`MASTER_PROJECT_CONTEXT.md`), none of it written yet: `worker.js` and
`lib/queue.js` (Postgres-backed queue, outbox, webhook inbox), Redis, object
storage and the image/video/story pipeline, a CDN and cache headers, a
versioned migration runner, PgBouncer, the `listing_search` table and
suggestions, worker-generated HTML snapshots, JWT auth with two-factor login,
escrow payments through a gateway, versioned listing content, encrypted
CNIC/payout fields and append-only ledger tables. What IS built is the
COD-era harness described below.

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
| 1. Identity & Users | FR-01–10 | `modules/users.service.js` | cities, users, seller_applications, seller_profiles |
| 2. Catalog | FR-11–14a | `modules/catalog.service.js` | main_categories, sub_categories, measurement_field_defs |
| 3. Listings | FR-15–21a | `modules/listings.service.js` | listings, listing_measurements, listing_images, listing_evidence |
| 4. Search & Discovery | FR-22–27b | `modules/discovery.service.js` | favorites (reviews read via orders.service.js, see below) |
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
- `db.service.js` — the only file that imports `pg` directly; exports `query`, `many`, `one`, `withTransaction` (one planned, named exception: `lib/queue.js`, `rules.md` Section 11).
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
| **FR-08b** | High-value listing pending ID verification — no automatic rule | **No guard.** `listings.service.holdListingPendingIdVerification()` / `users.service.recordManualIdVerificationDecision()` implement the manual, case-by-case process — that IS the decided interim behavior. `listings.service.approveListing()` refuses to silently approve and expects the caller to route to this manual path instead. |

`FR-40a` (delivery partner count/city assignment) isn't in the table above
because it has no guard either — `delivery_partners.city_id` is nullable on
purpose so the schema works whichever way this eventually gets decided.

## Cross-module dependency map (the parts that aren't obvious from one file)

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
- `.env.example` — copy to `.env`; nothing loads it automatically yet (no
  `dotenv` wired in — see the gap below).

## Known gaps to close before this is production-ready (not hallucinated as "done")

- **`users.service.authenticate()` is an unimplemented stub.** Session
  strategy (cookie session vs. JWT) was never decided — pick one before any
  route relying on `req.user` (i.e. everything behind `requireAuth`) can
  actually work.
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
- **`db/migrate.js` is single-shot, not real migrations** — fine for a
  fresh dev database, will break if you try to re-run it against a database
  that already has the tables, and has no way to evolve `schema.sql` over
  time without a manual `ALTER`. Replace with a real migration tool
  (e.g. `node-pg-migrate`) before this matters in practice.
- **Some queries don't match `schema.sql`, and the tests can't tell.**
  Verified: `users.updateSellerPayoutMethod` writes a `payout_details` column
  that doesn't exist (schema has `payout_bank_account` and
  `payout_wallet_number`) and validates `bank_transfer`/`mobile_wallet`
  while the schema enum is `bank`/`easypaisa`/`jazzcash`;
  `listings.addListingImages` and `submitAuthenticityEvidence` write a `url`
  column where the schema has `image_url` / `evidence_url`. These would fail
  on a real Postgres. The unit tests mock `db.service`, so they pass anyway.
  Not every column has been audited — add a real-Postgres integration layer
  (`db:setup` against a throwaway database) before trusting the SQL.
- **Escrow replaces COD (decided 2026-10-13); `specs.md` was revised on
  2026-10-14, but the CODE and `schema.sql` still describe COD.** Modules 7
  (payments), 9a (payout hold) and 10 (settlement), `cod_collections` and the
  COD-era `delivery`/`orders` behavior are rewritten in Phases 4–5
  (`Phases.md`). Don't extend any COD path (`cod_collections`,
  `confirmCodCollection`, cash reconciliation).
- **A session can't survive a page reload under the current decisions
  (`specs.md` FR-84a).** JWT in memory only + no refresh token + two-factor on
  every login means a reload or new tab forces a fresh login with a second
  factor. Undecided; resolve before building auth.
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
