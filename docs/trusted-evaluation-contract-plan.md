# Trusted evaluation contracts and loss functions

- Status: proposed
- Roadmap phase: M5 foundation
- Release marker: v0.6 with Hypagoal
- Prerequisites: M3 deterministic checks and M4 executable bounded loops
- Research source: https://github.com/elvisun/loss-function-development
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This plan adds trusted evaluation contracts to Hypagraph.

M4 already adds the runtime part of a loss function. It adds a numeric progress fact, a minimize or maximize direction, a minimum improvement value, best-result tracking, patience, and a no-progress stop reason.

That runtime can compare values. It does not prove that a value is a trustworthy measure of progress.

Hypagraph must add a controlled evaluation surface that can:

- run a task-specific evaluator;
- parse a typed metric report;
- reject an invalid evaluation;
- limit the information that an evaluator returns;
- protect evaluator integrity;
- apply evaluation budgets;
- distinguish development evaluation from holdout acceptance;
- record evaluation history for replay.

This work is a foundation for optimization-grade Hypagoal workflows.

## 2. Decision

Hypagraph must keep the existing M4 progress model.

Hypagraph must not execute an arbitrary loss function inside the reducer.

Hypagraph must add an evaluation contract around the existing progress model.

The evaluation contract must define:

- how Hypagraph obtains a metric;
- how Hypagraph validates the metric;
- when the metric is valid;
- what feedback the model can see;
- how many evaluations can run;
- which evaluator artifacts are protected;
- which trust level applies;
- which typed condition controls acceptance.

The deterministic runtime must consume typed facts only.

A scorer, parser, or evaluator must not change canonical state directly.

## 3. Research result

The `loss-function-development` repository describes more than one numeric loss value.

Its principal pattern contains:

1. a target;
2. constraints;
3. instruments that measure the target and enforce the constraints;
4. forced variation that limits local overfitting.

It also separates two loops:

- an inner specification loop that makes tests pass;
- an outer evaluation loop that improves a measured capability.

Useful patterns include:

- task-specific scoring tools;
- development and holdout evaluation sets;
- aggregate-only holdout feedback;
- score invalidation after a constraint violation;
- probe cases that detect memorization;
- capacity limits for lookup-table artifacts;
- evaluation-call limits;
- persistent iteration logs;
- explicit stop rules for low marginal gain.

Hypagraph must adopt the control principles that fit a deterministic graph runtime.

Hypagraph must not copy prompt-only enforcement.

## 4. Terms

### 4.1 Success condition

A success condition answers this question:

> Can the loop stop with a successful result?

Hypagraph evaluates success with a typed condition.

### 4.2 Progress metric

A progress metric answers this question:

> Is this valid iteration better than the best prior valid iteration?

M4 stores the metric as a numeric typed fact.

### 4.3 Evaluation validity

Evaluation validity answers this question:

> Can Hypagraph use this score as an honest observation?

An evaluation can be invalid when:

- the implementation violates a declared constraint;
- the evaluator report is malformed;
- the evaluator detects overlap with protected evaluation data;
- a protected evaluator artifact changed;
- the score is not finite;
- the evaluator cannot complete its required probes;
- the evaluator trust boundary is not available.

An invalid evaluation must not improve the best metric.

### 4.4 Evaluation contract

An evaluation contract defines the evaluator, typed output, validity rule, feedback policy, budgets, protected resources, and acceptance rule.

### 4.5 Development evaluation

A development evaluation can run frequently.

It can return bounded diagnostic information.

It does not provide final acceptance when the contract requires a holdout evaluation.

### 4.6 Holdout evaluation

A holdout evaluation uses protected expected results.

It returns aggregate information only.

A workflow must not claim a trusted holdout result when the evaluator and expected results remain readable by the model.

### 4.7 Probe evaluation

A probe evaluation changes inputs or conditions to test whether an implementation generalizes.

A probe can publish facts such as:

- `evaluation.probe_score`;
- `evaluation.probe_gap`;
- `evaluation.generalization_valid`.

## 5. Architectural rules

### 5.1 Keep the reducer pure

The reducer must not:

