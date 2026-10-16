# Phases.md — build order (backend and frontend in parallel)

Created 2026-10-13, **consolidated 2026-10-14** with the Poshaak scale, auth and
listing-media decisions. **Current phase: 0** (change this line when a gate passes).

## How phases work

- Every phase has two tracks, **Backend** and **Frontend**, built in parallel.
  Contract-first: at the start of a phase, write that phase's endpoint list
  (path, request, response) into its section, so both tracks build to the same
  shapes.
- **Tick state lives in `specs.md` and `security.md`, not here.** This file
  lists codes and holds only the gate checkboxes. An FR is ticked under
  `rules.md` Section 1 (a test that asserts it, title naming the code); a SEC
  row under `security.md`.
- A phase starts only when the previous **gate** holds. Don't build rows from a
  later phase early. Rows tagged `(DISCUSS)`, `(OPEN)` or `(SUPERSEDED)` are not
  built until the human removes the tag (`rules.md` Section 1); `(DEFERRED)`
  rows are out of scope.
- **Gate** = every in-scope FR row ticked, every listed SEC row ticked, every
  listed open question resolved (`open-questions.md`), `npm test` green,
  `npm audit --omit=dev` clean, and the phase's frontend items ticked in the
  "Prototype gap-analysis" list in `specs.md`.
- Frontend items have no FR codes; they are the rows under **Prototype
  gap-analysis action items** in `specs.md`, named here in short form.
- Concurrency-sensitive code needs real-Postgres integration tests
  (`rules.md` Section 11).

## Settled decisions the phases build on

**Payment model — escrow, replaces COD (decided 2026-10-13/14).** Buyers pay
through a licensed gateway; an order becomes Funded only from a verified webhook
(FR-60, FR-61). Flow (FR-62): offer accepted → Bag (listing reserved for that
buyer, with a payment window) → Funded → ship → Delivered (only an admin marks
it, FR-68) → hold and complaint window → Completed. The platform absorbs the
gateway fee (FR-64); payouts are manual at launch (FR-65); a seller is
ID-verified before their first payout (FR-66); no cool-off on payout-detail
changes (FR-67). Partial refunds (FR-71) are Claude's recommendation, unconfirmed.

**Scale program (10K concurrent visitors).** One codebase, two processes:
`server.js` and `worker.js`; a Postgres-backed queue behind `lib/queue.js`;
Redis, object storage and a CDN from day one; managed Postgres with failover; a
real migration runner; Postgres full-text search; worker-generated HTML
snapshots; edits to live listings go through moderation (FR-73–FR-81d).

**Auth.** JWT in the Authorization header, no refresh token, two-factor on every
login with email as the ordinary-buyer channel, first admin via
`npm run admin:create` (FR-83, FR-83a, FR-84). **Known conflict:** how a session
survives a page reload is open (FR-84a) and must be settled before auth is built.

---

## Phase 0 — Foundation and platform infrastructure

**Why first:** every FR ticked on mocked-database tests, with security rows
failing and no queue/auth/migrations, would be unreliable. Nothing from the
feature phases is ticked until this gate holds. Phase 0 is large; split it only
by the human's decision (renumbering would touch every reference).

**Backend — 0a data and tests**
- Real-Postgres test setup (`db:setup` against a throwaway database) plus
  integration tests; fix the schema/code mismatches listed in `agent.md`; audit
  every column.
- Versioned migration runner replacing `db/migrate.js` (FR-79b); separate
  read/write entry points on `db.service.js` (FR-79e); pool, statement, idle and
  lock timeouts configured (FR-79c — PgBouncer itself is deployment work, Phase 6).

- Already done (2026-10-16): Express 5 and the `db.one` / `db.many` helpers. New code uses the helpers; existing call sites are converted only when a module is touched (`rules.md` Section 12).

**Backend — 0b queue and worker**
- `worker.js` and `lib/queue.js` with outbox, leases, retries, dead-letter
  (FR-77, FR-77a); notification listeners enqueue instead of sending inline
  (FR-77d); Redis for cache and rate-limit state. Real-Postgres tests for the
  queue guarantees (two workers claiming, crash after an effect, duplicate
  delivery).

**Backend — 0c auth and hardening**
- JWT login with server-side password hashing, suspended users rejected
  immediately (FR-01, FR-02, FR-10, FR-84); two-factor on every login with the
  email channel (FR-83, FR-83a); `npm run admin:create` (FR-84).
- Hardening: helmet, CORS allowlist, rate limiting, explicit body limit, an error
  handler that never leaks, responses that never include `password_hash`, an
  input-validation layer; CI running tests and `npm audit`.

