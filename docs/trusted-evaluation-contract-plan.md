# Trusted evaluation contracts and loss functions

- Status: complete
- Roadmap phase: M5A
- Completion date: 2026-07-24
- Final implementation baseline: `9d529e2cc549c5d2508a190b267a07361f302659`
- Final implementation pull request: #60
- Tracking issue: #30
- Dogfood record: `docs/m5a-dogfood.md`
- Release marker: v0.6 with M5B Hypagoal
- Prerequisites: M3 deterministic checks and M4 executable bounded iteration regions
- Research source: https://github.com/elvisun/loss-function-development

## 1. Purpose

M4 can compare typed numeric progress values. It cannot prove that a value is a trustworthy observation.

M5A adds a controlled evaluation contract around the existing M4 loop model. The contract defines:

- how an evaluator runs;
- how a versioned report becomes typed facts;
- when an observation is valid;
- what feedback the model can see;
- how many evaluation attempts can start;
- which evaluator artifacts are protected;
- which trust boundary applies;
- which typed condition controls acceptance.

The reducer consumes typed facts and persisted observations only. It does not run evaluators, inspect files, invoke Git, call a model, or calculate semantic scores.

The capability applies to optimization, refinement, search, repeated evaluation, reconciliation, migration, polling, and repair. Repair is not the default loop purpose.

## 2. Architectural decisions

### 2.1 Keep the M4 progress model

Hypagraph uses:

- one numeric progress fact;
- minimize or maximize direction;
- strict minimum improvement;
- best metric and best iteration;
- patience;
- hard iteration limits.

M5A does not add arbitrary JavaScript or TypeScript loss functions to the reducer.

### 2.2 Separate success, progress, validity, purpose, trust, and transport

Success answers whether a region may complete.

Progress answers whether a valid observation is better than the prior best observation.

Validity answers whether the runtime may use the observation.

Purpose is development, probe, or holdout.

Trust is transparent, protected, or isolated.

Transport is the evaluator adapter that obtains the report.

A numeric result can be invalid. An invalid result cannot:

- complete a loop;
- update the accepted metric;
- replace the best metric;
- replace the best iteration;
- reset or increment patience.

### 2.3 Keep trust labels accurate

A transparent evaluator can expose its logic and data.

A protected evaluator proves that declared local evaluator artifacts did not change. It does not hide readable answers from a model or process in the same workspace.

An isolated evaluator keeps evaluator logic or expected results outside the model workspace.

Only isolated execution can support trusted holdout acceptance.

A local holdout-purpose evaluator without isolated trust is labelled as holdout purpose only.

### 2.4 Keep feedback explicit

Metric evaluators use:

- aggregate feedback; or
- bounded diagnostics.

Aggregate feedback exposes mapped scalar facts only.

Bounded diagnostics expose validated `{code, message}` items up to a declared limit.

Raw reports, stdout, stderr, protected commands, protected paths, expected hashes, and raw Git output remain protected unless the contract explicitly permits public report exposure.

Holdout-purpose evaluation uses aggregate feedback.

### 2.5 Consume budget at external start

An evaluation attempt consumes budget when the external evaluator starts.

Passed, failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts count.

The event stream records total and per-purpose counts before the external side effect begins.

## 3. Implemented contract

### 3.1 Metric reports

A `metric-report` check obtains one bounded JSON report through an evaluator adapter and parses it with the versioned `metric-json` parser.

The report uses `schemaVersion: 1`.

The definition maps declared scalar paths to declared facts. Supported values are Boolean, integer, finite number, and string.

The parser rejects malformed JSON, unsupported versions, unsafe paths, prototype traversal, missing required mappings, non-finite numbers, type mismatches, duplicate mappings, undeclared facts, and excessive report size.

### 3.2 Evaluation validity

A loop can declare:

```ts
evaluation: {
  validWhen: Condition;
  maximumInvalidEvaluations: number;
}
```

Validity runs before success and progress.

Invalid observations remain in iteration evidence and count against their limit and evaluation budget.

The region stops with `invalid_evaluations` when the invalid-observation limit is reached.

### 3.3 Feedback and budgets

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

A required evaluator start is rejected when the total or relevant per-purpose budget is exhausted.

A loop stops with `evaluation_budget` when it cannot start another required evaluator.

### 3.4 Evaluator integrity

A metric evaluator can declare:

```ts
evaluation: {
  integrity: {
    trustLevel: "transparent" | "protected" | "isolated";
    protectedPaths?: Array<{
      path: string;
      sha256: string;
      maxBytes?: number;
    }>;
    git?: {
      expectedRevision?: string;
      requireCleanWorktree?: true;
      protectedPathsUnchangedFrom?: string;
    };
    evaluatorVersion?: {
      value: string;
      fact?: string;
    };
  };
}
```

The current local runtime supports transparent and protected trust. It rejects isolated trust until a production isolated adapter exists.

Protected file instruments:

- require canonical workspace-relative paths;
- require exact SHA-256 values;
- use bounded descriptor reads;
- reject symbolic links;
- use no-follow opens where supported;
- verify opened file identity;
- obey cancellation;
- stop at a bounded integrity deadline.

