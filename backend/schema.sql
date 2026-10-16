-- =============================================================================
-- CONSOLIDATION NOTE (2026-10-14) — read before relying on this file
-- This is the COD-era BASELINE schema (26 tables). No table or column was added
-- or changed in the consolidation. It does NOT yet reflect:
--   * escrow: payments, refunds, payout and ledger tables replace the shape of
--     cod_collections / payout_holds / settlements (specs.md section 13)
--   * versioned listing content, reservations, photo slots/variants, video and
--     story fields (sections 14-15)
--   * queue, outbox and webhook-inbox tables (section 16)
--   * listing_search, synonyms, suggestions (section 18)
--   * 2FA, passkeys, backup codes, devices, audit tables (section 20)
--   * application-level encryption of CNIC / payout fields (FR-79f)
-- Per FR-79b this file becomes a snapshot generated from versioned migrations;
-- the new SQL is written as migrations when each phase starts (Phases.md).
-- Known code/schema mismatches are listed in agent.md ("Known gaps").
-- =============================================================================

-- ============================================================
-- Poshaak — Data Model / Schema (schema.sql)
-- Maps to specs.md FR numbers. Comments flag OPEN decisions.
-- Modular monolith, single Postgres DB, logical module ownership.
-- Last updated: 2026-09-26
-- ============================================================

-- ------------------------------------------------------------
-- MODULE 1: Identity & Users  (FR-01 to FR-10)
-- ------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('buyer', 'seller', 'admin', 'moderator');
CREATE TYPE seller_application_status AS ENUM ('none', 'pending', 'approved', 'rejected');
CREATE TYPE payout_method_type AS ENUM ('bank', 'easypaisa', 'jazzcash');

