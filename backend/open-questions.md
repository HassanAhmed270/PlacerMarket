# open-questions.md

Log of things an agent stopped on per `rules.md` Section 1 — an OPEN spec
item it needed but couldn't resolve, or a genuine ambiguity `specs.md`
doesn't answer. One entry per question. Move an entry to "Resolved" (don't
delete it) once a human answers it, and note the answer + where it got
implemented.

Format per entry: date, FR/SEC code(s) if any, what's blocked, "needed by"
phase (see `Phases.md`). Consolidated 2026-10-14: this register merges the
Marketplace-chat entries with the register in the Poshaak handoff.

## Open

### Needed by Phase 0
- 2026-10-14 · FR-84a, SEC-03 / SEC-06 · **How a session survives a page reload.** JWT in memory only + no refresh token + two-factor on every login means a reload or new tab forces a fresh login with a second factor. Options: a persistent token store (against SEC-06), an httpOnly-cookie refresh token (brings CSRF back on that endpoint), or an httpOnly cookie as the session credential. The access-token lifetime value and trusted-device handling are open too. *This conflict was found during consolidation — the "no refresh token" decision was made before the two-factor decision was reconciled with it.* **Recommended resolution (Claude, unconfirmed — it reopens the "no refresh token" decision):** a rotating refresh-token cookie scoped to one endpoint, with the second factor required only at sign-in.
- 2026-10-14 · Hosting approach: managed vs self-managed, and the providers for managed Postgres, Redis and the CDN. Asked in the scale discussion, never answered.
- 2026-10-14 · Email provider (and the second provider behind the adapter) for two-factor codes (FR-83a, FR-83e).
- 2026-10-14 · FR-83b–FR-83f · Confirm the two-factor design proposals (method ranking, role rules, code hardening, deliverability, step-up and device list). Admins and moderators are proposed to use a passkey or authenticator app — which matters for the very first admin created by `npm run admin:create`.
- 2026-10-15 · FR-79c, FR-77a · Check that the chosen queue library works with PgBouncer's transaction mode (advisory locks, LISTEN/NOTIFY and prepared statements need real sessions). Verify before choosing; workers already connect directly.

### Needed by Phase 1
- 2026-10-14 · FR-83g · Account recovery when a user loses all factors.
- 2026-10-14 · FR-79f / SEC-30 · Key management for the application-level encryption of CNIC and payout fields (where keys live, rotation). *Follows from a decided requirement; not yet discussed.*
- 2026-10-14 · SEC-35 · Confirm the payout-detail protections (re-enter password, notify the seller, admin "changed recently" flag). There is no cool-off (decided). The "no cool-off" decision relies on this (and FR-83c, FR-83f) being confirmed; until then a hijacked seller account could change payout details and be paid, and for ordinary buyers email is both the second factor and probably the recovery channel.

### Needed by Phase 2
- 2026-10-13 · FR-18a · Verified-badge criteria. Interim: a moderator sets it by hand.
- 2026-10-13 · FR-08b · High-value listing pending ID verification: no automatic rule; interim is a manual hold/approve/reject.
- 2026-10-13 · Object storage provider for images, evidence, ID documents and video originals.
- 2026-10-14 · CNIC/document retention period; data-protection obligations in Pakistan (needs a lawyer — Claude is not one).
- 2026-10-14 · FR-75, FR-75a · Video: final hosting choice, YouTube API audit and daily-upload quota (flagged from general knowledge — verify), agreement wording, original-file retention. **Blocked: do not build until discussed.**
- 2026-10-14 · FR-76 · Story (voice) description: remaining details. **Blocked: do not build until discussed.**
- 2026-10-15 · FR-73e · Price-edit rule on a live listing: decreases immediate, increases moderated, crossing the high-value threshold needs ID verification first. Proposed (DISCUSS).
- 2026-10-15 · FR-75a/FR-75b/FR-75 · Video terms must cohere: the platform owns the video, the seller opts in to public visibility, it is removed when sold or removed, and it is also used for marketing — plus the "editor" is not a defined role. **Blocked with the video discussion.**

### Needed by Phase 3
- 2026-10-14 · CDN provider (a node near Pakistani users matters; Cloudflare was mentioned as a candidate — verify).
- 2026-10-14 · FR-80f · Sold items hidden from search, reserved shown with a badge (proposed default).
- 2026-10-14 · FR-82–FR-82d · All SEO decisions, via SEO-GATE at page-building time, including which languages buyers search in (English, Roman Urdu, Urdu script).
- 2026-10-14 · Urdu-script / right-to-left support: not decided anywhere.

### Needed by Phase 4
- 2026-10-13 · Payment gateway provider, legal advice on holding customer funds, sandbox account (external).
- 2026-10-13 · FR-63 · Reservation duration (will be an admin-configurable `reservation_hours`).
- 2026-10-14 · FR-63b · What happens to the OTHER open offers when one is accepted. Two unconfirmed options: auto-close them with a notice (and notify favoriters if the item frees up) — recommended in the scale discussion — or freeze them and revive if the reservation lapses — assumed in the Marketplace chat. **Deferred by the human to the end.**
- 2026-10-13 · FR-72 · Seller no-ship policy (seller never hands the item to the courier after the buyer paid). Policies discussion.
- 2026-10-13 · FR-40a · Delivery-partner count and city-based assignment.
- 2026-10-13 · FR-51 · Delivery channel for general notifications (email / SMS / WhatsApp / push). Today the code only writes rows. Decide together with real-time updates (FR-78, deferred) and how offline users are reached.
- 2026-10-14 · FR-60a, FR-63a, FR-69, FR-70 · Confirm the DISCUSS design rows for escrow (hosted checkout, atomic reservation and auto-refund, gateway refunds, settlement reconciliation).
- 2026-10-14 · FR-73a · How price edits (which go through moderation) interact with the high-value ID threshold (FR-08a).
- 2026-10-15 · FR-63c, FR-32b · Cap on a buyer's active reservations (value open) and how it fits the single-item checkout rule. Proposed (DISCUSS).

