# Session handoff: M5A complete to M5B Slice 1

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- M5A implementation baseline: `9d529e2cc549c5d2508a190b267a07361f302659`
- M5A final implementation pull request: #60
- M5A tracking issue: #30
- Active milestone: M5B Hypagoal
- Next slice: M5B Slice 1, canonical goal lifecycle
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read:

- `AGENTS.md`;
- `docs/hypagoal-vertical-slice-plan.md`;
- `docs/trusted-evaluation-contract-plan.md`;
- `docs/m5a-dogfood.md`;
- `docs/automatic-graph-authoring.md`;
- `docs/loop-region-product-model.md`;
- `docs/product-spec.md`.

Use issue #25 as the authoritative M5B checklist.

Issue #30 is the completed M5A implementation record.

## 2. Product decisions that must not change

### 2.1 One canonical workflow

Hypagraph has one executable workflow graph.

Hypagoal must control that workflow. It must not add:

- a goal node;
- a second task model;
- a parallel completion state machine;
- a model tool that marks a goal complete.

The runtime derives goal completion from canonical workflow state.

### 2.2 Goal control is continuation control

Hypagoal decides whether Pi may request another agent turn.

It does not decide that semantic task work is complete.

The continuation decision must be pure. The Pi adapter performs the external continuation side effect only after the decision is durable and current.

### 2.3 Generic bounded iteration

A loop is a generic bounded iteration region.

It can perform refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

Repair is one pattern, not the default purpose.

A loop can connect to the wider graph or run as an independent top-level component. Each loop has explicit failure policy.

### 2.4 Trusted evaluation is complete foundation work

M5A keeps these concepts separate:

- success;
- progress;
- evaluation validity;
- evaluation purpose;
- evaluator trust;
- evaluator transport.

Hypagoal must consume the existing evaluation and loop state. It must not add a second loss or evaluator model.

Only isolated execution can support trusted holdout acceptance.

### 2.5 Restore must not run autonomous work

Session restore rebuilds canonical state only.

An active goal must pause after reload or branch change. The user must resume it explicitly.

A stale continuation or stale turn must not affect the current goal generation.

## 3. Completed foundation

### M3.1 deterministic checks

Complete:

- command checks;
- Vitest, ESLint, and Istanbul report checks;
- file assertions;
- Git assertions;
- durable lifecycle, retry, cancellation, restore, and replay.

### M4 bounded iteration regions

Complete:

- typed success;
- multiple iterations;
- feedback edges;
- hard limits;
- numeric progress;
- best metric and iteration;
- patience;
- independent loop components;
- explicit failure policy;
- cancellation and revision recovery;
- stale-result rejection;
- Pi and graph surfaces.

### M5A trusted evaluation contracts

Complete:

- metric-report checks;
- typed evaluation validity;
- invalid-observation limits;
- bounded feedback;
- protected evaluator output;
- event-backed total and per-purpose budgets;
- transparent and protected evaluator integrity;
- evaluator versions and fingerprints;
- cancellation and integrity deadlines;
- transport-neutral evaluator adapters;
- evaluation-contract authoring guidance;
- deterministic authoring advisories;
- accurate purpose, trust, claim, adapter, and integrity presentation;
- complete product-path dogfood;
- restore and replay on every supported target.

The M5A dogfood record is `docs/m5a-dogfood.md`.

## 4. M5A final evidence

PR #60 adds `tests/m5a-dogfood.test.ts`.

The three executable scenarios prove:

1. prose-derived evaluation authoring, an inner typed gate, three improving development evaluations, typed acceptance, and a generalization probe;
2. protected evaluator change detection, rejection of a high invalid score, best-result and patience protection, and later `no_progress` termination;
3. `evaluation_budget` termination, restore, replay, and stale evaluator result rejection.

CI #621 passes:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The suite contains 79 test files and 300 tests.

## 5. Current architecture map

### Domain and reducer

- `src/domain/model.ts`: canonical workflow, loop, evaluation, and event types.
- `src/domain/reducer.ts`: canonical workflow decisions.
- `src/domain/projection.ts`: event replay and runtime projection.
- `src/domain/evaluation-policy.ts`: event-backed evaluation budgets.
- `src/domain/integrity-policy.ts`: evaluator-integrity validation.
- `src/domain/evaluation-authoring.ts`: non-blocking authoring assessment.
- `src/domain/evaluation-presentation.ts`: honest evaluator result claims.

### Check and evaluator path

