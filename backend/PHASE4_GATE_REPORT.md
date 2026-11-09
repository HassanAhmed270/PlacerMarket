# Phase 4 gate report — Stage 22 (2026-11-08)

This report records Phase 4 evidence for baseline commit
`485f7cfb7f6323f52ed43798b676e836cd20aba5`; it is evidence, not a claim of
production readiness. No live payment provider, legal clearance, courier
arrangement, or production payment enablement is established here. The FR rows
remain unchecked where the repository's full backend test gate is red; only
SEC-39 and SEC-40 were checked in this stage, with their named PostgreSQL tests
staged in the same commit.

## Requirement inventory

`[ ]` and `[x]` show the current checkbox state after this stage. A PARTIAL
verdict includes the specific missing proof or gate. For an otherwise complete
FR, the project rule in `rules.md` still blocks a new specs checkbox until the
whole `npm test` run passes.

| Requirement | Passing test name or current result | Verdict |
|---|---|---|
| FR-32 `[ ]` | `FR-32, FR-32a, FR-32b, FR-63, FR-86: Buy creates one reservation and locks its item/seller price snapshot` — integrations 1–3 and targeted reservations run passed. | PARTIAL — behavior is covered, but the required full backend unit/smoke run is red. |
| FR-32a `[ ]` | `FR-32a, SEC-34: client fee, total, amount, seller, status, expiry, and payment fields cannot alter server totals or order state`; address validation tests; webhook funding tests — integrations 1–3 passed. | PARTIAL — the full backend unit/smoke gate is red. |
| FR-32b `[ ]` | `FR-32b, FR-63c: five parallel buys by one buyer on different listings respect the cap of three`; `FR-32b, FR-63c: honors an administrator-configured cap of two active unpaid reservations` — integrations 2–3 and targeted reservations run passed. | PARTIAL — the full backend unit/smoke gate is red; `open-questions.md` also retains the cap-value DISCUSS entry. |
| FR-33 `[ ]` | No passing test title naming FR-33 was found; named order-state tests cover selected transitions under FR-34, FR-61/62, FR-68, and FR-72. | NONE — no complete FR-33-named lifecycle test. |
| FR-33a `[ ]` | `FR-33a: cancelling a funded order requests the full item-plus-delivery refund once and the job succeeds`; `FR-33a, FR-72: ten buyer-cancel and timeout races create one refund and a consistent cancellation` — integrations 1–3 passed. | PARTIAL — the full backend unit/smoke gate is red. |
| FR-33b `[ ] (DEFERRED: Phase 5)` | Manual issue recording is a Phase 4 stopgap, but the row remains explicitly deferred. | BLOCKED-BY-TAG — never tick a DEFERRED row. |
| FR-34 `[ ]` | `FR-34: seller list and detail expose only the exact safe funded-order fields`; `FR-34: detail follows funded, handover, delivery, dispute, resolution, and cancellation states`; frontend `FR-34: seller order APIs use authenticated reads and cursor query parameters` — integrations 1–3 and frontend test run passed. | PARTIAL — named buyer-side FR-34 coverage is missing; the frontend test proves API wiring, not the whole buyer/seller requirement. |
| FR-39 `[ ]` | No passing test title naming FR-39 was found. | NONE — no test proves platform-controlled courier arrangement; courier arrangement is also an external dependency. |
| FR-41 `[ ] (DEFERRED: real-time courier API/webhook integration)` | `FR-41, FR-72: legacy status logging is Admin-only and rejects reservation-backed orders` — integrations 1–3 passed. | BLOCKED-BY-TAG — the named test rejects the legacy route for reservation-backed orders; the row also carries a DEFERRED tag. |
| FR-42 `[ ]` | `FR-42: tracking is available to order parties and Admins but returns 404 to unrelated users` — integrations 1–3 passed. | PARTIAL — backend access evidence passes, but the matching frontend prototype remains pending owner browser click-through. |
| FR-51 `[ ]` | `FR-51: a late payment auto-refund notifies the buyer and seller with its stored amount`; `FR-51: the seller receives a dispute-filed notification`; `FR-51: GET notifications exposes rows only to their recipient` — integrations 1–3 passed. | PARTIAL — the complete event list (including seller-application/listing decisions and messages/offers) is not demonstrated by the named tests. |
| FR-55 `[ ]` | No passing test title naming FR-55 was found. Admin order views are named FR-68. | NONE — no FR-55-named test proves platform-wide order, delivery, and payment monitoring. |
| FR-60 `[ ] (D1 scope provisional in specs.md)` | Fake gateway / checkout tests are named FR-60a, not FR-60. | PARTIAL — no FR-60-named test proves the escrow/COD replacement row; D1 is also inconsistent between design and open-question records. |
| FR-60a `[ ]` | `FR-60a: first checkout creates one payment, moves the order to payment_pending, and returns snapshot values`; `FR-60a: repeat checkout reuses the payment and URL with exactly one fake provider session`; `FR-60a, FR-61: checkout return and payment-status reads never fund an order` — integrations 1–3 passed. | PARTIAL — fake-provider evidence passes, but provider-specific capability and the frontend hosted-checkout click-through remain unverified. |
| FR-61 `[ ]` | `FR-61, FR-62: a verified success funds the order exactly once and syncs sold availability`; `FR-61: status GET is private/no-store and leaves stored order and payment state unchanged`; `FR-60a, FR-61: checkout return and payment-status reads never fund an order` — integrations 1–3 passed. | PARTIAL — the full backend unit/smoke gate is red. |
| FR-62 `[ ]` | `FR-61, FR-62: a verified success funds the order exactly once and syncs sold availability`; `FR-61, FR-62: a failed payment keeps the reservation active and a new keyed attempt can fund it`; buyer-order and delivery-state tests — integrations 1–3 passed. | PARTIAL — there is no single complete named FR-62 lifecycle proof covering every specified transition; the full backend unit/smoke gate is red. |
| FR-63 `[ ]` | `FR-63: discovery uses database time for new reservations and sold wins over reserved`; `FR-63a: eight concurrent buyers racing one listing produce exactly one reservation`; `FR-63: missing reservation settings use their documented defaults` — integrations 1–3 passed. | PARTIAL — behavior evidence passes, but the full backend unit/smoke gate is red. |
| FR-63a `[ ]` | `FR-63a: eight concurrent buyers racing one listing produce exactly one reservation`; `FR-63a: expiry sweep expires due unpaid reservations, cancels orders, and synchronizes availability`; `FR-63a: a funded listing take-down requests only one full system cancellation refund` — integrations 1–3 passed. | PARTIAL — the full multi-condition row (including every seller-edit/removal and payment-idempotency case) is not established by one complete named test set; the full backend unit/smoke gate is red. |
| FR-63b `[ ] (DEFERRED; not applicable to fixed-price Buy)` | No active-flow test is appropriate; offers remain disabled. | BLOCKED-BY-TAG — explicitly deferred and not applicable. |
| FR-63c `[ ]` | `FR-32b, FR-63c: five parallel buys by one buyer on different listings respect the cap of three`; `FR-32b, FR-63c: honors an administrator-configured cap of two active unpaid reservations`; `FR-63c: only active unexpired reservations count against the buyer cap` — integrations 1–3 and targeted reservations run passed. | PARTIAL — the cap-value DISCUSS entry remains in `open-questions.md`; the full backend unit/smoke gate is red. |
| FR-64 `[ ]` | No passing test title naming FR-64 was found. | NONE — no named test proves gateway-fee storage and platform absorption. |
| FR-67 `[ ]` | No passing test title naming FR-67 was found. | NONE — no named test proves payout-detail changes have no cool-off period. |
| FR-68 `[ ]` | `FR-68: only Admin can mark a handed-over reservation order delivered`; `FR-68: 20 concurrent delivered calls produce one success and one hold`; `FR-68: list access is Admin-only, private/no-store, and excludes legacy orders`; frontend `FR-68: order list query builder includes status and cursor without empty values` — integrations 1–3 and frontend test run passed. | PARTIAL — the full backend unit/smoke gate is red. |
| FR-69 `[ ] (D2 conditions provisional in specs.md)` | `FR-69, SEC-39, SEC-40: request then approve enqueues one refund and calls the gateway once with its idempotency key`; system-expiry and timeout refund tests; frontend `FR-69: manual refund helpers keep the request full-balance and prevent requester decisions` — integrations 1–3, refund-security targeted, and frontend test runs passed. | PARTIAL — manual/system behavior is tested, but D2's owner status conflicts across documents; FR checkboxes also require a green full backend unit/smoke run. |
| FR-70 `[ ]` | `FR-70: reconciliation re-enqueues orphan inbox rows and executes an orphan requested refund`; `FR-70: gateway lookup outcomes enter one synthetic inbox event and use normal funding and failure processing`; `FR-70: one gateway lookup error leaves that payment unchanged and does not stop later items` — integrations 1–3 passed. | PARTIAL — no named evidence compares gateway settlement reporting with all recorded transactions and identifies the full mismatch set. |
| FR-72 `[ ]` | `FR-72: the due timeout requests one full refund and ten parallel calls remain idempotent`; `FR-72: the handover sweep refunds only due, unhanded-over funded orders once`; `FR-33a, FR-72: handover and buyer cancellation have exactly one winner in 20 PostgreSQL races`; frontend `FR-72: handover form rejects future times, empty notes, and notes over 500 characters` — integrations 1–3 and frontend test run passed. | PARTIAL — the full backend unit/smoke gate is red. |
| FR-72e `[ ] (DEFERRED: Phase 5)` | `FR-72e: only an Admin may resolve exceptions with a validated note and an audit-only order change`; `FR-68, FR-72e: detail exposes delivery, hold, and issue metadata without changing state or emitting events` — integrations 1–3 passed. | BLOCKED-BY-TAG — never tick a DEFERRED row. |
| FR-73e `[x] (already checked before this stage)` | `FR-73e: equality does not require email; approval uses the latest threshold`; `FR-73, FR-73e: approval updates public content once, checks current threshold and rejects stale versions` — integrations 1–3 passed. | COMPLETE — pre-existing checkbox left unchanged. |
| FR-77b `[ ]` | `FR-77b, SEC-33: a valid signed event stores exact bytes and queues one job without funding the order`; `FR-77b, SEC-33: ten parallel identical signed deliveries create one inbox row and one job`; `FR-61, FR-62: a verified success funds the order exactly once and syncs sold availability` — integrations 1–3 passed. | PARTIAL — the full backend unit/smoke gate is red; SEC-33's separate constant-time proof remains missing. |
| FR-85 `[ ]` | `FR-85: Buy uses the administrator-configured delivery fee in server-calculated snapshots` — targeted reservations PostgreSQL run passed (29 tests). | PARTIAL — default/configured server totals are tested; the named test does not prove the frontend displays the fee before payment confirmation. |
| FR-86 `[ ]` | `FR-32, FR-32a, FR-32b, FR-63, FR-86: Buy creates one reservation and locks its item/seller price snapshot`; `FR-32a, FR-86: malformed or incomplete address fields return 400`; `FR-86: Buy accepts a supported city, while deactivation blocks new buys without changing existing orders`; frontend `FR-86: delivery city toggle labels describe the next action` — targeted reservations, integration, and frontend test runs passed. | PARTIAL — frontend prototype click-through remains pending; the full backend unit/smoke gate is red. |
| FR-87 `[ ]` | `FR-63, FR-87: the listing owner receives 403 when attempting to buy their listing` — targeted reservations PostgreSQL run passed. | PARTIAL — behavior test passes, but the full backend unit/smoke gate is red. |
| SEC-11 `[ ]` | No passing test title naming SEC-11 was found; tests cover selected Admin routes and delivery permissions under other codes. | PARTIAL — the complete non-public route permission surface is not proven. |
| SEC-12 `[ ]` | `SEC-12: every conversation/message ID route denies a stranger`; `SEC-12: inbox and message keyset pages are participant-scoped and report unread counts`; `SEC-12: staff conversation reads require the new permission and an audited reference`; photo/revision ownership tests — integrations 1–3 passed. | PARTIAL — complete object-ID route coverage is not demonstrated. |
| SEC-27 `[ ]` | `SEC-27/28 logs only redacted metadata and returns a generic 500 with request id`; `SEC-27: seven provider failures persist only safe codes and alert once when attention is newly set` — integration runs passed. `payout.service.js:55` still logs `{ orderId, disputeId, err }`; `escrowPayments.service.js` logs a JSON object at line 929. | PARTIAL — sensitive error-object logging remains; keep unticked. |
| SEC-33 `[ ]` | `FR-77b, SEC-33: a valid signed event stores exact bytes and queues one job without funding the order`; `SEC-33: rejects a stale timestamp signature without an inbox row or job`; `FR-77b, SEC-33: ten parallel identical signed deliveries create one inbox row and one job`; worker funding test — integrations 1–3 passed. | PARTIAL — no named passing test proves constant-time signature comparison. |
| SEC-34 `[ ]` | `FR-32a, SEC-34: client fee, total, amount, seller, status, expiry, and payment fields cannot alter server totals or order state`; `SEC-34: refunds cannot exceed or mismatch their payment amount`; `FR-79f and SEC-34: ledger and money audit records reject update, delete, and truncate` — integrations 1–3 passed. | PARTIAL — selected assertions do not cover every money-state transaction and idempotency path. |
| SEC-36 `[ ]` | The route-cache test passes but its title does not name SEC-36; it does not prove all money-data cache paths. | PARTIAL — required title and money-data-path evidence are missing. |
| SEC-39 `[x]` | `FR-69, SEC-39, SEC-40: request then approve enqueues one refund and calls the gateway once with its idempotency key`; `SEC-39: requester cannot self-approve a manual refund`; `SEC-39: missing, foreign, consumed, and wrong-action grants are rejected`; `FR-69, SEC-39: concurrent approve-versus-approve has exactly one winner` — refund-security targeted PostgreSQL run passed. | COMPLETE — checked in this stage; the supporting tests were staged in the same commit. D2 remains a separate launch-decision inconsistency. |
| SEC-40 `[x]` | `FR-69, SEC-39, SEC-40: request then approve enqueues one refund and calls the gateway once with its idempotency key`; `FR-72, SEC-40: the due timeout requests one full refund and ten parallel calls remain idempotent`; `FR-69, FR-61, FR-62, SEC-40: a duplicate capture refund executes without changing the funded order` — refund-security targeted PostgreSQL run passed. | COMPLETE — checked in this stage; trigger, payment/order identity, durable key, and repeated-effect assertions were staged in the same commit. |

