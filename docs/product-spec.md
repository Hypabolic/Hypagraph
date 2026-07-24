# Hypagraph product and technical specification

- Status: active
- Version: implementation baseline through M5B Slice 6
- Current baseline: `a6c5b9ee2b9025308e91241570154b0524158258`
- Delivery: independent Pi package, designed to support additional agent runtimes
- Future execution plan: `docs/goal-family-and-concurrent-execution-plan.md`

## Executive decision

Hypagraph is an execution-control layer in which coding work becomes an executable directed graph instead of a flat todo list.

The graph makes these concerns executable rather than advisory:

1. dependency order;
2. logical gates and branch selection;
3. evidence-backed completion;
4. bounded iteration regions;
5. deterministic evaluation and progress control;
6. durable recovery and replay;
7. autonomous goal continuation;
8. bounded goal decomposition;
9. isolated and concurrent execution.

Models inspect repositories, author graphs, and perform task work. The deterministic controller validates definitions, scopes, transitions, evidence, check contracts, gate decisions, loop boundaries, evaluation contracts, goal control, scheduling, executor results, workspace leases, and integration.

## Product thesis

Flat plans encode sequence but not dependency, hide blocked states, accept narrative completion claims, and handle repeated work through unstructured replanning.

Hypagraph represents work as bounded node contracts connected by dependency, route, data, and feedback edges. It turns ordinary user intent into the smallest useful executable graph. The user does not need to design graph structure or use graph terminology.

A durable objective can later discover another bounded objective. Hypagraph represents that decomposition as a child Hypagoal with its own canonical workflow. One family controller coordinates the resulting workflow family.

## Product boundary

Hypagraph supports or plans:

- automatic graph authoring from ordinary repository requests and supplied plans;
- a user-inspectable work graph;
- typed node contracts;
- dependency-derived readiness;
- evidence-gated completion;
- deterministic checks and typed facts;
- typed gates and persisted route selection;
- strongly connected bounded iteration regions;
- independent top-level loop components;
- numeric progress, best-result tracking, patience, and explicit failure policy;
- trusted evaluation contracts with validity, feedback, budgets, integrity, authoring, and transport adapters;
- branch-aware session persistence;
- event-backed Hypagoal lifecycle;
- graph-aware autonomous continuation;
- bounded parent and child goal composition;
- isolated node executors;
- worktree leases and integration;
- bounded concurrent scheduling;
- live graph rendering and deterministic replay.

Hypagraph is not a hosted project-management platform, a repository knowledge graph, or an operating-system sandbox.

## Core concepts

### Workflow

A workflow is a versioned graph plus canonical runtime state.

Each Hypagoal owns one workflow. A future goal family composes separate workflow aggregates. It does not embed one complete workflow definition inside another workflow node.

### Node

A node is a bounded work contract containing intent, acceptance criteria, scope, required evidence, consumed and produced facts, runtime state, and attempt history.

Implemented node kinds are task, check, and gate. Approval and delegated execution remain planned.

A future child goal can be bound to an active task. The task waits for a validated child result. A check or gate cannot create a child goal.

### Edge

- `requires`: prerequisite relationship;
- `route`: branch selected by a gate;
- `data`: fact or artifact dependency;
- `feedback`: controlled edge inside a declared loop region;
- `child-return`: future validated return from a child goal to its parent task.

The future child-return relationship is a family-level binding. It does not make the child workflow part of the parent workflow definition.

### Facts and gates

Checks publish typed immutable facts. Gates evaluate deterministic typed conditions over those facts and workflow metadata.

Strict completion cannot depend solely on model judgement.

Public fact names use lowercase dotted paths and kebab-case multiword segments. Each fact has one declared producer and a matching type contract.

### Deterministic checks

Implemented check kinds are:

- `command`: bounded process execution without a shell;
- `test-report`: declared Vitest JSON output;
- `lint-report`: declared ESLint JSON output;
- `coverage-report`: declared Istanbul coverage summary;
- `metric-report`: declared scalar evaluator output;
- `file-assertion`: bounded workspace-contained file properties;
- `git-assertion`: fixed-allowlist repository-state queries.

A valid assertion that evaluates to false is a failed check. Invalid input or evaluator failure is an error.

Reports and assertion observations remain evidence. They do not mutate canonical state directly.

### Loop regions

A loop is a first-class bounded iteration region containing normal task, check, and gate nodes.

The node contracts define what the region does. Hypagraph does not encode repair as a loop type or implicit purpose.

Every cyclic strongly connected component must be explicitly declared. A loop defines entry and evaluation points, feedback edges, typed success, optional numeric progress, patience, hard limits, evaluation policy, and failure policy.

A loop can model refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

### Independent loop regions

A loop can connect to the wider graph or form a disconnected top-level component.

Facts, routes, attempts, iteration counters, progress values, validity, and exit decisions from one loop cannot change another loop without an explicit graph dependency.

