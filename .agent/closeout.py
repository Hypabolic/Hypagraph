from pathlib import Path

MERGE_SHA = "a6c5b9ee2b9025308e91241570154b0524158258"


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    target = Path(path)
    text = target.read_text()
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {actual}: {old[:160]!r}")
    target.write_text(text.replace(old, new, count))


# Execution roadmap.
replace(
    "docs/execution-roadmap.md",
    "- Current implementation baseline: `2f5ca9dbdc5664f7bcdf455939881d420fb6363e`",
    f"- Current implementation baseline: `{MERGE_SHA}`",
)
replace(
    "docs/execution-roadmap.md",
    "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1, 2, 3, 4, and 5 complete |",
    "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1, 2, 3, 4, 5, and 6 complete |",
)
replace(
    "docs/execution-roadmap.md",
    """5. Loop and trusted-evaluation continuation — complete in PR #71.
6. Blockage and bounded revision — current.
7. Complete Pi product surface.
8. Dogfood and v0.6 release.""",
    """5. Loop and trusted-evaluation continuation — complete in PR #71.
6. Blockage and bounded revision — complete in PR #73.
7. Complete Pi product surface — current.
8. Dogfood and v0.6 release.""",
)
replace(
    "docs/execution-roadmap.md",
    """Slice 6 adds canonical blocker classification and one bounded automatic workflow revision attempt. It must preserve the exact objective and safety contracts, reuse the existing revision and invalidation reducer, reject stale or repeated proposals, charge the revision turn, and stop clearly when no safe runnable path results.

### M5B architecture constraints""",
    f"""### Slice 6 result

M5B Slice 6 provides:

- deterministic canonical blocker classification;
- one durable automatic revision allowance for each root Hypagoal;
- state-bound revision identity across goal, workflow, revision, sequence, snapshot, blocker, session, branch, operation, and request;
- byte-exact objective preservation before adapter normalization;
- non-weakening validation for checks, gates, evidence, acceptance, typed success, evaluator trust, loop policies, limits, budgets, scopes, facts, dependencies, and existing required work;
- accepted revisions through the existing workflow revision, invalidation, readiness, and stale-result reducer path;
- exact Slice 4 turn and token accounting for delivered revision turns;
- safe exhaustion for malformed, rejected, stale, interrupted, no-op, weakening, and still-blocked proposals;
- reload and branch-change abandonment plus explicit pause without restore-time dispatch;
- realistic blocked-to-revised-to-completed Pi smoke evidence in `docs/m5b-slice-6-dogfood.md`.

The merged baseline is `{MERGE_SHA}`. CI #1014 passes 93 test files and 441 tests on all six supported OS and Node.js targets.

Slice 7 completes the Pi product surface. It must make active action, lifecycle control, remaining budget, loop and evaluation state, graph state, and typed stop reasons understandable without event inspection.

### M5B architecture constraints""",
)

# Vertical-slice plan.
replace(
    "docs/hypagoal-vertical-slice-plan.md",
    "- Status: active implementation; Slices 1, 2, 3, 4, and 5 complete; Slice 6 current",
    "- Status: active implementation; Slices 1, 2, 3, 4, 5, and 6 complete; Slice 7 current",
)
replace(
    "docs/hypagoal-vertical-slice-plan.md",
    """### Slice 6 - Blockage and bounded revision — current

Add canonical blocker classification and one workflow-local automatic revision allowance.

The automatic path must:

- run only after canonical goal blockage and only when no unrelated root action remains runnable;
- preserve the exact user objective;
- bind the request and proposal to goal, workflow, revision, sequence, snapshot, blocker, session, branch, operation, and request identity;
- consume at most one automatic revision attempt in v0.6;
- charge the revision turn through the existing goal turn and token accounting path;
- reject stale, duplicate, unsafe, over-budget, or second proposals;
- prevent automatic weakening of protected evaluation contracts, typed loop success, failure policy, and hard bounds;
- reuse the existing `revise` transition, node invalidation, loop invalidation, readiness, history, and stale-result semantics;
- resume only when the revised graph has a valid path;
- stop with a clear blocker when revision is invalid, unsafe, exhausted, or still blocked;
- keep manual user revision separate from the automatic allowance;
- perform no revision work during replay or restore.

The v0.6 response to newly discovered bounded work is workflow revision. A later release can create a child goal when work needs separate ownership, budget, workspace, or return semantics.

Done when one blocked graph returns to a valid path through one safe automatic revision, a non-revisable blocker stops without a proposal, a second automatic attempt is impossible, and the complete matrix passes.

### Slice 7 - Complete Pi product surface""",
    f"""### Slice 6 - Blockage and bounded revision — complete

PR #73 delivered:

- deterministic blocker classification for typed node, loop, legacy-definition, no-path, external, safeguard, and terminal-policy cases;
- one event-backed automatic revision attempt for each root Hypagoal;
- exact state-bound request and proposal identity;
- allowance consumption when the revision turn is requested, including malformed, rejected, stale, interrupted, no-op, weakening, and still-blocked outcomes;
- byte-exact objective preservation before adapter normalization;
- explicit non-weakening validation for protected evaluation, typed success, checks, gates, evidence, acceptance, facts, dependencies, scopes, loop policy, hard limits, and goal or evaluation budgets;
- accepted revision through the existing `revise` command and canonical invalidation reducer;
- preservation of unaffected completed work and rejection of pre-revision stale results;
- exact turn and token accounting through the Slice 4 path;
- reload and branch-change abandonment and pause without semantic dispatch;
- realistic positive and negative Pi smoke coverage;
- complete evidence in `docs/m5b-slice-6-dogfood.md`.

The merge baseline is `{MERGE_SHA}`.

CI #1014 passes 93 test files and 441 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The v0.6 response to newly discovered bounded work remains workflow revision. A later release can create a child goal when work needs separate ownership, budget, workspace, or return semantics.

### Slice 7 - Complete Pi product surface — current""",
)
replace(
    "docs/hypagoal-vertical-slice-plan.md",
    "M5B is active. Slices 1, 2, 3, 4, and 5 are complete. Slice 6 is the current implementation target.",
    "M5B is active. Slices 1, 2, 3, 4, 5, and 6 are complete. Slice 7 is the current implementation target.",
)

