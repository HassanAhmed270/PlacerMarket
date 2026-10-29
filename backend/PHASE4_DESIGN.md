# Phase 4 Design — Fixed-Price Purchases, Reservations, Payments, Refunds and Delivery

**Task:** P4-D1, design only
**Baseline:** `5688383` (`docs: close Phase 3 gate`)
**Scope:** backend design; no code, migration, schema, specification, or security-checklist changes are part of this task.

The decisions in `DECISIONS_2026-10-25.md` Q1–Q19 and its addendum, and the Phase 4 requirements in `specs.md`, are the settled product inputs for this design. This document does not edit or supersede those files. In particular:

- **D1 = A — owner-confirmed in chat 2026-10-29:** Phase 4 accepts buyer payments only. Seller payouts remain manual under FR-65; gateway payout automation is out of scope.
- **D2 = A — owner-confirmed in chat 2026-10-29:** a real second Admin has their own authenticator; provide a command to create Admins. `PAYMENTS_ENABLED` must remain blocked unless two distinct Admin accounts have enrolled authenticators.

No live gateway is selected, no legal clearance is implied, and payment collection remains disabled until the separate launch gate passes.

## 1. Current-state summary and legacy conflicts

### a. Orders and COD columns

The current `orders` table has `accepted_offer_id UUID NOT NULL REFERENCES offers(id)`, `agreed_item_price`, `delivery_fee`, generated `total_cod_amount`, required `delivery_address`, required `payment_method_preference`, and `status` defaulting to `bag`; the `order_status` enum includes `bag`, `order_placed`, fulfillment/hold/completion states, `cancelled`, `refused_at_door`, `return_requested`, and `returned` (`db/migrations/001_initial_schema.sql:230-256`). This is incompatible with fixed-price Buy unless `accepted_offer_id` becomes nullable and the new purchase path does not require an offer.

- `orders.service.js` creates offer-backed Bag rows (`src/modules/orders.service.js:72-85`), checks/updates a Bag during COD checkout (`:89-121`), and changes order status or cancels an order (`:129-173`). Its reservation query treats selected order statuses as a reservation (`:30-45`). `orders.routes.js` exposes the authenticated legacy checkout, cancel, and history paths (`src/routes/orders.routes.js:6-19`).
- COD total reads are routed through `orders.getCodAmountDue()` (`src/modules/orders.service.js:224-228`); `payments.service.js` reads it and records `cod_collections`, then changes the order to `held` and starts a payout hold (`src/modules/payments.service.js:24-53`). `payout.service.js` gets the item price through that same read and changes completed order state during release (`src/modules/payout.service.js:68-85`). `settlement.service.js` looks up the order’s seller (`src/modules/settlement.service.js:99-104`).
- `disputes.service.js` reads the order row (`src/modules/disputes.service.js:44`); `delivery.service.js` stores delivery history by `order_id` (`src/modules/delivery.service.js:52-70`). These modules must be checked when order lifecycle and payment data are expanded; neither creates the new reservation or gateway payment today.
- Existing integration fixtures directly insert offer-backed orders in discovery, search, and snapshot tests (`test/integration/discovery.test.js:119-120`, `test/integration/listing-search.test.js:191-192`, `test/integration/page-snapshots.test.js:157-158`). Preserve their legacy use during expand-only rollout.
- COD conflict: FR-60 had described replacing COD entirely, but D1 confirms buyer-only payments and manual seller payouts. Existing COD structures and behavior must therefore remain during the compatibility period; no Phase 4 stage drops them.

### b. Discovery reservation data

`discovery.service.js` derives `has_reservation` live from `orders` using `orderExistsSql()` and maps it to `reserved` (`src/modules/discovery.service.js:42-65`, `:503-627`). Search indexing separately computes `listing_search.is_reserved` by checking `orders` in `order_placed` or `seller_preparing` (`src/modules/listingSearch.service.js:12-13`, `:20-35`); its worker upserts the derived index (`:100-123`). Order status transitions enqueue index updates through `syncListingAfterOrderTransition()` (`src/modules/orders.service.js:50-62`, `:114-120`, `:140-152`, `:163-171`). A new reservation table/state must be reflected in both the live discovery queries and the cached search projection; changing only the Buy endpoint would leave availability inconsistent.

### c. Migration 018 gap

The tracked migration directory has `017_listing_slugs_seo.sql` followed by `019_public_page_snapshots.sql`; the checked repository history contains no `018` migration-file addition or tracked `018` file. `db/migrate.js` passes the migrations directory to the migration runner (`db/migrate.js:137-169`), which discovers and orders available migration files; it does not assert a contiguous numeric sequence. Repository evidence does not establish whether the gap was intentional, renumbered, or lost. Treat the cause as unknown; assign a new unique migration number after checking the current directory and history when implementation begins. Do not backfill or reuse `018` by assumption.

### d. Middleware order and webhook mount

`app.js` currently runs `express.json()` at line 29 and the media raw-body route at line 30 (`src/app.js:24-35`). Mount the payment webhook’s `express.raw()` route before line 29 (and before the general `/api` router), so signature verification receives the original bytes. The current `/api` router is mounted afterward (`src/app.js:35`).

### e. Staff TOTP step-up and Admin creation

