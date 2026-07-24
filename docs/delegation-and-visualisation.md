# Graph visualisation, goal families, and delegated execution

- Status: accepted proposed architecture
- Updated: 2026-07-24
- Depends on: `docs/product-spec.md`
- Goal-family plan: `docs/goal-family-and-concurrent-execution-plan.md`
- Pi subagent research: https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents
- Writing standard: ASD-STE100 Simplified Technical English

## Decision

Extend Hypagraph from a single-worker control layer into a graph-family controller with pluggable node executors.

The canonical workflow reducer remains deterministic and independent of Pi, ACP, subprocesses, terminals, git, and executor implementation.

A future family controller coordinates one root Hypagoal and bounded child Hypagoals. Each goal owns one canonical workflow. One scheduler owns all dispatch decisions.

Execution occurs through adapters. The controller owns:

- workflow and family scheduling;
- node contracts;
- attempts;
- child-goal bindings;
- context projection;
- evidence validation;
- graph transitions;
- workspace leases;
- integration;
- budgets;
- replay.

A child Hypagoal is not a subagent. A child Hypagoal defines another canonical workflow. A subagent executes one selected node attempt.

## Visual surfaces

Hypagraph should provide two graph surfaces inside Pi:

- a compact live widget;
- a full interactive overlay opened by `/hypagraph`, `/hypagoal graph`, or a dedicated show action.

Both consume transport-independent projections of canonical state and append-only events.

The future family view must show:

- goal ancestry;
- parent task and child-goal bindings;
- each workflow as a nested graph boundary;
- independent root and child components;
- active executors;
- workspace leases;
- integration state;
- family budgets;
- scheduler decisions.

The view must not imply that a child workflow is copied into the parent workflow definition.

## Workflow and family aggregates

Each workflow keeps its own:

- definition and revision;
- node, loop, fact, route, evaluation, and attempt state;
- workflow-local `GoalRuntime`;
- append-only event stream;
- deterministic snapshot hash.

The family aggregate keeps:

- root goal identity;
- member goal and workflow identities;
- parent-child bindings;
- family bounds and budgets;
- scheduler ordinal and selections;
- child-return state;
- executor and workspace coordination state.

The M5B Slice 1 `GoalRuntime` remains the leaf lifecycle. Family composition is additive.

## Executor abstraction

Node semantics and execution mechanism are separate.

Supported executor kinds are:

- current Pi session;
- isolated Pi RPC subagent;
- ACP-compatible agent;
- named direct CLI adapter;
- extension-owned deterministic executor.

Task nodes reference executor profiles rather than embedding transport details in the graph model.

Executor selection is deterministic from node policy, capability, resource limits, and scheduler state. It is not delegated to another model call.

## Attempts

Every node execution receives an immutable attempt identity.

Events and results carry:

- family ID when one exists;
- goal ID;
- workflow ID;
- graph revision;
- node ID;
- attempt ID;
- workspace lease ID when mutating;
- executor profile and instance identity.

Stale, cancelled, superseded, previous-revision, previous-family-generation, and previous-lease results remain available in history but cannot transition current canonical state.

## Delegated node contract

A delegated worker receives a bounded context envelope containing:

- root and local goal objectives;
- goal ancestry breadcrumbs;
- node intent and acceptance criteria;
- readable and writable scope;
- required evidence;
- selected upstream facts;
- selected artifacts;
- predecessor summaries;
- workflow and attempt identity;
- workspace lease and base revision;
- attempt budget;
- structured result protocol.

Dependency, route, data, feedback, and child-return edges determine which context enters the envelope.

The envelope must be bounded, inspectable, hashable, and reproducible from canonical state.

The complete parent conversation is not the execution contract.

A persisted child Pi session can provide optional continuity. Loss of that session must not remove canonical context or prevent recovery.

## Structured result protocol

Workers do not receive graph or family mutation authority.

A worker returns a structured result envelope with:

