# Session handoff: M5A Slice 4 closeout to Slice 5

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `22aad1500af71d137ee4deab5ac92ba99d8b7437`
- Last merged pull request: #55
- Active implementation pull request: #56
- Active branch: `agent/m5a-slice-4-closeout`
- Active milestone: M5A trusted evaluation contracts
- Next feature slice: M5A Slice 5, evaluation-contract authoring
- Tracking issue: #30
- Hypagoal issue: #25

## 1. Read first

Read:

- `AGENTS.md`;
- `docs/trusted-evaluation-contract-plan.md`;
- `docs/hypagoal-vertical-slice-plan.md`;
- `docs/automatic-graph-authoring.md`;
- `docs/loop-region-product-model.md`;
- `docs/product-spec.md`.

Issue #30 is the authoritative M5A checklist.

Issue #25 is the authoritative M5B Hypagoal checklist.

## 2. Product decisions that must not change

### One canonical workflow

Hypagraph has one executable workflow graph.

Hypagoal must control that workflow. It must not add a second work model or let a model mark the goal complete.

### Generic bounded iteration

A loop is a generic bounded iteration region. Repair is one possible pattern.

The same model supports refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, and repair.

A loop can connect to the main graph or run as an independent top-level component. Each loop has explicit failure policy.

### Pure reducer

The reducer must not run commands, inspect files, invoke Git, read the clock, generate IDs, call a model, access the network, or calculate semantic scores.

External executors and deterministic parsers produce observations. The reducer validates commands and applies events.

### Separate success, progress, validity, and trust

Success controls completion.

Progress compares valid numeric observations.

Evaluation validity controls whether the runtime may use an observation.

Evaluator trust describes the boundary: transparent, protected, or isolated.

Evaluation purpose describes use: development, probe, or holdout.

Only isolated evaluation can support a strong trusted holdout claim.

## 3. Completed milestones

### M3.1 deterministic checks

Complete:

- command checks;
- Vitest, ESLint, and Istanbul report adapters;
- file assertions;
- Git assertions;
- canonical typed fact publication;
- durable lifecycle, retry, cancellation, restore, and replay.

### M4 bounded iteration regions

Complete:

- typed success conditions;
- multiple iterations;
- feedback edges;
- hard limits;
- numeric progress;
- best metric and best iteration;
- patience;
- explicit failure policies;
- independent loop components;
- cancellation and revision recovery;
- stale-result rejection;
- optimistic sequence conflicts;
- Pi and graph product surfaces;
- dogfood evidence.

### M5A Slice 1: metric reports

PR #52 added versioned scalar metric reports through the existing report executor.

### M5A Slice 2: evaluation validity

PR #53 added typed validity, invalid-observation counts, progress protection, and `invalid_evaluations` termination.

### M5A Slice 3: feedback and budgets

PR #54 added evaluation purpose, aggregate or bounded-diagnostic feedback, protected output, total and per-purpose event-backed budgets, and `evaluation_budget` termination.

### M5A Slice 4: evaluator integrity

PR #55 added:

- separate evaluator trust;
- SHA-256 protected paths;
- exact Git revision, clean-worktree, and protected-path constraints;
- declared evaluator version facts;
- versioned integrity observations;
- evaluator fingerprints;
- runtime-enforced integrity validity before success and progress;
- replay and restore validation;
- Pi, graph, and loop integrity status;
- protected-output redaction.

PR #56 closes the Slice 4 hardening gaps:

- evaluator integrity now receives the active `AbortSignal`;
- Git integrity subprocesses are cancellable;
- integrity work has a bounded deadline;
- cancellation and timeout produce stable coarse diagnostics;
- protected file instruments reject symbolic links;
- bounded reads use no-follow descriptor opens where supported;
- the opened file identity is verified before content is accepted;
- normalization-error paths retain required integrity observations;
- focused hardening tests cover cancellation, deadline expiry, and symbolic links.

## 4. Current code map

### Domain

- `src/domain/model.ts`: evaluation definitions and persisted observations.
- `src/domain/validate.ts`: authoring contract validation.
- `src/domain/integrity-policy.ts`: canonical protected paths and integrity-result validation.
- `src/domain/evaluation-policy.ts`: event-backed budget logic.
- `src/domain/reducer.ts`: canonical validity, success, progress, patience, and terminal decisions.
- `src/domain/projection.ts`: replay and runtime projection.

