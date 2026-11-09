# Phase 4 gate report — closure by owner amendment (2026-11-08)

This report records Phase 4 evidence for baseline commit
`bdecb136ef8d44f36f6044a19a14f6d1c373706d` (stage 22, on top of `485f7cf`) plus the
closure patch described below. It is evidence, not a claim of production readiness.
No live payment provider, legal clearance, courier arrangement, second real Admin or
production payment enablement is established here.

## Closure decision

The owner closed the Phase 4 gate by amendment (Option A, as for Phase 3) on
2026-11-08. Rows are ticked only where passing, FR-named tests prove the whole row.
Everything else stays unticked with its exact gap below and is carried forward.
Frontend rows stay unticked and listed as pending until the owner's browser
click-through. Owner answers recorded in `open-questions.md` (Resolved):

- D1 and D2 confirmed (2026-10-29, `PHASE4_DESIGN.md`).
- Reservation cap = 3 confirmed.
- Escrow rows FR-60a, FR-63a, FR-69, FR-70 approved as built (DISCUSS removed). Approval
  of a design is not a tick: FR-60a and FR-70 stay unticked for the gaps below.
- O6 dropped.
- The `glob`/`minimatch` audit exception (via `node-pg-migrate`; re-check on or after
  2026-11-11) is accepted.
- Gateway, legal clearance, courier and a real second Admin are launch blockers, not
  gate blockers.

## What the closure patch changed

- `db/generate-schema-snapshot.js` (generate and `--check`) and
  `test/unit/migration-runner.test.js` now normalize CRLF to LF. This was the only
  non-test, non-doc code change. It removes the Windows-only red migration-runner test
  and `db:check-schema` failure that blocked every FR tick under `rules.md` Section 1
  (full `npm test` must pass). Verified by running both checks with every migration
  and `schema.sql` converted to CRLF.
- Test titles were made honest (the Buy snapshot test no longer names FR-32b) and small
  tests were added only where a ticked row had an unproven clause (listed below).
- No migration, schema, dependency or production-source change.

## Rows ticked at closure (13 FR)

Existing ticks are unchanged (SEC-39, SEC-40, FR-73e and earlier phases).

| Row | Whole-row evidence (all PostgreSQL integration unless noted) |
|---|---|
| FR-32 | Buy snapshot test (direct reservation, `accepted_offer_id` null, status `reserved`, locked price) and the expected-price 409 test, `reservations.test.js`. |
| FR-32b | Cap tests (three by default, configured two), the added one-item-one-seller test, and paid exclusion via FR-63c. |
| FR-33a | Funded cancel refunds item plus delivery fee once and the job succeeds; 20-race and ten-race tests; cancellation refused after handover. |
| FR-61 | Verified-success funds exactly once; checkout return and status reads never fund; client amount and currency ignored. |
| FR-63 | Atomic Buy, 401 when unauthenticated, 60-minute default, added test for the configured window, eight-way race, database-time discovery. |
| FR-63a | Eight-way race, expiry sweeps once, seller pause/remove blocked while reserved or paid, price-revision approval blocked by an active reservation, late capture refunded, buyer and seller notified, listing take-down refunds once. |
| FR-63c | Cap of three under five parallel buys, configured cap of two, active-unexpired and paid exclusion, added test that cancelled, released and expired reservations free a slot. |
| FR-68 | Only Admin marks delivered, delivery starts one hold, Admin-only permission mapping, legacy manual status entry Admin-only. |
| FR-69 | Request and approve by two Admins with grants, self-approval refused, audit of both Admins, idempotent gateway call, system refunds without a second Admin and with triggers, additional-Admin command, production startup gate for two enrolled Admins. |
| FR-72 | 3-day deadline set at funding, timeout cancels and fully refunds once under ten parallel calls and sweeps, handed-over orders skipped, added test that the missed deadline stays on the cancelled order with its end reason and refund trigger. |
| FR-77b | Signed event stores exact bytes, duplicates acknowledged without a second row or job, wrong/missing/stale signatures rejected with no row or job, signature verified before parsing, 64 KiB cap, worker re-reads under lock, replay changes nothing. |
| FR-86 | Required address fields and supported-city validation (400/422/404), address snapshot on the reservation, deactivation blocks new buys without touching existing orders. |
| FR-87 | Listing owner gets 403 over the HTTP route and nothing is written. |

## Rows left unticked, with the exact gap

- FR-32a — the review of server-calculated price plus fee before paying is UI and awaits
  the click-through; payment start and funding are proven under FR-60a/FR-61.
- FR-33 — no FR-33-named lifecycle test; no named proof of the Out for Delivery and
  Completed transitions.
- FR-34 — no named buyer-side order status/history test; seller side is covered;
  frontend order pages pending click-through.
- FR-39 — no test; courier arrangement is an external dependency.
- FR-42 — backend access test passes; the frontend tracking view awaits click-through.
- FR-51 — the complete event list (seller-application and listing decisions, messages) is
  not demonstrated by named tests.
- FR-55 — no FR-55-named test (Admin order views are named FR-68).
- FR-60 — COD structures are still preserved by the expand-first migration and the COD
  contract step is not done; no FR-60-named test.
- FR-60a — provider-specific capability can be checked only once a provider is selected;
  hosted-checkout UI awaits click-through.
