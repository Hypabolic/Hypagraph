# Hypagraph

Hypagraph is a graph-native workflow and execution-control extension for coding agents. The first integration is for the Pi coding agent.

Hypagraph lets an agent define coding work as a directed graph. It then controls execution with dependencies, node contracts, evidence, bounded loop declarations, branch-aware session state, and pluggable node executors.

## M0 baseline

M0 provides a stable graph foundation.

The baseline includes:

- an installable Pi package and a bundled Hypagraph skill;
- the `hypagraph_define`, `hypagraph_read`, `hypagraph_transition`, and `hypagraph_revise` tools;
- one public Pi command, `/hypagraph`;
- a pure state reducer;
- one-active-node enforcement;
- dependency-based readiness;
- evidence-gated completion;
- Tarjan strongly connected component detection;
- exact loop-region validation;
- bounded loop declarations with explicit feedback edges;
- downstream invalidation after graph revisions;
- branch-aware restoration from tool-result snapshots;
- a versioned persisted state schema;
- deterministic state hashes;
- strict file-scope enforcement;
- property tests for generated directed acyclic graphs;
- tests for reducer determinism, input immutability, schema rejection, and persistence restoration.

Loop execution, gate expression evaluation, check runners, full graph visualization in Pi, and delegated node execution are not part of M0.

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
| `hypagraph_read` | Read the canonical state and the ready nodes. |
| `hypagraph_transition` | Start, complete, block, or unblock a node. |
| `hypagraph_revise` | Replace the graph and preserve valid completed work. |

## Design documents

- [Product and technical specification](docs/product-spec.md)
- [Execution plan and roadmap](docs/execution-roadmap.md)
- [Graph visualization and delegated execution architecture](docs/delegation-and-visualisation.md)
- [Pi workflow comparison and adoption decisions](docs/research/pi-workflows-comparison.md)