Creation or execution of a child goal in another component must not pause, reset, release, fail, or complete an independent loop.

### Trusted evaluation contracts

M5A controls how a workflow obtains and trusts numeric progress observations.

A metric evaluator can declare:

- purpose: development, probe, or holdout;
- feedback: aggregate or bounded diagnostics;
- total and per-purpose budgets;
- typed validity;
- protected file and Git instruments;
- evaluator version and fingerprint;
- trust: transparent, protected, or isolated;
- evaluator adapter transport.

Success, progress, validity, purpose, trust, and transport remain separate concepts.

An invalid observation cannot complete a loop, update accepted progress, replace the best result, or alter patience.

Evaluation budget is consumed when the external evaluator starts, including failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts.

Protected evaluator output remains protected evidence. Normal Pi output does not expose protected commands, paths, hashes, raw reports, stdout, stderr, or raw Git output.

Protected local evaluation proves declared artifact integrity. It does not provide answer secrecy. Only isolated execution can support trusted holdout acceptance.

### Hypagoal

A Hypagoal is durable continuation control for one canonical workflow.

The workflow remains the executable goal contract. Workflow state determines completion, failure, cancellation, and blockage. A model cannot mark a goal complete.

M5B Slice 1 implements the workflow-local `GoalRuntime`, commands, events, replay, restore validation, and workflow-derived terminal projection.

M5B Slice 2 implements atomic root creation through `/hypagoal` and `hypagoal_start`. It preserves the exact prose objective, persists definition, initial readiness, and goal start in one event batch, requires state-bound replacement confirmation, and does not queue continuation during creation.

M5B Slice 3 implements pure graph-aware continuation decisions, event-backed component selection, one state-bound Pi follow-up, stale-delivery rejection, user-message priority, and deterministic interleaving across disconnected branches and independent loop components.

M5B Slice 4 implements workflow-local substantive-turn and token budgets, exactly-once charging against durable continuation identity, deterministic budget-limited stops, reload and branch-change pause, invalid-usage pause, and explicit resume.

M5B Slice 5 implements canonical loop and trusted-evaluation continuation guidance, protected model-visible evaluator redaction, explicit validity and typed-success separation, fair independent-component continuation, stale loop-delivery protection, and realistic multi-iteration automatic execution.

M5B Slice 6 implements deterministic canonical blocker classification, one durable automatic revision allowance, state-bound proposal identity, byte-exact objective preservation, non-weakening validation, existing-reducer revision and invalidation, exact revision-turn accounting, stale and interrupted exhaustion, and reload-safe pause.

The v0.6 product supports one root Hypagoal in one Pi session.

### Goal family

A goal family is the planned aggregate which coordinates a root goal and bounded descendant goals.

Each member retains its own workflow-local `GoalRuntime` and `HypagraphState`.

One family controller owns scheduling and canonical writes. A child goal does not own a competing controller.

Creating a child goal waits only the invoking parent task. Unrelated branches and independent loops remain runnable.

The first root-only goal must migrate into a one-member family without changing its workflow event history or snapshot hash.

### Scheduler

The scheduler selects runnable actions from canonical state.

The v0.6 scheduler queues at most one Pi continuation.

The future family scheduler sees runnable work across root workflows, child workflows, independent branches, and loop regions. It can dispatch compatible work concurrently through isolated executors.

Only the scheduler can dispatch work. A model, child goal, loop, or executor cannot enqueue autonomous execution directly.

### Executor

An executor performs one selected node attempt. It does not define a child goal and it does not mutate canonical state.

The executor receives a bounded context envelope and returns a structured result envelope. The controller validates the result before it commits events.

The first model executor will use an isolated Pi RPC process. Later adapters can use ACP or named CLI agents behind the same contract.

### Context envelope

Context is derived from canonical graph and family state.

The envelope contains explicit identity, objective, ancestry, node contract, scope, selected facts, artifacts, evidence, predecessor summaries, workspace lease, budget, and result protocol.

A persisted executor session is optional continuity. It is not canonical context. Recovery must remain possible when that session is lost.

### Workspace lease and integration

A mutating isolated attempt uses one git worktree and one workspace lease by default.

Execution success and integration success are separate states.

The controller validates scope and evidence, integrates the worker commit, records conflicts explicitly, runs post-integration checks in the base workspace, and completes the node only after integration succeeds.

## Runtime invariants

