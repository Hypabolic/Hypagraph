# Automatic graph and evaluation-contract authoring

- Status: active product direction
- Applies to: all Hypagraph and Hypagoal entry points
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Decision

The user describes the work. Hypagraph builds the graph.

A user can provide:

- an ordinary coding request;
- a bug report;
- an issue or ticket;
- a checklist;
- an implementation plan;
- a durable objective.

The user does not have to mention Hypagraph, graphs, nodes, edges, gates, facts, checks, loops, metrics, or evaluation contracts.

The graph is an inspectable executable representation of user intent. It is not an input format that the user must design.

## 2. Default skill behavior

The bundled skill activates for actionable repository work and supplied implementation plans.

It must:

1. inspect the repository;
2. identify the requested result and constraints;
3. find relevant files, checks, data, and repository conventions;
4. compile the request into the smallest correct workflow;
5. define the graph before execution;
6. review deterministic authoring advisories;
7. execute only ready work;
8. revise the graph when new evidence makes the plan incorrect.

The skill must not wait for graph-specific words.

## 3. Smallest useful graph

Automatic authoring must not create complexity for its own sake.

Use:

- one task when one bounded contract is sufficient;
- a deterministic check when verification exists;
- multiple tasks when dependencies or writable scopes are materially different;
- a gate when typed facts select a real alternative;
- a loop when work must repeat until typed success or a hard bound applies;
- disconnected regions when work has independent bounded lifecycles;
- a metric evaluator only when a defensible deterministic measurement exists.

Do not convert every sentence or checklist item into a node mechanically.

Do not add a progress metric merely because the workflow contains a loop.

## 4. Intent preservation

The generated graph must preserve:

- requested outcome;
- explicit constraints;
- acceptance intent;
- required ordering;
- safety limits;
- writable scope;
- user-selected trade-offs.

The authoring model must not invent product scope, silently widen file access, or reinterpret a subjective objective as a numeric optimization problem.

An existing plan is semantic input. The skill can merge, split, reorder, or add validation nodes when repository evidence requires it, but it must preserve intent and explain material changes.

## 5. Evaluation-contract decision

Before authoring numeric progress, ask:

> Is there a deterministic measurement that tracks the requested target closely enough to guide work?

Use a metric only when the answer is defensible from repository evidence, an existing benchmark, a declared external instrument, or explicit user intent.

Examples that often support deterministic metrics include:

- failing-test count;
- coverage percentage;
- benchmark latency or throughput;
- binary size;
- lint or static-analysis defect count;
- task-specific accuracy, precision, recall, or error rate;
- bounded migration or reconciliation counts.

Examples that normally do not justify an invented metric include:

- make this architecture cleaner;
- improve the explanation;
- choose the best design;
- make the API intuitive;
- produce a good user experience.

For non-metric objectives, use typed success, deterministic checks, evidence, hard iteration limits, explicit failure policy, and user review where needed.

## 6. Evaluation-contract authoring sequence

When a defensible measurement exists, author in this order.

### 6.1 Define the target

State what capability or property should improve.

The target is semantic intent. It is not automatically the progress fact.

### 6.2 Define constraints and instruments

For every material constraint, identify:

- a deterministic instrument;
- a typed fact;
- a validity or gate condition;
- an explicit failure route or stop rule.

A prose constraint without an instrument remains advisory. The graph must not present it as enforced.

Prefer existing test, lint, coverage, file, Git, command, and metric-report checks.

### 6.3 Define success

`successWhen` answers whether the region may complete.

Use typed facts and conditions. Do not use model narrative as canonical success.

### 6.4 Define progress

Progress answers whether a valid observation improved over the prior best result.

Declare:

- one numeric fact;
- `minimize` or `maximize`;
- `minDelta` when noise or insignificant changes must not count;
- patience when low marginal gain should stop the region.

Progress is optional.

### 6.5 Define evaluation validity

Validity answers whether the runtime may use the observation.

Declare:

- typed `validWhen`;
- `maximumInvalidEvaluations`;
- constraint facts that can invalidate a score.

An invalid observation cannot complete the region, update accepted progress, replace the best result, or alter patience.

### 6.6 Select evaluation purpose

Use:

- `development` for repeated optimization feedback;
- `probe` for changed conditions that test generalization or gaming;
- `holdout` for final-purpose evaluation.

Purpose does not establish trust.

### 6.7 Select evaluator trust

