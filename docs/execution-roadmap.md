# Hypagraph execution plan and roadmap

- Status: active roadmap
- Date: 2026-07-21
- Horizon: v0.2 through v1.0
- Depends on: `docs/product-spec.md`, `docs/delegation-and-visualisation.md`

## 1. Purpose

This document turns Hypagraph's product direction into an ordered execution plan.

The central architectural distinction is:

> The graph describes the work. A deterministic finite-state runtime executes the work.

Hypagraph is therefore not merely a visual graph planner or a replacement todo list. It is an execution-control kernel for coding agents. The model may propose plans, implement code, and diagnose failures, but the runtime owns lifecycle transitions, dependency readiness, checks, gates, loops, evidence, budgets, replay, and executor coordination.

The roadmap is deliberately sequenced so that deterministic execution semantics are established before delegated or parallel agent execution is introduced.

## 2. Product outcome

At v1.0, Hypagraph should be able to:

1. accept a versioned directed workflow authored by an agent or user;
2. validate its graph structure, node contracts, gates, and loop regions;
3. execute nodes through an explicit event-driven state machine;
4. run deterministic checks and publish typed facts;
5. evaluate branches and joins without model judgement;
6. run bounded repair and refinement loops with explicit success and convergence policies;
7. persist an append-only event history and rebuild state through replay;
8. visualise live and historical execution inside Pi;
9. delegate bounded node contracts through pluggable executor adapters;
10. remain independent of Pi at the domain and runtime layers.

## 3. Principles and constraints

### 3.1 Determinism by default

Use model judgement only where semantic reasoning is genuinely required. Scheduling, state transitions, validation, gate evaluation, budgets, evidence rules, and check execution must be deterministic.

### 3.2 Events are the source of truth

Canonical workflow state should become a projection over append-only events. Snapshots are an optimisation for restoration, not the authoritative record.

### 3.3 Graph and runtime are separate

The workflow definition describes nodes, edges, contracts, gates, and loop policies. Runtime state describes attempts, lifecycle states, facts, evidence, budgets, and selected routes.

### 3.4 The controller is the only writer

Executors never mutate canonical workflow state. They return structured results and events which the controller validates before applying transitions.

### 3.5 Failure is explicit state

Failed verification, blocked work, integration conflicts, exhausted loops, cancelled attempts, and stale results are not prose conditions. They are first-class runtime states with permitted recovery transitions.

### 3.6 Build the single-worker kernel first

Delegation and concurrency must not be used to paper over incomplete lifecycle semantics. The same workflow must work correctly with the current Pi session before it can safely run through multiple executors.

## 4. Current baseline

The current vertical slice already provides:

- graph definition and validation;
- dependency-derived readiness;
- a pure state reducer;
- one-active-node enforcement;
- evidence-gated completion;
- SCC detection and exact bounded-loop declarations;
- graph revision with downstream invalidation;
- branch-aware restoration from tool-result snapshots;
- Pi tools and status integration;
- guided and strict write-scope enforcement.

The current reducer is a useful foundation, but it still treats execution as a relatively small set of direct transitions. The next stage is to expand this into a durable execution FSM and event model.

## 5. Target architecture

Hypagraph should converge on the following boundaries:

```text
Workflow definition
  - nodes
  - edges
  - contracts
  - gates
  - loop policies
  - executor profiles
            |
            v
Deterministic controller
  - command validation
  - FSM transition rules
  - scheduling
  - budgets
  - evidence validation
  - integration policy
            |
            v
Append-only event store ---> projections ---> Pi UI / replay / export
            |
            v
Executors
  - current Pi session
  - deterministic checks
  - isolated Pi worker
  - ACP adapter
  - direct CLI adapter
  - human approval
```

The domain package must not depend on Pi, terminal UI APIs, ACP, git processes, or any particular executor implementation.

## 6. Delivery strategy

The roadmap is split into seven milestones. Each milestone should leave the repository in a usable state and should be releasable independently.

Recommended release sequence:

