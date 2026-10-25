-- Generated from db/migrations by db:generate-schema. Do not edit directly.
-- Migration: 001_initial_schema.sql
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

-- Migration: 002_pgboss_schema.sql
SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint);
CREATE SCHEMA IF NOT EXISTS pgboss;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE FUNCTION pgboss.job_now()
    RETURNS timestamp with time zone AS
    $$
      SELECT pg_catalog.now();
    $$
    LANGUAGE sql STABLE;
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone,
      reindex_on timestamp with time zone,
      monitor_backoff_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      blocked_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      retained_count int,
      retained_on timestamp with time zone,
      created_delta int NOT NULL default 0,
      completed_delta int NOT NULL default 0,
      failed_delta int NOT NULL default 0,
      delta_on timestamp with time zone,
      delta_seconds int,
      wait_bins int[],
      run_bins int[],
      ready_oldest_seconds int,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_claim_on timestamp with time zone,
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      kind text not null DEFAULT 'cron' CHECK (kind IN ('cron', 'rrule')),
      cron text not null,
      timezone text DEFAULT 'UTC',
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      last_job_id uuid,
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int,
      source_output jsonb,
      source_root_id uuid,
      trace_context jsonb,
      upsert_by_key bool
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    CREATE TABLE pgboss.job_common (LIKE pgboss.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i12 ON pgboss.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i13 ON pgboss.job (name, singleton_key) WHERE state = 'created' AND upsert_by_key$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i14 ON pgboss.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i15 ON pgboss.job (name, created_on)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i16 ON pgboss.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i17 ON pgboss.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, 'job_common');

    ALTER TABLE pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count   int NOT NULL DEFAULT 0,
      ready_count    int NOT NULL DEFAULT 0,
      active_count   int NOT NULL DEFAULT 0,
      failed_count   int NOT NULL DEFAULT 0,
      total_count    int NOT NULL DEFAULT 0,
      created_delta   int,
      completed_delta int,
      failed_delta    int,
      delta_seconds   int,
      delta_on        timestamptz,
      wait_bins       int[],
      run_bins        int[],
      ready_oldest_seconds int,
      captured_on timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, captured_on)
    ) PARTITION BY RANGE (captured_on)
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);
;

    DO $$
    DECLARE
      d date;
      i int;
      part_name text;
    BEGIN
      FOR i IN 0..1 LOOP
        d := (pgboss.job_now() AT TIME ZONE 'UTC')::date + i;
        part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

    CREATE TABLE pgboss.instance (
      id uuid PRIMARY KEY,
      name text,
      host text NOT NULL,
      pid int NOT NULL,
      version text NOT NULL,
      node_version text NOT NULL,
      application_name text,
      heartbeat_seconds int NOT NULL,
      supervise bool NOT NULL,
      schedule bool NOT NULL,
      migrate bool NOT NULL,
      persist_queue_stats bool NOT NULL,
      persist_warnings bool NOT NULL,
      pool_max int,
      pool_total int,
      pool_idle int,
      pool_waiting int,
      workers jsonb NOT NULL DEFAULT '[]'::jsonb,
      metrics jsonb,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      crash_restarts int NOT NULL DEFAULT 0,
      crash_restarts_since timestamptz,
      started_on timestamptz NOT NULL DEFAULT now(),
      heartbeat_on timestamptz NOT NULL DEFAULT now(),
      stopped_on timestamptz
    )
  ;

    CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          pgboss.job_now(),
          pgboss.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i12 ON pgboss.job (source_root_id) WHERE source_root_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i13 ON pgboss.job (name, singleton_key) WHERE state = 'created' AND upsert_by_key$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i14 ON pgboss.job (name, state, blocked, start_after) WHERE state IN ('created', 'retry', 'active', 'failed')$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i15 ON pgboss.job (name, created_on)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i16 ON pgboss.job (name, completed_on) WHERE completed_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i17 ON pgboss.job (name, singleton_key, created_on) WHERE state < 'active' AND singleton_key IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN

      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;

      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('46');

-- Migration: 003_auth_foundation.sql
-- Expand-only authentication foundations for FR-01, FR-02, FR-83d, FR-84.
ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD COLUMN password_changed_at TIMESTAMPTZ;

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  replaced_by_session_id UUID REFERENCES auth_sessions(id),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id, created_at);

