# Phase 6.5 launch-readiness audit

Audit base: `673dd3b7c45320d0544cd7c9276026d6561dbdb2` (`origin/main`).
Branch: `review/phase6-5-launch-audit`. This is a read-only audit of code. No
checkboxes were changed. Evidence below is repository paths with line numbers,
named test titles, and raw command summaries.

## Summary by class

Status classes: `DONE_WITH_TEST` means code exists and a named test exists;
`DONE_NO_TEST` means code exists without a named test; `PARTIAL` means an
implementation exists but the stated requirement is incomplete; `MISSING`
means no implementation was found; `INFRA` requires provider/hosting/owner
action; `DECISION` needs an owner decision.

| Inventory | DONE_WITH_TEST | DONE_NO_TEST | PARTIAL | MISSING | INFRA | DECISION | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Backend and infrastructure | 1 | 6 | 9 | 4 | 5 | 0 | 25 |
| B. Frontend launch items | 0 | 2 | 3 | 2 | 0 | 0 | 7 |
| C. Unticked security rows | 0 | 6 | 16 | 0 | 1 | 1 | 24 |
| D. Other unticked specs rows (excluding the 16 Phase 6 focus rows) | 60 | 22 | 2 | 37 | 1 | 53 | 175 |
| E. CI and automation | 0 | 3 | 1 | 2 | 0 | 0 | 6 |

For D, an ad-hoc Node command scanned every unchecked `specs.md` row (191
total), extracted its leading FR code, and searched test titles in
`backend/test` and `frontend/src`. It also searched implementation references
in `backend/src`, `backend/db`, `backend/scripts`, `frontend/src`, and
`frontend/scripts`; explicit open/deferred/superseded tags, explicit partial
notes, and infrastructure language were classified separately. Sixteen
Phase 6 rows are itemized in A and excluded from D. The class totals are an
inventory aid, not a proposal to tick rows mechanically; test-title presence
is necessary but not sufficient evidence that the full sentence is asserted.

## A. Backend and infrastructure inventory

