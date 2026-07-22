# Durable lifecycle and Pi session storage

- Status: implemented
- Milestone: M3 Slice 8
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This document defines how Hypagraph stores accepted workflow events in Pi.

The storage design prevents these failures:

- a command starts but Hypagraph loses the start event;
- restore starts the same command again;
- two writers append from the same sequence;
- a stored snapshot does not match its event stream;
- a check result is stored but verification is not complete.

## 2. Source of truth

The append-only domain event stream is the source of truth.

A stored batch contains:

```ts
interface PersistedEventBatch {
  version: 1;
  workflowId: string;
  expectedSequence: number;
  events: DomainEvent[];
  snapshot: HypagraphState;
}
```

The snapshot is a verified projection cache. It is not an independent source of truth.

Restore replays the events and compares the rebuilt snapshot hash with the stored snapshot hash.

## 3. Pi adapter

Hypagraph stores each batch with:

```ts
pi.appendEntry("hypagraph.event-batch.v1", batch);
```

The custom entry does not enter the model context.

The final tool result still contains a full Hypagraph snapshot and event stream. This data supports compatibility with sessions that were written before the custom journal existed. New durable writes use the custom journal.

## 4. Optimistic sequence rule

Each append supplies the sequence that the writer expects:

```text
stored sequence = expected sequence
```

The events in the batch must start at the next sequence and must be contiguous.

The resulting snapshot sequence must equal the final event sequence in the batch.

If the stored sequence is different, the append fails with a sequence conflict. The host does not continue the lifecycle after this failure.

## 5. Check commit boundaries

A command check uses four durable boundaries:

```text
1. check started
2. facts published
3. raw result recorded
4. verification started and completed
```

The host stores boundary 1 before it invokes the executor.

The host stores facts before it stores the raw result because raw-result recording freezes fact publication for the attempt.

The host stores verification start and verification completion in one batch. This avoids a normal crash boundary between these two reducer-only transitions.

## 6. Store failure behaviour

If the start append fails:

- the executor does not run;
- the input state stays current;
- the returned diagnostic identifies the store failure or sequence conflict.

If a later append fails:

- the host returns the last stored state;
- uncommitted reducer output is discarded;
- restore continues from the last stored boundary.

## 7. Restore and interruption recovery

Restore only reads and projects stored events. It does not invoke a check executor.

A restored active check has one of these states.

### 7.1 Start stored, no raw result stored

Hypagraph records an `interrupted` check result and fails verification.

The result explains that the host stopped before it stored a result.

Hypagraph does not publish success facts. A retry must use a new attempt ID.

### 7.2 Raw result stored, verification not complete

Hypagraph uses the stored raw result and stored facts to finish verification.

It does not run the command again.

A stored passing result succeeds only when all required facts for the attempt are present.

### 7.3 Verification already complete

Hypagraph does not add recovery events.

## 8. Canonical writer

The Pi extension uses one `PiSessionWorkflowEventStore` instance for the active session.

This writer stores:

- workflow definition;
- task transitions;
- gate evaluation;
- graph revision;
- check lifecycle boundaries;
- recovery transitions.

The writer synchronizes its sequence from the restored branch before it accepts new commands.

## 9. Determinism rules

The reducer does not access Pi, the store, the clock, the executor, or the file system.

The host supplies commands and times. The reducer produces deterministic events and state.

Recovery command IDs are deterministic for the workflow, revision, node, attempt, action, and stored result.

Replay of all stored events must equal the final stored snapshot.

## 10. Test requirements

The implementation verifies:

- start storage before executor invocation;
- no executor invocation after a start-store failure;
- four check commit boundaries;
- fact storage before raw-result storage;
- optimistic sequence conflict rejection;
- Pi custom-entry journal restoration;
- snapshot and event replay equality;
- interrupted-result recovery without rerun;
- verification completion from a stored raw result;
- no recovery changes for a workflow with no orphaned check.
