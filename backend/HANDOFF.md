# HANDOFF.md — Poshaak: state, approved decisions, open questions, next actions

Written 2026-10-17 for the agent that continues this project. Longer resume
instructions: `DEVELOPMENT_HANDOFF.md`. Full state and architecture:
`MASTER_PROJECT_CONTEXT.md`. Poshaak is the single name of the project (it was
first called "Marketplace").

## 0. Inspect before you propose anything

1. Extract the ZIP. In `backend/` run `npm install`, then `npm test` — expect
   **192 tests in 12 suites, all passing** — and `npm audit --omit=dev` — expect 0.
2. Read, in order: this file, `DEVELOPMENT_HANDOFF.md`, `MASTER_PROJECT_CONTEXT.md`,
   `agent.md`, `rules.md`, `Phases.md`, `security.md`, `specs.md`, `open-questions.md`.
3. Compare what you find with section 1 below and tell the human about any
   difference **before** proposing changes. Do not change application code (`src/`,
   `db/`, `hooks/`, `test/`) unless a change is necessary and you can justify it.
4. Follow `rules.md`: stop and ask on `(OPEN)`/`(DISCUSS)` rows and real ambiguity,
   log them in `open-questions.md`; SEO work is discussion-gated; the human's
   latest decision wins over any recommendation.

## 1. Project state

- The code is a **COD-era Express scaffold** (Express 5, plain `pg`, 13 service modules,
  Jest). Every test mocks the database; nothing has run against a real Postgres.
  Auth is a stub. No escrow, queue, worker, Redis, 2FA, media or search code exists.
- **Phase 0 has not started.** `specs.md` has 183 FR rows, **0 ticked**; of
  them 11 are tagged OPEN, 29 DISCUSS (proposals awaiting the human),
  11 DEFERRED and 7 SUPERSEDED. `security.md` has 38 rows, none ticked.
- This round changed documents only. No implementation or testing was marked complete.

## 2. Decisions approved on 2026-10-17 (recorded in the files named)

- **FR-83d, buyer email codes:** six digits; five-minute expiry; single use; only a
  hash stored; **at most 3 verification attempts per code**; resend cooldown and
  email-sending caps (values still to be set); identical responses whether or not the
  account exists.
- **FR-84a, token lifetimes (configurable defaults):** access token 15 minutes, in
  memory; buyer refresh token 30-day absolute and 7-day inactivity; staff refresh
  token 8-hour absolute and 30-minute inactivity; rotate after every successful
  refresh; reuse of an old refresh token revokes its family and requires sign-in;
  enforced server-side. Refresh-cookie design and CSRF scope: FR-84 (httpOnly,
  Secure, SameSite=Strict, refresh endpoint only; second factor at sign-in only).
- **FR-83h, Phase 0 two-factor scope:** email code for buyers, authenticator app for
  admins and moderators, passkeys later.
- **FR-77f / FR-79c, queue:** verify the library against the actual PostgreSQL and
  PgBouncer configuration before committing (claiming, concurrent workers,
  transactions, retries, pooling); direct worker connections only if the library needs
  them; if incompatible, choose a compatible architecture; a transactional outbox or
  equivalent keeps an order and its job consistent; jobs are retryable and
  duplicate-safe.
- **FR-79h, hosting:** Render for initial hosting; PostgreSQL hosting, Redis, CDN,
  storage and connection configuration are chosen later; verify backups, secrets,
  security settings, database limits, monitoring and recovery before deployment.
- **FR-83e / FR-83a, email:** Nodemailer as the common sending interface where
  appropriate (it is the interface, not the provider); providers behind an adapter;
  HTTPS-API-compatible delivery preferred for the initial Render deployment; a
  secondary provider as fallback with failover implemented and tested before
  production; providers selected before the first real login.
- Earlier decisions (escrow, scale program, SEC list, rules): `MASTER_PROJECT_CONTEXT.md`.

## 3. Still open, with deadlines (full list: `open-questions.md`)

| Question | Deadline |
|---|---|
| Resend-cooldown and email-sending-cap values (FR-83d) | when the Phase 0c login is built |
| Queue library verification against PostgreSQL + PgBouncer (FR-77f) | before a library is committed (start of Phase 0b) |
| SEC-07: per-request status check, or accept up to 15 minutes for a suspended user | before Phase 0c |
| Remaining email proposals (FR-83i, FR-83j); choose email provider(s) | before the first real login |
| PostgreSQL hosting, Redis, CDN, storage, connection configuration; the Render pre-deployment checks; database plan vs the FR-79 targets | before the first deployment |
| Account recovery; key management for encrypted fields; confirm FR-83b/83c/83f | Phase 1 |
| Returns, refunds, disputes (incl. lost parcel, FR-72e, FR-45g), policies | deferred by the human to a later discussion |

## 4. Checks completed in this round

- Every FR and SEC code cited in the nine documents exists (script): **passed**.
- Search for outdated or conflicting values (old attempt count, old lifetimes, old
  queue/PgBouncer wording, old hosting/email blocker wording): found and fixed two stale
  sentences; **no remaining conflicts found** by the searches.
- Queue strategy, refresh-token rules and email architecture agree across the relevant
  files (checked by search): **passed**.
- `npm test`: **192 passed, 0 failed, 12 suites**. `npm audit --omit=dev`: 0 vulnerabilities.
- Two Render facts were checked against Render's own pages on 2026-10-17: free web
  services block outbound SMTP ports; free PostgreSQL has no recovery capability.

**Not run:** any test against a real Postgres or PgBouncer (none exist yet); the queue
library compatibility check; any provider or deployment verification; the git hooks
(not touched this round); the application against Render itself.

## 5. Immediate next actions

1. Inspect (section 0) and report any difference to the human.
2. Get the human's choice on the SEC-07 question and the cooldown/cap values.
3. Start Phase 0a: the real-Postgres test setup (`embedded-postgres`, verified on Linux
   only), the migration runner, and the four schema/code mismatches in `agent.md`.
4. At the start of Phase 0b, run the queue-library check (FR-77f) before choosing.

## 6. Continuation prompt

> Continue Poshaak from `HANDOFF.md` in the attached ZIP. First inspect the files: run
> `npm install && npm test` in `backend/` (expect 192 tests in 12 suites), read the
> documents in the order `HANDOFF.md` lists, and tell me any difference from its section 1.
> Do not change application code or propose changes until I confirm. Follow `rules.md`
> (stop and ask on OPEN/DISCUSS rows; SEO is discussion-gated). Then ask me for the two
> open Phase 0 answers (SEC-07 and the cooldown/cap values) and start Phase 0a.

## 7. Package contents and exclusions

The whole project under `backend/` (documents, `src/`, `db/`, `hooks/`, `test/`,
`package.json` and lockfile). Excluded: `node_modules/`, any `.env`, credentials, keys,
tokens, private user data. `.env.example` contains placeholders only.

## 8. Working model (added 2026-10-18)

You decide; a Claude conversation (another account, with access to the repo) plans,
discusses and reviews; the Codex agent in your editor implements. `AGENTS.md` is read
by Codex automatically; `WORKFLOW.md` describes the loop, who edits which files, a
task-prompt template, a ready first task for Phase 0a and the review checklist. The
repo documents are the only memory shared between the two Claude accounts — keep them
current. Receiving Claude: write the next task prompt from `Phases.md`, then review what
Codex pushes against `WORKFLOW.md`.
