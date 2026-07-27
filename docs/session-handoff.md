# Session handoff: v0.7 candidate after M6A and M6B

- Handoff date: 2026-07-27
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Implementation baseline before this slice: `affef6cfb5b604b2d890bb139a6a7062ef72ac1d`
- Slice 7 candidate commit: `a89dce344ebb21b1cd999ecd98c7388cff3c4da7`
- Published release: `v0.6`
- Release candidate: `v0.7`
- Completed milestones: M6A deterministic dispatch lane, M6B event history, replay, and debugger UI
- Current milestone: M6.1 interaction and approval nodes
- M6A plan: `docs/m6a-deterministic-dispatch-plan.md`
- M6B plan: `docs/m6b-event-history-plan.md`

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

## 2. Released and candidate state

M5A and M5B remain released as published `v0.6`.

M6A and M6B are complete in code and documentation for the `v0.7` release candidate.

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

The suite after M6B Slice 7 is 109 test files and 582 tests.

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

## 4. Immediate release work for v0.7

1. Land the M6B Slice 7 dogfood and release documentation on `main`.
2. Publish the `v0.7` tag and GitHub release from the accepted main commit.
3. Close stale issues for completed milestones when the release evidence is accepted.

## 5. Current target: M6.1 interaction and approval nodes

### Objective

Let the graph return to the user for a decision, and let a typed answer control the next work.

### Plan

`docs/m6-1-interaction-node-plan.md`

### Mandatory rules

- An interaction node does not stop an independent runnable component.
- The answer is typed and durable.
- The model cannot invent an answer as a completion claim.
- Replay and restore must not re-prompt for a stored answer.

## 6. Release evidence for the candidate

- M6A dogfood: `docs/m6a-dogfood.md`
- M6B dogfood: `docs/m6b-dogfood.md`
- Release notes: `docs/v0.7-release-notes.md`
- M6A plan status: complete
- M6B plan status: complete
- Suite: 109 test files and 582 tests

## 7. Deferred product direction

The following work remains accepted but deferred beyond M6.1:

- code nodes and the sandbox executor adapter;
- external effects and reconciliation;
- goal-family persistence;
- recursive child Hypagoals;
- executor abstraction and isolated Pi execution;
- worktree leases and integration;
- bounded physical concurrency;
- dynamic fan-out regions, only when a branch count is derived at run time;
- ACP and named direct agent adapters.

Rejected direction: a resident supervisor, a trigger service, or any persistent host process. Roadmap design rule 3.9 rejects them. A monitor node inside the graph meets the monitoring need.
