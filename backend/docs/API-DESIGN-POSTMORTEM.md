# API-DESIGN-POSTMORTEM.md

**Scope:** why `API.md` needed about eight rounds of clarification, and what to change next time.
**Evidence used:** `PRD.md`, `Architecture.md`, `Domain_Model.md`, `DB_Schema.md`, the original template `API.md`, `API_Contract.md`, the seven question files (72 numbered questions), the closing list of eight gaps (G-1 to G-8), and the final `API.md`.
**Not available:** `INDEX-00.md` and `MBP API.md` were not in this session. I read the PRD sections on business rules, state machines, authorization, security, failure handling, resolved decisions, open questions and two use cases; I did not read every section.
**Caveat:** I cannot tell which of your documents were written by AI and which by you. Where I say "AI-generated", I mean the contract, which you described yourself as "an inferred doc".

---

## 1. Executive Summary

The repeated questions were **mostly not caused by a lack of understanding**. Your PRD is detailed, and most of your answers show you understood the system well.

They were caused by three things working together:

1. **The design stopped at "what" and the API forced "exactly how".** Rules for authorization, error handling, login sessions, the postmortem lifecycle and the escalation policy were missing or conflicting in the PRD, Domain Model and DB schema. The API was the first place anyone had to decide them.
2. **No single place held decisions.** Answers lived in question files, chat messages and a growing "settled" list. When two answers disagreed, nothing told us which one won.
3. **Answers were often about the example, not the rule.** "Unassign sets status to OPEN" was answered for one endpoint, without saying how it relates to "assignment is independent of lifecycle". The conflict came back two rounds later.

Rough picture of the 72 questions (my impression, not a measured count): roughly half were rules that no upstream document defined; roughly a quarter were conflicts between documents or between your own earlier and later answers; the rest were confirmations of drafts or side effects of earlier decisions.

The main weakness the evidence shows is **closing the loop from a rule to every place it applies** (DB, authorization, events, errors, API). It does not show a weakness in understanding requirements.

---

## 2. What Actually Went Wrong

The sequence was:

```text
PRD + Domain Model + DB schema + Architecture
        → AI writes API_Contract.md (an inference, with its own defaults)
        → template API.md says something different
        → API generation prompt: "stop and ask on any ambiguity"
        → Round 1: 15 questions  (many about the contract's own guesses)
        → each answer creates new consequences
        → Rounds 2–7: 57 more questions
        → Round 8: eight remaining gaps
```

The prompt did its job: it refused to let the agent guess. But that turned the API step into the **first real design review**. Whatever was undecided upstream surfaced there, one layer at a time.

Four things made it longer:

- **The contract was a poor middle layer.** You told us in round 1 that the contract "is an inferred doc, with many assumptions built on top of design docs that need to be corrected" and that the template was right on paths and endpoint count. The final `API.md` overrides the contract in roughly twenty places (base path, auth, 422, no DELETE, escalation policy, pagination, error codes, field limits…). Much of round 1 was spent un-deciding the contract's defaults.
- **Decisions changed inside answers to unrelated questions.** Three examples are in section 4.
- **The schema moved while the API was being designed.** You updated `DB_Schema.md` between rounds (team and service `status`, nullable `User.teamId`, new audit event types `REASSIGNED` and `OPEN`).
- **Some answers were blank, contradictory, or a one-word "Yes" to a multi-part question.** Each left the question open and it came back (details in section 4).

---

## 3. Root Causes

Grouped by underlying cause, not by wording. "Rounds" = how many of the seven question files it appeared in.

| # | Root cause | Rounds | Mainly a… |
|---|---|---|---|
| 1 | Postmortem and close lifecycle never defined (PRD left it open; Domain and DB disagree) | 7 | Design gap + document conflict |
| 2 | Assignment / acknowledge / unassign: state changes and audit events never enumerated | 7 | Design gap |
| 3 | No error and status-code taxonomy | 7 | Design gap |
| 4 | Escalation policy modelled three different ways | 6 | Document conflict |
| 5 | Authentication and session design absent from PRD and Architecture | 6 | Design gap |
| 6 | Authorization defined by role only, not by relationship (assignee, "escalation chain", no team) | 5 | Design gap |
| 7 | Deactivation and team/user lifecycle rules missing; DB constraints disagree with them | 5 | Design gap + DB/API mismatch |
| 8 | Single `PATCH` + body-shape contract invented late; DTO and naming conventions | 5 | Process (decided late) |
| 9 | Webhook, replay and rate-limit details | 4 | Genuine detail + design gap |
| 10 | List and pagination conventions | 4 | Process (no conventions page) |

