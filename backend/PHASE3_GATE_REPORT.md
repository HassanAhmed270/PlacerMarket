# Phase 3 gate report (2026-10-25)

Phase 3 is **not closed**. This report maps the Phase 3 scope in `Phases.md`
and the 2026-10-22 owner decisions to current evidence. A test file existing is
not the same as a passing test; integration-only tests listed below were not
executed in this refresh because the guarded integration harness requires
`TEST_DATABASE_URL`.

The 2026-10-22 owner decisions supersede the former negotiation-only Buy flow.
Fixed-price Buy is the early-site path; Phase 3 only routes a signed-in buyer to
“checkout opens soon”. Offers/negotiation remain dormant behind
`OFFERS_ENABLED` (default off) and are deferred. No Phase 3 action reserves a
listing or charges payment.

## Backend requirements

| Phase 3 item | State | Evidence / remaining work |
|---|---|---|
| Public listing browse and details (FR-22) | Parked | Named PostgreSQL test `FR-22: public listing-detail route serves published listing photos without authentication` exists in `test/integration/known-mismatches.test.js`; the guarded integration run did not start. |
| Login gates for favorites and messaging (FR-22a) | Parked | Named PostgreSQL test `FR-22a, FR-26: favorites require login, add/remove idempotently, and paginate by keyset` exists but was not run. Offers are disabled by owner decision and are not an active gate. |
| Keyword search (FR-23) | Parked | `FR-23: keyword search matches title or description on published listings only` exists in the integration suite; not run in this refresh. |
| Category, condition, price and seller-city filters (FR-24) | Parked | Named `FR-24` integration tests cover category/condition/zero minimum and the seller's registered city. They were not run in this refresh. The product decision is resolved: city comes from `users.city_id`, not a listing city. |
| Listing detail, status, sold suggestions and seller card (FR-25) | Parked | Current `test/unit/discovery.service.test.js` passed its `FR-25` detail/sold-item tests, but the approved seller card now includes `display_alias`; those tests assert the superseded no-alias shape. Update the implementation and assertions, then rerun PostgreSQL integration before checking the row. |
| Favorite add/remove and keyset pagination (FR-26) | Done (with evidence) | `FR-26: add/remove are safe to repeat and keyset pages use a deterministic cursor` and `FR-26: malformed cursors and zero-size pages are rejected` passed in `test/unit/discovery.service.test.js`. End-to-end authorization remains subject to the pending integration rerun. |
| Public share link (FR-27) | Parked | `FR-27: public share URL is available without login and does not set cookies` exists in `test/integration/discovery.test.js`; not run in this refresh. |
| Public seller card (FR-27a) | Parked | The 2026-10-22 owner decision includes `display_alias`, rating and join date. The existing named test asserts only rating and join date, so it no longer verifies the approved requirement. |
| Listing-linked messaging (FR-28) and contact-detail blocking (FR-30) | Parked | Messaging/conversation routes and contact-block UI are present. Frontend test `contact-detail block is shown as a clear, actionable message` passed, but PostgreSQL participant/security coverage did not run, and this run did not establish the full FR-28/FR-30 behavior. |
| Negotiation-only sale, offers and offer history (FR-29, FR-31) | Deferred | FR-29 is superseded. Offers/negotiation and their history are deferred behind `OFFERS_ENABLED` (default off); fixed-price Buy is the approved early-site path. |
| PostgreSQL full-text search and indexed filters (FR-80) | Parked | Backend search/filter integration tests were not executed in this refresh. |
| Search index, queue synchronization and reconciliation (FR-80a) | Parked | `test/integration/listing-search.test.js` exists, but this guarded PostgreSQL suite did not start. |
| English/Roman Urdu tolerance and synonyms (FR-80b) | Parked | Product scope is decided; current passing evidence does not establish the complete search behavior. |
| Minimal suggestions (FR-80c) | Parked | The approved scope is a worker-built versioned vocabulary of categories, brands, fabrics, colors and synonyms, plus browser-only recent searches. Trending, popular-search mining and “did you mean” are not in scope; no passing test in this refresh names and verifies the complete requirement. |
| Search load protection (FR-80d) | Parked | `test/unit/rate-limit.test.js` passed account/IP counter, fail-closed and account-cap tests. Global/dispute coverage, real Redis integration and deployed proxy behavior remain unverified. |
| Search sort set (FR-80e) | Parked | Newest, low-to-high price, high-to-low price and query-only relevance are approved; popularity is deferred. The current frontend suite does not test the full sort behavior. |
| Sold hidden / reserved badged in search (FR-80f) | Parked | The 2026-10-22 product decision is resolved. The database-backed search test was not run in this refresh. |
| Listing detail/status freshness up to 10 seconds; search/category freshness up to 60 seconds (FR-73a) | Parked | The 2026-10-22 freshness decision supersedes the earlier version-pointer design. `test/unit/route-cache-policy.test.js` passed its API cache-header walker, but current evidence does not assert the complete endpoint-specific freshness limits. Production behavior is also pending. |
| Version-pointer/cache hardening proposals (FR-73b–FR-73c) | Deferred | The owner did not adopt these proposals. Do not implement their version pointers, Redis status model, stale-if-error behavior or proposed cache lifetimes without a new decision. |
| Proposed route-cache walker requirement (FR-73d) | Parked | The route walker passes locally, but its test title does not name FR-73d and the row remains tagged DISCUSS. Do not tick it on the basis of an adjacent test. |
| React + Vite delivery (FR-81) | Done (with evidence) | `npm run build` passed with Vite; the current production build is React/Vite. |
| Worker-generated snapshots (FR-81a) | Done (with evidence) | `test/unit/page-snapshots.test.js` passed under `describe('FR-81a, FR-82b public snapshots')`, covering listing metadata/rendering, noindex behavior, snapshot queue enqueue and full-build startup enqueue. Production serving remains a live check. |
| Sold page and moderator removal behavior (FR-81b) | Parked | Backend unit tests passed sold-item selection; frontend test `sold and removed listings have distinct rendering states` passed. The database-backed status/410 path was not rerun, so the complete row remains open. |
| Slugs, canonicals, sitemap, robots and filter indexing (FR-81c) | Parked | Unit tests for canonical URL helpers and snapshot noindex rules passed; the named PostgreSQL old-slug redirect test was not run. Sitemap/robots production behavior remains unverified. |
| SEO wording rules (FR-82) | Parked | The owner-approved recommendation, Replica, contact-detail, length and formatting rules are recorded in `specs.md`. The frontend SEO validation test and backend `FR-82` unit tests passed, but not every rule in the full row has a passing named test. |
| Image alt text and filenames (FR-82a) | Parked | No final owner decision or passing test establishes this behavior. |
| Product/Offer/Breadcrumb structured data, without ratings (FR-82b) | Done (with evidence) | `test/unit/page-snapshots.test.js` passed under `describe('FR-81a, FR-82b public snapshots')`; it asserts Product, Offer, PKR, availability, condition, brand, color, BreadcrumbList and absence of rating data. |
| URL/canonical/indexing decisions (FR-82c) | Parked | The product rules are recorded and canonical URL unit tests passed; the PostgreSQL old-slug redirect and complete sitemap/robots behavior were not rerun. |
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
| SEC-12 object-level authorization | Parked | Named conversation/message and listing ownership integration tests exist, but the guarded suite did not start; the whole object-ID route surface is not established by the available unit run. |
| SEC-16 route-boundary validation | Parked | Named SEC-16 smoke/email/reset tests passed for selected boundaries. They do not cover the full route and validation scope required by the row. |
| SEC-17 XSS/output handling | Parked | No complete review or test evidence for the full API and frontend requirement was produced in this documentation task. |
| SEC-24 rate limiting | Parked | Local unit tests passed, but their titles do not name SEC-24; integration, global/dispute coverage and deployed proxy forwarding remain unverified. |
| SEC-36 cache policy | Parked | The route walker passed and checks private/no-store defaults plus no cookies on public allow-listed routes. Its title does not name SEC-36 and it does not prove the money-data access path; leave the checkbox open. |

