# MASTER_PROJECT_CONTEXT.md — Poshaak

**Consolidated 2026-10-14.** This is the authoritative description of the whole
project. It merges the original "Marketplace" work (the harness in this ZIP,
inspected and tested directly) with the later Poshaak development (decisions
recorded in a handoff document). **Poshaak is the single, current name** — files
and chats that say "Marketplace" mean the same project.

**Precedence rule used to merge:** where two sources conflict, the human's latest
*finalized* decision wins; a recommendation that was only proposed (by Claude) is
never treated as a decision. Conflicts found are listed in section 7.

## 0. Provenance and honesty

| Source | How it was used |
|---|---|
| The ZIP (`poshaak-backend-harness.zip`) and its files | **Inspected and tested directly.** Everything labeled BUILT below was checked in the files. |
| The Poshaak handoff (scale / performance / SEO / auth discussion, Points 1–9, plus recorded notes) | Secondhand. Requirements taken from it are tagged by the status the handoff gave them; nothing from it was implemented in code. |
| Decisions made in the Marketplace chat (escrow, roles, sessions) | First-hand; recorded in `open-questions.md` and `specs.md`. |

Status vocabulary (same tags as `specs.md`): **BUILT** (exists in code, verified) ·
**DECIDED** (confirmed by the human, not built) · **DISCUSS** (recommended or
proposed, not confirmed — don't build) · **OPEN** (undecided) · **DEFERRED**
(postponed by the human) · **SUPERSEDED** (replaced).

## 1. The product

Poshaak is a C2C marketplace in Pakistan for high-value occasion, bridal and groom
fashion (sherwani, bridal wear, designer/branded). Website only — React + Vite,
no native app, no PWA. Individual sellers only (boutique tier deferred). Buy-only
(no rental). Replica items are allowed with disclosure. **There is no fixed-price
purchase path: negotiation (offer / counter / accept) is the only way to a sale.**
Revenue: commission (single global %, adjustable, about 10%, on item price only) plus
featured listings and advertising.

Roles: Admin (everything) and Moderator/Ops (listings, disputes, seller
applications; cannot configure fees or suspend users). Browsing is public; login is
needed for favorite, message and offer. Two approval tiers: seller application, then
per-listing moderation. Verified badge is separate from approval and set manually.
Two-way ratings only from the completed Orders page; the public seller card shows
rating and join date only. The prototype's `styles.css` theme (deep green / cream /
gold, Playfair Display + DM Sans) is the final design system.

## 2. What exists today — BUILT (verified in the ZIP)

A plain-JavaScript **Express modular monolith scaffold**, COD-era, in `backend/`:

- **Stack:** Node, Express 5, `pg`; Jest + supertest. No TypeScript, no DI framework.
  Routes call services directly (no controllers).
- **Structure:** `src/db.service.js` (the only `pg` import) · `src/modules/` — 13
  service files, one per spec module: users, catalog, listings, discovery,
  negotiation, orders, payments, delivery, disputes, payout, settlement,
  notifications, admin · `src/routes/` — 13 routers + `index.js` · `src/lib/` —
  errors (5 classes), events, eventBus, roles · `src/middleware/` —
  auth, errorHandler · `db/migrate.js` (single-shot `schema.sql` apply), `db/seed.js`
  (seeds 4 `platform_settings`) · `hooks/` (commit-msg, pre-commit, install, shared
  logic) · `test/unit`, `test/smoke`.
- **Data:** `schema.sql` — 26 tables, COD-era baseline (header note added; no
  structural change).
- **Enforcement already in place:** Jest tests for circular requires, FR-code
  comments on every exported service function, admin-route permissions, the
  ticked-checkbox rules (named test; no blocking tag), and the hook logic; git hooks
  for commit format, "ticked FR needs its test in the same commit", and never
  committing `node_modules`/`.env`/`coverage`.
- **Verification:** 175 tests / 11 suites passed on the original ZIP; after this
  consolidation 184 / 11, and after the 2026-10-16 changes (Express 5, db helpers, new tests) **192 tests / 12 suites** pass (see section 8). `npm audit --omit=dev`:
  0 vulnerabilities. The app boots.

**Honest limits of what is built:** every test mocks the database — nothing has ever
run against a real Postgres (`db:setup` included). Several queries use columns that
don't exist in `schema.sql` (`payout_details`, the payout-method values,
`listing_images.url`, `listing_evidence.url`). Auth is a stub
(`authenticate()` throws `NotImplementedError`). Money, payout and settlement code is
COD-shaped. There is no Redis, queue, worker, CDN, object storage, helmet, CORS, rate
limiting or JWT in the code. `security.md` lists the verified failing rows.

## 3. Architecture — target (DECIDED unless tagged)

