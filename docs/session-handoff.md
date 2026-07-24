# Session handoff: M5B Slice 4 complete to Slice 5

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `80766e51636cbd065cd08632546d3ff39419624c`
- Last merged pull request: #69 — Add Hypagoal budgets and reload safety
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 4, budgets and reload safety
- Current slice: M5B Slice 5, loop and trusted-evaluation continuation
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/hypagoal-vertical-slice-plan.md`;
4. `docs/loop-region-product-model.md`;
5. `docs/trusted-evaluation-contract-plan.md`;
6. `docs/goal-family-and-concurrent-execution-plan.md`;
7. `docs/product-spec.md`;
8. `docs/delegation-and-visualisation.md`;
9. `docs/automatic-graph-authoring.md`;
10. `docs/execution-roadmap.md`;
11. `docs/m5a-dogfood.md`;
12. `docs/m5b-slice-3-dogfood.md`;
13. `docs/m5b-slice-4-dogfood.md`.

Use issue #25 as the active M5B checklist.

The loop-region and trusted-evaluation plans are authoritative for Slice 5. The goal-family plan remains authoritative for later child goals, isolated executors, worktrees, family budgets, and physical concurrency. Slice 5 must preserve compatibility with those later features without implementing them.

## 2. Product decisions that must not change

### 2.1 The workflow remains the executable goal contract

Each Hypagoal owns one canonical Hypagraph workflow.

`HypagraphDefinition.goal` remains the user objective. `GoalRuntime` remains the workflow-local controller state. Workflow state remains authoritative for completion, failure, cancellation, and blockage.

Do not add:

- a goal node;
- a second workflow model;
- a second task or loop model;
- a model-owned completion command;
- a prose-only continuation state machine.

### 2.2 Loops are generic bounded iteration regions

A loop can perform refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

Do not infer repair semantics from:

- a loop name;
- a node title;
- a check failure;
- a metric;
- the presence of a back edge.

Use the existing loop definition, runtime, conditions, evidence, progress, patience, evaluation, and failure-policy contracts.

### 2.3 Existing loop and evaluation state is canonical

Slice 5 must consume the existing canonical state. It must not duplicate it in `GoalRuntime` or in adapter-local fields.

Relevant canonical state includes:

- current iteration and hard iteration limit;
- loop status and exit reason;
- typed success condition;
- current accepted metric;
- best accepted metric;
- progress direction;
- no-progress count and patience limit;
- invalid-evaluation count and limit;
- evaluation attempt budget and consumed attempts;
- evaluation purpose;
- trust and isolation claims;
- feedback mode;
- evaluator identity, version, and fingerprint;
- loop failure policy;
- independent component state.

Continuation guidance can summarize this state. It cannot create a competing source of truth.

### 2.4 Validity is separate from score

An invalid evaluation cannot:

- update the current metric;
- update the best metric;
- reset patience;
- satisfy loop success;
- complete a node;
- produce trusted acceptance;
- expose protected evaluator details to the model.

Validity, score, typed success, progress, purpose, trust, transport, and feedback remain separate concepts.

### 2.5 Failure policy is explicit

The existing loop failure policies are:

- `fail-workflow`;
- `block-dependants`;
- `record-and-continue`.

A continuation prompt must not silently choose or override a failure policy.

When a bounded stop occurs, canonical reducer policy decides the workflow effect.

### 2.6 Independent components remain independent

The Slice 3 selector still enumerates all runnable root components in stable definition order and uses the event-backed continuation ordinal for rotation.

Slice 5 must not give recency ownership to the currently discussed loop.

A connected optimization loop and an independent auxiliary loop can both remain runnable. Progress, failure, or evaluation in one component must not reset, release, fail, pause, or complete the other component unless a declared graph dependency or workflow policy requires it.

### 2.7 Goal budgets remain separate

Slice 4 added workflow-local substantive-turn and token budgets.

Do not merge those counters with:

- loop iteration limits;
- patience;
- invalid-evaluation limits;
- evaluation attempt budgets;
- check retry limits.

A delivered continuation turn is charged once through the Slice 4 contract, regardless of whether that turn runs loop work, evaluation work, or an independent component.

### 2.8 Restore and replay do not run work

Restore and replay rebuild and validate state only.

They must not:

- send a Pi follow-up;
- run a check;
- start an evaluator;
- resume a loop;
- select an executor;
- start a subagent;
- consume a continuation turn;
- consume an evaluation attempt.

Reload and branch change still pause an active Hypagoal until explicit resume.

## 3. M5B Slice 4 delivered

PR #69 adds workflow-local budgets and reload safety.

The merged implementation provides:

- optional maximum substantive turns and maximum normalized tokens;
- consumed input, output, cache-read, cache-write, and total tokens;
- event-backed `hypagraph.goal.turn-recorded`;
- event-backed `hypagraph.goal.budget-limited`;
- event-backed continuation abandonment;
- durable pending-continuation identity;
- exactly-once charging for delivered continuations;
- duplicate and stale usage rejection;
- `pi-assistant-usage-v1` normalization at the Pi boundary;
- deterministic turn-limit and token-limit stop state;
- final-turn accounting when semantic work completes the workflow;
- budget exhaustion separate from workflow success;
- pause causes for session reload, branch change, explicit pause, workflow pause, and invalid usage;
- canonical pending-continuation invalidation during pause;
- explicit `/hypagoal resume`;
- resume-time budget and runnable-state checks;
- schema version 4 restore validation;
- budget summaries in Pi text and widget views.

### Slice 4 implementation map

- `src/domain/goal-budget.ts`: budget validation, token accumulation, deterministic stop selection, and stop formatting.
- `src/domain/model.ts`: budget, usage, pending continuation, pause cause, command, and event contracts.
- `src/domain/reducer.ts`: continuation request, abandonment, usage recording, budget stop, pause, and resume policy.
- `src/domain/projection.ts`: deterministic budget and continuation projection.
- `src/domain/goal-policy.ts`: terminal goal classification.
- `src/domain/goal-continuation.ts`: budget-limited stop decision.
- `src/pi/hypagoal-budget.ts`: Pi usage normalization.
- `src/pi/hypagoal-continuation.ts`: durable pending-continuation validation.
- `src/extension.ts`: charging, invalid-usage pause, reload pause, branch pause, resume, and one scheduling authority.
- `src/persistence/session-rebuild.ts`: schema compatibility and restored budget validation.
- `tests/hypagoal-budget.test.ts`: domain, replay, restore, duplicate, malformed usage, and stop tests.
- `tests/hypagoal-budget-pi.test.ts`: Pi usage normalization tests.
- `tests/hypagoal-continuation-pi.test.ts`: turn stop, invalid usage, reload, branch, and resume tests.
- `docs/m5b-slice-4-dogfood.md`: executable evidence.

### Slice 4 evidence

Implementation baseline:

```text
80766e51636cbd065cd08632546d3ff39419624c
```

CI #871 and final PR CI #873 passed:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 87 test files and 374 tests.

## 4. Current architecture map

### Workflow-local domain

- `src/domain/model.ts`: workflow, goal, loop, evaluation, budget, continuation, command, and event contracts.
- `src/domain/reducer.ts`: canonical state transitions and stale identity validation.
- `src/domain/projection.ts`: deterministic replay and snapshot hashing.
- `src/domain/goal-policy.ts`: workflow-derived goal outcome policy.
- `src/domain/goal-continuation.ts`: pure runnable-action selection.
- `src/domain/goal-budget.ts`: workflow-local root budget policy.
- `src/domain/loop-policy.ts`: loop progression and stop policy.
- `src/domain/evaluation-policy.ts`: evaluation purpose, budget, validity, metric, feedback, and trust policy.
- `src/domain/workflow-outcome.ts`: loop failure effect on workflow state.

### Pi controller

- `src/extension.ts`: creation, continuation scheduling, charging, reload safety, tool delivery, and UI.
- `src/pi/hypagoal.ts`: root creation schema and presentation.
- `src/pi/hypagoal-continuation.ts`: pending continuation identity and action guidance.
- `src/pi/hypagoal-budget.ts`: normalized Pi usage.
- `skills/hypagraph/SKILL.md`: authoring and controller guidance.

### Persistence and recovery

- `src/persistence/event-store.ts`: optimistic event append and branch leases.
- `src/persistence/pi-session-store.ts`: Pi session event batches.
- `src/persistence/session-rebuild.ts`: replay, snapshot verification, loop validation, goal validation, and budget validation.

### Future seam

The v0.6 controller is root-only and sequential. Slice 5 must keep its guidance and action identity workflow-local so the same canonical loop and evaluation state can later be presented to an isolated executor or selected by a family scheduler.

Do not add family membership, child-goal state, executor state, worktree leases, or concurrent dispatch in Slice 5.

## 5. Current task: M5B Slice 5 — loop and trusted-evaluation continuation

### 5.1 User result

A user can start a normal prose Hypagoal whose graph contains:

- one refinement or optimization loop;
- one independent bounded auxiliary loop or branch;
- typed success;
- a defensible numeric metric when one exists;
- a trusted or explicitly non-trusted evaluation contract;
- explicit hard limits and failure policy.

Hypagraph continues through both components without manual continuation prompts, does not starve the independent component, rejects invalid evaluation output without corrupting progress, and stops or completes through canonical typed state.

### 5.2 Reuse the existing runtime

Do not add another loop controller.

Extend continuation presentation and Pi integration around the existing:

- loop definitions;
- loop runtimes;
- evaluation contracts;
- evaluation observations;
- protected integrity results;
- typed facts;
- checks and gates;
- workflow outcome policy.

Any new helper should be a pure projection or formatting function over canonical state unless a missing domain transition is proven.

### 5.3 Loop-aware continuation guidance

For a selected loop action, give the model only the canonical context required for the next semantic step.

The guidance must identify, where applicable:

- goal ID;
- workflow ID and revision;
- node ID;
- loop ID;
- current iteration and hard limit;
- loop status;
- typed success condition;
- current accepted metric;
- best accepted metric;
- progress direction;
- patience limit and current no-progress count;
- invalid-evaluation limit and current invalid count;
- evaluation attempt limit and consumed attempts;
- evaluation purpose;
- trust and isolation classification;
- feedback mode;
- evaluator version or public fingerprint when model-visible;
- declared failure policy;
- current stop or exit reason;
- the independent-component rule;
- permitted tools for the selected action.

Do not include unavailable values. Do not invent metrics, tests, trust claims, evaluator output, or progress.

### 5.4 Trusted-evaluation guidance

Continuation guidance must distinguish:

- metric production from typed success;
- valid evaluation from invalid evaluation;
- trusted holdout acceptance from development feedback;
- protected evaluator evidence from model-visible diagnostics;
- evaluation attempt budget from goal turn/token budget.

Protected commands, paths, hashes, raw reports, stdout, stderr, Git output, and hidden evaluator details must not enter the model prompt.

A non-isolated evaluator must not be described as trusted holdout acceptance.

### 5.5 Typed stop and transition behavior

Slice 5 must preserve or expose clear canonical outcomes for:

- typed loop success;
- hard iteration limit;
- patience or no-progress stop;
- invalid-evaluation limit;
- evaluation attempt budget exhaustion;
- evaluator failure, timeout, cancellation, or integrity failure;
- loop failure policy;
- workflow completion, blockage, or failure;
- goal token or turn budget;
- reload or branch pause.

Do not collapse these outcomes into one generic failure string.

The reducer remains authoritative. The model receives guidance; it does not choose terminal state.

### 5.6 Selection and fairness

Keep the Slice 3 selector as the only root-work selection authority.

Before each continuation request, enumerate all runnable root actions. Independent loop entries, loop nodes, checks, gates, and normal tasks remain candidates.

Selection must remain:

- stable;
- replayable;
- independent of map iteration;
- independent of wall-clock time;
- independent of UI focus;
- independent of event recency;
- compatible with later family scheduling.

A loop must not monopolize continuation because it produced the latest metric or evaluation event.

### 5.7 Pi integration

Extend the Pi prompt and tool exposure so the selected action can perform the correct next step.

Required behavior:

1. derive guidance from the exact state-bound continuation action;
2. expose only tools permitted for that action and current state;
3. include canonical loop and evaluation summaries;
4. keep protected evaluator information out of model-visible text;
5. let existing commands persist checks, facts, evaluation starts, evaluation results, loop decisions, and node transitions;
6. charge the delivered Pi turn through Slice 4;
7. request the next action only after durable canonical progress and usage accounting;
8. stop on stale identity, invalid usage, canonical terminal state, or any bounded controller stop.

Do not add a second scheduler inside a loop helper or evaluation adapter.

### 5.8 Required tests

Add focused domain, projection, persistence, Pi, and integration tests proving:

- continuation guidance reports the correct loop ID and iteration;
- current and best metrics are not confused;
- metric direction is presented correctly;
- patience and no-progress state is presented correctly;
- invalid-evaluation count and limit are presented correctly;
- evaluation attempts and evaluation budget are presented correctly;
- evaluation purpose, trust, isolation, and feedback mode remain distinct;
- protected evaluator details do not enter prompts or normal tool output;
- invalid evaluation does not update current or best accepted progress;
- invalid evaluation does not reset patience or satisfy typed success;
- evaluator start consumes the existing evaluation budget exactly once;
- hard limit, patience, invalid limit, and evaluation budget produce distinct canonical outcomes;
- each loop failure policy produces its declared workflow effect;
- a loop without a defensible metric can complete through typed success and evidence;
- a metric loop cannot complete from score alone when typed success is false;
- an optimization or refinement loop and an independent auxiliary loop both receive continuation opportunities;
- the independent component is not starved while the metric loop progresses;
- state changes in one independent loop do not reset or complete the other;
- reload and replay do not start evaluation or queue work;
- goal turn and token accounting remains exact during loop turns;
- stale loop or evaluation continuation identity is rejected;
- a realistic Pi smoke rejects one invalid score without updating the best metric;
- the same smoke improves a valid metric over at least three iterations;
- the same smoke completes through typed success;
- the smoke proves independent-component state isolation;
- the complete six-target CI matrix passes.

### 5.9 Dogfood scenario

Use one realistic repository task, not a synthetic counter-only graph.

The graph must include:

- a primary refinement or optimization region;
- at least three iterations;
- a deterministic metric with declared direction;
- typed success separate from the metric;
- one invalid evaluation;
- one valid improvement after the invalid evaluation;
- a patience or hard-limit boundary;
- one independent bounded auxiliary component;
- explicit failure policy;
- a gate or check which consumes declared facts;
- no manual continuation prompts after creation.

Record the exact event sequence, selected components, metric history, invalid observation, best metric, independent component state, stop or success reason, and CI evidence.

### 5.10 Deferred from Slice 5

Do not add:

- automatic graph revision from Slice 6;
- the complete `/hypagoal` administrative surface from Slice 7;
- child Hypagoals;
- family persistence or family scheduling;
- family-level budget aggregation;
- executor or subagent dispatch;
- worktree leases;
- physical concurrency;
- release packaging;
- a v0.6 tag.

### 5.11 Done when

Slice 5 is complete when:

- loop and evaluation guidance is derived from canonical state;
- all bounded loop and evaluation outcomes remain typed and distinct;
- protected evaluator data stays protected;
- invalid evaluation cannot corrupt progress or success;
- independent components continue fairly;
- the realistic multi-component Pi smoke completes without manual continuation;
- replay and restore reproduce the same loop, evaluation, metric, budget, and stop state;
- the complete six-target CI matrix passes.

Suggested branch:

```text
agent/m5b-slice-5-loop-evaluation-continuation
```

Suggested pull request title:

```text
Add loop-aware Hypagoal continuation
```

## 6. Work after Slice 5

Continue M5B in this order:

1. Slice 6: blockage and bounded revision.
2. Slice 7: complete Pi product surface.
3. Slice 8: dogfood and v0.6 release.

After v0.6:

1. M6: event history, replay, and debugger UI.
2. M7: family persistence, bounded child Hypagoals, executor abstraction, and isolated Pi execution.
3. M8: worktree integration and bounded concurrent scheduling.

Do not tag or release v0.6 during Slice 5.
