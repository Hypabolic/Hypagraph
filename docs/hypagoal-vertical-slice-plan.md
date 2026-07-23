# Hypagoal vertical-slice plan

- Status: proposed
- Proposed milestone: M5
- Proposed release marker: v0.6
- Prerequisite: M4 executable bounded loops
- Research source: https://github.com/Michaelliv/pi-goal
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This plan adds a `/hypagoal` mode to Hypagraph.

The user supplies one durable objective. Hypagraph converts that objective into an executable workflow. The current Pi session then continues work until the workflow reaches a terminal state or a deterministic stop condition applies.

Hypagoal must use the full Hypagraph runtime. It must use node contracts, typed facts, deterministic gates, evidence, checks, bounded loops, progress rules, and replay.

Hypagoal must not add a second execution model beside Hypagraph.

## 2. Decision

Hypagraph must add `/hypagoal` as an autonomous controller over one canonical Hypagraph workflow.

Hypagoal is not a prose continuation loop. It is not a new workflow type. It is not a new node kind.

The workflow remains the source of truth for work. The goal controller only decides whether Pi can request another agent turn.

The runtime must derive goal completion from canonical workflow state. A model must not mark the goal complete directly.

## 3. Research result

The `pi-goal` project proves that a small `/hypagoal` surface is useful in Pi.

Useful product patterns include:

- `/hypagoal <objective>`;
- `/hypagoal status`;
- pause, resume, and clear controls;
- optional token budgets;
- compact lifecycle messages;
- full model-visible continuation instructions;
- automatic follow-up turns in the same session;
- session-scoped persistence;
- reload-time pause;
- goal tools that are visible only when they apply.

Hypagraph must adopt these interaction patterns where they fit.

Hypagraph must not adopt these control rules:

- one prose string as the complete work model;
- prompt-only evidence auditing;
- model-selected completion;
- unstructured iteration state;
- a goal lifecycle that is independent of the workflow runtime.

Hypagraph already has stronger control primitives. It has explicit node contracts, typed facts, deterministic gates, evidence-backed verification, revisions, declared loops, and an append-only event stream.

## 4. Product result

At the end of this milestone, a Pi user can:

1. Start a durable goal from one `/hypagoal` command.
2. Let the model inspect the repository and define a valid Hypagraph workflow.
3. Continue through tasks, checks, and gates without a new user prompt for each turn.
4. Run bounded repair loops.
5. Use a typed success condition for each loop.
6. Use a numeric progress or loss fact when the workflow has a defensible metric.
7. Stop after success, failure, blockage, cancellation, a token budget, a turn budget, a hard loop limit, or a patience limit.
8. Pause and resume goal continuation.
9. Restore a session without silent autonomous work.
10. Inspect the goal in the existing graph pane.
11. Replay the same goal state and stop decision from events.
12. Verify that a model cannot mark the goal complete directly.

## 5. Architectural model

### 5.1 Keep one workflow definition

Use `HypagraphDefinition.goal` as the human-readable objective.

Use the graph as the executable contract.

Do not create a second goal definition that duplicates:

- node intent;
- acceptance criteria;
- checks;
- evidence;
- facts;
- gates;
- loop rules;
- scopes;
- dependencies.

### 5.2 Add canonical goal-control state

Add a goal-control runtime to `HypagraphState` after M4 is complete.

The initial model is:

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
  timeUsedSeconds: number;
  continuationOrdinal: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stopReason?: string;
}
```

The command must supply time and usage values. The reducer must remain pure.

### 5.3 Keep workflow state authoritative

The workflow phase and loop state control the goal result.

Use these derivations:

- workflow `completed` -> goal `completed`;
- workflow `failed` -> goal `failed`;
- workflow `cancelled` -> goal `cancelled`;
- workflow `blocked` with no permitted action -> goal `blocked`;
- exhausted goal budget -> goal `budget_limited`;
- workflow `paused` or user pause -> goal `paused`.

Do not add a public command that completes a goal.

Do not add a model tool that completes a goal.

### 5.4 Keep the continuation decision pure

Add a pure decision function:

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

The function must not:

- call Pi;
- read the clock;
- create an ID;
- change state;
- run a process;
- inspect files;
- select semantic implementation work.

The Pi adapter applies the decision after the current agent turn ends.

### 5.5 Use one queued continuation

The Pi adapter must queue no more than one continuation.

It can queue a continuation only when:

- the goal status is `active`;
- the workflow is not terminal;
- no pending Pi message exists;
- no continuation is already queued;
- the active session generation still matches;
- the budget permits another substantive turn.

A session branch change must invalidate a queued continuation.

### 5.6 Separate control text from user data

The continuation message must contain deterministic control instructions.

The message must delimit the user objective and workflow text as task data.

Example:

```text
Continue the active Hypagraph goal.