| Milestone | Suggested release | Primary outcome |
| --- | --- | --- |
| M0 | v0.2 | Stabilised current graph runtime |
| M1 | v0.3 | Explicit event-driven execution FSM |
| M2 | v0.4 | Typed facts and deterministic gates |
| M3 | v0.5 | First-class check execution |
| M4 | v0.6 | Executable bounded loops |
| M5 | v0.7 | Event history, replay, and debugger UI |
| M6 | v0.8 | Executor abstraction and isolated Pi execution |
| M7 | v0.9 | ACP, workspace integration, and bounded concurrency |
| Exit | v1.0 | Hardened agent-independent execution kernel |

The versions are planning markers rather than commitments. Milestone acceptance criteria are authoritative.

---

# Milestone 0 — Stabilise the current graph runtime

## Objective

Make the existing single-session implementation a trustworthy base for architectural change.

## Scope

### Repository hygiene

- regenerate and commit `package-lock.json` under the Hypagraph package name;
- add CI for type checking and tests;
- add release/versioning conventions;
- remove remaining obsolete product-name references where they are not retained compatibility identifiers;
- document the intentional distinction between Hypagraph branding and existing `workgraph_*` protocol names.

### Domain hardening

- define all reducer invariants in tests;
- add property tests for graph revision and readiness;
- test strict scope matching and path traversal rejection;
- validate snapshot hashes during restoration;
- reject malformed or incompatible snapshots with diagnostics rather than silently accepting them;
- define schema migration behaviour before schema version 2 is introduced.

### Dogfooding

Use Hypagraph to perform at least one medium-sized change to Hypagraph itself. Record friction, bypasses, missing transitions, and confusing UI behaviour.

## Deliverables

- green CI on supported Node versions;
- documented invariants;
- restoration validation;
- expanded tests;
- dogfooding notes in `docs/research/` or an issue;
- clean v0.2 release candidate.

## Acceptance criteria

- `npm run check` succeeds from a fresh clone;
- malformed graph state cannot become canonical state;
- a two-to-six-node coding task can be completed through the Pi tools without manual state repair;
- every known state mutation occurs through the reducer;
- no current test depends on Pi UI internals for domain correctness.

## Exclusions

Do not introduce gates, executable loops, subagents, or concurrency in this milestone.

---

# Milestone 1 — Event-driven execution FSM

## Objective

Replace the minimal node transition model with an explicit finite-state execution runtime driven by commands and events.

## 1.1 Lifecycle model

Define a node-attempt lifecycle that can represent work, verification, failure, repair, cancellation, and later integration.

Recommended initial states:

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

Future delegated states may add:

```text
queued
integrating
integration_conflicted
superseded
```

The exact state names may change, but the runtime must distinguish successful execution from successful verification.

## 1.2 Commands

Introduce explicit commands such as:

- `DefineWorkflow`;
- `ReviseWorkflow`;
- `StartNode`;
- `SubmitAttemptResult`;
- `BeginVerification`;
- `CompleteVerification`;
- `BlockNode`;
- `UnblockNode`;
- `CancelAttempt`;
- `RetryNode`;
- `PauseWorkflow`;
- `ResumeWorkflow`.

Commands express intent. They are validated against current projected state and produce zero or more events.

## 1.3 Events

Introduce a versioned event envelope containing:

- event ID;
- workflow ID;
- graph revision;
- sequence number;
- event type and version;
- timestamp;
- causation ID;
- correlation ID;
- optional node ID and attempt ID;
- event payload.

Initial events should include:

- `WorkflowDefined`;
- `WorkflowRevised`;
- `NodeBecameReady`;
- `NodeStartRequested`;
- `AttemptStarted`;
- `AttemptResultSubmitted`;
- `VerificationStarted`;
- `VerificationPassed`;
- `VerificationFailed`;
- `NodeBlocked`;
- `NodeUnblocked`;
- `AttemptCancelled`;
- `NodeSucceeded`;
- `NodeFailed`;
- `NodeInvalidated`;
- `WorkflowPaused`;
- `WorkflowResumed`;
- `WorkflowCompleted`;
- `WorkflowFailed`.

Avoid creating events for every derived value. For example, readiness may either be derived or recorded only where historical readiness is required for replay and diagnostics. Make that decision explicitly in an ADR.

## 1.4 Projection