- FR-62 — no single named test walks the full order flow including Out for Delivery and
  Completed.
- FR-64 — `payments.gateway_fee` exists but defaults to 0 and nothing stores an actual
  provider fee; needs live provider data.
- FR-67 — no FR-67-named test asserts that a payout-detail change has no cool-off.
- FR-70 — the job reconciles per-payment gateway lookups and orphan rows, but no test
  proves comparison with settlement reporting or a mismatch report.
- FR-85 — the fee is server-calculated and tested; showing it before payment confirmation
  is UI and awaits click-through.
- FR-33b, FR-41, FR-63b, FR-72e — carry DEFERRED tags; never ticked here.
- SEC-11, SEC-12, SEC-27, SEC-33, SEC-34, SEC-36 — partial; the exact gaps are in
  `security.md` (SEC-27: `payout.service.js` still logs an error object; SEC-33: no named
  constant-time test and no live-provider adapter; SEC-36: test title does not name
  SEC-36 and the money-data path is not asserted; SEC-34: not every money-state
  transaction and idempotency path is covered; SEC-11/12: complete route surface not
  demonstrated).

## Frontend prototype rows pending the owner's browser click-through

Every `Prototype gap-analysis action items` checkbox in `specs.md` stays unticked,
including: login-gated Buy and checkout state; hosted gateway page (FR-60a); seller card;
two-way reviews; Kids category; condition and Replica fields; authenticity evidence;
payout choice; payout-hold and dispute-window UI; seller-application review in Admin;
pre-dispatch cancellation in Buyer Orders; Orders/Tracking states (FR-33); seller net
payout Held/Released; two-factor login; labeled photo upload; search sorts; listing
status and countdown (FR-63); code splitting and bundle budget (the bundle check
passes at 76 KB gzip of 200 KB, but the owner has not signed off the UI).

## Carried forward to Phase 5 and later

- FR-45b–FR-45h, FR-65 and dispute ownership were pulled forward and accepted on
  2026-11-07; their `specs.md` boxes remain unticked pending a row-by-row close-out.
- FR-33b returns policy, FR-72e lost-parcel recovery, partial-refund workflow (FR-45a,
  FR-50a, FR-71 remain DISCUSS), chargeback liability and unverified-seller funds.
- Provider deployment, production email delivery, queue/PgBouncer compatibility,
  production snapshot/CDN behavior and hosted CI.
- Open item D3: no audit trail for Admin delivery-city changes (owner: do at the end).

## External launch blockers (not gate blockers)

- Select a payment provider and obtain a sandbox account; build and verify its signature
  scheme and the hosted-checkout capability check.
- Legal clearance for holding customer funds.
- Courier arrangement.
- A real second Admin (D2); production `PAYMENTS_ENABLED` stays closed until two
  distinct enrolled Admins, the provider checks and legal clearance exist.

## Phase 4 gate checklist (as ticked in `Phases.md`)

| Gate line | Status | Basis |
|---|---|---|
| Task 0 design review done | met | `PHASE4_DESIGN.md`. |
| Backend FRs above ticked | closed by owner amendment | 13 rows ticked on named tests; remainder listed above. |
| Frontend items above ticked | closed by owner amendment | Pending click-through; items stay unticked. |
| SEC rows above ticked | closed by owner amendment | SEC-39/40 ticked; six rows partial with exact gaps. |
| Decisions above resolved | met | `open-questions.md` Resolved, 2026-11-08. |
| `npm test` green and audit clean | met | Linux run green; audit met under the owner exception (`glob`/`minimatch`, re-check on or after 2026-11-11); frontend audit clean. |

## Test and build results (Linux, real PostgreSQL 16 and Redis, closure patch applied)

```text
Backend npm test -- --runInBand:
Test Suites: 60 passed, 60 total
Tests:       829 passed, 829 total

Backend integration (npm run test:integration), three full runs:
Run 1: Test Suites: 36 passed, 36 total | Tests: 423 passed, 423 total
Run 2: Test Suites: 36 passed, 36 total | Tests: 423 passed, 423 total
Run 3: Test Suites: 36 passed, 36 total | Tests: 423 passed, 423 total
(The environment was recycled during the first attempt at runs 2 and 3; they were
rerun from the start and passed. No page-snapshots timeout occurred in these runs.)

Backend npm run db:check-schema: exit 0 (also exit 0 and migration-runner 5/5 passing
with every migration and schema.sql converted to CRLF)

Frontend npm run lint: Found 0 warnings and 0 errors.
Frontend npm test: # tests 43 | # pass 43 | # fail 0 | # skipped 0
Frontend npm run build: built in 379ms
Frontend npm run check:bundle: Largest public route: 76.0 KB gzip (budget: 200 KB)

Backend npm audit --omit=dev: 3 moderate severity vulnerabilities (accepted exception)
Frontend npm audit --omit=dev: found 0 vulnerabilities
```

The owner's Windows machine showed a red migration-runner unit test and a failing
`db:check-schema` at stage 22 (probable CRLF mismatch). The closure patch makes both
line-ending-insensitive; the owner should re-run `npm test` and `npm run db:check-schema`
on Windows to confirm.

## Known flaky test

`page-snapshots.test.js` is the known full-suite timeout flake (first full run only).
It passed alone when rerun and in the other full runs.