Objective:
<untrusted_goal>
Implement and verify the parser migration.
</untrusted_goal>

Canonical state:
- Workflow phase: running
- Active node: implement-parser
- Ready checks: none
- Ready gates: none
- Loop: repair-tests, iteration 3 of 6
- Current metric: 4 failing tests
- Best metric: 7 failing tests at iteration 2
- Remaining patience: 2

Complete the current node contract.
Work only in its declared scope.
Do not claim goal completion.
The controller derives completion from canonical workflow state.
```

## 6. Commands, tools, and events

### 6.1 Domain commands

Add these commands:

- `start-goal`;
- `account-goal-turn`;
- `pause-goal`;
- `resume-goal`;
- `cancel-goal`.

Do not add `complete-goal`.

### 6.2 Domain events

Add these events:

- `hypagraph.goal.started`;
- `hypagraph.goal.turn-accounted`;
- `hypagraph.goal.paused`;
- `hypagraph.goal.resumed`;
- `hypagraph.goal.budget-reached`;
- `hypagraph.goal.blocked`;
- `hypagraph.goal.completed`;
- `hypagraph.goal.failed`;
- `hypagraph.goal.cancelled`.

The event stream must store each stop decision.

Replay must not calculate a different stop result from later state.

### 6.3 Atomic goal creation tool

Add a Pi tool such as `hypagoal_start`.

The initial input is:

```ts
{
  definition: HypagraphDefinition;
  tokenBudget?: number;
  turnBudget?: number;
}
```

The operation must create the workflow and start goal control in one durable operation.

This rule prevents an active goal from existing without an executable workflow.

Keep `hypagraph_define` for manually controlled workflows.

### 6.4 Pi command surface

Add:

```text
/hypagoal [--tokens 50k] [--turns 40] <objective>
/hypagoal
/hypagoal status
/hypagoal pause
/hypagoal resume
/hypagoal cancel
/hypagoal graph
```

Use these rules:

- `/hypagoal <objective>` starts a planning turn.
- The model inspects the repository before it defines the workflow.
- The model calls `hypagoal_start` with the complete definition.
- The command asks for confirmation before it replaces a non-terminal goal.
- `/hypagoal pause` stops continuation and keeps all state.
- `/hypagoal resume` enables continuation.
- `/hypagoal cancel` is terminal and event-backed.
- `/hypagoal graph` opens the existing graph pane.
- `/hypagoal` and `/hypagoal status` show the canonical goal state.

Do not use a clear command to delete canonical history.

A later view command can hide a terminal goal without changing canonical state.

## 7. Goal authoring rules

Extend the bundled Hypagraph skill with goal authoring guidance.

Translate a user objective into these graph elements:

| Goal contract element | Hypagraph representation |
| --- | --- |
| Outcome | `definition.goal` and terminal workflow state |
| Verification surface | Check nodes and evidence-gated verification |
| Constraints | Node acceptance criteria and workflow policy |
| Boundaries | Node scopes |
| Dependencies | Graph edges |
| Conditional behavior | Typed gates |
| Iteration policy | Declared loop regions |
| Loop success | Typed loop success condition |
| Progress or loss | Numeric fact and loop progress definition |
| Blocked stop condition | Blocked node or workflow state |
| Resource limit | Goal token and turn budgets |

Hypagoal must apply stronger validation than a manually controlled guided workflow.

The validator must require:

- each reachable terminal path to finish with a check or an evidence-gated verification node;
- each terminal task to have acceptance criteria;
- each deliberate cycle to use a declared loop;
- each loop to have a typed success condition;
- each loop to have a hard iteration limit;
- each progress rule to use a numeric typed fact;
- each required fact to have a valid producer;
- each mutating task to have a declared scope in strict mode.

The workflow must not depend on a narrative completion claim.

## 8. Loss and progress rules

Use the M4 loop progress definition:

```ts
export interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}
```

Do not add model-scored loss.

Do not extract loss from unstructured text.

Use a progress rule only when the workflow has a defensible numeric fact.

Example:

```text
implement
   |
   v
run-tests ---- publishes tests.failed and tests.passed
   |
   v
