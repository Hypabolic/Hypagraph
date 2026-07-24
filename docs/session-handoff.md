# Session handoff: M5B Slice 5 complete to Slice 6

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `2f5ca9dbdc5664f7bcdf455939881d420fb6363e`
- Last merged pull request: #71 — Add loop-aware Hypagoal continuation
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 5, loop and trusted-evaluation continuation
- Current slice: M5B Slice 6, blockage and bounded revision
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/hypagoal-vertical-slice-plan.md`;
4. `docs/automatic-graph-authoring.md`;
5. `docs/event-runtime.md`;
6. `docs/loop-region-product-model.md`;
7. `docs/trusted-evaluation-contract-plan.md`;
8. `docs/goal-family-and-concurrent-execution-plan.md`;
9. `docs/product-spec.md`;
10. `docs/delegation-and-visualisation.md`;
11. `docs/execution-roadmap.md`;
12. `docs/m5b-slice-4-dogfood.md`;
13. `docs/m5b-slice-5-dogfood.md`.

Use issue #25 as the active M5B checklist.

The existing workflow revision reducer, loop invalidation policy, stale-result protection, root selector, and goal-budget runtime are authoritative. Slice 6 adds a bounded Hypagoal controller path around those contracts. It must not create a second revision engine.

## 2. Product decisions that must not change

### 2.1 The workflow remains the executable goal contract

Each Hypagoal owns one canonical Hypagraph workflow.

`HypagraphDefinition.goal` remains the exact user objective. Workflow state remains authoritative for completion, failure, cancellation, and blockage. The model cannot mark the goal complete or choose a terminal outcome.

Do not add:

- a goal node;
- a second workflow model;
- a second task, loop, evaluation, or revision model;
- a prose-only replan state machine;
- a model-owned unblock or completion command.

### 2.2 Revision is bounded recovery, not silent replanning

The v0.6 controller can request at most one automatic graph revision after canonical blockage.

The automatic path must not:

- change the exact user objective;
- run repeatedly until the model finds a graph which passes;
- relabel a blocker, budget stop, loop stop, or failed evaluation as success;
- reset consumed goal, loop, patience, invalid-evaluation, or evaluation-attempt budgets;
- erase attempt, evidence, metric, evaluation, or event history;
- weaken a protected or isolated evaluation boundary;
- remove a typed success condition or declared failure policy;
- increase a hard bound without explicit user authority;
- revise while an affected attempt is active.

A user-requested manual revision remains distinct from the one automatic revision allowance.

### 2.3 Original objective preservation is exact

The automatic revision proposal must preserve `definition.goal` byte-for-byte.

Do not use semantic similarity, normalization, or model judgement to decide whether the objective is unchanged. The deterministic command boundary compares the proposed objective with the stored objective.

The revision can change the graph only to represent newly discovered bounded work or repair an executable-path defect. It cannot broaden the product objective.

### 2.4 Blockage is canonical and typed

The controller can request automatic revision only when the canonical goal is blocked and the workflow has no runnable action.

A blocked reason can originate from:

- an explicitly blocked node;
- a loop failure policy which blocks required dependants;
- a legacy loop predicate which requires typed revision;
- a definition or route defect which leaves no executable path;
- a recoverable missing bounded step discovered during execution.

The following states are not automatic-revision triggers:

- goal token or turn budget exhaustion;
- hard loop, patience, invalid-evaluation, or evaluation-attempt exhaustion when policy already gives a terminal outcome;
- workflow or goal failure;
- cancellation;
- reload, branch-change, invalid-usage, or user pause;
- an external dependency which cannot be represented as bounded repository work;
- a stale continuation or stale result.

The blocker classifier must be deterministic and visible. Do not infer revision eligibility from prose alone.

### 2.5 Existing revision semantics remain canonical

The current `revise` command and `hypagraph.workflow.revised` event already:

- validate the full definition;
- increment workflow revision;
- reject revision while a loop attempt is active;
- compare old and new definitions;
- invalidate changed loops and affected nodes;
- retain unaffected runtime state;
- preserve attempt history;
- recalculate readiness;
- reject stale old-revision results through existing identity checks.

Slice 6 must reuse this behavior. New controller commands may bind and authorize one automatic revision request, but they must delegate the actual definition transition to the existing revision policy.

### 2.6 One scheduling authority remains

The Slice 3 selector remains the only root-work selector. The Slice 4 `agent_end` path remains the only Pi follow-up scheduler.

When the goal becomes blocked, the selector can return a typed revision request or stop. Do not add a polling loop, recursive prompt sender, or revision scheduler.

Unrelated runnable components must finish before the goal is considered blocked. A blocked node in one component does not justify revision while another component remains runnable.

### 2.7 Revision turns use existing accounting

A delivered automatic-revision turn is a substantive Hypagoal turn and must use the Slice 4 exactly-once accounting path.

Keep these counters separate:

- goal substantive turns;
- goal tokens;
- automatic revision attempts;
- loop iterations;
- patience;
- invalid evaluations;
- evaluation attempts.

Budget exhaustion prevents an automatic revision request. Revision cannot reset or enlarge the goal budget.

### 2.8 Restore and replay do not run work

Replay and restore rebuild and validate state only.

They must not:

- request a revision;
- send a Pi follow-up;
- apply a proposed definition;
- resume a blocked goal;
- consume a revision attempt;
- consume a goal turn;
- start a node, check, evaluator, executor, or subagent.

Reload and branch change still pause an active goal until explicit resume.

## 3. M5B Slice 5 delivered

PR #71 adds loop-aware and trusted-evaluation-aware continuation.

The merged implementation provides:

- canonical loop guidance for status, iteration, hard limit, and typed success;
- distinct current and best accepted metrics;
- progress direction, minimum delta, patience, and no-progress state;
- invalid-evaluation count and limit;
- evaluation purpose, feedback mode, trust, isolation, attempt counts, and public evaluator identity;
- declared loop failure policy and stop state;
- explicit validity, metric, and typed-success separation;
- protected evaluator redaction in model-visible graph, summary, continuation, check-start, and check-result surfaces;
- one unchanged root selector and scheduling authority;
- stale loop-continuation rejection after iteration change;
- fair interleaving between an optimization region and an independent bounded audit region;
- a realistic four-evaluation Pi smoke with one invalid observation, three valid improvements, and typed success;
- exact Slice 4 turn and token accounting during loop work;
- replay and restore without dispatch.

### Slice 5 implementation map

- `src/pi/hypagoal-loop-guidance.ts`: pure canonical loop and evaluation projection plus model guidance.
- `src/pi/model-visible-state.ts`: safe model-facing graph and workflow-summary projections.
- `src/pi/hypagoal-continuation.ts`: state-bound loop identity and guidance in queued and delivered continuations.
- `src/pi/check-runner.ts`: protected evaluator command, report, stdout, stderr, and error redaction.
- `src/extension.ts`: safe read surfaces and protected check-start text while retaining one scheduler.
- `tests/hypagoal-loop-guidance.test.ts`: guidance, identity, redaction, and protected-output coverage.
- `tests/hypagoal-loop-continuation-pi.test.ts`: realistic interleaved multi-iteration Pi smoke.
- `tests/hypagoal-continuation.test.ts`: stale loop delivery after canonical iteration change.
- `docs/m5b-slice-5-dogfood.md`: executable evidence.

### Slice 5 evidence

Implementation baseline:

```text
2f5ca9dbdc5664f7bcdf455939881d420fb6363e
```

CI #892 and final PR CI #894 passed:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 89 test files and 382 tests.

## 4. Current architecture map

### Workflow-local domain

- `src/domain/model.ts`: workflow, goal, loop, evaluation, budget, continuation, command, and event contracts.
- `src/domain/reducer.ts`: canonical transitions, loop progression, existing full-definition revision, affected-node and loop invalidation, and stale identity checks.
- `src/domain/projection.ts`: deterministic replay, revision projection, and snapshot hashing.
- `src/domain/goal-policy.ts`: workflow-derived goal outcomes and blocked reason.
- `src/domain/goal-continuation.ts`: pure root action selection and typed stop decisions.
- `src/domain/goal-budget.ts`: workflow-local turn and token budget policy.
- `src/domain/evaluation-policy.ts`: evaluation purpose, validity, budget, metric, feedback, and trust policy.
- `src/domain/workflow-outcome.ts`: loop failure effects on workflow and dependants.

### Pi controller

- `src/extension.ts`: creation, continuation, charging, reload safety, revision tool, and one scheduling authority.
- `src/pi/hypagoal.ts`: root creation schema and presentation.
- `src/pi/hypagoal-continuation.ts`: pending continuation identity and action guidance.
- `src/pi/hypagoal-loop-guidance.ts`: safe loop and evaluation guidance.
- `src/pi/model-visible-state.ts`: safe model-facing state projections.
- `skills/hypagraph/SKILL.md`: authoring and controller guidance.

### Persistence and recovery

- `src/persistence/event-store.ts`: optimistic append and branch leases.
- `src/persistence/pi-session-store.ts`: Pi event batches.
- `src/persistence/session-rebuild.ts`: replay, snapshot verification, loop validation, goal validation, and budget validation.

### Future seam

The v0.6 response to newly discovered bounded work is one workflow revision. A later family controller can instead create a child Hypagoal when the work needs separate ownership, budget, workspace, or return semantics.

Slice 6 must not add family membership, child-goal state, executor state, worktree leases, or concurrent dispatch.

## 5. Current task: M5B Slice 6 — blockage and bounded revision

### 5.1 User result

A Hypagoal which reaches a recoverable blocked state can make one state-bound automatic revision attempt.

The controller explains the canonical blocker, asks the model for one constrained replacement definition, validates the proposal deterministically, preserves the exact objective and safety contracts, applies the existing revision and invalidation policy, and continues only when the revised graph has a valid runnable path.

If the proposal is invalid, stale, unsafe, over budget, or still blocked, the goal stops with a clear blocker and does not replan again automatically.

### 5.2 Blocker classification

Add the smallest pure blocker projection needed for the controller.

It should identify at least:

- blocker kind;
- blocked node or loop identity when present;
- canonical reason;
- whether definition revision can address it;
- why automatic revision is not allowed when it cannot;
- current workflow revision, sequence, snapshot, goal status, and budget state.

The classifier must examine canonical state. It must not ask the model to decide whether a blocker is revisable.

A suggested typed result is:

```ts
type GoalBlockageDecision =
  | { kind: "not-blocked" }
  | { kind: "revision-eligible"; blocker: GoalBlockerIdentity }
  | { kind: "revision-not-allowed"; blocker: GoalBlockerIdentity; reason: string }
  | { kind: "revision-exhausted"; blocker: GoalBlockerIdentity; reason: string };
