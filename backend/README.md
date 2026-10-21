# Poshaak backend

> Poshaak is the single, current name of this project (earlier chats and files
> call it "Marketplace"). Resuming in a new session? Start with
> `DEVELOPMENT_HANDOFF.md`.

Plain Node.js + Express 5 backend for the Poshaak C2C marketplace. Plain
JavaScript (no TypeScript), no DI framework, one `modules/*.service.js`
file per spec module, routes call services directly (no controllers).

Phase 0 owner decisions dated 2026-10-21 are recorded in `Phases.md`,
`specs.md`, `security.md`, and `open-questions.md`. Run checks from this
repository's backend and frontend workspaces; production provider checks are
tracked separately in [`LIVE_CHECKS.md`](./LIVE_CHECKS.md). Phase 2 design and
migrations may begin, but Phase 2 routes stay unavailable to real users until
authentication is complete.

**Start here if you're an agent or a new contributor:** read [`agent.md`](./agent.md)
first — it maps every FR number to the file that owns it, flags the 5 OPEN
spec decisions and how each is actually handled in code, and documents the
non-obvious cross-module dependencies. Then read [`rules.md`](./rules.md) —
the standing rules for how to behave on every task (spec discipline,
ownership rules, when to stop and ask vs. proceed, testing and commit
requirements). This README only covers running the thing.

## Local setup (Windows PowerShell)

Use a dedicated development database for the application. Never point
`DATABASE_URL` at the disposable `testing_only` database: the integration
harness resets that database. Start local PostgreSQL and Redis first, and
create an empty development database using your normal PostgreSQL tooling.

In PowerShell terminal 1:

```powershell
Set-Location D:\Havuor\marketplace\backend
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env locally: set DATABASE_URL to the dedicated development database,
# REDIS_URL=redis://localhost:6379, and CORS_ORIGINS=http://localhost:5173.
# Leave TEST_DATABASE_URL pointed at the disposable testing_only database.
npm.cmd ci
npm.cmd run db:setup
$jwtBytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($jwtBytes)
$env:JWT_ACCESS_SECRET = [Convert]::ToBase64String($jwtBytes)
[Array]::Clear($jwtBytes, 0, $jwtBytes.Length)
npm.cmd run dev
```

The secret above is generated in the current PowerShell process and is not
printed. Generate it again in a new terminal, or keep it in a secure local
secret store; never commit it. `db:setup` expects an empty development
database. For an existing legacy schema, inspect it and use the explicit
baseline workflow below only after confirming compatibility.

In PowerShell terminal 2, run the worker when exercising background jobs:

```powershell
Set-Location D:\Havuor\marketplace\backend
npm.cmd run worker
```

Terminal 1 starts the backend at `http://localhost:3000`. Start the frontend
in its own terminal using the steps in [`../frontend/README.md`](../frontend/README.md).

The setup command expects an empty database. For a database that already has
the legacy schema, first inspect it and run `npm.cmd run db:migrate:baseline`
only after confirming compatibility; then run `npm.cmd run db:seed`.

`npm run db:setup` runs the versioned migration runner, then seeds the database.
- `db/migrate.js` — applies ordered SQL files from `db/migrations/`, tracks
  them in `schema_migrations`, and uses a PostgreSQL advisory lock. An existing
  untracked schema is left untouched and refused; after checking that it is
  compatible with the initial migration, explicitly run
  `npm run db:migrate:baseline` to record it without replaying DDL.
- `db/seed.js` — inserts the `platform_settings` rows (`commission_percent`, `high_value_threshold_pkr`, `payout_hold_days`, `complaint_window_days`) that a large part of the service layer reads via `getSetting()`. Without this step, calls like `users.service.isIdVerificationRequired()` or `payout.service.startHold()` will throw `NotFoundError`.

`schema.sql` is generated from migrations with `npm run db:generate-schema`;
use `npm run db:check-schema` to verify the snapshot. The initial migration
preserves the existing schema definition. The runner is a Phase 0 foundation;
the full FR-79b compatibility and zero-downtime migration gate remains open.

## Testing

```bash
npm test
```

Jest. `test/unit/` covers pure logic and mocked service behavior. The real
PostgreSQL suite is `npm run test:integration`; its guard requires a confirmed
disposable local database URL whose name contains `test` as a delimited token,
then resets only that database's `public` schema. Never point it at an ordinary
development database.

Coverage today is intentionally partial — it proves the pattern and covers
the two OPEN-item guards (FR-45a/FR-50a) and the FR-05a permission matrix,
not every function. Extend it as you build out each module's real logic.

The PostgreSQL queue integration suite covers durable enqueue, transaction
rollback, concurrent workers/FIFO, and transactional effect retry. It requires
the guarded disposable test database above.

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
- Full expand/switch/contract migration compatibility checks, worker backfills,
  and deployed PgBouncer behavior are still future work.
- The Phase 0b queue uses pinned `pg-boss@12.38.0` and Redis. Set
  `QUEUE_DATABASE_URL` to a direct PostgreSQL URL when web `DATABASE_URL` uses
  transaction pooling. Actual deployment PgBouncer compatibility is still an
  open Phase 6 verification.

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
  migrate.js            applies ordered, versioned SQL migrations
  migrations/           ordered migration sources for schema.sql
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
