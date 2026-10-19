# rules.md — standing rules, followed every time, no exceptions

`agent.md` tells you where logic lives. This file tells you how to behave
while working in this repo. Read both before starting any task.

**Source of truth:** `MASTER_PROJECT_CONTEXT.md` describes the whole project
(Poshaak — the single, current name; it was first called "Marketplace").
`specs.md` is the row-by-row requirement list and `open-questions.md` the
register of undecided points. If anything here conflicts with a decision the
human has made since, the human's decision wins — log the conflict in
`open-questions.md` instead of picking a side silently.

## 1. Spec discipline

- Never implement behavior for a spec item marked **(OPEN)** in `specs.md`
  without it being resolved first.
- A row marked **(DISCUSS)** is a recommendation or proposal the human has
  NOT confirmed: don't build it, don't tick it, raise it with the human; the
  human confirms by removing the tag. A row marked **(SUPERSEDED)** was
  replaced by a later decision: never build it. Rows marked **(DEFERRED)**
  are out of scope for now.
- On hitting an OPEN item, or any genuine ambiguity `specs.md` doesn't
  answer: **STOP the current task and log it, don't guess.** Concretely:
  append an entry to `open-questions.md` (one line: what's blocked, which
  FR, why) and continue with any OTHER, unrelated work still in scope for
  the task — but do not touch the blocked FR further until a human answers
  it. If the whole task depends on the blocked item with nothing unrelated
  left to do, the task ends there.
  - **Exception, historical only:** the three `NotYetSpecifiedError` guards
    already in this codebase (FR-33b, FR-45a, FR-50a in
    `orders.service.js`, `disputes.service.js`, `settlement.service.js`)
    were built under the *previous* convention (guard-and-continue) and
    predate this rule. Leave them as-is — don't remove them, and don't
    treat them as license to use the same pattern going forward. From here
    on, new ambiguity gets logged to `open-questions.md`, not a new guard.
    These three specifically get revisited (a) once other/unrelated FR
    work in the current task queue is done, not immediately, or (b)
    whenever a human explicitly asks to revisit them — never automatically
    just because the underlying spec item happens to get resolved
    elsewhere.
- A `specs.md` checkbox (☐ → ✅) may ONLY be ticked once ALL of:
  1. the function(s) implementing that FR exist and match the spec text
     exactly — not an interpretation or a "close enough."
  2. there's a passing Jest test that **asserts the FR's actual behavior
     — the spec sentence itself** — not merely that the function runs or
     returns something. The test's `describe`/`test` title must name the
     FR code (`FR-45f: force-release is refused while a dispute is
     open`). `test/unit/specs-checkboxes.test.js` fails `npm test` if a
     ticked row has no test title naming it, or still carries a blocking
     tag (**(OPEN)**, **(DISCUSS)** or **(SUPERSEDED)**, including forms
     like "(OPEN / MAJOR GAP)"). It can prove the test *names* the FR; whether it truly
     asserts the sentence is a reviewer's call — don't game the title.
  3. `npm test` passes for the **whole suite**, not just the new test.
  "I ran it manually once and it looked right" is not enough to tick a box.

## 2. Ownership discipline

