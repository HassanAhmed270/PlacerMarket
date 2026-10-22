# Schema/code audit — Phase 0a-1b

Comparison of service behavior and SQL with `schema.sql` and the current project
requirements. Phase 0a-2a through 0a-2c implementation state is reflected below.
The migration foundation adds the existing schema unchanged as the initial
versioned migration and generates `schema.sql` from it; no domain-schema change
was introduced. Classifications follow the intended
implementation sequence: `fix-0a-2a` is users/catalog SQL
repair; `fix-0a-2b` is listing SQL and behavior repair; `fix-0a-2c` is discovery
repair and regression tests; `defer-Phase-1` is payout functionality;
`superseded-4-5` is explicitly superseded COD/payment/delivery behavior;
`needs-decision` is an unresolved requirement or schema/API contract; and
`no-mismatch-static-only` means static inspection found no mismatch. These labels
do not authorize or start a repair phase.

Evidence labels distinguish actual PostgreSQL reproductions from static review.
PostgreSQL messages below were captured by temporary pin tests against
PostgreSQL 18.6. Corrected users/catalog behaviors are now covered by normal
passing integration tests with valid foreign-key fixtures and cleanup. The
retained `test.failing` probes cover known behavior gaps. Separate passing
error-code pin tests explicitly record these known mismatches:
`updateSellerPayoutMethod` (`42703`, deferred to Phase 1). The former
`holdListingPendingIdVerification` (`22P02`) mismatch is resolved by removing
the invalid status transition and using the approved temporary email-verification
publication gate. Other findings
are represented by static or scratch-copy evidence where a valid isolated
regression fixture is not appropriate; the probe set is not exhaustive.

