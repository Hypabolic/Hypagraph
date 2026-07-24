# Hypagraph product and technical specification

- Status: active
- Version: implementation baseline through completed M5A trusted evaluation contracts
- Current baseline: `9d529e2cc549c5d2508a190b267a07361f302659`
- Delivery: independent Pi package, designed to support additional agent runtimes

## Executive decision

Hypagraph is an in-session control layer in which coding work becomes an executable directed graph instead of a flat todo list.

The graph makes these concerns executable rather than advisory:

1. dependency order;
2. logical gates and branch selection;
3. evidence-backed completion;
4. bounded iteration regions;
5. deterministic evaluation and progress control;
6. durable recovery and replay.

Models inspect repositories, author graphs, and perform task work. The deterministic controller validates definitions, scopes, transitions, evidence, check contracts, gate decisions, loop boundaries, evaluation contracts, and revisions.

## Product thesis

Flat plans encode sequence but not dependency, hide blocked states, accept narrative completion claims, and handle repeated work through unstructured replanning.

Hypagraph represents work as bounded node contracts connected by dependency, route, data, and feedback edges. It turns ordinary user intent into the smallest useful executable graph. The user does not need to design graph structure or use graph terminology.

## Product boundary

Hypagraph supports:

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
- live graph rendering and deterministic replay.

Hypagraph is not a hosted project-management platform, a repository knowledge graph, or an operating-system sandbox.

## Core concepts

### Workflow

A workflow is a versioned graph plus canonical runtime state.

### Node

A node is a bounded work contract containing intent, acceptance criteria, scope, required evidence, consumed and produced facts, runtime state, and attempt history.

Implemented node kinds are task, check, and gate. Approval and delegated execution remain planned.

### Edge

- `requires`: prerequisite relationship;
- `route`: branch selected by a gate;
- `data`: fact or artifact dependency;
- `feedback`: controlled edge inside a declared loop region.

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

## Runtime invariants

1. Only the controller mutates canonical graph state.
2. A node cannot start until dependencies and routes permit it.
3. Completion requires declared evidence and verification.
4. Undeclared cycles are rejected.
5. Revisions invalidate changed work and affected downstream nodes.
6. Stale or cancelled attempts cannot transition current state.
7. External effects start only after their start event is durable.
8. Parsers and assertions publish only declared type-correct facts.
9. Restore and replay do not repeat completed external effects.
10. A loop has no implicit repair semantics.
11. An independent loop cannot release, fail, or reset an unrelated component.
12. Loop failure and workflow failure are separate policy decisions.
13. Success, progress, validity, purpose, trust, and transport remain separate.
14. An invalid evaluation cannot update progress or complete a loop.
15. Evaluation budgets are event-backed and consumed before evaluator effects.
16. Protected evaluator information cannot enter model-visible output.
17. Replay reproduces the same validity, integrity, progress, and stop decisions.

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
- complete M5A product-path dogfood.

M5A is complete. Its evidence is in `docs/m5a-dogfood.md`.

Planned work includes M5B Hypagoal, delegated execution, worktree leases, production isolated evaluation, ACP integration, and bounded parallel scheduling.

## Delivery sequence

1. M4 bounded iteration regions — complete.
2. M3.1 deterministic parser and assertion adapters — complete.
3. M5A trusted evaluation contracts — complete through PR #60 and `docs/m5a-dogfood.md`.
4. M5B Hypagoal autonomous controller.
5. Event history, replay, and debugger UI.
6. Executor abstraction and production isolated evaluation.
7. Workspace integration and bounded concurrency.
8. ACP and direct agent adapters.
9. Hardened v1.0 execution kernel.

## Validation baseline

CI #621 passes:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 79 test files and 300 tests.
