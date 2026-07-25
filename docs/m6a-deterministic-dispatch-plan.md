# M6A deterministic dispatch lane vertical-slice plan

- Status: active
- Milestone: M6A
- Release marker: v0.7
- Prerequisite: v0.6
- Must complete before: M6B event history, replay, and debugger UI
- Analysis source: `docs/graph-capability-review.md` section 7
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

M6A removes the model turn from every canonical action which needs no reasoning.

The orchestration is already deterministic. The continuation selector is a pure function of canonical state. The model cannot select a route or complete a goal. The remaining cost is dispatch, not orchestration.

The controller delivers every selected action as a Pi follow-up, and it charges one substantive turn for each delivery. Two of the four work actions need no reasoning:

- `run-ready-check` runs through `runPiCheck`, which is a function of state, executor, and store;
- `evaluate-ready-gate` is one `evaluate-gate` reducer command.

The model turn exists only to make the tool call.

## 2. Product result

A workflow with three tasks, four checks, and two gates costs three model turns instead of nine.

The canonical result does not change. The events which describe node and check lifecycle do not change. Replay produces the same state.

The user sees that consumed turns count model work only.

## 3. Problem statement in the current code

The current continuation lifecycle closes only through a delivered model turn.

1. `queueGoalContinuation` stores a `request-goal-continuation` event and then sends a Pi follow-up.
2. `before_agent_start` validates the pending continuation and delivers it.
3. `agent_end` normalizes Pi usage and stores `record-goal-turn-usage`.
4. The projection rejects a turn-recorded event when no pending continuation exists, with the message "A turn-recorded event requires a pending continuation."
5. The turn-recorded event increments the consumed turn count, records the accounted turn, and advances the continuation ordinal.

A directly dispatched action produces no Pi usage. It cannot use step 3, so it cannot close the continuation which step 1 created.

An earlier version of the analysis stated that this milestone does not change the reducer or the events. That statement is wrong. This milestone changes the dispatch event model. Section 4 gives the replacement contract.

## 4. Generic action dispatch

An earlier version of this plan offered two narrow options: add a continuation-completion event, or create no continuation event for a deterministic action. Both keep "continuation" as the name for every dispatched action. That name becomes wrong as execution becomes broader, because M7 adds executor attempts and M8 adds concurrent attempts which are not Pi continuations.

Use a generic dispatch model instead. It gives the inspection value of a completion event without treating every action as a Pi continuation.

### 4.1 Contract

```ts
export type DispatchLane = "deterministic" | "model" | "executor";

export interface ActionDispatch {
  dispatchId: string;
  action: ScheduledAction;
  lane: DispatchLane;
  selectedSequence: number;
  selectedSnapshotHash: string;
  schedulerOrdinal: number;
}
```

### 4.2 Events

Use one lifecycle for every lane:

```text
action selected
    |
    v
action dispatched
    |
    v
action completed, failed, or interrupted
```

A model-backed action records model usage in addition. A deterministic action does not.

### 4.3 Why this is better

- one audit trail for M6B, across every lane;
- a scheduler ordinal which is independent from model-turn accounting, so round-robin fairness is preserved without the turn event;
- a direct extension into M7 isolated executors and M8 bounded concurrency, because the executor lane already exists in the model;
- no need to redefine "continuation" as execution becomes broader.

### 4.4 Migration from the current model

The current `request-goal-continuation` and `record-goal-turn-usage` events become the model lane of this contract. Keep their data. Keep exactly-once turn accounting for the model lane.

The continuation ordinal becomes the scheduler ordinal. It advances for every dispatched action in every lane. This keeps the M5B fairness property and removes the coupling between fairness and model usage.

Restate the M5B invariant in lane terms: each delivered model-lane action is charged once through a durable usage event before another model-lane action can be dispatched. A deterministic-lane action is never charged.

### 4.5 Schema and compatibility

This is a schema change. Provide a migration from schema version 5, or an explicit rejection path, as `AGENTS.md` requires.

A v0.6 event stream contains continuation and turn events only. Migration must project them into the model lane and must produce the same canonical state.

## 5. Mandatory rules

### 5.1 Keep the reducer pure

The reducer must not run a check, call an executor, or read the clock. Direct dispatch belongs to the controller, exactly as check execution does today.

### 5.2 Keep the durable order

A directly dispatched check must keep the existing durable order: store the check start, run the bounded external effect, store the raw result and evidence, publish declared facts, then store verification and the loop decision.

Hypagraph must not start an external check when it cannot first store the check-start event. Direct dispatch does not relax this rule.

### 5.3 Keep a bound on execution

A model turn is currently a bound. A budget stops autonomous continuation. A deterministic action consumes no turn, so it does not consume that bound.

The runtime must still stop. Loop iteration limits, patience, evaluation budgets, and check retry limits remain the bound for deterministic work. Confirm with a test that a graph without a task cannot run without a bound.

