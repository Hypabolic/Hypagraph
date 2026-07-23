# Changelog

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
