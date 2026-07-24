# Session handoff: M5B Slice 3 complete to Slice 4

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `836ac10ea8c13c6b0839902d175f718359d1bd07`
- Last merged pull request: #67 — Add graph-aware Hypagoal continuation
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 3, graph-aware continuation
- Current slice: M5B Slice 4, budgets and reload safety
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/hypagoal-vertical-slice-plan.md`;
4. `docs/goal-family-and-concurrent-execution-plan.md`;
5. `docs/product-spec.md`;
6. `docs/delegation-and-visualisation.md`;
7. `docs/automatic-graph-authoring.md`;
8. `docs/loop-region-product-model.md`;
9. `docs/trusted-evaluation-contract-plan.md`;
10. `docs/execution-roadmap.md`;
11. `docs/m5b-slice-3-dogfood.md`.

Use issue #25 as the active M5B checklist.

The goal-family plan remains authoritative for later family budgets, descendant accounting, child goals, isolated executors, worktrees, and physical concurrency. Slice 4 must preserve compatible usage identity without implementing those later aggregates.

## 2. Product decisions that must not change

### 2.1 Goal lifecycle remains workflow-local

Each Hypagoal owns one canonical Hypagraph workflow.

The existing `GoalRuntime` remains the workflow-local lifecycle for the root and every future child goal. Slice 4 can add workflow-local budget and usage state, but it must not add parent, child, family, executor, workspace, or scheduler ownership fields.

`HypagraphDefinition.goal` remains the human-readable objective. Lifecycle and budget state remain separate under `goalControl` or another explicit structured field.

There is no goal node, second task model, duplicate workflow definition, parallel completion state machine, `complete-goal` command, or model-owned terminal state.

### 2.2 Budget exhaustion is a stop, not success

Token or turn exhaustion must stop autonomous continuation deterministically.

Budget exhaustion must not:

- mark the workflow completed;
- satisfy a task, check, gate, or loop;
- replace workflow-derived goal completion;
- present cancellation as success;
- discard the reason, limit, or consumed amount.

The stop must be event-backed, replayable, and visible through goal-control state.

### 2.3 Usage accounting is explicit and reproducible

The reducer must not read Pi messages, a clock, token counters, or model metadata directly.

The Pi adapter supplies normalized usage observations through explicit commands. Domain logic validates and stores those observations.

At minimum, usage identity must distinguish:

- goal ID;
- workflow ID;
- workflow revision;
- continuation operation or ordinal;
- session generation;
- branch generation;
- turn identity;
- token values and their source or measurement contract.

Use names which can later aggregate child-goal and executor usage into a family budget. Do not assume that every future token is consumed by the root Pi process.

### 2.4 Continuation remains state-bound

Slice 3 delivered one durable continuation request before each Pi follow-up.

Slice 4 must account for a turn against the exact continuation which caused it. Stale usage observations must not mutate current state.

Budget decisions must run before another continuation request is stored. A continuation cannot be queued when the next turn would exceed a hard turn limit or when the current token budget is exhausted.

### 2.5 Final-turn and wrap-up behavior is bounded

If the product permits one final wrap-up turn near a budget boundary, that permission must be explicit, deterministic, and counted.

Do not create an uncounted summary turn or a prose-only exemption. A final turn cannot perform new semantic implementation work unless the declared policy permits it.

### 2.6 Reload and branch changes pause autonomous work

Session reload and branch change must invalidate pending continuation delivery and pause an active goal before another autonomous turn can run.

Restore still rebuilds canonical state only. It must not queue a continuation, dispatch model work, run a check, invoke an executor, resume a component, or start a subagent.

A user must explicitly resume after reload or branch change. Resume must re-evaluate current canonical state and budgets before it can queue work.

### 2.7 Independent components remain independent

The Slice 3 selector remains canonical for runnable root work.

Budget or reload handling must not reset, release, fail, complete, or transfer ownership between disconnected branches or independent loop components. A global root budget can stop further dispatch without rewriting component-local state.

### 2.8 Existing loop and evaluation budgets remain separate

Goal token and turn budgets are not loop iteration limits or evaluator budgets.

Do not merge:

- model token usage;
- substantive continuation turns;
- loop iteration count;
- evaluation attempt budget;
- invalid-evaluation count;
- patience or no-progress limits.

Each counter keeps its own event and policy semantics.

## 3. M5B Slice 3 delivered

PR #67 adds graph-aware root continuation.

The merged implementation provides:

- `src/domain/goal-continuation.ts` with a pure workflow-local selector;
- typed runnable and stop decisions;
- explicit goal, workflow, revision, sequence, snapshot, ordinal, node, and loop identity;
- stable definition-order candidate enumeration;
- event-backed round-robin selection through `GoalRuntime.continuationOrdinal`;
- `hypagraph.goal.continuation-requested`;
- `request-goal-continuation` with stale-state validation;
- one Pi scheduling authority in `agent_end`;
- state-bound delivery in `before_agent_start`;
- user-message priority;
- no-progress stop behavior;
- stale-delivery protection and mutating-tool blocking;
- dynamic continuation tool exposure and restoration;
- deterministic selection across disconnected branches and independent loop components;
- replay and restore compatibility;
- realistic Pi command-to-tool smoke evidence.

### Slice 3 implementation map

- `src/domain/check-policy.ts`: pure immediate check-start eligibility used by the selector.
- `src/domain/goal-continuation.ts`: candidate enumeration, selection, stop decisions, and action matching.
- `src/domain/model.ts`: continuation action, command, and event contracts.
- `src/domain/reducer.ts`: canonical request validation and event creation.
- `src/domain/projection.ts`: continuation ordinal projection.
- `src/pi/hypagoal-continuation.ts`: pending action, prompt, delivery validation, and action guidance.
- `src/extension.ts`: one queued follow-up, user priority, stale protection, and tool exposure.
- `tests/hypagoal-continuation.test.ts`: pure selector, replay, restore, identity, and independent-loop fairness.
- `tests/hypagoal-continuation-pi.test.ts`: Pi scheduling, user priority, stale delivery, no progress, restore, and routed smoke.
- `docs/m5b-slice-3-dogfood.md`: executable evidence.

### Slice 3 evidence

Implementation baseline:

```text
836ac10ea8c13c6b0839902d175f718359d1bd07
```

CI #770 and final PR CI #772 passed:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 85 test files and 357 tests.

## 4. Current architecture map

### Workflow-local domain

- `src/domain/model.ts`: workflow, goal, loop, evaluation, continuation, command, and event contracts.
- `src/domain/reducer.ts`: canonical state transitions and stale request validation.
- `src/domain/projection.ts`: deterministic replay and snapshot hashing.
- `src/domain/goal-policy.ts`: workflow-derived goal outcome policy.
- `src/domain/goal-continuation.ts`: pure runnable-action selection.
- `src/domain/check-policy.ts`: canonical check-start policy.

### Pi controller

- `src/extension.ts`: creation, continuation scheduling, tool delivery, session events, and UI.
- `src/pi/hypagoal.ts`: root creation schema and presentation.
- `src/pi/hypagoal-continuation.ts`: pending continuation identity and prompt guidance.

### Persistence and recovery

- `src/persistence/event-store.ts`: optimistic event append and branch leases.
- `src/persistence/pi-session-store.ts`: Pi session event batches.
- `src/persistence/session-rebuild.ts`: replay, snapshot verification, loop validation, and goal validation.

### Future seam

The current Pi adapter accounts only the root Pi session. Slice 4 must use additive usage contracts which a later family aggregate can sum across root, child, and executor sources. It must not add the family aggregate now.

## 5. Current task: M5B Slice 4 — budgets and reload safety

### 5.1 User result

A user can configure or receive bounded autonomous execution. Hypagraph counts substantive continuation turns and normalized token usage, stops before another over-budget continuation, records the exact stop reason, and does not silently resume after a reload or branch change.

### 5.2 Domain budget model

Add the smallest workflow-local budget state required for v0.6.

It should represent at least:

- optional maximum substantive turns;
- consumed substantive turns;
- optional maximum tokens;
- consumed input, output, cached, or total tokens according to one documented normalization contract;
- final-turn or wrap-up allowance when supported;
- budget stop reason and relevant limit;
- last accounted continuation or turn identity.

Do not duplicate evaluator budgets or loop limits.

### 5.3 Commands and events

Prefer explicit commands and events for:

- configuring or starting goal budgets where the current creation contract requires it;
- recording one completed continuation turn and its usage;
- recording a deterministic budget stop;
- pausing because the session reloaded;
- pausing because the active branch changed;
- resuming explicitly after validation.

All timestamps, usage values, operation IDs, and session or branch generations enter through commands. Pure reducers generate no external values.

A duplicate or stale usage report must be rejected without double charging.

### 5.4 Accounting boundary

Define exactly which Pi activity counts as a substantive Hypagoal turn.

The default should count the model turn caused by a durable continuation request. Root creation, graph inspection, user-only messages, stale rejected delivery, restore, and internal UI updates must not consume a substantive turn unless the documented policy explicitly says otherwise.

Account the completed turn once. Include failed, interrupted, or no-progress turns when they consumed model execution, unless Pi cannot provide trustworthy usage and the limitation is documented.

### 5.5 Pre-dispatch decision

Before storing another continuation request, evaluate canonical budget state.

The controller must choose one of:

- dispatch the normal selected action;
- dispatch one explicitly permitted final or wrap-up turn;
- stop as turn-budget-limited;
- stop as token-budget-limited;
- stop because required usage data is invalid or stale.

Budget state must not alter the Slice 3 component selector. It decides whether the selected action can be dispatched, not which component semantically owns work.

### 5.6 Reload and branch-change pause

On `session_start` restore and `session_tree` branch change:

1. invalidate adapter-local pending and delivered continuations;
2. rebuild and validate canonical state;
3. if a non-terminal goal was active, persist an explicit pause reason before autonomous work can resume;
4. do not send a follow-up;
5. require explicit resume;
6. re-check budget and current runnable state after resume.

Do not use an adapter-only boolean as the canonical pause record.

### 5.7 Pi integration

Use Pi-provided usage metadata where available. Normalize it once at the adapter boundary and test absent, partial, malformed, and repeated data.

The Pi adapter must not infer success from token exhaustion. It should display a clear stop or pause message with consumed and maximum values.

Keep at most one queued continuation and preserve every Slice 3 stale-delivery rule.

### 5.8 Required tests

Add focused domain, persistence, Pi, and integration tests proving:

- turn usage is recorded once per durable continuation;
- duplicate usage cannot double charge;
- stale goal, workflow, revision, sequence, snapshot, session, branch, continuation, or turn identity is rejected;
- token normalization is deterministic;
- absent or malformed usage follows explicit policy;
- the final permitted turn is counted;
- no continuation is queued when a hard budget is exhausted;
- budget exhaustion is not workflow completion;
- replay and restore reproduce usage and stop state;
- reload pauses an active goal and queues no work;
- branch change pauses an active goal and queues no work;
- terminal goals are not rewritten by reload handling;
- explicit resume re-checks canonical budget and runnable state;
- independent components keep their own lifecycle while the root budget stops dispatch;
- loop limits and evaluation budgets remain unchanged;
- a realistic Pi smoke stops at a turn limit;
- a realistic Pi smoke stops at a token limit;
- a restore smoke proves no silent continuation after reload.

### 5.9 Deferred from Slice 4

Do not add:

- detailed loop and trusted-evaluation continuation guidance from Slice 5;
- automatic graph revision;
- child Hypagoals or family persistence;
- family budget aggregation;
- executor or subagent usage accounting;
- worktree leases;
- physical concurrency;
- the complete administrative `/hypagoal` surface;
- release packaging or a v0.6 tag.

### 5.10 Done when

Slice 4 is complete when:

- token and substantive-turn usage is event-backed and replayable;
- every counted turn maps to an explicit continuation identity;
- duplicate and stale usage cannot mutate current state;
- budget exhaustion prevents another continuation and remains distinct from success;
- reload and branch change persist a pause and queue no work;
- explicit resume re-checks current budgets and runnable state;
- the contracts can later aggregate descendant usage without replacing workflow-local history;
- realistic Pi budget and reload smoke tests pass;
- the full six-target CI matrix passes.

Suggested branch:

```text
agent/m5b-slice-4-budgets-reload-safety
```

Suggested pull request title:

```text
Add Hypagoal budgets and reload safety
```

## 6. Work after Slice 4

Continue M5B in this order:

1. Slice 5: loop and trusted-evaluation continuation details and fairness.
2. Slice 6: blockage and bounded revision.
3. Slice 7: complete Pi product surface.
4. Slice 8: dogfood and v0.6 release.

After v0.6:

1. M6: event history, replay, and debugger UI.
2. M7: family persistence, bounded child Hypagoals, executor abstraction, and isolated Pi execution.
3. M8: worktree integration and bounded concurrent scheduling.

Do not tag or release v0.6 during Slice 4.
