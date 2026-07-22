# Changelog

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
