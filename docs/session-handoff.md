# Session handoff: M5B Slice 6 complete to Slice 7

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `a6c5b9ee2b9025308e91241570154b0524158258`
- Last merged pull request: #73 — Add bounded Hypagoal revision
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 6, blockage and bounded revision
- Current slice: M5B Slice 7, complete Pi product surface
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B Slice 8 dogfood and release evidence

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/hypagoal-vertical-slice-plan.md`;
4. `docs/product-spec.md`;
5. `docs/execution-roadmap.md`;
6. `docs/loop-region-product-model.md`;
7. `docs/trusted-evaluation-contract-plan.md`;
8. `docs/goal-family-and-concurrent-execution-plan.md`;
9. `docs/m5b-slice-5-dogfood.md`;
10. `docs/m5b-slice-6-dogfood.md`;
11. issue #25.

Use issue #25 as the active M5B checklist.

The current root workflow, goal runtime, continuation selector, loop and evaluation runtime, budget accounting, blocker classifier, automatic revision allowance, and workflow revision reducer are authoritative. Slice 7 adds product surfaces. It must not add a second lifecycle, scheduler, revision engine, or completion path.

## 2. Current repository state

M5B Slices 1 through 6 are complete.

The current implementation baseline is `a6c5b9ee2b9025308e91241570154b0524158258`.

PR #73 merged M5B Slice 6.

CI #1012 and final PR CI #1014 pass:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 93 test files and 441 tests.

No v0.6 tag or release exists. Do not create one during Slice 7.

## 3. Delivered Hypagoal architecture

### 3.1 Canonical root lifecycle

One root Hypagoal owns one canonical Hypagraph workflow.

`HypagraphDefinition.goal` is the exact user objective.

Workflow state remains authoritative for:

- completion;
- failure;
- cancellation;
- blockage;
- readiness;
- checks and evidence;
- gates and routes;
- loop outcomes;
- revision invalidation.

A model cannot mark the workflow or goal complete.

### 3.2 Atomic creation

`/hypagoal <objective>` and `hypagoal_start` create the workflow and root goal atomically.

Creation preserves the objective, validates the definition, records initial readiness, persists one event batch, and queues no continuation during authoring.

### 3.3 One root scheduling authority

The Slice 3 selector is the only root-work selector.

It enumerates active tasks, ready tasks, ready checks, and ready gates from canonical state. It uses durable continuation identity and workflow-local round-robin fairness across independent components.

Slice 6 adds `request-revision` as a controller action only when no normal root action remains runnable and deterministic blocker classification permits revision.

### 3.4 Goal budgets and reload safety

Goal turn and normalized token usage are event-backed and charged exactly once against durable continuation identity.

Turn and token limits are separate from loop iterations, patience, invalid-evaluation limits, evaluation budgets, check retries, and automatic revision allowance.

Reload and branch change pause the root goal and dispatch no semantic work. A pending revision continuation is abandoned before pause.

### 3.5 Loop and evaluation continuation

Loop guidance comes from canonical loop and evaluation runtime state.

Validity, current metric, best metric, typed success, progress, patience, invalid-evaluation count, evaluation budgets, trust, isolation, feedback, integrity, and failure policy remain separate.

Protected evaluator commands, paths, hashes, reports, stdout, stderr, and holdout details remain outside model-visible output.

Independent branches and bounded regions remain independent and fairly eligible.

### 3.6 Blockage and bounded revision

Slice 6 provides deterministic blocker classification for:

- typed repository-work node blockers;
- external dependencies;
- safeguards;
- interrupted blocked loops;
- recoverable and terminal `block-dependants` loop outcomes;
- restored legacy definition forms;
- malformed or incomplete no-path definitions;
- terminal goal and workflow policies.

One root Hypagoal can consume at most one automatic revision attempt in v0.6.

The allowance is consumed when the durable revision continuation is requested. Malformed, rejected, stale, interrupted, no-op, weakening, and still-blocked proposals do not restore the allowance.

Revision identity includes goal, workflow, revision, sequence, snapshot, blocker, session, branch, operation, ordinal, and request sequence.

Automatic revision preserves the objective byte-for-byte and cannot weaken:

- required evidence;
- strict enforcement;
- acceptance requirements;
- fact contracts;
- dependencies;
- scopes;
- checks and evaluator trust;
- gates and existing required work;
- typed success;
- validity and progress contracts;
- loop failure policy;
- iteration, patience, invalid-evaluation, evaluation, goal-turn, or goal-token budgets.

Accepted definitions use the existing `revise` command and canonical invalidation reducer. Unaffected completed work remains valid where the existing policy permits it. Changed nodes, loops, facts, routes, checks, gates, and dependant state invalidate through the existing path.

The complete evidence is in `docs/m5b-slice-6-dogfood.md`.

## 4. Current target: M5B Slice 7

### Objective

Complete the Pi product surface for the root Hypagoal controller.

A user must be able to understand and control the active root goal without inspecting raw events.

### Required commands and surfaces

Implement or complete:

- `/hypagoal status`;
- `/hypagoal pause`;
- `/hypagoal resume`;
- `/hypagoal cancel`;
- `/hypagoal graph`;
- compact lifecycle messages;
- graph-pane goal details;
- active-action summary;
- remaining turn and token budget;
- loop and evaluation summary;
- automatic revision allowance and last outcome;
- explicit typed stop reason;
- narrow and wide terminal rendering.

Reuse existing canonical view models where possible. Add projections only when the current domain state cannot be presented accurately.

### Product rules

The Pi surface must distinguish:

- workflow phase from goal status;
- workflow blockage from revision eligibility;
- revision eligibility from revision exhaustion;
- turn and token budgets from loop and evaluation limits;
- evaluation validity from numeric progress and typed success;
- pause cause from terminal outcome;
- protected evaluator identity from protected evaluator internals;
- current action from historical attempts;
- automatic revision from manual user revision.

The user-facing surface must show exact typed state. It must not infer completion, success, trust, or recoverability from model prose.

### Lifecycle control

Pause, resume, and cancel must use existing goal and workflow commands.

Do not add adapter-local lifecycle flags.

Resume must retain current budget and runnable-state validation.

Cancel must not convert blocked, failed, or budget-limited state into success.

### Graph pane

The graph pane must show root goal information without replacing normal workflow, node, loop, evaluation, route, attempt, or evidence views.

Keep identity fields explicit so later family UI can add ancestry, child workflows, executor attempts, workspaces, and concurrent actions without replacing the root view.

### Terminal coverage

Add product coverage for at least:

- completed;
- failed;
- cancelled;
- paused by user;
- paused by reload;
- paused by branch change;
- paused by invalid usage;
- blocked and revision-eligible;
- blocked and non-revisable;
- blocked with revision exhausted;
- goal turn-budget limit;
- goal token-budget limit;
- hard loop limit;
- patience exhaustion;
- invalid-evaluation exhaustion;
- evaluation-budget exhaustion;
- stale continuation or proposal;
- interrupted revision turn.

### Done condition

Slice 7 is complete when a user can determine from normal Pi surfaces:

- what the root goal is;
- what action is active or next;
- what work is ready;
- what budgets remain;
- what loop and evaluation state applies;
- whether blockage can revise automatically;
- whether the one revision allowance is consumed;
- why execution stopped;
- which explicit command can pause, resume, cancel, inspect, or open the graph.

The complete six-target CI matrix must pass.

## 5. Architectural constraints

Do not introduce during Slice 7:

- a second workflow or goal model;
- a second scheduler;
- a second graph-revision engine;
- prose-owned terminal state;
- model-owned completion;
- child Hypagoals;
- family scheduling;
- executors or subagents;
- worktrees;
- physical concurrency;
- release packaging;
- a v0.6 tag or release.

Future goal families, child goals, isolated executors, worktrees, and concurrent scheduling remain accepted later direction in `docs/goal-family-and-concurrent-execution-plan.md`.

## 6. Implementation process

1. Pull the latest `main`.
2. Read the files in section 1.
3. Inspect current Pi commands, graph pane, formatters, model-visible projections, and terminal-state tests.
4. Create a Slice 7 branch.
5. Implement the smallest coherent presentation and command changes.
6. Keep all lifecycle mutations in existing domain commands and reducers.
7. Add focused projection, UI, Pi command, and integration tests.
8. Run type checks and the complete local suite.
9. Review for duplicated lifecycle state, hidden terminal inference, protected-data leaks, stale presentation, and restore-time dispatch.
10. Document realistic Pi product evidence.
11. Open a PR and run the complete six-target CI matrix.
12. Fix all failures and merge when clean.
13. Update plans, product specification, session handoff, and issue #25 so Slice 8 becomes current.
14. Do not tag or release v0.6 during Slice 7.

## 7. Required final report

Report:

- implementation PR and merge SHA;
- closeout PR and merge SHA;
- files changed;
- Pi commands and product surfaces delivered;
- realistic product smoke result;
- exact test count;
- six-target CI result;
- issue #25 state;
- next slice;
- confirmation that no release or tag was created.
