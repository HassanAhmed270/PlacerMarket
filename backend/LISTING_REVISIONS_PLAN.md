# Listing revisions implementation plan

**Status: proposed design only.** This document is a Phase 2 planning artifact. It does not approve SQL, change the Phase 1 contract, or authorize routes. SQL below is illustrative; do not run it or turn it into a migration until the owner resolves the questions at the end. No historical revision backfill is proposed.

## Goal and Phase 1 contract

For a published listing, the existing `listings` row remains the public version while a seller's edit awaits moderation. A proposed edit is stored as a side-copy in `listing_revisions`. There may be at most one open revision per listing. In v1, the copy contains text, structured listing fields, measurements, and price. Every price edit requires moderation, including a decrease. A proposed price strictly above `platform_settings.high_value_threshold_pkr` may be published only when the seller's registered email is verified; equality does not trigger the gate. Email verification proves address control and is not identity verification.

Approval atomically copies the revision onto the live listing, guarded by the listing's `content_version`; rejection changes only the revision and leaves the public row unchanged. Existing search and detail API contracts continue to read the public listing. Pending revision values must never leak through public search or detail responses. See `specs.md` FR-20, FR-73, FR-73a, FR-73b, and FR-73e; `Phases.md` Phase 2; and the resolved FR-73 entry in `open-questions.md`.

## Proposed v1 boundaries

Proposed editable fields to snapshot: `main_category_id`, `sub_category_id`, `condition`, `replica_disclosure`, `title`, `description`, `asking_price`, `fabric_material`, `brand`, `color`, `embellishment_detail`, and the measurement field/value pairs in `listing_measurements`.

Do not accept seller-proposed changes to owner, listing status, moderation/verification fields, timestamps, or identity/payout state. Do not copy `listing_images` or `listing_evidence` into revisions in v1: FR-74/media moderation needs a separate decision on replacement, private originals, and published variants. This is a recommended boundary, not a resolved product decision. New, unpublished listing creation and rejected-listing resubmission retain their existing lifecycle until the owner decides whether they should share this revision model.

## Proposed data shape (SQL sketch only)

Prefer typed columns for the listing values so existing validation, SQL queries, and constraints remain visible. A JSONB field may be useful for immutable audit metadata, but should not be the only copy of core listing values. Measurements can be represented as a JSONB snapshot keyed by stable measurement-definition ID, or as child rows; the implementation task must select one after checking FR-15a validation and category changes. The sketch chooses child rows conceptually and omits their DDL for brevity.

```sql
-- Proposal only. content_version is a concurrency token for the live row.
ALTER TABLE listings
  ADD COLUMN content_version BIGINT NOT NULL DEFAULT 1;

CREATE TYPE listing_revision_status AS ENUM
  ('pending_review', 'approved', 'rejected');

CREATE TABLE listing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  base_content_version BIGINT NOT NULL,
  proposed_main_category_id UUID NOT NULL REFERENCES main_categories(id),
  proposed_sub_category_id UUID NOT NULL REFERENCES sub_categories(id),
  proposed_condition listing_condition NOT NULL,
  proposed_replica_disclosure TEXT,
  proposed_title VARCHAR(150) NOT NULL,
  proposed_description TEXT,
  proposed_asking_price NUMERIC(12,2) NOT NULL,
  proposed_fabric_material VARCHAR(100),
  proposed_brand VARCHAR(100),
  proposed_color VARCHAR(50),
  proposed_embellishment_detail TEXT,
  status listing_revision_status NOT NULL DEFAULT 'pending_review',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE UNIQUE INDEX listing_revisions_one_open_per_listing
  ON listing_revisions (listing_id)
  WHERE status = 'pending_review';

CREATE INDEX listing_revisions_review_queue
  ON listing_revisions (submitted_at, id)
  WHERE status = 'pending_review';
CREATE INDEX listing_revisions_owner_history
  ON listing_revisions (seller_id, listing_id, submitted_at DESC);
```

Measurement values need a revision child table with a unique key such as `(revision_id, field_def_id)` and the same numeric constraints as listing measurements. If category changes are permitted, the service must validate the target category's active required measurement definitions against the proposed snapshot. If not, category IDs should be removed from the v1 editable set. Retain approved/rejected rows for moderation history; decide retention and privacy policy before launch.

`content_version` is proposed as a monotonically increasing version of the published content, initialized to 1 for existing rows. No old revision rows are backfilled because there is no historical snapshot to reconstruct. Verify the deployed PostgreSQL version and lock behavior for adding a non-null default. If the operation cannot meet the migration lock budget, add the column nullable with a default, then use a bounded/operationally safe step to establish the baseline and constraint. The migration plan should use a short `lock_timeout`. A `CREATE INDEX CONCURRENTLY` step must be run outside a transaction if the repository's migration runner requires transaction-wrapped migrations; confirm runner behavior before splitting the proposal into migrations.