- run an evaluator;
- read an evaluator report;
- inspect files;
- read the clock;
- call a model;
- calculate a semantic score.

The reducer can validate commands and apply evaluation events.

### 5.2 Use a check or evaluator adapter

A check executor or evaluator adapter runs the task-specific evaluator.

The adapter returns an untrusted report.

A deterministic parser validates the report and publishes typed facts.

The controller stores accepted events before it makes the next external side effect.

### 5.3 Keep success separate from progress

A loop can improve without success.

A loop can satisfy a success threshold without producing the best observed metric.

A workflow must use a typed success condition for completion.

A progress metric can control best-result tracking and patience.

### 5.4 Keep validity separate from score

A score is not valid only because it is numeric.

The evaluation contract must define a typed validity condition.

When validity is false:

- Hypagraph must not update the best metric;
- Hypagraph must not reset patience;
- Hypagraph must record the invalid evaluation;
- Hypagraph must count the evaluation against its budget;
- Hypagraph must follow only a declared invalid-evaluation route or stop rule;
- Hypagraph must not expose protected diagnostic details.

### 5.5 Use explicit trust levels

The initial trust levels are:

- `transparent`;
- `protected`;
- `isolated`.

A transparent evaluator can expose its evaluator logic and development data to the model.

A protected evaluator prevents changes to evaluator artifacts. It does not guarantee that hidden answers are unreadable.

An isolated evaluator keeps evaluator logic or expected results outside the model workspace. It returns only the declared report.

Only an isolated evaluator can support a strong holdout claim.

### 5.6 Do not mislabel local data as holdout data

A file in the same readable workspace is not a trusted holdout file.

Path write protection does not provide answer secrecy.

A local workflow can still use a transparent development evaluator.

The user interface and event history must show the evaluator trust level.

## 6. Metric-report check

### 6.1 Check definition

Add a constrained metric-report check.

The initial shape is:

```ts
export interface MetricReportCheckDefinition {
  kind: "metric-report";
  command: string;
  arguments?: string[];
  reportPath: string;
  timeoutMs: number;
  mappings: MetricReportMapping[];
  maximumReportBytes?: number;
}

export interface MetricReportMapping {
  source: string;
  fact: string;
  type: "boolean" | "integer" | "number" | "string";
}
```

The parser must support only declared scalar paths.

The parser must not publish arbitrary nested objects.

### 6.2 Report format

A typical evaluator report is:

```json
{
  "schemaVersion": 1,
  "valid": true,
  "score": 0.847,
  "metrics": {
    "precision": 0.88,
    "recall": 0.82,
    "probeScore": 0.79,
    "probeGap": 0.057
  },
  "summaryCode": "below_target"
}
```

The contract can map fields to facts such as:

```text
evaluation.valid
evaluation.score
evaluation.precision
evaluation.recall
evaluation.probe_score
evaluation.probe_gap
evaluation.summary_code
```

### 6.3 Parser requirements

The parser must:

- enforce a report-size limit;
- require a supported schema version;
- reject invalid JSON;
- reject duplicate or ambiguous fields when the parser can detect them;
- reject missing required mappings;
- reject non-finite numbers;
- type-check each mapped value;
- use deterministic mapping order;
- reject undeclared fact publication;
- preserve the raw report as an artifact when policy permits;
- prevent raw protected output from entering a model-visible message.

## 7. Evaluation contract model

The exact public schema can change during implementation.

The initial semantic model is:

```ts
export interface EvaluationContractDefinition {
  evaluatorNodeId: string;
  trustLevel: "transparent" | "protected" | "isolated";
  validWhen: Condition;
  acceptanceWhen: Condition;
  feedback: EvaluationFeedbackPolicy;
  budget?: EvaluationBudget;
  protectedPaths?: string[];
  probeNodeId?: string;
  holdoutNodeId?: string;
}

export interface EvaluationFeedbackPolicy {
  mode: "aggregate" | "bounded-diagnostics";
  maximumDiagnosticItems?: number;
  exposeRawReport?: boolean;
}

export interface EvaluationBudget {
  maximumEvaluations?: number;
  maximumHoldoutEvaluations?: number;
}
```

