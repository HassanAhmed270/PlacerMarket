# DEVELOPMENT_HANDOFF.md — resuming Poshaak development

**State as of 2026-10-14.** Poshaak (formerly "Marketplace" — same project) has a
tested but COD-era harness and a large, mostly *documented* plan. **No phase has
started: Phase 0 is next.** Read `MASTER_PROJECT_CONTEXT.md` for the full picture.

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

## 3. What to do next (Phase 0)

Do not start Phase 0 code until these are decided (all in `open-questions.md`,
"Needed by Phase 0"): how a session survives a page reload and the access-token
lifetime (FR-84a); hosting approach and providers; the email provider; confirmation
of the two-factor design (FR-83b–FR-83f). Then Phase 0a (real-Postgres tests,
migration runner, fix the schema/code mismatches), 0b (queue + worker), 0c (JWT +
two-factor + hardening). The frontend scaffold runs in parallel.

## 4. Working agreements (details in `rules.md`)

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
- The session-persistence conflict (FR-84a) must be resolved before building auth.
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