## Product decisions, deferred work and live checks

| Phase 3 item | State | Evidence / remaining work |
|---|---|---|
| Seller city as discovery city; sold items hidden and reserved items badged | Done (with evidence) | Owner decisions are recorded in `DECISIONS_2026-10-22.md`, `open-questions.md` and `specs.md`. Runtime/database verification remains parked above. |
| SEO titles/descriptions, structured data, URLs, canonicals and indexability | Done (with evidence) | The owner decisions are documented; implementation/test status is separately mapped under FR-81/82 above. |
| CDN provider selection and production snapshot-serving/purge model | Live-check pending | No provider is selected. Verify production routing, no-cloaking behavior, cache freshness and purge delivery in `LIVE_CHECKS.md`. |
| Production cache freshness and deployed CDN behavior | Live-check pending | Verify the approved 10-second detail/status and 60-second search/category freshness limits against the deployed origin/CDN. |
| Integration test rerun with approved `TEST_DATABASE_URL` (and `TEST_REDIS_URL` where required) | Live-check pending | Attempted once on 2026-10-25; Jest stopped in global setup with `TEST_DATABASE_URL is required and cannot be empty.` No integration tests ran. |
| Offers, counters, offer acceptance/history, Urdu script/RTL, popularity, trending, “did you mean”, real-time chat, video and voice | Deferred | Owner decisions and deferred scope are recorded in `open-questions.md` and `END_OF_PHASES_REVIEW.md`. Video and voice remain FR-75–FR-76a deferrals. |

## Verification run (2026-10-25)

Commands ran from the respective package directories:

- Backend unit and smoke: `npm.cmd test -- --runInBand`
  - `Test Suites: 46 passed, 46 total`
  - `Tests:       581 passed, 581 total`
  - `Snapshots:   0 total`
- Guarded PostgreSQL integration: `npm.cmd run test:integration -- --runInBand`
  - **Blocked before tests:** `TEST_DATABASE_URL is required and cannot be empty.`
- Frontend: `npm.cmd test`
  - `# tests 16`
  - `# pass 16`
  - `# fail 0`
- Frontend lint: `npm.cmd run lint` — passed.
- Frontend production build: `npm.cmd run build` — passed.
- Public bundle: `npm.cmd run check:bundle` — passed; largest public route was
  `75.1 KB gzip (budget: 200 KB)`.

The failed integration setup is not counted as a test pass. This refresh did
not rerun `npm audit --omit=dev`, production-provider checks, or deployment
checks. No push or production-readiness claim is made.