**Frontend**
- Scaffold against the API (React + Vite) using the prototype's `styles.css`
  theme; auth client and the two-factor login screens; route guards; shared error
  handling; admin code kept out of the public bundle from the start (FR-81d).
  Tick nothing from the gap list yet other than the login flow row.

**Security rows to close:** SEC-01, 02, 03, 04, 07, 08, 10, 15, 16 (framework),
22, 23, 24, 25, 27, 28, 29, and SEC-09 for the confirmed part (FR-83, FR-83a).

**Decisions needed first:** how a session survives a reload and the access-token
lifetime (FR-84a); hosting approach and providers (managed Postgres, Redis);
email provider(s); confirm the two-factor design rows FR-83b–FR-83f (including
how the first admin enrolls a second factor).

**Gate**
- [ ] Backend 0a, 0b, 0c done, with real-Postgres integration tests
- [ ] Frontend scaffold and login flow done
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 1 — Identity, catalog, seller onboarding

**Backend:** Module 1 beyond what Phase 0 built (FR-03–FR-09, FR-05a, FR-07a/b;
FR-08b stays OPEN), Module 2 (FR-11–FR-14a), cities (FR-04), admin seller-application
review (FR-53), application-level encryption for payout details (FR-79f) and the
role rules for sellers if confirmed (FR-83c).

**Frontend:** Kids' as a third main category · Condition/Type set with Replica
disclosure · seller-application review sub-tab in Admin → Users · Bank vs Mobile
Wallet payout field.

**Security rows to close:** SEC-11, 12, 13 (audit), 30, 35.

**Decisions needed first:** account recovery (FR-83g); key management for the
encrypted fields; confirm SEC-35.

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 2 — Listings, moderation and media

**Backend:** Module 3 (FR-15–FR-21a), versioned listing content with moderated edits (FR-73, FR-73a; price-edit rule FR-73e once confirmed), 3–6 photos with required shots and the image pipeline —
presigned uploads, worker variants, private originals (FR-74, FR-74d, and FR-74a/c
once confirmed), listing moderation (FR-19, FR-54 listing actions), the ID gate
(FR-08a, FR-19b), the manual hold for FR-08b, the manual Verified badge (FR-18/18a).
**Not built until discussed:** video (FR-75–FR-75c) and story/voice (FR-76, FR-76a).

**Frontend:** structured measurement fields · fabric/material, brand, color,
embellishment fields · evidence upload step + Verified badge display · reframe
`/verification` · photo upload enforcing 3–6 photos · moderation queue UI.
Video and story sections wait for the discussion.

**Security rows to close:** SEC-12 (listings), 17, 18, 19, 20, 30 (ID documents
private with short-lived signed links).

**Decisions needed first:** object storage provider; document retention period
and the legal check; Verified-badge criteria is *not* needed (manual interim).

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 3 — Discovery, negotiation and public delivery

**Backend:** Module 4 (FR-22–FR-27a, FR-27 share link), Module 5 (FR-28–FR-31 up
to requesting an accept — the atomic accept + reservation lands in Phase 4),
search (FR-80–FR-80e; FR-80f once confirmed), the live-status endpoint and cache
headers (FR-73a, and FR-73b–FR-73d once confirmed), HTML snapshots plumbing
(FR-81a–FR-81c — wording is SEO-GATE, FR-82 to FR-82d stay DISCUSS).

**Frontend:** remove the fixed-price "Add to bag" path · login gates on Favorite,
Chat and Make-an-offer · trim the seller card · chat and offer screens · search
sort set and suggestions (suggestions once confirmed) · listing page status
behavior · route-level code splitting, public JS budget, self-hosted fonts
(FR-81d).

**Security rows to close:** SEC-12 (conversations, offers, messages — known holes
`getNegotiationHistory`, `acceptOffer`), 24, 17, 36.

**Decisions needed first:** CDN provider; sold-item visibility in search.

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 4 — Orders and payment in (money comes in)

**Task 0:** `specs.md` was already revised for escrow on 2026-10-14. Before code:
confirm the DISCUSS rows (FR-60a, FR-63a, FR-69, FR-70), write the new
schema as migrations (payments, refunds, reservation fields, webhook inbox,
append-only ledger — FR-79f), and update `agent.md`. Do not extend any COD path.

**Backend:** Module 6 (FR-32–FR-34 per FR-62: reservation and the atomic accept FR-63/FR-63a (cap per buyer FR-63c once confirmed), payment window, checkout, lifecycle, cancel with refund), Module 7
rewritten (hosted checkout, webhook inbox FR-61/FR-77b, payments with the
gateway fee FR-64), Module 8 (FR-39, FR-41, FR-42; admin-only status entry through
`order.mark_delivered`, FR-68), notifications completed through the queue (FR-51),
reservation expiry job and reconciliation sweeps (FR-77c). Real-Postgres
concurrency tests: many simultaneous accepts → exactly one wins; expiry vs
payment race.