| Item | Class | Evidence and remaining work |
|---|---|---|
| FR-52 Admin user management | DONE_NO_TEST | `src/modules/admin.service.js:35-40` delegates suspension; `src/routes/admin.routes.js:270` exposes suspension. No test title names FR-52; view/reinstate coverage is not demonstrated by an FR-52 test. |
| FR-53 seller-application administration | DONE_NO_TEST | `src/modules/admin.service.js:42-44`, `src/routes/admin.routes.js:482-489`; existing FR-07 and FR-05a test titles do not name FR-53. |
| FR-54 listing moderation and Verified badge | DONE_NO_TEST | `src/modules/admin.service.js:145-159`, `src/routes/admin.routes.js:494-502`; the relevant implementation exists, but no test title names FR-54. |
| FR-55 cross-platform operations overview | DONE_NO_TEST | `src/modules/admin.service.js:162-168`, `src/routes/admin.routes.js:506`; no test title names FR-55. |
| FR-56 dispute/return administration | DONE_WITH_TEST | `src/modules/admin.service.js:171-179`; named tests include `FR-56: buyer, seller, and Admin reads expose event timelines without Admin IDs` and `FR-56: Moderator can read the no-store dispute queue but cannot decide disputes` in `test/integration/dispute-resolution.test.js`. |
| FR-57 delivery-partner configuration | DONE_NO_TEST | `src/modules/admin.service.js:181-188`, `src/routes/admin.routes.js:530`; FR-57 test titles found concern chargebacks, not delivery-partner configuration, so they do not justify a tick for this row. |
| FR-58 fees / featured-listing pricing | PARTIAL | Commission percent is implemented in `src/modules/admin.service.js:190-195` and has `FR-58: commission.update grants are created...` / `FR-50, FR-58: a valid grant updates commission...` tests in `test/integration/settlement-core.test.js`. Featured-listing pricing is not implemented in the delivered code. |
| FR-79 managed Postgres, failover and recovery targets | INFRA | `specs.md:222`; no database provider or recovery plan is provisioned. The RPO/RTO targets require owner verification on the selected managed plan. |
| FR-79a immutable backups, restore tests and drills | INFRA | `specs.md:223`; no backup provider, weekly restore automation, or quarterly drill evidence/runbook was found. |
| FR-79b migration safety | PARTIAL | `backend/package.json:20-22` provides separate migration and schema-check commands; named tests include `FR-79b: a fresh database applies the ordered schema in one migration run` in `test/integration/migration-runner.test.js`. The full expand/switch/contract, lint, and old-code/new-schema compatibility requirements are not evidenced as complete. |
| FR-79c PgBouncer and pool behavior | INFRA | Pool bounds/timeouts/503 behavior are implemented in `src/db.service.js:12-36,53-68` and tested by `FR-79c: pool has bounded size and short connection, statement, idle, and lock timeouts` and `FR-79c: pool acquisition timeout becomes a 503 service error`. There is no provisioned PgBouncer endpoint or test against the actual PostgreSQL + PgBouncer deployment configuration; worker `useListenNotify` also needs that compatibility check (`src/lib/queue.js:153-160`). |
| FR-79d counters buffered through Redis | MISSING | `specs.md:226`; no Redis counter-buffer/flush implementation or matching test was found. |
| FR-79g private network, verified TLS and roles | INFRA | `specs.md:229`; `src/db.service.js:12-33` constructs pools from `DATABASE_URL` without explicit TLS certificate options. No provider network boundaries or least-privilege production role provisioning is evidenced. |
| FR-79h Render architecture and deployment checks | INFRA | `specs.md:230`; Render is the recorded hosting decision, but no live service/database/CDN/storage configuration or pre-deployment verification evidence exists. |
| FR-80 Postgres full-text search and indexed filters | DONE_NO_TEST | Search implementation exists in `src/modules/discovery.service.js`; named coverage found is for FR-80a, not the exact FR-80 row. No FR-80 load-test threshold evidence exists. |
| FR-84b WAF/bot protection and existing protections | PARTIAL | Bounded Argon2id and rate-limit components exist (`src/lib/passwordHashPool.js`, `src/middleware/rateLimit.js`) with `FR-84b: password hashing uses a bounded worker pool` in `test/unit/password-hash-pool.test.js`. WAF/bot protection is not provisioned or implemented; real production Redis and host benchmark checks remain. |
| Multi-instance behavior | PARTIAL | Redis-backed rate limits (`src/middleware/rateLimit.js`) and PostgreSQL durable queue/schedules (`src/lib/queue.js`, `worker.js:24-68`) share state. `SEARCH_SINGLE_FLIGHT` in `src/modules/discovery.service.js:26` is process-local (optimization only); `lib/eventBus.js` listeners are in-process, and `open-questions.md:85` records the fire-and-forget FR-45g payout-hold pause gap. No multi-process deployment or PgBouncer test was found. |
| Health/readiness | PARTIAL | Queue health exists at the Admin-only `GET /api/admin/queue/health` endpoint (`src/routes/admin.routes.js:517`), but there is no general load-balancer health/readiness endpoint. |
| Web graceful shutdown | PARTIAL | `src/server.js:53-75` stops accepting HTTP connections, then stops the queue producer, Redis, password-hash pool and database pools. There is no configured overall shutdown deadline; an active request can hold `server.close()` open. |
| Worker graceful shutdown | PARTIAL | `worker.js:186-205` invokes queue stop, producer stop and Redis stop on SIGINT/SIGTERM. Pg-boss graceful stop has a 30-second timeout (`src/lib/queue.js:221-224`); the worker does not explicitly close `db.service` pools or set a total process-drain deadline. |
| Monitoring, structured logs and redaction | PARTIAL | Request IDs are set and propagated (`src/middleware/requestId.js:4-9`, `src/lib/queue.js:233-236`); error handler logs request ID, error name and code (`src/middleware/errorHandler.js:28-39`). No metrics backend or external error-reporting integration was found. A refund alert logs explicit refund/order IDs, trigger and error code (`src/modules/escrowPayments.service.js:1464-1470`). `security.md:115` says `payout.service.js` logs an error object, but current `payout.service.js` has no logger/console calls; the broader SEC-27 review remains open. |
| Load tests and targets | MISSING | No load-test script/tool or CI job was found. The only benchmark script is `scripts/benchmark-argon2.js`, not a service load test. Proposed SLO values are recorded in `open-questions.md:90`. |
| Refund runbook | MISSING | No refund runbook document was found; `LIVE_CHECKS.md` is deployment verification, not an operator refund procedure. |
| Payout runbook | MISSING | No payout runbook document was found; `LIVE_CHECKS.md` has a key backup/rotation check, not an operator payout procedure. |
| Final dependency audit | PARTIAL | Backend `npm.cmd audit --omit=dev` reports three moderate advisories in `node-pg-migrate` 9.0.0's `glob`/`minimatch` tree. This matches the explicit SEC-31 owner exception in `security.md:123-125`, re-accepted 2026-11-19 until the next check on/after 2026-12-10. Frontend audit reports zero vulnerabilities. |