- full attempt identity;
- explicit outcome;
- declared facts;
- evidence references;
- artifact references;
- bounded summary;
- diagnostics;
- usage;
- workspace result when mutating.

Raw assistant text is evidence or commentary. It is not the canonical executor result and cannot complete a node directly.

The controller validates the envelope before it commits state changes.

## Family scheduler semantics

The family scheduler sees runnable actions from:

- the root workflow;
- independent root branches;
- connected and disconnected loop regions;
- child workflows;
- deeper descendant workflows.

Only the family scheduler can dispatch work.

A child goal, loop, worker, or model tool cannot enqueue an autonomous continuation directly.

Creating a child goal changes only its invoking parent task to a child-wait state. It does not transfer controller focus or pause unrelated work.

### Logical concurrency

Many components can be runnable, waiting, or active at the same time in canonical state.

The first implementation can interleave work through one current Pi session.

### Physical concurrency

Independent attempts can run concurrently when:

- dependencies and routes permit them;
- loop ordering permits them;
- executor capacity exists;
- family and goal budgets permit them;
- workspace leases are compatible;
- concurrency groups are compatible;
- integration is not conflicting.

Initial delegated concurrency should default to two.

The scheduler must use deterministic priority and stable tie-breaking. Selection must be event-backed so replay does not recalculate a different historical choice.

## Parent and child execution

A parent task can create a bounded child Hypagoal in a later milestone.

The atomic creation operation:

1. validates the parent task and family bounds;
2. validates the child workflow;
3. records the binding;
4. puts only the parent task into `waiting_for_child` or an equivalent state;
5. persists the child workflow and goal start;
6. adds the child workflow to the scheduler;
7. leaves unrelated components unchanged.

Child completion returns declared facts, evidence, and artifacts to the parent binding.

The parent task then resumes integration or verification. Child completion does not complete the parent task automatically.

## Isolated Pi subagents

The first delegated model executor should launch an isolated Pi process in RPC mode.

The `pi-codex-subagents` package is a suitable implementation donor because it already demonstrates:

- isolated child Pi processes;
- RPC JSONL request handling;
- explicit provider and model selection;
- explicit tool, skill, extension, and prompt loading;
- session-scoped agent identity;
- child-session persistence;
- process ownership tokens and identity checks;
- completion mailboxes;
- steering and interruption;
- streaming activity events;
- process-tree termination;
- orphan reconciliation;
- bounded output storage;
- live subagent UI.

Its MIT licence permits reuse with attribution.

Hypagraph should port or adapt the process lifecycle behind its own executor contract. It should not adopt these source-package product semantics:

- model-controlled `spawn_agent` as the scheduler;
- raw final response text as the canonical result;
- same-checkout mutation by concurrent workers;
- agent task names as canonical attempt identity;
- completion messages which directly trigger an uncontrolled Pi turn;
- worker-owned orchestration.

A subagent completion enters the Hypagraph controller as an executor result. The controller validates, persists, integrates, updates canonical state, and asks the scheduler for later work.

## Pi subagent lifecycle

The isolated Pi adapter must support:

1. durable attempt and executor-dispatch events before process launch;
2. explicit context-envelope materialization;
3. controlled child Pi startup;
4. ownership verification;
5. streaming progress projection;
6. bounded steering where policy permits it;
7. cancellation and process-tree termination;
8. structured result submission;
9. session hibernation or termination after settlement;
10. orphan detection after host restart;
11. stale-result rejection;
12. usage accounting.

A resumed child session is an executor optimization. The canonical attempt contract remains the explicit context envelope.

## ACP

Hypagraph acts as an ACP client.

ACP is an execution transport, not the orchestration, goal-family, scheduler, or graph domain model.

Each attempt should initially receive its own ACP session. The adapter negotiates capabilities, streams progress, brokers permissions and user input through Pi, supports cancellation, and normalises the final result.

