# Changelog

## Unreleased

No unreleased changes.

## v0.10.0 - 2026-07-29

M6.3 adds external effects and reconciliation.

### Added

- the `effect` node kind with durable states `requested`, `observed`, and `indeterminate`;
- request-before-start durable lifecycle and lost-knowledge rules;
- canonical-identity idempotency keys injected into sandbox programs;
- declared read-only reconciliation programs selected before new work;
- restore recovery for in-flight `requested` effects;
- separation of execution success from external success;
- status, graph, and history surfaces for effect state;
- simulated dogfood evidence in `docs/m6-3-dogfood.md`;
- focused tests in `tests/m6-3-external-effects.test.ts`.

### Changed

- persisted state uses schema version 8 for effect observations;
- restore cancels in-flight code and effect registries before rebuild.

### Unchanged

- the domain reducer stays pure; external calls run on the executor side only;
- replay restores effect state and never repeats the external call;
- a revision cannot widen effect external authority.

### Release notes

See `docs/v0.10-release-notes.md` and `docs/m6-3-external-effect-plan.md`.


## v0.9.0 - 2026-07-29

M6.2 adds code nodes and the sandbox executor adapter.

### Added

- the `code` node kind with a type-checked TypeScript program and mandatory bounds;
- a QuickJS sandbox executor and a deny-by-default host bridge;
- definition-time TypeScript check with line-numbered diagnostics;
- host-pinned runtime identity and compiled output on prepare;
- deterministic controller dispatch for ready code nodes;
- durable code lifecycle events and attempt results;
- capability allowlists with non-widening revision checks;
- scope verification with baseline content hashes for mutating programs;
- definition-time code authoring advisories on status surfaces;
- focused tests in `tests/m6-2-code-node-sandbox.test.ts`.

### Changed

- persisted state uses schema version 7 for code node shape and attempt results;
- the package depends on `quickjs-emscripten-core`, the QuickJS singlefile runtime, and `typescript` for prepare and execute.

### Unchanged

- the domain reducer stays pure; the sandbox runs on the executor side only;
- replay restores a recorded code result and never re-runs the program;
- M6.2 ships `pure` programs end to end; non-pure host handlers remain for M6.3.

### Release notes

See `docs/v0.9-release-notes.md` and `docs/code-node-adapter-plan.md`.


## v0.8.0 - 2026-07-28

M6.1 adds interaction and approval nodes.

### Added

- the `interaction` node kind with node-local `awaiting_response` wait;
- closed and open questions with `hypagraph_ask` and a dialog surface;
- deterministic presentation kinds `none`, `report`, and `command`;
- optional free-text notes and structured feedback artifacts for the next task;
- level-triggered interaction deadlines with block or select policies;
- reload and resume re-presentation without repeating a completed presentation effect;
- derived waiting surfaces on status, widget, and the graph pane;
- live Pi dogfood evidence for plan approval beside an independent loop.

### Changed

- an unanswered interaction does not stop an independent branch or loop;
- blockage classification excludes a wait-only state.


## v0.7.0 - 2026-07-27

M6A adds the deterministic dispatch lane. M6B makes the stored event stream inspectable.

### Added

- one generic action-dispatch model with a deterministic, a model, and an executor lane;
- selected, dispatched, completed, failed, and interrupted action events for every lane;
- a scheduler ordinal which advances for every selected action, independent of model usage;
- direct deterministic evaluation of a ready gate;
- direct deterministic execution of a ready check through the existing durable check lifecycle;
- an explicit maximum of 64 consecutive deterministic dispatches in one controller pass;
- scheduled action count, charged model-turn count, and the turn-accounting rule in `/hypagoal status`, in the lifecycle message, and in the model-visible workflow view;
- interrupted-dispatch recovery on reload, so a lost deterministic dispatch cannot block a later selection;
- a typed event timeline with lane classification, paging, and a lane filter;
- replay of canonical state to any stored sequence, with a comparison against live state;
- canonical explanations for why a node or a goal is not runnable;
- `/hypagraph history`, `/hypagraph history <sequence>`, `/hypagraph history <lane>`, `/hypagraph history revisions`, and `/hypagraph explain`;
- history and explain views on `hypagraph_read`;
- a replay mode of the graph pane;
- revision segments, discarded-result reporting, and a projection seam for future family, executor, workspace, and integration namespaces;
- one presentation redaction policy for protected evaluator detail across every surface.

### Changed

- consumed turns count model turns only. A deterministic action consumes no turn;
- the model lane replaces the previous continuation lifecycle. Exactly-once turn accounting for a delivered model turn does not change;
- persisted state uses schema version 6. The runtime rejects an unsupported stored schema with a clear error and adds no migration code.

### Unchanged

- the domain reducer stays pure. Direct dispatch belongs to the controller;
- the durable check order: store the check start, run the bounded external effect, store the result and evidence, publish declared facts, then store verification and the loop decision;
- cancellation, retry, backoff, artifacts, recovery, evaluation budgets, and protected evaluator redaction;
- round-robin fairness across independent components;
- `hypagraph_run_check` and the evaluate action of `hypagraph_transition`, so a user or a model can still run a check or a gate explicitly;
- M6B adds no schema version, no event type, and no stored field. It projects and presents the existing stream.

### Release evidence

