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
gateway fee (FR-64); payouts are manual at launch (FR-65); a seller must be
manually identity-verified before their first payout (FR-66), while registered
email verification gates only high-value listings strictly above threshold
(FR-08a). No automatic payout-detail change lock (FR-67/SEC-35). Partial refunds (FR-71) are Claude's
recommendation, unconfirmed.

**Scale program (10K concurrent visitors).** One codebase, two processes:
`server.js` and `worker.js`; a Postgres-backed queue behind `lib/queue.js`;
Redis, object storage and a CDN from day one; managed Postgres with failover; a
real migration runner; Postgres full-text search; worker-generated HTML
snapshots; edits to live listings go through moderation (FR-73–FR-81d).

**Auth.** JWT in the Authorization header: a short-lived access token in memory plus a rotating refresh-token cookie; two-factor at every sign-in (email code for buyers, authenticator app for admins and moderators, passkeys later); first admin via `npm run admin:create` (FR-83, FR-83a, FR-83h, FR-84).

**Phase 0 gate amendment (owner-approved 2026-10-21):** Phase 2 design and
expand-only migrations may begin now. No Phase 2 route may be exposed to real
users until authentication is complete. FR-83g self-service password reset is
in Phase 0. Account recovery policy is owner-approved: Admin-only recovery with
a 24-hour delay, old-email notice, recorded reason, session revocation and new
factor enrollment; use the manual owner-only procedure until implemented, and
pause recovered sellers' payouts pending Admin resolution and real-owner payout
detail verification (FR-83k/FR-83l). Email verification proves address control
only, never legal identity, and does not set `seller_profiles.id_verified` or
add a `held_pending_id` state.

---

## Phase 0 — Foundation and platform infrastructure

**Why first:** every FR ticked on mocked-database tests, with security rows
failing and no queue/auth/migrations, would be unreliable. Nothing from the
feature phases is ticked until this gate holds. Phase 0 is large; split it only
by the human's decision (renumbering would touch every reference).

**Backend — 0a data and tests**
- Real-Postgres test setup — the tests start their own Postgres from an npm package (`embedded-postgres`; verified on Linux, no Docker needed) — plus integration tests; fix the schema/code mismatches listed in `agent.md`; audit
  every column.
- Versioned migration runner replacing `db/migrate.js` (FR-79b); separate
  read/write entry points on `db.service.js` (FR-79e); pool, statement, idle and
  lock timeouts configured (FR-79c — PgBouncer itself is deployment work, Phase 6).

- Already done (2026-10-16): Express 5 and the `db.one` / `db.many` helpers. New code uses the helpers; existing call sites are converted only when a module is touched (`rules.md` Section 12).

**Backend — 0b queue and worker**
- `worker.js` and `lib/queue.js` with outbox, leases, retries, dead-letter (FR-77, FR-77a, FR-77f); notification listeners enqueue instead of sending inline
  (FR-77d); Redis for cache and rate-limit state. Real-Postgres tests for the
  queue guarantees (two workers claiming, crash after an effect, duplicate
  delivery).

The Phase 0b queue selection review is recorded below. On 2026-10-20, the
applicable queue and migration integration checks passed against the owner-
specified disposable `testing_only` database after its identity and the
existing destructive-test guard were verified. The current implementation has
durable notification processing, transactional enqueue, queue administration,
and partial FR-77c health/correlation metrics. Payment webhook, reservation,
media, cache, and other feature-specific jobs remain with the phases that
implement those features.

**Stage-specific FR-77f resolution (owner-approved 2026-10-20):** Phase 0b may
select and implement a queue without waiting for final PgBouncer provisioning.
`pg-boss@12.38.0` is selected after official-document review. It supports
PostgreSQL 13+ and Node.js 22.12+, transactional enqueue and transactional
workers, durable PostgreSQL storage, concurrent claiming, retry/dead-letter
handling, and optional LISTEN/NOTIFY with polling fallback. Its worker will use
a direct PostgreSQL connection when LISTEN/NOTIFY is enabled. Actual behavior
with the deployed PgBouncer transaction-pool configuration remains unverified
and must be checked before Phase 6 deployment (or sooner if configured
earlier). The 2026-10-20 run passed (4 suites, 57 tests) on PostgreSQL 18.6;
this does not include a deployed PgBouncer configuration. FR-77f is not fully
satisfied by this stage resolution.

**Backend — 0c auth and hardening**
- The configuration foundation centralizes production credential checks, approved
  FR-83d values, approved configurable rate limits, and explicit-opt-in fake email
  and challenge adapters (FR-84c).
- Stage 2 adds server-side Argon2id registration, a benchmark-selected bounded
  worker pool, strict request allowlists, and expand-only auth persistence in
  `003_auth_foundation.sql` (FR-01, SEC-01, SEC-16).
