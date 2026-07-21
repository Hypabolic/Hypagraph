# `pi-workflows` research and adoption decisions

- Status: accepted research input
- Date: 2026-07-21
- Reference: `osolmaz/pi-workflows`
- Target: Hypagraph

## Executive judgement

`pi-workflows` is a well-executed single-path workflow runtime with strong terminal observability. Its most useful ideas are its live graph renderer, durable run trace, replayable node-attempt history, explicit attempt identity, and structured completion contract.

Hypagraph should adopt those interaction and audit patterns while retaining its own graph semantics:

- dependency graphs rather than one predetermined route;
- a ready frontier rather than a single current node;
- joins and independently ready branches;
- evidence-gated completion;
- exact SCC loop regions with explicit convergence policy;
- graph revision and downstream invalidation;
- multiple active delegated attempts where safe.

## Adopt

### Live graph rendering

Use a shared graph projection and renderer for the compact Pi widget and full overlay. Render pending, ready, active, delegated, blocked, completed, failed, stale, and skipped states distinctly. Support dependency, data, route, and feedback edges.

### Explicit attempts

Every execution receives an immutable attempt ID. Completion and failure are correlated to workflow, revision, node, and attempt. Stale submissions are rejected.

### Durable events and replay

Persist transitions before scheduling the next action. Derive live and historical graph views from the same reducer and event stream.

### Executor separation

Node kind describes the contract. Executor binding describes who or what performs it. This supports the parent Pi session, Pi subagents, ACP agents, named CLI adapters, and deterministic extension executors.

### Pause, cancellation, and timeout

Treat pause-at-boundary, cancellation, timeout, and retained partial results as first-class lifecycle states.

## Do not copy unchanged

### Single-path routing

Hypagraph must preserve fan-out, joins, concurrent readiness, and independent branches rather than limiting each node to one outgoing route.

### Worker output as completion authority

An executor's success report is submitted evidence. The controller remains responsible for validating contracts, evidence, checks, and integration before completing a node.

### Executable TypeScript as canonical graph format

Canonical user and model-authored graphs should remain inspectable data with deterministic policy expressions, not arbitrary executable workflow modules.

### External viewer as the primary experience

The principal graph experience belongs inside Pi. External viewers may consume the same event export later.

## ACP position

ACP is an appropriate client-to-agent transport for delegated work. Hypagraph acts as the ACP client and owns the attempt lifecycle. ACP does not become the graph runtime or multi-agent scheduler.

Executor priority:

1. current Pi session;
2. isolated Pi subagent;
3. ACP-compatible external agent;
4. named direct CLI adapter;
5. in-process extension executor.

## Product decisions

1. Make executor binding explicit on task nodes.
2. Keep canonical graph mutation controller-owned.
3. Permit parallel delegated attempts only for independent ready nodes.
4. Use isolated worktrees for mutating delegated attempts.
5. Separate execution success from integration success.
6. Display executor and attempt state in the graph.
7. Persist append-only history for live UI, replay, and export.
8. Keep ACP behind an adapter boundary.

## Recommended implementation order

1. Graph layout, view model, widget, and overlay.
2. Append-only events and replay.
3. Executor registry with current Pi behaviour wrapped as an executor.
4. Isolated Pi subagents.
5. Workspace leases and integration.
6. ACP adapter.
7. Bounded parallel scheduling.
8. Named CLI adapters where ACP is unavailable.
