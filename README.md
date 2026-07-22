# Hypagraph

Hypagraph is a graph-native workflow and execution-control extension for coding agents. The first integration is for the Pi coding agent.

Hypagraph lets an agent define coding work as a directed graph. A deterministic runtime then controls execution with commands, events, attempts, dependencies, node contracts, evidence, typed facts, gates, bounded loop declarations, branch-aware session state, and deterministic command checks.

## Current implementation

M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is the active milestone and adds deterministic check execution and Pi product integration.

The current implementation includes:

- an installable Pi package and a bundled Hypagraph skill;
- the `hypagraph_define`, `hypagraph_read`, `hypagraph_run_check`, `hypagraph_cancel_check`, `hypagraph_transition`, and `hypagraph_revise` tools;
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
- a session-scoped active check execution registry;
- explicit check cancellation through Pi tools and commands;
- late-result rejection after cancellation;
- explicit retry policy with allowed statuses, maximum attempts, and bounded backoff;
- a new immutable attempt ID for each retry;
- prior-attempt fact removal when a retry starts;
- environment-variable name allowlists;
- a small safe default command environment;
- no environment values in definitions, events, results, or logs;
- bounded stdout and stderr capture;
- file-backed check artifact references;
- automatic check result normalization and lifecycle completion;
- typed fact publication from check results;
- a Pi session journal for accepted event batches;
- optimistic workflow sequence checks;
- durable check-start, fact, result, and verification boundaries;
- restore-time closure of interrupted check attempts;
- verification recovery from a stored raw result without command rerun;
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
- replay, determinism, persistence, migration, lifecycle, recovery, cancellation, retry, environment, fact, routing, check, artifact, graph, and Pi adapter tests.

The next M3 work is end-to-end dogfood validation and the v0.4 release. Structured report parsers move to M3.1. Executable loops, replay navigation, graph revision comparison, and delegated node execution follow in later milestones.

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
| `/hypagraph check active` | Show the active check execution. |
| `/hypagraph check cancel [node-id]` | Request cancellation of an active check. |
| `hypagraph_define` | Validate, create, and durably store a workflow. |
| `hypagraph_read` | Read the projected state. Use the `graph` view for the structured graph projection. |
| `hypagraph_run_check` | Durably run one ready or retryable deterministic command check. |
| `hypagraph_cancel_check` | Request cancellation of an active command check. |
| `hypagraph_transition` | Durably apply a task or gate lifecycle transition. |
| `hypagraph_revise` | Durably replace the graph and invalidate changed work. |

The graph pane uses arrow keys or `h`, `j`, `k`, and `l` for navigation. Use Enter to show node details, Home to select the active node, `r` to select the ready frontier, `+` or `-` to change density, Escape to release focus on wide terminals, and `q` to close the pane.

## Durable session storage

Hypagraph writes each accepted event batch to a Pi custom session entry. Each batch contains the expected sequence, the new events, and the resulting snapshot. Restore checks sequence continuity and rebuilds the snapshot from the stored events.

A command check follows this order:

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
store verification result
```

If the start cannot be stored, Hypagraph does not run the command. Restore does not rerun a command. It records an interrupted result for a check that has no stored result, or it finishes verification when a raw result is already stored.

## Check execution policy

Cancellation is terminal for the current attempt. Hypagraph passes the Pi abort signal to the executor. A cancellation tool can also abort the registered execution. If an executor ignores cancellation and returns a later success result, Hypagraph records a cancelled result and does not publish success facts.

Retries are explicit. Hypagraph does not retry automatically. A retry must use a new attempt ID. The prior result and artifacts remain in attempt history. Facts from the prior attempt are removed when the retry starts. The definition can restrict retry statuses, the total attempt count, and the retry backoff.

A command check stores environment-variable names only. It does not store environment values. The executor inherits a small safe launch environment by default. A definition can replace that default with an explicit list of names.

## Design documents

- [Product and technical specification](docs/product-spec.md)
- [Execution plan and roadmap](docs/execution-roadmap.md)
- [M3 deterministic check execution plan](docs/m3-vertical-slice-plan.md)
- [M3 completion and Pi productisation plan](docs/m3-completion-phase-plan.md)
- [Durable lifecycle and Pi session storage](docs/durable-lifecycle-storage.md)
- [Check cancellation, retry, and environment policy](docs/check-execution-policy.md)
- [Pi graph visualisation plan](docs/pi-graph-visualisation-plan.md)
- [Event-driven runtime](docs/event-runtime.md)
- [Graph visualisation and delegated execution architecture](docs/delegation-and-visualisation.md)
- [Pi workflow comparison and adoption decisions](docs/research/pi-workflows-comparison.md)