Build canonical state exclusively by applying events through pure projection functions.

Required projections:

- workflow execution state;
- node and attempt state;
- ready frontier;
- compact UI summary;
- event timeline.

## 1.5 Compatibility migration

Provide a migration path from current snapshot-only sessions:

- accept schema version 1 snapshots;
- synthesise an initial event stream or wrap the snapshot in a migration event;
- write all new mutations using schema version 2 events;
- document whether old sessions remain writable or read-only.

## Deliverables

- event envelope and event schemas;
- command handler returning events;
- pure event projection;
- revised Pi tool handlers;
- migration support for existing snapshots;
- lifecycle and transition table documentation;
- exhaustive transition tests.

## Acceptance criteria

- the same ordered event stream always produces the same state hash;
- invalid transitions produce diagnostics and no events;
- replay reconstructs the same workflow state as live execution;
- stale attempt events cannot complete a current node;
- node execution and verification are represented as separate phases;
- Pi remains a thin adapter over the runtime.

## Risks

The main risk is over-designing a distributed workflow system prematurely. Keep v0.3 in-process and single-writer. The event model should support future persistence and delegation without requiring them immediately.

---

# Milestone 2 — Typed facts and deterministic gates

## Objective

Allow checks and nodes to publish typed facts and allow the graph to route execution through deterministic predicates.

## 2.1 Fact model

Define immutable fact records with:

- namespace and name;
- declared type;
- value;
- producer node and attempt;
- graph revision;
- publication event;
- optional evidence reference;
- acceptance status.

Initial types:

- Boolean;
- integer;
- floating-point number;
- string;
- duration;
- timestamp;
- string list.

Avoid arbitrary nested objects in the first version. A constrained type system makes validation and expression compilation more reliable.

## 2.2 Fact contracts

Nodes declare the facts they may publish. Consumers and gates declare the facts they require.

Validation must reject:

- undeclared fact publication;
- type mismatch;
- references to facts that cannot be available on the incoming route;
- ambiguous or conflicting fact names;
- stale facts from superseded attempts unless explicitly selected.

## 2.3 Expression engine

Adopt CEL or a similarly constrained, non-Turing-complete expression language.

Implementation requirements:

- compile expressions when the graph is defined or revised;
- type-check expressions against the workflow fact environment;
- evaluate expressions without network, filesystem, process, clock, or model access;
- enforce execution limits;
- report diagnostics with source location;
- version expression semantics.

## 2.4 Gate nodes

Support exclusive gates first.

An exclusive gate contains ordered outcomes:

- each outcome has a Boolean predicate and one or more routed targets;
- one optional `else` outcome is permitted;
- exactly one outcome must be selected;
- zero or multiple matches are deterministic failures unless the declared mode permits them.

Inclusive gates and richer joins should follow only after exclusive routing is stable.

## 2.5 Join behaviour

Define how routed branches affect downstream readiness:

- nodes on unselected branches become `skipped` or inactive for the current revision;
- joins declare whether they require all selected predecessors, any selected predecessor, or a named branch set;
- branch selection is persisted as events;
- graph revision invalidates affected branch decisions.

## Deliverables

- fact type system;
- fact publication events and projection;
- expression compiler/evaluator abstraction;
- exclusive gate nodes;
- persisted route-selection events;
- branch-aware readiness;
- schema and examples.

## Acceptance criteria

- a build/test workflow can route to either documentation or repair without an LLM decision;
- invalid expressions are rejected before execution;
- identical facts and graph state always produce the same selected route;
- unselected branches cannot become ready;
- facts from cancelled or stale attempts cannot satisfy current gates;
- gate outcomes are visible in the event history and UI projection.

---

# Milestone 3 — First-class deterministic checks

## Objective

Replace manual evidence claims for mechanical verification with extension-owned check execution and typed result parsing.

## 3.1 Check node contract

A check node declares:

- command profile or built-in runner;
- working directory policy;
- timeout;
- environment allowlist;
- expected artifacts;
- parser;
- published facts;
- success policy;
- output retention policy.

Do not permit arbitrary unrestricted shell execution in strict mode without an explicit policy decision.

