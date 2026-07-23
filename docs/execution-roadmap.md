# Hypagraph execution plan and roadmap

- Status: active
- Date: 2026-07-22
- Current milestone: M4
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This document gives the ordered execution plan for Hypagraph.

The graph describes the work. The deterministic runtime executes the work.

Hypagraph is an execution-control kernel for coding agents. A model can propose a plan, write code, and diagnose a failure. The runtime controls state changes, dependency readiness, checks, gates, loops, evidence, budgets, replay, and executor coordination.

The project must complete deterministic runtime functions before it adds delegated or parallel execution.

## 2. Product result

At version 1.0, Hypagraph must:

1. Accept a versioned directed workflow.
2. Validate graph structure, node contracts, gates, and loops.
3. Execute nodes with an explicit finite-state machine.
4. Run deterministic checks.
5. Publish typed facts.
6. Evaluate routes without model judgement.
7. Run bounded iteration regions for refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, and repair.
8. Store an append-only event history.
9. Rebuild state from events.
10. Show live and historical execution in Pi.
11. Delegate bounded node contracts through executor adapters.
12. Keep the domain and runtime independent of Pi.

## 3. Mandatory design rules

### 3.1 Use deterministic control

Use a model only when the task needs semantic reasoning.

Use deterministic code for:

- validation;
- state changes;
- scheduling;
- gate evaluation;
- budgets;
- evidence rules;
- check execution;
- replay.

### 3.2 Keep definition and runtime state separate

The workflow definition contains:

- nodes;
- dependencies;
- contracts;
- gates;
- loop policies;
- executor profiles.

Runtime state contains:

- attempts;
- node states;
- facts;
- evidence;
- budgets;
- selected routes.

### 3.3 Use one canonical writer

Only the controller can change canonical state.

An executor returns a structured result. The controller validates the result before it changes state.

### 3.4 Make failure explicit

The runtime must use explicit states for:

- failed verification;
- blocked work;
- integration conflicts;
- exhausted loops;
- cancelled attempts;
- stale results.

### 3.5 Use ASD-STE100 technical English

All repository text must follow `AGENTS.md`.

## 4. Release sequence

| Milestone | Release marker | Result |
| --- | --- | --- |
| M0 | v0.1 | Stable graph foundation |
| M1 | v0.2 | Event-driven finite-state runtime |
| M2 | v0.3 | Typed facts and deterministic gates |
| M3 | v0.4 | Deterministic check execution |
| M4 | v0.5 | Executable bounded iteration regions |
| M5 | v0.6 | Event history, replay, and debugger UI |
| M6 | v0.7 | Executor abstraction and isolated Pi execution |
| M7 | v0.8 | Workspace integration and bounded concurrency |
| M8 | v0.9 | Agent Communication Protocol adapter and direct adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

Release markers are planning values. Acceptance criteria control milestone completion.

---

# M0 - Stable graph foundation

## Status

Complete in the repository baseline.

## Objective

Make the current single-session graph engine a stable base for later runtime work.

## Implemented work

### Naming

- The product name is `Hypagraph`.
- Pi tools use the `hypagraph_` prefix.
- The Pi command is `/hypagraph`.
- Source types use `Hypagraph` names.
- Persisted state uses the `hypagraph` key.
- Domain events use the `hypagraph.` namespace.
- The extension entry point is `extensions/hypagraph.ts`.
- No compatibility alias is part of the public interface.

### Repository policy

- `AGENTS.md` defines the naming rules.
- `AGENTS.md` makes the ASD-STE100 writing method mandatory.
- The rule applies to documentation, plans, comments, tests, messages, and tool text.

### Schema and persistence

- Persisted state has an explicit schema version.
- Restoration rejects an unsupported schema version.
- State snapshots have deterministic hashes.
- Session restoration uses only the active branch.
- Restoration returns a clone of the stored state.

### Reducer

