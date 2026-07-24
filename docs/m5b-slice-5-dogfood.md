# M5B Slice 5 dogfood evidence

- Date: 2026-07-24
- Slice: M5B Slice 5, loop and trusted-evaluation continuation
- Implementation commit: `413bd73da72ada5eb1c2e16bb3ea4b9aa4a93218`
- Pull request: #71
- Verification run: CI #892
- Test result: 89 test files and 382 tests passing

## 1. Scenario

The realistic Pi smoke starts one root Hypagoal with two independent bounded regions:

- `quality`: a primary optimization region with a deterministic maximize metric, typed success, patience, invalid-evaluation limits, evaluation-attempt limits, and `fail-workflow` policy;
- `documentation-audit`: an independent auxiliary region with typed success and its own bounded lifecycle.

The primary evaluator is transparent and not isolated. The result is development feedback, not protected holdout acceptance.

The smoke uses automatic continuation after creation. It sends no manual continuation prompt.

## 2. Automatic selection order

The controller selected these state-bound actions:

1. `refine` in `quality`, iteration 0;
2. `audit` in `documentation-audit`, iteration 0;
3. `evaluate` in `quality`, iteration 1;
4. `audit-result` in `documentation-audit`, iteration 1;
5. `refine` in `quality`, iteration 2;
6. `evaluate` in `quality`, iteration 2;
7. `refine` in `quality`, iteration 3;
8. `evaluate` in `quality`, iteration 3;
9. `refine` in `quality`, iteration 4;
10. `evaluate` in `quality`, iteration 4.

The independent audit received a continuation before the first primary evaluation. The primary loop did not keep ownership because it emitted the latest loop event.

## 3. Evaluation history

The primary evaluation sequence was:

| Iteration | Valid | Metric | Typed success | Result |
| --- | --- | ---: | --- | --- |
| 1 | no | 0.1 | no | rejected; best metric remained absent |
| 2 | yes | 0.4 | no | current and best metric became 0.4 |
| 3 | yes | 0.7 | no | current and best metric became 0.7 |
| 4 | yes | 0.9 | yes | typed success completed the region |

The invalid result:

- increased the invalid-evaluation count;
- did not set current or best accepted progress;
- did not reset patience;
- did not satisfy typed success;
- did not complete the loop or workflow.

The metric alone did not complete the loop. Completion occurred only after the valid iteration-four result also satisfied typed success.

## 4. Independent state

The auxiliary region completed through its own typed result. Progress and evaluation events in `quality` did not reset, complete, or fail `documentation-audit`.

The final state contains:

- `quality`: succeeded at iteration 4 with best metric 0.9;
- `documentation-audit`: succeeded at iteration 1;
- four development evaluations consumed;
- no holdout or probe evaluation consumed.

## 5. Goal accounting

Each delivered continuation used the Slice 4 accounting path.

The final root budget state contains:

- 10 substantive turns consumed;
- 110 normalized tokens consumed;
- no duplicate charge;
- no budget-limited stop.

Loop iteration, patience, invalid-evaluation, evaluation-attempt, goal-turn, and goal-token counters remained separate.

## 6. Model-visible guidance

Focused tests prove that continuation guidance reports canonical values for:

- loop identity, status, iteration, and hard limit;
- typed success condition;
- last validity and last typed-success result;
- current and best accepted metric;
- progress direction and minimum delta;
- patience and no-progress count;
- invalid-evaluation count and limit;
- evaluation purpose and feedback mode;
- trust and isolation classification;
- per-kind and total evaluation-attempt budgets;
- public evaluator version and compact fingerprint;
- integrity status and protected-evidence count;
- declared loop failure policy and current exit state.

The guidance states that validity, progress, and typed success are separate. It also states that independent runnable components remain eligible.

## 7. Protected evaluator boundary

Model-visible graph, summary, continuation, check-start, and check-result paths do not reveal:

- full evaluator fingerprints;
- protected commands or arguments;
- protected report paths;
- stdout or stderr artifact paths;
- raw reports;
- hidden assertions;
- holdout details.

The normal product UI can retain canonical evaluator identity. The model-facing projection uses the public compact fingerprint and declared feedback contract.

## 8. Stale identity, replay, and restore

Tests prove that a queued loop continuation becomes stale when the canonical loop iteration changes before delivery.

The smoke restores the completed session and reproduces:

- both loop outcomes;
- invalid-evaluation count;
- current and best accepted metric;
- evaluation-attempt counts;
- goal turn and token usage;
- workflow and goal completion.

Restore queues no continuation, starts no evaluator, and consumes no turn or evaluation attempt.

## 9. Architecture review

The implementation adds no:

- second workflow, task, loop, evaluation, or loss-function model;
- second scheduler;
- domain command, event, schema, or reducer lifecycle;
- model-owned completion path;
- child goal or family state;
- executor, subagent, or worktree state;
- physical concurrency;
- restore-time semantic dispatch.

The existing loop, evaluation, workflow-outcome, continuation, and goal-budget runtimes remain authoritative.

## 10. Result

M5B Slice 5 satisfies its completion criteria:

- loop and evaluation guidance comes from canonical state;
- validity, score, typed success, trust, and budgets remain distinct;
- protected evaluator details stay protected;
- invalid evaluation cannot corrupt progress or success;
- independent components receive fair continuation;
- the realistic multi-component smoke completes without manual continuation;
- replay and restore reproduce the same state without dispatch;
- the complete six-target CI matrix passes.