Staff TOTP authentication locks the credential row, checks enrollment and replay step, verifies the code, updates `last_used_step`, and creates the session (`src/modules/users.service.js:351-379`). `createStepUpGrant()` verifies the active session and factor within a transaction, then issues a short-lived hashed, one-use grant bound to user, session, and action; consumption is atomic (`src/modules/users.service.js:536-571`). The existing action allowlist is `payout.update`, `password.change`, `security.change`, and `payout.force_release` (`src/modules/users.service.js:43`); refund request/approval actions do not yet exist. The step-up route requires authentication, a supported action and code, and returns a private/no-store response (`src/routes/users.routes.js:206-213`).

`createInitialAdmin()` requires valid details and a valid TOTP, serializes bootstrap, refuses if an Admin already exists, and creates the initial Admin with an enabled TOTP credential (`src/modules/users.service.js:427-451`). `scripts/create-admin.js` is an interactive initial-bootstrap command (`scripts/create-admin.js:19-38`); it is not a command for creating a second administrator. The second-Admin command must not weaken the one-time bootstrap guard or reuse another person’s authenticator.

### f. Queue and scheduled jobs

`queue.js` defines `money-offers`, `media`, `notifications`, `email`, `listing-search`, and `page-snapshots` queues plus a dead-letter queue, retry policy, and deterministic job IDs (`src/lib/queue.js:14-39`, `:151-187`). The worker consumes notifications, email, media, listing-search, and page-snapshot jobs (`worker.js:39-80`). Worker-mode PgBoss config enables its scheduler (`src/lib/queue.js:89-103`, `:122-136`), but no recurring `boss.schedule()` registration or Phase 4 scheduled job exists. Enabling scheduler support alone does not schedule expiry, handover, or reconciliation.

### g. Settings and supported cities

The seeded `platform_settings` keys today are `commission_percent`, `high_value_threshold_pkr`, `instant_price_decrease_max_percent`, `payout_hold_days`, and `complaint_window_days` (`db/seed.js:23-29`); the generic key/value table is defined in `db/migrations/001_initial_schema.sql:374-379`. Phase 4 needs new configurable values for reservation minutes (initial 60), maximum active unpaid reservations per buyer (initial 3), delivery fee in PKR (initial 300), and seller handover days (3). These can be scalar settings, validated and defaulted through the existing settings owner.

Cities already have a `cities` table (`db/migrations/001_initial_schema.sql:33-39`), but current city existence is not the same as supported delivery coverage. Model supported delivery coverage explicitly (recommended: a table keyed by `city_id` with active/configuration metadata and audit timestamps), rather than treating every registered city as deliverable or storing a loosely validated list in one setting. The exact coverage set remains an operational input.

### h. Requirements and existing tests

Phase 4 directly touches FR-20/FR-73e (reserved listing edits and price-revision approval), FR-60/FR-60a–FR-65 (buyer payment, verified payment, reservation, fee, and manual seller payouts; FR-63b remains deferred), FR-68 (Admin-only Delivered transition), FR-69 (refunds), FR-70 (reconciliation), FR-72/FR-72e (handover timeout and manual delivery exceptions), FR-77a–FR-77c (transactional queue, webhook inbox and reconciliation sweeps), FR-79b/FR-79f (expand/contract migration and append-only ledger/audit), and connected FR-32/FR-32a/FR-33a/FR-34, FR-41/FR-42, and FR-45b–FR-45h where existing order and hold behavior is reused. FR-71’s complete partial-refund workflow remains deferred; this task designs only its data and validation foundation as directed by Q18.

The Phase 4 plan names SEC-33 (webhook signature/inbox), SEC-34 (money integrity), SEC-39 (two-person manual refund approval), and SEC-40 (refund idempotency/trigger attribution); it also calls for SEC-11 (delivery permission), SEC-12 (order/payment access), SEC-27 (sensitive logging), and SEC-36 (no-store money routes). Current test status for every FR/SEC row this design addresses:

| Row(s) | Test exists today? |
|---|---|
| FR-20 | No reservation-aware edit/pause/removal test found. |
| FR-32, FR-32a, FR-33a, FR-34 | No matching FR-named order/checkout/cancellation/history test found. Existing integration fixtures exercise discovery/search with legacy orders, not the new purchase contract. |
| FR-41, FR-42 | No matching delivery-status/tracking test found in the targeted test search. |
| FR-45b–FR-45h | No matching named tests found for the escrow path/hold integration. Adjacent settlement tests cover FR-48/FR-66, not the new funding path. |
| FR-60, FR-60a–FR-65, FR-68–FR-70, FR-71, FR-72, FR-72e | No matching new-flow tests found. FR-63b is deferred; existing negotiation coverage does not test fixed-price Buy. FR-65 manual-payout preservation also lacks a Phase 4-specific regression test. |
| FR-73e | Yes, existing price-revision tests in `test/integration/revisions.test.js:27-54`, `:145-162`, and `:281-296`; none covers blocking approval while a reservation is active or the required seller notices. |
| FR-77a | Yes, queue durability/idempotency/retry/dead-letter tests in `test/integration/queue.test.js`, `test/unit/queue.service.test.js`, and `test/unit/notifications.queue.test.js`; these do not test the Phase 4 money jobs. |
| FR-77b, FR-77c | No webhook-inbox or gateway-reconciliation tests found. Existing queue tests do not test those behaviors. |
| FR-79b | Yes, migration-runner unit/integration tests exist; none covers Phase 4’s old-code/new-schema compatibility or COD contract step. |
| FR-79f | Yes, `test/unit/payout-encryption.test.js` covers encryption/rotation; no append-only money-ledger/audit immutability test found. |
| SEC-11 | No delivery-permission-specific test found. |
| SEC-12 | Yes, existing tests cover conversation and listing resource access, including `test/integration/conversation-security.test.js:124-238`; no order/payment-specific access test found. |
| SEC-27 | Yes, `test/unit/http-hardening.test.js:32`; it does not prove that new payment/refund/webhook paths redact their data. |
| SEC-33, SEC-34, SEC-39, SEC-40 | No implementation tests found; security.md currently marks these as needing tests. |
| SEC-36 | Yes, `test/unit/route-cache-policy.test.js` exists; security.md records it as partial and it does not assert the new money-data access path. |