| Classification | File | Function / area | Finding | Evidence level and evidence |
|---|---|---|---|---|
| `fix-0a-2a` | `src/modules/users.service.js` | `registerUser` | **Fixed:** maps the input `name` to `users.full_name`. | **Passing PostgreSQL regression:** `registration persists the supplied name in the user full_name field`. The pre-repair pin had reproduced `42703`, column `name` did not exist. |
| `fix-0a-2a` | `src/modules/users.service.js` | `suspendSeller` | **Fixed:** sets `users.is_suspended = true`. | **Passing PostgreSQL regression:** `seller suspension updates the is_suspended flag`. The pre-repair pin had reproduced `42703`, column `status` did not exist. |
| `needs-decision` | `src/modules/users.service.js` | `submitSellerApplication` | FR-06 expects name, phone, and city input, while schema stores `user_id`, `reason_for_selling`, and `what_will_sell`. Decide whether values come from the user row or the schema/API needs a migration. | **Reproduced SQL error:** `42703`, `column "name" of relation "seller_applications" does not exist`. Conflict with FR-06 is also confirmed by static comparison. Service line 82; schema lines 57–69; `specs.md` FR-06. |
| `fix-0a-2a` | `src/modules/users.service.js` | `reviewSellerApplication` | **Fixed:** writes the supplied reason to `rejection_reason`; no additional seller-approval behavior was added. | **Passing PostgreSQL regression:** `seller application rejection stores its rejection reason`. The pre-repair pin had reproduced `42703`, column `decision_reason` did not exist. |
| `needs-decision` | `src/modules/users.service.js` | `reviewSellerApplication` | Current approval code creates/updates a profile with `is_approved = true` and `approved_at = now()` and promotes the user. The open question remains whether FR-07/FR-08 requires these profile fields as part of approval; no new product decision is inferred. | Passing PostgreSQL regression now verifies role promotion, profile approval flag and timestamp. See `open-questions.md` FR-07/FR-08 entry for the still-open requirement interpretation. |
| `Phase-1-Stage-6` | `src/modules/users.service.js` | `updateSellerPayoutMethod` | **Implemented:** validates `bank`, `easypaisa`, or `jazzcash`, stores the seller-bound encrypted envelope, clears legacy plaintext columns, and returns masked metadata. Migration 010 adds last-four, change timestamp, stale-data flag, and audited payout-hold fields. | Unit validation/encryption tests pass. PostgreSQL regression is added as `FR-09a, SEC-30/35, FR-66/83l` in `test/integration/known-mismatches.test.js`; it remains unverified until `TEST_DATABASE_URL` is provided. |
| `fix-0a-2a` | `src/modules/catalog.service.js` | `getMeasurementFieldDefs` | **Fixed:** orders by existing `display_order`. | **Passing PostgreSQL regression:** `measurement definition lookup returns fields ordered by display_order`. The pre-repair pin had reproduced `42703`, `sort_order` did not exist. |
| `fix-Phase-1` | `src/modules/catalog.service.js` | `setMeasurementFieldDefs` | **Fixed:** definitions can be added, renamed and reordered; required/active state is persisted. Omitted referenced fields are retired, and unreferenced definitions may be removed. | Passing PostgreSQL tests cover ordering, rename/reorder, required-field enforcement, duplicate-name validation, empty replacement when unused, and retirement with old values preserved. |
| `fix-Phase-1` | `src/modules/catalog.service.js` | `setMeasurementFieldDefs` `required` input | **Fixed:** migration `006_measurement_field_lifecycle.sql` adds `required BOOLEAN NOT NULL DEFAULT false`; definitions persist the flag and listing creation enforces required active values. | **Passing PostgreSQL regression:** `FR-15a: required active measurement fields persist and are enforced when a listing is created`. |
| `fix-Phase-1` | `src/modules/catalog.service.js` | `setMeasurementFieldDefs` with referencing measurements | **Fixed:** referenced omitted definitions are marked inactive; their IDs and existing values remain intact. Listing creation and definition edits serialize on the sub-category row. | Passing PostgreSQL regression: `FR-15a: referenced measurement definitions retire while existing listing values remain`. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `createListing` | **Fixed:** persists required title and replica disclosure and starts the listing as `draft`. | Passing PostgreSQL regression: `FR-14, FR-15: listing creation persists title and replica disclosure and starts as draft`. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `saveListingMeasurements` | **Fixed:** maps configured measurement names to `listing_measurements.field_def_id`. | Passing PostgreSQL regression: `FR-15a: listing measurements store the configured field definition ID`. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `addListingImages` | **Fixed:** persists `image_url` and sequential `display_order`; seller ownership and the 3–6 photo lifecycle checks are covered separately. | Passing PostgreSQL regression: `FR-16: listing images persist through image_url and display_order`; ownership/count tests also pass. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `submitAuthenticityEvidence` | **Fixed:** persists `evidence_url`, leaves `evidence_type` nullable, and does not infer a type. | Passing PostgreSQL regression: `FR-17: authenticity evidence persists evidence_url with nullable evidence_type`. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `approveListing` | **Fixed:** publishes only pending listings using `published`, recording `reviewed_by` and `published_at`; enforces the existing photo and high-value gates. | Passing PostgreSQL regressions cover approval metadata, insufficient photos and the high-value publication gate. |
| `fix-0a-2b` | `src/modules/listings.service.js`, `src/routes/listings.routes.js` | `approveListing`; retired `holdListingPendingIdVerification` route | The invalid `held_pending_id` transition and route are removed. Under approved FR-08a/FR-08b, high-value publication is blocked until registered-email verification exists; that mechanism is scheduled for Phase 1 before Phase 2. No schema enum value or legal-identity check is introduced. | Passing PostgreSQL integration regressions verify the hold enum value is absent and the legacy ID flag does not bypass the high-value email gate. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `rejectOrUnpublishListing` | **Fixed:** persists `rejection_reason` and uses the schema-valid `unpublished` status for a published listing. | Passing PostgreSQL regressions cover rejection-reason retention and unpublishing. |
| `needs-decision` | `src/modules/discovery.service.js` | `filterListings` | Accepts `cityId` but never applies it; schema has no listing city column. Decide whether filtering should follow seller city or require another data-model change. | **Static only:** parameter is destructured but not used; no city column exists on `listings`. Service lines 37–46; schema lines 126–154. |
| `fix-0a-2c` | `src/modules/discovery.service.js` | `searchListings`, `filterListings` | **Fixed for supported filters:** only `published` listings are returned; search matches title or description and filter supports category, sub-category, condition and inclusive price bounds. City remains unresolved. | Passing PostgreSQL regressions cover title/description search, published-only results, and non-city filters. |
| `fix-0a-2c` | `src/modules/discovery.service.js` | `getSellerPublicCard` | **Fixed:** uses the seller profile creation date and returns only rating and join date; no display alias, seller ID or other private profile fields are included. | Passing PostgreSQL regression: `FR-27a: public seller card contains only rating and join date`. |
| `fix-0a-2c` | `src/modules/discovery.service.js` | `getListingDetail` | **Fixed:** only published listings are visible; the public detail includes ordered images and the permitted seller summary, with moderation metadata omitted. | Passing PostgreSQL regressions cover hidden draft/rejected listings, image ordering, seller-summary fields and unauthenticated detail access. |
| `fix-0a-2b` | `src/modules/listings.service.js` | `updateOwnListing` | **Fixed for drafts and rejected listings:** applies an allowlisted content patch only for the owner, rejecting system-controlled fields. Published edits are safely refused because the existing schema has no pending-content version storage; do not overwrite approved content. | Passing PostgreSQL regressions cover draft edits, ownership, system-field rejection, rejected correction/resubmission, and preservation of published content when the edit is refused. |
| `no-mismatch-static-only` | `src/modules/notifications.service.js` | SQL/listener queries | Referenced seller application, listing, order, and notification columns exist in schema. | **Static only:** identifier comparison; not a complete integration proof. Service lines 26–99; schema corresponding tables. |
| `no-mismatch-static-only` | `src/modules/negotiation.service.js` | SQL functions | Conversation, message, and offer identifiers/statuses match schema. | **Static only:** identifier and enum comparison. Service lines 29–108; schema lines 195–228. |
| `superseded-4-5` | `src/modules/orders.service.js` | COD-shaped order functions | Referenced columns/statuses match the COD-era schema; COD-shaped order/payment behavior is superseded. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 35–180; schema lines 230–277. |
| `superseded-4-5` | `src/modules/delivery.service.js` | Delivery partner/status functions | Referenced delivery columns/statuses match; cash-collection-shaped assumptions are superseded. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 33–81; schema lines 295–320. |
| `superseded-4-5` | `src/modules/payments.service.js` | COD collection functions | SQL matches the COD-era table. Payments/COD behavior is superseded. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 41–65; schema lines 279–293. |
| `superseded-4-5` | `src/modules/payout.service.js` | Hold/release functions | Referenced hold columns/statuses match; COD-order release flow is superseded. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 40–139; schema lines 354–372. |
| `superseded-4-5` | `src/modules/settlement.service.js` | Settings/settlement functions | Referenced columns match; COD-era settlement flow is superseded. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 25–113; schema lines 374–400. |
| `superseded-4-5` | `src/modules/disputes.service.js` | Dispute SQL/order dependencies | Referenced columns/statuses match; COD-shaped order dependencies belong to the later rewrite. **Do not fix here.** | **Static only:** SQL/schema comparison. Service lines 44–160; schema lines 245–263, 322–352. |
| `no-mismatch-static-only` | `src/modules/admin.service.js` | All functions | No direct SQL; delegates to owning services. | **Static only:** source inspection. Service lines 1–117. |

The persistent integration suite does not claim every row is reproduced; other
findings have the evidence level stated in their rows. The seller-application
input/schema discrepancy, seller-approval question, measurement-definition
`required` and foreign-key behavior, and city-filter semantics remain unresolved.
Published-listing edit versioning also requires a separately approved schema
change before that behavior can be implemented safely.
