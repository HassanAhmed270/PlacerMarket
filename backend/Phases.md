# Phases.md — build order (backend and frontend in parallel)

Created 2026-10-13, **consolidated 2026-10-14** with the Poshaak scale, auth and
listing-media decisions. **Current phase: 3** (Phase 3 gate remains open; see
`PHASE3_GATE_REPORT.md`).

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

**Payment model — escrow, replaces COD (owner decisions 2026-10-25).** A fixed-
price Buy creates a `reserved` listing/order state directly (temporary legacy
`Bag` alias); no accepted offer is required. Flow (FR-62): Buy → reservation →
payment → Funded only from a verified webhook → ship → Delivered (admin marks it,
FR-68) → hold/complaint window → Completed. The reservation window starts at 60
minutes, configurable; the active-unpaid cap is 3, configurable. Buyer payments
are adapter-based; cards first is provisional (D1), wallets/bank later. Seller
payouts stay manual under FR-65. The platform absorbs gateway fees (FR-64).
Manual refunds require two distinct authenticator-verified Admins; system refunds
use a separate idempotent path. D2's additional-admin and payment-enable gates
remain provisional. See `DECISIONS_2026-10-25.md` and `open-questions.md`.

**Scale program (10K concurrent visitors).** One codebase, two processes:
`server.js` and `worker.js`; a Postgres-backed queue behind `lib/queue.js`;
Redis, object storage and a CDN from day one; managed Postgres with failover; a
real migration runner; Postgres full-text search; worker-generated HTML
snapshots; edits to live listings go through moderation (FR-73–FR-81d).

**Phase 3 owner decisions (2026-10-22):** fixed-price Buy replaces negotiation
as the early-site purchase path; offers remain dormant behind
`OFFERS_ENABLED` (default off) and are deferred. The Phase 3 Buy action is
login-gated and leads to “checkout opens soon”; reservation/payment begin in
Phase 4. Messaging remains in scope with participant-only access, blocked
contact details, polling, and throttled notification email. Search hides sold
items and badges reserved items. English and Roman Urdu search are supported;
the interface is English-only and Urdu script/RTL is deferred. See
`DECISIONS_2026-10-22.md`, `specs.md`, and `open-questions.md`.

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

**Dated implementation backlog (owner decisions 2026-10-21; progress is tracked in `PHASE1_PROGRESS.md`):**
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

**Stage 2 contract (implemented 2026-10-22):** `GET
/api/catalog/sub-categories/:id/measurement-fields` returns active definitions;
Admin-only `GET /api/catalog/sub-categories/:id/measurement-fields/admin`
includes retired definitions; Admin-only `PUT
/api/catalog/sub-categories/:id/measurement-fields` accepts
`{fieldDefs:[{id?,fieldName,unit?,required?,isActive?},...]}`. Omitted unreferenced
fields are removed; omitted fields with stored listing values are retired.
Migration `006_measurement_field_lifecycle.sql` adds `required` and `is_active`.
Stage evidence is in `PHASE1_PROGRESS.md`.

**Stage 3 contract (implemented 2026-10-22):** payout payloads use a versioned
AES-256-GCM envelope with a fresh 12-byte nonce, 16-byte authentication tag,
seller-bound AAD and the key ID stored in the envelope. `KeyProvider` reads the
active ID and base64 key map from environment settings; production startup
rejects absent or malformed key configuration. Migration
`007_payout_encryption_envelope.sql` adds expandable JSONB storage, and
`npm run keys:rotate` rewrites mixed key versions. Keep legacy keys present
until the migration/rollback window is closed; offline backup and a deployment
rotation exercise remain live checks. Stage evidence is in
`PHASE1_PROGRESS.md`.

**Stage 4 contract (implemented 2026-10-22):** Admin-only
`POST /api/admin/sellers/:id/identity-verification` accepts a short note only;
it records `id_verified`, `verified_by`, `verified_at`, and
`verification_note`. CNIC and document fields are rejected. The manual-admin
`IdentityVerifier` is the production implementation; test fake requires
`DEV_FAKES=1` and is forbidden in production. Email verification remains
separate. Migration `008_manual_identity_verification.sql` adds audit columns.
The first-payout identity gate remains for Stage 6. Stage evidence is in
`PHASE1_PROGRESS.md`.

**Stage 5 contract (implemented 2026-10-22):** sellers can start and confirm
encrypted TOTP enrollment; confirmation returns ten random backup codes once,
with only hashes stored. A seller without a factor receives an enrollment-only
session restricted to authenticator setup, confirmation, logout and refresh.
Step-up grants are one-use, expire within 15 minutes (5-minute default), and bind to user, session
and action. Password change, authenticator disable and Admin force-release use
action-specific grants. New-device fingerprints are HMAC-hashed and cause one
encrypted queued email notice. Each new endpoint uses the Redis-backed security
limiter. Migration `009_seller_authenticator_step_up.sql` adds the records and
session markers. Stage 6 completes the payout enrollment/step-up gate and
notification in code, with PostgreSQL leak/access regression still pending.
Stage evidence and unchecked gate rows are in `PHASE1_PROGRESS.md`.

