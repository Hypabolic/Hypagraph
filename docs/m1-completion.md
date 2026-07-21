# M1 completion record

- Milestone: M1
- Release target: 0.3.0
- Status: implemented, external checks pending
- Date: 2026-07-21

## Implemented functions

M1 adds these functions:

- schema version 2;
- versioned event envelopes;
- explicit commands;
- pure event application;
- full event replay;
- event sequence validation;
- node attempt records;
- immutable attempt IDs;
- stale-attempt rejection;
- separate result-submission and verification states;
- readiness events;
- workflow pause and resume commands;
- workflow revision events;
- node invalidation events;
- event-stream persistence;
- snapshot hash validation during restoration;
- migration from valid schema version 1 snapshots;
- a Pi adapter that sends commands to the domain runtime;
- tests for replay, lifecycle separation, event order, stale attempts, and persistence validation.

## Public compatibility

The public Pi surface did not change.

The tools are:

- `hypagraph_define`;
- `hypagraph_read`;
- `hypagraph_transition`;
- `hypagraph_revise`.

The `complete` transition now produces separate result-submission and verification events.

## Deferred functions

M1 does not implement:

- check executors;
- typed facts;
- gate expressions;
- executable loops;
- delegated execution;
- concurrent node execution;
- a replay user interface.

## Verification status

The repository has strict TypeScript checks and automated tests.

This implementation was written through the GitHub connector. The execution environment could not resolve GitHub or npm hosts. Therefore, `npm run check` has not run against this change in the current session.

The next required action is to run the repository checks in GitHub Actions or in a network-enabled checkout. Fix all type or test failures before the 0.3.0 release tag.
