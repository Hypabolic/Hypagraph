# M6B dogfood evidence

- Date: 2026-07-27
- Milestone: M6B event history, replay, and debugger UI
- Release marker: v0.7
- Prerequisite: M6A deterministic dispatch lane
- Plan: `docs/m6b-event-history-plan.md`
- Live Pi session: real RPC session with `xai-auth/grok-4.5` and the local extension
- Live evidence: `docs/dogfood-evidence/m6b-live/`
- Automated product-path test: `tests/m6b-dogfood.test.ts`
- Orphan-continuation recovery test: `tests/hypagoal-continuation-pi.test.ts`
- Suite after this slice: 109 test files and 583 tests

## 1. Purpose

M6B makes execution and decisions inspectable. The runtime already stores an
append-only event stream and rebuilds the same state from that stream. Before
M6B the product did not show the stream, move through it, or explain a decision.

This dogfood has two layers:

1. a live Pi session on this machine;
2. an automated product-path test for revision and loop coverage.

The live session is the product proof. The automated test keeps the larger
revision path regression-safe.

## 2. Live Pi dogfood

### Environment

- host command path: Pi RPC mode;
- model: `xai-auth/grok-4.5`;
- extension: `./extensions/hypagraph.ts` from this branch;
- workspace: temporary empty directory with one README;
- objective:

> Create result.txt with the exact text m6b-dogfood and verify that file with a
> deterministic command check.

### Authoring

`/hypagoal` started one authoring turn. The model inspected the empty workspace
and called `hypagoal_start` with:

- one task, `create-result`;
- one command check, `verify-result`;
- dotted lower-case facts `result.created` and `result.verified`.

The first authoring attempt was rejected once for invalid fact names. A second
`/hypagoal` authoring turn produced a valid graph.

### Execution

The model-lane continuation selected `create-result`. The model wrote
`result.txt` with exact content `m6b-dogfood`, published `result.created`, and
verified the task.

Live Pi left the durable model-lane request open after that task succeeded. The
controller recovered:

1. it closed the orphaned model-lane continuation;
2. it selected `run-ready-check` for `verify-result` in the deterministic lane;
3. the check passed and published `result.verified`;
4. the workflow and goal completed through canonical state.

Final workspace file:

```text
m6b-dogfood
```

### Measured live result

| Measurement | Value |
| --- | --- |
| Final workflow phase | completed |
| Final goal status | completed |
| Final revision | 1 |
| Stored event sequences | 21 |
| Scheduled actions | 2 |
| Charged model turns | 0 |
| Last action | deterministic lane; completed; run check `verify-result` |
| Nodes | `create-result` succeeded; `verify-result` succeeded |
| Facts | `result.created`, `result.verified` |

Charged model turns are 0 because the model-lane request was abandoned before
turn accounting closed it. The task work still happened through Hypagraph tools
during the open agent run. The recovery path is the important product result:
without it the ready check never dispatched.

### Live history and debugger surfaces

After completion, the same Pi session inspected:

| Command | Observed result |
| --- | --- |
| `/hypagoal status` | phase completed; goal completed; scheduled actions 2; last action deterministic check |
| `/hypagraph history` | 21-event timeline with model and deterministic dispatch markers |
| `/hypagraph history dispatch` | model selection, model abandon, deterministic select/dispatch/complete |
| `/hypagraph history revisions` | one revision segment; no discarded results |
| `/hypagraph explain` | goal decision `stop-completed`; both nodes succeeded |
| `/hypagraph history 3` | replay at the goal-started event with difference from live sequence 21 |

Replay text included:

```text
Replay reads stored events only. It runs no check and calls no executor.
```

Timeline dispatch markers included:

1. model lane selected start task `create-result`;
2. model lane abandoned the orphaned continuation;
3. deterministic lane selected run check `verify-result`;
4. deterministic lane dispatched and completed that check.

### Live recovery fix recorded during dogfood

The first live run stuck after the task succeeded. The durable model-lane
continuation still named `create-result`, so the ready check never dispatched.

The controller now recovers when:

- a durable model-lane continuation exists;
- no delivered turn bookkeeping exists;
- the selected action is no longer runnable.

Recovery abandons that continuation and selects the next action. Evidence:

- live notification: `Hypagoal closed an orphaned model-lane continuation and will select the next action.`;
- event 11: `hypagraph.goal.continuation-abandoned`;
- events 12 to 21: deterministic check dispatch through goal completion;
- regression test: `closes an orphaned model-lane continuation after the selected task succeeds`.

## 3. Automated product-path dogfood

`tests/m6b-dogfood.test.ts` keeps a larger synthetic path under regression:

- one bounded two-iteration lint-repair region;
- two command checks and two gates;
- one recoverable repository blocker;
- one automatic non-weakening revision that adds `prepare-note`;
- timeline, three replay points, blocked-node and skipped-route explanations,
  and revision history.

That path completes with:

| Measurement | Value |
| --- | --- |
| Final phase | completed |
| Final revision | 2 |
| Stored events | 100 |
| Charged model turns | 7 |
| Scheduler ordinal | 12 |
| Loop iterations for `lint-repair` | 2 |

The automated path is not a substitute for the live Pi session. It covers the
revision and loop shapes that the short live objective does not exercise.

## 4. Acceptance mapping

| Acceptance criterion | Live Pi evidence | Automated evidence |
| --- | --- | --- |
| Replay to any event produces the correct historical state | `/hypagraph history 3` against sequence 21 | three replayed sequences in `tests/m6b-dogfood.test.ts` |
| Live and replay views use common projection code | replay surface renders workflow through the live projector | same |
| The user can identify why a node or a goal is not runnable | `/hypagraph explain` after completion | blocked and skipped-route explanations |
| Protected evaluator data remains protected | presentation redaction policy remains in force | Slice 3 to 6 tests |
| Future family and executor namespaces have a defined seam | Slice 6 fixture coverage | `tests/m6b-revisions-and-seams.test.ts` |
| History shows a directly dispatched M6A action and separates it from a model turn | dispatch lane shows model and deterministic markers | dispatch-lane assertions |
| Replay performs no check and no external effect | replay text and unchanged completed state | event count and snapshot hash stay fixed |
| M6B adds no schema version, no event type, and no stored field | schema remains version 6 | schema remains version 6 |

## 5. Evidence files

- live summary notifications: `docs/dogfood-evidence/m6b-live/summary.json`
- live canonical extract: `docs/dogfood-evidence/m6b-live/canonical.json`
- live result file: `docs/dogfood-evidence/m6b-live/result.txt`
- automated test: `tests/m6b-dogfood.test.ts`
- orphan recovery test: `tests/hypagoal-continuation-pi.test.ts`

## 6. Bound evidence

M6B does not change execution bounds. The live and automated paths still depend on:

- loop iteration limits where a loop exists;
- the one automatic non-weakening revision allowance;
- the M6A consecutive-deterministic-dispatch maximum;
- model-turn accounting for delivered model-lane work only.