**Frontend:** checkout with the gateway's hosted payment step (**supersedes** the
"Remove Card/Wallet payment option" item) · reserved-listing state and
payment-window countdown · expanded order lifecycle states (FR-33) · buyer
cancellation (pre-dispatch only) · delivery tracking.

**Security rows to close:** SEC-33, 34, 11 (delivery permission), 12 (orders,
payments), 27 (no payment data in logs).

**Decisions needed first:** gateway provider, legal advice and a sandbox account
(external) · reservation duration · other open offers on accept (FR-63b,
deferred by the human) · seller no-ship policy · courier partner count (FR-40a) ·
general-notification channel.

**Gate**
- [ ] Task 0 done (DISCUSS rows confirmed, migrations written)
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 5 — Hold, disputes, payout and settlement (money goes out)

**Backend:** Module 9a (FR-45b–FR-45h, started from Delivered), Module 9
(FR-43–FR-45 and the return flow for a full refund; partial refunds FR-71 once
confirmed), admin-triggered idempotent gateway refunds (FR-69), Module 10
(FR-46–FR-50a: commission on what the seller receives, manual payouts FR-48/FR-65,
ID-verified before the first payout FR-66), the settlement reconciliation job
(FR-70), append-only ledger writes (FR-79f), two-way reviews after Completed (FR-27b).

**Frontend:** buyer "report an issue" · admin HELD view with countdown and
open-dispute flag · seller net-payout visibility (Held vs Released) · admin
settlement and payout screens · two-way reviews from the completed Orders page.

**Security rows to close:** SEC-30, 34 (audit trail on every money change), 27, 35.

**Decisions needed first:** confirm partial refunds (FR-45a, FR-50a, FR-71) ·
lost-parcel recovery (FR-72e) · refusal/return flow and return shipping cost (FR-33b) · delivery fee on a full
refund (FR-72a) · chargeback liability (FR-72b) · funds held for a seller who never
verifies (FR-72c).

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 6 — Admin completion and launch readiness

**Backend / infrastructure:** finish the Admin console (FR-52–FR-58; FR-59 stays
deferred) · backups, weekly restore tests and quarterly drills, managed-Postgres
failover, PgBouncer, private network/TLS/least-privilege roles (FR-79, FR-79a,
FR-79c, FR-79g) · WAF/bot protection (FR-84b once confirmed) · deployment
reliability (several instances, health checks, graceful shutdown) · monitoring
with log redaction · load tests against the SLO targets · runbooks for refunds and
payouts · final dependency audit.

**Frontend:** no public source maps · CSP check · bundle-size and Lighthouse
budgets in CI · real-user performance tracking · final watermark · sweep of the
whole gap list.

**Security rows to close:** every remaining row — SEC-05, 14, 21, 26, 31, 32, 37.

**Decisions needed first:** RLS (SEC-14) · load-test targets · watermark design.

**Gate**
- [ ] Admin console FRs ticked
- [ ] Every `security.md` row ticked, or left open by the human's explicit, dated decision
- [ ] Deployment, backups, monitoring and load tests in place
- [ ] `npm test` green and `npm audit --omit=dev` clean

---

## Later / not scheduled

Deferred in `specs.md`: physical inspection and fees · paid advanced verification ·
dry cleaning and alteration · boutique seller profile · express delivery tiers ·
real-time courier API · advertising and analytics (FR-59) · payout automation
through the gateway · real-time updates over Server-Sent Events (FR-78, decide
with how offline users are reached) · popularity sort · a read replica once metrics
justify it · phone verification before a first offer, only if fake-account abuse
appears. Video and story/voice (FR-75–FR-76a) are in scope but blocked on
discussion. "Automatic cash-remittance reconciliation" is obsolete (no COD).

## External dependencies (lead time outside our control)

| Needed | Before |
|---|---|
| Hosting approach; managed Postgres, Redis host | Phase 0 |
| Email provider(s) for two-factor codes (+ a second for failover) | Phase 0 |
| Object storage provider | Phase 2 |
| CDN provider | Phase 3 |
| Payment gateway provider, legal advice on holding funds, sandbox account | Phase 4 |
| Courier partner(s) | Phase 4 |
| Notification channel for general notifications | Phase 4 |
| Speech-to-text / LLM provider, YouTube API audit (only once video/story unblock) | when unblocked |
| Domain, TLS, load-testing and monitoring tools | Phase 6 |

## Decisions parked for later

All tracked in `open-questions.md`: reservation duration · other open offers (FR-63b)
· seller no-ship · FR-33b refusal/return and return shipping · delivery fee on
refunds · chargeback liability · held funds for an unverified seller · real-time
updates · all SEO wording (SEO-GATE).
