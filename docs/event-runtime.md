# Hypagraph event-driven runtime

- Status: implemented
- Version: 0.3
- Date: 2026-07-21

## Purpose

The graph defines the work. The runtime controls execution.

Hypagraph now uses commands, versioned events, and pure projections. The Pi extension does not change graph state directly.

## Source of truth

The ordered event stream is the source of truth.

A snapshot is a projection of that event stream. Hypagraph stores the event stream and the snapshot together. During restoration, Hypagraph replays the events and compares the new snapshot hash with the stored snapshot hash.

Hypagraph rejects the stored data when the hashes do not match.

## Event envelope

Each event contains:

- event ID;
- workflow ID;
- graph revision;
- sequence number;
- event type;
- event version;
- timestamp;
- causation ID;
- correlation ID;
- optional node ID;
- optional attempt ID;
- event data.

Sequence numbers must be contiguous. The first event has sequence number 1.

## Commands

The runtime supports these commands:

- revise workflow;
- start node;
- submit attempt result;
- begin verification;
- complete verification;
- block node;
- unblock node;
- cancel attempt;
- pause workflow;
- resume workflow.

A command produces events or diagnostics. A rejected command produces no events.

## Node lifecycle

The M1 node states are:

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
stale
```

The current runtime does not use `starting` yet. The state is reserved for delegated execution.

## Attempt lifecycle

Each node start creates an immutable attempt ID.

The attempt states are:

```text
running
submitted
verifying
succeeded
failed
cancelled
```

A result is valid only when its attempt ID is the current attempt ID for the node. Hypagraph rejects stale results and stale cancellation requests.

## Completion flow

The public `hypagraph_transition` tool keeps the current `complete` action. The Pi adapter converts this action into three commands:

1. submit the attempt result;
2. begin verification;
3. complete verification.

This keeps the public tool simple. It also keeps execution success separate from verification success in the event history.

Later check executors can replace the immediate verification pass without a public tool change.

## Readiness

Readiness is recorded as an event.

Hypagraph emits a node-ready event when:

- the node is pending or stale;
- all required predecessor nodes succeeded;
- the node is not inside an executable loop that is not yet supported.

The ready frontier is a projection of node-ready events.

## Replay rules

Replay must obey these rules:

1. The first event must define the workflow.
2. Every event must have the same workflow ID.
3. Event sequence numbers must be contiguous.
4. Events must be applied in sequence order.
5. The same event stream must always produce the same snapshot hash.

## Schema migration

Schema version 2 is the current format.

Hypagraph can read a valid schema version 1 snapshot. It converts the old node states into a schema version 2 event stream. It then rebuilds a new snapshot from those events.

All new state changes use schema version 2 events.

## Pi adapter boundary

The Pi extension can:

- convert tool input into commands;
- call the domain command handler;
- append returned events;
- store events and snapshots;
- render projections;
- enforce file scope at the Pi tool boundary.

The Pi extension must not contain domain transition rules.

## Current limits

M1 does not add:

- deterministic check runners;
- typed facts;
- gate evaluation;
- executable loops;
- delegated workers;
- concurrent execution.

These functions belong to later milestones.