- The reducer is a pure function.
- The reducer does not read the clock.
- The reducer does not create random values.
- The caller supplies time and workflow identity.
- The reducer does not change input state.
- The same state and command produce the same result.

### Validation

- The validator rejects duplicate node IDs.
- The validator rejects missing dependencies.
- The validator rejects invalid node and loop IDs.
- The validator rejects undeclared cycles.
- A declared loop must match one cyclic strongly connected component.
- A declared loop must identify its feedback edges.
- A declared loop must have a hard iteration limit.
- A declared loop must have a success predicate.

### Runtime rules

- A node cannot start before its dependencies complete.
- Only one node can be active.
- Completion can require evidence.
- A revision marks changed completed nodes as stale.
- A revision also marks dependent completed nodes as stale.
- Strict mode blocks file changes outside the active node scope.

### Tests

- Tests cover dependency order.
- Tests cover one-active-node enforcement.
- Tests cover evidence requirements.
- Tests cover workflow completion.
- Tests cover downstream invalidation.
- Tests cover reducer determinism.
- Tests cover input immutability.
- Tests cover unsupported schema versions.
- Property tests generate directed acyclic graphs and check strongly connected components.

## M0 acceptance criteria

- [x] The public interface uses only Hypagraph names.
- [x] Persisted state has a schema version.
- [x] The reducer is deterministic.
- [x] The reducer does not change input state.
- [x] Invalid graphs cannot start.
- [x] Unsupported snapshots cannot become canonical state.
- [x] The test suite checks the principal domain invariants.
- [x] Repository writing rules are explicit.
- [x] Continuous integration runs `npm run check` on a clean checkout.
- [x] A complete Pi dogfood run is recorded.

The two unchecked items are release tasks. They do not change the M0 domain model.

## M0 release tasks

1. Add continuous integration for supported Node.js versions.
2. Run `npm install` in a network-enabled checkout.
3. Commit the generated lock file.
4. Run `npm run check`.
5. Complete one medium Hypagraph change with Hypagraph itself.
6. Record the dogfood findings.
7. Tag the M0 release.

---

# M1 - Event-driven finite-state runtime

## Objective

Replace the small direct-transition model with an explicit finite-state runtime.

## Node attempt states

The first state model must include:

- `pending`;
- `ready`;
- `starting`;
- `running`;
- `awaiting_evidence`;
- `verifying`;
- `succeeded`;
- `failed`;
- `blocked`;
- `cancelled`;
- `stale`.

The runtime must keep execution success separate from verification success.

## Commands

Add explicit commands for:

- workflow definition;
- workflow revision;
- node start;
- attempt result submission;
- verification start;
- verification completion;
- node block and unblock;
- attempt cancellation;
- node retry;
- workflow pause and resume.

A command states intent. A command handler validates the intent and returns events.

## Event envelope

Each event must include:

- event ID;
- workflow ID;
- graph revision;
- sequence number;
- event type;
- event version;
- timestamp;
- causation ID;
- correlation ID;
- optional node ID;
- optional attempt ID;
- payload.

## Projection

Build canonical state only by applying events.

Create projections for:

- workflow state;
- node state;
- attempt state;
- ready nodes;
- compact user interface state;
- event timeline.

## M1 acceptance criteria

- The same ordered events always produce the same state hash.
- An invalid command produces no events.
- Replay produces the same state as live execution.
- A stale attempt cannot complete a current node.
- Execution and verification have separate states.
- Pi is a thin adapter over the runtime.

---

# M2 - Typed facts and deterministic gates

## Objective

Let nodes publish typed facts. Let gates select routes with deterministic expressions.

## Fact model

Each fact must include:

- namespace;
- name;
- type;
- value;
- producer node;
- producer attempt;
- graph revision;
- publication event;
- optional evidence reference.

Initial fact types:

- Boolean;
- integer;
- floating-point number;
- string;
- duration;
- timestamp;
- string list.

