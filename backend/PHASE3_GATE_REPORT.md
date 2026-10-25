# Phase 3 gate report (2026-10-25)

Phase 3 is **not closed**. This report maps the Phase 3 scope in `Phases.md`
and the 2026-10-22 owner decisions to current evidence. A test file existing is
not the same as a passing test. The guarded integration suite ran against the
local `testing_only` database and localhost Redis in this refresh: 11 suites
passed, 2 failed; 122 tests passed and 3 failed, with no skipped tests.

The 2026-10-22 owner decisions supersede the former negotiation-only Buy flow.
Fixed-price Buy is the early-site path; Phase 3 only routes a signed-in buyer to
“checkout opens soon”. Offers/negotiation remain dormant behind
`OFFERS_ENABLED` (default off) and are deferred. No Phase 3 action reserves a
listing or charges payment.

## Integration evidence (2026-10-25)

| Requirement | Passing test name or current result |
|---|---|
| SEC-12 | Passed: `SEC-12: every conversation/message ID route denies a stranger`; `SEC-12: inbox and message keyset pages are participant-scoped and report unread counts`; `SEC-12: staff conversation reads require the new permission and an audited reference`; `SEC-12: notification and email work are duplicate-safe and email is throttled per conversation`. The full object-ID route surface remains unproven. |
| SEC-16 | Still unproven as a full integration requirement. The passing `SEC-16` tests are selected smoke/unit route-boundary checks, not comprehensive integration coverage. |
| SEC-24 | Still unproven. The integration rate-limit suite passed, including `conversation Redis limits allow exactly 10 per hour and 30 per day per account` and `message Redis limits allow exactly 10 per minute and 60 per hour per account`; those test titles do not name SEC-24, and the complete SEC-24 scope is not covered. |
| SEC-36 | Still unproven. `test/unit/route-cache-policy.test.js` passed, but the full requirement has no passing integration test naming SEC-36 and the money-data access path remains unverified. |
| FR-22 | Passed: `FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states`. Failed: `FR-22: public listing-detail route serves published listing photos without authentication` — its public search request expected HTTP 200 and received HTTP 503. |
| FR-22a | Passed: `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset`. |
| FR-23 | Failed: `FR-23: keyword search matches title or description on published listings only` — `TypeError: descriptionResults.map is not a function`. `FR-23: search rejects an empty keyword instead of returning every public listing` passed. Overall FR-23 remains unproven. |
| FR-24 | Passed: `FR-24: category, condition, and inclusive price filters include zero minimum`; `FR-24: city filter uses the seller registered city`. |
| FR-25 | Passed: `FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states`. The separate seller-card test passes but asserts the superseded no-alias shape; the approved `display_alias` requirement remains unproven. |
| FR-26 | Passed: `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset`. |
| FR-27 | Passed: `FR-27: public share URL is available without login and does not set cookies`. |
| FR-27a | Still unproven against the owner decision: `FR-27a: public seller card exposes rating and join date only` does not verify the required `display_alias`. |
| FR-28 | Still unproven as a complete requirement. SEC-12 conversation authorization tests passed, but there is no passing integration test title naming FR-28 and covering the full messaging behavior. |
| FR-29 | Failed: `FR-29: offers are disabled by default and accepting one never creates a bag entry` — token signing threw `TypeError: Signing requires at least 32 bytes of key material.` Cleanup also reported a listing/conversation foreign-key violation. FR-29 is superseded by the fixed-price Buy decision; offers remain deferred. |
| FR-30 | Still unproven as a backend integration requirement. The frontend test `contact-detail block is shown as a clear, actionable message` passed, but no passing integration test title names FR-30. |
| FR-31 | Still unproven by a passing named test; offer history is deferred by the owner decision. |
| FR-80 | Still unproven as a complete requirement. The `FR-80a listing search indexing on PostgreSQL` integration suite passed; that does not establish the complete search and filter scope. |
| FR-80a | Passed: the `FR-80a listing search indexing on PostgreSQL` suite, including `publish and moderated price/attribute revisions enqueue versioned, idempotent updates` and `pause, resume, unpublish, and seller removal keep the index aligned with publication`. |
| FR-80b | Still unproven by a passing named integration test. The S13 demo transcript reports a Roman Urdu synonym search, but that is not a passing automated test. |
| FR-80c | Still unproven; no passing test names and verifies the complete approved minimal-suggestions requirement. |
| FR-80d | Still unproven as a complete requirement. Rate-limit integration tests passed, but they do not name FR-80d or cover all global/dispute and deployed-proxy requirements. |
| FR-80e | Still unproven; no passing test names and verifies the complete approved sort set. |
| FR-80f | The FR-80a index suite passed `checkout reservation is indexed and delivery marks the listing sold and removes it`; complete search visibility/badge behavior is still unproven. |
| FR-81 | The React/Vite production build passed. This is build evidence, not a database-backed integration test for all FR-81 behavior. |
| FR-81a | Passed: the `FR-81a, FR-82b PostgreSQL page snapshots` suite; snapshot regeneration and sold/removed snapshot behavior tests passed. |
| FR-81b | Passed: `FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states`; `sold and removed snapshots are noindex, absent from the sitemap, and follow the public 200/410 rules`. |
| FR-81c | Passed: `FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice`; snapshot sitemap/status coverage also passed. Complete robots and filter-indexing behavior remains unproven. |
| FR-82 | Passed: `FR-82: custom SEO text remains pending until its listing revision is approved`. The entire SEO wording/metadata requirement remains unproven. |
| FR-82a | Still unproven; no passing named integration test establishes image alt text and filenames. |
| FR-82b | Passed: the `FR-81a, FR-82b PostgreSQL page snapshots` suite. |
| FR-82c | Passed: `FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice`; complete sitemap/robots behavior remains unproven. |
| FR-82d | Still unproven; no passing named integration test establishes internal linking and the remaining technical SEO checks. |