## 3.2 Runner abstraction

Introduce a deterministic executor interface for check nodes:

```text
prepare -> start -> stream -> cancel -> collect -> parse -> publish
```

The runtime owns timeouts, cancellation, result size limits, and event publication.

## 3.3 Initial runners and parsers

Prioritise generic primitives over ecosystem-specific breadth:

1. process exit-code runner;
2. JSON-file parser;
3. JUnit XML parser;
4. line/regex fact extractor for observe-only use;
5. git diff/status collector;
6. file-exists and content-hash checks.

Then add useful presets for:

- TypeScript type checking;
- Vitest/Jest;
- .NET build and test;
- linting;
- coverage reports.

Presets should compile into ordinary check definitions rather than creating special runtime branches.

## 3.4 Evidence integration

Check attempts automatically produce evidence containing:

- command profile;
- exit status;
- timestamps and duration;
- bounded stdout/stderr references;
- parsed report artifact hashes;
- published facts.

Manual evidence remains valid for semantic tasks, but deterministic checks should be preferred wherever possible.

## 3.5 Safety

- environment variables are allowlisted;
- credentials are never written into events;
- output is treated as untrusted data;
- parser failures are explicit verification failures;
- command and output sizes are bounded;
- cancellation terminates process trees where supported.

## Deliverables

- check executor interface;
- process runner;
- parser interface and initial parsers;
- check events;
- fact publication integration;
- timeout and cancellation handling;
- check-node UI detail view.

## Acceptance criteria

- Hypagraph can run its own typecheck and test suite as check nodes;
- test results publish typed pass/fail counts;
- check failure routes deterministically through a gate;
- a timed-out or cancelled check cannot publish accepted facts;
- raw console output is not parsed by the graph controller itself;
- check evidence is sufficient to audit why a gate passed or failed.

---

# Milestone 4 — Executable bounded loops

## Objective

Turn validated SCC loop declarations into executable, bounded feedback regions.

## 4.1 Loop runtime state

Track per-loop:

- status;
- current iteration;
- current and best attempt set;
- success predicate result;
- current and best loss;
- patience counter;
- iteration, tool-call, time, and cost budgets;
- selected exit outcome;
- retained artifacts and facts.

## 4.2 Loop lifecycle

Recommended loop states:

```text
inactive
entering
iterating
evaluating
succeeded
stalled
exhausted
failed
cancelled
```

Each iteration must have a stable ID. Facts and evidence must be attributable to an iteration and attempt.

## 4.3 Success and loss

Keep hard success predicates separate from progress objectives.

- success answers whether the loop may exit successfully;
- loss compares unsuccessful iterations;
- lower loss never overrides a failed success predicate;
- lexicographic objectives should be the default;
- scalar objectives are supported only when units are meaningfully comparable.

Example lexicographic loss:

```text
[
  types.errors,
  tests.failed,
  coverage.shortfall,
  lint.warnings
]
```

## 4.4 Convergence controls

Support:

- `maxIterations`;
- `patience`;
- `minImprovement`;
- optional `maxToolCalls`;
- optional elapsed-time budget;
- optional token or monetary budget where an executor supplies reliable usage.

Every loop must have a hard bound. Patience is additional protection, not a replacement.

## 4.5 Iteration reset semantics

Define exactly which nodes reset for a new iteration:

- feedback-edge targets reset;
- downstream nodes inside the SCC reset as required;
- accepted upstream inputs outside the loop remain stable;
- prior iteration facts remain historical but are not implicitly current;
- best-attempt artifacts may be retained according to policy.

## 4.6 Failure outcomes

A loop may terminate as:

- success;
- stalled;
- exhausted;
- deterministic error;
- user cancellation.

These outcomes must be routable through explicit graph edges rather than silently failing the workflow.

## Deliverables

- loop controller;
- iteration events and projection;
- success predicate evaluation;
- loss/objective evaluator;
- patience and budget enforcement;
- loop UI summary;
- repair-loop examples and tests.

## Acceptance criteria