CREATE TABLE email_login_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_attempt_id UUID NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email_digest TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts_used SMALLINT NOT NULL DEFAULT 0 CHECK (attempts_used BETWEEN 0 AND 3),
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX email_login_codes_attempt_idx ON email_login_codes (login_attempt_id, created_at DESC);
CREATE INDEX email_login_codes_address_idx ON email_login_codes (email_digest, created_at DESC);
CREATE UNIQUE INDEX email_login_codes_one_active_attempt_idx ON email_login_codes (login_attempt_id)
  WHERE consumed_at IS NULL;

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);

CREATE TABLE staff_totp_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: 004_email_code_purpose.sql
-- Expand-only distinction between login-factor codes and address verification.
ALTER TABLE email_login_codes
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'
    CHECK (purpose IN ('login', 'verify_email'));

CREATE UNIQUE INDEX email_login_codes_one_active_verification_idx
  ON email_login_codes (user_id, purpose)
  WHERE purpose = 'verify_email' AND consumed_at IS NULL;

-- Migration: 005_staff_totp_replay_guard.sql
-- Expand-only TOTP replay protection; one accepted counter value per credential.
ALTER TABLE staff_totp_credentials
  ADD COLUMN last_used_step BIGINT;

-- Migration: 006_measurement_field_lifecycle.sql
-- Expand measurement definitions for required and retired fields (FR-15a).
ALTER TABLE measurement_field_defs
  ADD COLUMN required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- Migration: 007_payout_encryption_envelope.sql
-- FR-79f: expandable encrypted payout payload storage; the legacy plaintext
-- columns remain untouched until the payout UI migration is ready.
ALTER TABLE seller_profiles
  ADD COLUMN payout_details_encrypted JSONB;

-- Migration: 008_manual_identity_verification.sql
-- FR-66 / FR-08a: audit the manual Admin identity check without retaining
-- identity numbers or documents.
ALTER TABLE seller_profiles
  ADD COLUMN verified_by UUID REFERENCES users(id),
  ADD COLUMN verified_at TIMESTAMPTZ,
  ADD COLUMN verification_note TEXT;