## Backend requirements

| Phase 3 item | State | Evidence / remaining work |
|---|---|---|
| Public listing browse and details (FR-22) | Parked | The status/detail integration test passed; `FR-22: public listing-detail route serves published listing photos without authentication` failed because the included public search request returned HTTP 503 instead of 200. |
| Login gates for favorites and messaging (FR-22a) | Parked | `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset` passed. Offers are disabled by owner decision and are not an active gate. |
| Keyword search (FR-23) | Parked | The title/description search integration test failed with `TypeError: descriptionResults.map is not a function`; the empty-keyword rejection test passed. |
| Category, condition, price and seller-city filters (FR-24) | Parked | Both named `FR-24` integration tests passed. The product decision is resolved: city comes from `users.city_id`, not a listing city. |
| Listing detail, status, sold suggestions and seller card (FR-25) | Parked | `FR-22, FR-25: listing status/detail distinguish available, paused, sold, reserved and removed states` passed. The seller-card assertion still omits the approved `display_alias`; the full requirement is unproven. |
| Favorite add/remove and keyset pagination (FR-26) | Done (with evidence) | Unit tests and `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset` passed. End-to-end coverage is available; broader checklist ticking is still subject to the same-commit hook rule. |
| Public share link (FR-27) | Parked | `FR-27: public share URL is available without login and does not set cookies` passed. |
| Public seller card (FR-27a) | Parked | The 2026-10-22 owner decision includes `display_alias`, rating and join date. The existing named test asserts only rating and join date, so it no longer verifies the approved requirement. |
| Listing-linked messaging (FR-28) and contact-detail blocking (FR-30) | Parked | SEC-12 conversation integration tests passed and frontend test `contact-detail block is shown as a clear, actionable message` passed. Full FR-28/FR-30 behavior is not established by a passing test naming each requirement. |
| Negotiation-only sale, offers and offer history (FR-29, FR-31) | Deferred | FR-29 is superseded. Offers/negotiation and their history are deferred behind `OFFERS_ENABLED` (default off); fixed-price Buy is the approved early-site path. |
| PostgreSQL full-text search and indexed filters (FR-80) | Parked | The FR-80a PostgreSQL index suite passed; complete FR-80 search/filter behavior remains unproven. |
| Search index, queue synchronization and reconciliation (FR-80a) | Parked | The `FR-80a listing search indexing on PostgreSQL` suite passed, including publish/revision synchronization and publication-state alignment. |
| English/Roman Urdu tolerance and synonyms (FR-80b) | Parked | Product scope is decided; current passing evidence does not establish the complete search behavior. |
| Minimal suggestions (FR-80c) | Parked | The approved scope is a worker-built versioned vocabulary of categories, brands, fabrics, colors and synonyms, plus browser-only recent searches. Trending, popular-search mining and “did you mean” are not in scope; no passing test in this refresh names and verifies the complete requirement. |
| Search load protection (FR-80d) | Parked | `test/unit/rate-limit.test.js` passed account/IP counter, fail-closed and account-cap tests. Global/dispute coverage, real Redis integration and deployed proxy behavior remain unverified. |
| Search sort set (FR-80e) | Parked | Newest, low-to-high price, high-to-low price and query-only relevance are approved; popularity is deferred. The current frontend suite does not test the full sort behavior. |
| Sold hidden / reserved badged in search (FR-80f) | Parked | The FR-80a integration suite passed its reservation/sold index test; the full search visibility and badge requirement remains unproven. |
| Listing detail/status freshness up to 10 seconds; search/category freshness up to 60 seconds (FR-73a) | Parked | The 2026-10-22 freshness decision supersedes the earlier version-pointer design. `test/unit/route-cache-policy.test.js` passed its API cache-header walker, but current evidence does not assert the complete endpoint-specific freshness limits. Production behavior is also pending. |
| Version-pointer/cache hardening proposals (FR-73b–FR-73c) | Deferred | The owner did not adopt these proposals. Do not implement their version pointers, Redis status model, stale-if-error behavior or proposed cache lifetimes without a new decision. |
| Proposed route-cache walker requirement (FR-73d) | Parked | The route walker passes locally, but its test title does not name FR-73d and the row remains tagged DISCUSS. Do not tick it on the basis of an adjacent test. |
| React + Vite delivery (FR-81) | Done (with evidence) | `npm run build` passed with Vite; the current production build is React/Vite. |
| Worker-generated snapshots (FR-81a) | Done (with evidence) | The `FR-81a, FR-82b PostgreSQL page snapshots` integration suite and `test/unit/page-snapshots.test.js` passed. Production serving remains a live check. |
| Sold page and moderator removal behavior (FR-81b) | Parked | Backend integration tests for listing status/detail and snapshot HTTP 200/410 behavior passed; frontend test `sold and removed listings have distinct rendering states` passed. The full row remains open for remaining production behavior. |
| Slugs, canonicals, sitemap, robots and filter indexing (FR-81c) | Parked | `FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice` and PostgreSQL snapshot sitemap tests passed. Complete robots and filter-indexing behavior remains unverified. |
| SEO wording rules (FR-82) | Parked | The owner-approved recommendation, Replica, contact-detail, length and formatting rules are recorded in `specs.md`. The frontend SEO validation test and backend `FR-82` unit tests passed, but not every rule in the full row has a passing named test. |
| Image alt text and filenames (FR-82a) | Parked | No final owner decision or passing test establishes this behavior. |
| Product/Offer/Breadcrumb structured data, without ratings (FR-82b) | Done (with evidence) | The `FR-81a, FR-82b PostgreSQL page snapshots` integration suite and matching unit tests passed; coverage asserts Product, Offer, PKR, availability, condition, brand, color, BreadcrumbList and absence of rating data. |
| URL/canonical/indexing decisions (FR-82c) | Parked | `FR-82c: canonical listing detail redirects an old slug and returns SEO recommendation and choice` passed; complete sitemap/robots behavior remains unverified. |
| Internal linking and remaining technical SEO checks (FR-82d) | Parked | Language choice is resolved (English and Roman Urdu search, English-only UI; Urdu script/RTL deferred). Internal-linking and remaining technical checks are still open. |

