# Hypagraph execution plan and roadmap

- Status: active
- Updated: 2026-07-25
- Current milestone: M6A deterministic dispatch lane
- Current implementation baseline: `0d1375a5f19a311528d5c774b66f0239a48164bb`
- Current release: `v0.6`
- Capability analysis which added M6A, M6.1, M6.2, M6.3, M8.1, and M10: `docs/graph-capability-review.md`
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

### 3.9 Use ASD-STE100 technical English

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
| M6A | v0.7 | Deterministic dispatch lane | Active |
| M6B | v0.7 | Event history, replay, and debugger UI | Planned |
| M6.1 | v0.8 | Interaction and approval nodes | Planned |
| M6.2 | v0.9 | Code nodes and the sandbox executor adapter | Planned |
| M6.3 | v0.10 | External effects and reconciliation | Planned |
| M7 | v0.11 | Goal families, recursive Hypagoals, executor abstraction, and isolated Pi execution | Planned |
| M8 | v0.12 | Worktree integration and bounded concurrent scheduling | Planned |
| M8.1 | v0.13 | Dynamic fan-out regions | Planned |
| M9 | v0.14 | ACP and named direct agent adapters | Planned |
| M10 | v0.15 | External triggers and continuous operation | Planned |
| Exit | v1.0 | Hardened agent-independent execution kernel | Planned |

Release markers are planning values. Acceptance criteria control milestone completion.

M6A, M6.1, M6.2, M6.3, M8.1, and M10 are new. `docs/graph-capability-review.md` gives the analysis which added them. The milestone numbers of M7, M8, and M9 do not change, and their content does not change. This keeps every existing cross-reference correct.

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

This milestone is needed only when the branch count is a runtime value, for example one branch for each changed package, or one branch for each item in a queue.

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

## 16. M10 - External triggers and continuous operation

### Objective

Let an external event start bounded work, and let Hypagraph run as a service.

### Product decision required before implementation

This milestone changes the product model. Every earlier milestone assumes one bounded objective which reaches a terminal state.

A continuous loop does not reach a terminal state. The two models must be reconciled explicitly, and the decision must be recorded before implementation starts.

The recommended reconciliation keeps the bounded model as the unit of work:

1. a trigger creates one bounded goal for each external item;
2. each goal keeps its own budgets, terminal state, and evidence;
3. the service is the supervisor which creates goals. The service is not one goal which never ends.

This keeps every existing invariant. It also matches the reference workflow, in which each backlog item is one unit of work.

### Scope

1. Trigger adapters: schedule, webhook, and issue-tracker poll.
2. A durable trigger record with an item identity, so that one item creates one goal.
3. A supervisor which applies concurrency, rate, and cost limits across goals.
4. Deduplication, so that a repeated external event does not create a second goal.
5. Explicit operator control: pause the service, drain the service, and inspect every active goal.

### Acceptance criteria

- One external item creates exactly one bounded goal.
- A repeated event does not create a second goal for the same item.
- The supervisor limits concurrent goals, rate, and total cost.
- An operator can pause and drain the service without losing canonical state.
- A failed goal does not stop the supervisor.
- Restart reconciles active goals and pending triggers.
- Every goal keeps its own terminal state and evidence.

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
- a trigger creates one bounded goal for each external item, and the supervisor bounds concurrency and cost.

## 18. Immediate next work

1. Decide the M6A continuation-completion design. Choose between a completion event for a deterministic action and no continuation request for a deterministic action. Record the decision in `docs/m6a-deterministic-dispatch-plan.md`.
2. Implement M6A Slice 1 and Slice 2. These give a directly dispatched gate and a directly dispatched check.
3. State in the product surface that consumed turns count model turns only.
4. Complete M6A before M6B, so that the history views render the final event model.
5. Confirm whether reference workflow B needs a fixed or a derived reviewer count. This decides whether M8.1 is on the critical path.
6. Do not start M6.3 before M6.2. The effect state model needs the code node as its execution mechanism.
7. Do not start M10 before the bounded-goal and continuous-service reconciliation is recorded.