Related infrastructure coverage also exists: queue behavior in `test/unit/queue.service.test.js`, worker startup/consumption in `test/unit/worker.test.js`, staff TOTP in `test/unit/totp.test.js`, step-up in `test/integration/known-mismatches.test.js`, and database locking/revisions in `test/integration/revisions.test.js`. These are prior art, not proof that Phase 4 requirements are tested.

**Legacy conflicts (one line each):**

- `accepted_offer_id NOT NULL` conflicts with fixed-price Buy; make it nullable additively and leave offer-based rows valid.
- `bag` is the current default/legacy term; `reserved` is canonical, with only a temporary compatibility alias.
- `total_cod_amount`, COD preference, and `cod_collections` encode a COD checkout; retain them unchanged while new escrow totals/payments are introduced.
- Discovery currently derives reservation from selected order statuses; new reservations must be included in both live and indexed availability.
- Existing cancellation/status flows are COD-era and cannot be treated as the final escrow/refund state machine.
- No migration 018 intent is evidenced; do not infer missing schema or migration intent from the number gap.
- PgBoss scheduler support is enabled in the worker, but no recurring job is registered.
- Initial Admin bootstrap is one-time and cannot create the required second Admin.

## 2. Data model — expand-only

### Options and recommendation

**A. Separate `reservations` table (recommended).** A reservation is an explicit, time-bounded allocation with its own status, timestamps, buyer, listing and locked checkout snapshot. Add `orders.reservation_id` as unique nullable FK during expansion, and create the order and reservation in one Buy transaction. The reservation row and a partial unique index on active listing reservations make the core allocation invariant explicit. Order status remains the lifecycle/read-model field for existing order consumers; reservation and order changes commit together. Keep the reservation row after expiry/cancellation for audit and test history.

**B. Reservation as an `orders.status` only.** Extend the existing enum with `reserved` and add a partial unique index over listing IDs where an order has a reservation-active status. This avoids an additional reservation aggregate, but couples reservation expiry and allocation to an order table whose current required `accepted_offer_id`, COD fields, history, and many legacy consumers are already in transition. Partial unique indexes also require every active→inactive path to update order status correctly. This is feasible but less isolated.

Choose A to keep the new reservation lifecycle explicit and auditable. Avoid maintaining two independently writable truths: write `reservations.status` and the order’s corresponding public lifecycle status in the same transaction, and derive reservation availability only from the canonical reservation row after migration.

### Expand-only schema inventory

Implement as prose/schema plan only; exact SQL, migration numbering and ownership are for the implementation stages.

- **`reservations`**: `id`, `listing_id`, `buyer_id`, `seller_id`, `status` (`active`, `paid`, `expired`, `cancelled`, `released`), `item_price_snapshot`, `delivery_fee_snapshot`, `total_amount_snapshot`, `currency`, `address_snapshot` (structured JSONB or normalized immutable recipient/address columns), `created_at`, `expires_at`, `paid_at`, `ended_at`, `end_reason`, timestamps. Require positive item price, nonnegative fee, total equal to item plus fee, supported currency, valid status, and a complete address snapshot. Add a partial unique index on `listing_id WHERE status = 'active'`. Keep expiry decisions based on database time; the worker transitions expired rows out of `active`.
- **`orders` additive changes**: alter `accepted_offer_id` to nullable; add unique nullable `reservation_id`; add `reserved`, `payment_pending`, and `funded` to the order-status enum; and add `funded_at`, `handover_deadline_at`, and `handed_over_at`. The canonical immutable amount/currency/address snapshot lives on `reservations`, linked by `reservation_id`; do not duplicate mutable copies on the order. Do not change or drop `delivery_address`, `payment_method_preference`, `delivery_fee`, `total_cod_amount`, or old enum values in this expansion. Do not send legacy COD fields as authoritative payment totals for new orders.
- **`payments`**: `id`, `order_id`, `provider`, provider payment/reference IDs, `status` (`created`, `pending`, `succeeded`, `failed`, `cancelled`, `late`, `refunded/partially_refunded` as a derived or carefully maintained projection), amount/currency snapshots, actual gateway fee, unique application idempotency key, hosted checkout reference/URL as needed, provider timestamps, created/updated timestamps. Unique provider reference where present; permit multiple failed attempts but at most one accepted successful capture per order. Keep all money in `NUMERIC`/integer minor units, never JavaScript floats.
- **`refunds`**: `id`, `payment_id`, `order_id`, `trigger` (`system_cancel`, `system_expiry`, `system_handover_timeout`, `manual_admin`), positive amount/currency, `status` (`requested`, `approved`, `pending`, `succeeded`, `failed`, `reversed`), gateway refund reference, globally unique idempotency key, `requested_by`, `approved_by`, request/approval/completion timestamps, reason/decision note, and audit timestamps. Require manual requester and approver to differ; system-triggered rows use a distinct authorization path. Row-level `CHECK` constraints validate positive amounts and valid requester/approver shape. Aggregate invariant: total succeeded plus reserved/in-flight refunds must not exceed the captured refundable amount (captured total less prior refunds). A normal SQL `CHECK` cannot safely aggregate other rows; enforce the aggregate under a locked payment row in one transaction and, if database-enforced defense-in-depth is chosen, a trigger/constraint-trigger with the same serialization rule. Partial-refund data and validation only—do not expose a partial-refund workflow.
- **Append-only `ledger_entries`**: payment capture, gateway fee, refund and reversing/correction entries, with order/payment/refund references, currency, signed minor-unit amount, entry type, unique source/idempotency key and timestamps. Enforce append-only writes with the database role/permissions; corrections are compensating entries, not updates/deletes.
- **`webhook_inbox`**: provider, unique provider event ID, event type, raw body bytes, signature/timestamp metadata, verified receipt time, processing state, attempts/error code, linked payment, received/processed timestamps. `UNIQUE(provider, provider_event_id)`. Store only after successful signature verification; restrict raw payload retention/access and never log it.
- **Append-only `money_audit_events`** (or a shared append-only audit table): actor, action, order/payment/refund IDs, request/decision metadata, requester/approver identity, reason, request correlation ID and timestamps. Never store TOTP codes, secrets, full credentials, or raw provider secrets.
- **Settings and coverage**: add validated scalar settings for reservation minutes, maximum unpaid reservations, delivery fee in minor units/PKR, and handover deadline days. Add a supported-delivery-city relation referencing `cities`; keep unsupported or inactive cities out of Buy.
- **Existing COD columns and tables**: left intact and untouched by the new buyer-payment logic throughout all expand stages. Any later removal is a separately approved contract step.