## Frontend work items

| Phase 3 item | State | Evidence / remaining work |
|---|---|---|
| Replace legacy Add-to-bag with login-gated Buy and “checkout opens soon” (FR-22b / owner decision) | Done (with evidence) | Frontend tests `Buy redirects guests to login and returns them to the listing`, `Buy sends signed-in users to checkout state` and `login return path accepts internal paths only` passed. They do not name an FR code, so no FR checkbox was added. |
| Favorite and Chat login gates | Parked | Backend/database authorization needs the guarded integration rerun; the Buy redirect tests do not prove these actions. |
| Display alias, rating and join date on the seller card | Parked | The approved decision is documented, but current backend tests assert the no-alias shape. |
| Chat polling intervals and cleanup | Done (with evidence) | Frontend tests `chat and inbox polling use the decision intervals` and `polling cleanup clears the scheduled timer` passed. Messaging authorization is tracked separately above. |
| Offer screens and negotiation interactions | Deferred | Offers/negotiation are disabled by default and deferred by the 2026-10-22 owner decision. |
| Search sort and minimal suggestions UI | Parked | Product behavior is decided; no current frontend test proves the complete sort/suggestion set. |
| Sold/removed listing rendering | Done (with evidence) | Frontend test `sold and removed listings have distinct rendering states` passed. Database status and 410 coverage remains parked above. |
| Route-level splitting, self-hosted fonts and public-JavaScript budget | Done (with evidence) | Vite production build passed; `npm run check:bundle` reported largest public route 75.1 KB gzip against the 200 KB budget. Build output includes self-hosted DM Sans and Playfair Display fonts. |
| Lighthouse budgets and real-user performance tracking (remaining FR-81d work) | Parked | Not demonstrated by the build or bundle check. |
| SEO text chooser validation | Done (with evidence) | Frontend test `SEO chooser validation enforces live length and replica guardrails` passed; full FR-82 wording remains parked above. |