## Proposed lifecycle and transaction behavior

The only open state in this proposal is `pending_review`. `approved` and `rejected` are terminal history states. Do not add `conflicted` or `superseded` until product behavior is chosen; stale versions should produce a visible conflict and require a fresh seller submission.

1. **Submit:** authenticate the seller, lock/read the listing, verify ownership and that it is currently published/editable, capture `content_version`, validate all proposed fields and measurements, then insert the revision. The partial unique index is the final race-proof guard for one open revision. Return a conflict if another submission won the race.
2. **Public reads while pending:** continue returning the unchanged `listings` row and existing images. Draft/revision values are private to the seller and authorized moderation views. Search and detail response shapes do not change.
3. **Reject:** in a transaction, lock revision and listing, verify the revision is pending and reviewer permission is present, then mark it rejected with reviewer, timestamp, and reason. Do not update `listings`, measurements, search state, or public cache.
4. **Approve:** in one transaction, lock revision and listing, confirm pending state, ownership relationship, and `base_content_version = listings.content_version`; validate again against current rules and the current high-value threshold. If proposed price is strictly above the threshold, require the seller's registered email to be verified. Update all approved fields and measurements, increment `content_version`, mark the revision approved, and enqueue any required post-commit/search projection work through the established transactional outbox. A version mismatch is a conflict: do not overwrite the live listing. Decide whether moderators can resubmit for correction or the seller must submit a new revision.
5. **Concurrent decisions:** serialize approve/reject by locking the revision row. Lock ordering should consistently be listing then revision (or revision then listing everywhere) to avoid deadlocks. Concurrent seller submission is still guarded by the unique partial index. A transaction failure must leave both the public listing and revision state unchanged.

Read the email-verification state from the authoritative user/profile row at approval, not a stale cache. Since the policy is “before publication,” recheck the current threshold and email state at approval even if also checked at submission. A threshold change between submission and approval therefore cannot silently bypass the rule.

## Proposed service, route, permission, notification changes

- Add a listing revision service for submit, seller history/detail, moderator queue/detail, approve, and reject. Keep validation and atomic transitions in the service, not route handlers.
- Add authenticated seller routes scoped to the current seller and listing ownership, and moderator/Admin routes protected by the existing listing-review capability (verify the actual permission names before implementation). Never rely on a caller-supplied `seller_id`, status, reviewer ID, version, or email verification value.
- Add request schemas that reject forbidden listing state and unknown fields. Enforce title, price, category, condition/replica disclosure, and required measurement rules consistently with listing creation. Define a stable conflict response for an existing open revision and a stale `content_version`.
- On approval, emit a versioned listing-updated event only after the database commit, preferably using the existing transactional outbox. Notify seller on approval/rejection using the existing notification/worker path. Submission and review retries must not duplicate notifications; include revision ID and transition in the event idempotency key. No email is sent directly inside a database transaction.
- Search/detail continue reading only the published `listings` row. Reindex approved content using the current search architecture; pending submissions and rejection must not touch search. Verify cache invalidation against the actual implementation before shipping, especially the cached detail path and any static snapshots (FR-80a/FR-81a).

## Expand, switch, contract proposal

1. **Expand:** deploy additive `content_version`, revision enum/table/measurement snapshot storage, and indexes. No old revision backfill. Existing listing readers and writers continue working.
2. **Switch writes:** deploy service and routes behind a feature flag or disabled route mount. Enable seller revision submission and moderator review only after the new transaction path, authorization, and notification/outbox behavior are verified. Keep direct live-listing update paths for drafts/new listings as presently specified; prohibit bypass updates to published seller-owned content.
3. **Switch reads on approval:** approved values atomically replace the live columns and measurements; public search/detail code continues reading the same live row and preserves response contracts. Verify reindex and invalidation behavior before enabling broadly.
4. **Contract:** after confirming all callers use the revision service and the rollback window has closed, remove any legacy direct-edit path for published listings. Do not remove revision history or `content_version` as part of ordinary rollback. Any future destructive retention cleanup needs a separate approved policy and migration.

## Rollback proposal

Disable revision submission/review routes or the feature flag first. Keep additive tables and the version column so data remains reviewable. A code rollback can restore the previous public read path because it still reads the live row; do not run a down migration that drops revisions or resets versions. If approval code caused bad content, use the normal moderation/unpublish correction path and a new reviewed revision; never rewrite audit history silently. A database rollback is not the rollback mechanism for already approved content. Document an operator recovery procedure and test transaction rollback before production enablement.

## Required real-PostgreSQL tests before enabling