- One table, one owning `modules/*.service.js` file (`agent.md` "Rule
  zero"). **Writes** (`INSERT`/`UPDATE`/`DELETE`) to a table you don't own
  are never allowed — call the owning service's exported function.
- **Reads** across tables: a single-row lookup on a table you don't own
  goes through the owning service's exported function. A direct read-only
  `SELECT`/`JOIN` on someone else's table is allowed ONLY for (a)
  multi-table list/queue views where calling the owner per row would mean
  N+1 queries, and (b) event listeners resolving who to notify
  (`notifications.service.js`). Every such query carries a comment:
  `// cross-module read: <table> (owned by <module>)`.
- `admin.service.js` owns zero tables and stays that way: permission check
  + delegate, nothing else. A SQL query appearing in that file is a bug.

## 3. Dependency discipline

- No circular `require`s between `modules/*.service.js` files. If module A
  needs data module B holds, and B already (or would) need to require A
  back, pass the data in as a parameter instead — see
  `payout.service.js` → `settlement.service.js`'s `resolutionAmountToBuyer`
  parameter (built to avoid exactly this for FR-50a). This is enforced
  automatically by `test/unit/no-circular-requires.test.js`, which fails
  `npm test` and names the cycle if one is introduced — don't "fix" a
  failure there by editing or skipping the test.
- Reactive side effects ("notify someone something happened") go through
  `lib/eventBus.js`. Gating a decision inside the same request/call (e.g.
  FR-45f's force-release check) is always a direct synchronous function
  call — never an event listener. If you're unsure which one a new case
  needs, ask: "does this block a decision right now, or just react to
  something that already happened?"

## 4. Error handling discipline

- Only throw the shared classes in `lib/errors.js`. Never throw a bare
  `Error` or a string from a `modules/*.service.js` function or a route —
  a bare `Error` reaches the client as an anonymous 500 and can't be told
  apart from a real crash. Pick the class by meaning:
  - `NotFoundError` (404) — the row/entity doesn't exist.
  - `ValidationError` (400) — the caller sent bad input (including an
    unknown action/enum value).
  - `ForbiddenError` (403) — the caller isn't allowed.
  - `NotImplementedError` (501) — the behavior is decided but the code
    isn't written yet (e.g. the `authenticate()` stub). No FR code.
  - `NotYetSpecifiedError` (501, carries an FR code) — the product
    decision itself is missing. Historical only: per Section 1, new
    ambiguity is logged to `open-questions.md`, not turned into a new
    throw of this class.
- Express 5 forwards a throwing or rejected async handler to
  `middleware/errorHandler.js`, so route handlers are plain
  `async (req, res) => { ... }`. Don't add a wrapper (`lib/asyncHandler.js` was
  removed on 2026-10-16); do throw the typed errors above.

## 5. Permission discipline

- Permission checks live at the **route layer only**: every admin/moderator-
  facing route carries its own `requirePermission()` (`middleware/auth.js`),
  checked against `lib/roles.js`'s `hasPermission()`. Services — including
  `admin.service.js` — never look at a role. Never write an inline
  `if (req.user.role === 'admin')` in a route or service. (Checking whether
  a user *is an approved seller* — `users.isApprovedSeller()` — is domain
  logic about seller status, not a permission check, and is fine.)
- For a route whose needed permission depends on the request body (e.g.
  approve vs reject), pass `requirePermission` a function of `req`.
- Enforced for the admin router by `test/unit/admin.routes.permissions.test.js`,
  which walks every route on `admin.routes.js` and fails if a buyer gets
  past the gate (or a moderator reaches an admin-only action). Any new
  route added to that router is covered automatically; a new router with
  gated routes needs the same kind of test.
- If a route needs a permission that doesn't exist yet in `lib/roles.js`:
  **stop and ask** before reusing an unrelated permission as a stand-in.
  (The two stand-ins already in the codebase — `catalog.manage` and
  `payout.force_release`, both currently using Admin-only gates as
  placeholders — predate this rule and are tracked in `agent.md`'s Known
  Gaps; fixing them isn't a blocker for unrelated work, but don't add a
  third stand-in the same way.)

## 6. Comment & documentation discipline

- Every exported function in a `modules/*.service.js` file has a comment
  **directly above its declaration** (no blank line between) citing at
  least one FR code, e.g. `/** FR-45f: ... */`. Strict, no escape hatch:
  a helper that doesn't map to one FR cites the FR it serves (e.g. a
  settings getter cites the FR whose setting it reads). A section header
  like `// ---- FR-xx ----` separated from the function by a blank line
  does not count. Enforced by `test/unit/fr-comments.test.js`, which fails
  `npm test` and names the function. If you genuinely can't tell which FR
  a new function serves, that's an ambiguity — log it per Section 1.
- Any new cross-module dependency, new OPEN item, new stand-in/workaround,
  or newly discovered gap gets added to `agent.md` (the cross-module map,
  the OPEN items table, or Known Gaps — whichever fits) **in the same
  change that introduces it**, not as a follow-up task.

## 7. Testing discipline

- `npm test` must pass before any task is considered done.
- A new DB-touching function gets a test using the mocked-`db.service.js`
  pattern — `test/unit/disputes.service.test.js` or
  `test/unit/settlement.service.test.js` are the templates.
- Name FR tests by the FR: put the code at the start of the title
  (`FR-xx: <what the spec sentence requires>`). That naming is what the
  checkbox check in Section 1 looks for; a test that exercises an FR but
  doesn't name it can't justify a tick.
- A test that only proves a function runs (smoke, "doesn't throw") is
  fine to have but never justifies ticking a checkbox on its own.
- Never delete or weaken an existing test to make a change pass. If a test
  is genuinely wrong (not just inconvenient), say so explicitly and get
  confirmation before changing it.

## 8. Git / commit discipline

- One commit per FR (or one tightly-related group of FRs) — not one giant
  commit per session. **Written rule only**: nothing can verify what counts
  as "tightly related", so this one relies on review.
- Commit message format: `<FR-code(s)>: <short description>`, e.g.
  `FR-45a, FR-50a: add partial-refund guard to dispute resolution`. For
  non-FR changes: `chore: <description>` or `docs: <description>`.
  **Enforced by `hooks/commit-msg`**, which rejects anything else, rejects
  an FR code that doesn't exist in `specs.md` (typo guard), and lets
  git-generated `Merge ...` subjects through.
- A commit that ticks a `specs.md` checkbox must include, in that same
  commit, the test that justifies the tick — not a separate "add tests"
  commit later. **Enforced by `hooks/pre-commit`**: for every FR newly
  ticked in the staged `specs.md`, it requires a staged `test/**/*.test.js`
  whose `describe`/`test` title names that FR code in full (so write
  `FR-46, FR-46a:`, not `FR-46/46a:` — a title naming only `FR-45a` does
  not back `FR-45`).
- Never commit `node_modules/`, `.env`, or `coverage/`. `.gitignore`
  covers it, and `hooks/pre-commit` also rejects them if force-added
  (`git add -f`). `.env.example` is fine.