**Stage 6 implementation checkpoint (2026-10-22):** seller payout updates use
AES-GCM envelopes and one-use `payout.update` grants; Admin review sees masked
metadata and recent-change/hold/identity flags; settlement initiation invokes
the identity/authenticator/hold/current-details guard. Migration 010 adds the
display and hold metadata. PostgreSQL integration cannot be claimed until
`TEST_DATABASE_URL` is available; see `PHASE1_PROGRESS.md`.

**Stage 7 implementation checkpoint (2026-10-22):** a separate `/account`
workspace provides seller application, authenticator, backup-code, payout and
Admin review/identity/hold controls. It calls the real API and keeps the
short-lived access token in memory. Existing public catalog markup is unchanged.
The build and frontend checks pass; browser-level behavior is not yet tested.

**Stage 8 implementation checkpoint (2026-10-22):** `DEV_FAKES=1` enables a
development-only encrypted-queue email sender whose decrypted messages are
written to an OS-temporary outbox and exposed at `/api/dev/outbox`; production
refuses the flag. Guarded `demo:seed` and `demo:smoke` scripts implement the
local Phase 1 walkthrough. Service-backed execution is recorded in Stage 9;
the fake does not represent provider delivery.

**Stage 9 verification checkpoint (2026-10-22; refreshed at Stage 11):** backend
unit (38 suites / 441 tests), PostgreSQL integration (77 passed / 4 Redis-only skips), schema
check, both audits, and frontend lint/test/build pass. Local PostgreSQL is up,
but Redis, a development DATABASE_URL and a valid JWT secret are unavailable;
backend startup, demo seed/smoke, and live CORS were therefore not claimed.
Vite returned HTTP 200 at `http://127.0.0.1:5173/`. Exact commands and limits
are in `DEMO_RUN.md`.

**Stage 10 design checkpoint (2026-10-22):** the document-only
`LISTING_REVISIONS_PLAN.md` records a proposed side-copy design for moderated
edits, with illustrative DDL and real-Postgres acceptance tests. It is not an
approved schema or migration; settle its owner questions and reconcile FR-73b–d
before coding.

**Stage 11 handoff (2026-10-22):** `PHASE1_GATE_REPORT.md` maps each dated
implementation-backlog item to evidence, parked work, and live checks. Local
implementation checks passed, but the broader release gate is not closed:
FR-07b, unfinished functional/frontend/security rows, recovery implementation,
and live service/provider checks remain open. Do not expose unfinished Phase 1
or Phase 2 routes to real users.

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

**Owner follow-up (2026-10-22):** Jest 29 -> 30 upgrade (separate small task,
right after Phase 2). The 33 development-tree advisories in the Jest 29 chain
are triaged under SEC-31 and do not block Phase 2. The release stop condition
is a nonzero `npm audit --omit=dev` result in either package.

**Local verification (2026-10-23):** both production audits returned zero.
Full backend audit findings remain dev-only and owner-triaged. The configured
development DB/JWT values, Redis, API, worker, Vite and local CORS were usable;
the 14-step smoke passed. Integration passed with the guarded test database
and local Redis. Phase 2 remains ungated; see `PHASE2_GATE_REPORT.md`.

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] `npm test` green and `npm audit --omit=dev` clean

## Phase 3 — Discovery, messaging and public delivery

**Backend:** public discovery and seller-city filters (FR-22–FR-27a, including
FR-27 share links); listing-linked messaging and contact-detail blocking
(FR-28, FR-30); search/suggestions/sorts (FR-80–FR-80e) with sold hidden and
reserved badged (FR-80f); status freshness (FR-73a); and worker-generated
snapshots and URL/indexability rules (FR-81a–FR-81c). FR-29's negotiation-only
sale path is superseded: offers/negotiation stay off behind
`OFFERS_ENABLED` (default off) and are deferred. FR-31 offer history and
acceptance work is consequently not Phase 3 scope. FR-73b–FR-73c version-pointer
and proposed cache semantics were not adopted. The owner-approved SEO rules are
in `specs.md`; only remaining alt-text/internal-linking details stay open.

**Frontend:** replace legacy Add-to-bag with login-gated Buy and a
“checkout opens soon” state · login gates on Favorite and Chat (offers hidden) ·
seller card with display alias, rating and join date · chat with 15-second
conversation and 60-second inbox polling · sold/removed/paused/reserved status
behavior · approved search sort set and minimal suggestions · route-level code
splitting, public JS budget and self-hosted fonts (FR-81d).