FR-79e and FR-79f are already ticked in `specs.md:227-228`, so they are not
counted as unticked Phase 6 rows. FR-79f's named evidence is
`FR-79f/SEC-30: key rotation encrypts and scrubs legacy plaintext columns` in
`test/unit/payout-encryption.test.js`.

## B. Frontend launch inventory

| Item | Class | Evidence and remaining work |
|---|---|---|
| No public source maps | DONE_NO_TEST | `frontend/vite.config.js:13` sets `sourcemap: false`. Production build completed; scan output: `dist_map_files=0`, `sourceMappingURL_comments=0`. There is no named source-map test. |
| CSP | PARTIAL | API/snapshot responses use `helmet()` in `backend/src/app.js:25-28`; `test/smoke/app.test.js` has `SEC-23 asserts Helmet security headers and CSP`. Static hosting is separate and must set its own CSP. `frontend/index.html:11` has only an external module script and no inline script/style; the production host still needs a tested policy compatible with API, fonts and image origins. |
| Bundle-size budget in CI | DONE_NO_TEST | `frontend/scripts/check-public-bundle.js` is called by `frontend/package.json` and both `.github/workflows/backend.yml:60` and `.github/workflows/phase0.yml:72`. Current result: largest public route 81.2 KB gzip against 200 KB. |
| Lighthouse budget in CI | MISSING | No Lighthouse configuration, script or workflow step was found. |
| Real-user performance tracking | MISSING | No RUM/web-vitals collector or reporting provider was found. |
| Final watermark | PARTIAL | `backend/src/modules/media.service.js:14-18,41-62` applies a replaceable POSHAAK placeholder to variants; `test/unit/media.service.test.js` has `FR-74b: placeholder watermark is explicit and replaceable`. Final approved brand artwork remains outstanding (`Phases.md:487-488`, `open-questions.md:149`). |
| Gap-list sweep | PARTIAL | The actionable list is in `specs.md`, section “Prototype gap-analysis action items” (25 unchecked rows); `PHASE4_GATE_REPORT.md` also has the earlier gap list. `MASTER_PROJECT_CONTEXT.md:209` refers to an 18-item gap list in specs. No separate standalone gap-list document was found, and a complete sweep is not evidenced. |

## C. Every unticked row in security.md

