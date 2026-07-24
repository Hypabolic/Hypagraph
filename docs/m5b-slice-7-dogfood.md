# M5B Slice 7 dogfood evidence

- Date: 2026-07-24
- Slice: M5B Slice 7, complete Pi product surface
- Validated implementation commit: `24ec90083b96d6f9572054e4ec561d1759719598`
- Pull request: #75
- Verification run: CI #1075
- Test result: 94 test files and 460 tests passing

## 1. Product result

A Pi user can inspect and control one root Hypagoal without reading raw events or persisted snapshots.

The product surface exposes:

- the exact root objective;
- workflow phase, revision, and event sequence;
- goal status, pause cause, and stop reason;
- the active action;
- the next selected action;
- all ready root work;
- consumed, maximum, and remaining goal turns;
- consumed, maximum, and remaining normalized goal tokens;
- loop iteration and hard-limit state;
- evaluation validity, invalid-evaluation count, progress, best result, patience, attempt budget, trust, and integrity summaries;
- canonical blocker classification;
- automatic revision eligibility, exhaustion, pending state, and last outcome;
- explicit typed stop codes;
- the commands available for the current lifecycle state.

Workflow phase and goal status remain separate. Goal budgets remain separate from loop limits and evaluation budgets. Evaluation validity remains separate from numeric progress and typed success.

## 2. Pi commands

The `/hypagoal` command now supports:

- `/hypagoal status`;
- `/hypagoal pause [reason]`;
- `/hypagoal resume`;
- `/hypagoal cancel [reason]`;
- `/hypagoal graph`;
- `/hypagoal <objective>` for root creation.

The control commands do not create Pi-local lifecycle state.

- Pause applies the existing `pause-goal` command.
- Resume applies the existing `resume-goal` command and retains canonical budget and runnable-path validation.
- Cancel applies the existing `cancel-goal` command and does not imply success.
- Graph opens the existing graph pane.
- Status reads one pure projection of canonical workflow and goal state.

Pause and cancel abandon any pending continuation through the existing continuation event path before the lifecycle command is committed.

## 3. Status surfaces

The same pure Hypagoal projection supplies:

- wide `/hypagoal status` output;
- narrow terminal status output;
- compact lifecycle notifications;
- the workflow summary and widget details;
- root-goal metadata in the graph view model;
- root-goal details in the graph pane.

Narrow rendering is verified at 52 columns. Wide rendering is verified at 110 columns. Every rendered line remains inside the requested width.

The graph pane shows:

- goal ID and status;
- exact objective;
- turn and token use;
- automatic revision allowance and outcome;
- current or next action;
- ready work;
- canonical stop reason or blocker;
- loop and evaluation summaries.

Existing node, edge, route, loop, and graph-state rendering remains unchanged.

## 4. Compact lifecycle messages

Pi emits compact canonical summaries when automatic execution reaches:

- workflow completion;
- workflow failure;
- cancellation;
- canonical blockage;
- goal turn or token exhaustion;
- explicit pause;
- session-reload pause;
- branch-change pause;
- invalid-usage pause;
- stale continuation delivery;
- interrupted delivered revision work.

The notification uses the same projection as `/hypagoal status`. It does not infer completion, recoverability, trust, or success from model prose.

A completed root reports goal status and workflow phase independently. A stale continuation reports its state-bound diagnostic code and cannot mutate repository or canonical workflow state during that turn.

## 5. Explicit terminal matrix

Focused product-surface tests cover:

- `goal_completed`;
- `goal_failed`;
- `goal_cancelled`;
- `pause_explicit`;
- `pause_session_reload`;
- `pause_branch_change`;
- `pause_usage_invalid`;
- `automatic_revision_eligible`;
- a non-revisable external blocker;
- `automatic_revision_exhausted`;
- `turn_limit`;
- `token_limit`;
- `loop_max_iterations`;
- `loop_no_progress`;
- `loop_invalid_evaluations`;
- `loop_evaluation_budget`;
- `stale_goal_revision`;
- `revision_turn_interrupted`;
- stale continuation delivery.

Loop exit reasons take precedence over generic goal failure in the product surface. A failed goal caused by a bounded loop therefore reports the exact loop limit, no-progress, invalid-evaluation, or evaluation-budget reason.

Blocked states distinguish:

1. an eligible single automatic revision;
2. a blocker which automatic revision cannot represent safely;
3. a consumed and exhausted revision allowance;
4. a rejected, stale, or interrupted revision outcome.

## 6. Safety and architecture

Slice 7 adds no new domain events, lifecycle, scheduler, revision engine, or completion path.

The implementation preserves:

- one root continuation selector;
- workflow-derived completion only;
- one canonical workflow for the root goal;
- exact objective preservation;
- the Slice 4 turn and token accounting path;
- the Slice 5 loop and trusted-evaluation model;
- the Slice 6 blocker classifier and bounded revision allowance;
- protected evaluator redaction;
- replay and restore without semantic work;
- later migration to goal-family view identities.

The model still has no tool which can mark a workflow or goal complete.

## 7. Verification

CI #1075 passes the complete matrix:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

The complete suite contains 94 test files and 460 tests.

No v0.6 tag or release was created. M5B Slice 8 remains responsible for final integrated dogfood and release evidence.