-- Migration: 009_seller_authenticator_step_up.sql
-- FR-83c / FR-83f: seller TOTP credentials, one-use recovery codes, bound
-- step-up grants, and privacy-preserving known-device fingerprints.
ALTER TABLE auth_sessions
  ADD COLUMN device_hash TEXT,
  ADD COLUMN enrollment_only BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE seller_totp_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  last_used_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seller_totp_backup_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX seller_totp_backup_codes_active_idx ON seller_totp_backup_codes(user_id, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE step_up_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('payout.update', 'password.change', 'security.change', 'payout.force_release')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX step_up_grants_active_idx ON step_up_grants(user_id, session_id, action, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE known_auth_devices (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

-- Migration: 010_payout_controls.sql
-- FR-09a / SEC-35 / FR-83l: sanitized payout display metadata and audited
-- seller-level administrative holds. Legacy plaintext columns remain for
-- expand-only compatibility and are scrubbed by keys:rotate.
ALTER TABLE seller_profiles
  ADD COLUMN payout_last4 VARCHAR(4),
  ADD COLUMN payout_changed_at TIMESTAMPTZ,
  ADD COLUMN payout_needs_update BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN payout_hold_active BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN payout_hold_reason TEXT,
  ADD COLUMN payout_hold_set_by UUID REFERENCES users(id),
  ADD COLUMN payout_hold_set_at TIMESTAMPTZ,
  ADD COLUMN payout_hold_cleared_by UUID REFERENCES users(id),
  ADD COLUMN payout_hold_cleared_at TIMESTAMPTZ,
  ADD COLUMN payout_hold_clear_reason TEXT;

-- Migration: 011_listing_media.sql
-- FR-74: expand listing image storage for private originals and processed variants.
ALTER TABLE listing_images
  ADD COLUMN slot VARCHAR(16),
  ADD COLUMN processing_state VARCHAR(16) NOT NULL DEFAULT 'ready'
    CHECK (processing_state IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN original_key TEXT,
  ADD COLUMN thumbnail_key TEXT,
  ADD COLUMN medium_key TEXT,
  ADD COLUMN large_key TEXT,
  ADD COLUMN social_key TEXT,
  ADD COLUMN content_hash CHAR(64),
  ADD COLUMN label_confirmed_by UUID REFERENCES users(id),
  ADD COLUMN label_confirmed_at TIMESTAMPTZ,
  ADD COLUMN label_rejected_by UUID REFERENCES users(id),
  ADD COLUMN label_rejected_at TIMESTAMPTZ,
  ADD COLUMN label_rejected_reason TEXT;

CREATE UNIQUE INDEX listing_images_slot_unique
  ON listing_images (listing_id, slot)
  WHERE slot IS NOT NULL;
CREATE INDEX listing_images_processing_idx
  ON listing_images (processing_state, id)
  WHERE processing_state IN ('pending', 'failed');

-- Migration: 012_listing_revisions.sql
-- FR-73: moderated listing content versions. Additive only; public reads stay on listings.
SET lock_timeout = '3s';

ALTER TABLE listings ADD COLUMN content_version BIGINT NOT NULL DEFAULT 1;

CREATE TYPE listing_revision_status AS ENUM ('pending_review', 'approved', 'rejected', 'withdrawn');

CREATE TABLE listing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id),
  seller_id UUID NOT NULL REFERENCES users(id),
  base_content_version BIGINT NOT NULL CHECK (base_content_version > 0),
  proposed_condition listing_condition NOT NULL,
  proposed_replica_disclosure TEXT,
  proposed_title VARCHAR(150) NOT NULL,
  proposed_description TEXT,
  proposed_asking_price NUMERIC(12,2) NOT NULL CHECK (proposed_asking_price > 0),
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

CREATE UNIQUE INDEX listing_revisions_one_pending_per_listing
  ON listing_revisions (listing_id) WHERE status = 'pending_review';
CREATE INDEX listing_revisions_review_queue
  ON listing_revisions (submitted_at, id) WHERE status = 'pending_review';
CREATE INDEX listing_revisions_seller_history
  ON listing_revisions (seller_id, listing_id, submitted_at DESC);

CREATE TABLE listing_revision_measurements (
  revision_id UUID NOT NULL REFERENCES listing_revisions(id) ON DELETE CASCADE,
  field_def_id UUID NOT NULL REFERENCES measurement_field_defs(id),
  value NUMERIC(6,2) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (revision_id, field_def_id)
);

RESET lock_timeout;

-- Migration: 013_messaging_rules.sql
ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'sold';

CREATE TABLE contact_info_block_attempts (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: 014_conversation_access_notifications.sql
-- SEC-12 conversation access, staff audit, and notifications.
ALTER TABLE messages
  ADD COLUMN read_at TIMESTAMPTZ;

ALTER TABLE notifications
  ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX notifications_user_dedupe_key
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX messages_conversation_activity
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX messages_unread_by_conversation
  ON messages (conversation_id, sender_id, created_at)
  WHERE read_at IS NULL;

CREATE TABLE conversation_staff_read_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  staff_user_id UUID NOT NULL REFERENCES users(id),
  reference_type VARCHAR(20) NOT NULL CHECK (reference_type IN ('dispute', 'report')),
  reference_id VARCHAR(100) NOT NULL CHECK (length(trim(reference_id)) > 0),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversation_staff_read_audit_conversation
  ON conversation_staff_read_audit (conversation_id, read_at DESC);

CREATE TABLE conversation_email_throttles (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
  last_queued_at TIMESTAMPTZ NOT NULL,
  last_message_id UUID NOT NULL REFERENCES messages(id)
);

-- Migration: 015_managed_listing_attributes.sql
CREATE TABLE managed_catalog_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_type TEXT NOT NULL CHECK (attribute_type IN ('color', 'fabric', 'brand')),
  value VARCHAR(100) NOT NULL CHECK (length(trim(value)) > 0),
  normalized_value TEXT GENERATED ALWAYS AS (lower(trim(value))) STORED,
  status TEXT NOT NULL DEFAULT 'pending_custom'
    CHECK (status IN ('approved', 'pending_custom', 'rejected')),
  created_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT managed_catalog_values_type_value_unique UNIQUE (attribute_type, normalized_value)
);

CREATE INDEX managed_catalog_values_review_queue
  ON managed_catalog_values (created_at, id) WHERE status = 'pending_custom';
CREATE INDEX managed_catalog_values_approved
  ON managed_catalog_values (attribute_type, normalized_value) WHERE status = 'approved';

ALTER TABLE listings
  ADD COLUMN color_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN fabric_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN brand_id UUID REFERENCES managed_catalog_values(id);

ALTER TABLE listing_revisions
  ADD COLUMN proposed_color_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN proposed_fabric_id UUID REFERENCES managed_catalog_values(id),
  ADD COLUMN proposed_brand_id UUID REFERENCES managed_catalog_values(id);

INSERT INTO managed_catalog_values (attribute_type, value, status) VALUES
  ('color', 'Black', 'approved'),
  ('color', 'White', 'approved'),
  ('color', 'Navy Blue', 'approved'),
  ('color', 'Red', 'approved'),
  ('color', 'Green', 'approved'),
  ('color', 'Maroon', 'approved'),
  ('color', 'Pink', 'approved'),
  ('color', 'Purple', 'approved'),
  ('color', 'Yellow', 'approved'),
  ('color', 'Orange', 'approved'),
  ('color', 'Brown', 'approved'),
  ('color', 'Beige', 'approved'),
  ('color', 'Grey', 'approved'),
  ('color', 'Gold', 'approved'),
  ('color', 'Silver', 'approved'),
  ('color', 'Teal', 'approved'),
  ('color', 'Turquoise', 'approved'),
  ('color', 'Cream', 'approved'),
  ('color', 'Multicolor', 'approved'),
  ('color', 'Off-white', 'approved'),
  ('fabric', 'Cotton', 'approved'),
  ('fabric', 'Silk', 'approved'),
  ('fabric', 'Chiffon', 'approved'),
  ('fabric', 'Lawn', 'approved'),
  ('fabric', 'Linen', 'approved'),
  ('fabric', 'Khaddar', 'approved'),
  ('fabric', 'Khadi', 'approved'),
  ('fabric', 'Velvet', 'approved'),
  ('fabric', 'Georgette', 'approved'),
  ('fabric', 'Organza', 'approved'),
  ('fabric', 'Net', 'approved'),
  ('fabric', 'Satin', 'approved'),
  ('fabric', 'Denim', 'approved'),
  ('fabric', 'Wool', 'approved'),
  ('fabric', 'Polyester', 'approved')
ON CONFLICT (attribute_type, normalized_value) DO NOTHING;

WITH legacy_values AS (
  SELECT 'color'::TEXT AS attribute_type, color AS value FROM listings
  UNION ALL SELECT 'fabric', fabric_material FROM listings
  UNION ALL SELECT 'brand', brand FROM listings
  UNION ALL SELECT 'color', proposed_color FROM listing_revisions
  UNION ALL SELECT 'fabric', proposed_fabric_material FROM listing_revisions
  UNION ALL SELECT 'brand', proposed_brand FROM listing_revisions
)
INSERT INTO managed_catalog_values (attribute_type, value, status)
SELECT DISTINCT legacy.attribute_type, trim(legacy.value), 'pending_custom'
FROM legacy_values legacy
WHERE legacy.value IS NOT NULL
  AND length(trim(legacy.value)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM managed_catalog_values existing
    WHERE existing.attribute_type = legacy.attribute_type
      AND existing.normalized_value = lower(trim(legacy.value))
  )
ON CONFLICT (attribute_type, normalized_value) DO NOTHING;

UPDATE listings listing SET color_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'color' AND value.normalized_value = lower(trim(listing.color))
  AND listing.color IS NOT NULL AND listing.color_id IS NULL;
UPDATE listings listing SET fabric_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'fabric' AND value.normalized_value = lower(trim(listing.fabric_material))
  AND listing.fabric_material IS NOT NULL AND listing.fabric_id IS NULL;
UPDATE listings listing SET brand_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'brand' AND value.normalized_value = lower(trim(listing.brand))
  AND listing.brand IS NOT NULL AND listing.brand_id IS NULL;

UPDATE listing_revisions revision SET proposed_color_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'color' AND value.normalized_value = lower(trim(revision.proposed_color))
  AND revision.proposed_color IS NOT NULL AND revision.proposed_color_id IS NULL;
UPDATE listing_revisions revision SET proposed_fabric_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'fabric' AND value.normalized_value = lower(trim(revision.proposed_fabric_material))
  AND revision.proposed_fabric_material IS NOT NULL AND revision.proposed_fabric_id IS NULL;
UPDATE listing_revisions revision SET proposed_brand_id = value.id
FROM managed_catalog_values value
WHERE value.attribute_type = 'brand' AND value.normalized_value = lower(trim(revision.proposed_brand))
  AND revision.proposed_brand IS NOT NULL AND revision.proposed_brand_id IS NULL;

CREATE INDEX listings_color_id ON listings (color_id) WHERE color_id IS NOT NULL;
CREATE INDEX listings_fabric_id ON listings (fabric_id) WHERE fabric_id IS NOT NULL;
CREATE INDEX listings_brand_id ON listings (brand_id) WHERE brand_id IS NOT NULL;

-- Migration: 016_listing_search.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE listings
  ADD COLUMN search_version BIGINT NOT NULL DEFAULT 1;

CREATE TABLE listing_search (
  listing_id UUID PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  search_version BIGINT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  main_category_id UUID NOT NULL,
  main_category TEXT NOT NULL,
  sub_category_id UUID NOT NULL,
  sub_category TEXT NOT NULL,
  condition TEXT NOT NULL,
  asking_price NUMERIC(12,2) NOT NULL,
  seller_city_id UUID,
  seller_city TEXT,
  color_id UUID,
  color TEXT,
  fabric_id UUID,
  fabric TEXT,
  brand_id UUID,
  brand TEXT,
  embellishment_detail TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  is_reserved BOOLEAN NOT NULL DEFAULT FALSE,
  search_text TEXT NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, search_text)
  ) STORED
);

CREATE INDEX listing_search_vector_idx
  ON listing_search USING GIN (search_vector);
CREATE INDEX listing_search_trigram_idx
  ON listing_search USING GIN (search_text gin_trgm_ops);
CREATE INDEX listing_search_newest_idx
  ON listing_search (published_at DESC, listing_id);
CREATE INDEX listing_search_price_asc_idx
  ON listing_search (asking_price ASC, published_at DESC, listing_id);
CREATE INDEX listing_search_price_desc_idx
  ON listing_search (asking_price DESC, published_at DESC, listing_id);

CREATE TABLE search_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_term VARCHAR(100) NOT NULL CHECK (length(trim(source_term)) > 0),
  normalized_source_term TEXT GENERATED ALWAYS AS (lower(trim(source_term))) STORED,
  target_term VARCHAR(100) NOT NULL CHECK (length(trim(target_term)) > 0),
  normalized_target_term TEXT GENERATED ALWAYS AS (lower(trim(target_term))) STORED,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT search_synonyms_pair_unique UNIQUE (normalized_source_term, normalized_target_term)
);