Add an explicit maximum for consecutive deterministic dispatches in one controller pass. This protects against an authoring error which creates a large deterministic cycle.

### 5.4 Keep cancellation

A directly dispatched check must remain cancellable through the existing active-execution registry and `/hypagraph check cancel`.

### 5.5 Keep the manual surface

`hypagraph_run_check` and the evaluate action of `hypagraph_transition` remain available. A user or a model can still run a check or a gate explicitly.

### 5.6 Do not dispatch during a delivered model turn

The controller must not dispatch a deterministic action while a model turn is in flight. The existing active-execution guard and the pending-continuation guard both apply.

### 5.7 State the accounting change in the product surface

Consumed turns count model turns only. `/hypagoal status` must say so. A user who compares node count with turn count must not think that work is missing.

## 6. Vertical slices

### Slice 1 - Generic dispatch model and the model lane

Scope:

1. Add the `ActionDispatch` contract and the selected, dispatched, and completed events from section 4.
2. Move the scheduler ordinal off the turn event.
3. Project the existing continuation and turn events into the model lane.
4. Add the schema migration or the explicit rejection path.

This slice changes no behaviour. It changes the event model only. Every existing test must still pass.

Tests:

- a v0.6 event stream migrates and produces the same canonical state;
- exactly-once turn accounting holds for the model lane;
- the scheduler ordinal advances without a turn event;
- round-robin fairness across independent components is unchanged;
- replay produces the same state and the same stop decision.

Exit: the event model supports a lane which is not the model lane, and nothing yet uses it.

### Slice 2 - Direct gate evaluation

Scope:

1. Dispatch `evaluate-ready-gate` in the deterministic lane.
2. Select again after the gate resolves.
3. Add the consecutive-dispatch maximum from rule 5.3.

A gate is the smallest case. It is one reducer command with no external effect, no artifacts, and no cancellation.

Tests:

- a ready gate resolves without a Pi follow-up;
- the gate publishes the same route event as the current path;
- consumed turns do not increase;
- the scheduler ordinal advances for the deterministic action;
- an independent component still receives its turn in rotation;
- replay reproduces the same route;
- the consecutive-dispatch maximum stops a deterministic cycle.

Exit: a workflow with two gates and one task costs one model turn.

### Slice 3 - Direct check execution

Scope:

1. Dispatch `run-ready-check` directly through the existing durable lifecycle.
2. Keep cancellation, retry, backoff, artifacts, and evaluation budgets unchanged.
3. Keep protected evaluator redaction unchanged.

Tests:

- a ready check runs, stores its start event, and records its result without a Pi follow-up;
- a failed check with a retry policy retries under the existing policy;
- cancellation stops a directly dispatched check;
- an interrupted check recovers through the existing recovery path;
- a metric evaluation consumes evaluation budget exactly once;
- protected evaluator output stays protected.

Exit: a bounded iteration region completes several iterations and consumes model turns only for its task nodes.

### Slice 4 - Accounting, budgets, and surfaces

Scope:

1. Update the budget surface so that consumed turns describe model turns.
2. Update `/hypagoal status` and the model-visible summary.
3. Confirm budget exhaustion behaviour with a deterministic-only remainder.
4. Confirm the no-canonical-progress guard, which currently compares sequences across a delivered turn.

Tests:

- a goal which reaches its turn limit still completes remaining deterministic work, or stops, according to the recorded decision;
- the no-progress guard does not fire for a deterministic dispatch;
- the status surface explains the turn meaning.

### Slice 5 - Reload, restore, and replay

Scope:

1. Confirm that restore does not dispatch a deterministic action.
2. Confirm that a reload or a branch change still pauses the goal.
3. Confirm replay determinism for a graph which mixes direct dispatch and model turns.

Tests:

- restore rebuilds state and runs nothing;
- replay produces the same state, the same routes, and the same stop decision;
- a stale session or branch generation cannot dispatch.

### Slice 6 - Dogfood and release

Scope:

1. Run one realistic objective which contains tasks, checks, gates, and one iteration region.
2. Record the model-turn count before and after M6A.
3. Record evidence in `docs/m6a-dogfood.md`.
4. Update the README status list and the changelog.

## 7. Acceptance criteria

- A ready check runs without a Pi follow-up and without a charged turn.
- A ready gate evaluates without a Pi follow-up and without a charged turn.
- The reducer stays pure.
- The durable check order does not change.
- Cancellation, retry, recovery, and evaluation budgets do not change.
- Round-robin fairness across independent components holds.
- A deterministic cycle cannot run without a bound.
- Consumed turns count model turns only, and the product surface says so.
- Restore runs no work, and replay reproduces the same canonical state and stop decision.
- The dogfood record shows a measured reduction in model turns.

## 8. Out of scope

- executor abstraction and isolated execution, which belong to M7;
- concurrency, which belongs to M8;
- a code node, which belongs to M6.2;
- any change to node, attempt, check, fact, route, or loop event semantics.