- JWT login with server-side password hashing, the refresh-cookie flow, suspended users rejected immediately (FR-01, FR-02, FR-10, FR-84); two-factor at sign-in: email code for buyers, authenticator app for admins and moderators (FR-83, FR-83a, FR-83h); `npm run admin:create` with authenticator enrollment (FR-84).
- Argon2id in a bounded worker pool with benchmark-selected parameters and a concurrency cap; saturation returns 503. Redis per-IP/account limits cover login, signup, reset, email-code send, offers, and messages. WAF/bot protection is Phase 6. Forgot-password is self-service for all roles; the FR-83k recovery policy is decided and its implementation remains in the Phase 1 backlog.
- Email sending behind a provider adapter: Nodemailer as the common interface, an HTTPS-API-compatible provider for the initial Render deployment, and a secondary-provider failover implemented and tested before production (FR-83a, FR-83e).
- Hardening: helmet, CORS allowlist, rate limiting, explicit body limit, an error
  handler that never leaks, responses that never include `password_hash`, an
  input-validation layer; CI running tests and `npm audit`.

**Frontend**
- Scaffold against the API (React + Vite) using the prototype's `styles.css`
  theme; React auth routes for login (buyer email code and staff TOTP), registration, forgot/reset, in-memory access tokens and cookie refresh. The existing public catalog page remains unchanged. The development mock is explicit and production builds refuse it.

**Implementation checkpoint (2026-10-21):** Stage 5–7 backend login, refresh,
reset and admin-bootstrap flows and Stage 9 account screens have been implemented
and locally tested. Stage 10 adds GitHub Actions with PostgreSQL 18 and Redis.
The local Redis integration test was skipped because no service was available;
the hosted workflow has not run. Email/challenge providers, production secrets,
TLS/cookie behavior, and the remaining security audit items stay open. The
checkboxes below remain the release gate and the current phase remains Phase 0.

**Security rows still open:** consult the unchecked items in `security.md`; SEC-08/24 await real Redis and expanded scope, while several unrelated Phase 0 API authorization/input/logging checks remain incomplete.

**Decisions (updated 2026-10-21):** sessions and token lifetimes (FR-84, FR-84a), buyer email and staff TOTP scope including first-admin enrollment (FR-83h), code values, Argon2id bounded execution and Redis rate limits (FR-83d, FR-84b), self-service password reset (FR-83g), the email adapter (FR-83e), queue selection (FR-77f), Render hosting (FR-79h), and the Phase 1/2 decisions listed in those sections are approved. All security limits are configurable. SEC-07 requires current suspension state on every authenticated request. Refresh/TOTP persistence and bootstrap are implemented; live provider delivery, secret rotation, Redis concurrency and deployment behavior remain readiness requirements. FR-83k recovery policy is decided; implementation is in the Phase 1 backlog and uses the manual owner-only procedure meanwhile. Email delivery providers need live checks before real login. Deployment-level PgBouncer compatibility is required before Phase 6.

**Gate**
- [ ] Backend 0a, 0b, 0c done, with real-Postgres integration tests
- [x] Frontend scaffold and login flow done (local lint, tests, and build passed)
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 1 — Identity, catalog, seller onboarding

**Backend:** Module 1 beyond what Phase 0 built (FR-03–FR-09, FR-05a, FR-07a/b),
Module 2 (FR-11–FR-14a), cities (FR-04), admin seller-application
review (FR-53), application-level encryption for payout details (FR-79f) and the
seller authenticator gate (FR-83c).

Before Phase 2 listing publication, implement and test registered-email
verification strictly above the configured high-value listing threshold
(FR-08a, FR-08b, FR-19b). It verifies address control only. Separately, the
first payout requires manual identity verification (`seller_profiles.id_verified`)
under FR-66/FR-66a; the manual procedure stores no CNIC number or document.

**Frontend:** Kids' as a third main category · Condition/Type set with Replica
disclosure · seller-application review sub-tab in Admin → Users · Bank vs Mobile
Wallet payout field.

**Security rows to close:** SEC-11, 12, 13 (audit), 30, 35.

**Decisions needed first:** none remain from the 2026-10-21 owner decision set.

**Dated implementation backlog (owner decisions 2026-10-21; no rows are ticked):**
seller-application contract (profile name/phone/verified city; application reason
and what-will-sell only) · atomic approval/revocation role and profile state ·
measurement `required` / `is_active` migration and enforcement · bank/Easypaisa/
JazzCash payout mapping · SEC-35 authenticator step-up, email notice and Admin
recent-change flag · FR-83f step-up, new-device notice and backup codes · seller
authenticator gate before payout details · manual `IdentityVerifier` and audit
fields · `KeyProvider` and payout-field encryption/key custody · FR-83k/83l
recovery and payout pause. Preserve the strictly-above email threshold for
high-value listing approval; verify existing implementation before relying on it.

