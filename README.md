# Hypagraph

A graph-native workflow and execution-control extension for coding agents, initially integrated with the [Pi coding agent](https://pi.dev).

Hypagraph lets an agent define coding work as a directed graph, then guides and enforces execution using dependencies, node contracts, evidence, bounded loop declarations, branch-aware session state, and pluggable node executors.

## Current implementation

The initial vertical slice includes:

- installable Pi package and bundled Hypagraph skill;
- `workgraph_define`, `workgraph_read`, `workgraph_transition`, and `workgraph_revise` tools;
- a pure, tested state reducer with one-active-node enforcement;
- dependency-derived readiness and evidence-gated completion;
- Tarjan SCC detection and exact loop-region validation;
- bounded-loop declarations with explicit feedback edges;
- downstream invalidation after graph revisions;
- branch-aware restoration from tool-result snapshots;
- compact Pi status/widget context;
- guided mode plus strict write/edit scope enforcement.

Loop execution, gate expression evaluation, check runners, full in-Pi graph visualisation, and delegated node execution are planned next. Loop declarations are already structurally validated but are not yet iterated.

## Roadmap

Hypagraph is evolving from a graph-aware planning extension into a deterministic execution kernel for coding agents. The graph describes work; an event-driven finite-state runtime controls how that work executes.

See the [detailed execution plan and roadmap](docs/execution-roadmap.md) for the ordered milestones, architecture, acceptance criteria, implementation backlog, and v1.0 exit conditions.

## Try locally

```bash
npm install
npm test
npm run typecheck
pi -e ./extensions/workgraph.ts
```

Install from Git:

```bash
pi install git:github.com/Hypabolic/Hypagraph
```

## Commands and tools

The primary Pi command is `/hypagraph`. `/workgraph` remains as a compatibility alias.

| Tool | Purpose |
| --- | --- |
| `workgraph_define` | Validate and create a workflow |
| `workgraph_read` | Read canonical state and the ready frontier |
| `workgraph_transition` | Start, complete, block, or unblock a node |
| `workgraph_revise` | Replace the graph while preserving valid completed work |

## Design documents

- [Execution plan and roadmap](docs/execution-roadmap.md)
- [Product and technical specification](docs/product-spec.md)
- [Graph visualisation and delegated execution architecture](docs/delegation-and-visualisation.md)
- [`pi-workflows` comparison and adoption decisions](docs/research/pi-workflows-comparison.md)