## 3. State machine

### Listing availability

- `draft`/`pending_review` → `published`: existing moderation approval.
- `published` → `reserved`: Buy transaction establishes the active reservation; do not accept a second reservation.
- `reserved` → `published`/available: reservation expires or is cancelled before capture; return only if the listing remains published and not otherwise unavailable.
- `reserved` → `sold`: verified successful payment funds the order so the listing cannot be bought again.
- `reserved` → `unpublished`/`removed`: an Admin takes the listing down; release the reservation through the authorized refund path where payment was captured. A late successful capture after release is refunded and does not restore the listing.
- `published`/`reserved` → `paused`, `removed`, or `unpublished`: existing seller/admin path, except seller pause/removal while active reservation is blocked; Admin take-down is allowed and triggers the documented refund/release path.
- A pending price revision cannot be approved while the listing has an active reservation. It remains pending after expiry/cancellation and requires normal review; notify the seller in-dashboard and in-app.

### Reservation

- `active` → `paid`: verified webhook wins the serialized expiry/payment race while the reservation is still valid.
- `active` → `expired`: expiry worker or a database-time check in Buy/payment processing finds expiry reached and atomically releases the listing.
- `active` → `cancelled`: buyer cancellation before courier handover, subject to the order/payment state; a captured payment creates a system full-refund intent in the same transaction.
- `active` → `released`: authorized Admin take-down/other permitted release path with the corresponding reason and refund intent where captured.
- Terminal reservation states do not return to `active`. A provider event for an ended reservation never reopens it; a verified late capture is recorded and routed to an idempotent system refund.

### Order and payment

- Order: `reserved` → `payment_pending` → `funded` → `seller_preparing` → `handed_to_delivery` → `out_for_delivery` → `delivered` → existing `held`/complaint window → `completed`.
- Order failure exits: unpaid `reserved`/`payment_pending` → `cancelled` on expiry or permitted cancellation; funded pre-handover cancellation → `cancelled` plus full system refund; funded seller timeout after three days → `cancelled` plus full system refund. Post-handover issues are recorded for manual resolution; no new automatic entitlement is inferred.
- `payment_pending` → `succeeded` only from a verified gateway webhook. Browser redirects are display-only and cannot fund an order. Gateway failure updates payment attempt state but does not itself cancel a still-valid reservation unless its expiry/cancellation rule applies.
- Manual delivery status is an Admin-only transition; only authorized Admin `order.mark_delivered` may mark Delivered. Use the existing permission-based route pattern rather than role checks scattered in services.

### Temporary `Bag` compatibility

Treat legacy `bag` as a temporary compatibility alias for `reserved` only at API/read boundaries and for old data that still depends on it. New fixed-price Buy writes canonical `reserved`, never creates an offer or requires `accepted_offer_id`, and exposes `reserved` as canonical state. Remove the alias only after all stored Bag rows and consumers/tests have been migrated, checked, and the separately gated contract step confirms no dependency remains.

## 4. Concurrency and money races

