# Session handoff: M5B Slice 7 complete to Slice 8

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `90c54214c5337be01e455145a36232a392172fae`
- Last merged pull request: #75 — Complete Hypagoal Pi product surface
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 7, complete Pi product surface
- Current slice: M5B Slice 8, final dogfood and v0.6 release
- Hypagoal tracking issue: #25
- Release marker: v0.6 after the Slice 8 integrated dogfood passes on the tested main commit

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
11. `docs/m5b-slice-7-dogfood.md`;
12. issue #25.

Use issue #25 as the active M5B checklist.

The existing workflow reducer, goal runtime, continuation selector, loop and evaluation runtime, budget accounting, blocker classifier, bounded revision path, and Slice 7 product projection are authoritative. Slice 8 validates and releases this product. It must not add another lifecycle, scheduler, evaluation model, revision engine, or completion path.

## 2. Current repository state

M5B Slices 1 through 7 are complete.

The current implementation baseline is `90c54214c5337be01e455145a36232a392172fae`.

PR #75 merged M5B Slice 7.

CI #1075 and final PR CI #1077 pass:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 94 test files and 460 tests.

No v0.6 tag or release exists yet. Slice 8 owns final integrated dogfood, version alignment, the tested-main tag, and release evidence.

## 3. Delivered root Hypagoal product

### 3.1 Canonical execution

One root Hypagoal owns one canonical workflow. `HypagraphDefinition.goal` remains the exact user objective.

Workflow state is authoritative for readiness, attempts, evidence, checks, gates, routes, loop outcomes, blockage, revision invalidation, and terminal state. A model cannot mark the workflow or goal complete.

The Slice 3 continuation selector remains the only root scheduling authority. It interleaves disconnected branches and independent bounded regions with durable state-bound identity.

### 3.2 Budgets and safety

Goal turns and normalized tokens are event-backed and charged exactly once. They remain separate from loop iterations, patience, invalid-evaluation limits, evaluation budgets, check retries, and the one automatic revision allowance.

Reload, branch change, and invalid usage pause autonomous execution. Restore and replay perform no semantic work.

Protected evaluator commands, paths, reports, hashes, stdout, stderr, and holdout details remain outside model-visible output.

### 3.3 Bounded revision

Canonical blockage classification decides whether one automatic graph revision is eligible. The revision is state-bound, preserves the objective byte-for-byte, cannot weaken safeguards, consumes the single allowance when requested, and applies only through the existing workflow revision and invalidation reducer.

### 3.4 Pi product surface

`/hypagoal` supports:

- `/hypagoal <objective>`;
- `/hypagoal status`;
- `/hypagoal pause [reason]`;
- `/hypagoal resume`;
- `/hypagoal cancel [reason]`;
- `/hypagoal graph`.

The pure product projection exposes:

- exact objective;
- workflow phase, revision, and event sequence;
- goal status, pause cause, and stop reason;
- active action, next action, and ready work;
- consumed, maximum, and remaining turn and token budgets;
- loop iteration, typed success, progress, patience, evaluation validity, evaluation budgets, trust, and integrity summaries;
- blocker class and revision eligibility;
- automatic revision allowance, pending state, and last outcome;
- explicit stop codes;
- valid lifecycle controls for the current state.

The same projection supplies wide and narrow status, compact lifecycle messages, model-visible state, and graph-pane root-goal details.

Exact product coverage includes completion, failure, cancellation, all pause causes, goal budgets, revision eligibility and exhaustion, non-revisable blockage, loop hard limit, no progress, invalid evaluations, evaluation budget, stale continuation or revision, and interrupted revision work.

Evidence is in `docs/m5b-slice-7-dogfood.md`.

## 4. Current target: M5B Slice 8

### Objective

Run one final integrated root-Hypagoal dogfood path, close any product defects it exposes, align package versions, and release v0.6 from the exact tested main commit.

### Required integrated scenario

The final dogfood must:

1. start from one prose `/hypagoal` command;
2. compile one graph with at least one deterministic gate;
3. run one refinement or optimization region for at least three iterations;
4. run one independent bounded auxiliary region;
5. use check-and-repair as one pattern, not the default loop model;
6. improve one numeric progress metric;
7. reject one invalid evaluation without updating best progress;
8. run a probe or generalization check;
9. complete only through typed success and canonical workflow completion;
10. prove independent-region isolation and fair scheduling;
11. restore between iterations without automatic dispatch;
12. prove reload-time pause and explicit resume;
13. prove turn-budget and token-budget termination;
14. prove evaluation-budget termination;
15. prove hard-limit and no-progress termination;
16. prove each loop failure policy;
17. prove stale-continuation rejection;
18. prove one bounded automatic revision and revision exhaustion;
19. prove that the model cannot mark the goal complete;
20. record that the root identities and workflow event history can enter the future one-member family projection without rewriting workflow state.

Use the Slice 5, Slice 6, and Slice 7 evidence as component evidence, but add one integrated end-to-end record for the release candidate.

### Release work

After the integrated scenario and complete suite pass:

1. update package and lock-file versions to v0.6 consistently;
2. update user-facing release notes and installation documentation where required;
3. run the complete six-target matrix on the exact release candidate commit;
4. merge the release PR;
5. verify the exact main commit;
6. create the v0.6 tag on that tested main commit;
7. create the release and attach or link the dogfood and CI evidence;
8. update issue #25 and the roadmap to mark M5B complete.

Do not tag before the release candidate main commit has passed the complete matrix.

### Product constraints

Slice 8 must not add:

- child or recursive Hypagoals;
- family persistence or scheduling;
- a second scheduler;
- executors or subagents;
- worktree leases;
- physical concurrency;
- ACP or direct CLI adapters;
- model-owned completion;
- unbounded revision;
- a new loop or evaluation model.

Those capabilities remain planned after v0.6.

## 5. Validation baseline

The pre-release baseline is:

- implementation merge: `90c54214c5337be01e455145a36232a392172fae`;
- implementation PR: #75;
- CI: #1075 and #1077;
- test files: 94;
- tests: 460;
- product evidence: `docs/m5b-slice-7-dogfood.md`.

Slice 8 must report its own final release-candidate matrix and exact tagged main SHA.

## 6. Suggested implementation

- Branch: `agent/m5b-slice-8-dogfood-release`
- Pull-request title: `Dogfood and release Hypagoal v0.6`

## 7. Required final report

Report:

- release PR and merge SHA;
- exact tagged main SHA;
- v0.6 tag and release;
- files changed;
- integrated dogfood result;
- exact test count;
- six-target release-candidate CI result;
- issue #25 and roadmap state;
- confirmation that M5B is complete;
- any deferred work for M6 or later milestones.
