# Hypagraph execution plan and roadmap

- Status: active
- Updated: 2026-07-24
- Current milestone: M5B Hypagoal
- Current implementation baseline: `3656caf3e62d26d3dc406e93b5b5e71e96cbfae8`
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
| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1 and 2 complete |
| M6 | v0.7 | Event history, replay, and debugger UI | Planned |
| M7 | v0.8 | Goal families, recursive Hypagoals, executor abstraction, and isolated Pi execution | Planned |
| M8 | v0.9 | Worktree integration and bounded concurrent scheduling | Planned |
| M9 | v0.10 | ACP and named direct agent adapters | Planned |
| Exit | v1.0 | Hardened agent-independent execution kernel | Planned |

Release markers are planning values. Acceptance criteria control milestone completion.

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
3. Graph-aware continuation — current.
4. Token and turn budgets plus reload safety.
5. Loop and trusted-evaluation continuation.
6. Blockage and bounded revision.
7. Complete Pi product surface.
8. Dogfood and v0.6 release.

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

## 7. M6 - Event history, replay, and debugger UI

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

## 8. M7 - Goal families and isolated Pi execution

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

## 9. M8 - Worktree integration and bounded concurrency

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

## 10. M9 - External executor adapters

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

## 11. Version 1.0 exit criteria

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
- a complete medium coding objective succeeds through root and child Hypagoals with isolated concurrent execution and no manual state repair.

## 12. Immediate next work

1. Implement M5B Slice 2 atomic `/hypagoal` creation.
2. Keep Slice 1 `GoalRuntime` as the workflow-local lifecycle.
3. Include goal and workflow identity in later continuation actions.
4. Keep independent components available to the continuation selector.
5. Keep v0.6 persistence compatible with later one-member family migration.
6. Do not implement child goals or subagents before the root controller is complete.