successWhen: tests.passed == true
progress: minimize tests.failed
patience: 2
maxIterations: 6
```

The loop runtime decides whether to:

- complete;
- continue;
- stop at the hard limit;
- stop after no progress;
- fail because evaluation data is invalid.

The goal controller only requests the next Pi turn.

When no valid numeric metric exists, omit the progress rule. Use the typed success condition, the hard iteration limit, and the goal budget.

## 9. Reload, branch, and recovery rules

An active goal must pause after a Pi reload.

An active goal must pause after a session branch change.

The user must run `/hypagoal resume` before autonomous continuation starts again.

Restore must not:

- start a task;
- run a check;
- evaluate a gate;
- start a loop iteration;
- queue a continuation before user resume.

A late result from an old session generation must not change current state.

A queued continuation from an old session generation must not start a new turn.

## 10. Budget rules

The initial goal budget can contain:

- a token limit;
- a turn limit.

Track elapsed time for display and audit. Do not use elapsed time as a hard limit in the first release.

Count all model usage that Pi reports for the turn. Include cache read and cache write tokens when Pi does not provide one total value.

Account the final turn before the runtime applies the terminal result.

When a budget is reached:

1. Store the final usage event.
2. Set the goal status to `budget_limited`.
3. Do not start new substantive work.
4. Send one wrap-up turn when the current turn did not already provide a useful result.
5. Report completed work, remaining work, blockers, and the next required input.

A budget limit must not mark the workflow complete.

## 11. Revision rules

The original user objective must remain stable across graph revisions.

A revision can change the executable plan. It cannot silently change the goal objective.

The first release must not allow unlimited autonomous revisions.

Use this initial rule:

- a blocked or invalid workflow pauses Hypagoal;
- the continuation message can request one explicit graph revision action;
- if the revision does not restore a valid executable path, the goal stops as blocked.

A later release can add a bounded revision budget.

## 12. Product surface

### 12.1 Status line

Show a compact line such as:

```text
Goal active | 18.4K/50K | repair-tests 3/6 | run-tests
```

### 12.2 Lifecycle messages

Show compact lifecycle messages for:

- goal started;
- goal continuing;
- goal paused;
- goal resumed;
- goal blocked;
- goal budget reached;
- goal completed;
- goal failed;
- goal cancelled.

The compact message is for the user. The full message content is for the model and the audit history.

### 12.3 Graph pane

Add goal details to the existing graph pane.

Show:

- goal status;
- token and turn budget use;
- active node;
- ready frontier;
- current loop and iteration;
- current metric;
- best metric and iteration;
- remaining patience;
- terminal stop reason.

The graph pane remains read-only.

## 13. Vertical slices

Each slice must cross all affected layers. These layers include the domain model, reducer, projection, persistence, Pi adapter, user interface, tests, and documentation.

### Slice 1 - Add the canonical goal lifecycle

#### User result

A workflow can have a durable goal-control state.

#### Add

- goal status and runtime types;
- goal commands;
- goal events;
- reducer logic;
- event projection;
- snapshot schema migration;
- workflow-derived completion, failure, blockage, and cancellation;
- replay and state-hash tests.

#### Rules

- The model cannot complete the goal.
- Goal state cannot exist without a workflow.
- The reducer remains pure.
- Every goal state change has an event.

#### Done when

A manually driven workflow produces the correct goal terminal state through replay.

### Slice 2 - Add atomic `/hypagoal` creation

#### User result

A user can start goal planning with one command.

#### Add

- `/hypagoal` command parsing;
- `hypagoal_start`;
- atomic workflow and goal creation;
- replacement confirmation;
- goal authoring guidance;
- strict goal-workflow validation.

#### Rules

- The model must inspect enough repository state before definition.
- The start operation must commit the workflow and goal state together.
- An invalid definition must create no canonical state.

#### Done when

A real Pi turn starts from one prose objective and creates a valid graph-backed goal.

### Slice 3 - Add graph-aware continuation

#### User result

Pi continues through tasks, checks, and gates without a new user prompt.

#### Add

- pure continuation decisions;
- one queued continuation;
- `agent_end` follow-up delivery;
- active-node continuation guidance;
- ready-task, ready-check, and ready-gate guidance;
- dynamic tool exposure;
- stale continuation rejection.

#### Rules

- The adapter cannot queue two continuations.
- A pending user or tool message has priority.
- The controller does not select semantic implementation work.
- The model cannot claim canonical completion.

#### Done when

A multi-node workflow completes without manual continuation prompts.

### Slice 4 - Add budgets and reload safety

#### User result

Hypagoal stops at a token or turn limit and never resumes silently.

#### Add

- token accounting;
- turn accounting;
- final-turn accounting;
- budget events;
- budget wrap-up guidance;
- reload pause;
- branch-change pause;
- explicit resume;
- session-generation tests.

#### Rules

- Restore does not run work.
- A budget stop is not success.
- A stale turn cannot add usage to the current goal.

#### Done when

Token limits, turn limits, reload, and branch changes produce deterministic stop behavior.

### Slice 5 - Integrate loops, loss, and patience

#### User result

Hypagoal can run a check-driven repair loop and stop for the correct reason.

#### Add

- loop state in continuation messages;
- current and best metric display;
- patience display;
- continuation after automatic feedback;
- hard-limit stop handling;
- no-progress stop handling;
- evaluation-error handling.

#### Prerequisite

M4 Slice 5 must be complete.

#### Done when

A repair loop improves a numeric metric and later completes through a typed success condition.

### Slice 6 - Add blockage and revision control

#### User result

A goal can stop honestly when the current graph has no executable path.

#### Add

- blocked goal projection;
- revision guidance;
- original objective preservation;
- one bounded revision attempt in the first release;
- revision and stale-result tests;
- clear blocked diagnostics.

#### Rules

- A revision cannot change the objective without user action.
- The runtime must not continue an invalid graph.
- The first release must not perform unlimited replanning.

#### Done when

A blocked plan either returns to a valid path through one revision or stops with a clear blocker.

### Slice 7 - Complete the Pi product surface

#### User result

A user can understand goal state without raw event inspection.

#### Add

- compact status line;
- lifecycle message renderer;
- `/hypagoal status`;
- `/hypagoal pause`;
- `/hypagoal resume`;
- `/hypagoal cancel`;
- `/hypagoal graph`;
- graph-pane goal details;
- narrow and wide terminal tests.

#### Done when

The Pi surface explains the active action, budget, loop state, and stop reason.

### Slice 8 - Dogfood and release

#### User result

The complete goal path is proven in Pi and released.

#### Required dogfood path

The dogfood run must:

1. Start from one prose `/hypagoal` command.
2. Define a graph with at least one gate.
3. Use one check-driven repair loop.
4. Run at least three loop iterations.
5. Improve one numeric loss metric.
6. Complete through a typed success condition.
7. Restore between two iterations.
8. Prove that reload pauses the goal.
9. Prove token-budget termination.
10. Prove turn-budget termination.
11. Prove hard-limit termination.
12. Prove no-progress termination.
13. Prove stale continuation rejection.
14. Prove that the model cannot mark the goal complete.

#### Release result

- all Hypagoal acceptance tests pass;
- CI passes on Ubuntu, macOS, and Windows;
- CI passes on Node.js 22 and 24;
- the dogfood record is stored in `docs`;
- the package and lock-file versions use the selected release marker;
- the release tag points to a tested main commit.

## 14. Test strategy

### 14.1 Determinism

Tests must prove:

- the same state and command produce the same goal events;
- the same ordered events produce the same snapshot hash;
- replay produces the same goal stop reason;
- continuation decisions do not read the clock;
- continuation decisions do not call Pi;
- a model response cannot directly change goal status.

### 14.2 Safety properties

Tests must prove:

- only one continuation can be queued;
- a paused goal cannot queue a continuation;
- a terminal goal cannot queue a continuation;
- a budget-limited goal cannot start new work;
- a reload cannot silently resume a goal;
- a branch change rejects stale continuation and stale results;
- a workflow cannot complete from narrative text alone;
- a loop cannot run without a hard limit;
- a progress rule cannot use untyped text;
- a revision cannot silently change the user objective.

### 14.3 Product behavior

Tests must cover:

- goal creation from one Pi command;
- replacement confirmation;
- status output;
- pause and resume;
- cancellation;
- graph-pane display;
- active-task continuation;
- ready-check continuation;
- ready-gate continuation;
- loop continuation;
- completion;
- failure;
- blockage;
- budget wrap-up.

## 15. Out of scope for the first release

The first Hypagoal release does not include:

- parallel autonomous node execution;
- delegated subagents;
- Agent Communication Protocol execution;
- named command-line agent adapters;
- model-scored success;
- model-scored loss;
- loss extraction from unstructured text;
- unlimited autonomous graph revision;
- automatic restoration of the best workspace state;
- time-based hard budgets;
- more than one active goal in one Pi session;
- automatic resume after reload;
- deletion of canonical goal history.

## 16. Roadmap position

Implement Hypagoal after M4.

Hypagoal depends on executable bounded loops, typed success conditions, hard iteration limits, progress metrics, and patience rules.

Implement Hypagoal before delegated execution.

This order proves the single-session controller, continuation rules, stop semantics, and graph contract before Hypagraph distributes node execution across other agents.

Use this proposed sequence:

| Milestone | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Executable bounded loops |
| M5 | v0.6 | Hypagoal |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Executor abstraction and isolated Pi execution |
| M8 | v0.9 | Workspace integration and bounded concurrency |
| M9 | v0.10 | Agent Communication Protocol adapter and direct adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

## 17. Exit criteria

Hypagoal is complete when:

- `/hypagoal` creates one canonical workflow and goal-control state;
- the workflow graph is the executable contract;
- the runtime derives goal completion;
- the model cannot mark the goal complete;
- Pi continues through active tasks, ready tasks, checks, and gates;
- only one continuation can be queued;
- token and turn budgets stop work deterministically;
- reload and branch changes pause the goal;
- loop success uses a typed condition;
- loop progress uses a typed numeric fact;
- hard limits and patience stop repair loops;
- goal state survives restore and replay;
- the graph pane shows goal, budget, and loop state;
- the complete dogfood path passes;
- the release tag points to a tested main commit.
