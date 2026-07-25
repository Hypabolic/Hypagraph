# Session handoff: v0.6 released to M6A

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Release baseline: `90a2885bb8f46d61cedd803897ca4d32246bcb44`
- Release: `v0.6`
- Release pull request: #77 — Dogfood and release Hypagoal v0.6
- Completed milestone: M5B root Hypagoal autonomous controller
- Current milestone: M6A deterministic dispatch lane. The former M6 is now M6B event history, replay, and debugger UI. See `docs/execution-roadmap.md`.
- Hypagoal tracking issue: #25

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/execution-roadmap.md`;
4. `docs/product-spec.md`;
5. `docs/hypagoal-vertical-slice-plan.md`;
6. `docs/v0.6-dogfood.md`;
7. `docs/event-sourcing-and-replay.md` if it exists;
8. `docs/goal-family-and-concurrent-execution-plan.md`;
9. issue #25 for the completed M5B record.

## 2. Released state

M5A and M5B are complete and released as v0.6.

The release contains:

- trusted evaluation contracts;
- one workflow-local root Hypagoal lifecycle;
- atomic `/hypagoal` creation from ordinary prose;
- graph-aware automatic continuation;
- exact turn and normalized token budgets;
- reload, branch-change, and invalid-usage pause;
- loop-aware and trusted-evaluation-aware continuation;
- deterministic canonical blocker classification;
- one bounded non-weakening automatic workflow revision;
- `/hypagoal` status, pause, resume, cancel, and graph controls;
- compact lifecycle messages and explicit typed stop reasons;
- complete integrated release dogfood.

Final release-candidate CI #1111 and exact-main publication gate CI #1114 pass 95 test files and 461 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

Tag and GitHub release `v0.6` point to `90a2885bb8f46d61cedd803897ca4d32246bcb44`.

## 3. Preserved invariants

Do not weaken these invariants during M6A and M6B:

- canonical state changes only through the controller and reducers;
- workflow state remains authoritative for goal completion;
- the model has no workflow-completion or goal-completion tool;
- one durable event sequence defines one workflow aggregate;
- snapshot hashes include canonical state;
- stale, cancelled, and pre-revision results cannot change current state;
- restore and replay do not repeat external effects;
- protected evaluator internals remain outside model-visible output;
- independent branches and bounded regions keep independent lifecycle state;
- the v0.6 root can later become a one-member goal family without rewriting workflow events.

## 4. Current target: M6A deterministic dispatch

### Objective

Run every canonical action which needs no reasoning without a model turn.

A check runs through `runPiCheck`, which is a function of state, executor, and store. A gate is one `evaluate-gate` reducer command. Both currently cost one charged model turn, because the controller delivers every selected action as a Pi follow-up.

The detailed plan is in `docs/m6a-deterministic-dispatch-plan.md`.

### Vertical slices

1. Add the generic action-dispatch event model with the deterministic, model, and executor lanes. Move the scheduler ordinal off the turn event. Migrate the v0.6 event stream. This slice changes no behaviour.
2. Dispatch a ready gate in the deterministic lane. Add the consecutive-dispatch maximum.
3. Dispatch a ready check in the deterministic lane through the existing durable lifecycle.
4. Update accounting, budgets, and the product surface, so that consumed turns describe model turns only.
5. Confirm reload, restore, and replay.
6. Dogfood, record the measured turn reduction, and release v0.7.

### Slice 1 recommendation

Start with the event model, not with dispatch. Behaviour must not change in Slice 1, and every existing test must still pass.

Suggested branch:

`agent/m6a-slice-1-action-dispatch-model`

Suggested pull request title:

`Add generic action dispatch event model`

### Slice 1 constraints

- The reducer stays pure.
- A v0.6 event stream migrates and produces the same canonical state.
- Exactly-once turn accounting holds for the model lane.
- Round-robin fairness across independent components does not change.
- Replay produces the same state and the same stop decision.

### Next milestone: M6B event history, replay, and debugger UI

M6B follows M6A. Do not start M6B first. M6A changes the dispatch event model, and M6B renders that model. The M6B slices are in `docs/execution-roadmap.md` section 8.

## 5. Release evidence

- Integrated dogfood: `docs/v0.6-dogfood.md`.
- Release notes: `docs/v0.6-release-notes.md`.
- Implementation PR: #77.
- Release baseline: `90a2885bb8f46d61cedd803897ca4d32246bcb44`.
- Candidate CI: #1111.
- Exact-main publication gate: #1114.
- Suite: 95 test files and 461 tests.
- Release: https://github.com/Hypabolic/Hypagraph/releases/tag/v0.6

## 6. Deferred product direction

The following work remains accepted but deferred beyond M6B:

- interaction and approval nodes;
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
