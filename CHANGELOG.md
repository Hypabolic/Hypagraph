# Changelog

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