### Needed by Phase 5
- 2026-10-14 · FR-45a, FR-50a, FR-71 · Confirm partial refunds with commission on what the seller receives. Claude's recommendation; the human left the choice to Claude and has not objected — treat as the working decision, not as confirmed.
- 2026-10-13 · FR-33b · Refusal / return at delivery, now that the buyer has already paid: the return flow and who pays return shipping. Parked.
- 2026-10-13 · FR-72a · Delivery fee on a full refund: refunded or kept? Policies discussion.
- 2026-10-13 · FR-72b · Chargeback liability after the seller has been paid. Policies discussion.
- 2026-10-13 · FR-72c · Held funds for a seller who never completes ID verification.
- 2026-10-15 · **Returns, refunds and disputes are deferred by the human to a later discussion.** Items found in the clash review that belong to it:
  - FR-72e · A lost parcel traps the buyer's money: after handover the buyer cannot cancel (FR-33a) or dispute (FR-43 needs a delivered order), and only an admin can mark Delivered.
  - FR-45g · The payout pause on a filed dispute runs on a fire-and-forget in-process event, not a durable job; if the process dies in between, the hold isn't paused (the release job's open-dispute check limits the damage). `rules.md` Section 3 still endorses events for this.
  - FR-33a · Free cancellation plus the platform absorbing the gateway fee means every cancellation costs money; partial refunds with commission on net widen the margin gap.

### Needed by Phase 6
- 2026-10-13 · SEC-14 · Postgres row-level security: recommended to defer (one DB role, modular monolith). Awaiting confirmation.
- 2026-10-14 · FR-74b · Watermark visual design (pending the final logo).
- 2026-10-14 · Load-test targets and SLOs (proposed: p95 browse under 500 ms, error rate under 1%, search p95 under 300 ms, cache hit above 90%).

## Resolved

- 2026-10-16 · Engineering conventions, adopted as working decisions by delegation (you asked for what is most efficient, fast and light on your system): Express 5 (done), library-first dependency policy, plain `pg` with thin `db.one` / `db.many` helpers (no query builder or ORM), and the load conventions — `rules.md` Section 12. Reverse any of them by telling me.
- 2026-10-15 · Clash review: FR-20 (edits now moderated, pause/remove immediate except while reserved), FR-32a (COD wording and "record only after checkout" removed), FR-32b (clarified), FR-73b (money-read wording made precise) were corrected so the spec no longer contradicts itself. The remaining clash-review items are listed above or under "Returns, refunds and disputes".
- 2026-10-14 · **Official name: Poshaak** is the single, current name of this project (earlier "Marketplace" is the same project).
- 2026-10-14 · SEC-06 · No refresh token: one access token with a configured lifetime; the user logs in again when it expires. A refresh token can be added later. *(Interaction with two-factor and reloads: see FR-84a above.)*
- 2026-10-14 · SEC-10 · The first admin is created by a one-time command run on the server (`npm run admin:create`). No network endpoint, no default credentials.
- 2026-10-14 · Two-factor authentication on every login; email is the code channel for ordinary buyers (FR-83, FR-83a). Design details remain open above.
- 2026-10-14 · Scale program LOCKED points: listing content versioning with moderated edits (Point 1, FR-73/73a), 3–6 photos with required front/back/other shots (Point 2, FR-74), Postgres-backed queue and a separate worker (Point 4, FR-77–77e), managed Postgres with the stated RPO/RTO, real migrations, PgBouncer, encryption and append-only ledgers (Point 6, FR-79–79g), Postgres full-text search with suggestions and the sort set (Point 7, FR-80–80e), React + Vite kept with worker-generated snapshots and performance budgets (Point 8, FR-81–81d). Details tagged DISCUSS in `specs.md` are proposals only.
- 2026-10-14 · Design system: the prototype's wired `styles.css` theme (deep green / cream / gold, Playfair Display + DM Sans) is final; `DESIGN.md` and the stitch-reference screens are not to be used.
- 2026-10-13/14 · Payment model: **escrow replaces COD entirely**, paid through a licensed gateway (card / wallet / bank); an order becomes Funded only from a verified webhook. `specs.md` was revised on 2026-10-14 (section 13; COD rows tagged SUPERSEDED or revised in place); code and schema are rewritten in Phases 4–5.
- 2026-10-13 · FR-38 / FR-41 actor: COD collection no longer exists; only an admin marks an order Delivered, for now (a dedicated `order.mark_delivered` permission, not a hard-coded role).
- 2026-10-13 · Gateway processing fee is absorbed by the platform out of its commission; the actual fee is stored per payment. Seller payouts are manual at launch (FR-48 as written).
- 2026-10-13 · A seller must be ID-verified before the first payout, whatever the price. No cool-off on payout-detail changes.
- 2026-10-13 · Reservation: yes, the listing is reserved for the buyer while payment is pending (duration still open above).
- 2026-10-15 · FR-68 · When to hand "mark Delivered" (and other routine steps) to an ops role as volume grows; today it is admin-only and every order needs an admin action. A permission, so no code change is needed to delegate it.

