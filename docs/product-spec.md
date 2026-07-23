# Hypagraph product and technical specification

- Status: proposed
- Version: 0.1 draft
- Delivery: independent Pi package, designed to support additional agent runtimes

## Executive decision

Hypagraph is an in-session control layer in which coding work is represented as a directed graph rather than a flat todo list.

The graph makes four concerns executable rather than advisory:

1. dependency order;
2. logical gates and branch selection;
3. evidence-backed completion;
4. bounded feedback and iteration regions.

The graph kernel is deterministic. Models may propose graphs and perform work, but the controller validates graph definitions, transitions, evidence, loop boundaries, and revisions.

## Product thesis

Flat plans encode sequence but not dependency, hide blocked states, accept narrative completion claims, and handle repeated work through unstructured replanning. Hypagraph represents work as bounded node contracts connected by explicit dependency, route, data, and feedback edges.

## Product boundary

Hypagraph supports:

- an agent-authored and user-inspectable work graph;
- typed node contracts;
- dependency-derived readiness;
- evidence-gated completion;
- graph revision and downstream invalidation;
- strongly connected loop regions with explicit bounds;
- deterministic check and gate executors;
- branch-aware session persistence;
- live graph rendering and replay;
- delegated node execution through Pi subagents, ACP agents, and named CLI adapters.

Hypagraph is not a hosted project-management platform, a repository knowledge graph, or an operating-system sandbox.

## Core concepts

### Workflow

A workflow is a versioned graph plus canonical runtime state.

### Node

A node is a bounded work contract containing intent, acceptance criteria, scope, required evidence, consumed and produced facts, runtime state, and attempt history.

Planned node kinds include task, check, gate, approval, and delegated task nodes.

### Edge

- `requires`: prerequisite relationship;
- `route`: branch selected by a gate;
- `data`: fact or artifact dependency;
- `feedback`: controlled edge within a declared loop region.

### Facts and gates

Checks publish typed immutable facts. Gates evaluate deterministic predicates over those facts and workflow metadata. Strict completion cannot depend solely on model judgement.

### Loop regions

A loop is a first-class bounded iteration region. It contains normal task, gate, and check nodes. The node contracts define what the loop does. Hypagraph must not encode repair as a loop type or as an implicit loop purpose.

Every cyclic strongly connected component must be explicitly declared. A loop defines entry and evaluation points, feedback edges, success conditions, progress objectives, patience, hard budgets, and failure policy.

A Boolean success condition determines whether the loop may exit successfully. A separate loss or progress objective determines whether unsuccessful iterations are improving.

A loop can model refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or repair.

### Independent loop regions

A loop can connect to the wider graph through its entry and evaluation boundaries. It can also be a disconnected top-level graph component.

Topological independence must also provide state independence. Facts, routes, attempts, iteration counters, progress values, and exit decisions from one loop must not change another loop unless an explicit graph dependency connects them.

A loop failure policy controls whether a failed region fails the complete workflow, blocks only its dependants, or records the failure while unrelated work continues.

The graph projection can show a loop region as one compound graph element with an inspectable internal graph. This gives Hypagraph a hypergraph-like composition without changing the deterministic node and edge kernel.

## Runtime invariants

1. Only the controller mutates canonical graph state.
2. A node cannot start until its dependencies and routing conditions are satisfied.
3. Completion requires the node's declared evidence and checks.
4. Undeclared cycles are rejected.
5. Graph revisions invalidate changed work and affected downstream nodes.
6. Stale or cancelled attempts cannot transition current graph state.
7. Delegated mutations occur in isolated workspace leases before integration.
8. A loop has no implicit repair semantics.
9. An independent loop cannot release, fail, or reset an unrelated graph component.
10. Loop failure and workflow failure are separate decisions controlled by explicit policy.

## Current implementation

The initial implementation provides:

- graph definition and validation;
- dependency-derived readiness;
- one-active-node execution;
- evidence-backed completion;
- Tarjan SCC detection;
- exact loop-region validation;
- downstream invalidation;
- branch-aware restoration from Pi tool-result snapshots;
- guided and strict scope enforcement.

Multi-iteration loop execution is in progress. Independent-region outcome policy, delegated executors, and bounded parallel scheduling remain planned work.

## Delivery sequence

1. Graph visualisation and shared view model.
2. Append-only events and replay.
3. Executor registry and attempt lifecycle.
4. Isolated Pi subagents.
5. Worktree leases and integration.
6. ACP client executor.
7. Bounded parallel scheduling.
8. Named direct CLI adapters where ACP is unavailable.
