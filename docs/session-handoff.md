# Session handoff: M5A Slice 3 to Slice 4

- Handoff date: 2026-07-23
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Implementation baseline before this handoff commit: `daed39beafb9c8ef5277a3c0350f4e3ef30aca11`
- Last merged pull request: #54
- Active milestone: M5A trusted evaluation contracts
- Next slice: M5A Slice 4, evaluator integrity checks
- Tracking issue: #30
- Writing method: ASD-STE100 Simplified Technical English

## 1. Purpose

This document gives another session enough context to continue the current work without repeating prior analysis.

Read this document before you change code.

Also read these files:

- `AGENTS.md`;
- `docs/trusted-evaluation-contract-plan.md`;
- `docs/hypagoal-vertical-slice-plan.md`;
- `docs/loop-region-product-model.md`;
- `docs/m4-vertical-slice-plan.md`.

Use issue #30 as the authoritative checklist for M5A.

Use issue #25 as the authoritative checklist for Hypagoal.

## 2. Current repository state

PR #54 is merged into `main`.

The merge commit is:

```text
daed39beafb9c8ef5277a3c0350f4e3ef30aca11
```

The final product commit in PR #54 is:

```text
2f3de2f30625ecc8b43bc4954577f38bf0bf5ca0
```

CI run #556 passed on all supported targets:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

The suite contains 71 test files and 271 tests.

The package version is still `0.5.0`.

Run this command for the complete local check:

```bash
npm ci
npm run check
```

`npm run check` runs TypeScript validation and the complete Vitest suite.

## 3. Important release warning

Issue #23 is still open because the `v0.5.0` Git tag has not been created.

The correct v0.5 release commit is:

```text
88ec3950bcbc07ce7148d940d0c65f6b176f3bc9
```

Do not tag current `main` as `v0.5.0`.

M3.1 and M5A changes are later than the intended v0.5 release commit.

When tag creation is available, create `v0.5.0` at the exact commit above. Then close issue #23.

This release administration task is separate from M5A implementation.

## 4. Product decisions that must not change

### 4.1 Hypagraph is the canonical workflow model

Hypagraph has one executable workflow graph.

Do not create a second goal model.

Hypagoal must control one canonical Hypagraph workflow.

The runtime must derive completion from canonical workflow state.

A model must not mark a goal complete directly.

### 4.2 A loop is a generic bounded iteration region

A loop is not a repair loop type.

Repair is one possible use.

The same loop model supports:

- refinement;
- optimization;
- search;
- batch processing;
- repeated evaluation;
- reconciliation;
- polling;
- migration;
- repair.

A loop can connect to the wider graph.

A loop can also be an independent top-level graph component.

Each loop has an explicit failure policy.

### 4.3 The reducer must remain deterministic

The reducer must not:

- run a command;
- read a file;
- inspect Git;
- read the clock;
- generate a random value;
- call a model;
- access the network;
- calculate a semantic score.

External executors and deterministic parsers produce observations.

The reducer validates commands and applies events.

Replay must reproduce the same state and stop decisions.

### 4.4 Success, progress, and evaluation validity are separate

Success answers whether a loop can complete.

Progress answers whether a valid observation is better than the best prior valid observation.

Evaluation validity answers whether the runtime can use an observation as an honest measurement.

A numeric score can be invalid.

An invalid score must not:

- complete a loop;
- replace the best metric;
- replace the best iteration;
- reset patience.

### 4.5 Evaluation purpose and trust level are different concepts

The current evaluation kinds are:

- `development`;
- `probe`;
- `holdout`.

These values describe evaluation purpose.

The planned trust levels are:

- `transparent`;
- `protected`;
- `isolated`.

These values describe the evaluator boundary.

Do not use evaluation kind as a trust level.

A local protected evaluator does not provide answer secrecy.

Only an isolated evaluator can support a strong trusted holdout claim.

The isolated evaluator adapter is Slice 6 work.

## 5. Completed milestones

### 5.1 M4 bounded iteration regions

M4 is functionally complete.

It includes:

- typed loop success conditions;
- multiple iterations;
- feedback edges;
- hard iteration limits;
- numeric progress in minimize or maximize mode;
- strict minimum improvement;
- best metric and best iteration;
- patience and `no_progress` termination;
- explicit loop failure policies;
- independent loop regions;
- cancellation and interruption recovery;
- revision invalidation;
- stale-result rejection;
- optimistic sequence conflict handling;
- restore and replay validation;
- Pi and graph surfaces;
- dogfood evidence.

### 5.2 M3.1 deterministic parser and assertion adapters

M3.1 is complete.

It includes:

- Vitest JSON parsing;
- ESLint JSON parsing;
- Istanbul coverage-summary parsing;
- `command` checks;
- `test-report` checks;
- `lint-report` checks;
- `coverage-report` checks;
- `file-assertion` checks;
- `git-assertion` checks;
- canonical namespaced facts;
- Pi authoring schemas;
- replay-safe check lifecycle behavior.

The existing assertion primitives are important for M5A Slice 4.

### 5.3 M5A Slice 1: metric reports

PR #52 added:

- the first-class `metric-report` check;
- the versioned `metric-json` parser;
- explicit scalar mappings;
- finite-number validation;
- report-size limits;
- workspace-contained report reads;
- raw report evidence;
- complete fact-contract validation;
- Pi result formatting;
- loop progress integration;
- replay tests.

### 5.4 M5A Slice 2: evaluation validity

PR #53 added the loop evaluation policy:

```ts
evaluation: {
  validWhen: Condition;
  maximumInvalidEvaluations: number;
}
```

It also added:

- validity facts used;
- invalid evaluation counters;
- the `invalid_evaluations` exit reason;
- best-metric protection after an invalid result;
- patience protection after an invalid result;
- replay-safe validity decisions;
- graph and Pi validity status.

### 5.5 M5A Slice 3: feedback and evaluation budgets

PR #54 added evaluator feedback policies and evaluation budgets.

A metric evaluator can declare:

```ts
evaluation: {
  kind: "development" | "probe" | "holdout";
  feedback: {
    mode: "aggregate" | "bounded-diagnostics";
    maximumDiagnosticItems?: number;
    exposeRawReport?: boolean;
  };
}
```

A workflow can declare:

```ts
evaluation: {
  budget: {
    maximumEvaluations?: number;
    maximumDevelopmentEvaluations?: number;
    maximumProbeEvaluations?: number;
    maximumHoldoutEvaluations?: number;
  };
}
```

The runtime now emits `hypagraph.evaluation.started` before `hypagraph.check.started` for a metric evaluator.

An evaluation consumes budget when the external evaluator starts.

These outcomes consume budget:

- passed;
- failed;
- invalid;
- timed out;
- cancelled;
- interrupted;
- executor error;
- retry.

The runtime tracks:

- total evaluations;
- development evaluations;
- probe evaluations;
- holdout evaluations.

The counters are event-backed and replayable.

A new evaluation start is rejected when the total limit or the relevant kind limit is exhausted.

A bounded loop stops with `evaluation_budget` when it cannot start another required evaluation.

Aggregate feedback exposes mapped scalar facts only.

Bounded-diagnostic feedback exposes a declared maximum number of validated diagnostic items.

Raw reports, standard output, and standard error are protected by default for an evaluator with a feedback policy.

Protected evidence remains available for audit.

Protected evidence does not enter public fact evidence.

Pi redacts protected evaluator commands and protected artifact references.

A holdout evaluator must use aggregate feedback.

A holdout evaluator cannot expose the raw report publicly.

## 6. Current code map

### 6.1 Domain model

`src/domain/model.ts` contains:

- `MetricReportCheckDefinition`;
- `MetricEvaluationDefinition`;
- `EvaluationKind`;
- `EvaluationFeedbackPolicy`;
- `EvaluationBudgetDefinition`;
- `EvaluationRuntime`;
- `LoopEvaluationDefinition`;
- `LoopExitReason`;
- `hypagraph.evaluation.started` in `EventType`.

The schema version is 3.

A schema change must include migration behavior or an explicit rejection path.

### 6.2 Evaluation budget policy

`src/domain/evaluation-policy.ts` contains:

- `metricEvaluationKind`;
- `evaluationBudgetStatus`;
- `evaluationStartDiagnostic`;
- `evaluationBudgetExhaustedForKind`.

This file is a suitable location for budget logic only.

Create a separate integrity policy module if integrity logic becomes substantial.

Do not combine unrelated policy concepts in one helper.

### 6.3 Reducer

`src/domain/reducer.ts` is the canonical decision point.

Important seams are:

- `start-check`, which validates budget and emits `hypagraph.evaluation.started`;
- `record-check-result`, which stores the normalized executor result;
- `publish-facts`, which validates fact contracts;
- `complete-verification`, which calls `prepareLoopEvaluation`;
- `prepareLoopEvaluation`, which applies validity, success, progress, best-result, and patience semantics;
- the exit-reason selection, which includes `evaluation_budget`.

A Slice 4 integrity failure must become effective before `prepareLoopEvaluation` can promote the score to progress state.

### 6.4 Projection and replay

`src/domain/projection.ts` projects:

- evaluation counters from `hypagraph.evaluation.started`;
- loop evaluation records;
- validity state;
- progress state;
- terminal loop state.

Any new persisted integrity state must be reconstructable from events.

Do not depend on transient executor memory during restore.

### 6.5 Durable check lifecycle

`src/checks/durable-lifecycle.ts` uses this sequence:

1. Commit `start-check`.
2. Execute the external check.
3. Normalize and publish facts.
4. Record the check result.
5. Begin verification.
6. Complete verification.
7. Commit the verification event batch.

This ordering is important for Slice 4.

An integrity observation can publish facts before verification.

The runtime must still prevent an integrity-invalid score from changing progress state.

### 6.6 Metric report execution

The principal files are:

- `src/checks/metric-report-parser.ts`;
- `src/checks/report-parser-registry.ts`;
- `src/checks/report-check-executor.ts`;
- `src/checks/normalization.ts`;
- `src/checks/execution.ts`.

Do not create a second metric execution path.

Extend the existing report check path.

### 6.7 Existing file and Git assertions

`src/checks/file-assertion.ts` already supports:

- file existence;
- file absence;
- exact size;
- SHA-256 hash;
- bounded text containment.

The SHA-256 assertion is workspace-contained and size-bounded.

`src/checks/git-assertion.ts` already supports:

- clean worktree;
- branch identity;
- revision identity;
- changed-path sets in `exact` or `contains` mode.

Reuse these deterministic primitives where their semantics match the integrity requirement.

Do not misuse `changed-paths` to mean that protected paths are unchanged.

Add a new assertion semantic when the existing semantic is not exact enough.

### 6.8 Authoring and product surfaces

The principal files are:

- `src/pi/definition.ts`;
- `src/pi/check-runner.ts`;
- `src/graph/projection.ts`;
- `src/ui/loop-surface.ts`.

`src/pi/check-runner.ts` currently redacts a protected evaluator command with this text:

```text
Command: protected evaluator command
```

Keep this protection when Slice 4 adds integrity diagnostics and version evidence.

Do not expose a protected hash source, expected answer, hidden path content, or hidden evaluator argument in normal Pi output.

## 7. Next task: M5A Slice 4

The next task is evaluator integrity checks.

The plan defines this result:

> A changed protected evaluator artifact voids the score before progress state changes.

Slice 4 must add:

- protected-path declarations;
- hash and Git assertion integration;
- evaluator version facts;
- invalidation after evaluator changes;
- strict acceptance rules;
- integrity diagnostics.

## 8. Required Slice 4 semantics

### 8.1 Integrity must be a runtime rule

Do not depend only on author-written `validWhen` conditions.

A workflow author must not be able to forget the integrity condition and still promote a changed evaluator score.

The runtime must make an integrity-invalid observation unusable for progress and success.

A user condition can add more validity requirements.

It must not weaken evaluator integrity.

### 8.2 Integrity failure still consumes budget

The evaluator already started.

Therefore an integrity-invalid result consumes an evaluation attempt.

The result can be recorded for audit.

The score can remain present as an observed fact.

The score must not become accepted progress.

### 8.3 Integrity must be checked before score acceptance

The external check layer can inspect files and Git.

The reducer cannot inspect files or Git.

The external layer must return a deterministic integrity observation.

The reducer must validate and apply that observation before it updates:

- current accepted metric;
- best metric;
- best iteration;
- patience;
- loop completion.

### 8.4 Evaluator version evidence must not be self-reported only

Do not trust an unverified version string from the evaluator report as the only version evidence.

Prefer a version value that is declared by the contract or derived from protected artifacts.

Store the observed version or fingerprint as typed evidence.

### 8.5 Trust labels must be accurate

`development`, `probe`, and `holdout` are not trust levels.

Slice 4 must not label a local protected evaluator as isolated.

Slice 4 can provide transparent and protected integrity semantics.

Strong isolated holdout semantics remain unavailable until Slice 6 provides the evaluator adapter boundary.

### 8.6 Read protection is out of scope

A local model or process can read a local file unless the execution boundary prevents it.

Path write protection does not provide answer secrecy.

Do not claim that protected local files are secret holdout data.

## 9. Recommended Slice 4 implementation path

This section is implementation guidance.

The final public schema can change if tests show that another shape is safer.

### 9.1 Add an explicit integrity definition

Extend metric evaluation with an explicit integrity contract.

Keep evaluation purpose separate from trust level.

A possible semantic shape is:

```ts
type EvaluatorTrustLevel = "transparent" | "protected" | "isolated";

interface EvaluationIntegrityDefinition {
  trustLevel: EvaluatorTrustLevel;
  protectedPaths?: ProtectedPathDefinition[];
  evaluatorVersion?: string;
  git?: EvaluationGitIntegrityDefinition;
}
```