- **Atomic Buy / one listing:** in one transaction, lock the listing row `FOR UPDATE`, re-read status/price/seller, reject unavailable/self-purchase, check supported city and current price, expire stale reservation state using `now()`, enforce buyer cap, insert reservation/order/payment-intent data, and enqueue durable work transactionally. The active-listing partial unique index is a second line of defense. Return conflict if another Buy wins.
- **Buyer cap under concurrent Buy:** serialize all active-unpaid count-and-insert operations for a buyer by locking the buyer row (or a transaction-scoped advisory lock keyed by buyer ID) before counting. Use the server setting (initially three), count only active unpaid reservations with `expires_at > now()`, and recheck in the transaction. Test simultaneous Buy requests for different listings by the same buyer.
- **Price revision approval:** approve and Buy both lock the same listing row. Approval checks for a non-expired active reservation after locking; when present it stays pending. Buy locks/rechecks the listing price and snapshot before creating reservation.
- **Expiry versus payment:** worker and webhook processing serialize on the same listing/reservation/order lock path and use database time. Exactly one transaction can transition an active reservation. If payment wins while active, mark funded; if expiry/release commits first, a later successful capture is marked late and refunded via a durable idempotency key—never resurrect the reservation. Persist provider event/capture timestamps for reconciliation, but do not use a client-supplied timestamp as authority.
- **Duplicate webhook:** unique `(provider, event_id)` inbox insert and unique provider transaction reference suppress duplicate deliveries; payment/order transition is transactional and state-checked. A duplicate returns success after the first verified event is durably recorded; it cannot duplicate ledger or refund effects.
- Establish and test one lock order for all money paths (listing → reservation/order → payment → refund aggregate) to prevent cross-path deadlocks. Retry only recognized serialization/deadlock conflicts under bounded policy; surface exhausted failures and dead-letter/reconcile rather than claiming success.

## 5. Server-authoritative totals

At Buy, load the current listing price and seller from the database, reject self-purchase by comparing authenticated buyer ID to listing owner, and snapshot price, configured delivery fee, total, currency, and validated delivery address. Ignore any browser-supplied fee, total, seller ID, order status, reservation expiry, or payment status. The server calculates `total = item price + delivery fee` using exact decimal/minor-unit arithmetic.

Read delivery fee and reservation settings through the validated `platform_settings` owner; initial fee is PKR 300, reservation window 60 minutes, and active-unpaid cap three. Require recipient name, phone, supported city and sufficient address fields at Buy. Check city against active delivery coverage at Buy, not only against the buyer profile. Store an immutable order address snapshot so profile edits do not change destination.

## 6. PaymentGateway, fake, and webhook

Define a narrow `PaymentGateway` adapter with typed operations equivalent to:

- `createHostedCheckout({ orderRef, amount, currency, idempotencyKey, returnUrl })` → provider reference and hosted URL.
- `verifyWebhook({ rawBody, headers, now })` → verified normalized event or explicit verification failure.
- `fetchPayment({ providerPaymentRef })` and a provider reporting/reconciliation operation for FR-70.
- `createRefund({ providerPaymentRef, amount, idempotencyKey })` for approved/system refund paths.

The fake adapter is explicit and non-production only, with controllable success, failure, duplicate event, and delayed event/capture cases. It must not be selectable as a live provider or imply payment readiness. Do not select a real provider in this design.

Commit the reservation/order/payment intent and its idempotency key before making an external gateway call. Create the hosted checkout outside the database transaction; return a checkout URL only after the adapter succeeds. If the external call fails, return an explicit service error while keeping a recoverable pending intent and active reservation; a retry uses the same key and cannot create a second charge. Define a retry/status response so the client never receives a success-shaped placeholder URL.

Mount `POST /api/webhooks/payments/:provider` with a bounded `express.raw()` parser before the general `express.json()` middleware. Verify the signature over exact raw bytes with constant-time comparison and stale-timestamp/replay checks before parsing. Reject invalid signatures without creating an inbox row. After verification, atomically insert the inbox event under unique provider/event ID and enqueue its processing job in that transaction; return 200 only after durable acceptance. Repeated verified events receive safe idempotent acknowledgement. Parse/normalize only after signature verification, process in a worker, and persist explicit failure/retry state.

## 7. Refunds

**System path:** expiry, buyer pre-handover cancellation, late payment, Admin take-down of an active funded reservation, and three-day seller handover timeout create a trigger-attributed full refund intent with a durable idempotency key in the same transaction as the state change. No second Admin approval is used. A worker calls the gateway with that key, records provider reference/status, and retries safely. A failed gateway call remains visibly pending/failed for retry and reconciliation; it never silently restores the order to a funded/active state.

**Manual path:** Admin 1 requests a permitted manual refund with reason and amount; Admin 2, a distinct Admin account, approves or rejects. Both must satisfy fresh TOTP step-up for their respective action using one-use, session-bound grants; reject self-approval. Apply route permissions, transactionally consume grants, lock payment/refund aggregate, write the append-only audit, and then enqueue the gateway operation idempotently. Preserve requester, approver, decision, timestamps and reason. Extend the existing step-up action model with separate refund request/approval actions; current actions do not cover refunds.

Partial-refund support is limited to schema, status representation and validation: amount must be positive and within the remaining refundable balance, and cumulative succeeded plus in-flight reservations cannot exceed the captured refundable amount. No buyer/admin partial-refund workflow, UI, or promise is included; full workflow stays deferred under Q18/FR-71.

## 8. Worker jobs