- Hook setup: `npm install` runs `prepare`, which points git at the
  versioned `hooks/` folder (`core.hooksPath`). If the repo didn't exist
  yet, run `npm run hooks:install` after `git init`. The hooks assume the
  repo root is this folder (`specs.md` and `test/` at the top level).
- **The hooks are a local guardrail, not a security boundary.**
  `git commit --no-verify` skips them, and there is no CI yet to catch a
  bypass. Never use `--no-verify` to get past a rejection — fix what the
  hook told you instead.

## 9. Security discipline

- `security.md` is the security checklist. Any task that adds or changes a
  route, a service function that takes an id from the caller, a schema
  column, auth/session code, logging, error handling, a dependency, or
  file/URL handling must be checked against it before the task is done.
- A security row is ticked only when its requirement holds in the code AND
  its "Enforced by" is in place (a test whose title names the SEC code, a
  hook, or a dated review note). Rows marked `n/a-yet` can't be ticked until
  the code they guard exists.
- Never weaken, reword or delete a row to make a change pass. If a row blocks
  the work, stop and ask (Section 1) — don't route around it.
- A security decision `security.md` marks OPEN (the remaining details of two-factor
  login, token lifetimes, RLS) is logged in `open-questions.md` and not built
  until a human answers it.
- Nothing automated checks `security.md` yet (checklist-only so far); the
  rows that say `test` are intended to get tests, and until they do they rely
  on review.

## 10. SEO-GATE (discussion gate)

> Any change that affects titles, meta descriptions, headings, image alt text
> or file names, keywords, structured data, URLs or slugs, canonical or robots
> rules, the sitemap, or snapshot templates is discussion-gated. The agent may
> build the mechanical plumbing (templates, generators, tests), but every
> wording rule or formula stays marked `(DISCUSS)` in `specs.md`. The agent
> must **stop and ask the human** before finalizing it, and the checkbox
> cannot be ticked until the human signs off by removing the tag.

The SEO rows are FR-82 to FR-82d. Section 1's `(DISCUSS)` rule and the
checkbox test enforce the "cannot be ticked" half of this.

## 11. Scale-program rules (in force from the moment the code is written)

None of the code below exists yet; these are stated now so the first
implementation follows them (`specs.md` sections 14–20).

- `lib/queue.js` owns the queue tables (jobs, archive, dead-letter, outbox,
  webhook inbox, effects log) and may hold its own `pg` connection — a direct one if the verified queue library needs a persistent session (e.g. for `LISTEN/NOTIFY`), per FR-79c and FR-77f. This is the one named exception to
  "`db.service.js` is the only file that imports `pg`" and to
  one-table-one-owner, and only for those tables. Nothing else touches them.
- Private, money and auth routes send `Cache-Control: private, no-store`;
  public routes never set cookies (FR-73c, FR-73d).
- Migrations are backward compatible (expand → switch → contract), linted, and
  run as a separate deploy step — never at web startup (FR-79b).
  `db/migrate.js` stays until the versioned runner replaces it.
- Concurrency-sensitive code (the atomic reservation, accept races, worker
  claims, webhook de-duplication, expiry-vs-payment races) needs
  **real-Postgres integration tests**; mocked-database tests don't count for it.
- Queued-job handlers are idempotent and re-read state with a row lock before
  acting (FR-77a, FR-77b).

## 12. Engineering conventions (working decisions by delegation, 2026-10-16)

You asked for whatever is most efficient, fast and light on your system without
changing the base strategies or the stack; these follow from that and can be
reversed by telling me. None of them changes the stack (Express 5 is still plain
Express) or a strategy.

- **Dependencies — library-first for solved problems:** queue, migrations,
  JWT / passkeys / TOTP / password hashing, validation, security headers and rate
  limits, image processing, and logging with redaction. Never hand-roll crypto or
  webhook-signature verification. One library per need; exact versions pinned
  (lockfile committed); add each to `agent.md` with why and the Node version it
  needs; `npm audit --omit=dev` stays clean. Prefer small, maintained libraries;
  run CPU-heavy native ones (argon2, sharp) in the worker or a small pool.
- **Data access — plain `pg` and SQL stay the strategy.** `db.one()` returns the
  first row or `null`, `db.many()` returns the rows, `db.query()` and
  `db.withTransaction()` as before; `NotFoundError` is thrown at the call site so
  it names the entity. New or touched code uses the helpers; don't bulk-convert
  untouched modules (their mocked tests would need rewriting, and the COD-shaped
  modules are being replaced anyway). No query builder, no ORM.
- **Load conventions:** explicit column lists, no `SELECT *` on hot paths
  (also SEC-29); no N+1 — batch with joins or `= ANY($1)`; keyset pagination with
  a hard page-size cap for listings, search and admin queues; one round trip where
  possible (`RETURNING`, CTEs); short transactions with no external call (gateway,
  email) inside; every hot-path query backed by an index and checked with
  `EXPLAIN` on real Postgres; anything not needed to answer the request goes on
  the queue.