- an implement/test/diagnose/repair loop can run for multiple iterations;
- the runtime exits immediately when the hard success predicate passes;
- the runtime stops at its iteration budget even if the model wants to continue;
- stalled progress is detected using persisted loss history;
- loop results are reproducible from events;
- previous iteration facts cannot accidentally satisfy the current iteration's gate.

---

# Milestone 5 — Event history, replay, and execution debugger

## Objective

Make execution observable enough to understand, audit, and debug without reconstructing behaviour from a conversation transcript.

## 5.1 Persistence

Introduce an append-only event-store abstraction.

Initial implementations:

1. Pi session-backed event persistence for portability;
2. local file-backed store for larger histories;
3. optional SQLite implementation if indexing and snapshots justify it.

The domain layer depends only on the abstraction.

## 5.2 Snapshots

Create periodic snapshots containing:

- projection schema version;
- last applied sequence number;
- state hash;
- canonical projected state.

On restoration:

1. load the latest valid compatible snapshot;
2. replay subsequent events;
3. verify final state hash;
4. fall back to full replay if validation fails.

## 5.3 Replay modes

Support:

- replay to latest;
- replay to sequence number;
- replay to timestamp;
- inspect a graph revision;
- inspect a node attempt;
- compare two attempts or loop iterations.

Replay is read-only. Historical inspection must not mutate the live workflow.

## 5.4 UI surfaces

### Compact widget

Show:

- workflow phase;
- active node or attempt;
- ready frontier;
- current gate or loop state;
- latest check result;
- elapsed time.

### Full overlay

Show:

- graph view;
- selected node contract;
- attempt list;
- evidence and facts;
- event timeline;
- gate decisions;
- loop iteration history;
- revision changes;
- pause, resume, retry, cancel, and approval actions.

## 5.5 Graph layout

Layout over the SCC condensation graph:

1. collapse loop regions;
2. rank the DAG;
3. reduce edge crossings;
4. expand loop regions;
5. render feedback edges distinctly;
6. preserve stable positions between revisions where possible.

The first useful renderer may be textual or box-drawing based. Do not delay replay semantics while pursuing a perfect graphical UI.

## Deliverables

- event-store abstraction;
- durable local implementation;
- snapshot and replay service;
- timeline projection;
- full Hypagraph overlay;
- graph layout/view model;
- attempt and iteration comparison.

## Acceptance criteria

- the user can identify exactly why a node is not ready;
- the user can inspect which facts caused a gate decision;
- the user can replay to a failed verification event;
- a full state rebuild matches the live state hash;
- UI projections consume the same event stream as runtime restoration;
- session compaction does not erase execution history required for replay.

---

# Milestone 6 — Executor abstraction and isolated Pi execution

## Objective

Separate node semantics from execution transport and prove the abstraction with an isolated Pi worker.

## 6.1 Executor contract

Define a transport-neutral executor interface around immutable attempt contracts.

Input contract:

- workflow and graph revision IDs;
- node and attempt IDs;
- goal and node intent;
- acceptance criteria;
- readable and writable scope;
- selected upstream facts and artifacts;
- evidence requirements;
- budget and cancellation token;
- result protocol version.

Output envelope:

- attempt identity;
- terminal executor status;
- evidence;
- published facts;
- artifacts;
- mutation summary;
- usage metrics where reliable;
- structured diagnostics;
- optional human-readable summary.

## 6.2 Executor profiles

A node references a named executor profile. Profiles contain capabilities and transport configuration outside canonical graph state.

Initial executor kinds:

- current Pi session;
- deterministic check executor;
- isolated Pi worker;
- human approval.

Executor selection must be deterministic from node policy and profile capability.

## 6.3 Attempt lifecycle

Every execution receives a unique attempt ID. Results must match:

- workflow ID;
- graph revision;
- node ID;
- attempt ID;
- executor profile;
- active lease where relevant.

Cancelled, stale, superseded, or previous-revision attempts remain historical but cannot mutate current state.

## 6.4 Isolated Pi worker

The first delegated executor should launch Pi in an isolated process or RPC session with:

- the bounded node contract;
- minimal required context;
- restricted tool surface;
- structured result submission;
- streamed progress events;
- cancellation support.

The worker has no graph mutation tools.

## 6.5 Parent-session semantics

