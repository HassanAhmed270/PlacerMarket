# DEVELOPMENT_HANDOFF.md — resuming Poshaak development

**State updated 2026-10-23.** Poshaak (formerly "Marketplace" — same project) has
a backend, React/Vite frontend, PostgreSQL queue, migrations, and completed
Phase 0 auth implementation. Local Redis is reachable; the hosted workflow and
live providers remain unverified.
Read `MASTER_PROJECT_CONTEXT.md`, `PHASE1_PROGRESS.md`, and
`PHASE1_GATE_REPORT.md` for current evidence. Phase 1 implementation stages and
local checks are recorded, but the broader gate remains open. Configured
development database/JWT values were used; the full local demo passed using a
fresh Redis logical DB. See
`DEMO_RUN.md` and `LIVE_CHECKS.md`.

## Phase 2 update (2026-10-23)

Listing core, media pipeline, photo moderation, listing revisions, and workspace
screens are implemented. See `PHASE2_PROGRESS.md` and `PHASE2_GATE_REPORT.md`.
Backend unit tests passed (39 suites/487 tests), integration passed (7
suites/98 tests with the guarded test database and local Redis), and frontend
lint/test/build plus schema check passed. Both production audits returned 0
vulnerabilities. Migrations, seeds, API/worker startup, Vite routes, local CORS,
and the 14-step local demo passed. See `DEMO_RUN.md`, `security.md` SEC-31, and
`LIVE_CHECKS.md`. Phase 2 is not a closed gate because hosted provider/storage
checks and named frontend behavior evidence remain pending.

## 1. What you are working with

The ZIP `poshaak-project-consolidated.zip` unpacks to `backend/`. It is the
authoritative state: if memory, an old chat or a pasted summary disagrees with these
files, trust the files and the human's latest instruction, and log the conflict in
`open-questions.md`.

Reading order: `MASTER_PROJECT_CONTEXT.md` → `agent.md` → `rules.md` → `Phases.md` →
`security.md` → `specs.md` → `open-questions.md`.

## 2. First 10 minutes in a new conversation

1. Ask for (or confirm you have) the latest ZIP. Run `unzip -tq` on it; extract it to a
   fresh working directory. Don't rebuild anything from memory of earlier chats.
2. `cd backend && npm install && npm test` — expect **192 tests, 12 suites, all passing**.
   `npm audit --omit=dev` — expect 0.
3. Read the documents in the order above. Check `Phases.md` for the **Current phase**.
4. Confirm the state with the human in a few lines before changing anything.

**Owner decisions dated 2026-10-21:** Phase 1/2 seller application, atomic
approval, measurement definition, payout protection, seller authenticator,
step-up/recovery, key custody, manual ID verification, listing revision and
photo-slot decisions are recorded in `specs.md` and `open-questions.md`.
Implementation backlogs are in `Phases.md`; deferred items are in
`END_OF_PHASES_REVIEW.md`. The later FR-66 decision requires manual
`id_verified` before first payout; email verification remains only for
high-value listings strictly above the threshold. Historical Phase 0 gate
evidence still contains the prior first-payout email wording, documented as a
conflict in `END_OF_PHASES_REVIEW.md`.

## 3. What to do next (Phase 1 handoff)

Resume from the residual items in `PHASE1_GATE_REPORT.md`, not by repeating
completed implementation stages. Owner decisions
dated 2026-10-21 set FR-83d limits, the FR-84b Argon2id/Redis scope, FR-83g
self-service password reset, the strict high-value threshold, and the Phase 2
gate amendment. FR-83k recovery policy is now decided; implementation is in the
Phase 1 backlog, with the manual owner-only procedure used until then.
Provider credentials and deployed behavior are listed in `LIVE_CHECKS.md`.

Stage 1 centralizes runtime settings in `src/config.js` and adapter boundaries
under `src/lib/adapters/`; no production provider implementation is claimed yet.
Stage 2 added Argon2id registration and the auth foundation migration. Stages 5–7 now implement login/session flows; live-provider and deployment checks remain open.
Stage 3 adds fail-closed Redis fixed-window limits for signup/login and existing
message/offer writes. Email-code requests add address caps and a soft IP signal in Stage 4; Stage 6 adds rate-limited reset requests and confirmation. Real Redis concurrency verification
requires `TEST_REDIS_URL`; Redis is unavailable in the current workspace.
Stage 4 adds address verification, encrypted queue delivery, code attempt and
send limits, and the high-value email-ownership gate. Stages 5–7 add buyer email
factor login, staff TOTP, rotating refresh sessions, reset flows and the one-time
admin bootstrap. Phase 1 Stages 1–10 and local checks are documented in
`PHASE1_PROGRESS.md`. The account UI has not had browser-level testing, real
Redis tests were skipped, and demo seed/smoke did not run. Resolve these and the
unchecked items in `PHASE1_GATE_REPORT.md` before claiming release readiness.
`LISTING_REVISIONS_PLAN.md` is proposed design only; resolve its questions before
Phase 2 implementation.