**Stage 1 contract (implemented 2026-10-22):** `POST /api/users/seller-applications`
accepts only `reasonForSelling` and `whatWillSell`; `GET
/api/users/me/seller-application` returns the caller's latest status;
`GET /api/admin/seller-applications?status=pending` returns the review queue with
name, phone and city joined from the user profile; the existing
`POST /api/admin/seller-applications/:id/review` decides the application. The
backend stage evidence is in `PHASE1_PROGRESS.md`; the admin queue's navigation
placement remains a frontend item.

**Gate**
- [ ] Backend FRs above ticked
- [ ] Temporary email verification above implemented and tested before Phase 2
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 2 — Listings, moderation and media

**Backend:** Module 3 (FR-15–FR-21a), versioned listing content with moderated
edits (FR-73, FR-73a, FR-73e; one open revision per listing), 3–6 photos with
required labeled shots and the image pipeline — storage adapter, worker variants,
private originals and replaceable watermark step (FR-74, FR-74a/c/d), listing
moderation (FR-19, FR-54 listing actions), the temporary high-value
email-verification gate (FR-08a, FR-19b), and manual identity verification for
first payout (FR-66/FR-66a). The Verified badge remains manual interim (FR-18/18a).
Video (FR-75–FR-75c) and story/voice (FR-76/76a) are deferred to
`END_OF_PHASES_REVIEW.md`.

**Frontend:** structured measurement fields · fabric/material, brand, color,
embellishment fields · evidence upload step + Verified badge display · reframe
`/verification` · photo upload enforcing 3–6 photos · moderation queue UI.
Video and story sections wait for the discussion.

**Security rows to close:** SEC-12 (listings), 17, 18, 19, 20, 30 (ID documents
private with short-lived signed links).

**Decisions needed first:** none for photo listings using the approved storage
adapter and manual watermark placeholder. Document retention/legal advice is
needed only before a future flow stores identity documents; video and voice
remain deferred. Verified-badge criteria is not needed (manual interim).

**Dated implementation backlog (owner decisions 2026-10-21; no rows are ticked):**
listing revision contract per the approved listing-revisions plan (one open
revision per listing; every edit including price goes through moderation) ·
labeled required photo slots and moderator confirmation · replaceable watermark
step with placeholder mark and private clean originals · storage adapter (local
disk initially; S3-compatible backend later). Keep Phase 2 routes unavailable to
real users until authentication is complete.

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
manual identity verification before the first payout FR-66/66a), the settlement reconciliation job
(FR-70), append-only ledger writes (FR-79f), two-way reviews after Completed (FR-27b).

**Frontend:** buyer "report an issue" · admin HELD view with countdown and
open-dispute flag · seller net-payout visibility (Held vs Released) · admin
settlement and payout screens · two-way reviews from the completed Orders page.

**Security rows to close:** SEC-30, 34 (audit trail on every money change), 27, 35.

**Decisions needed first:** confirm partial refunds (FR-45a, FR-50a, FR-71) ·
lost-parcel recovery (FR-72e) · refusal/return flow and return shipping cost (FR-33b) · delivery fee on a full
refund (FR-72a) · chargeback liability (FR-72b) · funds held for a seller who never
completes the required temporary email verification (FR-72c).

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
FR-79c, FR-79g) · WAF/bot protection (FR-84b, Phase 6) · deployment
reliability (several instances, health checks, graceful shutdown) · monitoring
with log redaction · load tests against the SLO targets · runbooks for refunds and
payouts · final dependency audit.

**Frontend:** no public source maps · CSP check · bundle-size and Lighthouse
budgets in CI · real-user performance tracking · final watermark · sweep of the
whole gap list.

**Security rows to close:** every remaining row — SEC-05, 14, 21, 26, 31, 32, 37.

**Decisions needed first:** RLS (SEC-14) · load-test targets. The replaceable
placeholder watermark step is approved; final brand artwork is still needed.

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
appears. Video and story/voice (FR-75–FR-76a) are deferred to
`END_OF_PHASES_REVIEW.md`. "Automatic cash-remittance reconciliation" is
obsolete (no COD). See that review for post-phase decisions.

## External dependencies (lead time outside our control)

| Needed | Before |
|---|---|
| Initial hosting is Render (decided); PostgreSQL hosting, Redis if required, CDN, storage, connection configuration | Before the first deployment |
| Email provider(s) for two-factor codes (+ a second for failover) | Before the first real login |
| Storage adapter: local disk initially; production S3-compatible backend later | Phase 2 / before launch respectively |
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