The current Pi session remains the controller and exclusive interactive agent. In the first release, run only one delegated mutating node at a time.

## Deliverables

- executor and attempt interfaces;
- profile configuration;
- current-session adapter;
- deterministic check adapter migration;
- isolated Pi adapter;
- progress and cancellation events;
- structured result validation.

## Acceptance criteria

- the same task-node contract can execute in the current session or isolated Pi without changing graph semantics;
- a worker cannot directly revise or transition the graph;
- stale worker results are rejected;
- cancellation produces an auditable terminal attempt state;
- malformed result envelopes cannot publish accepted evidence or facts;
- executor-specific details do not leak into the domain graph model.

---

# Milestone 7 — ACP, workspace integration, and bounded concurrency

## Objective

Support external agent harnesses and safe parallel delegated execution without weakening controller invariants.

## 7.1 Workspace leases

Mutating delegated attempts use isolated git worktrees by default.

A workspace lease records:

- workspace ID and path reference;
- base commit;
- allowed scope;
- owning attempt;
- lease state;
- integration state.

Conflicting exclusive leases cannot run concurrently.

## 7.2 Integration lifecycle

Execution success and integration success are distinct.

Preferred flow:

1. worker completes and commits inside its worktree;
2. controller validates scope and evidence;
3. controller inspects the diff;
4. controller cherry-picks into the base workspace;
5. conflicts enter `integration_conflicted`;
6. post-integration checks run in the base workspace;
7. only then may the node succeed.

## 7.3 ACP adapter

Hypagraph acts as an ACP client. ACP remains an execution transport rather than the graph domain model.

The adapter should:

- negotiate capabilities;
- create one ACP session per attempt initially;
- stream progress;
- broker permissions and user questions through the controller;
- support cancellation;
- normalise results into the executor envelope;
- treat all remote output as untrusted.

## 7.4 Bounded parallel scheduler

Allow independent delegated nodes to run concurrently only when:

- all dependencies are satisfied;
- they are not ordered within the same loop iteration;
- executor capacity permits it;
- workspace leases do not conflict;
- concurrency-group rules permit it;
- the workflow is not paused;
- budgets remain available.

Start with a default concurrency limit of two.

## 7.5 Direct CLI adapters

Add named, tested adapters for selected agent CLIs only after ACP and executor semantics are stable.

Each adapter must define:

- invocation;
- context handoff;
- progress parsing;
- cancellation;
- permission behaviour;
- structured result extraction;
- supported capabilities.

Generic arbitrary commands remain observe-only or explicitly unsafe.

## Deliverables

- git workspace lease service;
- integration FSM;
- ACP client adapter;
- permission and user-input brokerage;
- bounded concurrent scheduler;
- one or more named direct CLI adapters;
- integration and concurrency UI states.

## Acceptance criteria

- two independent non-conflicting delegated nodes can run concurrently;
- conflicting worktree scopes are serialised or rejected;
- worker success does not imply node success until integration and post-integration checks pass;
- ACP results obey the same attempt and evidence validation as Pi workers;
- cancelled or superseded remote sessions cannot complete nodes;
- concurrency decisions are deterministic and explainable.

---

# v1.0 exit milestone — Harden the execution kernel

## Objective

Declare Hypagraph a stable agent-independent execution kernel rather than an experimental Pi extension.

## Required work

### Public contracts

- version workflow, event, fact, executor, and artifact schemas;
- publish compatibility and migration policy;
- stabilise extension-facing APIs;
- document supported failure and recovery semantics.

### Reliability

- crash-recovery testing;
- corrupted event and snapshot handling;
- cancellation race tests;
- stale result and revision race tests;
- large-history replay benchmarks;
- loop and scheduler property testing;
- deterministic state-hash tests across platforms.

### Security

- threat model for local and remote executors;
- credential and environment handling review;
- worktree/path containment review;
- untrusted output and artifact validation;
- command policy review;
- dependency and release provenance.

### Operability

- structured logs;
- OpenTelemetry-compatible event export;
- useful diagnostics for every rejected command;
- documented recovery procedures;
- example workflows;
- upgrade guide from v0.x.

### Host independence

