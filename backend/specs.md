# Poshaak — Specification Checklist (specs.md)

**Purpose:** Every row below is one spec/requirement for the Poshaak C2C fashion marketplace (bridal/occasion-wear focus). Tick the checkbox once that specific item is fully built and verified — not just started.

**Legend:** `[ ]` = not done · `[x]` = done · items marked **(DEFERRED)** are explicitly out of MVP scope · items marked **(OPEN)** still need a product decision before they can be built · items marked **(DISCUSS)** are recommended or proposed but NOT confirmed by the human — discuss before building; they cannot be ticked until the human removes the tag · items marked **(SUPERSEDED)** were replaced by a later decision — do not build them

Phase 1 implementation evidence and residual release-gate items are summarized
in `PHASE1_GATE_REPORT.md`. Checked rows below retain their named test evidence;
unchecked rows remain open. `LISTING_REVISIONS_PLAN.md` is a Phase 2 proposal and
does not satisfy or tick FR-73/FR-73a/FR-73e.

---

## 1. Identity & Users
- [x] FR-01 Users can register an account (buyer by default).
- [ ] FR-02 Users can authenticate and manage sessions.
- [ ] FR-03 System requires location/city verification before buying or selling.
- [ ] FR-04 Admin can configure supported marketplace cities.
- [ ] FR-05 System supports roles: Buyer, Seller (approved), Admin, Moderator/Ops.
- [ ] FR-05a Moderator/Ops role has limited permissions: can review listings, review/resolve disputes, and approve/reject seller applications — CANNOT configure fees or suspend users.
- [x] FR-06 A buyer with a verified city (FR-03) can submit a "Become a Seller" application. Name, phone and city come from the user's profile; the application stores only `reason_for_selling` and `what_will_sell`. No CNIC/ID is collected at application time. Test: `FR-06: seller applications require a set city and store only reasonForSelling and whatWillSell` in `test/integration/known-mismatches.test.js`.
- [x] FR-07 Admin or Moderator/Ops can review, approve, or reject seller applications, with a rejection reason. Approval atomically sets the user's Seller role and `seller_profiles.is_approved = true` with `approved_at`; suspension/revocation clears seller approval state. Tests: `FR-07: approval atomically sets seller role, approval flag and approval timestamp`, `FR-07: failed seller approval rolls back the application and profile changes`, and `FR-07: rejected seller applications record the required reason` in `test/integration/known-mismatches.test.js`.
- [x] FR-07a Rejected seller applications can be resubmitted; reviewed case-by-case, no automatic cooldown/retry rule. Test: `FR-07a: rejected applications can be resubmitted with a link to the rejected application` in `test/integration/known-mismatches.test.js`.
- [ ] FR-07b Seller-application review queue lives as a sub-tab inside Admin → Users (not a separate top-level nav item).
- [x] FR-08 Only approved sellers can access seller tools (listing creation, seller dashboard, offer management). Test: `FR-08: seller suspension blocks seller listing operations and sets the suspended flag` in `test/integration/known-mismatches.test.js`.
- [x] FR-08a Temporary policy: verify control of the seller's registered email only when a listing's price is strictly above the admin-configurable `platform_settings.high_value_threshold_pkr` (seed 100000 PKR) — triggered per listing, not per seller upfront. A price equal to the threshold does not trigger verification. Email verification is not proof of legal identity, must not set `seller_profiles.id_verified`, and must not create a `held_pending_id` state. Tests: `FR-08a, FR-19b: the threshold is not high-value and prices above it remain pending` and `FR-19b: a price equal to the threshold can be approved without email verification` in `test/integration/known-mismatches.test.js`.
- [x] FR-08b A high-value listing whose seller's registered email is unverified remains `pending_review` and cannot be published under the temporary email-control policy, even after a separate manual identity check; registered email verification permits approval. Test: `FR-08b, FR-19b: above-threshold listing remains pending until registered email verification` in `test/integration/known-mismatches.test.js`. Manual identity verification is separate and required before first payout under FR-66/FR-66a.
- [ ] FR-09 Approved sellers maintain an individual seller profile (name/alias, rating, join date, item count) — must read as an individual, not a shop/storefront.
- [x] FR-09a Seller payout method is bank, Easypaisa or JazzCash, matching the schema enum. Bank details are bank name, account title and IBAN/account number; wallet details are wallet number and holder name. Writes require an enrolled authenticator and a session-bound `payout.update` step-up grant; values are encrypted at rest, legacy plaintext columns are cleared on update, responses expose only method/last four/change time, and each change queues a generic notice. Tests: `test/unit/users.service.test.js` FR-09a bank/wallet encryption/masking tests and `test/integration/known-mismatches.test.js` FR-09a SEC-30/35 API/leak regression.
- [x] FR-10 Admin can suspend/revoke a seller's approval. Test: `FR-10: suspending a seller clears approval and approved_at` in `test/integration/known-mismatches.test.js`.