## Security rows in the Phase 3 plan

| Security item | State | Evidence / remaining work |
|---|---|---|
| SEC-12 object-level authorization | Parked | The four named SEC-12 conversation integration tests passed. The full object-ID route surface remains unproven. |
| SEC-16 route-boundary validation | Parked | Named SEC-16 smoke/email/reset tests passed for selected boundaries. They do not cover the full route and validation scope required by the row. |
| SEC-17 XSS/output handling | Parked | No complete review or test evidence for the full API and frontend requirement was produced in this documentation task. |
| SEC-24 rate limiting | Parked | Redis-backed conversation/message rate-limit integration tests passed, but their titles do not name SEC-24; complete global/dispute coverage and deployed proxy forwarding remain unverified. |
| SEC-36 cache policy | Parked | The route walker passed and checks private/no-store defaults plus no cookies on public allow-listed routes. Its title does not name SEC-36 and it does not prove the money-data access path; leave the checkbox open. |

## Product decisions, deferred work and live checks

| Phase 3 item | State | Evidence / remaining work |
|---|---|---|
| Seller city as discovery city; sold items hidden and reserved items badged | Done (with evidence) | Owner decisions are recorded in `DECISIONS_2026-10-22.md`, `open-questions.md` and `specs.md`. Runtime/database verification remains parked above. |
| SEO titles/descriptions, structured data, URLs, canonicals and indexability | Done (with evidence) | The owner decisions are documented; implementation/test status is separately mapped under FR-81/82 above. |
| CDN provider selection and production snapshot-serving/purge model | Live-check pending | No provider is selected. Verify production routing, no-cloaking behavior, cache freshness and purge delivery in `LIVE_CHECKS.md`. |
| Production cache freshness and deployed CDN behavior | Live-check pending | Verify the approved 10-second detail/status and 60-second search/category freshness limits against the deployed origin/CDN. |
| Integration test rerun with approved `TEST_DATABASE_URL` (and `TEST_REDIS_URL` where required) | Open | Ran on 2026-10-25 against the local `testing_only` database and localhost Redis: 11 suites passed, 2 failed; 122 tests passed, 3 failed; none skipped. The three failures and reasons are recorded above. |
| Offers, counters, offer acceptance/history, Urdu script/RTL, popularity, trending, “did you mean”, real-time chat, video and voice | Deferred | Owner decisions and deferred scope are recorded in `open-questions.md` and `END_OF_PHASES_REVIEW.md`. Video and voice remain FR-75–FR-76a deferrals. |

## Verification run (2026-10-25)

Commands ran from the respective package directories:

- Backend unit and smoke: `npm.cmd test -- --runInBand`
  - `Test Suites: 46 passed, 46 total`
  - `Tests:       569 passed, 569 total`
  - `Snapshots:   0 total`
- Guarded PostgreSQL integration: `npm.cmd run test:integration -- --runInBand`
  - `Test Suites: 2 failed, 11 passed, 13 total`
  - `Tests:       3 failed, 122 passed, 125 total`
  - `Snapshots:   0 total`
  - No tests were skipped. Failures: FR-23 keyword search (`descriptionResults.map is not a function`); FR-22 public listing-detail test (`/api/discovery/search` returned 503 instead of 200); FR-29 offers test (token signing rejected key material shorter than 32 bytes; cleanup also hit a listing/conversation foreign-key violation).
- Backend schema: `npm.cmd run db:check-schema` — passed (exit 0).
- Backend production dependency audit: `npm.cmd audit --omit=dev` — 1 high-severity `body-parser` advisory (versions 2.0.0–2.3.0).
- Frontend production dependency audit: `npm.cmd audit --omit=dev` — `found 0 vulnerabilities`.
- Frontend: `npm.cmd test`
  - `# tests 16`
  - `# pass 16`
  - `# fail 0`
- Frontend lint: `npm.cmd run lint` — passed.
- Frontend production build: `npm.cmd run build` — passed.
- Public bundle: `npm.cmd run check:bundle` — passed; largest public route was
  `75.1 KB gzip (budget: 200 KB)`.

This refresh also did not run production-provider or deployment checks. No push
or production-readiness claim is made.
