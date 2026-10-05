# SLICE_IMPLEMENTATION_GUIDE.md

A personal workflow guide for executing IMS slices from specification to verified implementation. It explains the process; the rules agents must follow live in `AGENTS.md` and are not repeated here.

## 1. Purpose

IMS is built in capability slices so each unit of work is small enough to implement, test, and verify in one focused session, while the design survives between sessions.

```text
Slice      = persistent capability context
Chat       = execution session
Repository = implementation state
```

A chat has no memory of earlier chats. Everything it needs about *what to build* is in the slice; everything about *how to work* is in `AGENTS.md`; everything about *where the project is* is in `PROJECT_STATUS.md` and the repository.

## 2. Inputs

Normal implementation chat inputs:

```text
SLICE-XX.md
AGENTS.md
PROJECT_STATUS.md
GitHub repository
```

The master design documents (PRD, Domain Model, DB schema, API, Index) are used when **generating or revising slices**, not when implementing them. If you change the design, regenerate the affected slice(s) first, then implement.

## 3. Slice Readiness

A slice is ready when:

- Every slice it depends on is `COMPLETE` in `PROJECT_STATUS.md` (or the slice's Dependencies section says the minimum contract may be created inside it).
- It has no unresolved "supplied by the project owner" input that you have not provided yet. Check the slice's Implementation Constraints and the "Blockers" list in `PROJECT_STATUS.md`.
- The repository checks you expect to be green are green, or the known failures are listed in `PROJECT_STATUS.md`.

## 4. Fresh Claude Chat

Start a new chat per slice (or per clearly separated half of a large slice). Attach/provide: the slice, `AGENTS.md`, `PROJECT_STATUS.md`, and repository access. Suggested opening message:

> Implement SLICE-XX. Follow AGENTS.md. Inspect the repository first and tell me your plan before changing files. Stop and ask if you hit a blocker.

Do not paste other slices or the master design documents.

## 5. Repository Inspection

Before planning, the agent inspects: module structure and public `index.ts` interfaces; the nearest existing implementation of a similar pattern; error classes and middleware; the Prisma schema and migrations; test layout and helpers; scripts and configs; and the current check results. Ask the agent to summarize what it found and what is missing relative to the slice. Disagreement between docs and code is resolved per `AGENTS.md` §2.

## 6. Implementation

General flow (reorder where it does not apply):

1. Inspect → 2. understand current state → 3. plan (short, reviewed by you) → 4. implement → 5. add migration where required → 6. write/run tests → 7. debug → 8. verify against the slice's Completion Criteria → 9. report and update status.

Prefer vertical increments that stay green (e.g. schema/migration + repository + service + controller + tests for one endpoint), rather than a prescribed layer order.

## 7. Scope Control

Allowed: everything the slice lists In Scope; the minimum dependency contract the slice describes; tests; a migration for what the slice owns.

Not allowed: future slices, unrelated refactors, changing finalized contracts, extra endpoints/fields.

Cross-slice dependency missing → build only the minimal contract the Dependencies section specifies and report it. Do not "complete" the other slice. Existing-code conflict (the repo already does something differently) → keep the slice's required behavior, adapt to the repo's patterns, and report the conflict; if it needs a design decision, stop (`AGENTS.md` §13).

## 8. Database / Migration Procedure

1. Edit `prisma/schema.prisma` only when the slice requires a schema change (the current schema is final; most slices need none).
2. Generate a migration against a local database using `DIRECT_URL`; never edit an applied migration.
3. Open the generated SQL and review it: constraints, indexes, defaults, nullability, destructive statements.
4. Add hand-written SQL for anything Prisma cannot express (partial/lookup indexes, check constraints) in the same migration folder.
5. Apply to an empty database and to a database with the previous migrations; confirm both succeed.
6. Run `prisma generate`; run typecheck and the integration tests that touch the new constraints.

## 9. Testing Procedure

Applicable layers, as the slice requires: unit (pure rules, mappers, validators); integration against real PostgreSQL/Redis (repositories, transactions, locks, workers); API tests with supertest (status codes, envelope, validation, error codes); authorization tests (every role × every gate, cross-team, `teamId = null`); failure tests (dependency down, retry, exhaustion, rollback); concurrency tests (parallel requests with a single winner); idempotency tests (replay, duplicate job). Do not write tests the slice does not need.

## 10. Debugging

Reproduce with the smallest failing test; read the actual error and the executed SQL; form one hypothesis, change one thing, re-run. Never weaken an assertion, loosen a status code, skip a test, or relax a constraint to turn output green. If a requirement itself looks wrong, stop and report it.

## 11. Completion Review

Walk the slice's Completion Criteria one by one with evidence (test names, command output). Re-run typecheck, lint, unit and integration tests, and format check on touched files. Confirm: migrations apply from empty; no unrelated files changed; existing tests still pass; no secrets logged or returned.

## 12. Project Status Update

After completion, update `PROJECT_STATUS.md`: slice status (`COMPLETE` only with evidence), repository-state table with the check results you actually ran, a one-paragraph description of what now exists, new known issues, and the next step. Keep it a snapshot, not a design document.

## 13. Handoff

The next slice starts from the repository the previous slice produced. The next chat reads the updated `PROJECT_STATUS.md` and inspects the code; it does not need the previous chat.

**Suggested order** (derived from the dependency structure; adjust if you prefer): 00 → 01 → 02 → 08 → 06 → 03 → 04 → 05 → 09 → 07 → 10 → 11 → 12. Rationale: 01/02 supply identity and configuration; 08 and 06 supply the outbox and audit functions that 04/05 call inside transactions; 03 precedes 04; 09 consumes events from 04/05; 07 needs 05 and 09; AI slices come last.

## 14. Core Principle

> The repository is the implementation state.
>
> The slice is the capability specification.
>
> `AGENTS.md` is the agent rulebook.
>
> `PROJECT_STATUS.md` is the project-state snapshot.
