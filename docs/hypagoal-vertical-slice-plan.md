# Hypagoal vertical-slice plan

- Status: complete; released as v0.6
- Roadmap phase: M5B
- Release marker: v0.6 with M5A trusted evaluation contracts
- Prerequisites: M4 bounded iteration regions and the completed M5A evaluation foundation
- Tracking issue: #25
- Research source: https://github.com/Michaelliv/pi-goal
- Future architecture: `docs/goal-family-and-concurrent-execution-plan.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

`/hypagoal` gives Pi one durable root objective and lets Hypagraph continue work until the canonical workflow reaches a terminal state or a deterministic stop condition applies.

The v0.6 controller operates one root Hypagoal over one normal Hypagraph workflow.

This is the first member of the accepted future goal-family model. A later release can let an active task create a bounded child Hypagoal with its own canonical workflow. That later composition must preserve the workflow-local lifecycle delivered in Slice 1.

Hypagoal is not:

- a second workflow type;
- a goal node;
- an independent completion state machine;
- a prose continuation loop;
- a model-selected completion mechanism.

The workflow graph remains the executable contract. Goal control decides whether the controller can request or dispatch more work.

## 2. Release result

For v0.6, a user can:

1. start from one prose `/hypagoal` objective;
2. let the bundled skill inspect the repository and compile the smallest valid Hypagraph workflow;
3. continue through tasks, checks, gates, and bounded iteration regions without a manual prompt after every turn;
4. use deterministic evaluation contracts when a defensible metric exists;
5. omit metric progress when no defensible metric exists;
6. stop after workflow completion, failure, blockage, cancellation, token budget, turn budget, hard loop limit, patience, invalid-evaluation limit, or evaluation budget;
7. pause and resume explicitly;
8. restore a session without silent autonomous work;
9. inspect goal, workflow, loop, and evaluation state in Pi;
10. replay the same goal status and stop decision from events.

The v0.6 release is root-only and uses one Pi continuation at a time. This is a release boundary, not a permanent product boundary.

## 3. Product invariants

### 3.1 One canonical workflow for each goal

Use `HypagraphDefinition.goal` as the human-readable objective for the goal which owns that workflow.

Use normal nodes, facts, gates, checks, scopes, loops, evidence, and outcome policies as the executable work model.

Do not duplicate those fields in a second goal definition.

The future goal-family model composes separate workflow aggregates. It does not embed a complete child workflow inside a parent node definition.

### 3.2 Preserve the Slice 1 lifecycle as the leaf aggregate

M5B Slice 1 added one optional `GoalRuntime` to `HypagraphState`.

That runtime remains the canonical lifecycle for one goal and one workflow. Future family persistence and scheduling must reference it. They must not replace its events, reducer rules, replay, hashes, or workflow-derived terminal state.

A v0.6 root goal must therefore be valid as a one-member future goal family without rewriting its workflow event history.

### 3.3 Workflow-derived completion

The runtime derives goal status from canonical workflow state:

- completed workflow -> completed goal;
- failed workflow -> failed goal;
- cancelled workflow -> cancelled goal;
- no executable path -> blocked goal;
- exhausted goal budget -> budget-limited goal;
- reload, branch change, or user pause -> paused goal.

There is no `complete-goal` command and no model tool that completes a goal.

A future child goal follows the same rule for its own workflow. Child completion cannot directly mark its parent task complete.

### 3.4 Pure continuation decision

A later slice adds a pure continuation decision:

```ts
export type GoalContinuationDecision =
  | { kind: "stop-completed" }
  | { kind: "stop-paused" }
  | { kind: "stop-blocked"; reason: string }
  | { kind: "stop-failed"; reason: string }
  | { kind: "stop-budget-limited"; reason: string }
  | { kind: "continue-active-task"; goalId: string; workflowId: string; nodeId: string }
  | { kind: "start-ready-task"; goalId: string; workflowId: string; nodeId: string }
  | { kind: "run-ready-check"; goalId: string; workflowId: string; nodeId: string }
  | { kind: "evaluate-ready-gate"; goalId: string; workflowId: string; nodeId: string }
  | { kind: "request-revision"; goalId: string; workflowId: string; reason: string }
  | { kind: "invariant-error"; reason: string };