- **Reservation expiry:** recurring scan of due active reservations using database time; claim batches with row locks/`SKIP LOCKED`; transition once, release listing availability, enqueue notification and any required refund intent transactionally. Idempotency key derives from reservation and expiry transition.
- **Three-day handover deadline:** set deadline from the funded/fulfillment transition; recurring scan of funded orders not handed to courier by `now()`. Lock and recheck state/deadline; atomically cancel, record missed deadline, create system refund intent and audit action. Duplicate worker runs cannot repeat effects.
- **Gateway reconciliation (FR-70):** recurring provider report/fetch comparison against captured payment/refund records and ledger; record mismatches and alert/admin-visible work. Reconciliation identifies and reports differences; it does not automate seller payouts.
- Register jobs explicitly with the existing PostgreSQL PgBoss worker/scheduler. Choose cadence and batch size at implementation/operations planning; do not mistake scheduler enablement for an existing scheduled job. Use transactionally enqueued, deterministic job IDs and bounded retries. On exhausted retry, retain failure in dead-letter/health reporting and expose the mismatch for operator action; never silently mark money settled.

## 9. Second-Admin command and `PAYMENTS_ENABLED`

Provide a deliberate interactive command for creating an additional real Admin account. It must create a distinct user, collect its own authenticator secret and verify an initial TOTP code before marking enrollment enabled, validate identity fields/password, refuse duplicates, and audit who initiated creation. Do not print secrets outside the interactive one-time enrollment flow, log codes, or allow a command flag to bypass TOTP. Preserve `createInitialAdmin()`’s one-time bootstrap semantics; the additional-admin command is a separate guarded path.

Keep `PAYMENTS_ENABLED=false` by default and in production until explicit launch approval. If enabled in production, startup/config validation must fail closed unless at least two distinct, non-suspended Admin users exist and each has an enabled staff TOTP credential. Count distinct user IDs, not sessions, roles, or enrollment attempts. The command provisions an account; it does not itself enable payments. Provider credentials, sandbox evidence, legal review, security/operations review, and reviewed launch remain separate prerequisites.

## 10. API contracts

The following are proposed contracts for implementation review; route names may be aligned with existing conventions without changing the security or response guarantees. All authenticated endpoints use the bearer-token `requireAuth` path, return private/no-store responses, and derive buyer/admin identity from the authenticated principal, never the body.

| Operation | Request | Success response | Access and important errors |
|---|---|---|---|
| Buy | `POST /api/listings/:listingId/buy`; `{ address: { recipientName, phone, cityId, addressLine1, addressLine2?, postalCode? }, expectedPrice? }`. `expectedPrice` is optional stale-review context only; it is never charged. | `201 { orderId, reservationId, status: "reserved", expiresAt, itemPrice, deliveryFee, total, currency, payment: { status, checkoutUrl } }`. | Buyer auth. `400` invalid address, `401` no session, `403` self-purchase, `404` listing/city missing, `409` unavailable/cap reached/price changed, `422` unsupported city, `503` payment creation unavailable. |
| Payment status | `GET /api/orders/:orderId/payment` | `200 { orderId, reservationStatus, orderStatus, paymentStatus, amount, currency, expiresAt, hostedCheckoutUrl? }` | Buyer/order participant authorization; `401`, `403`, `404`. Never accept browser return as payment proof. |
| Cancel | `POST /api/orders/:orderId/cancel`; optional `{ reason }` only if existing policy needs it. | `200 { orderId, status: "cancelled", refund: { status, amount, currency } }` | Buyer/order ownership. `401`, `403`, `404`, `409` after handover/terminal transition. |
| Webhook | `POST /api/webhooks/payments/:provider`; provider-signed raw bytes. | `200 { received: true }` after durable inbox/job acceptance, including safe duplicate acknowledgement. | No user auth; provider signature required. `400` malformed event, `401` bad/stale signature, `404` unknown provider, `503` durable inbox unavailable. |
| Admin refund request | `POST /api/admin/orders/:orderId/refunds`; `{ amount, reason, stepUpGrant }` | `201 { refundId, status: "requested", amount, currency }` | Admin permission plus fresh request-action TOTP grant. `400` invalid amount/reason, `401`, `403`, `404`, `409` non-refundable/limit exceeded. |
| Admin refund decision | `POST /api/admin/refunds/:refundId/approve` or `/reject`; `{ decision, reason, stepUpGrant }` | `200 { refundId, status, decision }` | Admin permission, distinct approver, fresh decision-action TOTP grant. `403` self-approval or insufficient permission, `409` already decided/expired grant, `400` invalid decision. |
| Admin delivery update | `PATCH /api/admin/orders/:orderId/delivery`; `{ status, trackingNumber?, note? }` | `200 { orderId, deliveryStatus, trackingNumber?, updatedAt }` | `order.mark_delivered` permission for Delivered and appropriate delivery-update permission for other statuses; audit and notify. `400`, `401`, `403`, `404`, `409` invalid transition. |

Errors use the repository’s typed error handler and request ID shape. Never expose raw provider errors, internal identifiers not needed by the caller, signature data, secrets, or payment credentials.

## 11. Notifications and failure rules

Send in-app and rate-limited email notifications for meaningful reservation, payment, refund and delivery transitions, using the existing notification/email queue. Store/enqueue notifications in the same business transaction via the queue transaction adapter where possible. Notification failure does not roll back Buy, payment, refund, cancellation, or delivery state and is never evidence that a money operation failed. State and ledger are authoritative; retries must be notification-idempotent. Include the FR-73e seller dashboard/in-app blocked-approval notification. SMS and WhatsApp remain deferred.

## 12. Rollback and COD contract step

