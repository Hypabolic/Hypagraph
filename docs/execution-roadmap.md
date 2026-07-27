# Hypagraph execution plan and roadmap

- Status: active
- Updated: 2026-07-27
- Current milestone: M6.1 interaction and approval nodes
- Current implementation baseline: `fa95046ce021d8ebd7051bbb439bb2d27661ba22`
- Current published release: `v0.7`
- Capability analysis which added M6A, M6.1, M6.2, M6.3, and M8.1: `docs/graph-capability-review.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This document gives the ordered execution plan for Hypagraph.

The graph describes the work. The deterministic runtime controls execution.

Hypagraph is an execution-control kernel for coding agents. A model can inspect a repository, propose a workflow, perform semantic task work, and diagnose failure. The runtime controls state changes, dependency readiness, checks, gates, loops, evidence, evaluations, budgets, goals, scheduling, replay, executors, workspaces, and integration.

The project completes deterministic domain functions before it adds isolated and concurrent execution. The architecture must still prepare early state and identity contracts for those later functions.

## 2. Version 1.0 result

At version 1.0, Hypagraph must:

1. accept a versioned directed workflow;
2. validate graph structure, node contracts, gates, loops, and goal bindings;
3. execute nodes with an explicit finite-state machine;
4. run deterministic checks;
5. publish typed facts;
6. evaluate routes without model judgement;
7. run bounded iteration regions for refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, and repair;
8. use trusted evaluation contracts when a defensible evaluator exists;
9. pursue durable objectives through workflow-derived Hypagoal state;
10. create bounded child Hypagoals when execution discovers independently owned work;
11. store append-only workflow and family event history;
12. rebuild the same state and decisions from events;
13. show live and historical execution in Pi;
14. dispatch bounded node contracts through executor adapters;
15. isolate mutating attempts in leased worktrees;
16. execute compatible independent work concurrently;
17. keep the domain and runtime independent of Pi and executor transport.

## 3. Mandatory design rules

### 3.1 Use deterministic control

Use a model only when work needs semantic reasoning.

Use deterministic code for:

- validation;
- state changes;
- readiness;
- scheduling;
- gate evaluation;
- loop decisions;
- goal terminal state;
- budgets;
- evidence rules;
- check execution policy;
- executor result validation;
- workspace leases;
- integration policy;
- replay.

### 3.2 Keep definition and runtime state separate

A workflow definition contains:

- nodes;
- dependencies;
- contracts;
- gates;
- loop policies;
- evaluation contracts;
- executor profile references.

Workflow runtime state contains:

- attempts;
- node states;
- facts;
- evidence;
- budgets;
- selected routes;
- loop and evaluation state;
- workflow-local goal state.

Future family runtime state contains:

- root and member goal identities;
- workflow membership;
- parent-child bindings;
- scheduler decisions;
- family budgets;
- child returns;
- executor and workspace coordination state.

Do not embed a complete child workflow definition inside a parent node.

### 3.3 Use one canonical writer

Only the controller can change canonical workflow or family state.

An executor returns a structured result. The controller validates the result before it changes state.

A child Hypagoal does not own a competing controller.

#### Planner output is a work product, not graph authority

Keep these two capabilities separate:

| Capability | Authority | Mechanism |
| --- | --- | --- |
| Planner output changes work products. | Node output. | A node publishes facts, writes a plan artifact, and submits evidence. The graph topology and the contracts do not change. |
| Controller revision changes the executable graph. | Controller only. | A revision can add, remove, or alter nodes, dependencies, contracts, scopes, and loop structure. |

A node must not gain graph-mutation authority because its output is called a plan. A planner node produces a plan artifact and typed facts. It does not re-author the graph.

Repeated planning work is an ordinary bounded iteration region:

```text
planner --> reviewer --> gate
   ^                      |
   |                      |
   +------- feedback ------+