## 4. Working agreements (details in `rules.md`)

Stage 1 centralizes runtime settings in `src/config.js` and adapter boundaries
under `src/lib/adapters/`; no production provider implementation is claimed yet.

- **Stop and ask** on any `(OPEN)` or `(DISCUSS)` row or a genuine ambiguity; log it in
  `open-questions.md`; continue only with unrelated work.
- Rows tagged `(DISCUSS)`, `(OPEN)` or `(SUPERSEDED)` are not built or ticked until the
  human removes the tag. `(DEFERRED)` is out of scope.
- **SEO-GATE:** anything touching titles, meta, headings, alt text, structured data,
  URLs/slugs, canonicals, robots, sitemap or snapshot templates — discuss first.
- Tick a `specs.md` checkbox only with code + a test whose title names the FR + a
  green `npm test`. Commit as `FR-xx: …` / `chore:` / `docs:`; a tick and its test go in
  the same commit. Never use `--no-verify`.
- Add any new dependency, gap or OPEN item to `agent.md` / `open-questions.md` in the
  same change. Concurrency-sensitive code needs real-Postgres tests.
- Claude's recommendations are not decisions. The human's latest finalized decision wins.

## 5. Things that will trip you up

- Every existing test mocks the database. `db:setup` has never been run against a real
  Postgres, and some queries use columns that aren't in `schema.sql` (listed in
  `agent.md`). The unit tests cannot catch that.
- `schema.sql` is the COD-era baseline (26 tables). New SQL belongs in migrations.
- Hooks assume the repo root is `backend/`; they are local-only (`--no-verify` skips
  them) and there is no CI yet.
- Sessions: a rotating refresh-token cookie with the approved lifetimes (FR-84, FR-84a). Free Render web services block outbound SMTP and free Render PostgreSQL has no recovery — see FR-83e and FR-79h before deploying anything.
- Returns, refunds and disputes (including lost parcels, FR-72e, and the FR-45g payout pause) are deferred by the human to a later discussion — don't design or build them until it happens.
- FR-45a/50a/71 (partial refunds) are Claude's recommendation, not confirmed.
- The container resets between sessions; files persist only in the delivered ZIP.

## 6. Updating and re-packaging

Edit the extracted files; run `npm test`; check that every FR/SEC code cited in a
document exists (`specs.md` / `security.md`); remove `node_modules`; zip the `backend/`
folder (keep the hooks executable); present the ZIP. Update `MASTER_PROJECT_CONTEXT.md`
(sections 2, 6, 7, 9) and this file's state line whenever something is built or decided.

## 7. Resume prompt (paste into a new chat in this Claude Project, with the ZIP attached)

> We are continuing Poshaak (formerly "Marketplace"), one project. I've attached the
> latest `poshaak-project-consolidated.zip`. Verify the ZIP, extract it, run
> `npm install && npm test` (expect 192 tests in 12 suites), then read
> `DEVELOPMENT_HANDOFF.md`, `MASTER_PROJECT_CONTEXT.md`, `agent.md`, `rules.md`,
> `Phases.md`, `security.md`, `specs.md` and `open-questions.md`, in that order. Follow
> `rules.md` strictly, including stop-and-ask and SEO-GATE. Tell me the current phase
> and the decisions still needed before Phase 0, then wait for my answers. Don't change
> files until we've agreed the next step.

## 8. Phase 1 authorization amendment (2026-10-21)

The owner authorized the Phase 1 implementation program on 2026-10-21, including
the stage order recorded in `PHASE1_PROGRESS.md`. Phase 0 residuals remain open:
hosted CI, the real-Redis run, and all production/live checks in `LIVE_CHECKS.md`.
Nothing is exposed to real users before those residuals and the applicable Phase 1
gate checks are closed. This amendment records authorization; it does not claim
those checks have passed.
