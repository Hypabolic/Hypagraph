# Session handoff: M6.1 Slice 1 complete

- Handoff date: 2026-07-28
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Release baseline: `fa95046ce021d8ebd7051bbb439bb2d27661ba22`
- Current baseline: `8fc2b50fddef06fb279f78af74bf3b544e39604a`
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

The suite after M6B Slice 7 is 109 test files and 586 tests.

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

### Slice status

Slice 1 is complete in commit `45c26c9`. It adds the `interaction` node kind, the `awaiting_response` status, the request and answer lifecycle, declared response facts, and a Pi command which accepts an answer. `tests/m6-1-interaction-slice-1.test.ts` holds the tests.

Slice 2 deterministic presentation effects is the next work. Validation accepts only presentation kind `none` at this time. `src/domain/validate.ts` holds the rule.

The suite at the current baseline is 110 test files and 595 tests.

## 5. Release evidence

- M6A dogfood: `docs/m6a-dogfood.md`
- M6B dogfood: `docs/m6b-dogfood.md`
- Live Pi evidence: `docs/dogfood-evidence/m6b-live/` and `docs/dogfood-evidence/m6b-live-loop-revision/`
- Release notes: `docs/v0.7-release-notes.md`
- Release baseline: `fa95046ce021d8ebd7051bbb439bb2d27661ba22`
- Suite: 109 test files and 586 tests
- Release: https://github.com/Hypabolic/Hypagraph/releases/tag/v0.7

## 6. Deferred product direction

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