1. Only the controller mutates canonical graph or family state.
2. A node cannot start until dependencies and routes permit it.
3. Completion requires declared evidence and verification.
4. Undeclared cycles are rejected.
5. Revisions invalidate changed work and affected downstream nodes.
6. Stale or cancelled attempts cannot transition current state.
7. External effects start only after their start event is durable.
8. Parsers and assertions publish only declared type-correct facts.
9. Restore and replay do not repeat completed external effects.
10. A loop has no implicit repair semantics.
11. An independent loop cannot release, fail, reset, or pause an unrelated component.
12. Loop failure and workflow failure are separate policy decisions.
13. Success, progress, validity, purpose, trust, and transport remain separate.
14. An invalid evaluation cannot update progress or complete a loop.
15. Evaluation budgets are event-backed and consumed before evaluator effects.
16. Protected evaluator information cannot enter model-visible output.
17. Workflow state is authoritative for workflow-local goal terminal state.
18. A child goal cannot complete its parent task directly.
19. Child creation waits only its invoking parent task.
20. One family scheduler owns dispatch across all member workflows.
21. An executor cannot select graph transitions or mutate canonical state.
22. Context passed to an executor is explicit and reproducible.
23. Delegated mutation remains inside its workspace lease.
24. Execution success does not imply integration success.
25. Conflicting leases cannot run concurrently.
26. Descendant usage is charged to the root family budget.
27. Replay reproduces validity, integrity, progress, goal, scheduler, child-return, and stop decisions.

## Current implementation

The implementation provides:

- graph definition and validation;
- automatic graph and evaluation-contract authoring guidance;
- deterministic authoring advisories;
- dependency-derived readiness;
- task, check, and gate nodes;
- typed facts and deterministic routes;
- command, report, metric, file, and Git checks;
- bounded artifacts and parser registries;
- cancellation and retry policy;
- append-only event persistence and deterministic replay;
- exact loop-region validation;
- hard iteration limits, numeric progress, best-result tracking, and patience;
- invalid-evaluation limits and event-backed evaluation budgets;
- aggregate and bounded-diagnostic evaluator feedback;
- protected evaluator output filtering;
- SHA-256 and Git evaluator integrity instruments;
- cancellation and bounded integrity deadlines;
- evaluator versions, fingerprints, and coarse integrity observations;
- transport-neutral evaluator adapters;
- accurate purpose, trust, claim, adapter, and integrity presentation;
- downstream invalidation and stale-result rejection;
- branch-aware restoration;
- guided and strict scope enforcement;
- live Pi graph and loop surfaces;
- complete M5A product-path dogfood;
- workflow-local Hypagoal lifecycle;
- goal commands and events;
- workflow-derived goal completion, failure, blockage, cancellation, and pause;
- goal replay, restore validation, hashing, and UI summaries;
- atomic root Hypagoal creation from ordinary prose;
- typed stale-safe root replacement;
- explicit creation and correlation identity;
- creation and restore without autonomous continuation;
- pure graph-aware root continuation decisions;
- durable state-bound continuation requests;
- deterministic component selection and independent-loop fairness;
- stale continuation delivery rejection and user-message priority;
- workflow-local substantive-turn and token budgets;
- normalized Pi token usage with cache-read and cache-write accounting;
- exactly-once turn charging;
- deterministic budget-limited stop state;
- reload and branch-change pause without restore-time dispatch;
- explicit resume with budget and runnable-state validation;
- canonical loop and evaluation continuation guidance;
- separate validity, current metric, best metric, and typed-success presentation;
- protected evaluator redaction in model-visible state and check output;
- fair continuation across independent bounded regions;
- stale loop-continuation rejection;
- realistic multi-iteration automatic continuation with invalid-result rejection and typed success;
- deterministic canonical blocker classification;
- one durable bounded automatic revision allowance;
- byte-exact objective and non-weakening revision validation;
- accepted revision through the existing invalidation reducer;
- stale, rejected, malformed, interrupted, no-op, weakening, and still-blocked revision exhaustion;
- exact revision-turn and token accounting;
- reload and branch-change pause without revision dispatch;
- realistic positive and negative bounded-revision smoke evidence.

M5A is complete. Its evidence is in `docs/m5a-dogfood.md`.

M5B Slices 1, 2, 3, 4, 5, and 6 are complete in PRs #62, #65, #67, #69, #71, and #73. Slice 7, complete Pi product surface, is the current implementation target.

## Delivery sequence

1. M4 bounded iteration regions — complete.
2. M3.1 deterministic parser and assertion adapters — complete.
3. M5A trusted evaluation contracts — complete.
4. M5B root Hypagoal autonomous controller — active; Slices 1, 2, 3, 4, 5, and 6 complete.
5. M6 event history, replay, and debugger UI.
6. M7 goal families, bounded child Hypagoals, executor abstraction, and isolated Pi execution.
7. M8 worktree integration and bounded concurrent scheduling.
8. M9 ACP and named direct agent adapters.
9. Hardened v1.0 execution kernel.

The detailed M7 and M8 architecture is in `docs/goal-family-and-concurrent-execution-plan.md` and `docs/delegation-and-visualisation.md`.

## Validation baseline

CI #1012 and final PR CI #1014 pass:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 93 test files and 441 tests.