- Two simultaneous submissions for one listing: exactly one pending revision persists; the other receives the documented conflict, enforced by the real partial unique index.
- Pending revision leaves public detail/search values and content version unchanged; seller/moderator views show only appropriately authorized proposed values.
- Approval copies every v1 field and measurements atomically, increments content version exactly once, closes the revision, and produces one idempotent outbox event. Inject a failure mid-transition and assert neither side partially changes.
- Reject leaves listing fields, measurements, version, search projection, and public cache state unchanged; it records reviewer/reason/time.
- Two simultaneous approve/reject decisions: exactly one transition succeeds. A stale `base_content_version` cannot overwrite a newer listing.
- Strict threshold boundaries: price equal to threshold does not trigger email verification; price one minor unit above does. Unverified seller cannot publish above threshold; verified registered email can; email verification does not set identity verification. Change threshold after submission and verify approval uses the current value.
- Role and ownership matrix: unrelated seller cannot read/submit; seller cannot approve/reject; unauthorized staff cannot moderate; route cannot set protected fields or spoof verification state.
- Measurement/category validation uses current active required fields; malformed/inactive/duplicate field IDs fail without a partial revision.
- Rejected and approved history remains available only to authorized parties; public endpoints never return revision IDs or draft payloads.
- Search/detail continue returning the approved live content after approval and never return pending values; verify the real cache/reindex path and stale-result expectations.

Unit tests should cover validation and transition decisions, but they do not replace these database concurrency and transaction tests.

## Dependencies and sequencing

- FR-20 defines listing edit behavior; FR-73/73a/73e are the controlling resolved contract for revisions and price moderation.
- FR-08a high-value email gate and current threshold setting must be implemented and read from authoritative state. FR-66 identity verification remains a separate concept.
- FR-15a measurement definitions already exist; category/measurement behavior on revision is an owner decision and validation dependency.
- FR-74 photo slots, evidence, private originals, and watermarked public variants are deliberately outside v1 until media-revision behavior is decided.
- FR-80/80a search and FR-81/81a generated snapshots must consume approved content/version changes without exposing pending drafts. Confirm their delivery and cache invalidation design before release.
- FR-73b through FR-73d contain DISCUSS proposals for version pointers, cache handling, route-walker checks, and related behavior. This document does not resolve or approve those proposals; reconcile them before implementation if their approach affects the unchanged search/detail read contract.
- Moderation permissions, notification delivery, durable outbox, audit retention, and migration-runner transaction behavior must be verified against current code before the implementation issue is split.

## Bounded implementation task list (proposal)

1. Resolve the owner questions below and update the spec/decision log before coding.
2. Freeze the v1 editable-field allowlist and measurement snapshot representation; write API request/response and conflict semantics.
3. Add expand-only migration(s) for the version token, revision tables, status type, foreign keys, and indexes; measure lock behavior on a production-sized copy.
4. Implement service validation, ownership checks, single-open-revision handling, submission/history reads, and moderator queue reads.
5. Implement atomic approve/reject transitions with content-version compare, live threshold/email verification, measurements, and audit metadata.
6. Add seller and moderator routes with existing permission middleware; keep disabled until the data/service path is ready.
7. Add idempotent transactional outbox events and seller notifications; wire approved-version reindex/cache invalidation.
8. Add unit, route-permission, real-Postgres concurrency/rollback, and public-read non-leak tests listed above.
9. Run migration/schema checks and full relevant suites; verify no published-listing update bypass remains.
10. Enable for an internal cohort, inspect conflict/moderation/outbox behavior, then stage wider rollout and only later remove the legacy edit path.

## Owner questions and recommendations

1. **Which structured fields are editable in v1?** Recommendation: include category/subcategory, condition, replica disclosure, brand/fabric/color/embellishment, and measurements, subject to required-measurement validation. If category changes create excessive complexity, defer category changes explicitly.
2. **Are images/evidence part of a revision?** Recommendation: no for v1; design image replacements with FR-74 private originals, moderation, and published-variant lifecycle.
3. **Can an open revision be edited or withdrawn?** Recommendation: keep one immutable submitted snapshot; reject it or let a moderator return it for correction only after deciding whether “returned” is still open. Do not overwrite the submitted audit record.
4. **Does this apply only to already-published listings?** Recommendation: yes. Keep initial listing submission and rejected initial resubmission on their existing lifecycle until they are deliberately unified.
5. **What happens when current measurements become inactive or required definitions change while a revision is pending?** Recommendation: validate against current definitions at approval and return a clear conflict requiring seller correction; never silently drop values.
6. **Should category/subcategory changes be allowed?** Recommendation: allow only with full revalidation of category membership and measurement requirements; otherwise defer them from v1.
7. **How long are approved/rejected revision snapshots retained, and who can see them?** Recommendation: retain for moderation/audit according to the existing record-retention policy, seller and authorized moderators only; public APIs never expose them.
8. **Should FR-73b version pointers and FR-73c cache TTL proposals be adopted?** Recommendation: keep the simple live-row/content-version model for v1 and separately resolve pointer/cache proposals before any snapshot/cache consumer depends on them.

