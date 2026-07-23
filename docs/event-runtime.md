# Hypagraph event-driven runtime

- Status: implemented
- Version: 0.5 development
- Date: 2026-07-22
- Writing standard: ASD-STE100 Simplified Technical English

## Purpose

The graph defines the work. The deterministic runtime controls state changes.

Hypagraph uses commands, versioned events, and pure projections. The Pi extension does not change canonical graph state directly.

## Source of truth

The ordered event stream is the source of truth.

A snapshot is a projection of that event stream. Hypagraph stores each accepted event batch with its resulting snapshot. Restore replays the events and checks the snapshot hash.

Schema version 2 snapshots are accepted only through the migration path. New schema version 3 batches must match their replayed hash.

## Event envelope

Each event contains:

- event ID;
- workflow ID;
- graph revision;
- sequence number;
- event type and version;
- timestamp;
- causation ID;
- correlation ID;
- optional node ID;
- optional attempt ID;
- optional loop ID;
- event data.

Sequence numbers are contiguous. The first event has sequence number 1.

## Commands

The runtime supports commands for:

- workflow revision, pause, and resume;
- task and check start;
- check-result recording;
- typed fact publication;
- gate evaluation;
- result submission and verification;
- node block and unblock;
- attempt cancellation.

A command returns events or diagnostics. A rejected command returns no events.

The model cannot select a loop decision. Loop start and evaluation are deterministic effects of existing task and check commands.

## Node and attempt lifecycle

Node states are:

```text
pending
ready
starting
running
awaiting_evidence
verifying
succeeded
failed
blocked
cancelled
skipped
stale
```

Each node start creates an immutable attempt ID. Attempts inside a loop also store the loop ID and iteration number.

A result is valid only when its attempt ID is the current attempt ID for the node. Hypagraph rejects stale results and stale cancellation requests.

## Typed facts and gates

Facts are bound to:

- producer node;
- attempt ID;
- workflow revision;
- optional loop ID;
- optional loop iteration.

A gate uses the typed condition structure. The route-selection event stores the outcome, facts used, and condition-semantics version.

## Loop Slice 1 and Slice 2 lifecycle

A new loop definition uses a typed `successWhen` condition.

When the ready loop entry starts, one command batch records:

1. `hypagraph.loop.iteration-started`;
2. the task-attempt or check-start event.

When the evaluation node passes verification, the same command batch records:

1. the verification-passed event;
2. `hypagraph.loop.evaluated`;
3. `hypagraph.loop.completed` when the condition is true;
4. any newly ready downstream nodes;
5. workflow completion when applicable.

The loop evaluation event stores the iteration, success value, facts used, condition-semantics version, and decision. Replay uses the stored decision. It does not evaluate the condition again from later facts.

A node outside the loop cannot become ready from the evaluation node until the loop status is `succeeded`.

When the condition is false and another iteration is available, the evaluation event stores a `continue` decision. The same command batch then stores the next `hypagraph.loop.iteration-started` event and the entry ready event. Projection of the iteration-started event clears current loop facts, gate routes, node evidence, and current-attempt pointers. It keeps prior attempts, results, evidence, artifacts, events, and iteration history. Downstream work remains blocked until the loop succeeds.

## Readiness

Readiness is recorded as an event.

Hypagraph emits a node-ready event when:

- the node is pending or stale;
- all non-feedback dependencies succeeded or were skipped;
- each source loop for an external dependency succeeded.

The ready frontier is a projection of node-ready events.

## Durable check boundary

A command check keeps this order:

```text
store check start
    |
    v
run command
    |
    v
store facts
    |
    v
store raw result
    |
    v
store verification and loop decision
```

Restore does not run a task or check.

## Replay rules

Replay must obey these rules:

1. The first event defines the workflow.
2. Every event has the same workflow ID.
3. Event sequence numbers are contiguous.
4. Events are applied in sequence order.
5. The same event stream produces the same snapshot hash.
6. Loop decisions come from stored events.
7. Replay does not read the clock, run a process, or call Pi.