Do not accept this example without validation design.

Each protected path needs a stable expected value or a stable Git reference.

A path name without an expected state does not prove integrity.

The first implementation can support file SHA-256 and Git-based constraints only.

### 9.2 Add deterministic external integrity evaluation

Add a focused module such as:

```text
src/checks/evaluation-integrity.ts
```

This module can reuse:

- `evaluateFileAssertion`;
- `evaluateGitAssertion`.

It must return a normalized result with:

- overall integrity validity;
- stable diagnostic codes;
- observed evaluator version or fingerprint;
- protected evidence references;
- no hidden file content.

Keep path ordering deterministic.

Keep diagnostic ordering deterministic.

Use fixed limits for file hashing and Git output.

### 9.3 Extend the existing metric executor path

Do not add a parallel evaluator runtime.

Extend `report-check-executor.ts` or the shared report execution path.

The metric executor result can include a normalized integrity section.

The durable lifecycle must persist enough data to replay the same acceptance decision.

### 9.4 Enforce integrity during verification

The final check verification decision must include integrity validity.

The loop evaluation decision must combine:

1. executor and parser validity;
2. evaluator integrity validity;
3. the existing typed `validWhen` condition;
4. typed success;
5. numeric progress.

Do not merge these concepts into one undocumented Boolean.

Store the facts and reason codes that support the final decision.

### 9.5 Add strict validation

Validation must reject:

- empty protected paths;
- absolute paths;
- paths outside the workspace;
- duplicate protected paths;
- invalid SHA-256 values;
- invalid size limits;
- a protected trust claim with no integrity instrument;
- an isolated trust claim without isolated adapter evidence;
- a strong holdout claim without isolated trust;
- public raw report exposure when the policy forbids it;
- incompatible Git integrity declarations;
- evaluator version facts without a declared fact contract.

Use stable diagnostic codes.

### 9.6 Add event and projection support only when required

Prefer existing event data when it can reproduce the decision without ambiguity.

Add a new event when integrity needs a distinct audit record.

Possible event semantics include:

```text
hypagraph.evaluation.integrity-recorded
```

Do not add a new event only for display convenience.

If a new event is added, update:

- `EventType`;
- reducer emission;
- projection;
- restore validation;
- replay fixtures;
- graph projection;
- Pi status;
- schema compatibility behavior.

### 9.7 Add product status

The Pi and graph surfaces must show:

- evaluator purpose;
- trust level;
- evaluator version or fingerprint;
- integrity status;
- a coarse integrity diagnostic code;
- protected evidence state.

Normal model-visible output must not show:

- protected file contents;
- hidden expected results;
- protected command arguments;
- raw Git output that exposes protected paths more than the contract permits.

## 10. Required Slice 4 tests

Add focused tests before broad integration work.

The tests must prove these cases.

### 10.1 Protected file integrity

- A matching protected file hash permits a valid score.
- A changed protected file invalidates the score.
- A missing protected file invalidates the score.
- An oversized protected file fails safely.
- A path outside the workspace is rejected.
- Duplicate protected paths are rejected.

### 10.2 Git integrity

- A matching Git revision permits the declared integrity result.
- A revision mismatch invalidates the score.
- A protected-path change invalidates the score.
- An unrelated permitted change does not invalidate the score when policy permits it.
- Windows and POSIX path separators produce the same canonical result.

### 10.3 Progress protection

- An integrity-invalid numeric score does not update the best metric.
- An integrity-invalid numeric score does not update the best iteration.
- An integrity-invalid numeric score does not reset patience.
- An integrity-invalid success result does not complete the loop.
- An integrity-invalid result counts against the evaluation budget.
- An integrity-invalid result counts against the invalid-evaluation limit when that policy applies.

### 10.4 Replay and restore

- Replay reproduces the same integrity result.
- Replay reproduces the same score-validity decision.
- Replay reproduces the same best metric.
- Replay reproduces the same stop reason.
- Restore does not rerun the evaluator or integrity check.
- A stale integrity result cannot affect a newer attempt.

### 10.5 Information control

- Protected integrity evidence does not enter public fact evidence.
- Pi does not print protected command arguments.
- Pi does not print hidden file content.
- Pi uses stable coarse diagnostics.
- A transparent evaluator is not presented as a trusted holdout evaluator.
- A protected evaluator is not presented as an isolated evaluator.

### 10.6 Compatibility

- A metric report without an integrity declaration keeps current behavior.
- A workflow without an evaluation contract keeps current behavior.
- Existing Slice 1, Slice 2, and Slice 3 tests remain green.