| Row | Class | Evidence; remaining gap |
|---|---|---|
| SEC-01 | PARTIAL | `src/lib/passwordHashWorker.js:2-13`; tests `FR-01, SEC-01: server-side password hashing at registration` and `FR-01, SEC-01: registration stores a server-generated Argon2id password hash`. Production TLS is not verified (`security.md:50`). |
| SEC-02 | PARTIAL | `src/lib/jwt.js` and `test/unit/jwt.test.js` (`SEC-02: rejects missing or short external signing secrets`); signing-key rotation plan/runbook remains absent (`security.md:52`). |
| SEC-06 | DONE_NO_TEST | Access tokens are held in `frontend/src/lib/api.js:4,152-154`; `frontend/src/lib/api.test.js:177,247` checks no global localStorage object in test contexts. Search uses localStorage only for recent searches (`frontend/src/SearchPage.jsx:11,22`). No test title names SEC-06. |
| SEC-08 | PARTIAL | Redis-backed atomic limits are in `src/middleware/rateLimit.js`; tests include `SEC-08: concurrent requests share atomic per-IP and per-account limits` and email-code cap tests in `test/integration/rate-limit.test.js`. Remaining global/dispute/proxy coverage and production Redis verification are noted in `security.md:64`. |
| SEC-11 | PARTIAL | Admin permission walker is `test/unit/admin.routes.permissions.test.js`; `security.md:73` records uncovered payment and delivery routes that only require login. Full non-public route audit remains. |
| SEC-12 | PARTIAL | Tests `SEC-12: every conversation/message ID route denies a stranger`, `SEC-12: inbox and message keyset pages are participant-scoped and report unread counts`, and listing-photo/evidence ownership tests exist. The full set of object-ID routes is not demonstrated (`security.md:75`). |
| SEC-13 | PARTIAL | Named-field parsing is used in routes, but `src/routes/admin.routes.js:489` passes `...req.body` to seller review and other routes also accept/spread request bodies. Full mass-assignment audit is not complete (`security.md:77`). |
| SEC-14 | DECISION | Explicitly not adopted, awaiting owner confirmation (`security.md:79`; `open-questions.md:89`). Do not implement or tick without that decision. |
| SEC-15 | DONE_NO_TEST | Existing service SQL uses bound parameters; the security note identifies two fixed-string template queries (`security.md:84`). No test title naming SEC-15 was found. |
| SEC-16 | PARTIAL | Tests include `SEC-16: login validates its boundary and does not accept extra fields` and `SEC-16: verification endpoints reject unknown fields and malformed emails`; they do not cover every route/input class (`security.md:86`). |
| SEC-17 | DONE_NO_TEST | React-rendered text and API JSON responses plus Helmet/CSP exist (`src/app.js:25-28`; no `dangerouslySetInnerHTML`/`innerHTML` use found in frontend source). No test title names SEC-17. |
| SEC-18 | PARTIAL | Upload code verifies magic bytes, size and image format, re-encodes and strips metadata (`src/modules/media.service.js:6-9,41-62`); private-original storage is implemented. Production object storage/private bucket and the complete row-level upload validation proof remain. |
| SEC-19 | PARTIAL | Secure upload path exists, but legacy service paths still persist caller-provided image/evidence URLs (`src/modules/listings.service.js:378-381,496-499`). Arbitrary URL acceptance is therefore not closed (`security.md:92`). |
| SEC-20 | DONE_NO_TEST | No backend outbound fetch of user-supplied URLs was found; no SSRF test title exists. Reassess if server-side URL fetching is introduced. |
| SEC-21 | PARTIAL | `helmet()` supplies HSTS among API headers (`src/app.js:27`; header test is under SEC-23). `src/db.service.js:12-33` has no explicit TLS/certificate verification settings, and production config (`src/config.js:107-139`) does not require verified Postgres TLS. Static HTTPS/HSTS deployment is unverified. |
| SEC-24 | PARTIAL | Redis limits and named tests exist (`test/integration/admin-rate-limits.test.js`, `test/unit/admin-ops-rate-limit-guard.test.js`). Broad global/dispute limits and correct deployed proxy forwarding are not established (`security.md:105`). |
| SEC-26 | DONE_NO_TEST | Secret-looking scan covered tracked text files and the built frontend. No private-key marker, cloud-key ID, GitHub/Slack/Stripe token, or JWT-like value matched. There were 21 generic credential-assignment-pattern matches, all in test files; values were not printed. Fourteen `VITE_` references were found in docs/source/build paths and are public configuration references, not secret values. No automated secret scan/test was found. |
| SEC-27 | PARTIAL | `test/unit/http-hardening.test.js` title `SEC-27/28 logs only redacted metadata and returns a generic 500 with request id`, plus `SEC-27: seven provider failures persist only safe codes...`, provide focused evidence. Current logs are not audited across all routes/workers; the stale `payout.service.js` note is described in A. |
| SEC-29 | PARTIAL | Safe projections exist in user/order/payout paths, but no complete response-column audit or test title naming SEC-29 was found (`security.md:118`). |
| SEC-32 | DONE_NO_TEST | `frontend/vite.config.js:13`, production build and zero-map/zero-comment scan support the requirement. No named SEC-32 test exists. |
| SEC-33 | PARTIAL | Fake-provider tests include `FR-77b, SEC-33: a valid signed event stores exact bytes and queues one job without funding the order`, stale-signature rejection and parallel duplicate delivery (`test/integration/payment-webhooks.test.js`). No live payment-provider signature adapter exists and no named test proves constant-time comparison (`security.md:132-133`). |
| SEC-34 | PARTIAL | Tests cover client amount tampering, refund bounds and append-only records (`test/integration/reservations.test.js`, `test/integration/migration-runner.test.js`). Full money-state transaction/idempotency coverage is incomplete (`security.md:134`). |
| SEC-36 | PARTIAL | `test/unit/route-cache-policy.test.js` checks route defaults, but its title does not name SEC-36 and it does not prove that money data is never read from a cache (`security.md:139-140`). |
| SEC-37 | INFRA | `src/db.service.js:12-33` does not configure verified TLS. Private networking, distinct least-privilege roles, safe slow-query logging and staging-data policy require provider/owner setup (`security.md:141`). |

## D. Unticked specs inventory and proposed ticks

`specs.md` contains 191 unchecked rows. The 16 Phase 6 focus rows are itemized
in A. The other 175 rows classify by the ad-hoc title/source scan as:

| Class | Rows |
|---|---:|
| DONE_WITH_TEST | 60 |
| DONE_NO_TEST | 22 |
| PARTIAL | 2 |
| MISSING | 37 |
| INFRA | 1 |
| DECISION | 53 |

Rows with open/deferred/superseded tags were kept in DECISION and are not tick
proposals. Rows whose own text records an incomplete requirement remain
PARTIAL even if a test title mentions their FR code. The following primary-code
title matches are grouped by section. They are owner-review candidates only,
not checkbox changes; the named test title is included as evidence:

### Proposed ticks (owner decides)

| Section | Row ID | Named test title |
|---|---|---|
| 1. Identity & Users | FR-02 | `FR-02, FR-83h: buyer password starts email second-factor challenge without issuing a token` |
| 1. Identity & Users | FR-05a | `FR-05a: only Admin can resolve a dispute; Moderator keeps dispute review access` |
| 1. Identity & Users | FR-07b | `FR-07b: seller-application review queue resolves applicant identity from the user profile` |
| 2. Catalog | FR-13 | `FR-13: listConditionTypes returns the fixed 4 types` |
| 2. Catalog | FR-14 | `FR-14, FR-15, FR-15b: listing creation persists title, replica disclosure, attributes, and starts as draft` |
| 3. Listings | FR-15 | `FR-15: listing title is validated, trimmed, and retired fields are rejected on creation` |
| 3. Listings | FR-15b | `FR-14, FR-15, FR-15b: listing creation persists title, replica disclosure, attributes, and starts as draft` |
| 3. Listings | FR-16 | `FR-16: listing images persist through image_url and display_order` |
| 3. Listings | FR-17 | `FR-17: authenticity evidence persists evidence_url with nullable evidence_type` |
| 3. Listings | FR-18 | `FR-18, FR-19a: granting a verified badge persists reviewer metadata independently` |
| 3. Listings | FR-19 | `FR-19, FR-74: three photos submit a draft into the moderation queue` |
| 3. Listings | FR-19a | `FR-19a: approval publishes a submitted listing with reviewer and timestamp` |
| 3. Listings | FR-20 | `FR-20: seller edits supported content but cannot assign system-controlled fields` |
| 3. Listings | FR-21 | `FR-21: rejection stores its reason and reviewer in real listing columns` |
| 3. Listings | FR-21a | `FR-21a: only rejected listings can be resubmitted and their rejection reason remains visible` |
| 4. Search & Discovery | FR-22a | `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset` |
| 4. Search & Discovery | FR-24 | `FR-24: category, condition, and inclusive price filters include zero minimum` |
| 4. Search & Discovery | FR-25 | `FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states` |
| 4. Search & Discovery | FR-27 | `FR-22 through FR-27 public discovery` |
| 4. Search & Discovery | FR-27a | `FR-27a: public seller card exposes rating and join date only` |
| 4. Search & Discovery | FR-27b | `FR-27b two-way reviews` |
| 6. Orders | FR-32a | `FR-32a, FR-63 and FR-63a reservation Buy` |
| 6. Orders | FR-34 | `FR-34 seller reservation-backed order reads` |
| 8. Delivery | FR-42 | `FR-42: tracking is available to order parties and Admins but returns 404 to unrelated users` |
| 9. Disputes, Returns & Refunds | FR-43 | `FR-43, FR-61, FR-62: summary returns filing eligibility and only safe order fields` |
| 9. Disputes, Returns & Refunds | FR-43a | `FR-43a, FR-43b: filing rejects a blank reason and missing, blank, non-HTTPS, credentialed or excess evidence without writing a dispute` |
| 9. Disputes, Returns & Refunds | FR-43b | `FR-43a, FR-43b: filing rejects a blank reason and missing, blank, non-HTTPS, credentialed or excess evidence without writing a dispute` |
| 9. Disputes, Returns & Refunds | FR-43c | `FR-43c: another seller cannot submit counter-evidence for this dispute` |
| 9. Disputes, Returns & Refunds | FR-44 | `FR-44: status filters and cursor pagination return the matching dispute queue` |
| 9. Disputes, Returns & Refunds | FR-45 | `FR-44, FR-45, FR-56 dispute queue and timeline` |
| 8. Delivery | FR-41 | `FR-41, FR-68, FR-72: legacy status logging is Admin-only and rejects reservation-backed orders` |
| 9a. Payout Hold Window | FR-45b | `FR-68, FR-45b, FR-45c: delivery starts one configured hold and writes one delivery log and audit` |
| 9a. Payout Hold Window | FR-45c | `FR-68, FR-45b, FR-45c: delivery starts one configured hold and writes one delivery log and audit` |
| 10. Commission & Settlement | FR-46 | `FR-46, FR-47: Buy snapshots the commission percent on the reservation` |
| 10. Commission & Settlement | FR-46a | `FR-46, FR-46a: calculateCommission applies the global % to item price only` |
| 10. Commission & Settlement | FR-47 | `FR-46, FR-47: Buy snapshots the commission percent on the reservation` |
| 10. Commission & Settlement | FR-48 | `FR-48: two-Admin payout approval` |
| 10. Commission & Settlement | FR-49 | `FR-49, FR-65: seller sees earnings, payout summary and held-funds flag for their own order` |
| 10. Commission & Settlement | FR-50 | `FR-50 Admin commission setting route` |
| 10. Commission & Settlement | FR-50a | `FR-50a: a succeeded partial refund reduces commission and seller net, and the stored refunded_item_amount matches` |
| 11. Notifications | FR-51 | `FR-51, FR-65: processReminders run twice in parallel after moving held_at back 7, then 30, then 90 days produces exactly one in-app notification and one email job per milestone; nothing before 7 days` |
| 12. Administration | FR-56 | `FR-44, FR-45, FR-56 dispute queue and timeline` |
| 13. Escrow Payments | FR-60a | `FR-60a public delivery cities` |
| 13. Escrow Payments | FR-62 | `FR-61, FR-62 buyer order reads` |
| 13. Escrow Payments | FR-65 | `FR-65 reservation-backed dispute-resolution payout outcomes` |
| 13. Escrow Payments | FR-70 | `FR-70: reconciliation re-enqueues orphan inbox rows and executes an orphan requested refund` |
| 13. Escrow Payments | FR-72e | `FR-68, FR-72e: detail exposes delivery, hold, and issue metadata without changing state or emitting events` |
| 16. Queue, worker & process model | FR-77 | `FR-77, FR-77a: PostgreSQL queue durability and worker guarantees` |
| 16. Queue, worker & process model | FR-77a | `FR-77a: orphan refund reconciliation does not enqueue a manual request before approval` |
| 16. Queue, worker & process model | FR-77c | `FR-77c: PostgreSQL queue health reports backlog age and dead-letter visibility` |
| 16. Queue, worker & process model | FR-77d | `FR-77d: notification event listeners enqueue durable jobs` |
| 18. Search & suggestions | FR-80a | `FR-80a: search reflects reservation expiry without a search worker` |
| 19. Frontend delivery & SEO | FR-81a | `FR-81a, FR-82b PostgreSQL page snapshots` |
| 19. Frontend delivery & SEO | FR-82b | `FR-81a, FR-82b PostgreSQL page snapshots` |
| 20. Authentication & two-factor | FR-83d | `FR-83d: email verification code is single-use under concurrent confirmation` |
| 20. Authentication & two-factor | FR-83l | `FR-66 / FR-83l: seller payout disbursement eligibility` |
| 20. Authentication & two-factor | FR-85 | `FR-85: Buy uses the administrator-configured delivery fee in server-calculated snapshots` |
| Prototype gap-analysis action items | FR-74 | `FR-19, FR-74: three photos submit a draft into the moderation queue` |
| Prototype gap-analysis action items | FR-63 | `FR-63: discovery uses database time for new reservations and sold wins over reserved` |
| Prototype gap-analysis action items | FR-60a | `FR-60a public delivery cities` |

