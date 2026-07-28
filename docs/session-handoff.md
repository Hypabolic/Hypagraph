# Session handoff: M6.1 Slice 4 complete

- Handoff date: 2026-07-28
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Release baseline: `fa95046ce021d8ebd7051bbb439bb2d27661ba22`
- Published release: `v0.7`
- Completed milestones: M6A deterministic dispatch lane, M6B event history, replay, and debugger UI
- Current milestone: M6.1 interaction and approval nodes
- Live Pi dogfood evidence: `docs/dogfood-evidence/m6b-live/`, `docs/dogfood-evidence/m6b-live-loop-revision/`, and `docs/m6b-dogfood.md`
- M6A plan: `docs/m6a-deterministic-dispatch-plan.md`
- M6B plan: `docs/m6b-event-history-plan.md`
- M6.1 plan: `docs/m6-1-interaction-node-plan.md`

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/execution-roadmap.md`;
4. `docs/product-spec.md`;
5. `docs/m6a-dogfood.md`;
6. `docs/m6b-dogfood.md`;
7. `docs/v0.7-release-notes.md`;
8. `docs/m6-1-interaction-node-plan.md`;
9. `docs/goal-family-and-concurrent-execution-plan.md`.

## 2. Released state

M5A and M5B remain available as published `v0.6`.

M6A and M6B are complete and published as `v0.7`.

M6A provides:

- a generic action-dispatch model with deterministic, model, and executor lanes;
- direct deterministic evaluation of a ready gate;
- direct deterministic execution of a ready check;
- model-turn accounting only;
- interrupted-dispatch recovery on reload.

M6B provides:

- a typed event timeline with lane classification, paging, and filters;
- replay to any stored sequence with a live comparison;
- canonical node and goal explanations;
- `/hypagraph history`, `/hypagraph explain`, and matching `hypagraph_read` views;
- graph-pane replay mode;
- revision segments, discarded results, and future-namespace projection seams;
- one presentation redaction policy for protected evaluator detail.

## 3. Preserved invariants

Do not weaken these invariants during M6.1 and later work:

- canonical state changes only through the controller and reducers;
- workflow state remains authoritative for goal completion;
- the model has no workflow-completion or goal-completion tool;
- one durable event sequence defines one workflow aggregate;
- snapshot hashes include canonical state;
- stale, cancelled, and pre-revision results cannot change current state;
- restore and replay do not repeat external effects;
- protected evaluator internals remain outside model-visible output;
- independent branches and bounded regions keep independent lifecycle state;
- the root can later become a one-member goal family without rewriting workflow events;
- M6B adds no schema version, no event type, and no stored field.

## 4. Current target: M6.1 interaction and approval nodes

### Objective

Let the graph return to the user for a decision, and let a typed answer control the next work.

### Plan

`docs/m6-1-interaction-node-plan.md`

### Mandatory rules

- An interaction node does not stop an independent runnable component.
- The answer is typed and durable.
- The model cannot invent an answer as a completion claim.
- Replay and restore must not re-prompt for a stored answer.
- A presentation effect runs only after the request event is stored.
- A successful presentation observation must not re-run the external effect.

### Slice status

Slice 1 is complete in commit `45c26c9`. It adds the `interaction` node kind, the `awaiting_response` status, the request and answer lifecycle, and declared response facts. `tests/m6-1-interaction-slice-1.test.ts` holds the tests.

Slice 1.1 is complete. It adds `hypagraph_ask` and the closed and open dialog surfaces. It adds `/hypagraph ask` and waiting status and widget surfaces. A dialog opens only when no other action is runnable. Independent branches and loops keep running while a question waits. `tests/m6-1-interaction-slice-1-1.test.ts` holds the tests.

Slice 2 is complete. It adds deterministic presentation kinds `none`, `report`, and `command`. Durable order is request, presentation effect, `present-interaction` observation, then dialog. Artifacts use `.hypagraph/check-artifacts` through `FileCheckArtifactStore`. A failed effect stores an explicit failed node. Semantic presentation still fails validation with a diagnostic which names M7. Evidence:

- `src/checks/presentation-executor.ts`
- `src/domain/presentation-report.ts`
- `src/domain/model-base.ts`
- `src/domain/reducer.ts`
- `src/domain/projection-base.ts`
- `src/domain/validate.ts`
- `src/extension.ts`
- `tests/m6-1-interaction-slice-2.test.ts`

Slice 3 is complete. Routing uses published interaction facts through ordinary gates. Free-text notes and feedback artifacts never select a route. Feedback reaches the next task through `projectTaskContext`, continuation prompts, and `hypagraph_read`. Deadlines are level-triggered: the request stores an absolute deadline, and `expire-interaction` evaluates it with a supplied time. The extension evaluates outstanding deadlines when the controller wakes. An open presentation defers deadline evaluation until the next controller entry. Evidence: `tests/m6-1-interaction-slice-3.test.ts`.

Slice 4 is complete. Outstanding interactions survive reload. After `/hypagoal resume`, the controller re-presents the question when the wait is the only stop. A stored presentation observation prevents a repeated external presentation effect. Status surfaces and the graph pane show node-local awaiting. The derived goal waiting state appears only when no runnable action exists. Evidence:

- `src/domain/interaction-presentation.ts`
- `src/ui/interaction-surface.ts`
- `src/graph/projection.ts`
- `src/graph/renderer.ts`
- `src/pi/graph-pane.ts`
- `src/extension.ts`
- `tests/m6-1-interaction-slice-4.test.ts`

### Next work

Slice 5 is next: dogfood one objective with plan approval and one independent loop, prove the loop continues while approval waits, and record evidence in `docs/m6-1-dogfood.md`.

## 5. Release evidence

- M6A dogfood: `docs/m6a-dogfood.md`
- M6B dogfood: `docs/m6b-dogfood.md`
