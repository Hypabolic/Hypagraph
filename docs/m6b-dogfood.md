# M6B dogfood evidence

- Date: 2026-07-27
- Milestone: M6B event history, replay, and debugger UI
- Release marker: v0.7
- Prerequisite: M6A deterministic dispatch lane
- Plan: `docs/m6b-event-history-plan.md`
- Live Pi model: `xai-auth/grok-4.5`
- Live extension: `./extensions/hypagraph.ts`
- Live short path: `docs/dogfood-evidence/m6b-live/` (case ID `CASE-M6B-RESULT-TXT`)
- Live loop and revision path: `docs/dogfood-evidence/m6b-live-loop-revision/` (case ID `CASE-M6B-LOOP-REVISION`)
- Automated product-path test: `tests/m6b-dogfood.test.ts`
- Recovery tests: `tests/hypagoal-continuation-pi.test.ts`, `tests/hypagoal-revision-pi.test.ts`
- Suite after this slice: 109 test files and 586 tests

## 1. Purpose

M6B makes execution and decisions inspectable. The runtime already stores an
append-only event stream and rebuilds the same state from that stream. Before
M6B the product did not show the stream, move through it, or explain a decision.

This dogfood has three layers:

1. a short live Pi path for task, check, history, and replay;
2. a live Pi path for loop, gate, automatic revision, and history;
3. an automated product-path test for regression.

The live sessions are the product proof. The automated test keeps the path
stable under CI.

## 2. Live Pi path A: task and check

### Objective

> Create result.txt with the exact text m6b-dogfood and verify that file with a
> deterministic command check.

### Result

| Measurement | Value |
| --- | --- |
| Final phase | completed |
| Final goal status | completed |
| Sequence | 21 |
| Scheduled actions | 2 |
| Nodes | `create-result` succeeded; `verify-result` succeeded |
| Facts | `result.created`, `result.verified` |
| Last action | deterministic check `verify-result` |

History, dispatch, explain, and replay surfaces were inspected in the same
session. Evidence: `docs/dogfood-evidence/m6b-live/`.

## 3. Live Pi path B: loop, gates, and automatic revision

### Objective

> Repair the failing lint rule, prepare the release note, and verify the
> released documentation.

### Seeded workspace

- `src/app.js` contained `TODO_LINT`;
- `scripts-lint.mjs` failed while that marker remained;
- README required a lint-repair loop, two gates, and one automatic revision.

### Observed execution

1. Authoring created the required graph with loop `lint-repair`.
2. Task `repair-lint` removed `TODO_LINT`.
3. Deterministic check `lint` passed and the loop completed through typed success.
4. Deterministic gate `route` selected `release-note` and skipped `investigate`.
5. `release-note` was blocked with `repository-work`.
6. Blocking a running attempt cancelled that attempt, so revision stayed eligible.
7. Automatic revision applied through `hypagoal_submit_revision` and added
   `prepare-note`.
8. After revision, `prepare-note`, `release-note`, deterministic check
   `documentation`, gate `publish-gate`, and task `publish` completed.
9. Goal completion was workflow-derived.

### Measured live result

| Measurement | Value |
| --- | --- |
| Final phase | completed |
| Final goal status | completed |
| Final revision | 2 |
| Stored event sequences | 83 |
| Scheduled actions | 10 |
| Automatic revision | 1 applied |
| Loop `lint-repair` | succeeded at iteration 1 through typed success |
| Deterministic actions | lint check, route gate, documentation check, publish-gate |
| Skipped routes | `investigate`, `revise-documentation` |
| Workspace outputs | `src/app.js` ready; `docs/release-note.md`; `publish.ok` |

Selected deterministic actions:

1. run-ready-check `lint`;
2. evaluate-ready-gate `route`;
3. run-ready-check `documentation`;
4. evaluate-ready-gate `publish-gate`.

Selected model-lane actions:

1. start-ready-task `repair-lint`;
2. start-ready-task `release-note` then block;
3. request-revision;
4. start-ready-task `prepare-note`;
5. start-ready-task `release-note`;
6. start-ready-task `publish`.

### Live history and debugger surfaces

After completion, the same Pi session inspected:

| Command | Observed result |
| --- | --- |
| `/hypagoal status` | phase completed; revision 2; automatic revision applied; loop succeeded |
| `/hypagraph history` | paged 83-event timeline with model and deterministic markers |
| `/hypagraph history dispatch` | model and deterministic lanes separated |
| `/hypagraph history revisions` | two revision segments; discarded `release-note` result reported |
| `/hypagraph history loop` | loop start, evaluation, and completion entries |
| `/hypagraph explain` | goal `stop-completed`; skipped-route reasons for investigate paths |
| `/hypagraph history 3` | early replay before loop work |
| `/hypagraph history 27` | mid-path replay when `release-note` first became ready |

Replay text included:

```text
Replay reads stored events only. It runs no check and calls no executor.
```

Evidence: `docs/dogfood-evidence/m6b-live-loop-revision/`.

## 4. Product fixes found by live dogfood

### Orphan model-lane continuation

A durable model-lane request can remain after the selected task succeeds, with no
delivered turn bookkeeping. The controller now closes that request when the
selected action is no longer runnable and selects the next action.

### Block while an attempt is open

Blocking a running node left the attempt open, so automatic revision was refused.
`block-node` now cancels the open attempt first. Projection also closes residual
open attempts on older blocked streams.

### Automatic revision submit without delivery bookkeeping

Live Pi can lose in-memory delivery bookkeeping while the durable
request-revision continuation remains. `hypagoal_submit_revision` now accepts
that durable request. `hypagraph_revise` is rejected while automatic revision is
pending.

## 5. Automated product-path dogfood

`tests/m6b-dogfood.test.ts` keeps a synthetic loop, gate, blocker, and revision
path under regression. It completes with revision 2, 100 events, and history
surface assertions.

## 6. Acceptance mapping

| Acceptance criterion | Live evidence |
| --- | --- |
| Replay to any event produces the correct historical state | path A sequence 3; path B sequences 3 and 27 |
| Live and replay views use common projection code | both live sessions |
| The user can identify why a node or a goal is not runnable | explain on completed and skipped nodes |
| History shows deterministic and model lanes separately | dispatch lane pages in both live sessions |
| Loop decisions are inspectable | `/hypagraph history loop` in path B |
| Revision history is inspectable | two revision segments in path B |
| Replay performs no external effect | replay text and completed final state |

## 7. Evidence files

- short live path: `docs/dogfood-evidence/m6b-live/`
- loop and revision live path: `docs/dogfood-evidence/m6b-live-loop-revision/`
- automated test: `tests/m6b-dogfood.test.ts`
- orphan recovery: `tests/hypagoal-continuation-pi.test.ts`
- revision submit recovery: `tests/hypagoal-revision-pi.test.ts`
- block-while-running: `tests/hypagoal-revision.test.ts`

## 8. Bound evidence

M6B does not change execution bounds. The live paths still depend on:

- loop iteration limits;
- the one automatic non-weakening revision allowance;
- the M6A consecutive-deterministic-dispatch maximum;
- model-turn accounting for delivered model-lane work only.