```

The v0.6 implementation has one goal and one workflow, but action identity must still include goal and workflow IDs. This lets the decision lift into the future family scheduler without changing the action contract.

The function must not call Pi, read the clock, generate IDs, inspect files, run commands, invoke a model, or select semantic implementation work.

### 3.5 One queued continuation in v0.6

The Pi adapter can queue no more than one continuation.

A continuation is permitted only when:

- goal status is active;
- workflow state is not terminal;
- no user or tool message has priority;
- no continuation is already queued;
- the active session generation still matches;
- another substantive turn is within budget.

A reload or branch change invalidates queued continuation and pauses the goal.

The future goal-family controller keeps one scheduling authority but can dispatch more than one isolated executor attempt when concurrency policy permits it.

### 3.6 Independent components remain independent

Hypagoal uses the existing generic loop-region model.

A region can perform refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

A region can connect to the main graph or be an independent top-level component.

Creating or running work in another branch must not pause, reset, release, fail, or complete an independent region.

The v0.6 controller can interleave runnable components through sequential Pi turns. Future isolated executors can run compatible components concurrently.

### 3.7 Trusted evaluation integration

When a defensible metric exists, authoring should define a metric-producing evaluator, evaluation purpose, trust boundary, typed validity, typed success, progress direction, hard limit, optional patience, evaluation budget, feedback policy, deterministic constraints, and useful probe or anti-gaming instruments.

When no defensible metric exists, authoring must omit progress and use deterministic checks, typed success, evidence, hard bounds, outcome policy, and user review.

A non-isolated evaluation must not be presented as trusted holdout acceptance.

### 3.8 Future goal-family control

The accepted future model has one family controller above many workflow-local goal runtimes.

A child goal:

- can be created only from an active parent task;
- puts only that task into a child-wait state;
- leaves unrelated branches and independent loops runnable;
- receives bounded input facts, artifacts, evidence, scope, and budget;
- returns declared outputs through a validated binding;
- cannot own an independent scheduler;
- cannot mutate parent or family state directly.

The complete design is in `docs/goal-family-and-concurrent-execution-plan.md`.

## 4. Goal-control state

Slice 1 delivered this initial persisted domain model:

```ts
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface GoalRuntime {
  goalId: string;
  workflowId: string;
  status: GoalStatus;
  continuationOrdinal: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stopReason?: string;
}
```

Slice 4 extends the runtime with token and turn usage and deterministic budget-limited state. Commands supply timestamps and usage values. The reducer remains pure.

Do not add parent, child, or scheduler fields to this workflow-local runtime during v0.6 unless they are required for stable identity. Future family membership belongs in an additive family aggregate.

## 5. Commands and events

Slice 1 delivered these commands:

- `start-goal`;
- `pause-goal`;
- `resume-goal`;
- `cancel-goal`.

Slice 1 delivered these events:

- `hypagraph.goal.started`;
- `hypagraph.goal.paused`;
- `hypagraph.goal.resumed`;
- `hypagraph.goal.blocked`;
- `hypagraph.goal.completed`;
- `hypagraph.goal.failed`;
- `hypagraph.goal.cancelled`.

Slice 4 added turn accounting, budget events, durable continuation identity, and reload-safety pause events.

Future family events will record child bindings, family membership, scheduler selection, child return, executor dispatch, and workspace integration. Those events are outside v0.6 and must not overload the workflow-local lifecycle events.

Every status change and stop reason must be event-backed and replayable.

## 6. Vertical slices

Each slice crosses all affected domain, reducer, projection, persistence, Pi, test, and documentation layers.

### Slice 1 - Canonical goal lifecycle — complete

PR #62 delivered:

- optional `GoalRuntime` in canonical workflow state and snapshot hashes;
- start, pause, resume, block, complete, fail, and cancel events;
- explicit start, pause, resume, and cancel commands;
- workflow-derived completion, failure, blockage, and workflow-pause projection;
- explicit recovery from paused or blocked goal state;
- replay and restore validation;
- structured, text, and compact widget summaries;
- compatibility for workflows and sessions without goal control;
- preservation of the workflow objective under `goal`, with lifecycle state under `goalControl`;
- rejection of a fabricated `complete-goal` command without state mutation.

The merge baseline is `0bbe7f227fc28262958f29992cece9c663ecad2a`.

CI #661 passes 81 test files and 307 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

This implementation remains the workflow-local lifecycle for every future root or child goal.

### Slice 2 - Atomic `/hypagoal` creation — complete

PR #65 delivered:

- `/hypagoal <objective>` and model-facing `hypagoal_start`;
- repository-aware compilation of the smallest useful graph;
- exact preservation of `HypagraphDefinition.goal`;
- one pure workflow-plus-goal creation operation;
- deterministic definition, readiness, and goal-start event ordering;
- one durable append against expected empty sequence;
- candidate replay and restore validation before exposure;
- explicit goal, workflow, revision, sequence, snapshot, session, branch, operation, and correlation identity;
- typed replacement-required results and stale confirmation rejection;
- stale authoring-operation rejection after session or branch change;
- no continuation, executor, subagent, or restore-time side effect;
- realistic Pi command-to-tool smoke evidence.

The merge baseline is `3656caf3e62d26d3dc406e93b5b5e71e96cbfae8`.

CI #722 passes 83 test files and 333 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The one-root rule remains a v0.6 Pi product boundary. The workflow domain remains compatible with later family persistence.

### Slice 3 - Graph-aware continuation — complete

PR #67 delivered:

- pure workflow-local continuation decisions;
- explicit goal, workflow, revision, sequence, snapshot, ordinal, node, and loop identity;
- stable definition-order candidate enumeration;
- event-backed round-robin selection through `GoalRuntime.continuationOrdinal`;
- durable `hypagraph.goal.continuation-requested` events;
- one queued Pi follow-up through `agent_end`;
- state-bound delivery and stale rejection in `before_agent_start`;
- user-message priority and no-progress stop behavior;
- dynamic tool exposure and restoration;
- deterministic selection across disconnected branches and independent loop components;
- replay, restore, and realistic Pi smoke coverage.

The merge baseline is `836ac10ea8c13c6b0839902d175f718359d1bd07`.

CI #770 and final PR CI #772 pass 85 test files and 357 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The selector remains workflow-local and can later become one candidate source for the family scheduler without changing its action contract.

### Slice 4 - Budgets and reload safety — complete

PR #69 delivered:

- workflow-local substantive-turn and token limits;
- normalized input, output, cache-read, cache-write, and total token usage;
- durable pending-continuation identity;
- exactly-once turn charging;
- duplicate and stale usage rejection;
- deterministic `turn_limit` and `token_limit` stop state;
- final-turn accounting without replacing workflow completion;
- explicit reload, branch-change, and invalid-usage pause causes;
- canonical pending-continuation invalidation on pause;
- explicit `/hypagoal resume`;
- resume-time budget and runnable-state validation;
- replay, restore, schema compatibility, and Pi summaries.

The merge baseline is `80766e51636cbd065cd08632546d3ff39419624c`.

CI #871 and final PR CI #873 pass 87 test files and 374 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The budget contract is workflow-local and additive. A later family controller can aggregate descendant and executor usage without rewriting this event history.

### Slice 5 - Loop and trusted-evaluation continuation — complete

PR #71 delivered:

- canonical loop guidance for iteration, hard limit, typed success, current and best accepted metric, progress direction, patience, and invalid-evaluation state;
- evaluation purpose, feedback, trust, isolation, attempt budgets, public evaluator identity, integrity, and failure-policy guidance;
- explicit separation of validity, numeric progress, and typed success;
- protected evaluator redaction in model-visible graph, summary, continuation, check-start, and check-result surfaces;
- one unchanged root selector and scheduling authority;
- stale loop-continuation rejection after canonical iteration change;
- fair interleaving between an optimization region and an independent bounded auxiliary region;
- a realistic four-evaluation Pi smoke with one invalid observation, three valid improvements, and typed success;
- exact goal turn and token accounting during loop work;
- replay and restore without dispatch.

The merge baseline is `2f5ca9dbdc5664f7bcdf455939881d420fb6363e`.

CI #892 and final PR CI #894 pass 89 test files and 382 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

Evidence is in `docs/m5b-slice-5-dogfood.md`.

### Slice 6 - Blockage and bounded revision — complete

PR #73 delivered:

- deterministic blocker classification for typed node, loop, legacy-definition, no-path, external, safeguard, and terminal-policy cases;
- one event-backed automatic revision attempt for each root Hypagoal;
- exact state-bound request and proposal identity;
- allowance consumption when the revision turn is requested, including malformed, rejected, stale, interrupted, no-op, weakening, and still-blocked outcomes;
- byte-exact objective preservation before adapter normalization;
- explicit non-weakening validation for protected evaluation, typed success, checks, gates, evidence, acceptance, facts, dependencies, scopes, loop policy, hard limits, and goal or evaluation budgets;
- accepted revision through the existing `revise` command and canonical invalidation reducer;
- preservation of unaffected completed work and rejection of pre-revision stale results;
- exact turn and token accounting through the Slice 4 path;
- reload and branch-change abandonment and pause without semantic dispatch;
- realistic positive and negative Pi smoke coverage;
- complete evidence in `docs/m5b-slice-6-dogfood.md`.

The merge baseline is `a6c5b9ee2b9025308e91241570154b0524158258`.

CI #1014 passes 93 test files and 441 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The v0.6 response to newly discovered bounded work remains workflow revision. A later release can create a child goal when work needs separate ownership, budget, workspace, or return semantics.

### Slice 7 - Complete Pi product surface — complete

PR #75 delivered:

- one pure projection for exact objective, workflow phase, goal status, active and next action, ready work, goal budgets, loop and evaluation state, canonical blockage, revision allowance, and explicit stop codes;
- `/hypagoal status`, `/hypagoal pause`, `/hypagoal resume`, `/hypagoal cancel`, and `/hypagoal graph`;
- pause, resume, cancel, and continuation changes through existing canonical commands and reducers;
- compact lifecycle notifications for automatic completion, failure, cancellation, blockage, budget limits, reload and branch pauses, invalid usage, stale continuation, and interrupted revision work;
- explicit separation of workflow phase, goal status, pause cause, blocker class, revision eligibility, revision exhaustion, evaluation validity, numeric progress, typed success, and bounded stop reason;
- exact loop exit presentation for `max_iterations`, `no_progress`, `invalid_evaluations`, and `evaluation_budget`;
- goal details in model-visible projections and the graph pane without protected evaluator internals;
- narrow 52-column and wide 110-column terminal coverage;
- complete evidence in `docs/m5b-slice-7-dogfood.md`.

The merge baseline is `90c54214c5337be01e455145a36232a392172fae`.

CI #1075 and final PR CI #1077 pass 94 test files and 460 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

### Slice 8 - Dogfood and release — complete

PR #77 delivered:

- one integrated `/hypagoal` product path;
- one four-evaluation optimization region and one independent auxiliary region;
- invalid-evaluation rejection before accepted progress;
- numeric improvements from `0.4` to `0.7` to typed success at `0.9`;
- one probe evaluation at `0.95` and one deterministic gate route;
- reload pause, explicit resume, exact accounting, and restore without dispatch;
- one typed repository blocker and one consumed, accepted, non-weakening automatic revision;
- final completion derived only from canonical workflow state;
- root identity compatibility with a future one-member goal family;
- package and lock-file version `0.6.0`;
- release documentation and installation updates.

The release baseline is `90a2885bb8f46d61cedd803897ca4d32246bcb44`.

CI #1108 validates the integrated product path. Final PR CI #1111 and exact-main publication gate CI #1114 pass 95 test files and 461 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

Tag and GitHub release `v0.6` point to the tested release baseline. Complete evidence is in `docs/v0.6-dogfood.md`.

## 7. Test strategy

M5B tests must prove:

- deterministic goal events and hashes;
- workflow-derived completion only;
- atomic root creation;
- one queued continuation;
- explicit runnable-action identity;
- deterministic selection between root components;
- user and tool priority;
- paused and terminal behavior;
- token and turn budgets;
- reload and branch-change pause;
- stale usage and continuation rejection;
- generic loop continuation;
- independent loop isolation and fairness;
- evaluation stops;
- bounded revision;
- Pi surfaces;
- no model-selected completion;
- compatibility with workflows which have no goal state;
- preservation of the root identities required by the documented future family migration.

## 8. Deferred from v0.6

The root-only v0.6 release does not include:

- child or recursive Hypagoals;
- goal-family persistence;
- parallel autonomous node execution;
- delegated subagents;
- worktree leases and integration;
- ACP execution;
- named direct CLI agent adapters;
- model-scored success or loss;
- loss extraction from unstructured text;
- unlimited automatic revision;
- automatic restoration of the best workspace state;
- time-based hard budgets;
- more than one active goal in one Pi session;
- automatic resume after reload;
- deletion of canonical goal history.

Child goals, isolated subagents, worktree isolation, and bounded concurrency are accepted future product direction. Their deferral must not be interpreted as rejection.

## 9. Post-v0.6 evolution

The detailed design is in `docs/goal-family-and-concurrent-execution-plan.md`.

The required evolution is:

1. add a family aggregate above existing workflow-local goal runtimes;
2. migrate a v0.6 root into a one-member family without rewriting its workflow events;
3. add one family scheduler with sequential dispatch;
4. add bounded child-goal creation and validated return;
5. add an executor abstraction and explicit context/result envelopes;
6. add an isolated Pi RPC executor;
7. add worktree leases and integration lifecycle;
8. add bounded concurrent scheduling across independent loops and goal workflows;
9. add ACP and named CLI executors behind the same contract.

A child goal suspends only its invoking parent task. It does not pause unrelated graph components.

A child Hypagoal is not a subagent. The family scheduler owns orchestration. Subagents execute selected node attempts.

## 10. Roadmap position

| Phase | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Executable bounded iteration regions |
| M5A | v0.6 | Trusted evaluation contracts and adapter boundary |
| M5B | v0.6 | Root Hypagoal autonomous controller |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Goal families, recursive Hypagoals, executor abstraction, and isolated Pi execution |
| M8 | v0.9 | Worktree integration and bounded concurrent scheduling |
| M9 | v0.10 | ACP and direct agent adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

M5B is complete and released as v0.6. M6 event history, replay, and debugger UI is the current roadmap phase.