Declare:

- `transparent` when evaluator logic and data can be visible;
- `protected` when declared local artifacts must remain unchanged;
- `isolated` when evaluator logic or expected results are outside the model workspace.

The local runtime currently supports transparent and protected execution. It rejects isolated definitions until an isolated adapter exists.

Protected local files are not secret holdout data. Do not claim trusted holdout acceptance without isolated execution.

### 6.8 Bound feedback

Use aggregate feedback by default.

Use bounded diagnostics only when stable diagnostic codes materially help the next iteration. Set a maximum item count.

Do not expose raw reports that contain protected cases, answers, membership identifiers, exact hidden constraints, or other shortcut information.

### 6.9 Bound evaluation attempts

Declare a total evaluation budget and relevant development, probe, or holdout limits.

Budget is consumed when the external evaluator starts. Failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts count.

### 6.10 Add anti-gaming probes

Identify plausible shortcuts that improve the score without improving the target.

For each material shortcut, add a constraint instrument or probe when feasible.

Useful outputs include:

- `evaluation.probe-score`;
- `evaluation.probe-gap`;
- `evaluation.generalization-valid`;
- `evaluation.capacity-valid`;
- `evaluation.strategy-change-required`.

Do not use model judgement as a deterministic strategy-difference test.

## 7. Deterministic authoring advisories

`hypagraph_define` performs normal hard validation first.

After a valid definition is accepted, Hypagraph performs a pure structural assessment and returns non-blocking advisories for provable authoring weaknesses.

Current advisory codes include:

- `evaluation_policy_undeclared`;
- `evaluation_trust_undeclared`;
- `holdout_requires_isolated_authoring`;
- `evaluation_budget_undeclared`;
- `evaluation_validity_undeclared`;
- `progress_source_not_metric_report`;
- `probe_evaluation_undeclared`;
- `raw_evaluator_report_exposed`.

Warnings identify contract weaknesses that should normally be corrected.

Recommendations identify context-dependent improvements, such as adding a probe when generalization risk is material.

The assessment does not decide whether a semantic metric is good. Model authoring and repository evidence make that decision. Deterministic validation and advisories only check the declared structure.

Workflows without metric evaluation or numeric progress receive no evaluation-authoring advisory.

## 8. Questions

Ask a user question only when a safe graph cannot be inferred because of:

- ambiguous product intent;
- a destructive choice;
- conflicting explicit requirements;
- missing external authority;
- an unresolved material trade-off;
- a metric target or acceptance threshold that cannot be inferred from repository evidence.

Do not ask:

- how many nodes the graph should contain;
- which node or edge kind to use;
- whether a condition should be a gate;
- whether repeated work should be a loop;
- how the graph should be laid out;
- whether the user wants transparent or protected trust when repository evidence makes the boundary clear.

Those are Hypagraph authoring decisions.

## 9. Inspection and revision

The graph remains inspectable through the Pi graph pane and text summaries.

A user can revise work in normal language. The model translates the change into `hypagraph_revise` operations and preserves unaffected completed work when safe.

Authoring advisories remain visible in workflow summaries until the definition is revised.

The user can discuss the work model without learning the schema.

## 10. Architecture boundary

Model reasoning performs:

- repository interpretation;
- intent preservation;
- task decomposition;
- metric defensibility analysis;
- constraint and probe identification;
- authoring choices.

Deterministic code performs:

- graph validation;
- structural authoring assessment;
- readiness calculation;
- state transitions;
- check execution;
- gate evaluation;
- loop and evaluation decisions;
- evidence enforcement;
- persistence;
- replay.

Automatic authoring must not move deterministic runtime authority into the prompt.

The deterministic assessment must not claim that it can judge semantic metric quality.

## 11. Acceptance criteria

This product direction is met when:

- a normal coding request activates Hypagraph without graph terminology;
- a supplied plan becomes an executable graph automatically;
- a small task produces a small graph;
- complex work receives only the dependencies, checks, gates, loops, and evaluators it needs;
- a defensible metric produces an explicit target, validity, progress, success, feedback, trust, and budget contract;
- an objective without a defensible metric remains non-metric;
- weak but valid evaluation contracts return precise non-blocking advisories;
- authoring asks about user intent rather than graph design;
- generated graphs preserve scope and constraints;
- users can inspect and revise the graph in normal language;
- runtime validation remains authoritative.
