# End-of-phases review

Items to revisit after the scheduled phases. Deferral here does not authorize
building these features during Phases 1 or 2.

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
  separate LISTING_REVISIONS plan file was present in the repository when
  these docs were updated; this summary records the decision without claiming
  that a separate plan document was verified.