Do not support arbitrary nested objects in the first version.

## Expression engine

Use Common Expression Language or another constrained expression language.

The engine must:

- compile expressions during graph validation;
- type-check expressions;
- run without network access;
- run without file access;
- run without process access;
- run without clock access;
- enforce evaluation limits;
- give source diagnostics;
- version expression semantics.

## M2 acceptance criteria

- A workflow can select a repair route without model judgement.
- Invalid expressions fail before execution.
- The same facts and state always select the same route.
- Unselected routes cannot make downstream nodes ready.
- A revision invalidates affected route decisions.

---

# M3 - Deterministic check execution

## Status

Complete in v0.4. The dogfood record is in `docs/v0.4-dogfood.md`.

## Objective

Make build, test, lint, coverage, and security checks first-class nodes.

## Initial check types

- command exit status;
- test report;
- lint report;
- coverage report;
- file assertion;
- git state assertion.

## Check result

A check result must include:

- check type;
- attempt ID;
- start and end time;
- exit status;
- normalized facts;
- evidence references;
- captured output locations;
- timeout state;
- cancellation state.

## M3 acceptance criteria

- [x] A test check publishes typed facts.
- [x] A gate can use those facts.
- [x] A timeout is an explicit result.
- [x] A check cannot change canonical state directly.
- [x] Check output is treated as untrusted input.
- [x] Pi stores check lifecycle events before the next external side effect.
- [x] Restore does not rerun a command.
- [x] The user can cancel a running check.
- [x] Retry policy is explicit and bounded.
- [x] The live Pi graph pane shows routes, loops, feedback edges, and runtime state.
- [x] The complete dogfood path is recorded.

---

# M4 - Executable bounded loops

## Status

Active. The detailed implementation plan is in `docs/m4-vertical-slice-plan.md`.

M4 is selected before the M3.1 parser adapters.

## Objective

Execute declared cyclic regions as deterministic bounded iteration regions.

A valid v0.5 loop has one entry, one evaluation boundary, typed success rules, declared feedback, a hard iteration limit, optional numeric progress and patience rules, and an explicit failure policy.

A loop can be connected to the main graph or be an independent graph component. Repair is one use case. It is not a loop type.

## Vertical slices

1. Execute one successful iteration.
2. Follow feedback and start iteration 2.
3. Support a failed evaluation check as one loop observation.
4. Enforce the hard iteration limit.
5. Add progress, loss, best result, and patience.
6. Add independent loop regions and explicit outcome policy.
7. Harden revision, cancellation, and recovery.
8. Complete the Pi loop product surface.
9. Dogfood and release v0.5.

## Loop state

Track:

- loop status;
- iteration number;
- hard iteration limit;
- typed success condition;
- progress or loss value;
- best metric and best iteration;
- no-progress count and patience;
- selected feedback edge;
- iteration history;
- exit reason;
- failure policy;
- graph-component identity.

Success and progress are different values.

A loop can improve without succeeding. A loop can also satisfy its success condition without having the best metric value.

## M4 acceptance criteria

- [ ] New loop definitions use typed success conditions.
- [ ] The runtime executes only structured declared loop regions.
- [ ] A false success condition follows only declared feedback.
- [ ] Current facts and gate routes do not leak into a later iteration.
- [ ] A failed evaluation check can provide a valid loop observation.
- [ ] The runtime stops at the hard limit.
- [ ] The runtime can stop after no progress.
- [ ] The runtime stores each iteration result and best metric.
- [ ] Downstream work waits for loop success.
- [ ] Restore does not run a node or check.
- [ ] Replay gives the same loop decision and state hash.
- [ ] Pi shows current iteration, progress, and exit reason.
- [ ] Two disconnected loop regions can run without state coupling.
- [ ] A loop failure policy determines its effect on the workflow and its dependants.
- [ ] The domain model and public guidance do not assign repair semantics to loops.
- [ ] The v0.5 dogfood and release checks pass.