The contract must refer to graph nodes and typed conditions.

It must not duplicate node contracts, loop progress, or workflow acceptance criteria.

## 8. Loop integration

### 8.1 Extend evaluation policy

M4 defines loop success and progress.

The evaluation contract adds validity.

The implementation can add a loop evaluation policy such as:

```ts
export interface LoopEvaluationPolicy {
  validWhen?: Condition;
  maximumInvalidEvaluations?: number;
}
```

The final API must keep loop success, progress, and validity as separate concepts.

### 8.2 Decision order

At an evaluation boundary, use this order:

1. Validate the evaluator result and required facts.
2. Evaluate the validity condition.
3. Record an invalid evaluation when validity is false.
4. Stop when the invalid-evaluation limit is reached.
5. Evaluate the typed success condition for a valid evaluation.
6. Read and record the progress metric for a valid evaluation.
7. Update the best metric and best iteration.
8. Complete when success is true and verification passed.
9. Stop at the hard iteration limit.
10. Stop after no progress when patience is exhausted.
11. Otherwise start the next iteration.

Replay must reproduce this order.

### 8.3 Invalid evaluation route

A workflow can declare a repair route for an invalid evaluation.

The repair route can remove:

- an evaluator-shaped lookup table;
- protected-data overlap;
- a prohibited special case;
- a changed evaluator artifact;
- an invalid or incomplete report producer.

The runtime must not invent the repair action.

## 9. Inner and outer graph pattern

Hypagoal authoring guidance must support this graph pattern:

```text
implement-to-spec
        |
        v
run-tests
        |
        v
tests-green? ---- false ----> repair-spec
        |
       true
        v
optimize
        |
        v
development-evaluator
        |
        v
evaluation-valid?
   | false              | true
   v                    v
remove-invalid-path   target-reached?
   |                 | false       | true
   +---- feedback ---+             v
                              holdout-evaluator
                                | false   | true
                                v         v
                             optimize   complete
```

The graph can omit a holdout evaluator when no isolated evaluator is available.

In that case, the workflow must describe its result as a development score.

## 10. Feedback controls

### 10.1 Development feedback

A development evaluator can return:

- one aggregate score;
- declared component metrics;
- a bounded number of diagnostic items;
- stable summary codes.

The contract must set a maximum diagnostic count.

### 10.2 Holdout feedback

A holdout evaluator must return aggregate output only.

It must not return:

- expected answers;
- per-case failures;
- identifiers that expose membership;
- exact constraint-match values;
- raw hidden artifacts.

### 10.3 Constraint failures

A constraint failure can publish a coarse fact such as:

```text
evaluation.valid = false
evaluation.summary_code = "constraint_violation"
```

The evaluator must not expose a protected literal or expected answer in the public result.

### 10.4 Evaluation-call budgets

The runtime must count each accepted evaluator start.

The budget must distinguish:

- development evaluations;
- probe evaluations;
- holdout evaluations.

A failed, invalid, timed-out, or cancelled evaluation still consumes an evaluation attempt when an external side effect started.

## 11. Evaluator integrity

### 11.1 Protected artifacts

An evaluation contract can declare protected paths.

Hypagraph must detect changes to these paths before it accepts a score.

Useful instruments include:

- file hash assertions;
- Git state assertions;
- allowed-path assertions;
- evaluator version facts.

### 11.2 Read protection

Write protection alone is not sufficient for hidden answers.

A model can use a process to read a local file unless the execution boundary prevents it.

The first release must not claim strong secrecy from tool-name interception alone.

### 11.3 Isolated evaluator boundary

Define an evaluator adapter interface before the executor milestone.

An isolated implementation can arrive with the executor abstraction and workspace work.

The adapter receives:

- an evaluator profile;
- an artifact or workspace reference;
- declared public inputs;
- an evaluation kind;
- an attempt ID;
- a cancellation signal.

The adapter returns:

- a normalized report;
- report metadata;
- trust-level evidence;
- artifact references;
- failure details.

The adapter must not expose hidden expected results.

## 12. Forced variation and anti-gaming rules