**Security rows to close:** SEC-12 object-level authorization, SEC-16 complete
route-boundary validation, SEC-17 output/XSS handling, SEC-24 complete rate
limiting/proxy behavior, and SEC-36 cache policy. Their partial test evidence
and unchecked state are recorded in `security.md` and `PHASE3_GATE_REPORT.md`.

**Decisions resolved:** sold visibility and reserved badge; seller-city filter;
suggestions/sorts; fixed-price Buy and offers deferral; approved SEO content,
structured data, URLs and indexing; snapshot generation behavior.

**Decisions/live checks still pending:** choose the CDN provider; verify
production snapshot serving and CDN purge behavior; settle the remaining
alt-text and internal-linking details before those details are finalized.

**Gate**
- [ ] Backend FRs above ticked
- [ ] Frontend items above ticked
- [ ] SEC rows above ticked
- [ ] Decisions above resolved
- [ ] Backend unit/smoke, guarded integration, and frontend suites green; `npm audit --omit=dev` clean

## Phase 4 — Fixed-price purchases, reservations, payments, refunds and delivery

**Task 0 — design only.** Reconcile endpoint/request/response contracts and
architecture to the 2026-10-25 decisions; produce the design review and update
the implementation plan. Do not write code, migrations, or schema changes in
Task 0. No live gateway is selected, no legal clearance is claimed, and
`PAYMENTS_ENABLED` remains false in production. D1/D2 are provisional and must
be confirmed before implementation depends on them.

**Stage plan (in order):**
1. Design review: fixed-price Buy → reservation → payment → Funded → fulfillment;
  PaymentGateway boundary, order/refund state transitions, admin controls, API
  contracts, data ownership, security, operational and rollback design.
2. Expand-only migrations: reservation/order/payment/refund/webhook/audit data;
  preserve old COD columns, constraints, and paths until a separately gated
  contract step.
3. Reservation engine: atomic Buy, locked item-price snapshot, one reservation
  per listing, self-purchase refusal, validated structured address, server-side
  PKR 300 configurable fee, three active unpaid reservations per buyer, 60-minute
  configurable expiry, and blocked price-revision approval under a row lock.
4. Gateway adapter and fake: hosted checkout boundary, idempotent payment create,
  test/development fake, and no live provider selection implied.
5. Webhook inbox: raw-body route before `express.json()`, signature verification,
  unique event storage, queueing, safe repeated processing, and verified-payment
  transition.
6. Refunds: full pre-handover cancellation, expiry/late-payment and missed
  handover paths; trigger attribution, idempotency, audit, and manual two-Admin
  authenticator approval subject to D2 confirmation.
7. Delivery admin: manual courier coordination, tracking/status updates, three-day
  seller handover deadline, and Phase 4 manual issue-resolution stopgap for lost
  parcels/refused delivery.
8. Notifications: in-app and rate-limited email for purchase, payment, refund and
  delivery state changes.
9. Frontend: Buy/reservation, payment review, hosted checkout, order state,
  cancellation, tracking, and administrative workflows.
10. Demo: fixed-price purchase, payment webhook, expiry, cancellation/refund,
   handover timeout, and manual delivery exception walkthrough.
11. Gate: all in-scope unchecked FR/SEC rows, backend/frontend checks, audit,
   live-check evidence, and unresolved decision review.

**Security rows to close:** SEC-33, SEC-34, SEC-39, SEC-40; SEC-11 for delivery
permission, SEC-12 for orders/payments, SEC-27 for money-data logging, and SEC-36
where money routes/cache behavior apply.

**External launch dependencies:** payment provider and sandbox, legal clearance
for holding customer funds, provider-specific signature verification, courier
arrangement, two-admin enrollment per D2 if confirmed, and all production
`PAYMENTS_ENABLED` gates. FR-63b is not applicable under fixed-price Buy.

**Gate**
- [ ] Task 0 design review done (design only; no code or migrations)
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
| CDN provider | Before launch (CDN-ready implementation in Phase 3) |
| Payment gateway provider, legal advice on holding funds, sandbox account | Phase 4 |
| Courier partner(s) | Phase 4 |
| Notification channel for general notifications | Phase 4 |
| Speech-to-text / LLM provider, YouTube API audit (only once video/story unblock) | when unblocked |
| Domain, TLS, load-testing and monitoring tools | Phase 6 |

## Decisions parked for later

All tracked in `open-questions.md`: reservation duration · other open offers
(FR-63b) · seller no-ship · FR-33b refusal/return and return shipping · delivery
fee on refunds · chargeback liability · held funds for an unverified seller ·
real-time updates · remaining alt-text/internal-linking details (SEO-GATE).