### Root cause 1: postmortem and close lifecycle

- **What was missing:** how an incident closes when AI generation fails. PRD BR-014 and BR-072 say "or the defined manual review path", and OQ-008 asks what that path is. It was never answered.
- **Which document should have defined it:** the PRD, with the Domain Model carrying the states.
- **Why it caused later questions:** the Domain Model has one lifecycle, `GENERATING -> DRAFT -> REVIEWED`. The DB has `reviewStatus` (`PENDING/REJECTED/REVIEWED`) and no generation status or failure state, although PRD BR-013 and BR-071 require failure and retry. The API had to invent `generationStatus` and the manual path.
- **Why the first answer did not close it:** the questions kept hitting new corners. Your round-5 answer said both statuses after manual creation were "GENERATING and DRAFT", which are two values of one column. In round 6 you wrote that approving atomically closes the incident, which made the close endpoint unreachable. That became round 7.
- **What should have been done earlier:** answer OQ-008, and write one state table covering both generation and review.

### Root cause 2: assignment, acknowledge, unassign

- **What was missing:** for each action, the new status, the new assignee and the audit events written. PRD BR-009 says "every transition produces an event" but not which.
- **Why it recurred:** the DB audit event list was fixed first. The mapping from action to event was invented later and kept changing (rounds 1, 2, 3, 4, 5, 6, 7).
- **Why the first answer did not hold:** PRD says "assignment is independent of acknowledgement" and "lifecycle state unchanged" (UC-005). In round 5 you edited the unassign body to include `status: "OPEN"`, which contradicts that and your own round-4 table. In round 6 you answered both options.

### Root cause 3: no error taxonomy

- **What was missing:** a rule for what 400, 403, 404, 409 and 422 mean. The PRD only says "403/404" (BR-004) and "409" (BR-014).
- **Evidence:** `INVALID_ACTION` was first set to 400, then 403, then you wrote 409 in round 6, and round 7 had to pick one. Your pasted round-2 error table and your round-2 status table disagreed on three codes (round 3).
- **Why it recurred:** each case was decided on its own, so no general rule existed to check the next case against.

### Root cause 4: escalation policy

- **Domain Model:** `Service -> Escalation Policy 1..4`, `UNIQUE(service_id, severity)`.
- **DB:** one policy row (`level1..3`, `fallbackAdmin`) with a `NOT NULL` link from the service, no severity.
- **Template API:** `POST /:serviceId/escalation-policies` with a maximum-policies error.
- **Result:** a policy had to exist before the service, but its route needed the service. Asked in rounds 2, 3, 4, 5 and 6. The final answer (policy created inline; the create-policy endpoint always returns 409) works, but it is an artifact of the three-way disagreement.

### Root cause 5: authentication and sessions

- The PRD says only "appropriate session/token handling". Architecture says Identity owns authentication, and nothing more.
- The template added refresh tokens and a cookie; the contract said no refresh. Then, one piece per round: tokens and lifetimes (round 1), session table (2), claims (3), team claim (4), cookie path and logout (5), final claims (6).
- **A decision without its consequence:** "trust the JWT until it expires" meant the guard has no team, which every incident endpoint needs. That became round 4.

### Root cause 6: authorization by relationship

- PRD §11 is role × action. It does not cover "assigned incident", "no team", or a chain of responders.
- In round 2 an answer introduced "anyone in escalation chain". It was defined in round 4 and applied to more endpoints in round 5. Approve became chain-only, which contradicts the PRD matrix ("Review/approve postmortem: Yes / Yes / Yes").
- The PRD also has a small conflict of its own: the transition table says resolve is by the "Assigned Engineer", while the matrix says "Resolve assigned incidents: Yes / Yes / Yes". You later decided Team Lead and Admin can resolve any incident.

### Root cause 7: lifecycle rules versus the database

