# Hypagoal vertical-slice plan

- Status: active implementation; Slices 1, 2, and 3 complete; Slice 4 current
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

Later M5B slices add turn accounting and budget events.

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

### Slice 4 - Budgets and reload safety — current

Add token accounting, turn accounting, final-turn accounting, budget events, wrap-up guidance, reload pause, branch-change pause, explicit resume, and session-generation tests.

A budget stop is not success. Restore must not run work.

Use field and event names which can later aggregate descendant usage into a family budget. Do not create a budget model which assumes all future usage occurs in the root Pi process.

Done when token limits, turn limits, reload, and branch changes produce deterministic stop behavior.

### Slice 5 - Loop and trusted-evaluation continuation

Add continuation guidance for generic loop state, current and best metric, patience, invalid-evaluation count, evaluation purpose and trust, feedback mode, evaluation budgets, all bounded stop reasons, independent loop components, and explicit loop failure policy.

The continuation policy must keep independent components runnable while another component progresses. A child goal added in a later release must not change this isolation rule.

Done when Hypagoal runs both an optimization or refinement region and an independent auxiliary region, preserves their state independence, rejects an invalid score, and completes through typed success.

### Slice 6 - Blockage and bounded revision

Add blocked-goal projection, revision guidance, original-objective preservation, one bounded automatic revision attempt, stale-result protection, and clear diagnostics.

A revision cannot silently change the user objective. The first release must not replan without bound.

The v0.6 response to newly discovered bounded work is workflow revision. A later release can choose a bounded child goal when independent ownership, scope, budget, and return contracts are justified.

Done when a blocked graph either returns to a valid path through one revision or stops with a clear blocker.

### Slice 7 - Complete Pi product surface

Add compact lifecycle messages, `/hypagoal status`, `/hypagoal pause`, `/hypagoal resume`, `/hypagoal cancel`, `/hypagoal graph`, graph-pane goal details, budget/loop/evaluation/stop summaries, and narrow and wide terminal coverage.

Keep view-model identities explicit so later UI can show goal ancestry, child workflows, executor attempts, and workspaces without replacing root workflow views.

Done when a user can understand the active action, remaining budget, loop and evaluation state, and stop reason without event inspection.

### Slice 8 - Dogfood and release

The v0.6 dogfood path must:

1. start from one prose `/hypagoal` command;
2. define a graph with at least one gate;
3. run one refinement or optimization region for at least three iterations;
4. run one independent bounded auxiliary region;
5. include check-and-repair as one pattern, not the default loop model;
6. improve one numeric progress metric;
7. reject one invalid evaluation without updating the best metric;
8. run a probe or generalization check;
9. complete through typed success;
10. prove independent-region state isolation;
11. prove that the continuation selector does not starve the independent region;
12. restore between iterations;
13. prove reload-time pause;
14. prove token-budget and turn-budget termination;
15. prove evaluation-budget termination;
16. prove hard-limit and no-progress termination;
17. prove each loop failure policy;
18. prove stale-continuation rejection;
19. prove that the model cannot mark the goal complete;
20. record compatibility evidence that the persisted root identities and event history can be referenced by the documented future family model without rewriting workflow state.

The release requires the full six-target CI matrix, a dogfood record in `docs`, package and lock-file version alignment, and a tag on the tested main commit.

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

M5B is active. Slices 1, 2, and 3 are complete. Slice 4 is the current implementation target.
