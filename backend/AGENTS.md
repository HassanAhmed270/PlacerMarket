# AGENTS.md — instructions for coding agents (Codex)

You are the **implementer** on Poshaak. The human decides; a separate Claude
conversation plans, discusses and reviews. Your job is to build exactly what the
specification already says, using the harness in this repo. Keep this file at the
repo root so it is found.

## Before you write anything
1. Read `HANDOFF.md`, then `agent.md` and `rules.md`. Read `Phases.md` (the
   "Current phase" line) and only that phase's rows in `specs.md`.
2. Run `npm install` and `npm test` (192 tests in 12 suites at the time of
   writing). Once per clone: `npm run hooks:install`.
3. Build only `specs.md` rows with **no tag**. Rows tagged `(OPEN)`, `(DISCUSS)` or
   `(SUPERSEDED)` are not yours to build; `(DEFERRED)` is out of scope.

## You never decide
- If the spec doesn't answer something, or a row is tagged OPEN/DISCUSS: **stop that
  work.** Ask the human in the chat. If you cannot, add an entry to
  `open-questions.md` (date, FR code, what is blocked, why) and continue only with
  unrelated work. Do not guess, and do not add a guard and carry on.
- Do not change decisions in `specs.md`, `security.md`, `Phases.md` or the Resolved
  section of `open-questions.md`. Your only document edits: tick a checkbox (rules
  below), add known gaps to `agent.md`, log questions in `open-questions.md`.
- SEO wording (titles, meta, alt text, structured data, URLs, canonicals, sitemap,
  snapshot templates) is discussion-gated (`rules.md` Section 10).

## How you work
- Plain JavaScript, Express 5, plain `pg`. No TypeScript, ORM or query builder. No new
  dependency unless the task says so; if one is needed, follow `rules.md` Section 12
  (one per need, pinned, listed in `agent.md`).
- Small steps: one FR (or a tight group) per commit. Message format
  `FR-xx: description`, `chore: ...` or `docs: ...` (the hooks enforce it). Never use
  `--no-verify`.
- Tick a `specs.md` checkbox only with code **and** a Jest test whose title names the FR
  and asserts the spec sentence, with `npm test` green. Never weaken or delete a test.
- Follow `rules.md`: one owner per table, no circular requires, typed errors,
  permission checks at the route, an FR comment above every exported service function,
  real-Postgres tests for concurrency-sensitive code.
- Never commit secrets, `.env`, `node_modules` or personal data. No real credentials in
  code or tests.
- Stay inside the task. No drive-by refactors, no unrelated files.

## Credential-dependent features
- Put email, challenge, and other credential-backed integrations behind a small
  adapter interface. Supply a fake only for local/tests, and require an explicit
  opt-in flag to use it; production startup must refuse missing credentials,
  placeholders, or fake-adapter selection.
- Keep live provider configuration and account-specific checks in `LIVE_CHECKS.md`.
  Tests using fakes do not prove live delivery, provider failover, challenge quality,
  or production credential validity. Never log secrets, codes, tokens, hashes, or
  connection strings.

## Definition of done
`npm test` green; `npm audit --omit=dev` clean; every row you ticked has a named test;
documents you must update are updated in the same commit; nothing tagged OPEN or
DISCUSS was built.

## Always finish with this report
1. What you changed (files). 2. Rows ticked and the tests that justify them.
3. Commands you ran and their results — say plainly what you did **not** run.
4. Questions you logged or need answered. 5. Anything you did differently from the task,
and why.