- extract or confirm a standalone core/runtime package;
- keep Pi integration in an adapter package or clear module boundary;
- provide a minimal non-Pi harness proving runtime independence.

## v1.0 acceptance criteria

- a workflow can be defined, executed, failed, repaired, replayed, and audited without relying on transcript interpretation;
- the same domain runtime can be hosted by Pi and a minimal standalone harness;
- all loops and delegated attempts are hard-bounded and cancellable;
- every canonical state transition is attributable to a validated command and persisted event;
- runtime reconstruction is deterministic;
- integrations cannot bypass checks, evidence, or scope policy;
- public schema changes follow a documented compatibility policy.

---

# 7. Cross-cutting workstreams

These workstreams span all milestones and should be tracked separately from feature phases.

## 7.1 Schema and migration discipline

- assign explicit versions to definitions, commands, events, facts, snapshots, and executor envelopes;
- include fixture-based migration tests;
- never change persisted event meaning in place;
- prefer additive event versions and projection migrations;
- retain unknown events for forward compatibility where safe.

## 7.2 Testing strategy

Maintain four test layers:

1. pure domain unit tests;
2. property tests for graph, scheduler, revision, and replay invariants;
3. adapter contract tests for Pi, checks, ACP, and CLI executors;
4. end-to-end fixture workflows.

Core properties should include:

- replay determinism;
- at most one canonical transition per accepted command path;
- stale attempts cannot succeed;
- no node becomes ready before its selected prerequisites are satisfied;
- all cycles belong to declared loop regions;
- loop budgets are never exceeded;
- exclusive gates select exactly one route;
- integration cannot widen writable scope.

## 7.3 Observability

Every milestone should improve diagnostics and telemetry.

Track at least:

- workflow duration;
- node and attempt duration;
- wait versus execution time;
- retries and invalidations;
- gate outcomes;
- loop iterations and best loss;
- check failures;
- executor usage;
- integration conflicts;
- cancellation and stale-result counts.

Telemetry export must not become canonical state.

## 7.4 Documentation

Update documentation as executable behaviour changes:

- product specification describes intended semantics;
- this roadmap describes sequencing;
- ADRs record irreversible or high-cost decisions;
- examples demonstrate current supported behaviour only;
- compatibility notes explain retained `workgraph_*` identifiers.

## 7.5 Dogfooding

Hypagraph should manage its own development as early as practical.

For each milestone:

1. define at least one real repository change as a Hypagraph workflow;
2. record manual bypasses and missing states;
3. convert repeated friction into tests or backlog items;
4. preserve representative event histories as fixtures.

---

# 8. Recommended repository structure

The current repository can evolve toward:

```text
src/
  domain/
    definition/
    events/
    commands/
    projection/
    facts/
    gates/
    loops/
  runtime/
    controller/
    scheduler/
    replay/
    snapshots/
  executors/
    current-session/
    checks/
    pi-worker/
    acp/
    cli/
  integration/
    workspaces/
    git/
  persistence/
  ui/
  pi/
extensions/
tests/
  domain/
  properties/
  contracts/
  integration/
  fixtures/
docs/
  adr/
  examples/
  research/
```

Do not perform a large directory rewrite solely to match this shape. Move code as milestone boundaries become real.

# 9. Architecture decisions to record

Create ADRs before or during the relevant milestones for:

1. event sourcing and snapshot strategy;
2. whether readiness is derived, persisted, or both;
3. node and attempt state model;
4. expression engine selection and sandboxing;
5. fact naming and type system;
6. check process security policy;
7. loop loss and convergence semantics;
8. event-store implementation and Pi-session embedding;
9. executor result protocol;
10. workspace lease and git integration strategy;
11. ACP session lifecycle;
12. scheduler concurrency and fairness rules;
13. schema versioning and migration policy.

# 10. Initial implementation backlog

The following backlog should be executed in order unless discovery invalidates it.

## Now — M0 stabilisation

- [ ] Add GitHub Actions workflow for `npm ci`, typecheck, and tests.
- [ ] Generate a fresh `package-lock.json` for Hypagraph.
- [ ] Add snapshot integrity validation.
- [ ] Expand graph revision property tests.
- [ ] Add strict-scope path and glob tests.
- [ ] Add a compatibility note for `workgraph_*` tools and schema names.
- [ ] Dogfood the current implementation on a medium-sized repository change.