Before the documentation update, the `Today:` line for SEC-33 still said
`n/a-yet (no webhooks; courier updates are manual)`; SEC-34 said it needed an
audit once Phase 4 started; SEC-39 said the refund workflow was not implemented;
and SEC-40 said the workflow was not implemented. Those lines were replaced
with current named-test evidence. SEC-33 remains partial because constant-time
comparison is not proven; SEC-34 remains partial for the gaps listed above.

## Unticked rows and exact gaps

- FR-32, FR-32a, FR-32b, FR-33a, FR-34, FR-42, FR-51, FR-60, FR-60a,
  FR-61, FR-62, FR-63, FR-63a, FR-63c, FR-68, FR-69, FR-70, FR-72,
  FR-77b, FR-85, FR-86, and FR-87 remain unchecked. The exact missing piece
  for each row is in the inventory above. In particular, FR-33 and FR-39,
  FR-55, FR-64 and FR-67 have no complete passing test title naming the row.
- FR-33b, FR-41, FR-63b, and FR-72e remain unticked because of their DEFERRED
  tags (FR-41's tag is specifically its real-time courier API/webhook scope).
- FR-73e was already checked; it was not changed in this stage.
- SEC-11, SEC-12, SEC-27, SEC-33, SEC-34, and SEC-36 remain unchecked for the
  PARTIAL gaps recorded above.
- The FR-32b / FR-63c default-cap value remains a DISCUSS item in
  `open-questions.md`; the new test proves an administrator-configured value
  of two and does not establish an owner decision about changing the documented
  maximum/default.
- No FR checkbox was newly ticked: `rules.md` Section 1 requires the whole
  backend `npm test` suite to pass before a `specs.md` checkbox is ticked, and
  the migration snapshot test still fails.

## Rows blocked by tags and owner decisions

- FR-33b — `(DEFERRED: Phase 5)`; refusal/return policy is not resolved.
- FR-41 — real-time courier API/webhook integration is `(DEFERRED)`.
- FR-63b — `(DEFERRED; not applicable to fixed-price Buy)`.
- FR-72e — `(DEFERRED: Phase 5)`; lost-parcel recovery policy is deferred.
- FR-32b / FR-63c — `open-questions.md` still labels the cap value a proposed
  `(DISCUSS)` item; the spec describes the three-reservation maximum.
- D1 — `PHASE4_DESIGN.md` says owner-confirmed on 2026-10-29; `specs.md` and
  `open-questions.md` still describe D1 as provisional / owner-to-confirm.
- D2 — `PHASE4_DESIGN.md` says owner-confirmed on 2026-10-29;
  `open-questions.md` and the FR-69 / SEC-39 text still call it provisional.
- O6 — the supplied instruction still contains the literal
  `<paste the owner's O6 decision sentence here>` placeholder; it was skipped
  and `open-questions.md` was not edited.

## Frontend prototype rows pending owner browser click-through

Every `Prototype gap-analysis action items` checkbox in `specs.md` remains
unticked. The owner browser click-through was not performed. Pending items:

- Replace legacy Add-to-bag with login-gated Buy / checkout state.
- Replace obsolete Card/Wallet checkout with the hosted gateway page (FR-60a).
- Add Favorite and Chat login gates.
- Correct the seller card to alias, rating, and join date.
- Rework reviews to two-way and only from completed Orders.
- Add Kids category and subcategories.
- Replace the condition dropdown and add Replica disclosure.
- Add structured subcategory measurements and listing fabric/brand/color/handwork fields.
- Add authenticity-evidence upload and verified-badge display.
- Reframe the temporary high-value email-verification page.
- Add explicit Bank versus Mobile Wallet payout choice.
- Build payout-hold and dispute-window UI.
- Build seller-application review in Admin.
- Add pre-dispatch cancellation to Buyer Orders.
- Expand the Orders/Tracking lifecycle states (FR-33).
- Add seller net-payout Held / Released visibility.
- Build the two-factor login flow.
- Build labeled photo upload and moderation controls.
- Keep optional video/voice-story sections deferred.
- Implement the approved search sorts/suggestions/recent-search behavior.
- Complete listing status, Sold banner, similar items, and freshness UI.
- Add reserved-listing/payment-window countdown UI (FR-63).
- Complete frontend code splitting, public-bundle isolation, bundle budget, and self-hosted fonts.

## Carried forward to Phase 5 and later

- `Phases.md` and `HANDOFF.md` state that FR-45b–FR-45h, FR-65, and dispute
  ownership were pulled forward and accepted by the owner on 2026-11-07.
  Their `specs.md` checkboxes remain unchecked. Passing named evidence exists
  for selected parts (including FR-45b/c/g and FR-65), not a full row-by-row
  close-out in this stage.
- FR-33b returns/refusal policy, FR-72e lost-parcel recovery, partial-refund
  decisions, commission treatment, chargeback liability, and unverified-seller
  funds handling remain Phase 5 or later decisions as recorded in the repo.
- Provider deployment, production email delivery/failover, queue/PgBouncer
  compatibility, production snapshot/CDN behavior, and hosted CI remain later
  live checks.

## External launch dependencies

- Select a payment provider and obtain its sandbox account.
- Obtain legal clearance/advice for holding customer funds.
- Implement and verify provider-specific webhook signature behavior; the
  current fake-provider tests are not a live-provider verification.
- Arrange a courier partner.
- Resolve and satisfy the D2 second-real-Admin requirement before enabling
  production payments.
- Keep all production `PAYMENTS_ENABLED` gates closed until the launch
  dependencies and provider-specific checks pass.

## Phase 4 gate checklist

Copied from the six Phase 4 gate lines in `Phases.md`.

| Gate line | Status | Reason |
|---|---|---|
| Task 0 design review done (design only; no code or migrations) | met | `PHASE4_DESIGN.md` is present; no production code, migration, or schema change was made in this stage. D1/D2 status conflicts remain separately listed. |
| Backend FRs above ticked | not met | Multiple Phase 4 FRs remain unchecked; the full backend unit run is red. |
| Frontend items above ticked | not met | Prototype items await the owner's browser click-through. |
| SEC rows above ticked | not met | SEC-39/40 are checked; SEC-11/12/27/33/34/36 remain partial and unchecked. |
| Decisions above resolved | needs owner | D1/D2 records conflict, the FR-32b/FR-63c cap-value DISCUSS entry remains, and O6 was not supplied. |
| `npm test` green and `npm audit --omit=dev` clean | not met | The full backend unit suite and schema check fail. Backend production audit has 3 approved moderate glob/minimatch findings under the 2026-10-31 owner exception, therefore the audit is met only with that exception; frontend production audit is clean. |

## Test and build results

Raw summary lines from this stage's required runs and targeted follow-ups:

```text
Backend npm.cmd test -- --runInBand:
Test Suites: 1 failed, 59 passed, 60 total
Tests:       1 failed, 802 passed, 803 total
```

The failing test is `test/unit/migration-runner.test.js` —
`snapshot generator orders numbered SQL migrations and includes only each up
section`; it reports generated snapshot content differing from `schema.sql`.
The isolated rerun reproduced the same failure (`1 failed, 4 passed, 5 total`).
An initial isolated invocation using Windows backslashes as Jest's test selector
matched no tests; it was rerun with Jest's normalized slash selector.
`db:check-schema` also reports `schema.sql is not up to date; run npm run
db:generate-schema`. No schema file was changed because schema changes are
outside scope.

```text
Backend integration run 1:
Test Suites: 36 passed, 36 total
Tests:       417 passed, 417 total

Backend integration run 2:
Test Suites: 36 passed, 36 total
Tests:       418 passed, 418 total

Backend integration run 3:
Test Suites: 36 passed, 36 total
Tests:       418 passed, 418 total

Targeted reservations PostgreSQL run:
Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total

Targeted refund-security PostgreSQL run:
Test Suites: 3 passed, 3 total
Tests:       93 passed, 93 total

Frontend npm.cmd run test:
# tests 43
# pass 43
# fail 0
# skipped 0

Backend npm.cmd run db:check-schema:
schema.sql is not up to date; run npm run db:generate-schema

Backend npm.cmd audit --omit=dev:
3 moderate severity vulnerabilities

Frontend npm.cmd audit --omit=dev:
found 0 vulnerabilities

Frontend npm.cmd run check:bundle:
Largest public route: 76.0 KB gzip (budget: 200 KB)
```

Backend unit-test migration snapshot failure was reproduced in isolation. The
frontend lint command exited 0 (`oxlint`); the frontend build succeeded (`✓
built in 865ms`). No production source, schema, migration, dependency, or
frontend source was changed.

## Known flaky test

`page-snapshots.test.js` is the known full-suite timeout flake; the documented
observed pattern is a timeout on the first full-suite run only. It passed in
this stage's full unit and all three integration runs, so no standalone rerun
was triggered and the test was not changed.