ACP and isolated Pi executors must return the same normalized result type.

## Direct CLI adapters

Direct CLI execution is a compatibility mechanism for agents without ACP support.

Strict execution requires named adapters with tested invocation, parsing, cancellation, timeout, context, and result-normalisation behavior.

Generic arbitrary-command profiles should remain observe-only.

## Workspace isolation and integration

Mutating delegated nodes use one git worktree per attempt by default.

Execution success and integration success are distinct states.

The preferred path is:

1. scheduler selects the attempt;
2. controller acquires a workspace lease;
3. controller creates or prepares a worktree;
4. worker executes and commits in its worktree;
5. controller validates result identity, scope, facts, evidence, and artifacts;
6. controller integrates the commit into the base workspace;
7. conflicts enter an explicit integration-conflicted state;
8. post-integration checks run in the base workspace;
9. only then can the node complete.

Conflicting exclusive workspace leases cannot run concurrently.

A stale result cannot integrate.

## Persistence and replay

Hypagraph persists append-only events for:

- graph definitions and revisions;
- readiness and attempts;
- facts, evidence, and artifacts;
- gates and loops;
- evaluations and budgets;
- goal lifecycle;
- family membership and child bindings;
- scheduler selections;
- executor dispatch and progress;
- permissions and cancellation;
- workspace leases;
- integration;
- completion, failure, blockage, and invalidation.

Periodic snapshots provide fast restoration.

Live UI, history replay, and external export consume the same event model.

Per-workflow sequences remain. Family-level atomic operations also require a family sequence or transaction ordinal.

## Graph visualisation

The renderer consumes a transport-independent graph-family view model.

Workflow layout should operate over the SCC condensation graph:

1. collapse loop regions;
2. assign directed ranks;
3. reduce edge crossings;
4. expand loop groups and route feedback edges separately;
5. preserve node positions across revisions where possible.

Family layout should:

1. show the root workflow as the primary graph;
2. attach each child workflow to its parent task through a child-binding edge;
3. let the user expand or collapse child workflows;
4. show independent components without false dependency edges;
5. preserve workflow-local layout when family membership changes;
6. display concurrent executor and workspace state without changing canonical graph topology.

The compact widget shows active nodes, ready frontier, child waits, loop progress, executor identity, concurrency use, and elapsed time.

The full overlay adds navigation, goal ancestry, node contracts, evidence, attempts, workspaces, integration, events, replay, filters, pause, cancellation, retry, approval, and revision actions.

## Correctness invariants

1. Only the controller mutates canonical workflow or family state.
2. Every result correlates to an active attempt, workflow revision, goal, and family generation.
3. Cancelled or stale attempts cannot complete nodes.
4. A child goal does not own a competing scheduler.
5. Child creation waits only the invoking parent task.
6. Independent loops remain runnable during child execution.
7. Executors receive explicit reproducible context.
8. Executor session history is not canonical context.
9. Delegated mutation stays inside its workspace lease.
10. Scope validation runs before and after integration.
11. Integration does not bypass evidence or acceptance checks.
12. Execution success and integration success remain separate.
13. Conflicting exclusive workspace leases cannot run concurrently.
14. Credentials are never serialized into graph or family state.
15. ACP, CLI, and model output is treated as untrusted input.
16. History is derived from persisted events.
17. Scheduler selection is event-backed and replayable.
18. Descendant usage is charged to the root family budget.

## Implementation phases

1. root Hypagoal continuation and budgets in M5B;
2. event history and debugger UI in M6;
3. family persistence and root migration in M7;
4. family scheduler with sequential dispatch in M7;
5. bounded child-goal creation and return in M7;
6. executor abstraction and structured contracts in M7;
7. isolated Pi RPC execution in M7;
8. workspace leases and integration in M8;
9. bounded concurrent scheduling in M8;
10. ACP client adapter in M9;
11. direct CLI compatibility adapters in M9.
