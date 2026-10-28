# Owner decisions, 2026-10-25 (single source for Phase 4)

**Project:** Marketplace / Poshaak  
**Phase:** Phase 4 — Fixed-Price Purchases, Reservations, Payments, Refunds and Delivery  
**Status:** Owner decisions Q1–Q19 only. This record does not approve later proposed questions or policies.

1. **FIXED-PRICE PURCHASES are the active buying flow (Q1).** A buyer uses **Buy** on an available listing; there is no offer acceptance or negotiation step. The Buy action starts a time-limited reservation and checkout/payment flow. Confirm **FR-60a, FR-63a, FR-69 and FR-70** against this fixed-price approach. **FR-63b**, insofar as it depends on an accepted offer, does not govern the active fixed-price flow. Existing offers/negotiation functionality remains deferred and disabled as decided in Phase 3. A purchase must not require `orders.accepted_offer_id`. The item price is checked at checkout and locked in the reservation/order snapshot so subsequent listing edits cannot silently change what the buyer agreed to pay.

2. **RESERVATION WINDOW: 60 minutes (Q2).** Starting checkout reserves the listing for **60 minutes**. The duration is an **administrator-configurable setting**, initially 60 minutes, rather than a permanently hard-coded value. During a valid reservation the item is unavailable for another buyer's purchase. If payment is not completed within the window, the reservation expires and the item can become available again, subject to its actual listing/order state. Reservation expiry and payment callbacks must be handled safely so late or repeated events cannot create two valid purchases for one item.

3. **ACTIVE UNPAID RESERVATION LIMIT: three per buyer (Q3).** A buyer may hold at most **3 active, unpaid reservations** at once; the cap is **administrator-configurable**. A successfully paid order no longer counts toward this unpaid-reservation limit. Enforce the limit on the server, including concurrent Buy attempts, rather than relying only on what the interface displays. Expired or cancelled unpaid reservations must not continue to consume a slot.

4. **PRICE REVISION WHILE RESERVED: approval is blocked (Q4).** If a published listing is reserved, a moderator/administrator **cannot approve a pending price revision** during that reservation. Preserve the price already locked for the buyer; do not change the checkout amount because of a later seller request. The revision remains **pending**, and becomes eligible for normal review **after the reservation ends**; it is **not automatically approved** on expiry, cancellation or completion. **Notify the seller both in the dashboard and through an in-app notification** that approval is blocked because the item is reserved. The notification explains the reason; it does not promise approval later.

5. **DELIVERY FEE: flat PKR 300 per order (Q5).** Charge the buyer a **flat PKR 300 delivery fee** per order at launch, with the amount **administrator-configurable**. The **server** calculates and records the fee in the checkout/order totals; the browser must not be the authority for the amount. Show the fee before the buyer confirms payment. Courier-specific or distance-based pricing is deferred until a later phase; do not silently substitute a courier's actual charge for the agreed checkout fee.

6. **DELIVERY ADDRESS: required and validated at Buy (Q6).** Before a buyer can proceed, require **recipient name, phone number, supported city, and sufficient address details for delivery**. Validate the city against the marketplace's supported-delivery list **at the Buy/checkout step**, not merely when the user creates a profile. Reject incomplete or unsupported addresses with a clear explanation; store the address used for that order so later profile changes do not rewrite the delivery destination.

7. **NO SELF-PURCHASES (Q7).** The owner/seller of a listing **cannot buy their own listing**. Enforce this restriction **on the server** using authenticated buyer identity and the listing owner, including direct API calls. Do not depend only on hiding or disabling the Buy button in the interface.

8. **SELLER HANDOVER DEADLINE: three days (Q8).** After the relevant paid order is ready for fulfillment, the seller has **3 days to hand the parcel to the courier**. If handover does not occur by the deadline, **automatically cancel the order and initiate a full buyer refund**. This must be safe under repeated background checks and concurrent updates: a cancellation or refund must not be duplicated. Record the missed deadline and resulting actions so administrators can audit the outcome. This seller-handover deadline is separate from courier-delivery delays.

9. **BUYER CANCELLATION BEFORE COURIER HANDOVER: full refund (Q9).** A buyer may cancel an order **before the parcel is handed to the courier**. Refund **the full item price plus the full delivery fee**. If the payment gateway retains a non-refundable processing fee, **the platform absorbs that cost** rather than deducting it from this buyer refund. Once courier handover has happened, this automatic pre-handover cancellation rule no longer applies; post-handover cases require a separate policy or administrative handling, not an invented automatic entitlement.

