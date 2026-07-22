# Hypagraph

Hypagraph is a graph-native workflow and execution-control extension for coding agents. The first integration is for the Pi coding agent.

Hypagraph lets an agent define coding work as a directed graph. A deterministic runtime then controls execution with commands, events, attempts, dependencies, node contracts, evidence, typed facts, gates, bounded loop declarations, branch-aware session state, and deterministic command checks.

## Current implementation

M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is the active milestone and adds deterministic check execution and Pi product integration.

The current implementation includes:

- an installable Pi package and a bundled Hypagraph skill;
- the `hypagraph_define`, `hypagraph_read`, `hypagraph_run_check`, `hypagraph_transition`, and `hypagraph_revise` tools;
- the `/hypagraph` command and graph-pane subcommands;
- public Pi definitions for task, gate, and command-check nodes;
- a live transport-independent graph projection;
- a deterministic layered terminal graph layout;
- dependency, selected-route, skipped-route, and loop-feedback edges;
- declared loop boundaries;
- a responsive Pi graph pane;
- a passive right-side pane on wide terminals;
- a full-screen graph view on narrow terminals;
- read-only node navigation and inspection;
- stable graph positions when runtime state changes;
- terminal-control sanitisation and ASCII rendering fallback;
- a bounded local command-check executor with no shell by default;
- timeout and cancellation support;
- bounded stdout and stderr capture;
- file-backed check artifact references;
- automatic check result normalization and lifecycle completion;
- typed fact publication from check results;
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
- typed fact contracts and fact publication;
- fact binding to workflow revisions and attempts;
- a typed condition abstract syntax tree;
- static condition and operator type validation;
- bounded deterministic condition evaluation;
- gate nodes with persisted route selections;
- branch skipping and branch-aware joins;
- route invalidation after graph revisions;
- Tarjan strongly connected component detection;
- exact loop-region validation;
- downstream invalidation after graph revisions;
- strict file-scope enforcement;
- property tests for generated directed acyclic graphs;
- replay, determinism, persistence, migration, lifecycle, fact, routing, check, artifact, graph, and Pi adapter tests.

The next M3 work adds durable lifecycle commits, interrupted-run recovery, retry policy, dogfood validation, and the v0.4 release. Structured report parsers move to M3.1. Executable loops, replay navigation, graph revision comparison, and delegated node execution follow in later milestones.

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
| `/hypagraph graph` | Open the live graph pane, or focus it when it is open. |
| `/hypagraph graph toggle` | Open or close the live graph pane. |
| `/hypagraph graph focus` | Give keyboard focus to the open graph pane. |
| `/hypagraph graph close` | Close the graph pane. |
| `hypagraph_define` | Validate and create a workflow. |
| `hypagraph_read` | Read the projected state. Use the `graph` view for the structured graph projection. |
| `hypagraph_run_check` | Run one ready deterministic command check. |
| `hypagraph_transition` | Start, complete, block, or unblock a task node, or evaluate a gate. |
| `hypagraph_revise` | Replace the graph and invalidate changed work. |

The graph pane uses arrow keys or `h`, `j`, `k`, and `l` for navigation. Use Enter to show node details, Home to select the active node, `r` to select the ready frontier, `+` or `-` to change density, Escape to release focus on wide terminals, and `q` to close the pane.

## Design documents

- [Product and technical specification](docs/product-spec.md)
- [Execution plan and roadmap](docs/execution-roadmap.md)
- [M3 deterministic check execution plan](docs/m3-vertical-slice-plan.md)
- [M3 completion and Pi productisation plan](docs/m3-completion-phase-plan.md)
- [Pi graph visualisation plan](docs/pi-graph-visualisation-plan.md)
- [Event-driven runtime](docs/event-runtime.md)
- [Graph visualisation and delegated execution architecture](docs/delegation-and-visualisation.md)
- [Pi workflow comparison and adoption decisions](docs/research/pi-workflows-comparison.md)
