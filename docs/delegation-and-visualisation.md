# Graph visualisation and delegated execution

- Status: proposed architecture
- Date: 2026-07-21
- Depends on: `docs/product-spec.md`

## Decision

Extend Hypagraph from a single-worker control layer into a graph controller with pluggable node executors.

The canonical graph reducer remains deterministic and independent of Pi, ACP, subprocesses, terminals, and git. Execution occurs through adapters. The controller owns scheduling, node contracts, attempts, evidence validation, graph transitions, workspace leases, and integration.

Hypagraph should provide two graph surfaces inside Pi:

- a compact live widget;
- a full interactive overlay opened by `/hypagraph` or a dedicated show action.

Both consume the same projection of canonical state and append-only runtime events.

## Executor abstraction

Node semantics and execution mechanism are separate.

Supported executor kinds:

- current Pi session;
- isolated Pi subagent;
- ACP-compatible agent;
- named direct CLI adapter;
- extension-owned deterministic executor.

Task nodes reference executor profiles rather than embedding transport details in the graph model.

## Attempts

Every node execution receives an immutable attempt ID. Events and results carry workflow ID, graph revision, node ID, and attempt ID.

Stale, cancelled, superseded, or previous-revision results remain available in history but cannot transition current canonical state.

## Delegated node contract

A delegated worker receives a bounded contract containing:

- workflow goal;
- node intent and acceptance criteria;
- writable or readable scope;
- required evidence;
- selected upstream facts, artifacts, and summaries;
- a structured result protocol.

Workers do not receive graph mutation authority. They return a result envelope which the controller validates.

## Scheduler semantics

The parent Pi session remains exclusive. Independent delegated nodes may run concurrently only when dependencies, loop ordering, executor limits, workspace leases, and concurrency groups permit it.

Initial delegated concurrency should default to two.

Executor selection should be deterministic from node policy and profile capability, not delegated to another model call.

## Pi subagents

The first delegated executor should launch an isolated Pi process or RPC session in a leased workspace. It receives the bounded node contract and exposes only a structured result submission mechanism.

Mutating subagent work should occur in a git worktree.

## ACP

Hypagraph acts as an ACP client. ACP is an execution transport, not the orchestration or graph domain model.

Each attempt should initially receive its own ACP session. The adapter negotiates capabilities, streams progress, brokers permissions and user input through Pi, supports cancellation, and normalises the final result.

## Direct CLI adapters

Direct CLI execution is a compatibility mechanism for agents without ACP support. Strict execution requires named adapters with tested invocation, parsing, cancellation, and result-normalisation behaviour.

Generic arbitrary-command profiles should remain observe-only.

## Workspace isolation and integration

Mutating delegated nodes use one git worktree per attempt by default.

Execution success and integration success are distinct states. The preferred v1 path is:

1. worker commits in its worktree;
2. controller validates scope and evidence;
3. controller cherry-picks into the base workspace;
4. conflicts enter an explicit integration-conflicted state;
5. post-integration checks run in the base workspace;
6. only then may the node complete.

## Event model and replay

Hypagraph should persist append-only events for graph definitions, revisions, readiness, attempts, progress, permissions, artifacts, integration, completion, failure, invalidation, gates, loops, pause, resume, and workflow completion.

Periodic snapshots provide fast restoration. Live UI, history replay, and external export must consume the same event model.

## Graph visualisation

The renderer consumes a transport-independent graph view model.

Layout should operate over the SCC condensation graph:

1. collapse loop regions;
2. assign directed ranks;
3. reduce edge crossings;
4. expand loop groups and route feedback edges separately;
5. preserve node positions across revisions where possible.

The compact widget shows active and delegated nodes, ready frontier, immediate dependencies, blocked gates, loop progress, executor identity, and elapsed time.

The full overlay adds navigation, node details, contracts, evidence, attempts, workspaces, event history, filters, replay, pause, cancellation, retry, approval, and revision actions.

## Correctness invariants

1. Only the graph controller mutates canonical state.
2. Every result correlates to an active attempt and graph revision.
3. Cancelled or stale attempts cannot complete nodes.
4. Delegated mutation stays inside its workspace lease.
5. Scope validation runs before and after integration.
6. Integration does not bypass evidence or acceptance checks.
7. Conflicting exclusive workspace leases cannot run concurrently.
8. Credentials are never serialised into graph state.
9. ACP and CLI output is treated as untrusted input.
10. History is derived from persisted events.

## Implementation phases

1. Visualisation foundation.
2. Event history and replay.
3. Executor abstraction and attempt lifecycle.
4. Pi subagent execution.
5. Workspace leases and integration.
6. ACP client adapter.
7. Bounded parallel scheduling.
8. Direct CLI compatibility adapters.