- **Composite foreign key** `(affectedServiceId, teamId)` blocks changing a service's `teamId` once any incident exists (found in round 3).
- **Team deactivation** was decided to null the users' `teamId`, but `AppService.teamId` is `NOT NULL`.
- **PRD says** every user belongs to exactly one team (BR-003); the DB made `teamId` nullable and the Domain diagram says `0..1`.
- **ADR-011** says uniqueness is enforced in the database, but the domain rule is "at most one *unresolved* incident per alert identity". A plain unique index cannot express that, so recurrence after RESOLVED needed a schema change.

### Root causes 8–10 (short)

- **8:** collapsing eight incident actions into one `PATCH` (round 3) created the need for body shapes, which took rounds 4 and 5.
- **9:** the replay mechanism, severity mapping and rate-limit ladders had no PRD detail beyond "per authenticated source". Part of this is genuinely detail you could leave to implementation.
- **10:** list conventions (offset versus cursor, defaults, ordering) were never written once. You answered "Yes" to "allowed `orderBy` values per list" and the final table took two rounds.

---

## 4. Examples From This Project

**A. Decisions that changed inside unrelated answers**

- Round 3: collapsing acknowledge, severity, assign, resolve and comment into `PATCH /incidents/:id`. It produced round 4's body questions and round 5's confirmations.
- Round 5: adding `status: "OPEN"` to the unassign body. It reopened what round 4 had settled.
- Round 6: "if a postmortem is marked reviewed, then atomically the incident is updated to CLOSED". One sentence, no flag that it replaced the close endpoint.

**B. Answers that left the issue open**

- Round 6, unassign: answered both "A" and "B" with "Yes".
- Blank answers: round 2 (event for unassign), round 4 (error for `leadId` on an Admin), round 7 (what approve returns).
- "Use standard values" for rate-limit ladders (round 3).
- Round 5: you pasted back a table that still contained "RESOLVED, CLOSED?" in a cell. It surfaced again in round 6.

**C. A specific answer with no general rule**

- You answered "403 INVALID_ACTION" for several different situations, then 409 for another. There was never a sentence saying what `INVALID_ACTION` means.
- "Anyone in escalation chain" was used for severity, close, approve and manual postmortem without saying what the chain is until asked.

**D. A term meaning two things (never asked)**

- Architecture says assignment "goes through a worker, not inline". The API treats assignment as a synchronous `PATCH`. Nobody asked whether "assignment" there means automatic assignment, manual assignment, or both. This is the kind of mismatch that will surface during implementation.

**E. Genuine complexity (cannot be removed)**

- Concurrency (two people acknowledging at once) and replay versus duplicate for webhooks have real corner cases. Even a perfect design needs some questions about them. These were not the problem.

---

## 5. Was the Main Problem Understanding, Communication, Design, AI, or Process?

| Cause | Weight | Reason |
|---|---|---|
| **Process / workflow** | Largest | Decisions were made late, in answers, with no register and no consistency check. |
| **Incomplete design before the API** | Large | State transitions, event catalogue, error rules, auth and authorization were not complete in any one document. |
| **Communication** | Medium | Example-level answers, blanks, contradictory answers, one-word "Yes" replies. |
| **AI-generated material** | Medium | The contract introduced its own defaults that you then overruled; question drafts embedded AI guesses that you accepted. |
| **Understanding of requirements** | Small | The PRD is detailed and your corrections were mostly right. |
| **Genuine complexity** | Small | Concurrency and webhook replay. |

**On the AI side, honestly:** the questions were reasonable, because the source documents did not answer them. But the process had weaknesses I share responsibility for. It had no persistent decision file, so "settled" lists lived only in chat. Drafts for you to "confirm" carried guesses that a quick "Yes" turned into decisions. And I surfaced contradictions between your answers one round at a time instead of stopping to build the register first.

---

## 6. What I Should Change

**What the evidence says about your design ability.** The evidence supports these conclusions:

- **Strong:** product-level requirements; separating acknowledge from assign; async AI as advisory; outbox, idempotency and atomic audit as principles; decisive answers.
- **Weak, repeatedly:** tracing a decision to everything it touches. Examples: trusting the JWT without noticing the team gate needs a claim; atomic close on approve without noticing close became dead; unassign resetting status without checking the PRD rule.
- **Also visible:** DB schema designed before the behaviours it must support, and answers given from memory instead of from a written rule.
- **Not shown:** the evidence does not support a conclusion about your ability to implement, test, or reason about concurrency in code. It covers the design process only.

Four habits to change:

1. **Write rules, not examples.** Every answer should be a sentence you could paste into a rule book: "Unassign: always sets status OPEN, clears acknowledger; unassigned+OPEN is a no-op."
2. **When an answer changes an earlier decision, say so.** "This replaces R4-03 case 4."
3. **Never reply "Yes" to a multi-part question.** Answer each part.
4. **Read every cell of a table you are confirming.** Do not paste it back.

---

## 7. A Better Design Workflow

```text
Requirements (PRD)
   → 1. Rules and invariants
   → 2. Decision register (single authority)
   → 3. Conventions page
   → 4. Consistency check
   → 5. API contract, one slice at a time
   → 6. Implementation slices
```

### Step 1 – Rules and invariants: one "command card" per state-changing action

```text
Command:            e.g. unassign incident
Who:                role + relation (assignee? chain? same team?)
From states:        which statuses allowed
Changes:            every column that changes
Events written:     type + details, in order
Async work:         notifications, jobs
Failure → response: each failure with HTTP status + code
Idempotency:        what a retry does
Atomicity:          what commits together
```

One table for each entity's states (including failure states, e.g. generation FAILED), and one event catalogue (transition → events).

### Step 2 – Decision register: `DECISIONS.md`

One line per decision: ID, the general rule, scope, source, "supersedes". Every answer in a clarification round gets entered. The API generator reads it first. If a PRD, schema or contract line disagrees, the register wins and the other document is updated.

### Step 3 – Conventions page (written once)

Error taxonomy (what each status means), auth and session model with token claims, pagination (when offset, when cursor, defaults, limits), headers and envelope, naming, time, idempotency approach, rate-limit approach.

### Step 4 – Consistency check (AI can do the first pass)

Compare PRD, Domain Model and DB schema on: entities, enums and states, cardinalities, nullability, unique constraints, foreign keys. Output a list of conflicts, then decide each once in the register. This project's examples: escalation policy (three models), postmortem states, `User.teamId` nullability, alert uniqueness, `AppService.teamId`.

### Step 5 – Generate the API one slice at a time

Auth → identity → services → incident lifecycle → postmortem → webhook and investigations. A question is allowed only for something genuinely new, and the answer goes straight into the register.

### Step 6 – Implementation slices

Implement against the frozen slice.

### What to freeze before API generation, and what can stay open

| Freeze first | Safe to leave to implementation |
|---|---|
| State machines including failure states | Retry backoff constants and queue names |
| Command cards and the event catalogue | Index choices and DB pool sizes |
| Authorization by role **and** relationship | Exact message text and Zod messages |
| Error taxonomy | Cursor encoding |
| Auth and session model including claims | Ladder memory and final-block duration (you already left these open) |
| Deactivation and lifecycle rules for users, teams, services | Log format |
| Pagination and list conventions | Which worker process runs a job |
| DB constraints that must match the rules | Tie-breaker details |
| Idempotency and async result per endpoint | |

---

## 8. Final Takeaway

The eight rounds were not mainly a sign that your requirements were weak. They were the cost of leaving rules undecided and then deciding them one endpoint at a time, with nowhere to record the general rule.

What to learn:

1. **The API step is a decision-forcing step.** If questions keep coming, an upstream document is incomplete. Fix that document, not the API.
2. **Decide the rule, then the example.** The first time you answer a specific case, ask "what is the general rule?" and write that.
3. **Every decision touches several places.** Check DB, authorization, events and errors before you answer.
4. **Keep one register and let it win.** Document hierarchy changed several times in this project; a register ends that.
5. **Close the PRD's own open questions first.** OQ-008 (the manual postmortem path) alone fed seven rounds.
6. **Do the cross-document consistency check before generating anything.** Most of the DB-versus-API surprises were findable by comparing three files.
7. **Treat a confirmed draft as a decision.** Read it as carefully as you would write it.
