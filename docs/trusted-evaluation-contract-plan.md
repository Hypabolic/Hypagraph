# Trusted evaluation contracts and loss functions

- Status: active implementation
- Roadmap phase: M5A
- Release marker: v0.6 with M5B Hypagoal
- Prerequisites: M3 deterministic checks and M4 executable bounded iteration regions
- Tracking issue: #30
- Research source: https://github.com/elvisun/loss-function-development
- Writing standard: ASD-STE100 Simplified Technical English

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

The reducer must consume typed facts and persisted observations only. It must not run an evaluator, inspect files, invoke Git, call a model, or calculate a semantic score.

This capability applies to optimization, refinement, search, repeated evaluation, reconciliation, migration, polling, and repair. Repair is not the default loop purpose.

## 2. Core decisions

### 2.1 Keep one progress model

Hypagraph keeps the M4 progress model:

- one numeric progress fact;
- minimize or maximize direction;
- strict minimum improvement;
- best metric and best iteration;
- patience;
- hard iteration limits.

M5A does not add arbitrary JavaScript or TypeScript loss functions to the reducer.

### 2.2 Keep success, progress, and validity separate

Success answers whether a loop may complete.

Progress answers whether a valid observation is better than the best prior valid observation.

Evaluation validity answers whether the runtime may use the observation as an honest measurement.

A numeric result can be invalid. An invalid result must not:

- complete a loop;
- update the accepted current metric;
- replace the best metric;
- replace the best iteration;
- reset or increment patience.

### 2.3 Keep evaluation purpose and trust separate

Evaluation purpose is one of:

- `development`;
- `probe`;
- `holdout`.

Evaluator trust is one of:

- `transparent`;
- `protected`;
- `isolated`.

A protected local evaluator can prove that declared artifacts did not change. It does not hide readable answers from a model or process in the same workspace.

Only an isolated evaluator boundary can support a strong trusted holdout claim.

### 2.4 Keep feedback explicit

A metric evaluator declares one feedback mode:

- `aggregate`;
- `bounded-diagnostics`.

Aggregate feedback exposes mapped scalar facts only.

Bounded diagnostics expose only validated `{code, message}` items up to a declared limit.

Raw reports, stdout, stderr, protected commands, protected paths, expected hashes, and raw Git output remain protected evidence unless the contract explicitly permits public report exposure.

A holdout evaluator must use aggregate feedback.

### 2.5 Consume budget at external start

An evaluation attempt consumes budget when the external evaluator starts.

Passed, failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts consume budget.

The event stream records total and per-purpose counts before the external side effect starts.

## 3. Implemented contract

### 3.1 Metric reports

A `metric-report` check runs through the existing bounded command lifecycle and reads one workspace-contained JSON report.

The report must use `schemaVersion: 1`.

The definition maps declared scalar source paths to declared typed facts. Supported types are Boolean, integer, finite number, and string.

The parser rejects malformed JSON, unsupported versions, unsafe paths, prototype traversal, missing required mappings, non-finite numbers, type mismatches, duplicate mappings, undeclared facts, and report-size violations.

### 3.2 Loop evaluation validity

A loop can declare:

```ts
evaluation: {
  validWhen: Condition;
  maximumInvalidEvaluations: number;
}
```

The runtime evaluates validity before success and progress. It records invalid observations and stops with `invalid_evaluations` at the declared limit.

### 3.3 Feedback and evaluation budgets

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

A required next evaluation is rejected when either the total limit or the relevant per-purpose limit is exhausted. A loop stops with `evaluation_budget` when it cannot start another required evaluator.

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

The current runtime supports transparent and protected trust. It rejects isolated trust until the evaluator adapter boundary exists.

Protected path instruments:

- require workspace-relative canonical paths;
- require exact SHA-256 values;
- use bounded descriptor reads;
- reject symbolic links;
- use no-follow opens where the platform supports them;
- verify the opened file identity before hashing;
- obey evaluator cancellation;
- stop at a bounded integrity deadline.

Git instruments use a fixed argument allowlist. They can require:

- an exact commit revision;
- a clean worktree;
- declared protected paths unchanged from an exact base revision.

An unrelated path change does not fail the protected-path constraint.

The executor stores a versioned integrity observation in `CheckResult`. The observation contains:

- trust level;
- valid or invalid status;
- stable coarse diagnostic codes;
- declared evaluator version when present;
- a derived evaluator fingerprint;
- coarse protected-evidence states.

Replay validates and reuses this observation. Replay does not reread protected files or rerun Git.

An integrity-invalid result consumes evaluation budget and remains available for audit. It cannot update success or progress state.

## 4. Runtime decision order

At an evaluation boundary, Hypagraph uses this order:

1. Validate the executor result and required fact contracts.
2. Validate the persisted evaluator integrity observation.
3. Apply evaluator integrity validity.
4. Evaluate the typed user validity condition.
5. Record an invalid evaluation when either validity layer fails.
6. Stop when the invalid-evaluation limit is reached.
7. Evaluate typed success for a valid observation.
8. Read and record numeric progress for a valid observation.
9. Update the best metric and best iteration.
10. Complete when success is true and verification passed.
11. Stop at the hard iteration limit.
12. Stop after no progress when patience is exhausted.
13. Stop when another required evaluator cannot start within budget.
14. Otherwise start the next iteration.

Replay must reproduce this order and the same terminal reason.

## 5. Remaining vertical slices

Each slice crosses the domain model, validation, executor, persistence, Pi adapter, graph projection, tests, and documentation where those layers are affected.

### Slice 5 - Evaluation-contract authoring

Add automatic authoring guidance and contract linting for:

- target selection;
- constraint identification;
- deterministic instruments;
- typed validity;
- typed success;
- numeric progress when defensible;
- feedback limits;
- evaluation budgets;
- probe strategy;
- anti-gaming analysis;
- explicit trust selection;
- warnings when no isolated holdout exists.

The authoring model must omit progress when no defensible deterministic metric exists. It must not invent a semantic score.

Done when an ordinary prose objective produces a valid evaluation-backed graph, or deliberately produces a non-metric graph with typed checks, evidence, hard bounds, and user review.

### Slice 6 - Transport-neutral evaluator adapter

Add:

- `EvaluatorAdapter` interface;
- normalized request and response types;
- adapter identity and version;
- evaluation purpose;
- trust evidence;
- public and protected outputs;
- timeout and cancellation rules;
- a local command/report reference adapter;
- isolated-adapter contract tests.

The existing parser, durable check lifecycle, reducer, and loop runtime must not depend on evaluator transport.

A production secure isolated transport remains part of the later executor milestone.

Done when transport can change without changing canonical evaluation semantics.

### Slice 7 - Complete the Pi product surface

Show:

- evaluation purpose;
- declared trust boundary;
- feedback mode;
- validity and integrity state;
- current and best metric;
- evaluation counts and remaining budgets;
- evaluator version;
- probe or generalization facts when declared;
- terminal evaluation reason;
- protected evidence count.

Normal summaries should use a shortened fingerprint. Full fingerprints belong in detailed inspection.

Pi must label holdout as evaluation purpose. It must not present a non-isolated result as trusted holdout acceptance.

Done when a user can understand the measurement and trust boundary without reading raw events.

### Slice 8 - Dogfood and close M5A

Use focused scenarios:

1. Successful optimization from prose with an inner deterministic gate, at least three valid improving iterations, a probe fact, and typed acceptance.
2. Integrity-invalid evaluation that cannot update best progress or complete the loop.
3. Patience termination.
4. Evaluation-budget termination.
5. Restore between iterations.
6. Deterministic replay.
7. Stale-result rejection.
8. Accurate transparent and protected trust labels.
9. No trusted holdout claim without isolated execution.

Store the prose objective, generated graph, event-backed results, Pi screenshots, replay evidence, and final CI counts in `docs`.

Done when issue #30 can close and M5B can use one stable evaluation contract.

## 6. Test strategy

Tests must cover:

- parser determinism and rejection cases;
- valid and invalid observations;
- progress and patience protection;
- event-backed budget accounting;
- feedback caps and protected output filtering;
- exact file and Git integrity instruments;
- symbolic-link rejection;
- cancellation and integrity deadlines;
- stale-result rejection;
- restore without repeated external effects;
- replay equality;
- accurate trust labels;
- source compatibility for workflows without evaluation contracts.

The supported CI matrix is:

- Ubuntu, macOS, and Windows;
- Node.js 22 and 24.

## 7. Out of scope for v0.6

The first M5A release does not include:

- arbitrary loss code in the reducer;
- model-scored success or loss;
- automatic semantic strategy-difference detection;
- a universal evaluator generator;
- a secrecy claim based only on local path protection;
- a built-in remote holdout service;
- parallel evaluator execution;
- restoration of the best workspace state;
- automatic collection of private reference data.

## 8. Roadmap integration

| Phase | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Typed loop success, numeric progress, best result, patience, hard limits, and explicit outcome policy |
| M5A | v0.6 | Trusted metric production, validity, feedback, budgets, integrity, authoring, and adapter contract |
| M5B | v0.6 | Hypagoal autonomous controller over one canonical Hypagraph workflow |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Executor abstraction and production isolated evaluation |
| M8 | v0.9 | Workspace integration and bounded concurrency |
| M9 | v0.10 | ACP and direct agent adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

The v0.6 tag must point to a tested main commit after both M5A and M5B release criteria pass.