### Named test-title matches not proposed for ticking

These are included because a primary-code test title exists, but are not tick
proposals due to a deferred/open decision, a mismatch between the test behavior
and row, or an explicit known gap:

| Section | Row ID | Named test title | Reason not proposed |
|---|---|---|---|
| 1. Identity & Users | FR-04 | `FR-04: city owner lookup includes the city name for address presentation` | The title concerns city-owner lookup, not Admin city configuration. |
| 2. Catalog | FR-14a | `FR-14a: rental listing type is rejected (deferred, not MVP)` | Explicitly deferred. |
| 5. Messaging & Negotiation | FR-29 | `FR-29: offers are disabled by default and accepting one never creates a bag entry` | Explicitly deferred by owner decision. |
| 5. Messaging & Negotiation | FR-29 | `FR-29: offers are disabled by default and accepting one never creates a bag entry` | Duplicate row in the explicitly deferred section. |
| 6. Orders | FR-33b | `FR-33b: Admin records a refusal without changing money or payout state and notifies the seller without Admin identity` | Open product decision; awaiting owner resolution. |
| 9. Disputes, Returns & Refunds | FR-45a | `FR-45a, FR-69: split creates an exact partial refund and exposes the decision without Admin identity` | Open product decision remains unresolved. |
| Open product decisions still blocking full spec | FR-45a | `FR-45a, FR-69: split creates an exact partial refund and exposes the decision without Admin identity` | Duplicate row under the open product decisions section. |
| 9a. Payout Hold Window | FR-45g | `FR-43, FR-45g delivered reservation disputes` | Open-questions note records the non-durable, fire-and-forget pause gap (`open-questions.md:85`). |
| 12. Administration | FR-57 | `FR-57: records an exact-decimal chargeback, reuses the payout hold, and allocates item and delivery amounts` | Chargeback test does not assert delivery-partner configuration. |
| 12. Administration | FR-58 | `FR-50, FR-58: a valid grant updates commission and writes one event with actor and previous/new values` | Commission is implemented/tested; featured-listing pricing is not. |
| 17. Database & reliability | FR-79b | `FR-79b PostgreSQL migration runner` | The migration safety row remains partial; see A. |
| 17. Database & reliability | FR-79c | `FR-79c: pool has bounded size and short connection, statement, idle, and lock timeouts` | PgBouncer provisioning and the real configuration compatibility test remain infrastructure work. |
| 19. Frontend delivery & SEO | FR-82 | `FR-82: custom SEO text remains pending until its listing revision is approved` | The row says no named test asserts the complete rule set. |
| 19. Frontend delivery & SEO | FR-82c | `FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice` | Row says named PostgreSQL redirect coverage was not rerun. |
| 20. Authentication & two-factor | FR-84b | `FR-84b: password hashing uses a bounded worker pool` | WAF/bot protection and production Redis/benchmark evidence remain incomplete. |
| Explicitly deferred to later phases | FR-65 | `FR-65 reservation-backed dispute-resolution payout outcomes` | Explicitly deferred duplicate row; the Section 13 manual-payout row is listed separately above. |
| Open product decisions still blocking full spec | FR-33b | `FR-33b: Admin records a refusal without changing money or payout state and notifies the seller without Admin identity` | Duplicate row under the open product decisions section. |

