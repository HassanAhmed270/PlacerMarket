# Schema/code mismatch audit — Phase 0a-1

Read-only comparison of SQL in service modules with `schema.sql` (2026-10-19).
Probes for inexpensive, reproducible mismatches are in
`test/integration/known-mismatches.test.js` and use Jest 29 `test.failing`.

| file | function | problem | evidence |
|---|---|---|---|
| `src/modules/users.service.js` | `registerUser` | Inserts `users.name`; schema requires `users.full_name`. | `users.service.js:30`; `schema.sql:39-53` |
| `src/modules/users.service.js` | `suspendSeller` | Writes `users.status = 'suspended'`; schema has boolean `is_suspended`, with no `status` column. | `users.service.js:189`; `schema.sql:39-53` |
| `src/modules/users.service.js` | `submitSellerApplication` | Inserts `name`, `phone`, `city_id`; these columns are not in `seller_applications`. The schema stores `user_id`, `reason_for_selling`, and `what_will_sell`. | `users.service.js:82`; `schema.sql:57-69` |
| `src/modules/users.service.js` | `reviewSellerApplication` | Writes `decision_reason`; schema column is `rejection_reason`. | `users.service.js:98`; `schema.sql:57-69` |
| `src/modules/users.service.js` | `updateSellerPayoutMethod` | Writes absent `payout_details`; accepts `bank_transfer` / `mobile_wallet`, but enum values are `bank` / `easypaisa` / `jazzcash` and storage is split across `payout_bank_account` / `payout_wallet_number`. **Superseded by Phases 4-5, do not fix.** | `users.service.js:177-185`; `schema.sql:30-31,71-88` |
| `src/modules/catalog.service.js` | `getMeasurementFieldDefs` | Orders by absent `sort_order`; schema has `display_order`. | `catalog.service.js:78`; `schema.sql:108-118` |
| `src/modules/catalog.service.js` | `setMeasurementFieldDefs` | Inserts absent `required` and `sort_order`; schema defines `display_order` and no `required`. | `catalog.service.js:91-93`; `schema.sql:108-118` |
| `src/modules/listings.service.js` | `saveListingMeasurements` | Inserts `listing_measurements.field_name`; schema requires `field_def_id` referencing `measurement_field_defs(id)`. | `listings.service.js:68`; `schema.sql:156-161` |
| `src/modules/listings.service.js` | `createListing` | Omits `listings.title`, which is `NOT NULL` with no default, so a normal create fails before measurement writes. | `listings.service.js:41-48`; `schema.sql:126-154` |
| `src/modules/listings.service.js` | `addListingImages` | Inserts `url` and `sort_order`; schema columns are `image_url` and `display_order`. | `listings.service.js:78`; `schema.sql:163-168` |
| `src/modules/listings.service.js` | `submitAuthenticityEvidence` | Inserts `url` and `submitted_by`; schema has `evidence_url`, `evidence_type`, and no submitter column. | `listings.service.js:91`; `schema.sql:170-176` |
| `src/modules/listings.service.js` | `approveListing` | Uses enum value `live` (not in `listing_status`) and absent columns `approved_by`, `approved_at`; schema has `published`, `reviewed_by`, `published_at`. | `listings.service.js:147`; `schema.sql:121-154` |
| `src/modules/listings.service.js` | `holdListingPendingIdVerification` | Uses enum value `held_pending_id`, absent from `listing_status`. | `listings.service.js:157`; `schema.sql:121-125` |
| `src/modules/listings.service.js` | `rejectOrUnpublishListing` | Writes absent `decision_reason`; schema has `rejection_reason`. | `listings.service.js:178`; `schema.sql:126-154` |
| `src/modules/discovery.service.js` | `searchListings`, `filterListings` | Filter on enum value `live`; schema has `published` instead. | `discovery.service.js:28,45`; `schema.sql:121-125` |
| `src/modules/discovery.service.js` | `getSellerPublicCard` | Reads `profile.display_name`; schema names the column `display_alias`. | `discovery.service.js:94`; `schema.sql:71-88` |
| `src/modules/notifications.service.js` | `registerListeners` | Reads `seller_applications.user_id`, listing seller IDs, and order participants. These referenced columns exist; no schema mismatch found. | `notifications.service.js:66-99`; `schema.sql:57-69,126-154,245-263,402-410` |
| `src/modules/negotiation.service.js` | all SQL functions | Referenced conversation, message, and offer columns/status values match schema. No mismatch found. | `negotiation.service.js:29-108`; `schema.sql:195-228` |
| `src/modules/orders.service.js` | order and review queries | Referenced columns/statuses match the COD-era schema. COD-shaped order behavior and `total_cod_amount` reads are **superseded by Phases 4-5, do not fix**. | `orders.service.js:35-180`; `schema.sql:230-277` |
| `src/modules/delivery.service.js` | all SQL functions | Delivery partner and status-log names/status values match schema. Cash-collection-shaped courier assumption is **superseded by Phases 4-5, do not fix**. | `delivery.service.js:33-81`; `schema.sql:295-320` |
| `src/modules/payments.service.js` | COD collection functions | SQL matches the COD-era `cod_collections` table; payments/COD behavior is **superseded by Phases 4-5, do not fix**. | `payments.service.js:41-65`; `schema.sql:279-293` |
| `src/modules/payout.service.js` | hold and release functions | Referenced payout-hold columns and enum values match schema; COD-order release flow is **superseded by Phases 4-5, do not fix**. | `payout.service.js:40-139`; `schema.sql:354-372` |
| `src/modules/settlement.service.js` | settings and settlement functions | Referenced platform settings and settlement columns match schema; COD-era settlement flow is **superseded by Phases 4-5, do not fix**. | `settlement.service.js:25-113`; `schema.sql:374-400` |
| `src/modules/disputes.service.js` | all SQL functions | Referenced orders, disputes, and evidence columns/statuses match schema. Its COD-shaped order dependencies are **superseded by Phases 4-5, do not fix**. | `disputes.service.js:44-160`; `schema.sql:245-263,322-352` |
| `src/modules/admin.service.js` | all functions | No direct SQL; delegates SQL work to owning services. | `admin.service.js:1-117` |

No `src/`, `db/`, or schema files were changed. This audit compares identifiers and
enum values statically; passing matches are not claimed as end-to-end behavior proof.