- `src/checks/durable-lifecycle.ts`: durable check effect ordering.
- `src/checks/report-check-executor.ts`: report parsing and fact publication.
- `src/checks/evaluator-adapter.ts`: transport-neutral evaluator boundary.
- `src/checks/evaluation-integrity.ts`: external integrity instruments.

### Pi and product surfaces

- `src/extension.ts`: Pi tools and commands.
- `src/pi/definition.ts`: authoring schemas and normalization.
- `src/pi/check-runner.ts`: check and evaluator result presentation.
- `src/graph/projection.ts`: canonical graph view model.
- `src/ui/loop-surface.ts`: canonical loop and evaluation summaries.

### Persistence and session behavior

- `src/persistence/event-store.ts`: optimistic event persistence.
- `src/persistence/session-rebuild.ts`: restore from Pi session history.
- `src/pi/session-branch.ts`: branch generation and stale-result protection.

## 6. Next task: M5B Slice 1

### User result

A normal Hypagraph workflow can have durable goal-control state whose terminal status is derived from workflow state.

This slice is domain-first. It does not yet add `/hypagoal` automatic creation or Pi continuation.

### Add

- `GoalStatus` and `GoalRuntime` domain types;
- optional goal-control state in `HypagraphState`;
- goal commands:
  - `start-goal`;
  - `pause-goal`;
  - `resume-goal`;
  - `cancel-goal`;
- goal events in the `hypagraph.goal.*` namespace;
- pure workflow-to-goal status derivation;
- event projection;
- snapshot schema migration or explicit compatibility behavior;
- replay and snapshot-hash coverage;
- workflow-derived completion, failure, cancellation, and blockage.

Do not add token or turn accounting yet. That belongs to Slice 4.

Do not add automatic Pi continuation yet. That belongs to Slice 3.

Do not add `/hypagoal` creation yet. That belongs to Slice 2.

### Required rules

- Goal state cannot exist without a workflow.
- There can be at most one goal-control state in one Pi session for the first release.
- The model cannot complete a goal.
- There is no `complete-goal` command.
- Every goal status transition has a durable event.
- The reducer remains pure.
- Replaying the same events produces the same goal status and stop reason.
- Workflow terminal state is authoritative over model narrative.

### Recommended initial types

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

Budget-limited state and usage counters can be added in Slice 4 unless implementation evidence shows they must exist in the initial persisted schema.

### Done when

A manually driven workflow with goal control:

- completes only when the workflow completes;
- fails only when the workflow fails;
- cancels only through canonical cancellation;
- pauses and resumes through explicit commands;
- blocks when the workflow has no executable path;
- restores and replays the same goal state;
- cannot be completed by any model-visible command.

Suggested branch:

```text
agent/m5b-slice-1-goal-lifecycle
```

Suggested pull request title:

```text
Implement M5B canonical goal lifecycle
```

## 7. Work after Slice 1

Continue M5B in this order:

1. Slice 2: atomic `/hypagoal` creation.
2. Slice 3: graph-aware continuation.
3. Slice 4: token and turn budgets plus reload safety.
4. Slice 5: loop and trusted-evaluation continuation.
5. Slice 6: blockage and bounded revision.
6. Slice 7: complete Pi product surface.
7. Slice 8: dogfood and v0.6 release.

## 8. Important release warning

The package version remains `0.5.0` during M5A and M5B development.

Do not tag current `main` as `v0.5.0`.

The intended historical v0.5 tag target remains:

```text
88ec3950bcbc07ce7148d940d0c65f6b176f3bc9
```

The v0.6 version and tag must wait until M5B dogfood and release evidence pass on a tested main commit.

## 9. Known hazards

- Do not create a second goal definition that duplicates the graph.
- Do not make model text authoritative for completion.
- Do not queue autonomous work during restore.
- Do not infer repair semantics for generic loops.
- Do not weaken M5A validity, trust, budget, or protected-output rules.
- Preserve event ordering and optimistic sequence checks.
- Keep branch generation and stale-continuation identity explicit.
- Connector-authored commits can suppress push-triggered Actions. Use the PR `ready_for_review` trigger when required.
- Temporary patch workflows must remove themselves and must not remain in final diffs.

## 10. Successful next handoff

The next handoff is ready when:

- M5B Slice 1 is merged;
- issue #25 marks Slice 1 complete;
- goal-control state is event-backed and replayable;
- workflow state derives every goal terminal result;
- no model or public command can complete a goal;
- all six CI jobs pass;
- this document points to atomic `/hypagoal` creation.
