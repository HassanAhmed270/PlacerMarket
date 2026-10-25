# DEVELOPMENT_HANDOFF.md — resuming Poshaak development

**State updated 2026-10-25.** Poshaak (formerly "Marketplace" — same project)
has a backend, React/Vite frontend, PostgreSQL queue and migrations. Phase 3
implementation and gate evidence are mapped in `PHASE3_GATE_REPORT.md`.
Backend unit/smoke passed 46 suites/581 tests; frontend tests passed 16/16;
frontend lint, build and public-bundle check passed. The guarded integration
suite could not start because `TEST_DATABASE_URL` was unset. Phase 3 is not
closed; production provider/CDN/snapshot checks remain pending. Read
`MASTER_PROJECT_CONTEXT.md`, `Phases.md`, `PHASE3_GATE_REPORT.md` and
`LIVE_CHECKS.md` for current status.

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

1. Confirm the checked-out workspace and current branch; do not overwrite or
   reconstruct the repository from an old ZIP or chat summary.
2. Read `MASTER_PROJECT_CONTEXT.md`, `Phases.md`, `PHASE3_GATE_REPORT.md`,
   `DEVELOPMENT_HANDOFF.md`, `agent.md`, `rules.md`, `security.md`, `specs.md`
   and `open-questions.md`.
3. Run backend unit/smoke (`cd backend && npm test -- --runInBand`) and frontend
   tests (`cd frontend && npm test`). The guarded backend integration suite
   requires an explicitly approved `TEST_DATABASE_URL` and, where applicable,
   `TEST_REDIS_URL`; do not substitute production/development URLs.
4. Check `Phases.md` and the gate report before choosing the next task. The
   2026-10-25 integration attempt did not start because `TEST_DATABASE_URL` was
   unset; it is not a pass.

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

## 3. What to do next (Phase 3 gate)

Resume from `PHASE3_GATE_REPORT.md`; do not repeat completed work or treat this
documentation checkpoint as a closed gate. Resolve the integration rerun by
providing the specifically approved guarded test database and Redis
configuration. Then address the report's parked rows with tests whose titles
name the FR/SEC requirement. Do not implement the deferred offers/negotiation
or superseded version-pointer/cache proposals.

Phase 3 decisions are recorded in `DECISIONS_2026-10-22.md`: fixed-price Buy
with a “checkout opens soon” state, offers disabled by default and deferred,
messaging retained, sold listings hidden from search, reserved badges,
English/Roman Urdu search and English-only UI, and bounded snapshot/search
freshness. The selected production CDN and snapshot serving model remain live
checks in `LIVE_CHECKS.md`.

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

> We are continuing Poshaak (formerly "Marketplace"), one project. Inspect the
> current workspace and read `MASTER_PROJECT_CONTEXT.md`, `Phases.md`,
> `PHASE3_GATE_REPORT.md`, `DEVELOPMENT_HANDOFF.md`, `agent.md`, `rules.md`,
> `security.md`, `specs.md` and `open-questions.md`. Follow `rules.md`, including
> stop-and-ask and SEO-GATE. Phase 3 is not closed; the latest guarded
> integration attempt could not start because `TEST_DATABASE_URL` was unset.
> Resume from the gate report and do not claim integration or production checks
> passed without evidence..

## 8. Phase 1 authorization amendment (2026-10-21)

The owner authorized the Phase 1 implementation program on 2026-10-21, including
the stage order recorded in `PHASE1_PROGRESS.md`. Phase 0 residuals remain open:
hosted CI, the real-Redis run, and all production/live checks in `LIVE_CHECKS.md`.
Nothing is exposed to real users before those residuals and the applicable Phase 1
gate checks are closed. This amendment records authorization; it does not claim
those checks have passed.
