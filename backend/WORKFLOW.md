# WORKFLOW.md — who does what: you, the Claude window, Codex

Written 2026-10-18 for this working model: you decide; a Claude conversation (another
account, with access to the repo) plans, discusses and reviews; the Codex agent in your
editor implements. Items marked *(proposed)* need your confirmation.

## Roles
- **You:** decide, relay between the two agents, merge.
- **Claude window:** picks the next slice from `Phases.md`, discusses the choices with
  you, writes the task prompt, reviews what Codex pushed against `rules.md`, `specs.md`
  and `security.md`, and keeps the decision documents current. It cannot run your code —
  it reviews the diff and the report, so ask Codex for command output.
- **Codex:** implements only. It reads `AGENTS.md` automatically (Codex loads
  `AGENTS.md` before any task, scanning from the Git root down to the working folder),
  so that file must stay at the repo root.

## The loop (one task at a time)
1. Claude window chooses the next slice: current phase, untagged rows only. Any decision
   it needs is made with you first and **recorded in the documents** before the task.
2. It writes a task prompt (template below). You paste it into Codex.
3. Codex works on a branch *(proposed)*, commits in small steps (hooks run), runs the
   tests, pushes, and ends with the report that `AGENTS.md` requires.
4. Claude window reviews the diff and report with the checklist below: "approve" or a
   fix list. The fix list becomes the next prompt.
5. You merge. The "Current phase" line in `Phases.md` and `open-questions.md` are updated.
6. When Codex asks something or logs it in `open-questions.md`: you discuss it with the
   Claude window, the answer is written into the documents, and only then does Codex
   continue. Never let Codex proceed on an unrecorded answer.

## Who edits what
| Files | Codex | Claude window |
|---|---|---|
| Code, tests, migrations | yes | review only |
| `specs.md` checkboxes | tick only with a named test | no |
| Decisions: `specs.md` rows and tags, `security.md`, `Phases.md`, Resolved in `open-questions.md` | no | yes |
| Open entries in `open-questions.md` | add | add / close |
| Known gaps in `agent.md` | add | review |

If the Claude window can only **read** the repo, it gives you the exact text and Codex
applies it in a docs-only task.

## Task prompt template
```
Task: <Phase and step>. Branch: <name>.
Read HANDOFF.md, agent.md, rules.md, then Phases.md (<phase>).
Do only this: <numbered steps, each tied to FR/SEC codes that have no tag>.
Out of scope: <what not to start>.
Stop and ask if: <known open points that touch this task>.
Finish with the report from AGENTS.md.
```

## Example — first task, Phase 0a (adapt before use)
```
Task: Phase 0a, step 1 — real-Postgres test setup. Branch: phase0a-real-postgres.
Read HANDOFF.md, agent.md, rules.md, then Phases.md (Phase 0a).
Do only this:
1. Add embedded-postgres as a devDependency and a Jest setup that starts a throwaway
   PostgreSQL, applies schema.sql, exposes the connection string to the tests and stops
   it afterwards. If it cannot start on this machine, stop and report the exact error.
2. Write one integration test per module in src/modules/ that runs its main queries
   against that real database. Start with the four known mismatches in agent.md
   (payout_details, the payout method values, listing_images.url,
   listing_evidence.url): run those first and report which fail and why.
3. Fix the code to match schema.sql (the schema is the source of truth). If a fix needs
   a product decision, stop and ask.
Out of scope: the queue, auth, hardening, any Phase 0b/0c work, any frontend work.
Do not tick a specs.md row unless it has a named test.
Finish with the report from AGENTS.md.
```

## Review checklist (Claude window)
- Scope: only the task's rows; no drive-by changes; nothing outside the task's files.
- No `(OPEN)`, `(DISCUSS)` or `(SUPERSEDED)` row built; no decision invented.
- `npm test` output shown and green; new behavior has real tests; every ticked row has a
  test whose title names the FR and asserts the spec sentence; no test weakened.
- `rules.md` respected: ownership, no cycles, typed errors, route-layer permissions, FR
  comments, real-Postgres tests for concurrency.
- No secrets, no unexplained dependency (each is in `agent.md` with a reason), audit clean.
- Documents updated in the same change; commit messages in the required format; no
  `--no-verify` in the history.
- The report is complete, including what was not run.

## Limits of this model — know them
- Nothing can *force* Codex to stop and ask. The controls are `AGENTS.md`, the tests, the
  hooks (local only; `--no-verify` skips them) and your review loop. **Recommended:** a CI
  run of `npm test` and `npm audit --omit=dev` on every push and pull request (for
  example GitHub Actions), which does not depend on local hooks. It is not in the repo
  yet; `Phases.md` lists CI under Phase 0c and it can be pulled forward to the first task.
- Memory is per account: the second Claude window sees none of the first account's notes.
  **The repo documents are the shared memory — keep them current.**
- `.gitattributes` forces LF line endings so the hook scripts keep working on Windows.
- `embedded-postgres` was verified on Linux only; the first task tests it on your machine.
- Branch per task, merged after review *(proposed)*; the frontend lives in a `frontend/`
  folder of the same repo, the repo root staying as it is *(proposed)*.