CREATE INDEX search_synonyms_source_idx
  ON search_synonyms (normalized_source_term, normalized_target_term);

-- Migration: 017_listing_slugs_seo.sql
-- FR-82, FR-82a, FR-82c: expand-only listing URL and SEO metadata.
SET lock_timeout = '3s';

ALTER TABLE listings
  ADD COLUMN short_id TEXT GENERATED ALWAYS AS (substr(replace(id::text, '-', ''), 1, 12)) STORED,
  ADD COLUMN slug TEXT GENERATED ALWAYS AS (
    coalesce(
      nullif(trim(both '-' from lower(regexp_replace(title, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
      'listing'
    )
  ) STORED,
  ADD COLUMN seo_choice TEXT NOT NULL DEFAULT 'recommended'
    CHECK (seo_choice IN ('recommended', 'custom')),
  ADD COLUMN seo_title VARCHAR(60),
  ADD COLUMN seo_description VARCHAR(155),
  ADD CONSTRAINT listings_custom_seo_text_required
    CHECK (seo_choice <> 'custom' OR (seo_title IS NOT NULL AND seo_description IS NOT NULL));

CREATE UNIQUE INDEX listings_short_id_unique ON listings (short_id);

ALTER TABLE listing_revisions
  ADD COLUMN proposed_seo_choice TEXT NOT NULL DEFAULT 'recommended'
    CHECK (proposed_seo_choice IN ('recommended', 'custom')),
  ADD COLUMN proposed_seo_title VARCHAR(60),
  ADD COLUMN proposed_seo_description VARCHAR(155),
  ADD CONSTRAINT listing_revisions_custom_seo_text_required
    CHECK (proposed_seo_choice <> 'custom'
      OR (proposed_seo_title IS NOT NULL AND proposed_seo_description IS NOT NULL));

RESET lock_timeout;

-- Migration: 019_public_page_snapshots.sql
-- FR-81a, FR-82b: worker-generated public HTML and crawler documents.
CREATE TABLE page_snapshots (
  path TEXT PRIMARY KEY,
  page_type TEXT NOT NULL CHECK (
    page_type IN ('home', 'main_category', 'sub_category', 'category_city', 'listing', 'sitemap', 'robots')
  ),
  html TEXT NOT NULL,
  status_code SMALLINT NOT NULL DEFAULT 200 CHECK (status_code BETWEEN 200 AND 599),
  noindex BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX page_snapshots_type_idx ON page_snapshots (page_type, path);
