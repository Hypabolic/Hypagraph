# Hypagraph product and technical specification

- Status: active
- Version: implementation baseline through M5A evaluator integrity
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

The graph kernel is deterministic. Models may inspect repositories, author graphs, and perform task work. The controller validates definitions, scopes, transitions, evidence, check contracts, gate decisions, loop boundaries, evaluation contracts, and revisions.

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
- trusted evaluation contracts with validity, feedback, budgets, and integrity;
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

A check is a normal graph node with a versioned definition and durable attempt lifecycle.

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

A loop is a first-class bounded iteration region. It contains normal task, check, and gate nodes.

The node contracts define what the region does. Hypagraph does not encode repair as a loop type or implicit purpose.

Every cyclic strongly connected component must be explicitly declared. A loop defines entry and evaluation points, feedback edges, typed success, optional numeric progress, patience, hard limits, evaluation policy, and failure policy.

A loop can model refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

### Independent loop regions

A loop can connect to the wider graph or form a disconnected top-level component.

Topological independence also provides state independence. Facts, routes, attempts, iteration counters, progress values, validity, and exit decisions from one loop cannot change another loop without an explicit graph dependency.

### Trusted evaluation contracts

M4 can compare progress values. M5A controls how a workflow obtains and trusts those values.

A metric evaluator can declare:

- evaluation purpose: development, probe, or holdout;
- feedback mode: aggregate or bounded diagnostics;
- total and per-purpose evaluation budgets;
- typed validity;
- protected file and Git integrity instruments;
- evaluator version and fingerprint;
- trust boundary: transparent, protected, or isolated.

Success, progress, validity, and trust remain separate concepts.

An invalid observation cannot complete a loop, update the accepted metric, replace the best result, or change patience.

Evaluation budget is consumed when the external evaluator starts, including failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts.

Protected evaluator output remains protected evidence. Normal Pi output does not expose protected commands, paths, hashes, raw reports, stdout, stderr, or raw Git output.

Protected local evaluation proves declared artifact integrity. It does not provide answer secrecy. Only isolated execution can support a strong trusted holdout claim.

## Runtime invariants

1. Only the controller mutates canonical graph state.
2. A node cannot start until dependencies and routing conditions are satisfied.
3. Completion requires declared evidence and verification.
4. Undeclared cycles are rejected.
5. Revisions invalidate changed work and affected downstream nodes.
6. Stale or cancelled attempts cannot transition current state.
7. External check effects start only after the check-start event is durable.
8. Parser and assertion results publish only declared type-correct facts.
9. Restore and replay do not repeat completed external effects.
10. A loop has no implicit repair semantics.
11. An independent loop cannot release, fail, or reset an unrelated component.
12. Loop failure and workflow failure are separate policy decisions.
13. Success, progress, evaluation validity, and evaluator trust remain separate.
14. An invalid evaluation cannot update progress or complete a loop.
15. Evaluation budgets are event-backed and consumed before evaluator side effects.
16. Protected evaluator information cannot enter model-visible output.
17. Replay must reproduce the same validity, integrity, progress, and stop decisions.

## Current implementation

The implementation provides:

- graph definition and validation;
- automatic graph authoring guidance;
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
- evaluator versions, fingerprints, and coarse integrity observations;
- downstream invalidation and stale-result rejection;
- branch-aware restoration;
- guided and strict scope enforcement;
- live Pi graph and loop surfaces.

Planned work includes evaluation-contract authoring, a transport-neutral evaluator adapter, Hypagoal, delegated execution, worktree leases, ACP integration, and bounded parallel scheduling.

## Delivery sequence

1. M4 bounded iteration regions. Complete.
2. M3.1 deterministic parser and assertion adapters. Complete.
3. M5A metric reports, validity, feedback, budgets, and integrity. Slices 1-4 complete; closeout in PR #56.
4. M5A evaluation authoring, adapter contract, product surface, and dogfood.
5. M5B Hypagoal autonomous controller.
6. Event debugger UI.
7. Executor abstraction and production isolated evaluation.
8. Workspace integration and bounded concurrency.
9. ACP and direct agent adapters.
10. Hardened v1.0 execution kernel.