Hypagraph must not use model judgement to decide whether two implementation strategies are structurally different.

The graph can require explicit nodes for:

- probe generation;
- generalization checks;
- hypothesis recording;
- alternative-strategy work;
- evaluator-integrity checks;
- iteration checkpoints.

A task-specific instrument can publish facts such as:

```text
evaluation.probe_gap
evaluation.generalization_valid
evaluation.capacity_valid
evaluation.strategy_change_required
```

Hypagoal authoring guidance must ask the model to identify likely evaluator shortcuts.

Each declared shortcut must have:

- a constraint;
- an instrument;
- a typed result;
- a graph route for failure.

A textual warning without an instrument is not an enforceable constraint.

## 13. Vertical slices

Each slice must cross the affected domain, runtime, parser, persistence, Pi, test, and documentation layers.

### Slice 1 - Add the metric-report check

#### User result

A task-specific evaluator can publish deterministic numeric facts.

#### Add

- `MetricReportCheckDefinition`;
- fixed-schema JSON parsing;
- scalar fact mappings;
- report-size limits;
- finite-number validation;
- raw report artifacts;
- parser determinism tests;
- Pi tool support.

#### Done when

A command can produce a valid numeric score and typed component facts without custom reducer code.

### Slice 2 - Add evaluation validity

#### User result

Hypagraph can reject a numeric score that violates the evaluation contract.

#### Add

- typed validity conditions;
- invalid-evaluation events;
- invalid-evaluation counters;
- a bounded invalid-evaluation stop;
- no best-metric update after an invalid evaluation;
- no patience reset after an invalid evaluation;
- replay tests.

#### Done when

An invalid score cannot become the best result and cannot complete a loop.

### Slice 3 - Add feedback and evaluation budgets

#### User result

An evaluator can limit diagnostic output and evaluation frequency.

#### Add

- aggregate and bounded-diagnostic policies;
- development, probe, and holdout counters;
- maximum evaluation counts;
- maximum holdout evaluation counts;
- protected-output filtering;
- deterministic budget events;
- status projection.

#### Done when

Hypagraph stops another evaluation at the declared limit and does not expose protected output.

### Slice 4 - Add evaluator integrity checks

#### User result

A workflow can prove that declared evaluator artifacts did not change.

#### Add

- protected-path declarations;
- hash and Git assertion integration;
- evaluator version facts;
- invalidation after evaluator changes;
- strict acceptance rules;
- integrity diagnostics.

#### Done when

A changed protected evaluator artifact voids the score before progress state changes.

### Slice 5 - Add evaluation-contract authoring

#### User result

A model can translate an optimization objective into a graph-backed evaluation contract.

#### Add

- bundled skill guidance;
- target, constraint, instrument, and feedback prompts;
- inner and outer loop graph guidance;
- anti-gaming analysis;
- probe guidance;
- trust-level selection;
- clear warnings when no isolated holdout exists.

#### Done when

A prose Hypagoal objective can produce a valid graph with a typed score, validity rule, progress rule, success rule, and bounded evaluator feedback.

### Slice 6 - Define the isolated evaluator adapter

#### User result

Hypagraph has a stable boundary for future hidden holdout evaluation.

#### Add

- evaluator adapter interface;
- normalized evaluator result;
- trust-level evidence;
- cancellation and timeout rules;
- no-secret-output contract tests;
- a transparent local reference adapter.

#### Deferred implementation

A secure isolated process or remote evaluator can arrive with the executor and workspace milestones.

#### Done when

The domain and Pi adapter do not depend on one evaluator transport.

### Slice 7 - Complete the Pi product surface

#### User result

A user can understand score quality and evaluator trust.

#### Add

- current score and best score;
- validity state;
- trust level;
- evaluation counts and remaining budgets;
- probe gap;
- protected evaluator version;
- terminal evaluation reason;
- graph-pane evaluation details.

#### Done when

The Pi surface clearly distinguishes a valid isolated holdout score from a transparent development score.

### Slice 8 - Dogfood the evaluation contract

#### Required path

The dogfood run must:

1. Start from a prose optimization objective.
2. Pass an inner test gate.
3. Run a development evaluator.
4. Publish a numeric score and component metrics.
5. Reject one deliberately invalid evaluation.
6. Prove that the invalid score does not update the best metric.
7. Run a probe and publish a generalization fact.
8. Improve the score for at least three valid iterations.
9. Stop once through patience.
10. Stop once through an evaluation budget.
11. Complete once through a typed acceptance condition.
12. Restore and replay the same evaluation decisions.
13. Show the trust level in Pi.
14. Avoid a holdout claim when the evaluator is not isolated.

## 14. Test strategy

### 14.1 Parser tests

Tests must cover:

- valid reports;
- malformed JSON;
- unsupported schema versions;
- missing fields;
- wrong types;
- non-finite numbers;
- excessive report size;
- undeclared fields;
- deterministic mapping order;
- protected raw output.

### 14.2 Runtime tests

Tests must prove:

- a valid score can update the best metric;
- an invalid score cannot update the best metric;
- an invalid score cannot reset patience;
- an invalid score cannot complete a loop;
- invalid evaluations count against their limit;
- evaluation budgets survive restore;
- replay gives the same validity and stop decisions;
- a stale evaluator result cannot publish facts;
- a changed protected path invalidates the score.

### 14.3 Information-control tests

Tests must prove:

- bounded diagnostics do not exceed the configured count;
- aggregate feedback does not include per-case data;
- protected raw reports do not enter model-visible messages;
- a holdout result requires an isolated trust level;
- the user interface does not label transparent evaluation as holdout evaluation.

## 15. Out of scope for v0.6

The first implementation does not include:

- arbitrary JavaScript or TypeScript loss functions in the reducer;
- model-scored success;
- automatic semantic detection of strategy variation;
- a universal evaluator generator;
- a secure sandbox based only on tool-call interception;
- automatic collection of private or access-controlled reference data;
- restoration of the best workspace state;
- parallel evaluator execution;
- a built-in remote holdout service.

## 16. Roadmap integration

Keep M4 as the scalar progress and loop-control milestone.

Add trusted evaluation contracts as the foundation phase of M5.

Implement the required evaluation slices before Hypagoal runs optimization-grade autonomous loops.

Use this sequence:

| Phase | Release marker | Result |
| --- | --- | --- |
| M4 | v0.5 | Typed loop success, numeric progress or loss, best result, patience, and hard limits |
| M5A | v0.6 | Trusted metric reports, evaluation validity, evaluator integrity, feedback limits, and evaluation budgets |
| M5B | v0.6 | Hypagoal autonomous graph controller |
| M6 | v0.7 | Event history, replay, and debugger UI |
| M7 | v0.8 | Executor abstraction and isolated evaluator execution |
| M8 | v0.9 | Workspace integration and bounded concurrency |
| M9 | v0.10 | Agent Communication Protocol adapter and direct adapters |
| Exit | v1.0 | Hardened agent-independent execution kernel |

The M5 release can ship transparent development evaluation before it ships an isolated holdout adapter.

The product must label that distinction correctly.

## 17. Hypagoal integration

Hypagoal must use this plan when an objective contains an optimization loop.

Hypagoal must not require a progress metric for every goal.

When a defensible metric exists, Hypagoal must define:

- a metric-producing evaluator node;
- a typed validity condition;
- a typed success condition;
- a numeric progress direction;
- a hard iteration limit;
- a patience rule when useful;
- evaluation budgets;
- a feedback policy;
- a trust level.

When no defensible metric exists, Hypagoal must omit the progress policy.

It must use checks, evidence, typed success, hard bounds, and user review instead.

## 18. Exit criteria

Trusted evaluation contracts are complete for v0.6 when:

- a metric-report check publishes typed scalar facts;
- parser output is deterministic;
- evaluation validity is separate from score;
- an invalid score cannot update progress state;
- evaluation budgets are event-backed and replayable;
- evaluator changes can invalidate a score;
- feedback output follows a declared policy;
- Pi shows evaluator trust level and evaluation state;
- Hypagoal can author an inner and outer loop graph;
- the product does not make a false holdout claim;
- the complete dogfood path passes.