Modular monolith, React + Vite, Node + Express, PostgreSQL, payment and courier
adapters. **One codebase, two processes:** `server.js` (web, never runs jobs) and
`worker.js`. Redis, a Postgres-backed queue (`lib/queue.js`: outbox, leases, retries,
dead-letter, webhook inbox), object storage and a CDN are required from day one
(replacing "added as needed"). Notifications listeners enqueue jobs; the in-process
EventEmitter stays for wiring. Managed Postgres with failover and point-in-time
backups (lose ≤ ~5 min, recover ≤ ~1 h); real versioned migrations
(expand → switch → contract) replace `db/migrate.js`; PgBouncer for web, workers
connect directly; no read replica initially; application-level encryption of CNIC and
payout fields; append-only ledger/audit tables. Search stays in Postgres (a
`listing_search` table, trigram, admin synonyms, a browser-matched suggestions file).
Public pages get worker-generated HTML snapshots; React + Vite is kept (no Next.js).
Target load: **10K concurrent visitors**. Full requirement rows: `specs.md` sections
13–20 (FR-60 to FR-84b).

## 4. Payment model — escrow replaces COD (DECIDED 2026-10-13/14)

| Area | Was (COD) | Now |
|---|---|---|
| Payment | Cash or digital transfer at the door | Licensed gateway (card / wallet / bank); hosted checkout proposed (FR-60a, DISCUSS) |
| Order becomes paid | Courier confirms collection | Only from a verified webhook (FR-61) |
| Flow | Order Placed … Delivered (Payment Confirmed) | Bag (reserved) → Funded → … → Delivered → hold → Completed (FR-62) |
| Delivered marked by | Courier/ops staff | **Admin only, for now** (FR-68) |
| Cash remittance reconciliation | Manual vs courier statements | Obsolete; gateway settlement reconciliation (FR-70, DISCUSS) |
| Gateway fee | n/a | Platform absorbs it from commission (FR-64) |
| Payouts | Manual by admin | Still manual at launch (FR-65) |
| Seller ID verification | Only for high-value listings | Also before the first payout, any price (FR-66) |
| Payout-detail changes | not specified | No cool-off (FR-67); protections proposed (SEC-35) |
| Hold window | ~5 days from delivery, ~2–3 day complaint window | Unchanged, started from Delivered (FR-45b) |
| Partial refunds | OPEN | Allowed — **Claude's recommendation, unconfirmed** (FR-71, DISCUSS) |

Parked by the human for the policies discussion (kept simple for now): seller
no-ship, refusal/return and return shipping (FR-33b), delivery fee on refunds,
chargeback liability, reservation duration, held funds for an unverified seller.

## 5. Other decided requirements (see `specs.md` for the row text)

- **Listing media:** 3–6 photos with required front/back/other shots; watermark
  (design pending the logo); edits to a live listing go through moderation while the
  approved version stays public; optional video published on the platform's YouTube
  channel with seller opt-in and moderator play-once approval (hosting and agreement
  OPEN); optional voice-story description producing three versions (details DEFERRED).
- **Auth:** JWT in the Authorization header; **no refresh token**; **two-factor on
  every login**, email code for ordinary buyers; first admin via
  `npm run admin:create`. Passkey/authenticator methods, role rules, hardening and
  recovery are proposals (FR-83b–83g).
- **SEO-GATE:** wording and rules for titles, meta, headings, alt text, structured
  data, URLs, canonicals and snapshots are discussion-gated (FR-82–82d, `rules.md`
  Section 10); mechanical plumbing may be built.
- **Search sort set:** newest, price low→high, price high→low, relevance (only with a
  query); popularity later.

## 6. Planned but NOT built

Everything in section 3 and 5 beyond the harness; the escrow rewrite of modules 7, 9a
and 10; JWT/2FA auth; the queue and worker; the migration runner; all media, search,
snapshot and caching work; the frontend (the prototype exists separately — the
18-item gap list is in `specs.md`). Nothing from the Poshaak handoff was implemented
in code in this consolidation.

## 7. Conflicts found while merging

1. **Refresh token.** The handoff *proposed* a rotating refresh-token cookie; the human
   *decided* "no refresh token" on 2026-10-14. Decision wins. **But** memory-only token
   storage + no refresh + two-factor on every login means a page reload forces a fresh
   login with a second factor. Logged as OPEN, `specs.md` FR-84a — needs a decision
   before auth is built.
2. **Other open offers on accept.** The scale discussion recommended auto-closing them;
   the Marketplace chat assumed freezing them. Neither was confirmed; the human deferred
   it. Recorded as DEFERRED (FR-63b), both options listed.
3. **FR-45a.** The handoff said Claude's recommendation "is not recorded". It is: partial
   refunds allowed, admin enters 0 to the item price, commission on what the seller
   receives. Recorded as DISCUSS (FR-45a, FR-50a, FR-71) — not confirmed.
4. **MFA.** `security.md` called MFA "not in specs, OPEN"; two-factor on every login is
   now decided. SEC-09 updated; design details stay DISCUSS/OPEN.
5. **Handoff claims corrected by inspecting the files:** the code lives under `src/`
   and tests under `test/` (not root-level / `tests/`); `schema.sql` has 26 tables (not
   ~30); the `pg`-import rule is in `agent.md`, not `rules.md`; `security.md`,
   `open-questions.md` and `Phases.md` all exist (the handoff expected `Phases.md` to
   be unwritten); the highest FR number was FR-59, so new rows start at FR-60.