No security row is proposed for ticking.

## E. CI inventory

| Workflow / concern | Class | What runs; gap |
|---|---|---|
| `.github/workflows/backend.yml` backend job | PARTIAL | Node 22.14.0; `npm ci`; backend unit tests, integration tests, schema check and backend `npm audit --omit=dev`. It provisions PostgreSQL but not Redis, so Redis-dependent integration coverage is not configured in this workflow. |
| `.github/workflows/phase0.yml` backend job | DONE_NO_TEST | Node 22; PostgreSQL and Redis services; unit and integration suites, schema check and backend `npm audit --omit=dev`. |
| Frontend CI | DONE_NO_TEST | Both workflows run `npm ci`, `npm run lint`, `npm test`, `npm run build`, and `npm run check:bundle`. Frontend lint/test/build/bundle budget are not missing. |
| Backend dependency audit in CI | DONE_NO_TEST | Both workflow files run `npm audit --omit=dev` in the backend job. The current backend audit returns nonzero because of the recorded SEC-31 exception. |
| Frontend dependency audit in CI | MISSING | Neither workflow runs `npm audit` in `frontend/`; manual frontend production audit is clean. |
| Lighthouse / RUM CI | MISSING | No Lighthouse budget, performance CI gate, or real-user tracking step exists. |

## Work an agent can do in code

- **Stage 6.6 — security:** SEC-21/26/32 and CSP implementation/configuration
  and tests: production TLS and certificate validation checks; secret-scan
  automation and public `VITE_` guard; source-map build test; CSP alignment
  between API and static host, including browser validation.
- **Stage 6.7 — deployment reliability and monitoring:** health/readiness
  endpoints; bounded graceful shutdown and resource draining; multi-instance
  safety and durable cross-process effects; structured logs and redaction;
  metrics, alerts and request-ID/error-reporting integration.
- **Stage 6.8 — operational readiness:** refund and payout runbooks; load-test
  scripts and approved targets; CI additions; repeat dependency audits and
  document the SEC-31 exception/recheck.
- **Stage 6.9 — frontend launch items:** source-map test; static-host CSP;
  Lighthouse and bundle budget in CI; RUM; keep the replaceable watermark
  placeholder until approved artwork arrives; sweep the specs/gap list and
  document remaining gaps.

## Owner or infrastructure actions