### Checks

- `src/checks/metric-report-parser.ts`: versioned metric JSON parser.
- `src/checks/report-check-executor.ts`: existing report execution path and integrity integration.
- `src/checks/evaluation-integrity.ts`: external deterministic integrity evaluation.
- `src/checks/file-assertion.ts`: bounded protected file reads.
- `src/checks/git-assertion.ts`: fixed-allowlist Git instruments.
- `src/checks/durable-lifecycle.ts`: persisted check lifecycle.

### Product surface

- `src/pi/definition.ts`: Pi authoring schema and normalization.
- `src/pi/check-runner.ts`: protected check result presentation.
- `src/graph/projection.ts`: evaluator summary projection.
- `src/ui/loop-surface.ts`: canonical loop and evaluation summary.

## 5. Current validation state

The last merged Slice 4 matrix passed on:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

PR #56 must pass the same six jobs before it is merged.

The repository-local validation command is:

```bash
npm ci
npm run check
```

Do not mark Slice 4 complete in issue #30 until PR #56 is green and merged.

## 6. Important release warning

Issue #23 remains open because tag creation was deferred.

The intended v0.5 release commit is:

```text
88ec3950bcbc07ce7148d940d0c65f6b176f3bc9
```

Do not tag current `main` as `v0.5.0`.

M3.1 and M5A commits are later than the intended v0.5 release baseline.

The v0.6 tag must wait until both M5A and M5B release evidence is green.

## 7. Next task: M5A Slice 5

The next feature slice is evaluation-contract authoring.

### User result

A user gives an ordinary optimization, refinement, or evaluation objective. The bundled skill builds the evaluation contract without requiring graph or metric-schema terminology.

### Required authoring sequence

1. Determine whether a defensible deterministic metric exists.
2. Define the target separately from successful completion.
3. Convert every enforceable constraint into an instrument and typed fact.
4. Select development, probe, or holdout purpose.
5. Select transparent, protected, or isolated trust.
6. Define typed evaluation validity.
7. Define progress direction and minimum improvement.
8. Define typed success.
9. Bound feedback and evaluation attempts.
10. Add probe or anti-gaming instruments when an obvious shortcut exists.

When no defensible metric exists, omit progress. Use typed checks, evidence, hard limits, explicit outcome policy, and user review.

### Required implementation

- extend `skills/hypagraph/SKILL.md`;
- extend `docs/automatic-graph-authoring.md`;
- add a pure evaluation-contract assessment or lint module;
- expose warnings through `hypagraph_define` results;
- warn about undeclared trust, local holdout claims, missing instruments, unbounded diagnostics, missing budgets, and unenforced textual constraints;
- add authoring fixtures for optimization, development plus probe, and a non-metric objective;
- add normalization and validation tests;
- run a real Pi authoring smoke test from prose.

### Done when

A prose objective produces typed score, validity, success, progress, feedback, budget, and accurate trust semantics, or deliberately produces a non-metric graph.

Suggested branch:

```text
agent/m5a-slice-5-evaluation-authoring
```

Suggested pull request title:

```text
Implement M5A evaluation-contract authoring
```

## 8. Work after Slice 5

Continue M5A in this order:

1. Slice 6: transport-neutral evaluator adapter.
2. Slice 7: complete evaluation product surface.
3. Slice 8: dogfood and close M5A.
4. Reconfirm issue #25 and begin M5B Slice 1.

Do not start M5B before the required M5A authoring contract is stable.

## 9. Known hazards

- TypeBox literal unions must remain narrow. Avoid widening discriminants to `string`.
- Every integrity result must remain replayable without file or Git access.
- Protected commands, paths, hashes, raw reports, stdout, stderr, and Git output must not enter model-visible messages.
- Evaluation budget is consumed before the external side effect starts.
- Connector-authored commits can suppress push-triggered Actions. Use the PR `ready_for_review` trigger when required.
- Temporary workflow files must not remain in the final diff.
- A protected local evaluator is not isolated and does not provide answer secrecy.

## 10. Successful next handoff

The next handoff is ready when:

- PR #56 is merged;
- issue #30 marks Slice 4 complete with final CI and test counts;
- Slice 5 is merged;
- prose authoring can produce or deliberately omit an evaluation contract;
- trust claims remain accurate;
- all six CI jobs pass;
- this file points to Slice 6.
