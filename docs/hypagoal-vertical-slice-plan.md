# Hypagoal vertical-slice plan

- Status: accepted product direction
- Roadmap phase: M5B
- Release marker: v0.6 with M5A trusted evaluation contracts
- Prerequisites: M4 bounded iteration regions and the required M5A evaluation foundation
- Tracking issue: #25
- Research source: https://github.com/Michaelliv/pi-goal
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

`/hypagoal` gives Pi one durable objective and lets Hypagraph continue work until the canonical workflow reaches a terminal state or a deterministic stop condition applies.

Hypagoal is an autonomous controller over one normal Hypagraph workflow. It is not:

- a second workflow type;
- a goal node;
- an independent state machine for task completion;
- a prose continuation loop;
- a model-selected completion mechanism.

The workflow graph remains the executable contract. The goal controller decides only whether Pi may request another agent turn.

## 2. Product result

A user can:

1. Start from one prose `/hypagoal` objective.
2. Let the bundled skill inspect the repository and compile the smallest valid Hypagraph workflow.
3. Continue through tasks, checks, gates, and bounded iteration regions without a manual prompt after every turn.
4. Use deterministic evaluation contracts when a defensible metric exists.
5. Omit metric progress when no defensible metric exists.
6. Stop after workflow completion, failure, blockage, cancellation, token budget, turn budget, hard loop limit, patience, invalid-evaluation limit, or evaluation budget.
7. Pause and resume explicitly.
8. Restore a session without silent autonomous work.
9. Inspect goal, workflow, loop, and evaluation state in Pi.
10. Replay the same goal status and stop decision from events.

## 3. Product invariants

### 3.1 One canonical workflow

Use `HypagraphDefinition.goal` as the human-readable objective.

Use normal nodes, facts, gates, checks, scopes, loops, evidence, and outcome policies as the executable work model.

Do not duplicate those fields in a second goal definition.

### 3.2 Workflow-derived completion

The runtime derives goal status from canonical workflow state:

- completed workflow -> completed goal;
- failed workflow -> failed goal;
- cancelled workflow -> cancelled goal;
- no executable path -> blocked goal;
- exhausted goal budget -> budget-limited goal;
- reload, branch change, or user pause -> paused goal.

There is no `complete-goal` command and no model tool that completes a goal.

### 3.3 Pure continuation decision

A pure function decides the next control action:

```ts
export type GoalContinuationDecision =
  | { kind: "stop-completed" }
  | { kind: "stop-paused" }
  | { kind: "stop-blocked"; reason: string }
  | { kind: "stop-failed"; reason: string }
  | { kind: "stop-budget-limited"; reason: string }
  | { kind: "continue-active-task"; nodeId: string }
  | { kind: "start-ready-task"; nodeId: string }
  | { kind: "run-ready-check"; nodeId: string }
  | { kind: "evaluate-ready-gate"; nodeId: string }
  | { kind: "request-revision"; reason: string }
  | { kind: "invariant-error"; reason: string };
```

The function must not call Pi, read the clock, generate IDs, inspect files, run commands, invoke a model, or select semantic implementation work.

### 3.4 One queued continuation

The Pi adapter can queue no more than one continuation.

A continuation is permitted only when:

- goal status is active;
- workflow state is not terminal;
- no user or tool message has priority;
- no continuation is already queued;
- the active session generation still matches;
- another substantive turn is within budget.

A reload or branch change invalidates queued continuation and pauses the goal.

### 3.5 Generic bounded iteration

Hypagoal uses the existing generic loop-region model.

A region can perform refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

A region can connect to the main graph or be an independent top-level component.

Each region has:

- explicit entry and evaluation boundaries;
- typed success;
- hard iteration limits;
- optional numeric progress and patience;
- optional evaluation validity and budgets;
- explicit failure policy.

Hypagoal must not infer repair semantics from a loop name or node title.

### 3.6 Trusted evaluation integration

When a defensible metric exists, authoring should define:

- a metric-producing evaluator node;
- evaluation purpose;
- evaluator trust boundary;
- typed validity;
- typed success;
- numeric progress direction;
- hard iteration limit;
- patience when useful;
- evaluation budget;
- feedback policy;
- constraints and deterministic instruments;
- probe or anti-gaming checks when useful.

When no defensible metric exists, authoring must omit progress and use deterministic checks, typed success, evidence, hard bounds, outcome policy, and user review.

A non-isolated evaluation must not be presented as trusted holdout acceptance.

## 4. Goal-control state

The initial domain model is:

```ts
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "completed"
  | "failed"
  | "cancelled";

export interface GoalBudget {
  maxTokens?: number;
  maxTurns?: number;
}

export interface GoalRuntime {
  goalId: string;
  workflowId: string;
  status: GoalStatus;
  tokensUsed: number;
  turnsUsed: number;
  continuationOrdinal: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stopReason?: string;
}
```

Commands supply timestamps and usage values. The reducer remains pure.

## 5. Commands and events

Domain commands:

- `start-goal`;
- `account-goal-turn`;
- `pause-goal`;
- `resume-goal`;
- `cancel-goal`.

Domain events:

- `hypagraph.goal.started`;
- `hypagraph.goal.turn-accounted`;
- `hypagraph.goal.paused`;
- `hypagraph.goal.resumed`;
- `hypagraph.goal.budget-reached`;
- `hypagraph.goal.blocked`;
- `hypagraph.goal.completed`;
- `hypagraph.goal.failed`;
- `hypagraph.goal.cancelled`.

Every status change and stop reason must be event-backed and replayable.

## 6. Vertical slices

Each slice crosses all affected domain, reducer, projection, persistence, Pi, test, and documentation layers.

### Slice 1 - Canonical goal lifecycle

Add goal runtime types, commands, events, reducer logic, projection, schema migration, workflow-derived terminal status, replay, and state-hash tests.

Done when a manually driven workflow produces the correct goal terminal state through replay and no model action can mark the goal complete.

### Slice 2 - Atomic `/hypagoal` creation

Add command parsing, `hypagoal_start`, repository inspection guidance, atomic workflow-plus-goal creation, replacement confirmation, and strict validation.

An invalid graph must create no canonical workflow or goal state.

Done when one prose objective creates a valid graph-backed goal in a real Pi turn.

### Slice 3 - Graph-aware continuation

Add pure continuation decisions, one queued follow-up, `agent_end` delivery, active-task guidance, ready-task/check/gate guidance, dynamic tool exposure, and stale-continuation rejection.

Done when a multi-node workflow completes without manual continuation prompts.

### Slice 4 - Budgets and reload safety

Add token accounting, turn accounting, final-turn accounting, budget events, wrap-up guidance, reload pause, branch-change pause, explicit resume, and session-generation tests.

A budget stop is not success. Restore must not run work.

Done when token limits, turn limits, reload, and branch changes produce deterministic stop behavior.

### Slice 5 - Loop and trusted-evaluation continuation

Add continuation guidance for:

- generic loop state;
- current and best metric;
- patience;
- invalid-evaluation count;
- evaluation purpose and trust;
- feedback mode;
- evaluation budgets;
- hard-limit, no-progress, invalid-evaluation, evaluation-error, and evaluation-budget stops;
- independent loop components;
- explicit loop failure policy.

Done when Hypagoal runs both an optimization or refinement region and an independent auxiliary region, preserves their state independence, rejects an invalid score, and completes through typed success.

### Slice 6 - Blockage and bounded revision

Add blocked-goal projection, revision guidance, original-objective preservation, one bounded automatic revision attempt, stale-result protection, and clear diagnostics.

A revision cannot silently change the user objective. The first release must not replan without bound.

Done when a blocked graph either returns to a valid path through one revision or stops with a clear blocker.

### Slice 7 - Complete Pi product surface

Add compact lifecycle messages and:

- `/hypagoal status`;
- `/hypagoal pause`;
- `/hypagoal resume`;
- `/hypagoal cancel`;
- `/hypagoal graph`;
- graph-pane goal details;
- budget, loop, evaluation, and stop-state summaries;
- narrow and wide terminal coverage.

Done when a user can understand the active action, remaining budget, loop and evaluation state, and stop reason without event inspection.

### Slice 8 - Dogfood and release

The final dogfood path must:

1. Start from one prose `/hypagoal` command.
2. Define a graph with at least one gate.
3. Run one refinement or optimization region for at least three iterations.
4. Run one independent bounded auxiliary region.
5. Include check-and-repair as one pattern, not the default loop model.
6. Improve one numeric progress metric.
7. Reject one invalid evaluation without updating the best metric.
8. Run a probe or generalization check.
9. Complete through typed success.
10. Prove independent-region state isolation.
11. Restore between iterations.
12. Prove reload-time pause.
13. Prove token-budget and turn-budget termination.
14. Prove evaluation-budget termination.
15. Prove hard-limit and no-progress termination.
16. Prove each loop failure policy.
17. Prove stale-continuation rejection.
18. Prove that the model cannot mark the goal complete.

The release requires the full six-target CI matrix, a dogfood record in `docs`, package and lock-file version alignment, and a tag on the tested main commit.

## 7. Test strategy

Tests must prove:

- deterministic goal events and snapshot hashes;
- workflow-derived completion only;
- one queued continuation;
- user and tool message priority;
- paused and terminal goals cannot continue;
- token and turn budget enforcement;
- reload and branch-change pause;
- stale usage and continuation rejection;
- generic loop continuation;
- independent loop isolation;
- validity, integrity, and evaluation-budget stops;
- bounded revision;
- status and graph-pane behavior;
- no model-selected completion.

## 8. Out of scope for v0.6

The first Hypagoal release does not include:

- parallel autonomous node execution;
- delegated subagents;
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

## 9. Roadmap position

| Phase | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Executable bounded iteration regions |
| M5A | v0.6 | Trusted evaluation contracts and adapter boundary |
| M5B | v0.6 | Hypagoal autonomous controller |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Executor abstraction and production isolated execution |
| M8 | v0.9 | Workspace integration and bounded concurrency |
| M9 | v0.10 | ACP and direct agent adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

M5B starts after the required M5A metric, validity, budget, integrity, and authoring contracts are stable.
