# Hypagraph

Hypagraph is a graph-native workflow and execution-control extension for coding agents. The first integration is for the Pi coding agent.

Hypagraph lets an agent define coding work as a directed graph. A deterministic runtime then controls execution with commands, events, attempts, dependencies, node contracts, evidence, bounded loop declarations, and branch-aware session state.

## Current implementation

M0 provides the stable graph foundation. M1 adds the event-driven execution runtime.

The current implementation includes:

- an installable Pi package and a bundled Hypagraph skill;
- the `hypagraph_define`, `hypagraph_read`, `hypagraph_transition`, and `hypagraph_revise` tools;
- one public Pi command, `/hypagraph`;
- versioned commands and events;
- an append-only event stream as the source of truth;
- pure event projection and deterministic replay;
- schema version 2 snapshots with deterministic hashes;
- migration from valid schema version 1 snapshots;
- explicit node and attempt lifecycles;
- immutable attempt IDs;
- stale-attempt rejection;
- separate result-submission and verification states;
- pause and resume commands in the domain runtime;
- dependency-based readiness events;
- one-active-attempt enforcement;
- evidence-gated result submission;
- Tarjan strongly connected component detection;
- exact loop-region validation;
- downstream invalidation after graph revisions;
- strict file-scope enforcement;
- property tests for generated directed acyclic graphs;
- replay, determinism, persistence, migration, and lifecycle tests.

Typed facts, gate evaluation, deterministic check runners, executable loops, full graph visualization in Pi, and delegated node execution are planned next.

## Language rules

All repository text must use the ASD-STE100 Simplified Technical English writing method.

This rule applies to documentation, plans, comments, test descriptions, error messages, user interface text, and tool guidance.

See [AGENTS.md](AGENTS.md) for the mandatory rules.

## Run Hypagraph locally

```bash
npm install
npm run check
pi -e ./extensions/hypagraph.ts
```

Install the package from GitHub:

```bash
pi install git:github.com/Hypabolic/Hypagraph
```

## Commands and tools

| Name | Purpose |
| --- | --- |
| `/hypagraph` | Show the active workflow state. |
| `hypagraph_define` | Validate and create a workflow. |
| `hypagraph_read` | Read the projected state and ready nodes. |
| `hypagraph_transition` | Start, complete, block, or unblock a node. |
| `hypagraph_revise` | Replace the graph and invalidate changed work. |

## Design documents

- [Product and technical specification](docs/product-spec.md)
- [Execution plan and roadmap](docs/execution-roadmap.md)
- [Event-driven runtime](docs/event-runtime.md)
- [Graph visualization and delegated execution architecture](docs/delegation-and-visualisation.md)
- [Pi workflow comparison and adoption decisions](docs/research/pi-workflows-comparison.md)
