# Changelog

## v0.7.0 - 2026-07-25

M6A adds the deterministic dispatch lane. A canonical action which needs no reasoning runs without a model turn.

### Added

- one generic action-dispatch model with a deterministic, a model, and an executor lane;
- selected, dispatched, completed, failed, and interrupted action events for every lane;
- a scheduler ordinal which advances for every selected action, independent of model usage;
- direct deterministic evaluation of a ready gate;
- direct deterministic execution of a ready check through the existing durable check lifecycle;
- an explicit maximum of 64 consecutive deterministic dispatches in one controller pass;
- scheduled action count, charged model-turn count, and the turn-accounting rule in `/hypagoal status`, in the lifecycle message, and in the model-visible workflow view;
- interrupted-dispatch recovery on reload, so a lost deterministic dispatch cannot block a later selection.

### Changed

- consumed turns count model turns only. A deterministic action consumes no turn;
- the model lane replaces the previous continuation lifecycle. Exactly-once turn accounting for a delivered model turn does not change;
- persisted state uses schema version 6. The runtime rejects an unsupported stored schema with a clear error and adds no migration code.

### Unchanged

- the domain reducer stays pure. Direct dispatch belongs to the controller;
- the durable check order: store the check start, run the bounded external effect, store the result and evidence, publish declared facts, then store verification and the loop decision;
- cancellation, retry, backoff, artifacts, recovery, evaluation budgets, and protected evaluator redaction;
- round-robin fairness across independent components;
- `hypagraph_run_check` and the evaluate action of `hypagraph_transition`, so a user or a model can still run a check or a gate explicitly.

### Release evidence

- one dogfood objective with a bounded two-iteration repair region, two checks, two gates, and four tasks costs 4 model turns instead of 9;
- the loop continuation product path costs 6 model turns instead of 10;
- the v0.6 release product path costs 10 model turns instead of 15;
- each path produces the same canonical result, the same routes, the same stop decision, and the same replayed state.

See `docs/m6a-dogfood.md` and `docs/m6a-deterministic-dispatch-plan.md`.

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