Git instruments can require:

- an exact commit revision;
- a clean worktree;
- protected paths unchanged from an exact base revision.

The executor stores a versioned integrity observation containing:

- trust level;
- valid or invalid status;
- stable coarse diagnostic codes;
- evaluator version when declared;
- evaluator fingerprint;
- coarse protected-evidence state.

Replay validates and reuses the stored observation. It does not reread files or rerun Git.

### 3.5 Evaluator adapter boundary

Metric acquisition uses an injectable `EvaluatorAdapter`.

The request contains workflow, revision, node, attempt, requested time, evaluator profile, and metric definition.

The response separates:

- producer lifecycle result;
- bounded report bytes and media type;
- adapter identity and version;
- trust evidence;
- local-workspace or isolated boundary;
- terminal producer and adapter errors.

`LocalCommandReportEvaluatorAdapter` preserves the existing bounded local command/report behavior.

Metric parsing, fact publication, integrity, budgets, persistence, replay, and loop decisions do not depend on evaluator transport.

### 3.6 Evaluation-contract authoring

The bundled skill determines whether a defensible deterministic metric exists before adding numeric progress.

When a metric exists, authoring separates:

- target;
- constraints and instruments;
- typed success;
- numeric progress;
- evaluation validity;
- purpose;
- trust;
- feedback;
- budgets;
- probes and anti-gaming checks.

When no defensible metric exists, authoring omits progress and uses deterministic checks, typed success, evidence, hard limits, outcome policy, and user review.

A pure structural assessment returns non-blocking advisories for:

- undeclared evaluation policy;
- undeclared trust;
- non-isolated holdout purpose;
- missing evaluation budgets;
- missing typed validity;
- progress outside a metric-report boundary;
- missing probe guidance;
- public raw evaluator reports.

### 3.7 Product presentation

Pi and structured graph surfaces show:

- evaluation purpose;
- honest result claim;
- feedback mode;
- adapter identity and version;
- trust level;
- evaluator version;
- compact normal fingerprint and full structured fingerprint;
- integrity status and coarse diagnostic;
- protected-evidence count;
- current and best metric;
- evaluation counts and remaining budgets;
- terminal evaluation reason.

The product distinguishes:

- development score;
- probe score;
- holdout purpose only;
- trusted isolated holdout.

## 4. Runtime decision order

At an evaluation boundary, Hypagraph:

1. validates the executor result and fact contract;
2. validates the persisted integrity observation;
3. applies integrity validity;
4. evaluates typed user validity;
5. records an invalid observation when either layer fails;
6. stops at the invalid-evaluation limit;
7. evaluates typed success for a valid observation;
8. reads numeric progress for a valid observation;
9. updates best metric and iteration;
10. completes when success is true and verification passed;
11. stops at the hard iteration limit;
12. stops after no progress when patience is exhausted;
13. stops when another required evaluator cannot start within budget;
14. otherwise starts the next iteration.

Replay reproduces the same order and terminal reason.

## 5. Completed vertical slices

1. Metric-report checks — PR #52.
2. Evaluation validity — PR #53.
3. Feedback and evaluation budgets — PR #54.
4. Evaluator integrity — PRs #55 and #56.
5. Evaluation-contract authoring — PR #57.
6. Transport-neutral evaluator adapter — PR #58.
7. Complete evaluation product surface — PR #59.
8. Executable dogfood — PR #60.

## 6. Dogfood and validation

The complete dogfood record is `docs/m5a-dogfood.md`.

The executable tests prove:

- prose-derived authoring;
- an inner typed gate;
- three improving development evaluations;
- typed acceptance;
- a generalization probe;
- protected evaluator change rejection;
- best-result and patience protection;
- `no_progress` termination;
- `evaluation_budget` termination;
- restore and replay;
- stale-result rejection;
- protected-output filtering;
- accurate purpose, trust, adapter, and result claims.

CI #621 passes:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 79 test files and 300 tests.

## 7. Out of scope for M5A

M5A does not include:

- arbitrary loss code in the reducer;
- model-scored success or loss;
- a universal evaluator generator;
- semantic strategy-difference detection;
- secrecy based only on local path protection;
- a production remote holdout service;
- parallel evaluator execution;
- automatic restoration of the best workspace state;
- automatic collection of private reference data.

## 8. Roadmap integration

| Phase | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Typed loop success, numeric progress, best result, patience, hard limits, and explicit outcome policy |
| M5A | v0.6 | Trusted metric production, validity, feedback, budgets, integrity, authoring, adapters, and dogfood — complete |
| M5B | v0.6 | Hypagoal autonomous controller over one canonical Hypagraph workflow |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Executor abstraction and production isolated evaluation |
| M8 | v0.9 | Workspace integration and bounded concurrency |
| M9 | v0.10 | ACP and direct agent adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

The v0.6 tag waits until M5B dogfood and release evidence pass on a tested main commit.

## 9. Completion decision

M5A is complete.

M5B Hypagoal is the next milestone. It must reuse one canonical Hypagraph workflow and the completed M5A evaluation contract rather than introducing a second goal, loop, loss, or evaluator model.