CREATE TABLE cities (                                          -- FR-04
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL UNIQUE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone               VARCHAR(20) NOT NULL UNIQUE,          -- primary auth identifier
    email               VARCHAR(255) UNIQUE,
    password_hash       TEXT NOT NULL,
    full_name           VARCHAR(150) NOT NULL,
    city_id             UUID REFERENCES cities(id),           -- FR-03
    role                user_role NOT NULL DEFAULT 'buyer',   -- FR-05
    -- FR-05a: moderator permission flags (only meaningful when role = 'moderator')
    can_review_listings     BOOLEAN NOT NULL DEFAULT FALSE,
    can_review_disputes     BOOLEAN NOT NULL DEFAULT FALSE,
    can_review_applications BOOLEAN NOT NULL DEFAULT FALSE,
    -- fee config + user suspension are Admin-only by construction (no flag needed; enforced in app layer for role = 'admin')
    is_suspended        BOOLEAN NOT NULL DEFAULT FALSE,       -- FR-52
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seller_applications (                              -- FR-06, FR-07, FR-07a, FR-07b
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    status          seller_application_status NOT NULL DEFAULT 'pending',
    reason_for_selling TEXT,
    what_will_sell  TEXT,
    reviewed_by     UUID REFERENCES users(id),                -- admin or moderator (FR-05a scope)
    rejection_reason TEXT,
    is_resubmission BOOLEAN NOT NULL DEFAULT FALSE,            -- FR-07a
    resubmitted_from UUID REFERENCES seller_applications(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ
);

CREATE TABLE seller_profiles (                                  -- FR-08, FR-09, FR-09a
    user_id             UUID PRIMARY KEY REFERENCES users(id),
    display_alias       VARCHAR(100),
    is_approved         BOOLEAN NOT NULL DEFAULT FALSE,
    approved_at         TIMESTAMPTZ,
    -- FR-08a: ID verification is per-seller flag, but TRIGGERED by a listing crossing threshold — not required upfront
    id_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    id_verification_doc_url TEXT,
    -- FR-09a payout method
    payout_method       payout_method_type,
    payout_bank_account TEXT,       -- used when payout_method = 'bank'
    payout_wallet_number TEXT,      -- used when payout_method = 'easypaisa'/'jazzcash'
    rating_avg          NUMERIC(3,2) DEFAULT 0,                 -- FR-27a, FR-27b
    rating_count        INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 2: Catalog  (FR-11 to FR-14a)
-- ------------------------------------------------------------

CREATE TABLE main_categories (                                  -- FR-11, FR-12
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name    VARCHAR(50) NOT NULL UNIQUE                        -- Men's / Women's / Kids'
);

CREATE TABLE sub_categories (                                   -- FR-11, FR-12 (per-main-category, admin-extensible)
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    main_category_id    UUID NOT NULL REFERENCES main_categories(id),
    name                VARCHAR(50) NOT NULL,                  -- Bridal / Sherwani / Designer / Brand / Party Wear
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (main_category_id, name)
);

CREATE TYPE listing_condition AS ENUM ('brand_new', 'pre_owned', 'custom_made', 'replica'); -- FR-13

-- FR-15a: measurement fields are DEFINED per sub-category, admin-configurable
CREATE TABLE measurement_field_defs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sub_category_id UUID NOT NULL REFERENCES sub_categories(id),
    field_name      VARCHAR(50) NOT NULL,   -- e.g. "chest", "shoulder", "length", "sleeve"
    unit            VARCHAR(20),            -- e.g. "inches"
    display_order   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (sub_category_id, field_name)
);

-- ------------------------------------------------------------
-- MODULE 3: Listings  (FR-15 to FR-21a)
-- ------------------------------------------------------------

CREATE TYPE listing_status AS ENUM (
    'draft', 'pending_review', 'approved', 'rejected',
    'published', 'paused', 'unpublished', 'removed'
);

CREATE TABLE listings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id           UUID NOT NULL REFERENCES users(id),
    main_category_id    UUID NOT NULL REFERENCES main_categories(id),
    sub_category_id     UUID NOT NULL REFERENCES sub_categories(id),
    condition           listing_condition NOT NULL,             -- FR-13
    replica_disclosure  TEXT,                                   -- FR-14, required when condition = 'replica' (app-layer check)
    title               VARCHAR(150) NOT NULL,
    description         TEXT,
    asking_price        NUMERIC(12,2) NOT NULL,                 -- reference price only, NOT a buy-now price (FR-15, FR-29)
    fabric_material     VARCHAR(100),                           -- FR-15b
    brand               VARCHAR(100),                           -- FR-15b
    color               VARCHAR(50),                             -- FR-15b
    embellishment_detail TEXT,                                   -- FR-15b, e.g. embroidery/zardozi/stonework
    status              listing_status NOT NULL DEFAULT 'draft', -- FR-19
    rejection_reason    TEXT,                                    -- FR-21
    is_resubmission     BOOLEAN NOT NULL DEFAULT FALSE,          -- FR-21a
    resubmitted_from     UUID REFERENCES listings(id),
    -- FR-18/FR-18a: Verified badge is INDEPENDENT of approval-to-publish (FR-19a)
    is_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    verified_by         UUID REFERENCES users(id),
    verified_at         TIMESTAMPTZ,
    -- FR-19b: high-value threshold gate. Threshold value itself lives in platform_settings.
    requires_id_verification BOOLEAN NOT NULL DEFAULT FALSE,     -- computed at submit time (asking_price > threshold)
    reviewed_by         UUID REFERENCES users(id),                -- admin or moderator (FR-05a scope)
    published_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listing_measurements (                              -- FR-15a
    listing_id      UUID NOT NULL REFERENCES listings(id),
    field_def_id    UUID NOT NULL REFERENCES measurement_field_defs(id),
    value           NUMERIC(6,2) NOT NULL,
    PRIMARY KEY (listing_id, field_def_id)
);

CREATE TABLE listing_images (                                    -- FR-16
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id  UUID NOT NULL REFERENCES listings(id),
    image_url   TEXT NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE listing_evidence (                                  -- FR-17, FR-18
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id  UUID NOT NULL REFERENCES listings(id),
    evidence_url TEXT NOT NULL,
    evidence_type VARCHAR(50)      -- receipt / tag / packaging / doc
);

-- ------------------------------------------------------------
-- MODULE 4: Search & Discovery  (FR-22 to FR-27b)
-- ------------------------------------------------------------

CREATE TABLE favorites (                                          -- FR-26
    user_id     UUID NOT NULL REFERENCES users(id),
    listing_id  UUID NOT NULL REFERENCES listings(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, listing_id)
);

-- NOTE: reviews table (FR-27b) is defined after MODULE 6 (Orders) below,
-- since it references orders(id) and must come after that table exists.

-- ------------------------------------------------------------
-- MODULE 5: Messaging & Negotiation  (FR-28 to FR-31)
-- ------------------------------------------------------------

CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id  UUID NOT NULL REFERENCES listings(id),
    buyer_id    UUID NOT NULL REFERENCES users(id),
    seller_id   UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (listing_id, buyer_id)
);

CREATE TABLE messages (                                           -- FR-28, FR-30
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    sender_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    was_flagged_bypass BOOLEAN NOT NULL DEFAULT FALSE,            -- FR-30: contact-info/link detection
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE offer_status AS ENUM ('pending', 'countered', 'accepted', 'declined', 'expired');

CREATE TABLE offers (                                             -- FR-29, FR-31
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    listing_id      UUID NOT NULL REFERENCES listings(id),
    proposed_by     UUID NOT NULL REFERENCES users(id),           -- buyer or seller (counter)
    amount          NUMERIC(12,2) NOT NULL,
    status          offer_status NOT NULL DEFAULT 'pending',
    parent_offer_id UUID REFERENCES offers(id),                   -- counter-offer chain
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 6: Orders  (FR-32 to FR-34)
-- ------------------------------------------------------------

CREATE TYPE order_status AS ENUM (
    'bag',                -- FR-32: accepted offer, pending checkout
    'order_placed',
    'seller_preparing',
    'handed_to_delivery',
    'out_for_delivery',
    'delivered',
    'held',                -- FR-45b: in payout-hold window
    'completed',
    'cancelled',            -- FR-33a: pre-dispatch cancellation
    'refused_at_door',      -- FR-33b: OPEN — flow not fully defined yet, state reserved
    'return_requested',
    'returned'
);

CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    accepted_offer_id   UUID NOT NULL REFERENCES offers(id),      -- FR-32
    listing_id          UUID NOT NULL REFERENCES listings(id),
    buyer_id            UUID NOT NULL REFERENCES users(id),
    seller_id           UUID NOT NULL REFERENCES users(id),
    agreed_item_price   NUMERIC(12,2) NOT NULL,
    delivery_fee        NUMERIC(12,2) NOT NULL DEFAULT 0,          -- FR-32a, buyer pays on top
    total_cod_amount    NUMERIC(12,2) GENERATED ALWAYS AS (agreed_item_price + delivery_fee) STORED,
    delivery_address    TEXT NOT NULL,                             -- captured at checkout, FR-32a
    payment_method_preference VARCHAR(20) NOT NULL,                -- 'cash' | 'digital_transfer', FR-36a
    status              order_status NOT NULL DEFAULT 'bag',
    cancelled_at        TIMESTAMPTZ,                                -- FR-33a
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    checkout_completed_at TIMESTAMPTZ,                              -- when order_placed was reached
    delivered_at        TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE TABLE reviews (                                            -- FR-27b, two-way, tied to a completed order
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL REFERENCES orders(id),
    reviewer_id UUID NOT NULL REFERENCES users(id),
    reviewee_id UUID NOT NULL REFERENCES users(id),
    rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, reviewer_id)   -- one review per direction per order
);

-- ------------------------------------------------------------
-- MODULE 7: Payments & COD  (FR-36 to FR-38)
-- ------------------------------------------------------------

CREATE TABLE cod_collections (
    order_id            UUID PRIMARY KEY REFERENCES orders(id),
    collected_amount    NUMERIC(12,2),
    collection_method   VARCHAR(20),        -- 'cash' | 'digital_transfer', actual (may differ from preference)
    collected_at        TIMESTAMPTZ,
    -- FR-41a: MANUAL reconciliation for MVP
    remitted_to_platform BOOLEAN NOT NULL DEFAULT FALSE,
    remitted_at          TIMESTAMPTZ,
    reconciled_by        UUID REFERENCES users(id),  -- admin/ops who manually reconciled
    reconciliation_note  TEXT
);

-- ------------------------------------------------------------
-- MODULE 8: Delivery  (FR-39 to FR-42)
-- ------------------------------------------------------------

CREATE TABLE delivery_partners (                                   -- FR-40a: OPEN (count/city-assignment undecided)
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    supports_cash_collection BOOLEAN NOT NULL DEFAULT TRUE,        -- FR-40 hard requirement
    -- city assignment: nullable/global for now since partner count model is undecided
    city_id     UUID REFERENCES cities(id)
);

CREATE TYPE delivery_status_value AS ENUM (
    'assigned', 'picked_up', 'in_transit', 'delivered', 'delivery_failed'
);

CREATE TABLE delivery_status_log (                                 -- FR-41: MANUAL entry for MVP
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id),
    delivery_partner_id UUID REFERENCES delivery_partners(id),
    status              delivery_status_value NOT NULL,
    entered_by          UUID NOT NULL REFERENCES users(id),        -- ops staff, since manual for MVP
    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 9: Disputes, Returns & Refunds  (FR-43 to FR-45a)
-- ------------------------------------------------------------

CREATE TYPE dispute_status AS ENUM ('open', 'seller_responded', 'resolved_refund', 'resolved_release', 'resolved_other');

CREATE TABLE disputes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id),
    raised_by            UUID NOT NULL REFERENCES users(id),       -- buyer
    reason_text          TEXT NOT NULL,                             -- FR-43b: free-text only
    status               dispute_status NOT NULL DEFAULT 'open',
    -- FR-43c: seller counter-response — working default, not locked
    seller_response_text TEXT,
    seller_responded_at  TIMESTAMPTZ,
    resolved_by          UUID REFERENCES users(id),                  -- admin/moderator
    resolution_note      TEXT,
    -- FR-45a OPEN: resolution_amount_to_buyer lets partial refund be modeled without a schema change later;
    -- app layer can enforce "must equal 0 or full amount" until partial-refund policy is decided.
    resolution_amount_to_buyer NUMERIC(12,2),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at          TIMESTAMPTZ
);

CREATE TABLE dispute_evidence (                                     -- FR-43a: required at filing
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_id  UUID NOT NULL REFERENCES disputes(id),
    uploaded_by UUID NOT NULL REFERENCES users(id),                  -- buyer at filing, or seller counter-evidence
    file_url    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 9a: Payout Hold Window  (FR-45b to FR-45h)
-- ------------------------------------------------------------

CREATE TYPE payout_hold_state AS ENUM ('held', 'released', 'force_released', 'paused_for_dispute');

CREATE TABLE payout_holds (
    order_id            UUID PRIMARY KEY REFERENCES orders(id),
    hold_started_at     TIMESTAMPTZ NOT NULL,
    hold_window_days    INTEGER NOT NULL DEFAULT 5,                  -- FR-45c, provisional/admin-configurable
    complaint_window_days INTEGER NOT NULL DEFAULT 3,                -- FR-43, provisional/admin-configurable
    state               payout_hold_state NOT NULL DEFAULT 'held',
    released_at         TIMESTAMPTZ,
    -- FR-45e: force-release requires a reason
    force_released_by   UUID REFERENCES users(id),
    force_release_reason TEXT,
    -- FR-45f: cannot force-release while dispute open (enforced in app layer via disputes.status)
    dispute_id          UUID REFERENCES disputes(id)
);

-- ------------------------------------------------------------
-- MODULE 10: Commission & Settlement  (FR-46 to FR-50a)
-- ------------------------------------------------------------

CREATE TABLE platform_settings (                                    -- FR-46, FR-50, FR-19b threshold, FR-45c/FR-43 windows
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seeded rows (examples, not migrations):
--   ('commission_percent', '10')                        -- FR-46, single global %
--   ('high_value_threshold_pkr', '100000')               -- FR-08a/FR-19b
--   ('payout_hold_days', '5')                             -- FR-45c
--   ('complaint_window_days', '3')                        -- FR-43

CREATE TABLE settlements (                                           -- FR-47, FR-48, FR-49
    order_id            UUID PRIMARY KEY REFERENCES orders(id),
    commission_percent  NUMERIC(5,2) NOT NULL,                        -- snapshot at settlement time
    commission_amount   NUMERIC(12,2) NOT NULL,                       -- computed on agreed_item_price ONLY (FR-46a)
    seller_net_payout   NUMERIC(12,2) NOT NULL,
    payout_initiated_by UUID REFERENCES users(id),                    -- FR-48: manual/admin-triggered
    payout_initiated_at TIMESTAMPTZ,
    -- FR-50a OPEN: if a dispute resolves with a partial refund, this record's math depends on
    -- the still-undecided FR-45a policy — do not build partial-refund settlement logic yet.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 11: Notifications  (FR-51)
-- ------------------------------------------------------------

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    event_type  VARCHAR(50) NOT NULL,   -- e.g. 'seller_app_status', 'listing_status', 'new_offer', 'order_status', 'delivery_update', 'dispute_update'
    payload     JSONB,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- MODULE 12: Administration  (FR-52 to FR-59)
-- ------------------------------------------------------------
-- No dedicated tables beyond what's above — admin actions operate on
-- users, seller_applications, listings, orders, disputes, platform_settings,
-- delivery_partners (FR-57), and a future ad_campaigns table (FR-59, not yet modeled — deferred).

-- ============================================================
-- NOTES FOR IMPLEMENTATION
-- ============================================================
-- 1. FR-33b (COD refusal-at-the-door) has a reserved order_status enum value
--    ('refused_at_door') but no supporting table yet — do not build logic
--    against it until that gap is closed (see specs.md open decisions).
-- 2. FR-45a (dispute resolution granularity) — disputes.resolution_amount_to_buyer
--    and settlements table are shaped to ALLOW partial refunds later without a
--    migration, but app-layer logic should currently only allow 0 or full amount.
-- 3. FR-40a (delivery partner count/city assignment) — delivery_partners.city_id
--    is nullable so this works whether MVP ships with one partner or several.
-- 4. FR-18a (Verified badge criteria) — listings.is_verified is a simple boolean
--    set manually by admin/moderator; no rules engine, since criteria aren't defined.