```

Use repository naming conventions. Do not add a competing workflow outcome type.

### 5.3 Revision allowance and durable identity

Add workflow-local goal-control state for one automatic revision allowance.

It should represent at least:

- maximum automatic attempts, fixed to one for v0.6;
- consumed automatic attempts;
- pending revision operation identity when a request exists;
- blocker identity and source workflow revision;
- session and branch generation;
- request sequence and snapshot hash;
- applied or rejected outcome;
- clear final diagnostic.

Consume the automatic revision allowance when the durable revision turn is requested or delivered, not only when a valid proposal is accepted. A bad model proposal must not create an unlimited retry path.

Manual user revision must not consume or replenish this allowance.

### 5.4 Commands and events

Prefer explicit controller commands and `hypagraph.goal.*` events for:

- requesting one automatic revision;
- abandoning a stale or interrupted revision request;
- recording the proposed replacement definition and validation result;
- recording exhaustion or a non-revisable blocker;
- resuming the goal after a valid applied revision.

The proposal command must bind at least:

- goal ID;
- workflow ID;
- expected workflow revision;
- expected sequence;
- expected snapshot hash;
- revision operation ID;
- request sequence;
- session generation;
- branch generation;
- original objective;
- replacement definition.

Pure reducers generate no IDs, timestamps, or model text.

Do not duplicate `hypagraph.workflow.revised`. The accepted proposal must pass through the existing revision transition and invalidation policy.

### 5.5 Automatic revision guard

Before the existing revision transition can run through the automatic path, validate:

1. the durable revision request is current;
2. the goal and workflow identities match;
3. the goal is still blocked;
4. the automatic allowance is not exhausted;
5. no active attempt or check execution makes revision unsafe;
6. the proposed definition is structurally valid;
7. `definition.goal` exactly equals the stored objective;
8. the proposal does not weaken protected or isolated evaluation integrity;
9. the proposal does not remove typed success or declared failure policy from an existing bounded region;
10. the proposal does not increase hard loop or evaluation bounds without explicit user authority;
11. the proposal does not reset goal budgets;
12. changed and invalidated work follows the existing revision policy.

Use a deterministic comparison helper. Do not rely on prompt instructions as the safety boundary.

The automatic path can add or reroute bounded work when required by the blocker. It must reject unrelated scope expansion.

### 5.6 Revision guidance

The automatic revision prompt can include:

- the exact user objective;
- current definition;
- canonical blocker kind, identity, and reason;
- current revision and state-bound operation identity;
- unaffected completed work which should remain unchanged;
- current loop, evaluation, and budget summaries;
- explicit immutable and non-weakening constraints;
- the one-attempt limit;
- the exact model tool required to submit the replacement definition.

Do not include protected evaluator commands, paths, hashes, raw reports, stdout, stderr, hidden assertions, or holdout details.

The model proposes a definition. It does not apply state transitions directly.

### 5.7 Application and continuation

An accepted automatic proposal should produce one deterministic committed sequence which:

1. records the revision attempt;
2. applies the existing workflow revision event;
3. records loop and node invalidations from the existing policy;
4. recalculates readiness;
5. verifies that the workflow now has a runnable path or terminal typed outcome;
6. resumes goal control only when continuation is valid;
7. leaves the goal blocked with an exhausted revision allowance when no valid path exists.

Do not queue work from inside replay, restore, or the reducer. The normal `agent_end` scheduling path requests the next continuation after the revision turn is charged.

### 5.8 Stale and interrupted revision behavior

Reject without mutating current workflow state when:

- the workflow revision, sequence, or snapshot changed;
- the active session or branch generation changed;
- the blocker changed;
- the request was abandoned;
- the user supplied a message instead of the queued revision prompt;
- another command revised or unblocked the workflow first.

A delivered revision turn which consumed model execution is still charged through Slice 4. Stale application must not modify the definition or reset the revision allowance.

Reload or branch change pauses active work and queues no revision. Explicit resume reclassifies the current blocker and rechecks budgets and the revision allowance.

### 5.9 Required tests

Add focused domain, projection, persistence, Pi, and integration tests proving:

- explicit node, loop-policy, legacy-predicate, and no-path blockers are classified deterministically;
- non-revisable external, budget, pause, failure, cancellation, and stale states do not request automatic revision;
- unrelated runnable components finish before revision is considered;
- exactly one automatic revision request can be stored;
- duplicate or second automatic revision attempts are rejected;
- the exact original objective cannot change;
- protected or isolated evaluation contracts cannot be weakened;
- typed loop success and failure policy cannot be removed silently;
- hard loop and evaluation bounds cannot be increased automatically;
- active-loop or active-check revision is rejected;
- stale goal, workflow, revision, sequence, snapshot, blocker, session, branch, operation, and request identity is rejected;
- one delivered revision turn is charged exactly once;
- manual user revision remains distinct from the automatic allowance;
- accepted revision reuses existing invalidation and preserves unaffected completed work and all history;
- old-revision attempts, facts, check results, and evaluator results cannot mutate current state;
- a valid revised graph returns the blocked goal to active control and queues the next normal continuation only through `agent_end`;
- an invalid or still-blocked proposal consumes the allowance and stops with a clear blocker;
- reload and replay reproduce revision state without requesting or applying work;
- goal, loop, evaluation, patience, and budget counters remain unchanged except for the charged revision turn and revision allowance;
- a realistic Pi smoke blocks on newly discovered bounded repository work, performs one automatic revision, preserves the objective, adds the required bounded step, and completes without a second replan;
- a second smoke proves a non-revisable blocker stops without an automatic proposal;
- the complete six-target CI matrix passes.

### 5.10 Dogfood scenario

Use one realistic repository task.

The graph should:

- complete at least one unaffected component before blockage;
- discover one bounded missing repository step during execution;
- enter canonical blocked state with a typed blocker;
- request one automatic revision;
- preserve the exact objective;
- retain the completed component and its history;
- add or reroute only the bounded missing work;
- invalidate only affected work;
- continue through the normal selector;
- complete through canonical workflow state;
- prove that no second automatic revision can run.

Also record one non-revisable blocked case which remains blocked with a clear diagnostic.

Record the event sequence, blocker classification, revision identity, old and new definitions, invalidated nodes and loops, retained attempts, readiness after revision, turn and token accounting, final outcome, restore result, and CI evidence.

### 5.11 Deferred from Slice 6

Do not add:

- the complete `/hypagoal` administrative surface from Slice 7;
- child Hypagoals;
- family persistence or family scheduling;
- family-level revision or budget aggregation;
- executor or subagent dispatch;
- worktree leases;
- physical concurrency;
- general multi-attempt autonomous replanning;
- release packaging;
- a v0.6 tag.

### 5.12 Done when

Slice 6 is complete when:

- blockage classification is canonical and deterministic;
- one automatic revision attempt is event-backed and state-bound;
- the exact objective and safety contracts cannot be weakened automatically;
- accepted proposals reuse existing revision and invalidation semantics;
- stale proposals cannot mutate current state;
- one valid revision can restore a runnable path;
- invalid, unsafe, exhausted, or non-revisable cases stop with clear diagnostics;
- history, independent state, and all unrelated counters remain correct;
- replay and restore perform no work;
- the realistic blocked-to-revised Pi smoke completes without a second replan;
- the complete six-target CI matrix passes.

Suggested branch:

```text
agent/m5b-slice-6-blockage-bounded-revision
```

Suggested pull request title:

```text
Add bounded Hypagoal revision
```

## 6. Work after Slice 6

Continue M5B in this order:

1. Slice 7: complete Pi product surface.
2. Slice 8: dogfood and v0.6 release.

After v0.6:

1. M6: event history, replay, and debugger UI.
2. M7: family persistence, bounded child Hypagoals, executor abstraction, and isolated Pi execution.
3. M8: worktree integration and bounded concurrent scheduling.

Do not tag or release v0.6 during Slice 6.
