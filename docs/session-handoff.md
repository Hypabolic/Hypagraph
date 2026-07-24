# Session handoff: v0.6 released to M6

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Release baseline: `90a2885bb8f46d61cedd803897ca4d32246bcb44`
- Release: `v0.6`
- Release pull request: #77 — Dogfood and release Hypagoal v0.6
- Completed milestone: M5B root Hypagoal autonomous controller
- Current milestone: M6 event history, replay, and debugger UI
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

Do not weaken these invariants during M6:

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

## 4. Current target: M6

### Objective

Make execution history, replay, and controller decisions inspectable without changing canonical workflow semantics.

### Proposed vertical slices

1. Add a transport-neutral event-history projection with stable event identity and protected-data filtering.
2. Add replay to an exact event sequence and compare live state with replay state.
3. Add deterministic decision explanations for readiness, blockage, gates, loops, evaluations, budgets, revisions, and goal state.
4. Add Pi event-timeline and replay controls.
5. Add live-versus-replay graph rendering and preserve graph positions across small revisions.
6. Add revision, invalidation, stale-result, and external-effect history views.
7. Add future family, executor, workspace, and integration projection seams without implementing those runtimes.
8. Dogfood, harden, document, and release v0.7.

### Slice 1 recommendation

Start with the pure event-history projection.

Suggested branch:

`agent/m6-slice-1-event-history-projection`

Suggested pull request title:

`Add event history projection`

### Slice 1 product result

A caller can request a bounded chronological projection of persisted events and receive:

- stable sequence and event identity;
- event type and timestamp;
- workflow, goal, revision, node, loop, attempt, check, and continuation identity when present;
- a concise public summary;
- explicit redaction markers for protected evaluator data;
- enough metadata for later timeline grouping and replay selection.

### Slice 1 constraints

- Do not add a second event store.
- Do not change reducer semantics.
- Do not replay external effects.
- Do not expose protected evaluator commands, paths, hashes, reports, stdout, stderr, or holdout details.
- Do not add goal families, executors, worktrees, or physical concurrency.
- Keep the projection independent of Pi.
- Keep future family and executor identities additive.

### Slice 1 terminal coverage

Cover at least:

- workflow definition and revision;
- node attempts and verification;
- checks and typed facts;
- gates and selected routes;
- loop iteration, evaluation, success, and bounded failure;
- goal start, pause, resume, budget stop, blockage, revision, completion, failure, and cancellation;
- stale continuation and stale result rejection;
- reload and branch-change pause;
- malformed or legacy events which the current schema can restore.

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

The following work remains accepted but deferred beyond M6:

- goal-family persistence;
- recursive child Hypagoals;
- executor abstraction and isolated Pi execution;
- worktree leases and integration;
- bounded physical concurrency;
- ACP and named direct agent adapters.
