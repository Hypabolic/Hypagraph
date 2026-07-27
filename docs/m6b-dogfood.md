# M6B dogfood evidence

- Date: 2026-07-27
- Milestone: M6B event history, replay, and debugger UI
- Release marker: v0.7
- Prerequisite: M6A deterministic dispatch lane
- Plan: `docs/m6b-event-history-plan.md`
- Dogfood test: `tests/m6b-dogfood.test.ts`
- Suite after M6B: 109 test files and 582 tests

## 1. Purpose of the measurement

M6B makes execution and decisions inspectable. The runtime already stores an
append-only event stream and rebuilds the same state from that stream. Before
M6B the product did not show the stream, move through it, or explain a decision.

The dogfood run proves one product path that mixes:

- model-lane task work;
- deterministic-lane checks and gates;
- one bounded iteration region;
- one automatic non-weakening workflow revision;
- timeline, replay, explanation, and revision surfaces.

## 2. Dogfood objective

The dogfood scenario runs this exact objective:

> Repair the failing lint rule, prepare the release note, and verify the released
> documentation.

The workflow contains:

- one bounded two-iteration lint-repair region;
- two command checks, one inside the iteration region and one after the release note;
- two typed gates with one selected route and one skipped route each;
- one recoverable repository blocker on the release note;
- one automatic revision that adds a `prepare-note` task;
- five repository tasks after the revision path.

The lint check fails on its first attempt and passes on its second attempt, so
the iteration region completes two iterations through canonical feedback.

## 3. Measured product path

| Measurement | Value |
| --- | --- |
| Final workflow phase | completed |
| Final goal status | completed |
| Final revision | 2 |
| Stored event sequences | 100 |
| Timeline entries | 100 |
| Charged model turns | 7 |
| Scheduler ordinal | 12 |
| Automatic revision attempts | 1 applied |
| Loop iterations for `lint-repair` | 2 |
| Lint check attempts | 2 |

Selected model-lane work order:

1. start task `repair-lint`, iteration 1;
2. start task `repair-lint`, iteration 2;
3. start task `release-note`, then block it;
4. request the automatic revision;
5. start task `prepare-note`;
6. start task `release-note` again;
7. start task `publish`.

Deterministic-lane actions between those model turns:

1. run check `lint` and fail it;
2. run check `lint` and pass it;
3. evaluate gate `route`;
4. run check `documentation`;
5. evaluate gate `publish-gate`.

## 4. Timeline evidence

`/hypagraph history` renders a bounded page of the complete event stream.

- The page reports the total entry count and the sequence range.
- The marker legend names the model lane, the deterministic lane, the executor
  lane, and protected evaluator detail.
- `/hypagraph history dispatch` keeps only dispatch-lane entries and shows both
  model-lane task selection and deterministic-lane check and gate selection.
- The timeline marks the workflow revision boundary.

Lane counts for the dogfood stream:

| Lane | Entries |
| --- | --- |
| node | 46 |
| dispatch | 29 |
| goal | 6 |
| check | 6 |
| loop | 5 |
| fact | 3 |
| workflow | 3 |
| route | 2 |

Of the 29 dispatch-lane entries, 14 belong to the model lane and 15 belong to the
deterministic lane.

## 5. Replay evidence

The dogfood inspects three sequences:

| Sequence | Meaning | Result |
| --- | --- | --- |
| first `repair-lint` attempt start | early work | revision 1, node `repair-lint` is `running`, workflow is not complete |
| `hypagraph.workflow.revised` | revision boundary | revision 2, definition contains `prepare-note` |
| live sequence | final state | replay equals live state, comparison is identical |

Each replay surface states that replay reads stored events only. It runs no check
and calls no executor. Three successive replay commands leave the stored event
count and the snapshot hash unchanged.

## 6. Explanation evidence

While the release note is blocked, `/hypagraph explain release-note` reports:

- node status `blocked`;
- reason kind `blocked`;
- the recoverable repository-work blocker text.

After completion, `/hypagraph explain investigate` reports:

- node status `skipped`;
- reason kind `skipped-route`;
- gate `route` selected outcome `true`.

`/hypagraph explain` reports the goal decision and one line for every node.

`hypagraph_read` with the `history` and `explain` views returns the same
redacted projection that the command surface uses.

## 7. Revision history evidence

`/hypagraph history revisions` reports two revision segments:

- revision 1 from the first event through the revision boundary;
- revision 2 from the revision event through the live sequence.

The revision projection reads the same stored events as the timeline. It does
not create a new schema version, a new event type, or a new stored field.

## 8. Acceptance mapping

| Acceptance criterion | Evidence |
| --- | --- |
| Replay to any event produces the correct historical state | three replayed sequences in the dogfood test |
| Live and replay views use common projection code | `renderReplayAtSequence` and `renderWorkflow` share the live projection path |
| The user can identify why a node or a goal is not runnable | blocked `release-note` and skipped `investigate` explanations |
| Protected evaluator data remains protected in history views | presentation redaction policy from M6B slices 3 to 6 remains in force |
| Future family and executor namespaces have a defined projection seam | Slice 6 fixture coverage in `tests/m6b-revisions-and-seams.test.ts` |
| The history view shows a directly dispatched M6A action and separates it from a model turn | dispatch-lane page contains deterministic and model markers |
| Replay performs no check, no executor call, and no external effect | event count and snapshot hash stay fixed after three replays |
| M6B adds no schema version, no event type, and no stored field | schema remains version 6; dogfood uses existing events only |

## 9. Restore evidence

After completion, a session reload rebuilds the completed state and queues no
continuation. The restored snapshot hash matches the live completed hash.

## 10. Bound evidence

M6B does not change execution bounds. The dogfood still depends on:

- loop iteration limits for the lint-repair region;
- the one automatic non-weakening revision allowance;
- the M6A consecutive-deterministic-dispatch maximum for check and gate work;
- exact model-turn accounting for task and revision work only.
