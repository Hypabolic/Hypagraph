# M6A dogfood evidence

- Date: 2026-07-25
- Milestone: M6A deterministic dispatch lane
- Release marker: v0.7
- Prerequisite: v0.6
- Plan: `docs/m6a-deterministic-dispatch-plan.md`
- Dogfood test: `tests/m6a-dogfood.test.ts`
- Integrated release path test: `tests/m5b-v0-6-release-dogfood.test.ts`
- Loop continuation test: `tests/hypagoal-loop-continuation-pi.test.ts`
- Suite after M6A: 102 test files and 508 tests

## 1. Purpose of the measurement

M6A removes the model turn from every canonical action which needs no reasoning.
Before M6A the controller delivered every selected action as a Pi follow-up, and
it charged one substantive turn for each delivery. A ready check and a ready gate
need no reasoning, so each one cost a turn for a tool call only.

The measurement below counts the selected actions in each lane for one run. The
scheduler ordinal counts every selected action in every lane. Before M6A each
selected action was one delivered model turn, so the scheduler ordinal is the
exact pre-M6A model-turn count for the same canonical path.

## 2. Dogfood objective

The dogfood scenario runs this exact objective:

> Repair the failing lint rule, record the release note, and verify the released
> documentation.

The workflow contains:

- one bounded two-iteration lint-repair region;
- two command checks, one inside the iteration region and one after the release note;
- two typed gates with one selected route and one skipped route each;
- four repository tasks.

The lint check fails on its first attempt and passes on its second attempt, so
the iteration region completes two iterations through canonical feedback.

## 3. Measured model turns

| Measurement | Value |
| --- | --- |
| Selected actions in every lane | 9 |
| Model-lane actions after M6A | 4 |
| Deterministic-lane actions after M6A | 5 |
| Charged model turns before M6A | 9 |
| Charged model turns after M6A | 4 |
| Reduction | 5 turns, which is 56 percent |

The selected lane order is deterministic:

1. model lane, start ready task `repair-lint`, iteration 1;
2. deterministic lane, run ready check `lint`, which fails and continues the region;
3. model lane, start ready task `repair-lint`, iteration 2;
4. deterministic lane, run ready check `lint`, which passes and satisfies typed success;
5. deterministic lane, evaluate ready gate `route`;
6. model lane, start ready task `release-note`;
7. deterministic lane, run ready check `documentation`;
8. deterministic lane, evaluate ready gate `publish-gate`;
9. model lane, start ready task `publish`.

## 4. Two further measured paths

The two existing integrated Pi paths show the same result on larger graphs.

| Path | Model turns before M6A | Model turns after M6A |
| --- | --- | --- |
| Loop continuation with an independent region | 10 | 6 |
| v0.6 release product path | 15 | 10 |

The v0.6 release path contains two iteration regions, one development evaluator
with four observations, one probe evaluator, one typed gate, one bounded
automatic revision, and canonical completion. Every check and every gate on that
path now runs in the deterministic lane.

## 5. Canonical result is unchanged

Each path produces the same canonical result as before M6A:

- the same node, attempt, check, fact, route, and loop events;
- the same iteration counts, metrics, best results, and typed success decisions;
- the same evaluation counts, so a metric evaluation consumes evaluation budget
  exactly once for each external start;
- the same selected and skipped routes;
- the same stop decision;
- the same replayed state, because replay of the complete event stream equals the
  stored snapshot.

## 6. Bound evidence

Deterministic work consumes no turn, so a turn budget is not its bound. The
remaining bounds are unchanged:

- loop iteration limits, patience, and evaluation budgets. A graph which has no
  task node stops at its loop iteration limit and charges no turn;
- check retry limits and retry status policy;
- an explicit maximum of 64 consecutive deterministic dispatches in one
  controller pass, which protects against an authoring error that creates a
  large deterministic cycle.

## 7. Accounting and surface evidence

- `/hypagoal status` reports the scheduled action count, the charged model-turn
  count, and this rule: consumed turns count model turns only, a deterministic
  action consumes no turn, and a turn-budget stop ends automatic continuation in
  every lane.
- The model-visible workflow view reports the same rule.
- The dogfood run charges 4 turns of a 12-turn budget and reports 9 scheduled
  actions, so a user who compares node count with turn count does not think that
  work is missing.

## 8. Reload, restore, and replay evidence

- Restore rebuilds canonical state and runs no deterministic action. A reload and
  a branch change still pause the goal.
- A host which stops between the dispatched event and the terminal event leaves a
  pending dispatch. Restore records one interrupted action event, so a lost
  dispatch cannot block a later selection.
- An interrupted check attempt closes through the existing check recovery path.
- Replay of a mixed model and deterministic run reproduces the same state, the
  same routes, and the same stop decision.

## 9. Cancellation and manual surface evidence

- A directly dispatched check registers its attempt in the active-execution
  registry, so `/hypagraph check cancel` and `hypagraph_cancel_check` stop it.
- A cancelled dispatch records an interrupted action outcome and charges no turn.
- `hypagraph_run_check` and the evaluate action of `hypagraph_transition` remain
  available, so a user or a model can still run a check or a gate explicitly.