10. **PAYMENT PROVIDER: adapter first, live choice later (Q10).** Build payments behind a **PaymentGateway/provider abstraction** so a real provider can be integrated without tying the entire order flow to one vendor. Use a **fake gateway in development and automated tests** to exercise payment success, failure, refund and duplicate-event behavior. **Do not select or claim a live payment provider in this decision**; provider choice and real credentials remain a separate launch decision.

11. **PRODUCTION PAYMENT GATE: disabled until launch checks pass (Q11).** Keep **`PAYMENTS_ENABLED=false` in production** until legal, payment-provider, security and operational prerequisites have been reviewed and approved. The existence of checkout code, a fake gateway or a provider adapter is **not** authorization to collect real customer funds. Do not describe the marketplace as legally cleared, payment-ready or approved to hold customer money without actual verification. Enable live payments only through a deliberate, reviewed launch step.

12. **BUYER PAYMENT METHOD: cards first (Q12).** The initial intended live buyer-payment method is **card payment**, subject to choosing and approving a suitable provider. **Wallets and bank transfers for buyers** may be added later; they are **not part of the initial live-payment commitment**. These buyer payment methods are distinct from **seller payouts**, which remain manual under **FR-65**. Do not assume that a future buyer bank-transfer option means automated bank payouts to sellers.

13. **COURIER ARRANGEMENT: one manually coordinated partner at launch (Q13).** Start with **one courier partner**, coordinated manually by marketplace staff, with **no courier API integration required for launch**. Keep the delivery model extensible so additional courier partners and automated integrations can be introduced later. Do not pretend that courier status is automatically verified through an integration that does not exist.

14. **DELIVERY STATUS AND TRACKING: administrator-managed (Q14).** At launch, an **administrator updates delivery status manually** based on available courier information. Store the **tracking number** when one is provided and make relevant tracking/delivery information available through the order experience. Notify the buyer when **important delivery statuses change**. Courier APIs and webhooks are future enhancements; their absence must not block the agreed manual launch workflow.

15. **LOST PARCELS AND REFUSED DELIVERY: manual resolution in Phase 4 (Q15).** Do **not** build automatic lost-parcel or refused-delivery refund/cancellation rules in Phase 4. Instead, record the issue, make it visible for administrative follow-up, and allow staff to determine and document the appropriate resolution, including a refund when warranted under the applicable policy. **Automated case handling is deferred to Phase 5.** This decision does not create a new blanket promise of full or partial refunds for every delivery exception.

16. **ORDER AND DELIVERY NOTIFICATIONS: in-app plus rate-limited email (Q16).** Use **in-app notifications** and **email through the existing email mechanism**, with throttling/rate limits to avoid excessive or duplicate messages. Notify users about meaningful purchase, payment, refund and delivery changes as applicable. **SMS and WhatsApp are deferred**. Notification failure must not be treated as proof that a payment, refund or delivery state change failed; the underlying recorded state remains authoritative.

17. **MANUAL REFUNDS: two distinct administrators and TOTP verification (Q17).** A **manual refund** requires **one administrator to initiate** and a **different administrator to approve** it. Both must pass **authenticator-based/TOTP verification** for their respective sensitive actions. **Self-approval is forbidden.** A secure process for creating/provisioning the second administrator must exist before manual refunds go live. Preserve an audit trail of the requester, approver and decision. **System-triggered refunds** (for example, an automatic refund following the agreed seller-handover timeout) use **separate system authorization and idempotency safeguards** and **do not require two human approvals**. Do not confuse a manual refund with an automatically authorized refund.

18. **PARTIAL REFUNDS: prepare the foundation, defer the complete workflow (Q18).** In Phase 4, prepare the **data structures, validation, status handling and payment-gateway tracking** needed to support partial refunds safely. The **complete end-to-end partial-refund workflow is deferred to Phase 5**. If a manual partial-refund action is later enabled, it must follow the **two-distinct-administrator rule from Q17**. Do not expose a fully operational partial-refund feature or promise it to buyers merely because the underlying structures exist.