All Phase 4 schema work is expand-only: add tables, nullable links/snapshots, indexes, settings and compatible code. Deploy new readers/writers behind `PAYMENTS_ENABLED=false`; existing COD routes/data remain intact. Roll back by disabling the new flow and reverting compatible application code while retaining additive tables/data. Do not drop columns or mutate historical COD rows as a rollback shortcut.

COD column/table/enum cleanup is a separate contract step, not part of any reservation/payment stage. Require evidence that every deployed application/worker version and test no longer reads or writes `accepted_offer_id`, COD totals/preferences/collections or `bag`; inventory and migrate old data; confirm backup/restore and rollback limits; obtain explicit owner/release approval; then schedule a separate destructive migration. D1 confirms seller payouts remain manual even if buyer COD is later removed.

## 13. Test plan mapped to FR/SEC rows

Write tests with titles naming each FR/SEC and asserting the requirement. Use unit tests for deterministic validation, adapters, transition guards and idempotency; integration tests against real PostgreSQL and Redis for migration behavior, locks, transactional enqueue, worker retries and cross-process concurrency. Use fake gateway behaviors for success, failure, duplicate and delayed events; fake tests do not establish live-provider correctness.

| Requirement | Required coverage |
|---|---|
| FR-20, FR-63a, FR-73e | Concurrent Buy versus seller edit/removal and revision approval; single active reservation; pending revision remains pending; both seller notices queued. |
| FR-60a, FR-61, FR-62 | Hosted checkout only; client amount ignored; browser return never funds; only verified webhook advances to funded; transitions and legacy Bag alias. |
| FR-63, FR-63c | DB-time expiry; one reservation/listing; same-buyer concurrent cap; expired/cancelled/paid slots excluded; address/city/self-purchase validation. |
| FR-64, FR-65 | Store actual gateway fee; no seller payout request sent to buyer-payment adapter; manual payout path remains available. |
| FR-68, FR-72, FR-72e | Permission-scoped Delivered transition; three-day timeout once under concurrent workers; lost/refused issue recorded for manual handling only. |
| FR-69, FR-71 | System refund idempotency and triggers; manual two-Admin/TOTP/self-approval/audit; partial amount/status/cumulative-cap validation only, no partial workflow endpoint. |
| FR-70 | Reconciliation detects missing, mismatched and duplicate gateway records and does not automate payouts. |
| SEC-11, SEC-12 | Delivery/order/payment authorization boundaries, participant checks, Admin permissions and access-denial cases. |
| SEC-27, SEC-36 | No PII/secrets/raw webhook body in logs; private/no-store on every order/payment/refund/admin route; no money reads from cache. |
| SEC-33 | Raw byte signature, constant-time rejection, stale replay, unique inbox event, durable enqueue-before-200, duplicate event processing. |
| SEC-34, SEC-40 | Exact decimal/minor-unit calculations, transactional ledger, durable idempotency, append-only enforcement, refund trigger and aggregate limit under concurrency. |
| SEC-39 | Distinct real Admin IDs, fresh TOTP step-up per action, one-use session/action-bound grants, self-approval blocked, complete audit. |

## 14. Stage breakdown

Each stage below is a separate, bounded implementation chat/commit. No stage may tick a specification/security checkbox without the required named test and the repository’s test gate. **No code, migration, schema, spec/security changes or checklist ticks are authorized by this design-only task.**

| Stage | Likely files | Acceptance criteria | Must NOT do |
|---|---|---|---|
| 1. Review and test scaffolding | `test/integration/*`, test setup/config, `package.json` only if existing Redis/Postgres test dependencies require it | Confirm usable real PostgreSQL and Redis test services; capture pre-change tests; add focused test scaffolding and named empty/failing Phase 4 tests. | No payment behavior, schema migration or live provider. |
| 2. Expand-only schema | `db/migrations/<next-number>_phase4_expand.sql`, migration tests, schema snapshot if project convention requires | Add reservation/order snapshots, payment/refund/inbox/ledger/audit structures and indexes; preserve all COD columns/data; migration up/down/restore behavior explicitly tested. | No destructive COD cleanup, no ticks, no live credentials. |
| 3. Reservation/Buy engine | `src/modules/reservations.service.js` (or agreed owner), `src/modules/orders.service.js`, `src/modules/listingRevisions.service.js`, `src/modules/discovery.service.js`, `src/modules/listingSearch.service.js`, routes and real-Postgres integration tests | Atomic Buy, server totals/address/city/self-purchase checks, cap and listing concurrency, correct search availability, blocked price approval and notice. | No gateway selection, no browser-trusted payment, no offer creation, no COD drop. |
| 4. Gateway boundary and hosted checkout | `src/lib/adapters/paymentGateway.js` and fake adapter, `src/modules/payments.service.js`, config, payment routes, unit/integration tests | Adapter contract and explicit fake support success/failure/duplicate/delay; idempotent hosted checkout; production does not select fake or claim live readiness. | No real provider credentials/provider selection and no direct card-data handling. |
| 5. Webhook inbox and processing | `src/app.js`, webhook route, `src/modules/payments.service.js`, `src/lib/queue.js`, `worker.js`, migration only if required by approved expand design, tests | Raw-body mount before JSON parser; verified signature, durable unique inbox, transactional enqueue, safe repeated processing and verified-only funded state. | No signature bypass, no parse-before-verify, no browser-authorized funding. |
| 6. Refund foundation and full-refund paths | refund service/routes, `src/modules/users.service.js`, `src/routes/users.routes.js`, `src/lib/roles.js`, worker, tests | System triggers idempotent; manual two-admin TOTP workflow/audit; concurrency-safe refundable aggregate; partial-refund data/status validation covered. | No partial-refund end-to-end UI/API; no self-approval; no system path requiring a second Admin. |
| 7. Worker schedules and reconciliation | `src/lib/queue.js`, `worker.js`, reservation/payment/refund modules, worker integration tests | Explicit recurring expiry, handover deadline and FR-70 reconciliation schedules; locks, DB time, retries and dead-letter behavior verified across repeated runs. | No seller payout automation or silent reconciliation correction. |
| 8. Admin delivery and issue records | `src/modules/delivery.service.js`, `src/routes/delivery.routes.js`, roles/permissions, order state service, tests | Admin-only tracking/status updates, tracking number and audit, permission-only Delivered transition, manual issue visibility and notifications. | No courier API assumption and no automatic lost-parcel/refused-delivery refund policy. |
| 9. Second Admin and payment gate | `scripts/create-admin.js` or dedicated additional-admin command, `src/modules/users.service.js`, config/server startup, tests/docs | Interactive create command creates distinct enrolled Admin; production payment flag fails closed without two distinct enrolled Admins. | Do not weaken one-time initial bootstrap; do not enable live payments or accept a force/bypass flag. |
| 10. Client/API/notifications and launch gate | frontend files, route/client tests, `LIVE_CHECKS.md`, gate reports only when approved | Complete buyer/admin flows, notifications and failure UX; all in-scope named tests green; audit and external launch evidence reviewed. | No legal/provider/courier readiness claims without evidence; no live enablement before explicit gate approval. |
| 11. Separate COD contract | New separately approved migration/code/test commit after dependency/data/deployment review | Demonstrate no deployed consumer or row depends on COD fields/Bag alias; backup/recovery and cutover plan approved. | Must not be bundled into the expand-only migration or inferred from D1 alone. |