## 2. Catalog
- [ ] FR-11 Two-level category structure: Main Category (Men's/Women's/Kids') → Sub-category/Occasion, defined PER main category (not shared), admin-extensible over time.
- [ ] FR-12 Admin can add/edit/remove main categories and sub-categories independently.
- [ ] FR-13 Item Condition/Type independent of category: Brand New, Pre-Owned, Custom-Made, Replica (disclosed).
- [ ] FR-14 Explicit disclosure fields required when marked Replica; replica allowed under ANY sub-category (no restriction), never presented as authentic.
- [ ] FR-14a Buy-only for MVP — no rent/lease listing type. **(DEFERRED: rental)**

## 3. Listings
- [ ] FR-15 Sellers create a listing with a server-validated title: category, sub-category, condition, asking/reference price (not fixed buy-now), description, structured measurements, images. Unsupported and retired fields are rejected.
- [x] FR-15a Measurement fields are defined per sub-category and are admin-configurable; each listing stores structured values against the field set active at creation. Admins can add, rename and reorder definitions, and retire rather than delete referenced definitions. Creation accepts exactly one exact `fieldName` or `fieldDefId`; unknown, ambiguous, duplicate, and inactive definitions are rejected. Tests: `FR-15a: measurement definition replacement persists flexible fields in display order`, `FR-15a: administrators can rename and reorder existing measurement field definitions`, `FR-15a/FR-15d: required active measurement fields persist and are enforced when a listing is created`, `FR-15a/FR-15d: referenced measurement definitions retire while existing listing values remain`, `FR-15a: listing creation accepts an active measurement definition ID`, and `FR-15a: listing creation rejects unknown and inactive measurement definitions` in `test/integration/known-mismatches.test.js`.
- [x] FR-15d A measurement definition has `required BOOLEAN NOT NULL DEFAULT false` and `is_active BOOLEAN NOT NULL DEFAULT true`. Admins choose whether a field is required; active required fields are enforced at listing creation. Retired definitions remain available to existing listings, which retain their stored values. Tests: `FR-15a/FR-15d: required active measurement fields persist and are enforced when a listing is created` and `FR-15a/FR-15d: referenced measurement definitions retire while existing listing values remain` in `test/integration/known-mismatches.test.js`.
- [ ] FR-15b Richer attributes: fabric/material, brand (if applicable), color, embellishment/handwork detail.
- [ ] FR-16 Sellers can upload multiple images per listing.
- [ ] FR-17 Sellers can optionally submit authenticity evidence (receipts, tags, docs) for a listing.
- [ ] FR-18 Admin/Moderator can review evidence and grant a "Verified Listing" badge — independent of item condition.
- [ ] FR-18a **(OPEN)** Verified-badge grant criteria not yet defined — to be decided later by admin.
- [ ] FR-19 All new listings enter ONE unified moderation queue, requiring approval before going live. High-value (email-verification-required under the temporary policy) and evidence-submitted listings are flagged/badged inline within this same queue, not split into separate queues.
- [ ] FR-19a Listing approval (go-live) and Verified-badge grant are separate, independent decisions — a listing can be approved to go live without the Verified badge.
- [x] FR-19b Listings strictly above `platform_settings.high_value_threshold_pkr` additionally require the seller's registered email to be verified before approval under the temporary policy (see FR-08a/FR-08b); equality does not trigger the gate. Tests: the two FR-08a/FR-19b integration tests listed above verify strictly-above rejection/approval and equality behavior.
- [ ] FR-20 Sellers can edit, pause, or remove their own listings. Edits to a LIVE listing go through moderation (FR-73) and the approved version stays public meanwhile; pausing or removing is immediate, except while the listing is reserved (FR-63a, DISCUSS). *(Revised 2026-10-15: removes the clash with FR-73.)*
- [ ] FR-21 Admin can unpublish/reject a listing post-publication if it violates policy, with a reason.
- [ ] FR-21a Rejected listings can be resubmitted after edits; reviewed case-by-case, no automatic cooldown.

## 4. Search & Discovery
- [x] FR-22 Pure browsing (viewing marketplace, listing details, images) is fully public — no login required.
- [ ] FR-22a Login required the moment a user favorites a listing, messages a seller, or makes an offer.
- [ ] FR-22b Redirect-and-return login pattern: logged-out user attempting a gated action is sent to /login, then returned to the exact action after successful login (no inline modal).
- [x] FR-23 Buyers can search listings by keyword.
- [ ] FR-24 Buyers can filter by main category, sub-category/occasion, condition, price range, and seller registered city. The city filter joins through `users.city_id`.
- [x] FR-25 Buyers can view full listing details, seller profile summary, images.
- [ ] FR-26 Buyers can favorite/save listings (requires login).
- [ ] FR-27 Buyers can share a listing (external link, no login required).
- [x] FR-27a Seller's public profile card (buyer-facing) shows the seller's `display_alias`, rating, and join date — no sales count, no verified badge, no response-time stats. (Seller's own private dashboard may show richer stats to themselves.) Test: `FR-27a: public seller card includes display alias, rating, and join date only` in `test/integration/known-mismatches.test.js`.
- [ ] FR-27b Two-way rating system: after order completion, both buyer and seller can rate each other. Feeds FR-27a.

## 5. Messaging & Negotiation
- [ ] FR-28 Buyers and sellers can message each other in-platform about a specific listing.
- [ ] FR-29 No fixed "Buy Now" path at all, at any price point. Negotiation (offer/counter/accept) is the only path to a sale.
- [ ] FR-30 System detects/blocks attempts to share phone numbers, emails, or external links in messages.
- [ ] FR-31 All negotiation history tied to the listing/order for later reference (dispute evidence).

## 6. Orders
- [ ] FR-32 An accepted offer moves to the buyer's Bag (accepted-offer-awaiting-checkout state) — NOT an immediate finalized order.
- [ ] FR-32a Buyer completes a checkout step from the Bag: confirms the delivery address and reviews the final total (item price + delivery fee), then pays through the gateway (FR-60–FR-62). A Bag entry exists from the moment an offer is accepted (an order in state Bag, reserved, not yet a finalized order); it moves to Awaiting Payment at checkout and to Funded on the verified webhook. *(Revised 2026-10-15: removes the COD wording and the "record only created after checkout" clash with FR-33/FR-62.)*
- [ ] FR-32b Bag/checkout remains single-item at a time (one seller per checkout). *(Clarified 2026-10-15: this limits the checkout/payment step to one item at a time; whether several accepted-and-reserved items may wait is FR-63c, DISCUSS.)*
- [ ] FR-33 Order lifecycle states: Bag → Awaiting Payment → Funded → Seller Preparing → Handed to Delivery Partner → Out for Delivery → Delivered → Completed (revised 2026-10-14 for escrow, see FR-62). Failure paths: payment window expired, Cancelled (pre-dispatch, buyer refunded), Returned/Refund Requested (post-delivery dispute).
- [ ] FR-33a Buyer can freely cancel any time before handover to delivery partner — no fee, and the buyer is refunded (escrow). Once handed off, the buyer's only route is a dispute/return (the old COD refusal at the door is parked — see FR-33b).
- [ ] FR-33b **(OPEN / MAJOR GAP)** COD refusal-at-the-door flow is undefined: who logs the refusal, whether repeat-refusal buyers are flagged, what happens to the physical item (return logistics/cost), whether it counts against the seller. Needs its own dedicated spec round before build. Under escrow (decided 2026-10-13) the buyer has already paid, so refusal becomes a refund/return question — parked for the policies discussion.
- [ ] FR-34 Buyers and sellers can view order status/history relevant to their role.

## 7. Payments & COD  (SUPERSEDED by escrow — see section 13)
- [ ] FR-36 **(SUPERSEDED by escrow — see FR-60 to FR-72)** Cash on Delivery is the only payment method for MVP — no online payment gateway, no escrow/fund-holding.
- [ ] FR-36a **(SUPERSEDED by escrow — see FR-60 to FR-72)** At the door, buyer chooses Cash (hands to courier) OR Digital transfer (to a platform-owned account/number shown at delivery; courier confirms receipt before releasing parcel). Both converge on the same downstream pipeline — funds reach the platform before the seller ever sees them.
- [ ] FR-36b **(SUPERSEDED by escrow — see FR-60 to FR-72)** Checkout step presents payment as a METHOD PREFERENCE (Cash vs. Digital transfer), not an actual payment step — no in-app payment processing.
- [ ] FR-37 **(SUPERSEDED by escrow — see FR-60 to FR-72)** System records agreed order amount and expected COD collection amount at checkout.
- [ ] FR-38 **(SUPERSEDED by escrow — see FR-60 to FR-72)** No commission/payout release until COD collection is confirmed by the delivery partner.

## 8. Delivery
- [ ] FR-39 Delivery is arranged/controlled by the platform — seller only hands the item to a marketplace-approved courier.
- [ ] FR-40 **(SUPERSEDED by escrow — see FR-60 to FR-72)** Delivery partner must support cash collection at the door and remittance of collected cash back to the platform.
- [ ] FR-40a **(OPEN)** Number of delivery partners (single vs. multiple) and city-based assignment not yet decided — admin config screen should be BUILT to support multiple partners regardless of how many are used at launch.
- [ ] FR-41 Delivery status tracked via MANUAL updates (an admin enters status through an internal screen for now — see FR-68) for MVP. **(DEFERRED: real-time courier API/webhook integration)**
- [ ] FR-41a **(SUPERSEDED by escrow — see FR-60 to FR-72)** Cash remittance from courier to platform confirmed via MANUAL reconciliation by admin/ops against courier statements/reports for MVP. **(DEFERRED: automatic API-based remittance confirmation)**
- [ ] FR-42 Buyers and sellers can view delivery/tracking status for their relevant orders.

## 9. Disputes, Returns & Refunds
- [ ] FR-43 Buyer can report a problem with a delivered order within a complaint window (~2-3 days post-delivery, provisional/admin-configurable).
- [ ] FR-43a Buyer must upload photos/evidence when filing a dispute — text description alone is not accepted.
- [ ] FR-43b Dispute reason is free-text only — no fixed reason-category list.
- [ ] FR-43c Seller CAN respond/submit counter-evidence before admin decides. *(Working default — not explicitly confirmed by stakeholder, revisit if needed.)*
- [ ] FR-43d After the complaint window closes with no dispute, order proceeds to normal settlement automatically.
- [ ] FR-44 Admin/Moderator can review disputes and evidence (messages, images, order data) in a view combined with HELD orders (one screen, not two separate queues).
- [ ] FR-45 System supports Return Required → Returned → Refund/Resolution states.
- [ ] FR-45a **(DISCUSS)** Dispute resolution granularity — binary vs. partial/split. The human left this to Claude's recommendation: partial refunds allowed (see FR-71), adopted as the working decision unless the human objects. Confirm before building.

## 9a. Payout Hold Window
- [ ] FR-45b Seller's net payout enters a HELD state once the order is marked Delivered (the buyer's payment has been held in escrow since Funded), not paid out immediately.
- [ ] FR-45c Hold window ~5 days from delivery (provisional, admin-configurable), containing the ~2-3 day complaint window.
- [ ] FR-45d Payout releases only at the end of the FULL hold window by default — no early release, regardless of complaint window closing early.
- [ ] FR-45e Admin CAN manually force-release a payout early, overriding the default hold — but MUST enter a reason/note (audit trail) to do so.
- [ ] FR-45f Force-release is BLOCKED while there is an open unresolved dispute on that order (must resolve dispute first).
- [ ] FR-45g If a dispute is raised within the complaint window, payout pauses (stays HELD) until admin resolves it.
- [ ] FR-45h Admin/ops view for orders in HELD state, remaining time in window, and any open dispute against them (combined with dispute view, see FR-44).

## 10. Commission & Settlement
- [ ] FR-46 Commission calculated on each completed order as a SINGLE GLOBAL percentage (admin-adjustable) — not per-category or per-price-tier for MVP.
- [ ] FR-46a Commission applies to ITEM PRICE ONLY — delivery fee excluded from the commission base.
- [ ] FR-47 Once the hold window has passed (or admin force-releases) with no unresolved dispute, system calculates seller's net payout and platform's commission amount.
- [ ] FR-48 Admin can initiate seller payout of net amount (manual/admin-triggered in MVP — no automated payment-gateway payout).
- [ ] FR-49 System maintains a settlement/payout record per order for reconciliation.
- [ ] FR-50 Admin can configure/adjust commission percentage and listing/featured-listing fees.
- [ ] FR-50a **(DISCUSS)** Commission/settlement treatment of a partial-refund resolution: commission applies to what the seller actually receives (item price minus the refund). Follows FR-45a/FR-71 — confirm together.

## 11. Notifications
- [ ] FR-51 System notifies users of relevant events: seller application status, listing approval/rejection, new message/offer, order status changes, delivery updates, dispute updates.

## 12. Administration
- [ ] FR-52 Admin can manage users (buyers, sellers) — view, suspend, reinstate.
- [ ] FR-53 Admin/Moderator can manage seller applications (approve/reject/revoke) per FR-05a scope split.
- [ ] FR-54 Admin/Moderator can manage listings (approve/reject/unpublish, assign Verified badge) per FR-05a scope split.
- [ ] FR-55 Admin can monitor orders and delivery/payment status across the platform.
- [ ] FR-56 Admin/Moderator can manage disputes and refund/return resolutions per FR-05a scope split.
- [ ] FR-57 Admin can manage delivery partner configuration/integration status (see FR-40a).
- [ ] FR-58 Admin (only — not Moderator/Ops) can configure fees: commission %, featured-listing pricing.
- [ ] FR-59 Admin can manage advertising placements/campaigns and view basic revenue/growth analytics.

## 13. Escrow Payments  (replaces module 7 "Payments & COD"; decided 2026-10-13/14)
- [ ] FR-60 Escrow replaces COD entirely: buyers pay online through a licensed payment gateway (card / wallet / bank); COD is not kept alongside. Replaces FR-36–FR-38, FR-40 and FR-41a.
- [ ] FR-60a **(DISCUSS)** Checkout uses the provider's HOSTED payment page, so card data never touches our servers. Confirm the scope with the chosen provider.
- [ ] FR-61 An order becomes Funded ONLY from a verified gateway webhook (see FR-77b) — never because the buyer's browser returned from the payment page. All amounts are decided server-side; the client never supplies an amount.
- [ ] FR-62 Order flow: offer accepted → Bag (listing reserved for that buyer, with a payment window) → Funded → Seller Preparing → Handed to Delivery Partner → Out for Delivery → Delivered → hold and complaint window (FR-45b–FR-45h) → Completed (released to the seller). Failure paths: payment window expires, payment fails, buyer cancels before handover (refund, FR-33a).
- [ ] FR-63 While an accepted offer waits for payment, the listing is RESERVED for that buyer and released back to the seller after a period. The duration is an admin-configurable platform setting (`reservation_hours`). **(OPEN: duration not decided)**
- [ ] FR-63a **(DISCUSS)** Accepting an offer is one atomic database step with at most one active reservation per listing (partial unique index); expiry is run by the worker AND checked against database time on accept/pay; a payment that succeeds after the reservation was released or the listing taken down is auto-refunded and the buyer notified; payment creation uses idempotency keys; seller edits/removal are blocked while reserved; an admin take-down while reserved triggers the refund path.
- [ ] FR-63b **(DEFERRED)** What happens to the OTHER open offers when the seller accepts one. Two unconfirmed options: auto-close them with a notice (and notify favoriters if the item frees up), or freeze them and revive them if the reservation lapses. The human decides later.
- [ ] FR-63c **(DISCUSS)** Reservation hoarding: an admin-configurable cap on a buyer's active reservations (value open). Reservations are created by a seller accepting, so this only matters when many sellers accept the same buyer; FR-32b's single-item rule applies to checkout.
- [ ] FR-64 The platform absorbs the gateway processing fee out of its own commission; the actual fee is stored on each payment record.
- [ ] FR-65 Seller payouts are MANUAL at launch: an admin initiates the bank / mobile-wallet transfer (FR-48). No payout automation through the gateway.
- [x] FR-66 A seller must have `seller_profiles.id_verified = true` before the first payout, regardless of listing price. Email verification proves control of the address only and never sets `id_verified`. `assertPayoutAllowed` enforces identity, authenticator, active-hold, and current encrypted payout-detail gates at settlement initiation. Test: `test/integration/known-mismatches.test.js` FR-09a SEC-30/35 FR-66/83l plus `test/unit/settlement.service.test.js` named guard test.
- [x] FR-66a Manual identity verification sets `seller_profiles.id_verified` and records `verified_by`, `verified_at` and a short note. Do not store a CNIC number or identity document. `IdentityVerifier` has a manual-admin implementation and an explicitly opted-in test fake. `test/integration/known-mismatches.test.js` FR-66/08a verifies audit metadata and that email verification does not set identity; `test/unit/identity-verifier.test.js` covers adapters; Admin permission/input validation is covered by `test/unit/admin.routes.permissions.test.js`.
- [ ] FR-67 No cool-off period when a seller changes payout details (protective controls are tracked in security.md SEC-35).
- [ ] FR-68 Only an ADMIN may mark an order Delivered (this starts the complaint window), through a dedicated `order.mark_delivered` permission rather than a hard-coded role check. Manual delivery status entry is admin-only for now. Because this is a permission, an ops role can take it over later without code changes.
- [ ] FR-69 **(DISCUSS)** Refunds are admin-triggered, idempotent, and sent through the gateway to the original payment method.
- [ ] FR-70 **(DISCUSS)** A reconciliation job compares the gateway's settlement report with the payments table (replaces cash-remittance reconciliation, FR-41a).
- [ ] FR-71 **(DISCUSS)** Partial refunds are allowed (Claude's recommendation, adopted as the working decision unless the human objects): the admin enters a refund amount from 0 to the item price. 0 = full release to the seller; the full price = full refund with the item returned; anything between = partial refund and the buyer keeps the item. Every resolution records the admin and a note.
- [ ] FR-72 **(DEFERRED)** Seller no-ship policy: what happens when a seller never hands the item to the courier after the buyer has paid.
- [ ] FR-72a **(DEFERRED)** Delivery fee on a full refund: refunded or kept.
- [ ] FR-72b **(DEFERRED)** Chargeback liability: who bears a card chargeback after the seller has been paid.
- [ ] FR-72c **(OPEN)** Handling of funds for a seller who never completes the required temporary email verification (FR-66).
- [ ] FR-72e **(DEFERRED)** Order handed over but never delivered (a lost parcel): the buyer cannot cancel (FR-33a) and cannot dispute (FR-43 needs a delivered order), and nothing starts the clock — how the buyer recovers paid money is undecided. Discuss with returns, refunds and disputes.

## 14. Listing content versioning & caching  (scale program, Point 1)
- [x] FR-73 Every edit to a live listing, including every price edit, creates a revision and goes through moderation. The previously approved version stays public while the edit waits; the new version goes live only when approved. Each listing can have only one open revision at a time. *(Tests: `FR-73: one pending revision keeps public data unchanged; concurrent submissions serialize and seller can withdraw/resubmit`, `FR-73: concurrent moderator approve/reject decisions produce exactly one transition`, and the stale-version/rollback/permission cases in `test/integration/revisions.test.js`.)*
- [ ] FR-73a Listing content is versioned and cached per version; the live status (available / reserved / sold / removed) is served separately with a very short cache. Price travels with the published version/status and all price edits follow FR-73.
- [ ] FR-73b **(DISCUSS)** Hardening: latest_version vs published_version pointers; drafts served privately with no-store; invalid version values return a short-cached 404; take-down purges immediately; status read from Redis (one batch call for list pages) with a "Check availability" fallback and stale-if-error; private files (ID documents, dispute evidence) in a private bucket with short-lived signed links; video embed follows status; operations that move money or accept offers (offer, accept, checkout, payment, refund, payout) always read the live database — the displayed asking price may lag the cached status by up to the status cache lifetime; the offer action always checks the live database.
- [ ] FR-73c **(DISCUSS)** Starting cache values, tuned in load tests: status 5–10 s, list/search pages ~60 s, content up to ~1 day, images 1 year immutable via content-hashed URLs; public routes never set cookies; hit-rate target above 90%.
- [ ] FR-73d **(DISCUSS)** A Jest test walks all routes and fails if a private or money route lacks `Cache-Control: private, no-store` (public routes use an allow-list).
- [x] FR-73e Every price edit to a live listing goes through a revision and moderation. Before publication, if the proposed price is strictly above `platform_settings.high_value_threshold_pkr`, the seller's registered email must be verified under the temporary policy (FR-08a); equality does not trigger that email gate. Email verification never sets legal identity verification. *(Tests: `FR-73e: equality does not require email; approval uses the latest threshold` and `FR-73e, FR-15a: approval rechecks email verification and active measurement definitions`.)*

## 15. Listing media — photos, video, story  (scale program Point 2; listing-submission decisions)
- [x] FR-74 A listing needs at least 3 and at most 6 photos; the three required photos cover the front, the back and the other piece(s) of the outfit (a close-up detail for single-piece outfits). *(Test: `FR-19, FR-74: three photos submit a draft into the moderation queue`.)*
- [x] FR-74a Upload UI uses labeled slots (Front, Back, Other/detail required; up to 3 optional); moderators confirm each shot matches its label. *(Owner-approved 2026-10-21; test: `FR-74a, SEC-12: photo moderation confirms labels, records reviewer, and denies seller BOLA`.)*
- [x] FR-74b Public photos carry a replaceable watermark step using a placeholder mark until final brand artwork is available. Public variants can be regenerated when the mark changes. *(Owner-approved 2026-10-21; test: `FR-74b: placeholder watermark is explicit and replaceable`.)*
- [x] FR-74c The clean original stays in private storage; watermarking is applied when public variants are created so variants can be regenerated. *(Owner-approved 2026-10-21; test: `FR-74 private listing media` verifies owner-only signed original reads and public WebP variants.)*
- [ ] FR-74d **(DISCUSS)** Direct-to-storage uploads via presigned URLs (images never pass through Express); a worker validates real file type and size, strips location/camera metadata and creates variants (thumbnail, medium, large, 1200x630 social preview) as WebP served via CDN with content-hashed immutable URLs; a listing cannot be submitted for moderation until processing finishes; per-seller daily upload limit.
- [ ] FR-75 **(DEFERRED: end-of-phases review)** Optional listing video; hosting, legal terms, provider checks and operational details are listed in `END_OF_PHASES_REVIEW.md`.
- [ ] FR-75a **(DEFERRED: end-of-phases review)** Video visibility/consent agreement.
- [ ] FR-75b **(DEFERRED: end-of-phases review)** Video moderation and editing workflow.
- [ ] FR-75c **(DEFERRED: end-of-phases review)** Video playback and background processing.
- [ ] FR-76 **(DEFERRED: end-of-phases review)** Optional voice story and processing/consent details.
- [ ] FR-76a **(DEFERRED: end-of-phases review)** Voice-story background processing and rate limits.

## 16. Queue, worker & process model  (scale program, Point 4)
- [ ] FR-77 One codebase, two processes: `server.js` (web — never runs jobs) and `worker.js` (runs jobs). Redis, a Postgres-backed queue, object storage and a CDN are required from day one (this replaces "added as needed").
- [ ] FR-77a Postgres-backed queue behind `lib/queue.js`: atomic enqueue in the same transaction as the state change (outbox); leases with heartbeats; at-least-once delivery with idempotent handlers; business-key dedupe; retries with backoff and jitter and a maximum attempt count; a dead-letter list visible to admins; per-item ordering; single-runner scheduled jobs; separate queues and concurrency limits (money/offers, media, notifications); the worker has its own connection pool; graceful shutdown; LISTEN/NOTIFY wake-ups with a polling fallback.
- [ ] FR-77b Payment webhooks use an inbox: verify the signature, store the raw event under a unique gateway event ID, enqueue, return 200, process in the worker. Handlers re-read state with a row lock before acting; external effects use idempotency keys (an effects-log table where a provider has none).
- [ ] FR-77c Reconciliation sweeps (paid without order, reservations past expiry, Redis status vs database, stuck jobs); observability (queue depth, oldest job age, retry rate, dead-letter count, a trace ID from request to job); finished jobs archived to keep the hot table small; rate limits toward external APIs (YouTube quota, speech/LLM cost, email provider).
- [ ] FR-77d `notifications.service.js` listeners ENQUEUE jobs instead of sending inline; the in-process event emitter stays for wiring.
- [ ] FR-77e Jobs that run through the queue: notifications, image processing, video upload/removal, voice-story processing, payment webhook processing, reservation expiry, cache purge/warm, search-table updates, snapshot generation, suggestion-file builds, cleanup, OTP email sends (high-priority lane).
- [ ] FR-77f **(OPEN)** Queue library verification — not yet done; deadline: before a library is committed (start of Phase 0b). Test the candidate against the actual PostgreSQL and PgBouncer configuration: job claiming, concurrent workers, transaction handling, retries and pooling compatibility. If it is incompatible, choose a compatible architecture rather than weakening any correctness requirement. For critical operations (e.g. order creation and its notification job) the order and its job record cannot become inconsistent: use a transactional outbox or an equivalent reliable mechanism. Jobs are retryable and safe against duplicate execution. Example: a buyer places an order; the order and its notification job commit together; a worker sends the confirmation email; temporary failures retry in a controlled way; success marks the job complete.
- [ ] FR-78 **(DEFERRED)** Real-time updates (design proposed, not accepted): Server-Sent Events for logged-in users only, events as hints with database catch-up on reconnect. To be decided together with how offline users are reached for general notifications.

## 17. Database & reliability  (scale program, Point 6)
- [ ] FR-79 Managed Postgres with automatic failover and point-in-time backups; targets: lose at most about 5 minutes of data, recover within about 1 hour.
- [ ] FR-79a Immutable off-site backups (separate credentials and keys); automated weekly restore tests; quarterly recovery and failover drills; alerts on archive lag and backup age; object storage versioned and replicated; Redis is a rebuildable cache, not a backup target.
- [ ] FR-79b Zero-downtime migrations (expand → switch → contract, lock timeouts, concurrent index builds, backfills as worker jobs). A real versioned migration runner replaces `db/migrate.js`; it runs as a separate deploy step with an advisory lock, never at web startup; `schema.sql` becomes a snapshot generated from the migrations; migrations are linted and checked for old-code/new-schema and new-code/old-schema compatibility.
- [ ] FR-79c PgBouncer (transaction mode) for the web process; workers use direct connections only when the selected queue library needs persistent sessions (LISTEN/NOTIFY, advisory locks) or cannot work correctly through transaction pooling — decided by testing against the real PostgreSQL + PgBouncer configuration (FR-77f); small pools; `statement_timeout`, `idle_in_transaction_session_timeout` and a short `lock_timeout`; fail fast with 503 when the pool is exhausted.
- [ ] FR-79d Counters (views, favorites) stay off hot listing rows: buffered in Redis and flushed in batches.
- [x] FR-79e No read replica initially; `db.service.js` gets separate read and write entry points now so one can be added later.
- [x] FR-79f Application-level payout encryption uses AES-256-GCM with random nonces, seller-bound AAD, versioned key IDs, environment-backed `KeyProvider` and `npm run keys:rotate`; migration 007 adds an encrypted envelope column without removing legacy columns. `test/unit/payout-encryption.test.js` covers encryption and mixed-version rotation. Offline master-key backup remains a live check in `LIVE_CHECKS.md`. Append-only ledger and audit tables are immutable to the application role; corrections are reversing entries.
- [ ] FR-79g Database reachable only on a private network with TLS and certificate verification; least-privilege roles (web, worker, migrator, read-only, backup); no PII in logs or slow-query logs; staging never receives raw production data.
- [ ] FR-79h Initial deployment is hosted on Render *(decided 2026-10-17)*. The final production architecture is deferred: PostgreSQL hosting, Redis (if required), CDN, storage and connection configuration are chosen later, and Render is not a commitment to any particular database, Redis provider or CDN. Before deployment, verify backups, secrets, security settings, database limits, monitoring and recovery — including that the database plan can meet the FR-79 targets (Render documents no recovery capability for its free PostgreSQL tier: https://render.com/docs/postgresql-backups).

## 18. Search & suggestions  (scale program, Point 7)
- [ ] FR-80 Postgres full-text search plus indexed filters; no separate search engine now. An upgrade path stays behind `discovery.service.js` (trigger example: p95 search above 300 ms in load tests).
- [ ] FR-80a A dedicated denormalized `listing_search` table (one row per PUBLISHED listing) with a generated tsvector, a trigram index and composite indexes matching each sort; kept in sync via the queue with version checks; rebuildable; with a reconciliation sweep.
- [ ] FR-80b Roman Urdu / spelling tolerance: trigram matching plus an admin-managed synonym list (an ongoing admin task).
- [ ] FR-80c Suggestions come from a versioned vocabulary file (categories, brands, fabrics, colors, synonyms, popular searches) built by a worker, cached by the CDN and matched in the browser: completions, spelling variants, "did you mean", trending and recent searches (recent stored only in the browser). Only terms with live listings behind them; popular-search terms need a minimum number of distinct users; admin can pin/remove.
- [ ] FR-80d Search load protection: CDN → Redis (30–60 s) → Postgres; single-flight merging; a separate small search connection pool with a 1–2 s statement timeout; a concurrency cap with graceful degradation; bounded query length/terms/filters and result depth; per-IP rate limits.
- [ ] FR-80e Sort set: newest, price low→high, price high→low, relevance (only when there is a text query). Popularity sort comes later **(DEFERRED)**.
- [ ] FR-80f **(DISCUSS)** Sold items are hidden from search results; reserved items show a badge.

## 19. Frontend delivery & SEO  (scale program, Point 8)
- [ ] FR-81 Keep React + Vite; NO Next.js migration.
- [ ] FR-81a Worker-generated static HTML snapshots of public pages (home, categories, listings, static pages) carry a real title, description, key attributes, first image, social preview tags and structured data; the SPA takes over in the browser; snapshots regenerate through the queue when the published version, sold or removed state changes.
- [ ] FR-81b A sold listing keeps its URL with a "Sold" banner and similar items; a moderator take-down returns a "gone" response.
- [ ] FR-81c Slugged URLs (old slugs redirect), canonical tags, a worker-generated sitemap, `noindex` on deep filter combinations, bot rate limits on uncached routes, and a light watermarked 1200x630 social preview image.
- [ ] FR-81d Performance: route-level code splitting; no admin/moderator code shipped to public visitors; real-time and sign-in code loaded on demand; public JS budget about 150–200 KB compressed; self-hosted subset fonts (Playfair Display + DM Sans) with `font-display: swap` and critical weights preloaded only; reserved image space and a prioritized first photo; bundle-size and Lighthouse budgets in CI; real-user tracking of load speed, layout shift and responsiveness per page type; no service worker, no PWA.
- [ ] FR-82 **(DISCUSS)** SEO wording rules — title and meta-description formulas, headings, keyword strategy. SEO-GATE (rules.md Section 10): stop and discuss with the human before finalizing.
- [ ] FR-82a **(DISCUSS)** Image alt text and file names (e.g. generated from structured fields — brand, type, color, fabric, handwork, condition — rather than seller free text).
- [ ] FR-82b **(DISCUSS)** Structured data: negotiation-only means no fixed price, so how price, condition and availability are described needs a deliberate choice.
- [ ] FR-82c **(DISCUSS)** URL, slug, canonical and filter-page indexing rules (which filter combinations deserve indexable pages) and handling of duplicate seller-copied descriptions.
- [ ] FR-82d **(DISCUSS)** Internal linking and technical SEO checks; which languages buyers search in (English, Roman Urdu, Urdu script).

## 20. Authentication & two-factor  (scale program Point 9; auth decisions)
- [ ] FR-83 Two-factor authentication on EVERY login, designed for the best UX, strong security and reliability, including use across multiple devices.
- [ ] FR-83a The second-factor code channel for ordinary buyers (who use neither a passkey nor an authenticator app) is EMAIL — not WhatsApp or SMS.
- [ ] FR-83b **(DEFERRED: end-of-phases review)** Passkey methods and fallback UX; see `END_OF_PHASES_REVIEW.md`.
- [x] FR-83c Sellers enroll with TOTP and receive ten single-use backup codes; payout writes require enrollment. A seller without an enrolled authenticator must complete password and email-code factors before receiving an enrollment-only session, restricted to setup, confirmation, logout and refresh. Tests: `test/unit/users.service.test.js` FR-83h/SEC-09 seller challenge and `test/unit/users.auth.routes.test.js` FR-83h seller email login; `test/integration/known-mismatches.test.js` FR-83c/f enrollment and payout regression.
- [ ] FR-83d Buyer email verification codes *(owner values approved 2026-10-21)*: six digits; expiry after five minutes; single use; only a hash of the code is stored; tied to the login attempt; at most 3 verification attempts per code; 60-second resend cooldown; at most 5 codes per hour and 10 per day per address; soft signal after 30 sends per hour per IP (not a block); 10 failed verifications per hour causes a 15-minute lock. Every value is configurable. Responses and timing class are identical whether or not the account exists.
  Implementation checkpoint: registration/address verification and buyer login invoke login-attempt-bound issue/consume methods using encrypted queue payloads, keyed code/address digests, atomic per-address send limits, single-use confirmation, three attempts per code and configurable failure locks. Real Redis integration and provider delivery remain pending, so this row stays unticked.
- [ ] FR-83e Email delivery *(approved 2026-10-17)*: Nodemailer is the common sending interface where appropriate — it is the interface, not the delivery provider; delivery providers sit behind an adapter so the authentication logic is not coupled to one provider; prefer an HTTPS-API-compatible setup for the initial Render deployment (Render blocks outbound SMTP ports on free web services); a secondary provider is a planned fallback, with failover implemented and tested before production; the actual provider(s) are selected before the first real login, and real delivery, rate limits, failure handling, retries and fallback are verified then.
- [x] FR-83f A fresh second factor is required for payout-detail, password and security-setting changes and Admin force-release; email change is deferred with no self-service endpoint. Step-up grants are session/action-bound, single-use and expire within a configurable maximum of 15 minutes (default 5 minutes); password change, authenticator disable, payout update and force-release paths are gated. New device sign-ins and payout changes queue generic notices, and recovery codes are consumed once. Tests: `test/integration/known-mismatches.test.js` FR-83c/f and FR-09a SEC-30/35 payout regression. Device list/revoke UI is deferred. *(Owner-approved 2026-10-21.)*
- [x] FR-83g Self-service forgot-password and password reset are available to every role, with uniform responses, single-use hashed reset tokens, a configurable 30-minute expiry, session revocation on success, and notice to the account address. No self-service email change at launch. *(Owner-approved 2026-10-21; verified by FR-83g route and PostgreSQL integration tests.)*
- [x] FR-83h Second-factor methods for Phase 0: an email code for ordinary buyers, and an authenticator app (TOTP) for admins and moderators — admins and moderators never use email codes. Passkeys (WebAuthn) come later as an additive step. The first admin enrolls TOTP during the one-time bootstrap command. *(Decided 2026-10-17; reaffirmed 2026-10-21; verified by FR-83h/SEC-09 TOTP and bootstrap integration tests.)*
- [ ] FR-83k When a user loses all factors, only an Admin (never Moderator) may perform admin-assisted recovery after a 24-hour delay and notice to the old email; record a mandatory reason, revoke all sessions and enroll a new second factor. No self-service email change is available at launch. Until the recovery flow is implemented, use the manual owner-only procedure.
- [ ] FR-83l After recovery, pause a seller's payouts until an Admin confirms the issue is resolved and payout details are verified with the real owner. Twenty-four hours is the Admin's target; there is no automatic release.
- [ ] FR-83i **(DISCUSS)** Further email-code proposals not yet approved: an invisible bot check before a code is sent, disposable-email blocking, and email ownership verification at signup. Code-to-attempt binding and the approved per-IP limits are specified in FR-83d and are not part of this open proposal.
- [ ] FR-83j **(DISCUSS)** Email deliverability proposals, not yet approved: a dedicated sending subdomain with SPF, DKIM and DMARC; login emails on their own stream; about 10 s p95 delivery; the code in the subject and no links in the email.
- [x] FR-84 Authentication uses a JWT in the Authorization header. A short-lived access token is held in memory only (security.md SEC-06); a rotating, single-use refresh-token cookie (httpOnly, Secure, SameSite=Strict, scoped to the refresh endpoint only, stored hashed server-side with reuse detection; logout and password change revoke the whole family) renews it. The second factor is required at sign-in only, not at refresh. The refresh endpoint is CSRF-protected (SameSite=Strict plus an Origin check) and no other endpoint accepts a cookie. The first admin account is created by a one-time server command, `npm run admin:create`, which also enrolls that admin's authenticator app — no network endpoint, no default credentials. *(Revised 2026-10-17; verified by FR-84/SEC-38 integration and route tests.)*
- [x] FR-84a Session token lifetimes *(approved 2026-10-17)*, all configurable defaults: access token 15 minutes, held in memory; buyer refresh token 30-day absolute maximum and 7-day inactivity expiry; staff refresh token 8-hour absolute maximum and 30-minute inactivity expiry; the refresh token rotates after every successful refresh; reuse of an old refresh token revokes its token family and requires signing in again; expiry and rotation are enforced server-side. Refresh-cookie design and CSRF scope: FR-84. *(Verified by FR-84a/SEC-38 PostgreSQL integration test.)*
- [ ] FR-84b Password hashing uses Argon2id in a bounded worker pool, with parameters selected by the benchmark script, a concurrency cap, and 503 when saturated. Redis rate limits apply per IP and per account to login, signup, reset, email-code sending, offers, and messages. WAF/bot protection is deferred to Phase 6. *(Owner-approved 2026-10-21; supersedes the open bcrypt/WAF proposal.)*
  Implementation checkpoint: password hashing is covered; configured Redis limits cover signup/login/reset and existing offer/message writes; email-code sending has per-address caps and the soft IP signal. Real-Redis verification remains pending (see `PHASE0_PROGRESS.md`), so this row stays unticked.
- [x] FR-84c Production configuration rejects missing or placeholder credentials at startup; approved FR-83d/FR-84b security limits are environment-configurable, validated, and never silently replaced by development fakes. *(Owner-approved 2026-10-21; verified by FR-84c config and credential-adapter tests.)*

## Explicitly deferred to later phases (not MVP)
- [ ] Physical inspection workflow and inspection fees. **(DEFERRED)**
- [ ] Listing-level "advanced verification" as a paid service. **(DEFERRED)**
- [ ] Online/escrow payment methods. **(PROMOTED to MVP scope 2026-10-13 — see FR-60 to FR-72)**
- [ ] Dry cleaning and alteration services. **(DEFERRED)**
- [ ] Boutique/business seller profile type. **(DEFERRED)**
- [ ] Delivery express/priority tiers. **(DEFERRED)**
- [ ] Real-time courier API/webhook integration. **(DEFERRED — manual for MVP)**
- [ ] Automatic cash-remittance reconciliation. **(SUPERSEDED by escrow — there is no cash remittance)**
- [ ] Payout automation through the gateway (payouts are manual at launch, FR-65). **(DEFERRED)**
- [ ] Real-time updates / Server-Sent Events (FR-78). **(DEFERRED: design proposed, not accepted)**
- [ ] Popularity sort in search (FR-80e). **(DEFERRED)**

## Open product decisions still blocking full spec (tracked, not yet resolved)
- [ ] Dispute resolution granularity (binary vs. partial/split) — FR-45a (Claude recommended partial, FR-71; awaiting confirmation)
- [ ] Verified-badge grant criteria — FR-18a
- [ ] Delivery-partner count and city-based assignment — FR-40a
- [ ] COD refusal-at-the-door flow (major gap) — FR-33b (parked; now a refund/return question under escrow)
- Full register of open, deferred and parked decisions: `open-questions.md`.

## Prototype gap-analysis action items (build/fix against existing zip)
- [ ] Remove fixed-price "Add to bag"/direct checkout path entirely (product page currently bypasses negotiation).
- [ ] Remove Card/Wallet payment option from checkout (COD-only). **(SUPERSEDED by escrow — replace the payment step with the gateway's hosted checkout, FR-60a)**
- [ ] Add login gates to Favorite, Chat, and Make-an-offer actions (currently unguarded).
- [ ] Trim seller profile card on Product page to rating + join date only (currently shows response-rate/items-sold).
- [ ] Rework reviews to two-way (buyer↔seller), entry point only from completed Orders page (currently one-directional, reachable from product page).
- [ ] Add Kids' as a third main category with its own sub-categories.
- [ ] Replace Condition dropdown (Like New/Excellent/Good) with real Condition/Type set: Brand New, Pre-Owned, Custom-Made, Replica (+ disclosure field on Replica).
- [ ] Add structured per-sub-category measurement fields to the Sell form.
- [ ] Add fabric/material, brand, color, embellishment/handwork fields to the Sell form.
- [ ] Add authenticity-evidence upload step + Verified badge display on ProductCard/Product detail.
- [ ] Reframe `/verification` screen: explain temporary registered-email verification for high-value listings; it is not a legal-identity check or blanket signup requirement.
- [ ] Rework payout field into explicit Bank vs. Mobile Wallet (Easypaisa/JazzCash) choice.
- [ ] Build payout-hold/dispute-window UI (buyer "report an issue" action + admin/ops HELD view with countdown and open-dispute flag).
- [ ] Build dedicated seller-application review sub-tab inside Admin → Users (approve/reject + reason + resubmission tracking).
- [ ] Add order cancellation action to Buyer Orders UI (pre-dispatch only).
- [ ] Expand order lifecycle states in Orders/Tracking UI to match FR-33 (currently only 4 steps).
- [ ] Add seller-facing net-payout visibility (currently only gross Sales/Revenue shown) — split into Held vs. Released.
- [ ] Build the two-factor login flow: email code for ordinary buyers (FR-83a); passkeys are deferred to the end-of-phases review (FR-83b).
- [ ] Sell form: photo upload enforcing 3–6 photos with labeled required slots (Front, Back, Other) and up to three optional slots; moderators confirm each required photo matches its label (FR-74/FR-74a).
- [ ] Optional video and voice-story sections are deferred to the end-of-phases review (FR-75–FR-76a); do not add these sections in the current phase plan.
- [ ] Search: sort set newest / price low→high / price high→low / relevance (FR-80e); suggestions UI **(DISCUSS, FR-80c)**.
- [ ] Listing page: cached content with a status badge, "Check availability" fallback, click-to-play video, Sold banner with similar items **(DISCUSS, FR-73b, FR-81b)**.
- [ ] Bag/checkout: reserved-listing state with a payment-window countdown (FR-63).
- [ ] Frontend delivery: route-level code splitting, no admin code in the public bundle, public JS budget, self-hosted subset fonts (FR-81d).
- [ ] Ignore/do not build against: `verified_boutique_landing_sana_boutique`, `boutique_onboarding_hub_poshak`, `poshak_design_system/DESIGN.md`, `stitch-reference/`. The prototype's wired `styles.css` theme (deep green / cream / gold, Playfair Display + DM Sans) is the FINAL design system.

---
_Last updated: 2026-10-14 (consolidated with the Poshaak escrow, scale, auth and listing-media decisions — see MASTER_PROJECT_CONTEXT.md). Update this file's checkboxes as work is completed — do not remove rows once ticked; this is the running source of truth for build progress._