## Next — M1 FSM and events

- [ ] Write ADR for event sourcing and projections.
- [ ] Define command, event, and envelope types.
- [ ] Define node and attempt transition tables.
- [ ] Implement pure `handle(command, state) -> events` logic.
- [ ] Implement pure event projection.
- [ ] Add sequence numbers, causation IDs, and state hashes.
- [ ] Adapt current reducer tests to command/event assertions.
- [ ] Migrate Pi tools to the controller API.
- [ ] Add schema-v1 snapshot compatibility.

## Then — M2 facts and gates

- [ ] Write ADR for CEL and fact types.
- [ ] Add declared fact schemas to node definitions.
- [ ] Add fact publication events and projection.
- [ ] Compile and validate gate expressions.
- [ ] Implement exclusive gate outcomes.
- [ ] Persist selected routes.
- [ ] Add skipped/unselected branch semantics.
- [ ] Add gate diagnostics and UI projection.

## Then — M3 checks

- [ ] Define check node and runner interfaces.
- [ ] Implement bounded subprocess runner.
- [ ] Implement JSON and JUnit parsers.
- [ ] Publish check facts and evidence.
- [ ] Add timeout and process-tree cancellation.
- [ ] Add Hypagraph self-check workflow fixture.
- [ ] Add .NET and TypeScript presets after generic runners pass.

## Then — M4 loops

- [ ] Define loop runtime events and projection.
- [ ] Implement iteration reset rules.
- [ ] Evaluate success predicates after configured nodes.
- [ ] Implement lexicographic loss.
- [ ] Implement patience and hard budgets.
- [ ] Add stalled, exhausted, and success routes.
- [ ] Add multi-iteration replay fixtures.

## Then — M5 replay and UI

- [ ] Define event-store abstraction.
- [ ] Add durable local event store.
- [ ] Add periodic snapshots and integrity checks.
- [ ] Add replay-to-sequence service.
- [ ] Build event timeline projection.
- [ ] Build first full `/hypagraph` overlay.
- [ ] Add graph layout over SCC condensation.
- [ ] Add node-attempt and loop-iteration inspection.

## Later — M6/M7 execution adapters

- [ ] Define executor profile and result envelope.
- [ ] Migrate current-session and check execution behind executor interfaces.
- [ ] Build isolated Pi worker.
- [ ] Add workspace leases and worktrees.
- [ ] Add integration lifecycle and post-integration checks.
- [ ] Build ACP adapter.
- [ ] Add deterministic bounded scheduler.
- [ ] Add selected direct CLI adapters.

# 11. Milestone governance

A milestone is complete only when:

- its acceptance criteria are covered by automated tests or a documented manual verification;
- the behaviour is represented in current documentation;
- persisted schema changes include migration fixtures;
- the milestone has been dogfooded on a real task;
- known shortcuts and deferred work are recorded explicitly;
- the next milestone does not require bypassing current invariants.

Avoid calendar-driven completion claims. A milestone is complete when its runtime semantics are trustworthy.

# 12. Explicit non-goals before v1.0

Do not prioritise the following until the kernel is stable:

- a hosted control plane;
- organisation-level workflow management;
- arbitrary multi-agent swarms;
- automatic model selection through another LLM call;
- a general-purpose workflow language unrelated to coding agents;
- distributed consensus or multi-writer state;
- unrestricted JavaScript expressions;
- a marketplace of executor plugins;
- polished web visualisation before replay and debugging semantics exist;
- tight coupling to Atomic, Hypa, or another product runtime.

Hypagraph may export events to those systems later. It should first become a coherent standalone execution kernel.

# 13. Immediate definition of success

The next major checkpoint is not delegated agents. It is this:

> Hypagraph can execute a coding workflow through an explicit FSM, run deterministic checks, publish typed facts, choose a route through a gate, and reconstruct the exact result from its event history.

Once that is reliable, executable loops and delegated workers become controlled extensions of the same runtime rather than separate orchestration features.