```

The planner updates a plan artifact or publishes revised facts on each iteration. The topology and the contracts stay unchanged. This is available in v0.6.

Re-planning which changes the graph itself is a workflow revision. Today only the single bounded non-weakening automatic revision path provides it, and only for a classified blocker.

Do not describe the loop mechanism as arbitrary graph re-authoring. They are materially different capabilities.

### 3.4 Keep completion derived

Workflow state determines workflow-local goal completion, failure, blockage, and cancellation.

A model, worker, child goal, or result message cannot mark a goal complete directly.

A child goal result cannot complete its parent task without parent integration and verification.

### 3.5 Keep independent components independent

A disconnected loop or graph branch keeps its own lifecycle.

Creation or execution of a child goal in another component cannot pause, reset, release, fail, or complete that component.

The scheduler can interleave or concurrently execute compatible components.

### 3.6 Make failure explicit

The runtime must use explicit states for:

- failed verification;
- blocked work;
- exhausted loops;
- invalid evaluation;
- budget exhaustion;
- cancelled attempts;
- stale results;
- child-goal failure;
- executor failure;
- workspace lease failure;
- integration conflicts.

### 3.7 Pass explicit context

Executor context must be a bounded projection of canonical state.

Do not depend on the complete parent conversation as the execution contract.

A persisted executor session can improve continuity. It is not canonical context.

### 3.8 Use isolated mutation

A mutating delegated attempt uses one workspace lease and one git worktree by default.

Execution success and integration success are separate states.

### 3.9 Do not add a persistent host process

Hypagraph runs inside a Pi session. It is not a service, a daemon, or a supervisor which owns its own process lifetime.

Do not add:

- a trigger supervisor which creates goals while no Pi session runs;
- a rate limiter or a scheduler which must stay resident;
- an external event listener which owns canonical state;
- any promise of an exact wall-clock action while no Hypagraph process exists.

Separate three different needs. Only the second and the third are in scope:

| Need | Status |
| --- | --- |
| An external event starts Hypagraph while it does not run. | Out of scope. |
| A running node waits for external state, for example a Linear item, a CI result, or a merge. | Supported through a check or a code node. |
| An active graph waits and then processes work again and again. | A graph-loop policy, not a host service. |

Use level-triggered recovery for every time-dependent rule. Persist an absolute deadline. Evaluate the deadline when the controller next wakes, resumes, or reloads. Do not depend on a timer which must keep running.

### 3.10 Use ASD-STE100 technical English

All repository text must follow `AGENTS.md`.

## 4. Release sequence

| Milestone | Release marker | Result | Status |
| --- | --- | --- | --- |
| M0 | v0.1 | Stable graph foundation | Complete |
| M1 | v0.2 | Event-driven finite-state runtime | Complete |
| M2 | v0.3 | Typed facts and deterministic gates | Complete |
| M3 | v0.4 | Deterministic check execution | Complete |
| M4 | v0.5 | Executable bounded iteration regions | Complete |
| M3.1 | included before v0.6 | Deterministic parser and assertion adapters | Complete |
| M5A | v0.6 | Trusted evaluation contracts and adapter boundary | Complete |
| M5B | v0.6 | Root Hypagoal autonomous controller | Complete; released as v0.6 |
| M6A | v0.7 | Deterministic dispatch lane | Complete; released as v0.7 |
| M6B | v0.7 | Event history, replay, and debugger UI | Complete; released as v0.7 |
| M6.1 | v0.8 | Interaction and approval nodes | Planned |
| M6.2 | v0.9 | Code nodes and the sandbox executor adapter | Planned |
| M6.3 | v0.10 | External effects and reconciliation | Planned |
| M7 | v0.11 | Goal families, recursive Hypagoals, executor abstraction, and isolated Pi execution | Planned |
| M8 | v0.12 | Worktree integration and bounded concurrent scheduling | Planned |
| M8.1 | v0.13 | Dynamic fan-out regions | Planned |
| M9 | v0.14 | ACP and named direct agent adapters | Planned |
| Exit | v1.0 | Hardened agent-independent execution kernel | Planned |

Release markers are planning values. Acceptance criteria control milestone completion.

M6A, M6.1, M6.2, M6.3, and M8.1 are new. `docs/graph-capability-review.md` gives the analysis which added them. The milestone numbers of M7, M8, and M9 do not change, and their content does not change. This keeps every existing cross-reference correct.

An earlier version of this document contained an M10 milestone for external triggers and continuous operation. That milestone is removed. It required a resident supervisor and a service lifetime, which design rule 3.9 rejects. The monitoring need which it described is met by a monitor node inside the graph. Section 16 gives that model.

Order note: M6A must complete before M6B. M6A changes the continuation event model, and M6B renders that event model.

## 5. Completed foundation

### M0 - Stable graph foundation

M0 provides:

- versioned workflow definitions;
- deterministic validation;
- schema versions and migrations;
- pure reducer foundations;
- snapshot hashing;
- branch-aware session restoration;
- stable Hypagraph naming and repository policy.

### M1 - Event-driven finite-state runtime

M1 provides:

- explicit node and attempt states;
- commands and append-only events;
- pure event projection;
- optimistic sequence control;
- deterministic replay;
- stale-attempt rejection.

### M2 - Typed facts and deterministic gates

M2 provides:

- typed immutable facts;
- fact contracts;
- deterministic condition evaluation;
- persisted route selection;
- route-aware readiness;
- revision invalidation.

### M3 - Deterministic check execution

M3 provides:

- command checks;
- report checks;
- file and Git assertions;
- bounded artifacts;
- cancellation, timeout, and retry;
- durable external-effect ordering;
- restore without command replay.

### M4 - Executable bounded iteration regions

M4 provides:

- declared strongly connected loop regions;
- typed success conditions;
- hard iteration limits;
- optional progress and patience;
- validity and evaluation budgets;
- explicit loop failure policy;
- connected and independent loop components;
- deterministic recovery and replay.

Repair is one loop pattern. It is not the loop model.

### M3.1 - Parser and assertion adapters

M3.1 provides deterministic parsing and assertion adapters which publish declared typed facts.

### M5A - Trusted evaluation contracts

M5A provides:

- metric reports;
- development, probe, and holdout purpose;
- aggregate and bounded diagnostic feedback;
- evaluation validity;
- evaluation budgets;
- protected file and Git integrity;
- evaluator versions and fingerprints;
- transport-neutral evaluator adapters;
- authoring guidance and product surfaces;
- complete dogfood evidence in `docs/m5a-dogfood.md`.

## 6. M5B - Root Hypagoal autonomous controller

### Objective

Let a user enter one durable objective and let Hypagraph continue the canonical workflow until a deterministic stop state applies.

The v0.6 release supports one root goal and one root workflow in one Pi session.

This root is the first member of the accepted future goal-family model.

### Slice status

1. Canonical goal lifecycle — complete in PR #62.
2. Atomic `/hypagoal` creation — complete in PR #65.
3. Graph-aware continuation — complete in PR #67.
4. Token and turn budgets plus reload safety — complete in PR #69.
5. Loop and trusted-evaluation continuation — complete in PR #71.
6. Blockage and bounded revision — complete in PR #73.
7. Complete Pi product surface — complete in PR #75.
8. Dogfood and v0.6 release — complete in PR #77.

The detailed plan is in `docs/hypagoal-vertical-slice-plan.md`.

### Slice 1 result

M5B Slice 1 provides:

- workflow-local `GoalStatus` and `GoalRuntime`;
- goal commands and events;
- goal state in snapshot hashes;
- workflow-derived goal completion, failure, blockage, cancellation, and pause;
- replay and restore validation;
- UI summaries;
- compatibility for workflows without goal control.

This lifecycle remains the leaf lifecycle for future root and child goals.

### Slice 2 result

M5B Slice 2 provides:

- `/hypagoal <objective>` and `hypagoal_start`;
- repository-aware root graph authoring;
- exact objective preservation;
- one deterministic workflow-definition, readiness, and goal-start event batch;
- one-append persistence with no partial active state;
- typed, state-bound replacement confirmation;
- explicit creation, workflow, goal, revision, sequence, session, branch, and correlation identity;
- replay and restore without autonomous work;
- complete dogfood evidence in `docs/m5b-slice-2-dogfood.md`.

Slice 3 must select deterministically across every runnable root component. It must include goal and workflow identity on continuation actions, support disconnected and independent loop components, avoid recency-based component ownership, and preserve a direct lift into the later family scheduler.

### Slice 3 result

M5B Slice 3 provides:

- a pure workflow-local continuation selector;
- stable enumeration across every runnable root component;
- event-backed round-robin fairness;
- explicit goal, workflow, revision, sequence, snapshot, ordinal, node, and loop identity;
- durable continuation requests before Pi follow-ups;
- one Pi scheduling authority;
- stale request and delivery rejection;
- user-message priority and no-progress stopping;
- replay, restore, independent-loop fairness, and routed Pi smoke evidence in `docs/m5b-slice-3-dogfood.md`.

### Slice 4 result

M5B Slice 4 provides:

- workflow-local substantive-turn and token budgets;
- normalized Pi usage including cache-read and cache-write tokens;
- durable pending-continuation identity;
- exactly-once charging;
- duplicate, malformed, and stale usage rejection;
- deterministic turn-limit and token-limit stops;
- final-turn accounting;
- budget exhaustion separate from workflow success;
- event-backed reload, branch-change, and invalid-usage pause;
- explicit resume with budget and runnable-state validation;
- replay, restore, schema compatibility, and UI summaries;
- complete evidence in `docs/m5b-slice-4-dogfood.md`.

The merged baseline is `80766e51636cbd065cd08632546d3ff39419624c`. CI #871 and final PR CI #873 pass 87 test files and 374 tests on all six supported OS and Node.js targets.

### Slice 5 result

M5B Slice 5 provides:

- canonical loop and evaluation continuation guidance;
- distinct validity, current metric, best metric, and typed-success presentation;
- progress, patience, invalid-evaluation, evaluation-budget, trust, isolation, feedback, integrity, and failure-policy context;
- protected evaluator redaction across model-visible state and check surfaces;
- fair continuation across independent bounded components;
- stale loop-continuation rejection;
- a realistic four-evaluation Pi smoke with one invalid observation, three improvements, and typed success;
- exact goal accounting and restore without dispatch;
- complete evidence in `docs/m5b-slice-5-dogfood.md`.

The merged baseline is `2f5ca9dbdc5664f7bcdf455939881d420fb6363e`. CI #892 and final PR CI #894 pass 89 test files and 382 tests on all six supported OS and Node.js targets.

### Slice 6 result

M5B Slice 6 provides:

- deterministic canonical blocker classification;
- one durable automatic revision allowance for each root Hypagoal;
- state-bound revision identity across goal, workflow, revision, sequence, snapshot, blocker, session, branch, operation, and request;
- byte-exact objective preservation before adapter normalization;
- non-weakening validation for checks, gates, evidence, acceptance, typed success, evaluator trust, loop policies, limits, budgets, scopes, facts, dependencies, and existing required work;
- accepted revisions through the existing workflow revision, invalidation, readiness, and stale-result reducer path;
- exact Slice 4 turn and token accounting for delivered revision turns;
- safe exhaustion for malformed, rejected, stale, interrupted, no-op, weakening, and still-blocked proposals;
- reload and branch-change abandonment plus explicit pause without restore-time dispatch;
- realistic blocked-to-revised-to-completed Pi smoke evidence in `docs/m5b-slice-6-dogfood.md`.

The merged baseline is `a6c5b9ee2b9025308e91241570154b0524158258`. CI #1014 passes 93 test files and 441 tests on all six supported OS and Node.js targets.

### Slice 7 result

M5B Slice 7 provides:

- one pure Hypagoal product projection over canonical workflow, goal, budget, loop, evaluation, blocker, and revision state;
- `/hypagoal status`, `/hypagoal pause`, `/hypagoal resume`, `/hypagoal cancel`, and `/hypagoal graph`;
- lifecycle mutations through existing pause, resume, cancel, and continuation reducers only;
- compact automatic lifecycle notifications for completion, failure, cancellation, blockage, budgets, pauses, stale continuation, invalid usage, and interrupted revision work;
- exact objective, current action, next action, ready work, remaining turn and token budgets, loop and evaluation state, revision allowance, and stop-code presentation;
- explicit distinction between workflow phase, goal status, pause cause, blockage, revision eligibility, revision exhaustion, and terminal outcome;
- exact bounded-loop exit presentation for hard limit, no progress, invalid evaluations, and evaluation budget;
- root-goal metadata in model-visible state and the graph pane;
- verified narrow and wide terminal rendering;
- complete evidence in `docs/m5b-slice-7-dogfood.md`.

The merged baseline is `90c54214c5337be01e455145a36232a392172fae`. CI #1075 and final PR CI #1077 pass 94 test files and 460 tests on all six supported OS and Node.js targets.

### Slice 8 result

M5B Slice 8 provides:

- one integrated Pi product path which starts from `/hypagoal`;
- a four-evaluation optimization region with invalid-result rejection and typed success;
- one independent bounded auxiliary region with event-backed fairness;
- reload pause, explicit resume, and restore without dispatch;
- one probe evaluation and deterministic gate route;
- one typed repository blocker and one applied non-weakening automatic revision;
- canonical final workflow and goal completion only;
- package and lock-file version `0.6.0`;
- updated README, changelog, release notes, and dogfood evidence;
- exact-main publication after the complete six-target matrix.

The release baseline is `90a2885bb8f46d61cedd803897ca4d32246bcb44`. PR #77 and final candidate CI #1111 pass 95 test files and 461 tests. Publication gate CI #1114 passes the same six targets and creates tag and release `v0.6` from that exact commit.

M5B is complete. Evidence is in `docs/v0.6-dogfood.md`.

### M5B architecture constraints

M5B must:

- keep one canonical workflow for the root goal;
- keep workflow state authoritative for goal completion;
- keep one queued Pi continuation;
- preserve independent loop state and fairness;
- use explicit goal, workflow, revision, and node identity in continuation actions;
- make root persistence compatible with later one-member family migration;
- avoid treating one Pi session equals one workflow as a permanent domain invariant.

M5B does not implement child goals, subagents, worktree leases, or physical concurrency.

Those features are accepted later direction, not rejected scope.

### M5B acceptance criteria

- One prose objective creates one valid workflow and active root goal atomically.
- Invalid creation creates no canonical state.
- Completion is workflow-derived only.
- Multi-node work continues without manual prompts.
- Independent components do not starve.
- Token and turn budgets stop deterministically.
- Reload and branch changes pause autonomous work.
- Generic loops and trusted evaluations continue correctly.
- One bounded revision can recover a blocked graph.
- Pi explains active work, budgets, loops, evaluations, and stop reasons.
- Restore does not run work.
- Replay produces the same goal state and stop decision.
- The root workflow can later become a one-member family without rewriting its workflow events.

All M5B acceptance criteria are satisfied in v0.6.

## 7. M6A - Deterministic dispatch lane

- Status: complete
- Evidence: `docs/m6a-dogfood.md`, `docs/m6a-deterministic-dispatch-plan.md`

### Objective

Run every canonical action which needs no reasoning without a model turn.

### Problem

The controller delivers every selected action as a Pi follow-up, and it charges one substantive turn for each delivery. Two of the four work actions need no reasoning:

- a check runs through `runPiCheck`, which is a function of state, executor, and store;
- a gate is one `evaluate-gate` reducer command.

A workflow with three tasks, four checks, and two gates costs at least nine model turns. Six of those turns perform no reasoning. Inside an iteration region the ratio becomes worse, because each iteration adds one evaluation turn and one gate turn.

### Product result

The user runs the same workflow with the same canonical result and consumes model budget only for task work and revision.

### Event-model impact

This milestone changes the continuation event model. It is not only a dispatch change.

The current continuation lifecycle closes only through a delivered model turn. The projection rejects a turn-recorded event when no pending continuation exists. The turn-recorded event also increments the consumed turn count and advances the continuation ordinal. A directly dispatched action produces no Pi usage, so it cannot use that path.

The detailed plan is in `docs/m6a-deterministic-dispatch-plan.md`.

### Acceptance criteria

- A ready check runs without a Pi follow-up and without a charged turn.
- A ready gate evaluates without a Pi follow-up and without a charged turn.
- The reducer, the projection, and replay accept the new completion path.
- Consumed turn and token counts include model turns only, and the product surface says so.
- Cancellation of a directly dispatched check still works.
- A directly dispatched action cannot run without a bound. Loop iteration limits and evaluation budgets remain the bound.
- The continuation selector keeps round-robin fairness across independent components.
- `hypagraph_run_check` remains available for manual use.
- Replay reproduces the same canonical state and the same stop decision.

## 8. M6B - Event history, replay, and debugger UI

- Status: complete
- Evidence: `docs/m6b-dogfood.md`, `docs/m6b-event-history-plan.md`, `docs/v0.7-release-notes.md`

### Objective

Make execution and decisions inspectable.

### Product result

The user can:

- inspect the event timeline;
- replay to an event;
- compare live and replay state;
- explain readiness, blockage, loop, evaluation, and goal decisions;
- inspect revisions and stale results;
- preserve graph positions across small revisions.

### Future compatibility

M6 projections and event views must be able to add:

- family membership;
- child bindings;
- scheduler selections;
- executor attempts;
- workspace leases;
- integration state.

This must not require replacement of the workflow reducer or Slice 1 goal lifecycle.

### Acceptance criteria

- Replay to any event produces the correct historical state.
- Live and replay views use common projection code.
- The user can identify why a node or goal is not runnable.
- Protected evaluator data remains protected in history views.
- Future family and executor event namespaces have defined projection seams.
- The history view shows a directly dispatched action from M6A and distinguishes it from a delivered model turn.

## 9. M6.1 - Interaction and approval nodes

### Objective

Let the graph return to the user for a decision, and let a typed answer control the next work.

### Product result

A workflow can:

1. perform one bounded presentation action, for example render a report artifact or open a plan annotation view;
2. ask the user one declared question;
3. record a typed answer as facts and evidence;
4. route on those facts through an ordinary gate.

### Mandatory rules

Keep the wait node-local. Add node status `awaiting_response`. Do not add a goal status which stops the goal. A stored waiting goal status would break design rule 3.5 and would starve an independent branch or loop which remains runnable.

An `awaiting_response` node is not runnable, exactly as a pending node is not runnable. The continuation selector then keeps every other component eligible.

Report "waiting for a user response" as a derived presentation state. Derive it when the runnable action list is empty and one interaction is outstanding. Do not store it.

Separate deterministic presentation from semantic presentation. A skill is not automatically deterministic. A skill which renders an artifact or opens a fixed surface is deterministic. A skill which instructs a model needs the M7 executor and one model turn.

Free text is evidence only. Free text must never select a route.

The detailed plan is in `docs/m6-1-interaction-node-plan.md`.

### Acceptance criteria

- An interaction node performs its declared presentation effect through the durable lifecycle order.
- An unanswered interaction does not stop an independent runnable component.
- An unanswered interaction consumes no budget.
- A typed answer publishes declared facts and routes through an existing gate.
- Free text reaches evidence and never reaches a route.
- A definition which declares a semantic skill as deterministic fails validation.
- An unanswered interaction survives a reload and is presented again.
- Replay reproduces the same answer, facts, and route.

## 10. M6.2 - Code nodes and the sandbox executor adapter

### Objective

Let a node perform deterministic work in a sandbox without a model turn.

### Decision

Hypagraph adopts the `pi-fabric` execution pattern behind a Hypagraph-owned executor adapter. Hypagraph does not depend on the `pi-fabric` package.

A program is the body of one node. A program must not orchestrate the workflow. Control flow inside an opaque program is not a gate, a loop region, a typed fact, or a replayable decision.

The decision, the adapter contract, the definition shape, the authoring rules, and ten implementation slices are in `docs/code-node-adapter-plan.md`.

### Acceptance criteria

- A code node runs one type-checked program in a QuickJS sandbox and publishes declared facts.
- The program is part of the definition and part of the snapshot hash.
- The TypeScript check runs at definition time and reports a line-numbered error.
- The reducer stays pure. The sandbox stays on the executor side.
- The controller validates the returned value against the node `produces` contract.
- The capability allowlist denies by default, and a revision cannot widen it.
- A mutating program is verified against its declared scope.
- Replay replays the recorded result and never runs the program again.
- A definition-time advisory reports a program which is probably more than one node.

## 11. M6.3 - External effects and reconciliation

### Objective

Let a node change external state safely, for example open a pull request, merge, deploy, or notify.

### Problem

A sandbox and an idempotency key give the execution mechanism. They do not give the state model.

An external effect can complete in the external system after the host loses the result. The existing `interrupted` check status records only that the host could not store a result. It does not reconcile.

### Mandatory rules

An external effect node must use three durable states:

- `requested`: the controller stored the intent before the effect started;
- `observed`: the controller confirmed the outcome from the external system;
- `indeterminate`: the controller cannot decide the outcome.

An indeterminate effect must not be retried blindly. Restart must run a declared reconciliation query against the external system and resolve the effect to `observed` or keep it `indeterminate` and block.

Each effect declares an idempotency key which is derived from canonical identity, so that a repeated attempt is safe.

The detailed plan is in `docs/m6-3-external-effect-plan.md`.

### Acceptance criteria

- An effect stores `requested` before it starts the external call.
- A lost result produces `indeterminate` and never a silent success.
- Restart reconciles an indeterminate effect through a declared query.
- An unresolved indeterminate effect blocks its dependants explicitly.
- A repeated attempt with the same idempotency key does not duplicate the external effect.
- Execution success and external success remain separate states.
- Replay reproduces the effect state without repeating the external call.

## 12. M7 - Goal families and isolated Pi execution

The detailed architecture is in `docs/goal-family-and-concurrent-execution-plan.md` and `docs/delegation-and-visualisation.md`.

### Objective

Add bounded recursive goal composition and transport-independent node execution.

### Vertical slices

1. Add family persistence above existing workflow aggregates.
2. Migrate one v0.6 root into a one-member family projection.
3. Add one family scheduler with sequential dispatch.
4. Add bounded child-goal creation from an active parent task.
5. Add validated child return and parent failure policy.
6. Add explicit executor context and result contracts.
7. Route current-session execution through the executor abstraction.
8. Add an isolated Pi RPC executor.
9. Add nested graph and executor UI.

### Goal-family rules

- Each goal owns one canonical workflow.
- One family controller owns scheduling and canonical writes.
- A child goal waits only its invoking parent task.
- Unrelated branches and independent loops remain runnable.
- Child creation and return are family-level atomic operations.
- Recursive creation has depth, count, scope, and budget bounds.
- Descendant usage is charged to the root family budget.
- Child completion does not complete the parent task automatically.

### Executor rules

- A child Hypagoal is not a subagent.
- A subagent executes one selected node attempt.
- The executor receives explicit reproducible context.
- The executor returns a structured untrusted result.
- Only the controller commits state changes.
- A persisted child Pi session is optional continuity, not canonical context.

### Isolated Pi implementation source

The Pi RPC process lifecycle can reuse or adapt the MIT-licensed implementation in:

https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents

Reuse process bootstrap, RPC framing, ownership checks, cancellation, child sessions, streaming, and orphan reconciliation.

Do not adopt raw final text as the canonical result, model-owned spawning, same-checkout mutation, or uncontrolled completion-triggered turns.

### M7 acceptance criteria

- A root goal can create one child and one bounded grandchild.
- The root workflow event history remains unchanged during one-member family migration.
- An independent loop remains runnable while a child executes.
- The family scheduler is the only dispatch authority.
- Child output returns through declared fact and evidence contracts.
- Child failure policies have deterministic parent effects.
- The current Pi session and isolated Pi executor use the same result contract.
- Loss of an executor session does not lose canonical context.
- Restore and replay reproduce family membership, bindings, scheduler selections, and child outcomes.

M7 can dispatch sequentially or with limited isolated capacity. Production concurrent mutation waits for M8 worktree isolation.

## 13. M8 - Worktree integration and bounded concurrency

### Objective

Execute compatible independent work concurrently without unsafe repository mutation.

### Vertical slices

1. Add workspace lease contracts.
2. Create one worktree for each mutating attempt.
3. Add structured worker commit results.
4. Validate changed scope and evidence.
5. Add integration lifecycle and explicit conflict state.
6. Run post-integration checks in the base workspace.
7. Add global and per-executor concurrency limits.
8. Add concurrency groups and deterministic fairness.
9. Run independent loops and child workflows concurrently.
10. Harden cancellation, crash recovery, and stale integration rejection.

### Concurrency rules

Attempts can run together only when:

- dependencies and routes permit them;
- loop ordering permits them;
- executor limits permit them;
- family and goal budgets permit them;
- concurrency groups are compatible;
- workspace leases are compatible;
- integration operations do not conflict.

Initial default concurrency is two isolated attempts.

### Integration rules

1. Acquire a lease.
2. Prepare the worktree.
3. Launch the executor in that worktree.
4. Validate identity, scope, facts, evidence, and artifacts.
5. Integrate the worker commit.
6. Record conflicts explicitly.
7. Run base-workspace checks.
8. Complete the node only after integration succeeds.

### M8 acceptance criteria

- At least two compatible isolated attempts execute concurrently.
- Conflicting leases prevent unsafe concurrency.
- Independent root loops and child workflows can overlap.
- Execution success and integration success remain separate.
- Integration conflicts are explicit and recoverable.
- Post-integration checks run before completion.
- Stale executor and integration results cannot change current state.
- Crash recovery reconciles active child processes and workspace leases.
- Scheduler fairness prevents starvation.
- Replay reproduces scheduler, lease, integration, and terminal family state.

## 14. M8.1 - Dynamic fan-out regions

### Objective

Let one declared region expand into a number of branches which the runtime derives.

### Scope boundary

A fixed set of branches does not need this milestone. An author can declare three reviewers as three nodes, and M8 executes them concurrently.

Configurable is not the same as derived. A user or an authoring model can choose the branch count before execution starts, for example "create five reviewer nodes". The authoring turn then produces a static canonical graph with five declared nodes. That is a fixed count, and it needs M7 and M8 only.

| Case | Example | Milestones |
| --- | --- | --- |
| Fixed at definition time | A security reviewer, an architecture reviewer, and a correctness reviewer. Five reviewer nodes which the authoring turn creates. | M7 and M8 |
| Derived during execution | One reviewer for each changed package. One reviewer for each discovered subsystem. One branch for each item which a query returns. A count which comes from a typed runtime fact. | M7, M8, and M8.1 |

This milestone is needed only for the second case, because the runtime must canonically expand a collection into branch identities, attempts, evidence, and a fan-in policy.

### Default

Treat a branch count as fixed at definition time, unless a use case explicitly requires the runtime to derive branches from a collection.

This default keeps M8.1 off the critical path of an ordinary reviewer panel. It preserves the capability for genuinely data-driven expansion later.

Confirm that a workflow needs a derived count before you plan work here.

### Mandatory rules

A derived branch must keep every property of a declared node. Each branch must have its own attempt, evidence, retry, status, and graph-pane identity.

Parallel calls inside one program are not fan-out. A program which uses `Promise.all` hides its branches from the graph. It removes per-branch attempts, evidence, retry, visibility, and replay granularity. Do not implement this milestone inside a code node.

The derived count must come from a typed fact. It must be bounded by a declared maximum. Expansion is a canonical event, so replay must reproduce the same branch set.

### Acceptance criteria

- One region expands into a branch set which a typed fact derives.
- Expansion is bounded by a declared maximum.
- Each branch has its own attempt, evidence, and status.
- The scheduler executes compatible branches concurrently under M8 limits.
- Fan-in waits for every branch and applies a declared policy for a failed branch.
- Replay reproduces the same branch set and the same results.

## 15. M9 - External executor adapters

### Objective

Support external agents without moving orchestration out of Hypagraph.

### ACP

Hypagraph acts as the ACP client.

ACP is an execution transport. It is not the graph, goal-family, scheduler, or memory model.

Each attempt initially receives its own ACP session.

The adapter negotiates capabilities, streams progress, brokers permissions and user input, supports cancellation, and normalizes the result.

### Named direct CLI adapters

Use named and tested adapters.

Each adapter defines:

- command invocation;
- context input format;
- result output format;
- cancellation behavior;
- timeout behavior;
- result normalization;
- security limits.

Do not use an arbitrary command as a strict mutating executor.

### M9 acceptance criteria

- One ACP agent executes a node attempt.
- One named CLI adapter executes the same contract.
- Pi RPC, ACP, and CLI executors return the same normalized result type.
- Untrusted output cannot change canonical state without controller validation.

## 16. Monitoring inside the graph, not a service

### Decision

Hypagraph does not add a trigger supervisor, a resident scheduler, or a service lifetime. Design rule 3.9 rejects them.

An earlier version of this document contained an M10 milestone which added them. That milestone is removed.

### The need which remains

Reference workflow A waits for a Linear item, for a CI result, and for a merge. That need is real. A resident service is not the way to meet it.

Meet it with a monitor node inside the graph:

```text
monitor node
    waits for the external condition
    publishes one typed observation
    completes
        |
        v