## Schema migration

Schema version 3 is the current snapshot format.

A valid version 2 event stream without loops replays into schema version 3 automatically.

A version 2 loop with a textual predicate remains readable. Migration stores the text as legacy predicate data and sets the loop status to `requires_revision`. Hypagraph does not guess how to convert the text into executable logic. A definition revision must supply a typed condition before the loop can run.

## Pi adapter boundary

The Pi extension can:

- convert tool input into commands;
- call the domain command handler;
- append returned event batches;
- run an external check only after its start event is stored;
- render text and graph projections;
- enforce file scope at the Pi boundary.

The Pi extension must not contain loop decision rules.

The default stdout and stderr capture limit is 1,048,576 bytes for each stream.

## Failed check observations

A command check at the declared loop evaluation node can be a valid failed observation.

Hypagraph continues the loop only when:

- the raw check result status is `failed`;
- result normalization succeeded;
- all required facts from that check attempt are present and valid;
- the typed loop success condition is false;
- another iteration is available.

The verification event remains `hypagraph.verification.failed`. The same durable verification batch stores the loop evaluation, the `continue` decision, the next iteration start, and entry readiness. A true success condition cannot complete a loop when verification failed.

A cancelled, interrupted, timed-out, or executor-error result does not continue the loop. A failed check that is not the evaluation node does not continue the loop. Check retry stays in the same iteration. Loop continuation starts a new iteration and requires a new attempt ID.

## Hard iteration limit

The runtime evaluates the final allowed iteration before it reports exhaustion. A successful final iteration stores `hypagraph.loop.completed`. An unsuccessful final iteration stores these events in order:

1. the verification result;
2. `hypagraph.loop.evaluated` with decision `fail`;
3. `hypagraph.loop.failed` with exit reason `max_iterations`;
4. `hypagraph.workflow.failed`.

The final iteration facts, attempts, evidence, results, and artifact references remain in history. The exhausted loop cannot start again. A node command for that loop returns `loop_exhausted`.

## Current M4 limit

M4 Slices 1 to 5 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, failed evaluation-check observations, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure.

Progress decisions are stored in `hypagraph.loop.evaluated`. The event contains the metric, improvement result, best metric, best iteration, and no-progress count. Replay does not recalculate them. A missing or invalid current-iteration metric fails the loop with `evaluation_error`. Hard-limit failure has priority over patience failure.

## Independent region outcomes

A loop definition can set `failurePolicy` to `fail-workflow`, `block-dependants`, or `record-and-continue`. An omitted policy means `fail-workflow` and does not change the initial schema-3 snapshot shape.

A terminal failure stores the selected policy in `hypagraph.loop.failed`. `block-dependants` stores node-block events for the affected path. `record-and-continue` keeps unrelated work executable but does not release a dependant that requires loop success. The workflow completes only after every loop region is terminal. An independent recorded failure can coexist with a completed workflow.

Disconnected regions have separate attempts, facts, routes, progress values, resets, and graph-component IDs. M4 dispatch remains sequential, but region outcomes do not share runtime state.

## Revision, cancellation, and restore

A revision is rejected while an attempt in the affected loop is active. A change to a loop definition or one of its nodes stores `hypagraph.loop.invalidated`, clears the current region projection, preserves attempt history, and makes the entry eligible to restart at iteration 1. An unchanged completed loop is retained.

Cancellation and restored interruption store a blocked loop outcome. The region cannot start again until an explicit relevant revision invalidates it. Restore validates loop iteration, active-attempt, and fact ownership invariants. It never starts a node or reruns a command.

Pi session branches use generation-bound event-store leases. A late result from an earlier branch fails with `event_store_branch_changed`. Optimistic sequence conflicts return `event_store_sequence_conflict` and do not store part of a loop reset batch.

It does not yet support:

- parallel iterations;
- nested or overlapping loops.
