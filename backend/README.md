# Poshaak backend

> Poshaak is the single, current name of this project (earlier chats and files
> call it "Marketplace"). Resuming in a new session? Start with
> `DEVELOPMENT_HANDOFF.md`.

Plain Node.js + Express 5 backend for the Poshaak C2C marketplace. Plain
JavaScript (no TypeScript), no DI framework, one `modules/*.service.js`
file per spec module, routes call services directly (no controllers).

**Start here if you're an agent or a new contributor:** read [`agent.md`](./agent.md)
first — it maps every FR number to the file that owns it, flags the 5 OPEN
spec decisions and how each is actually handled in code, and documents the
non-obvious cross-module dependencies. Then read [`rules.md`](./rules.md) —
the standing rules for how to behave on every task (spec discipline,
ownership rules, when to stop and ask vs. proceed, testing and commit
requirements). This README only covers running the thing.

## Setup

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL at minimum
npm run db:setup        # applies schema.sql, then seeds platform_settings
npm start                # or: npm run dev (auto-restart on file change)
```

`npm run db:setup` runs two scripts:
- `db/migrate.js` — applies `schema.sql` to `DATABASE_URL` as one flat script (no migration-history table, no up/down versioning — this is a single-shot setup, not a real migrations system).
- `db/seed.js` — inserts the `platform_settings` rows (`commission_percent`, `high_value_threshold_pkr`, `payout_hold_days`, `complaint_window_days`) that a large part of the service layer reads via `getSetting()`. Without this step, calls like `users.service.isIdVerificationRequired()` or `payout.service.startHold()` will throw `NotFoundError`.

## Testing

```bash
npm test
```

Jest. `test/unit/` covers pure-logic functions directly and DB-touching
functions via a mocked `db.service.js` (see `test/unit/disputes.service.test.js`
and `test/unit/settlement.service.test.js` for the mocking pattern — extend
it the same way for other modules). `test/smoke/app.test.js` boots the real
Express app and hits routes that don't require a live database.

Coverage today is intentionally partial — it proves the pattern and covers
the two OPEN-item guards (FR-45a/FR-50a) and the FR-05a permission matrix,
not every function. Extend it as you build out each module's real logic.

## Git hooks

`hooks/commit-msg` and `hooks/pre-commit` enforce the commit rules in
`rules.md` Section 8 (message format, "ticked checkbox needs its test in the
same commit", never commit `node_modules/`/`.env`/`coverage/`). `npm install`
wires them up automatically via `core.hooksPath` once this folder is a git
repo; before that, run `npm run hooks:install` after `git init`. They assume
this folder is the repo root.

## Known gaps (see agent.md for the full list)

- No session/auth strategy implemented yet — `users.service.authenticate()`
  is a stub, so nothing behind `requireAuth` actually works end-to-end yet.
- `lib/roles.js` is missing a couple of permissions (routes currently reuse
  an Admin-only stand-in) — see agent.md's "Known gaps" section.
- `db/migrate.js` is a single-shot script, not a real migrations system —
  fine for a fresh dev DB, not for evolving schema.sql over time.

## Project layout

```
src/
  db.service.js         only file that imports `pg` directly
  app.js / server.js    Express app + bootstrap
  lib/                  errors, event bus + event names, roles matrix
  middleware/           auth stub, central error handler
  modules/              13 service files, one per spec module — see agent.md
  routes/               one thin router per module, mounted under /api
db/
  migrate.js            applies schema.sql
  seed.js                seeds platform_settings
hooks/
  commit-msg, pre-commit  git hooks enforcing rules.md Section 8
  lib/fr.js               pure logic shared by the hooks and the tests
test/
  unit/                  pure-logic + mocked-db tests
  smoke/                  app-level tests against routes that don't need a DB
specs.md                 functional spec (bundled so this repo is self-contained)
schema.sql                database schema (bundled, same reason)
agent.md                  routing doc — read this first
rules.md                  standing behavioral rules — read this second
security.md               security checklist — binding via rules.md Section 9
Phases.md                 build order, backend + frontend in parallel, gate per phase
MASTER_PROJECT_CONTEXT.md full project state: architecture, built vs planned, decisions, verification
DEVELOPMENT_HANDOFF.md    how a new Claude conversation resumes from here
HANDOFF.md                concise handoff: state, approved decisions, open questions, next actions
AGENTS.md                 instructions the Codex agent reads automatically (implementer rules)
WORKFLOW.md               who does what: you, the Claude window, Codex; the review loop
open-questions.md         register of open, deferred and resolved decisions
```