ordinary graph work
        |
        v
feedback edge returns to the monitor node
```

A monitor node is an ordinary check node or code node. The wait is bounded by a timeout and by a retry policy. The repetition is an ordinary bounded iteration region.

### What this needs, and where it comes from

| Requirement | Milestone |
| --- | --- |
| Direct deterministic dispatch, so that a poll does not cost a model turn | M6A |
| Fact-bound command and program inputs, so that a monitor can query a specific item or run | M6.2 |
| Cancellation and interruption handling | Available in v0.6 |
| Restart reconciliation for an observation which the host lost | M6.3 |
| An until-cancelled loop policy, only when a genuinely indefinite graph is required | Small addition to the existing loop model. Not yet accepted. |

Every one of these already belongs to an accepted milestone, except the last.

### The until-cancelled loop policy

The current loop model requires a hard iteration limit. That rule is correct for a bounded objective.

A monitor loop which must run until a user cancels it does not have a natural limit. If a product decision accepts an indefinite monitor graph, then add one explicit loop policy which permits no iteration limit and which requires an explicit cancel or an explicit typed stop condition.

Do not add this policy before a real workflow needs it. An indefinite loop removes a safeguard which every other loop keeps.

### Out of scope

- An external event which starts Hypagraph while no Pi session runs.
- A supervisor which creates goals without a user.
- A rate limiter or a cost limiter which must stay resident.
- Any promise of an exact wall-clock action while no Hypagraph process exists.

## 17. Version 1.0 exit criteria

Hypagraph can release version 1.0 when:

- the domain package has no Pi dependency;
- event replay is deterministic;
- schema migration is documented and tested;
- checks and gates are deterministic;
- iteration regions are bounded, policy-driven, independent when disconnected, and replayable;
- trusted evaluation claims match actual isolation and integrity;
- goal completion is workflow-derived;
- recursive goal creation is bounded and family-controlled;
- executors cannot change canonical state;
- executor context is explicit and reproducible;
- delegated file changes use isolated workspaces;
- concurrent scheduling respects dependencies, loops, leases, budgets, and executor limits;
- cancellation and stale-result rules are tested;
- integration failure is separate from execution failure;
- the user interface explains readiness, failure, family, executor, and workspace state;
- documentation follows repository writing rules;
- a complete medium coding objective succeeds through root and child Hypagoals with isolated concurrent execution and no manual state repair;
- a canonical action which needs no reasoning runs without a model turn;
- an interaction node returns to the user without stopping an independent runnable component;
- a code node runs a definition-time program in a sandbox, and replay never runs it again;
- an external effect resolves to an observed or an explicitly indeterminate state, and restart reconciles it;
- a derived branch set keeps per-branch attempts, evidence, and replay;
- a monitor node waits for external state inside the graph, and no resident host process exists.

## 18. Immediate next work

1. Start M6.1 interaction and approval nodes. `docs/m6-1-interaction-node-plan.md` gives the plan.
2. Close stale tracking issues for completed milestones when their evidence is accepted.
3. Treat a reviewer or branch count as fixed at definition time, unless a use case explicitly requires the runtime to derive branches from a collection. Under that default M8.1 is not on the critical path of reference workflow B. Confirm the intended case before you plan M8.1.
4. Do not start M6.3 before M6.2. The effect state model needs the code node as its execution mechanism.
5. Do not add a resident supervisor, a trigger service, or a running timer. Design rule 3.9 rejects them. Use a monitor node instead. Section 16 gives the model.