19. **SAFE MIGRATION AND CANONICAL RESERVATION STATUS (Q19a and Q19b).** **Q19a:** Use an **expand-first migration** for the shift away from old cash-on-delivery (COD) assumptions: introduce and validate new structures and compatible application behavior **before** removing old COD columns, constraints or code paths. Any destructive/drop migration is a **separately gated step**, performed only after checking dependent code, data, deployments and rollback/recovery needs. **Q19b:** Use **`reserved` as the canonical listing/order reservation status** in the new flow. Provide a **temporary compatibility mapping/alias for the older `Bag` terminology** while existing code and stored data are updated. Do not treat `Bag` and `reserved` as permanently separate business states, and remove the compatibility path only after dependencies have been migrated and checked.

## Implementation clarifications attached to the approved decisions

- **Payment webhooks:** Where a payment provider requires signed webhooks, register the raw-body webhook route before general JSON body parsing where necessary, preserve the original request bytes for signature verification, and leave ordinary API JSON parsing unchanged. Test valid and invalid signatures, duplicate deliveries and safe repeated processing. This is an implementation clarification, **not an additional owner decision numbered beyond Q19**.
- **Authoritative calculations and transitions:** Reservation eligibility, locked item price, delivery fee, ownership checks, cancellation, refunds and status transitions are enforced by the backend. Frontend display alone is not a security or correctness guarantee.
- **Refund reliability:** Automatic cancellation/refund triggers and webhook callbacks must be idempotent and auditable, especially when events arrive late, more than once or out of order.

## Provisional defaults and launch gates

- Reservation duration **60 minutes**, administrator-configurable.
- Maximum **3 active unpaid reservations per buyer**, administrator-configurable.
- Delivery fee **PKR 300 per order**, administrator-configurable.
- Seller courier-handover deadline **3 days**.
- **One manually coordinated courier partner** at launch; delivery statuses updated by an administrator.
- **Card payments intended first**, but the real provider remains unselected; **`PAYMENTS_ENABLED=false` in production** until the required checks pass.
- **Seller payouts remain manual (FR-65)**. These decisions do **not** set a new payout-eligibility waiting period, delivery-confirmation evidence policy, post-delivery complaint deadline or marketplace commission model.
- The final published legal, cancellation, delivery and refund wording must accurately reflect what is actually approved and operational before live payments are enabled.

## Deferred / not decided in this record

- Offers and negotiation in the active buying flow (previously deferred behind `OFFERS_ENABLED`).
- Buyer wallets and bank transfers beyond the initial card-payment direction.
- Selection and launch approval of a real payment provider.
- Multiple couriers, courier-based delivery pricing, courier APIs and courier webhooks.
- Automated lost-parcel and refused-delivery resolution (**Phase 5**).
- Complete partial-refund workflow (**Phase 5**).
- SMS and WhatsApp notifications.
- Final policy for buyer cancellation **after** courier handover, where not already covered by an approved rule.
- Any later proposed decisions **Q20–Q27**: **excluded and not approved by this document**, regardless of earlier conversational selections. In particular, no new seller-payout timing, delivery-confirmation evidence rule, post-delivery complaint window or commission policy is adopted here.

**Scope note:** This file records the owner-approved Phase 4 decisions **Q1–Q19 only**. It is a decision record, not a claim that the code is implemented, tested, deployed or legally cleared for live payments.

## Addendum (provisional, owner to confirm)

- **D1 (Q12 scope): PROVISIONAL** — buyer payments only; cards first; buyer wallets/bank later through the PaymentGateway adapter; seller payouts stay manual (FR-65), out of Phase 4.
- **D2 (Q17 second admin): PROVISIONAL** — a second real person with their own Admin account and authenticator; a controlled command to create additional Admins is part of the Phase 4 design; `PAYMENTS_ENABLED` may not be enabled until two distinct authenticator-enrolled Admins exist. System-triggered refunds (expiry, missed handover, pre-handover cancellation) use their own idempotent path and do not need a second Admin.
- Derived notes: refunds need a trigger field (`system_cancel`, `system_expiry`, `system_handover_timeout`, `manual_admin`); price-revision approval must check for an active reservation under a row lock; mount the webhook route before `express.json()` so signature verification can use the raw body; the worker needs its first recurring jobs for reservation expiry and the handover deadline.