6. **Clash review (2026-10-15).** The unified decisions were checked against `specs.md` and the code. Fixed in the spec: FR-20 vs moderated edits (FR-73), FR-32a's COD wording and its "record only after checkout" clash with FR-33/FR-62, FR-32b vs reservations (new FR-63c, DISCUSS), FR-73b's "money values never read from cache" vs the cached price (made precise; new FR-73e, DISCUSS), the undefined "editor" role (noted on FR-75b), the admin-only Delivered bottleneck (noted on FR-68). Recorded for confirmation: sessions vs two-factor (FR-84a, recommended resolution) and payout details with no cool-off (SEC-35, FR-83c, FR-83f). **Deferred by the human to the returns/refunds/disputes discussion:** the lost-parcel gap (FR-72e), the non-durable payout pause (FR-45g) and the cost of free cancellation.

## 8. Verification results (the handoff's section 15 checklist, answered from the files)

1. ZIP contents: match the layout in section 2 (plus `package-lock.json`); `security.md`
   and `open-questions.md` exist. 2. `package.json`: express, pg; jest, supertest;
   scripts `start`, `dev`, `test`, `prepare`, `hooks:install`, `db:migrate`, `db:seed`,
   `db:setup`. 3. Tests: 175 / 11 suites on the original; 184 / 11 after the consolidation; 192 / 12 after the 2026-10-16 changes. 4. Highest FR
   before consolidation: FR-59 (97 rows); OPEN: FR-08b, FR-18a, FR-33b (tagged "OPEN /
   MAJOR GAP"), FR-40a, FR-45a, FR-50a; FR-08b = high-value listing pending ID
   verification (no automatic rule). 5. COD-related rows: FR-36–38, FR-40, FR-41a,
   parts of FR-33, FR-33a, FR-41, FR-45b, FR-47, FR-55 — now SUPERSEDED or revised in
   place; table `cod_collections`. 6. Schema: no reservation, versioning, photo-slot,
   video, story, queue, search or 2FA structures. 7. `lib/roles.js`: `operations.view`
   exists; `catalog.manage` and `payout.force_release` are still missing (stand-ins in
   routes). 8. `pg` rule wording: `agent.md`; exception for `lib/queue.js` now in
   `rules.md` Section 11. 9. Auth stub: `NotImplementedError`; nothing assumes cookie
   sessions. 10. The three `NotYetSpecifiedError` guards (FR-33b, FR-45a, FR-50a) still
   exist, in `orders`, `disputes`, `settlement`. 11. Payout-hold rows are as described
   in section 4. 12. FR-32b: a TODO in `orders.service.checkoutFromBag()`, unenforced.
   13. The FR-45a recommendation was recorded only in chat and `open-questions.md`; now
   in `specs.md`. 14. Verified badge, video and story: Verified badge is in `specs.md` and
   `schema.sql`; video and story were in neither before this consolidation (now in
   `specs.md` only). 15. Prototype screens vs the new requirements: **not checked** — the
   prototype zip was not available in this session.

## 9. What this consolidation changed

Updated: `specs.md` (97 → 178 FR rows; escrow/scale/media/auth/SEO sections 13–20; COD
rows superseded or revised; new tags), `rules.md` (source-of-truth note, DISCUSS /
SUPERSEDED tags, Sections 10 SEO-GATE and 11 scale rules), `agent.md`, `security.md`
(SEC-36, SEC-37 added; SEC-03/06/09/30/33/34 updated), `Phases.md` (integrated the
scale/auth/media decisions), `open-questions.md` (one merged register), `README.md`,
`schema.sql` (header comment only). New: this file and `DEVELOPMENT_HANDOFF.md`.
**One code change:** `hooks/lib/fr.js` — the blocking-tag check now catches
`(OPEN / MAJOR GAP)`, `(DISCUSS)` and `(SUPERSEDED)` (it previously missed FR-33b),
with 9 new tests in `test/unit/git-hooks.test.js`; `test/unit/specs-checkboxes.test.js` only had a test title and a comment reworded.
**Not changed in the consolidation itself:** all `src/` code, `db/`, `package.json`, dependencies, and every other test.

**2026-10-16 follow-up (code):** Express 4 → 5.3.0 (`package.json`, lockfile); all 67 `asyncHandler` wrappers and `lib/asyncHandler.js` removed (verified: the 184 existing tests passed unchanged on Express 5 before the edit); a one-line `req.body ??= {}` shim in `app.js` because Express 5 leaves `req.body` undefined; `db.one` / `db.many` helpers in `db.service.js`; 8 new tests (db helpers, transactions, empty body, unwrapped async errors); `rules.md` Section 12. Existing query call sites were deliberately not converted.

## 10. Where to look

`DEVELOPMENT_HANDOFF.md` (resume), `agent.md` (where logic lives), `rules.md` (how to
behave), `Phases.md` (build order and gates), `security.md` (checklist),
`specs.md` (requirements), `open-questions.md` (undecided points).
