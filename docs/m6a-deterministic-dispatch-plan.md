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

An earlier version of the analysis stated that this milestone does not change the reducer or the events. That statement is wrong. This milestone changes the continuation event model.

## 4. Design decision to record first

Choose one design before implementation starts. Record the choice in this document.

### Design 1: add a completion event

Add `hypagraph.goal.continuation-completed`. It closes the pending continuation and advances the continuation ordinal without usage accounting.

Advantages:

- one uniform audit trail for every dispatched action;
- the history view in M6B shows every action in one sequence;
- the continuation ordinal keeps one meaning.

Costs:

- one new event type and one new command;
- the projection must accept a continuation which closes without usage;
- the turn count and the continuation count stop being equal, and every surface which assumes they are equal must change.

### Design 2: do not create a continuation request for a deterministic action

The controller dispatches a deterministic action directly and then selects again. A continuation request then means "a model turn is required".

Advantages:

- the accounting question disappears instead of needing an answer;
- `record-goal-turn-usage` keeps its exact current contract;
- the pending-continuation identity rules do not change;
- fewer events for a graph which is mostly checks and gates.

Costs:

- the continuation ordinal no longer advances for a deterministic action, so component fairness must come from a separate rotation;
- the event stream does not record which deterministic action the controller selected, unless the check and gate events are treated as sufficient;
- the M6B history view must derive the selection order from node and check events.

### Recommendation

Design 2 is simpler for accounting. Design 1 is better for inspection, and M6B is an inspection milestone.

The fairness cost of Design 2 is the deciding risk. Round-robin fairness across independent components is an M5B acceptance property, and it currently depends on the continuation ordinal. Design 2 must prove that fairness holds without an ordinal advance.

Prototype the fairness behaviour of Design 2 in Slice 1. If fairness needs a durable rotation value, then Design 2 has re-created the ordinal, and Design 1 is the better choice.

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

### Slice 1 - Direct gate evaluation and the design decision

Scope:

1. Prototype both designs from section 4 against the independent-component fairness tests.
2. Record the decision in section 4 of this document.
3. Dispatch `evaluate-ready-gate` directly in the controller.
4. Select again after the gate resolves.
5. Add the consecutive-dispatch maximum from rule 5.3.

A gate is the smallest case. It is one reducer command with no external effect, no artifacts, and no cancellation.

Tests:

- a ready gate resolves without a Pi follow-up;
- the gate publishes the same route event as the current path;
- consumed turns do not increase;
- an independent component still receives its turn in rotation;
- replay reproduces the same route;
- the consecutive-dispatch maximum stops a deterministic cycle.

Exit: a workflow with two gates and one task costs one model turn.

### Slice 2 - Direct check execution

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

### Slice 3 - Accounting, budgets, and surfaces

Scope:

1. Update the budget surface so that consumed turns describe model turns.
2. Update `/hypagoal status` and the model-visible summary.
3. Confirm budget exhaustion behaviour with a deterministic-only remainder.
4. Confirm the no-canonical-progress guard, which currently compares sequences across a delivered turn.

Tests:

- a goal which reaches its turn limit still completes remaining deterministic work, or stops, according to the recorded decision;
- the no-progress guard does not fire for a deterministic dispatch;
- the status surface explains the turn meaning.

### Slice 4 - Reload, restore, and replay

Scope:

1. Confirm that restore does not dispatch a deterministic action.
2. Confirm that a reload or a branch change still pauses the goal.
3. Confirm replay determinism for a graph which mixes direct dispatch and model turns.

Tests:

- restore rebuilds state and runs nothing;
- replay produces the same state, the same routes, and the same stop decision;
- a stale session or branch generation cannot dispatch.

### Slice 5 - Dogfood and release

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