---

# M5 - Event history, replay, and debugger UI

## Objective

Make execution inspectable.

## User interface functions

The compact view must show:

- active node;
- ready nodes;
- blocked gates;
- loop progress;
- executor identity;
- elapsed time.

The full view must show:

- graph navigation;
- node contracts;
- attempts;
- facts;
- evidence;
- events;
- revisions;
- replay position;
- pause, cancel, retry, and approval actions.

## M5 acceptance criteria

- The user can replay a workflow to any event.
- Live and replay views use the same projection code.
- The view preserves node positions across small revisions when possible.
- The user can identify why a node is not ready.

---

# M6 - Executor abstraction and isolated Pi execution

## Objective

Separate node semantics from the system that performs the work.

## Executor contract

An executor receives:

- workflow goal;
- node intent;
- acceptance criteria;
- read scope;
- write scope;
- required evidence;
- selected upstream facts;
- selected artifacts;
- attempt ID;
- cancellation signal.

An executor returns:

- attempt result;
- facts;
- evidence;
- artifacts;
- progress events;
- failure details.

The executor cannot change the graph.

## M6 acceptance criteria

- The current Pi session runs through the executor interface.
- An isolated Pi process can execute one node contract.
- A cancelled executor cannot complete a node.
- Results always identify workflow, revision, node, and attempt.

---

# M7 - Workspace integration and bounded concurrency

## Objective

Run independent delegated nodes and loop regions safely.

## Workspace rules

Use one Git worktree for each mutating attempt.

The controller must:

1. Create a workspace lease.
2. Start the executor in that workspace.
3. Validate changed paths.
4. Validate evidence.
5. Integrate the commit.
6. Run checks in the base workspace.
7. Complete the node only after integration succeeds.

## Concurrency rules

Start with a default limit of two delegated attempts.

Do not run attempts together when they have:

- a dependency relation;
- the same exclusive workspace lease;
- an incompatible concurrency group;
- a loop-order constraint;
- an executor limit conflict.

## M7 acceptance criteria

- Independent nodes can run together.
- Independent loop regions can overlap in execution when budgets permit.
- Conflicting nodes and loop regions cannot run together.
- Integration failure is separate from execution failure.
- Post-integration checks run before completion.
- A stale result cannot integrate.

---

# M8 - External executor adapters

## Objective

Support external agents without moving orchestration out of Hypagraph.

## Agent Communication Protocol

Hypagraph acts as the protocol client.

The adapter must:

- create one session for each attempt;
- negotiate capabilities;
- stream progress;
- broker permissions;
- broker user input;
- support cancellation;
- normalize the final result.

## Direct command-line adapters

Use named and tested adapters.

A named adapter must define:

- command invocation;
- input format;
- output format;
- cancellation behavior;
- timeout behavior;
- result normalization;
- security limits.

Do not use an arbitrary command as a strict mutating executor.

## M8 acceptance criteria

- One external protocol agent can execute a node.
- One named command-line adapter can execute a node.
- Both adapters produce the same normalized result type.
- Untrusted output cannot change canonical state without validation.

---

# Version 1.0 exit criteria

Hypagraph can release version 1.0 when:

- the domain package has no Pi dependency;
- event replay is deterministic;
- schema migration is documented and tested;
- checks and gates are deterministic;
- iteration regions are bounded, policy-driven, independent when disconnected, and replayable;
- executors cannot change canonical state;
- delegated file changes use isolated workspaces;
- cancellation and stale-result rules are tested;
- the user interface explains readiness and failure;
- documentation follows the repository writing rules;
- a complete medium coding task succeeds through Hypagraph without manual state repair.

## Immediate next work

1. Add the M1 event envelope.
2. Add the command handler interface.
3. Add pure event projections.
4. Define the node attempt transition table.
5. Add replay tests.
6. Keep Pi as an adapter.