- one dogfood objective with a bounded two-iteration repair region, two checks, two gates, and four tasks costs 4 model turns instead of 9;
- the loop continuation product path costs 6 model turns instead of 10;
- the v0.6 release product path costs 10 model turns instead of 15;
- each path produces the same canonical result, the same routes, the same stop decision, and the same replayed state;
- one inspectable dogfood path with tasks, checks, gates, one iteration region, and one automatic revision completes through 100 stored events, charges 7 model turns, and exposes the timeline, three replay points, a blocked-node explanation, a skipped-route explanation, and two revision segments;
- one live Pi RPC dogfood with `xai-auth/grok-4.5` authors a task and a command check, writes `result.txt`, recovers an orphaned model-lane continuation, dispatches the check in the deterministic lane, completes the goal, and inspects history, dispatch, revisions, explain, and replay surfaces;
- one live Pi RPC dogfood with loop, two gates, automatic revision, prepare-note insertion, documentation check, publish completion, revision history, loop history, explain, and multi-point replay through 83 events and revision 2;
- the controller closes a durable model-lane continuation when the selected action is no longer runnable and no delivered turn bookkeeping exists, so a ready check cannot stay blocked forever;
- blocking a running node cancels its open attempt so automatic revision stays eligible;
- `hypagoal_submit_revision` accepts a durable request-revision continuation when delivery bookkeeping is lost, and `hypagraph_revise` is rejected while automatic revision is pending.

See `docs/m6a-dogfood.md`, `docs/m6b-dogfood.md`, `docs/dogfood-evidence/m6b-live/`, `docs/dogfood-evidence/m6b-live-loop-revision/`, `docs/m6a-deterministic-dispatch-plan.md`, `docs/m6b-event-history-plan.md`, and `docs/v0.7-release-notes.md`.

## v0.6.0 - 2026-07-24

M5A and M5B add trusted evaluation contracts and the root Hypagoal autonomous controller.

### Added

- atomic `/hypagoal <objective>` creation from ordinary prose;
- workflow-derived root-goal lifecycle with no model completion command;
- durable graph-aware continuation across tasks, checks, gates, disconnected branches, and independent bounded regions;
- exact turn and normalized token accounting with deterministic budget stops;
- reload, branch-change, and invalid-usage pause with explicit resume;
- loop-aware continuation with typed validity, progress, patience, evaluation budgets, trust, integrity, and failure policy;
- deterministic canonical blocker classification;
- one durable non-weakening automatic workflow revision attempt;
- `/hypagoal status`, pause, resume, cancel, and graph controls;
- compact lifecycle messages, graph-pane goal details, and typed stop reasons.

### Release evidence

- one integrated Pi product-path scenario starts from `/hypagoal`, runs an optimization region and an independent auxiliary region, rejects an invalid evaluation, runs a probe and gate, pauses and resumes after reload, applies one bounded revision, and completes only through canonical workflow state;
- all dedicated budget, loop-limit, failure-policy, stale-result, revision-exhaustion, restore, replay, and no-model-completion tests remain green;
- the release-candidate matrix runs Node.js 22 and 24 on Ubuntu, macOS, and Windows.

See `docs/v0.6-dogfood.md` and `docs/v0.6-release-notes.md`.

## v0.5.0 - 2026-07-23

M4 adds generic executable bounded iteration regions. A loop is a deterministic graph region, not a repair-specific construct.

### Added

- typed loop success conditions and structured single-entry, single-evaluation regions;
- deterministic feedback continuation with iteration-scoped facts, routes, evidence, and attempts;
- failed evaluation checks as valid observations when required facts are complete;
- hard iteration limits and explicit exit reasons;
- numeric minimize and maximize progress metrics, best-result tracking, `minDelta`, and patience;
- independent top-level loop components;
- `fail-workflow`, `block-dependants`, and `record-and-continue` failure policies;
- revision invalidation, cancellation blocking, interrupted-attempt recovery, and stale-result rejection;
- canonical Pi loop summaries, `/hypagraph loop`, and live graph-pane loop state;
- loop-state replay, migration, restore, and persistence validation.

### Product scope

The same region model supports refinement, optimization, search, bounded batch processing, repeated evaluation, reconciliation, polling, migration, and check-and-repair workflows.

### Release evidence

- the v0.5 acceptance record maps all required dogfood and recovery scenarios to executable Pi product-path tests;
- the final release matrix runs Node.js 22 and 24 on Ubuntu, macOS, and Windows;
- `CI` is the single authoritative hosted workflow.

See `docs/v0.5-dogfood.md` for the complete evidence record.

## v0.4.0 - 2026-07-22

M3 adds deterministic command-check execution and the first graph-native Pi product surface.

### Added

- command-check nodes with bounded process execution;
- typed fact publication and deterministic gate routing;
- durable Pi event journaling and interrupted-run recovery;
- explicit cancellation, retry, timeout, output, and environment policies;
- file-backed stdout and stderr artifact references;
- a live responsive Pi graph pane;
- dependency, route, loop-boundary, and feedback-edge rendering;
- session branch protection and late-result rejection;
- hosted Linux, macOS, and Windows CI.

### Release evidence

- 104 tests passed before Slice 10;
- the v0.4 dogfood path passed in Pi 0.80.10;
- the final release matrix runs Node.js 22 and 24 on Ubuntu, macOS, and Windows.

See `docs/v0.4-dogfood.md` for the full dogfood record.