# Product specification.
replace(
    "docs/product-spec.md",
    """- Version: implementation baseline through M5B Slice 5
- Current baseline: `2f5ca9dbdc5664f7bcdf455939881d420fb6363e`""",
    f"""- Version: implementation baseline through M5B Slice 6
- Current baseline: `{MERGE_SHA}`""",
)
replace(
    "docs/product-spec.md",
    """M5B Slice 5 implements canonical loop and trusted-evaluation continuation guidance, protected model-visible evaluator redaction, explicit validity and typed-success separation, fair independent-component continuation, stale loop-delivery protection, and realistic multi-iteration automatic execution.

The v0.6 product supports one root Hypagoal in one Pi session.""",
    """M5B Slice 5 implements canonical loop and trusted-evaluation continuation guidance, protected model-visible evaluator redaction, explicit validity and typed-success separation, fair independent-component continuation, stale loop-delivery protection, and realistic multi-iteration automatic execution.

M5B Slice 6 implements deterministic canonical blocker classification, one durable automatic revision allowance, state-bound proposal identity, byte-exact objective preservation, non-weakening validation, existing-reducer revision and invalidation, exact revision-turn accounting, stale and interrupted exhaustion, and reload-safe pause.

The v0.6 product supports one root Hypagoal in one Pi session.""",
)
replace(
    "docs/product-spec.md",
    """- stale loop-continuation rejection;
- realistic multi-iteration automatic continuation with invalid-result rejection and typed success.""",
    """- stale loop-continuation rejection;
- realistic multi-iteration automatic continuation with invalid-result rejection and typed success;
- deterministic canonical blocker classification;
- one durable bounded automatic revision allowance;
- byte-exact objective and non-weakening revision validation;
- accepted revision through the existing invalidation reducer;
- stale, rejected, malformed, interrupted, no-op, weakening, and still-blocked revision exhaustion;
- exact revision-turn and token accounting;
- reload and branch-change pause without revision dispatch;
- realistic positive and negative bounded-revision smoke evidence.""",
)
replace(
    "docs/product-spec.md",
    "M5B Slices 1, 2, 3, 4, and 5 are complete in PRs #62, #65, #67, #69, and #71. Slice 6, blockage and bounded revision, is the current implementation target.",
    "M5B Slices 1, 2, 3, 4, 5, and 6 are complete in PRs #62, #65, #67, #69, #71, and #73. Slice 7, complete Pi product surface, is the current implementation target.",
)
replace(
    "docs/product-spec.md",
    "4. M5B root Hypagoal autonomous controller — active; Slices 1, 2, 3, 4, and 5 complete.",
    "4. M5B root Hypagoal autonomous controller — active; Slices 1, 2, 3, 4, 5, and 6 complete.",
)
replace(
    "docs/product-spec.md",
    """CI #892 and final PR CI #894 pass:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 89 test files and 382 tests.""",
    """CI #1012 and final PR CI #1014 pass:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 93 test files and 441 tests.""",
)

# Canonical session handoff for Slice 7.
Path("docs/session-handoff.md").write_text(f'''# Session handoff: M5B Slice 6 complete to Slice 7

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `{MERGE_SHA}`
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

The current implementation baseline is `{MERGE_SHA}`.

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
''')