- Provision an appropriate managed PostgreSQL plan with automated failover and
  point-in-time recovery meeting the current proposed RPO/RTO; provision
  immutable off-site backups, weekly restore tests and quarterly recovery
  drills. Do not select a plan without verifying its recovery capability.
- Provision/configure PgBouncer transaction mode and test the actual worker and
  queue behavior against the real PostgreSQL + PgBouncer configuration.
- Provision private database networking, TLS with certificate verification,
  least-privilege web/worker/migrator/read-only/backup roles, and staging data
  controls. Production `DATABASE_URL` alone does not enforce these properties.
- Choose and configure Render (or another approved host), Redis, object storage,
  CDN, domain, static hosting and HTTPS. Redis is required by production
  request-limit paths; CDN and storage provider choices remain open.
- Provision a WAF/bot-protection service and monitoring/logging/alerting/error
  reporting tools; configure secret storage, rotation and operator access.
- Approve final watermark artwork and make the owner’s production/browser
  launch checks. These are not supplied by a code-only change.

## Decisions needed

- **SEC-14 RLS:** `security.md:79` and `open-questions.md:89` explicitly say
  RLS was not adopted and awaits owner confirmation. Keep it a decision; do
  not infer adoption.
- **Load-test targets:** `open-questions.md:90` already proposes browse p95
  below 500 ms, error rate below 1%, search p95 below 300 ms, and cache hit
  above 90%. The owner must approve or revise targets before scripts can
  measure acceptance.

## Raw validation evidence

Commands were run on the verified audit branch. Backend and frontend audit
outputs:

```text
npm.cmd audit --omit=dev  (backend)
3 moderate severity vulnerabilities

npm.cmd audit --omit=dev  (frontend)
found 0 vulnerabilities
```

The backend advisories are the `node-pg-migrate` 9.0.0 transitive `glob` and
`minimatch` exception in `security.md:123-125`; no lockfile was changed.

Production build / source map scan / bundle check:

```text
✓ built in 807ms
dist_map_files=0
sourceMappingURL_comments=0
Largest public route: 81.2 KB gzip (budget: 200 KB)
```

Secret scan covered 424 tracked text files plus built `frontend/dist`; values
were never emitted:

```text
SECRET_SCAN text_files=424 findings=21
backend/test/integration/additional-admin.test.js:9:credential-assignment
backend/test/integration/known-mismatches.test.js:163:credential-assignment
backend/test/integration/known-mismatches.test.js:292:credential-assignment
backend/test/integration/known-mismatches.test.js:293:credential-assignment
backend/test/integration/known-mismatches.test.js:341:credential-assignment
backend/test/integration/known-mismatches.test.js:413:credential-assignment
backend/test/integration/known-mismatches.test.js:589:credential-assignment
backend/test/smoke/app.test.js:57:credential-assignment
backend/test/smoke/app.test.js:64:credential-assignment
backend/test/smoke/app.test.js:70:credential-assignment
backend/test/smoke/app.test.js:75:credential-assignment
backend/test/smoke/app.test.js:87:credential-assignment
backend/test/unit/password-hash-pool.test.js:29:credential-assignment
backend/test/unit/users.auth.routes.test.js:52:credential-assignment
backend/test/unit/users.auth.routes.test.js:58:credential-assignment
backend/test/unit/users.auth.routes.test.js:67:credential-assignment
backend/test/unit/users.auth.routes.test.js:166:credential-assignment
backend/test/unit/users.auth.routes.test.js:169:credential-assignment
backend/test/unit/users.service.test.js:180:credential-assignment
backend/test/unit/users.service.test.js:193:credential-assignment
frontend/src/lib/api.test.js:170:credential-assignment
VITE_SCAN references=14
```

All generic credential-pattern hits are test files; the scan reported types
and paths only, not matched values. `VITE_` results are public-variable
references in repository docs/source/build output, not exposed values.

## Not done

- No application code, tests, configuration, workflows, specs, or
  `security.md` were changed; no checkboxes were changed.
- Backend/frontend full unit/integration suites, frontend lint and browser
  click-through were not run as part of this audit. The build, bundle check,
  two production dependency audits, source-map scan and secret-pattern scan
  were run.
- No live Render/Postgres/PgBouncer/Redis/WAF/CDN/storage/monitoring setup,
  restore exercise, load test, or provider integration was run.
- The 21 generic credential-assignment matches are in test fixtures; their
  values were deliberately not printed. Confirm fixture-only classification
  before a final secrets sign-off.