## 11. Likely files for Slice 4

Expect to inspect or change these files:

- `src/domain/model.ts`;
- `src/domain/validate.ts`;
- `src/domain/reducer.ts`;
- `src/domain/projection.ts`;
- `src/domain/evaluation-policy.ts` or a new integrity policy module;
- `src/checks/evaluation-integrity.ts` as a possible new module;
- `src/checks/file-assertion.ts`;
- `src/checks/git-assertion.ts`;
- `src/checks/report-check-executor.ts`;
- `src/checks/normalization.ts`;
- `src/checks/durable-lifecycle.ts`;
- `src/pi/definition.ts`;
- `src/pi/check-runner.ts`;
- `src/graph/projection.ts`;
- `src/ui/loop-surface.ts`;
- new focused tests under `tests/`.

Do not change all files without a clear need.

Keep each change inside the vertical slice.

## 12. Known implementation hazards

### 12.1 TypeBox discriminant inference

Slice 3 found TypeScript inference problems when `StringEnum` was used for new discriminated literal types.

Use explicit TypeBox literal unions when the static type must remain narrow.

Example:

```ts
Type.Union([
  Type.Literal("transparent"),
  Type.Literal("protected"),
  Type.Literal("isolated"),
])
```

Do not allow the generated static type to widen to `string`.

### 12.2 Protected command output

Slice 3 found that Pi printed the full evaluator command even when evaluator artifacts were protected.

The final fix is in `src/pi/check-runner.ts`.

Keep that regression test.

Review every new display field for information leakage.

### 12.3 Event ordering

`hypagraph.evaluation.started` must remain before `hypagraph.check.started`.

This order records budget consumption before the external evaluator side effect.

Do not move budget consumption to result acceptance.

### 12.4 Temporary workflow files

Do not commit temporary source-export or patch-application workflows to the final pull request.

GitHub recursion protection can suppress automation-created workflow triggers.

Prefer a normal local branch and direct Git push when available.

If a connector performs repository writes, keep the final diff free of temporary workflows and staged patch files.

### 12.5 Integrity time-of-check and time-of-use

A preflight check alone can be insufficient.

An evaluator artifact can change after preflight and before score acceptance.

The Slice 4 design must define the protected state that applies to the accepted result.

The safest minimum is to compare the observed protected state at result time with a declared expected state.

If the design records a start fingerprint and an end fingerprint, both observations must be event-backed or included in persisted result evidence.

## 13. Work sequence for the next session

Use this order.

1. Verify that `main` contains merge commit `daed39beafb9c8ef5277a3c0350f4e3ef30aca11` or a later commit.
2. Read `AGENTS.md`.
3. Read this handoff document.
4. Read Slice 4 in `docs/trusted-evaluation-contract-plan.md`.
5. Read issue #30.
6. Inspect the existing file and Git assertion primitives.
7. Write the Slice 4 domain contract and invariant tests first.
8. Decide the exact persisted integrity observation shape.
9. Implement the external integrity evaluator.
10. Integrate it with the existing metric report lifecycle.
11. Enforce integrity before progress state changes.
12. Add replay and restore tests.
13. Add Pi and graph status.
14. Run `npm run check`.
15. Open a pull request that relates to issue #30.
16. Run the six-target CI matrix.
17. Fix all failures.
18. Update issue #30 only after CI is green.
19. Mark Slice 4 complete in issue #30.
20. Record the delivered contract and final test counts in issue #30.

A suitable branch name is:

```text
agent/m5a-slice-4-evaluator-integrity
```

A suitable pull request title is:

```text
Implement M5A evaluator integrity checks
```

## 14. Work after Slice 4

Do not start Hypagoal immediately after Slice 4.

Continue M5A in this order:

1. Slice 5: evaluation-contract authoring;
2. Slice 6: isolated evaluator adapter definition;
3. Slice 7: complete Pi product surface;
4. Slice 8: dogfood the evaluation contract.

After the required M5A slices are complete, start M5B Hypagoal from issue #25.

Hypagoal must use the canonical Hypagraph workflow.

Hypagoal must not add a second goal state machine.

## 15. Definition of a successful next handoff

The next handoff is ready when:

- Slice 4 is merged;
- issue #30 marks Slice 4 complete;
- protected evaluator changes invalidate a score before progress changes;
- replay reproduces the integrity decision;
- Pi shows accurate evaluator purpose, trust, version, and integrity status;
- protected data remains absent from model-visible output;
- the complete six-target CI matrix is green;
- this document is updated with the new baseline and the Slice 5 plan.
