---
name: hypagraph
description: Automatically turn any actionable coding request or implementation plan into an executable Hypagraph workflow, then run it with explicit dependencies, typed facts, deterministic checks and gates, evidence, bounded iteration regions, and trusted evaluation contracts when a defensible metric exists. The user does not need to mention graphs or Hypagraph.
---

# Hypagraph

Use Hypagraph whenever the user asks Pi to perform repository work or supplies a coding plan to execute. Do not wait for graph, workflow, DAG, gate, loop, metric, or Hypagraph terminology.

Treat the user's prose, issue, checklist, or plan as source intent. Compile it into the smallest correct executable workflow.

## Default authoring sequence

1. Inspect enough repository state to understand the requested result, relevant files, existing checks, conventions, and material risks.
2. Identify the requested outcome, explicit constraints, acceptance intent, required ordering, writable scope, and user-selected trade-offs.
3. Infer tasks, dependencies, acceptance criteria, evidence, deterministic checks, typed facts, gates, bounded iteration regions, failure policies, and scopes.
4. Keep simple work simple. One bounded task and one check can be sufficient.
5. Preserve explicit intent. Do not invent product scope, silently widen writable paths, or convert every sentence into a node.
6. Ask a question only when product intent, safety, destructive choice, external authority, or a material trade-off cannot be inferred safely. Do not ask the user to design nodes or edges.
7. For `/hypagoal`, call `hypagoal_start` once with the exact prose objective and complete definition. For ordinary workflow authoring, call `hypagraph_define` before execution.
8. Review any evaluation authoring advisories returned by the definition. Revise weak contracts before execution when the advisory identifies a real risk.

## Hypagoal creation

`/hypagoal <objective>` creates one root graph-backed goal for the current Pi session.

During the authoring turn:

1. preserve the objective exactly in `HypagraphDefinition.goal`;
2. inspect relevant repository state before compiling the graph;
3. build the smallest useful canonical workflow;
4. keep independent top-level components independent;
5. use a bounded iteration region only when repetition is justified;
6. add a metric only when a deterministic and defensible instrument exists;
7. put uncertain or useful authoring notes in `advisories`, not in canonical definition fields;
8. call `hypagoal_start` as the final action.

The creation tool validates the complete projected result and persists the workflow definition, initial readiness, and workflow-local goal start in one event batch. It does not start a task, run a check, invoke an executor, or queue autonomous continuation.

Do not supply goal lifecycle state. The model cannot set a Hypagoal to completed, failed, cancelled, blocked, or paused. Terminal goal state remains derived from the canonical workflow lifecycle.

When a root already exists, replacement requires the exact typed confirmation supplied by Hypagraph. Do not construct, alter, or reuse a replacement confirmation from an older root state.

## Evaluation-contract authoring

Use an evaluation contract only when the objective has a defensible deterministic measurement.

Do not invent a metric because a loop exists. A loop can use typed success, deterministic checks, evidence, hard limits, explicit outcome policy, and user review without numeric progress.

When a defensible metric exists, use this sequence.

### 1. Separate target, success, progress, and validity

Define separately:

- **target:** the capability or property to improve;
- **success:** the typed condition that permits completion;
- **progress:** the numeric fact and minimize or maximize direction;
- **validity:** the typed condition that makes an observation usable.

A threshold fact can participate in success. It must not replace validity.

### 2. Convert constraints into instruments

For each material constraint, define:

- an instrument that can measure or assert it;
- a declared typed fact;
- a validity or gate condition;
- an explicit failure route or stop rule.

A textual warning without a deterministic instrument is not an enforceable constraint.

Use existing test, lint, coverage, file, Git, command, or metric-report checks where possible.

### 3. Select evaluation purpose

Use:

- `development` for frequent optimization feedback;
- `probe` for changed inputs or conditions that test generalization and metric gaming;
- `holdout` only for final-purpose evaluation.

Purpose does not establish trust.

### 4. Select evaluator trust

Declare `evaluation.integrity.trustLevel` explicitly:

- `transparent`: evaluator logic and data can be visible;
- `protected`: declared evaluator artifacts are integrity-checked but remain locally readable;
- `isolated`: evaluator logic or expected results are outside the model workspace.

The current local runtime supports transparent and protected execution. Do not author isolated trust until an isolated adapter is available.

A local protected evaluator is not a secret holdout. Do not describe a transparent or protected result as trusted holdout acceptance.

For protected trust, declare exact SHA-256 paths or exact Git constraints. Declare an evaluator version or derive identity from protected instruments.

### 5. Define bounded feedback

Use aggregate feedback by default.

Use bounded diagnostics only when actionable diagnostic codes are necessary. Declare `maximumDiagnosticItems`.

Do not expose raw reports when they contain protected cases, expected answers, membership identifiers, hidden constraints, or other shortcut information.

Holdout-purpose evaluation must use aggregate feedback.

### 6. Define budgets

Declare workflow evaluation budgets whenever external metric evaluators can run.

Use a total limit and relevant per-purpose limits. Include enough budget for expected retries, invalid observations, probes, and final evaluation, but keep the contract bounded.

Evaluation attempts consume budget when the external evaluator starts, including failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts.

### 7. Define loop controls

An evaluation-backed loop should declare:

- typed `successWhen`;
- hard `maxIterations`;
- typed `evaluation.validWhen`;
- `maximumInvalidEvaluations`;
- optional numeric `progress`;
- `patience` when marginal improvement should stop the region;
- explicit `failurePolicy`.

Improvement must exceed `minDelta`. Equal values do not improve.

### 8. Analyze shortcuts and probes

Identify obvious ways the implementation could improve the score without improving the target.

For each material shortcut, add a constraint instrument or probe. Useful probe facts include generalization score, probe gap, capacity validity, and strategy-change requirements.

Do not ask a model to judge structural strategy difference unless a deterministic task-specific instrument exists.

## Execution rules

1. Call `hypagraph_transition` with `action: "start"` before task work. Use `action: "evaluate"` for a ready gate.
2. Work only in the active task contract and writable scope.
3. Use `action: "publish"` for declared task facts while the attempt is running.
4. Use `action: "submit"` with concrete evidence, then a separate `action: "verify"`.
5. Use `hypagraph_run_check` for ready or retryable check nodes. Do not start checks through `hypagraph_transition`.
6. Use `action: "block"` when work cannot continue and `action: "cancel"` when an active attempt must stop.
7. Call `hypagraph_revise` when new evidence makes the graph incorrect. Preserve unaffected completed work and routes.

## Loop rules

A deliberate cycle must be a declared bounded iteration region. The region nodes must match one cyclic strongly connected component. Feedback runs from the evaluation boundary to the entry boundary. Typed success and a hard iteration limit are mandatory.

Do not assume a loop is for repair. Use node contracts and facts to define refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

A loop can be an independent graph component. Keep its facts, routes, progress, validity, attempts, and reset state independent from unrelated regions.

A failed evaluator check is a usable loop observation only when normalization succeeded and all required facts were published. Cancellation or interruption blocks the affected loop until an explicit revision resets it.

Do not revise a loop while an attempt is active. A relevant revision restarts the region from iteration 1. Check retries stay in the current iteration. Loop continuation creates a new iteration and attempt ID. Do not select loop decisions manually.
