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
- 2026-10-17 · FR-77f, FR-79c · **Queue library verification (open; deadline: before a library is committed, start of Phase 0b).** Test the candidate against the actual PostgreSQL + PgBouncer configuration — job claiming, concurrent workers, transaction handling, retries, pooling compatibility. Workers use direct connections only if the library needs persistent sessions or fails through transaction pooling; if it is incompatible, choose a compatible architecture. Critical operations (order + its job) need a transactional outbox or equivalent.
- 2026-10-17 · FR-83d · Resend-cooldown and email-sending-cap values (configurable; set when the login is built, so that total guesses per hour stay negligible).
- 2026-10-17 · SEC-07, FR-84a · Suspended users: check user status on every request, or accept that a suspended user keeps working for up to the 15-minute access-token lifetime? SEC-07 asks for this to be decided and written down.

### Needed before the first deployment or first real login (moved out of Phase 0 on 2026-10-17)
- 2026-10-17 · FR-79h · **Initial hosting is Render (decided).** Still open, to be chosen before the first deployment: PostgreSQL hosting, Redis if required, CDN, storage and connection configuration. Before deployment verify backups, secrets, security settings, database limits, monitoring and recovery — and that the database plan meets the FR-79 targets (RPO about 5 minutes, RTO about 1 hour): Render documents no recovery capability for its free PostgreSQL tier, so free instances are not suitable for real data. Also check that the host's PostgreSQL version supports what the tests run on.
- 2026-10-17 · FR-83e · **Select the email provider(s) before the first real login:** a primary and a secondary fallback, behind the adapter. Verify real delivery, rate limits, failure handling, retries and failover. Nodemailer is the common interface, but it is SMTP-oriented — confirm it has a transport for the chosen HTTPS-API provider, or call the provider's own SDK behind the adapter. Render's free web services block outbound SMTP.
- 2026-10-17 · FR-83i, FR-83j · Confirm or drop the remaining email proposals: code tied to the login attempt, invisible bot check, per-IP limits, disposable-email blocking, email ownership at signup (FR-83i); sending subdomain with SPF/DKIM/DMARC, separate login stream, ~10 s p95, code in the subject (FR-83j).

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

- 2026-10-17 · FR-83d · **Buyer email codes approved:** six digits, five-minute expiry, single use, only a hash stored, at most 3 verification attempts per code, resend cooldown and sending caps (values open above), identical responses whether or not the account exists.
- 2026-10-17 · FR-84a · **Token lifetimes approved (configurable defaults):** access token 15 minutes in memory; buyer refresh 30-day absolute / 7-day inactivity; staff refresh 8-hour absolute / 30-minute inactivity; rotation on every refresh; reuse revokes the token family; enforced server-side.
- 2026-10-17 · FR-77f / FR-79c · **Queue strategy approved:** verify the library against the real PostgreSQL + PgBouncer configuration before committing (the verification itself stays open); direct worker connections only when the library requires them; if incompatible, choose a compatible architecture; a transactional outbox or equivalent keeps an order and its job consistent; jobs are retryable and safe against duplicate execution.
- 2026-10-17 · FR-79h · **Initial hosting: Render.** The final production architecture and provider choices are deferred (see open items).
- 2026-10-17 · FR-83e · **Email architecture approved:** Nodemailer as the common sending interface where appropriate, providers behind an adapter, an HTTPS-API-compatible setup preferred for the initial Render deployment, a secondary provider as a fallback with failover tested before production; providers selected before the first real login.
- 2026-10-17 · FR-84, SEC-04/05/06 · **Sessions:** a rotating, single-use refresh-token cookie (httpOnly, Secure, SameSite=Strict, refresh endpoint only) renews a short-lived in-memory access token; the second factor is needed at sign-in only; CSRF protection applies to the refresh endpoint. This replaces the 2026-10-14 "no refresh token" decision and closes the reload-with-2FA conflict. *Recommended by Claude, confirmed by you.*
- 2026-10-17 · FR-83h · **Phase 0 two-factor scope:** email code for ordinary buyers; authenticator app (TOTP) for admins and moderators, never email; passkeys later. `admin:create` also enrolls the first admin's authenticator.
- 2026-10-17 · **Hosting and provider choices** are no longer Phase 0 blockers: Phase 0 builds against local services (embedded Postgres for tests, an in-memory rate limiter, a mail log); hosting is chosen before the first deployment and the email provider before the first real login.
- 2026-10-16 · Engineering conventions, adopted as working decisions by delegation (you asked for what is most efficient, fast and light on your system): Express 5 (done), library-first dependency policy, plain `pg` with thin `db.one` / `db.many` helpers (no query builder or ORM), and the load conventions — `rules.md` Section 12. Reverse any of them by telling me.
- 2026-10-15 · Clash review: FR-20 (edits now moderated, pause/remove immediate except while reserved), FR-32a (COD wording and "record only after checkout" removed), FR-32b (clarified), FR-73b (money-read wording made precise) were corrected so the spec no longer contradicts itself. The remaining clash-review items are listed above or under "Returns, refunds and disputes".
- 2026-10-14 · **Official name: Poshaak** is the single, current name of this project (earlier "Marketplace" is the same project).
- 2026-10-14 · SEC-06 · No refresh token: one access token with a configured lifetime; the user logs in again when it expires. A refresh token can be added later. *(Interaction with two-factor and reloads: see FR-84a above.)* **Superseded 2026-10-17** by the rotating refresh-token cookie (see below).
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

