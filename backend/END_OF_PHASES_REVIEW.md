# End-of-phases review

Phase 1 and Phase 2 evidence and release-gate residuals are summarized in
`PHASE1_GATE_REPORT.md` and `PHASE2_GATE_REPORT.md`. Phase 2 listing revisions
are implemented per the 2026-10-22 owner decisions; the version-pointer/cache
proposals were not adopted. Phase 3 status and remaining gate work are mapped
in `PHASE3_GATE_REPORT.md`. Phase 3 is not closed.

## Phase 4 pre-launch gates (2026-10-28)

These are external/operational release conditions, not claims of approval or
implementation: select and verify the live gateway provider and sandbox; obtain
legal clearance for holding customer funds and approve customer-facing terms;
verify provider webhook signatures against raw request bytes; keep production
`PAYMENTS_ENABLED` disabled until all gates are approved; enroll two distinct
authenticator-protected Admins if provisional D2 is confirmed; and confirm the
manual courier arrangement and escalation process. Track execution in
`LIVE_CHECKS.md`.

Items to revisit after the scheduled phases. Deferral here does not authorize
building these features in an earlier phase.

- **Identity provider, document handling and retention (FR-66 / FR-66a):**
  evaluate a real identity-verification provider and any document collection,
  storage or retention only with legal advice. The current manual Admin flow
  stores no CNIC number or document.
- **Video (FR-75–FR-75c):** hosting/provider, YouTube API and quota audit,
  agreement wording, marketing rights, original-file retention, moderator/editor
  responsibilities and playback lifecycle.
- **Voice story (FR-76 / FR-76a):** processing/provider, consent wording,
  language handling and rate/cost limits.
- **Passkeys (FR-83b):** methods, fallback ordering and sign-in UX.
- **Device list/revoke UI (FR-83f):** revisit after core step-up and new-device
  notice behavior is implemented.
- **Payment gateway provider:** choose before Phase 4 implementation, with legal
  advice about holding customer funds and a sandbox account.
- **Production storage backend:** local disk is the initial adapter; select and
  verify the production S3-compatible backend before launch.
- **Offers/negotiation (FR-29–FR-31):** deferred by the 2026-10-22 owner
  decision; `OFFERS_ENABLED` defaults off. Fixed-price Buy is the early-site
  path, and its Phase 3 screen does not reserve or accept payment.
- **Urdu script / right-to-left interface:** deferred. Search may use English
  and Roman Urdu; the interface remains English-only.
- **Popularity sort, trending searches and “did you mean” suggestions:** deferred.
- **Real-time chat:** deferred; the approved update path uses polling.
- **Version-pointer and proposed FR-73b/FR-73c cache semantics:** not adopted.
  Preserve the approved Phase 3 freshness limits instead; production cache/CDN
  behavior is a live check, not permission to implement the rejected design.
- **CDN provider and production snapshot-serving model:** live checks tracked in
  `LIVE_CHECKS.md`; do not assume a provider or a serving architecture.

## Recorded conflicts to preserve

- **First payout verification:** earlier 2026-10-21 Phase 0 text in Phases.md,
  PHASE0_GATE_REPORT.md, and the prior resolved entry in open-questions.md said
  registered-email verification applied before the first payout. The later owner
  decision recorded on 2026-10-21 requires seller_profiles.id_verified before
  first payout, while email verification remains strictly-above-threshold for
  high-value listings and never sets id_verified. The current manual verification
  path stores no identity document. Historical gate evidence was not rewritten.
- **72-hour payout lock:** the old open-questions.md proposal described a
  72-hour payout lock without distinguishing it from the FR-45g dispute hold.
  The owner decision supersedes a payout-detail-change lock with step-up,
  notification and Admin review; FR-45g dispute-hold behavior remains a
  separate later discussion.
- **Listing revisions plan:** the approved decision is an overlay with one open
  revision per listing and moderation for every edit including price. No
  separate `LISTING_REVISIONS_PLAN.md` file was present during an earlier
  documentation update; it is now present and records the approved scope.

## Phase 3 checkpoint (2026-10-25)

The owner decisions dated 2026-10-22 supersede negotiation-only Buy, confirm
seller-city filtering and sold/reserved search behavior, define the minimal
suggestions/sort set, approve SEO/structured-data/URL/indexability rules, and
set snapshot generation behavior. See `DECISIONS_2026-10-22.md`,
`open-questions.md` and `PHASE3_GATE_REPORT.md`. The latest local backend
unit/smoke and frontend suites passed; the guarded PostgreSQL integration
suite did not start because `TEST_DATABASE_URL` was unset. No production
readiness is claimed.