## 15. Open questions — options and recommended defaults (not decided here)

These are implementation/operations questions, not a reopening of Q1–Q19 or the owner-confirmed D1/D2 answers. The recommendation in each item is a default for later review only, not a decision.

1. **Which live gateway/provider and hosted checkout capabilities?** Options: (a) select after a sandbox and capability/security review; (b) implement a named provider before that review. **Recommended default: (a)**, as Q10 requires the adapter first and no provider selection is settled.
2. **How is the launch supported-city set maintained?** Options: (a) Admin-managed supported-city table; (b) configuration list shipped with releases. **Recommended default: (a)**, with audited activation and Buy-time lookup.
3. **Which exact address fields and validation rules are mandatory?** Options: (a) recipient name, phone, city, address line, optional locality/postal code; (b) a stricter normalized address schema. **Recommended default: (a)** with locally appropriate phone validation and explicit minimum address detail, pending delivery-operator review.
4. **What event time decides payment-versus-expiry when provider capture precedes a delayed webhook?** Options: (a) reservation/order state at serialized processing time; (b) verified provider capture time if the provider supplies an authenticated, sufficiently precise timestamp. **Recommended default: (b)** only when provider timestamp authenticity/precision is proven; otherwise fail safe by refunding rather than reopening an ended reservation.
5. **How often should recurring expiry and handover scans run?** Options: (a) one-minute scans; (b) five-minute scans; (c) provider/hosting-specific cadence. **Recommended default: (a)** for reservation expiry and handover detection, subject to load testing and configured deadline precision.
6. **What gateway report is available for FR-70 and how often should reconciliation run?** Options: (a) provider API/report on a scheduled daily job; (b) operator-uploaded report until an API exists; (c) both. **Recommended default: (c)**, with automated comparison where supported and an auditable manual fallback.
7. **What raw webhook payload retention period and fields are necessary?** Options: (a) encrypted/restricted raw body retained for a short incident-review window; (b) normalized event only after verification. **Recommended default: (a)** with short retention, access controls and documented deletion, because signature/replay investigation may need original bytes.
8. **Does the payment adapter support partial gateway refunds at launch?** Options: (a) store partial-refund-ready data but expose full refunds only; (b) expose partial refund only after Phase 5 workflow approval. **Recommended default: (b)**; Phase 4 remains data/validation only either way, per Q18.
9. **How is order address snapshot represented?** Options: (a) immutable JSONB snapshot; (b) normalized immutable columns. **Recommended default: (b)** for validation/queryability and explicit PII lifecycle, unless implementation review establishes a stronger reason for JSONB.
10. **What are the exact accounting and refundable-fee rules beyond the confirmed pre-handover buyer cancellation?** Options: (a) track item and delivery fee as separate ledger lines and follow explicit scenario policy; (b) treat every refund as one opaque total. **Recommended default: (a)**. Q9 requires full item plus full delivery fee on buyer pre-handover cancel, while deferred cases (including delivery-fee treatment for other full refunds) remain undecided.
11. **How long should verified webhook inbox raw bytes and associated PII be retained, and who can inspect them?** Options: (a) restricted operational role with short retention; (b) longer retention for audit/legal review. **Recommended default: (a)** until legal/data-retention review sets a longer period.
12. **What exact delivery status vocabulary and transition mapping is used between order and delivery log?** Options: (a) keep the existing delivery status log and define a mapping to order state; (b) replace delivery history with a single order enum. **Recommended default: (a)** to preserve existing tracking/history while making the order transition authoritative.
