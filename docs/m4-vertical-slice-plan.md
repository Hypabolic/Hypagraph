# M4 executable bounded loops vertical-slice plan

- Status: planned
- Milestone: M4
- Release marker: v0.5
- Prerequisite: v0.4
- Selected before: M3.1 parser adapters
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

M4 makes declared cyclic graph regions executable.

A loop is not a model instruction to repeat work. It is a deterministic runtime region with a typed success condition, a hard iteration limit, optional progress rules, durable iteration history, and an explicit exit reason.

M4 must let a Pi user run a repair loop in which:

1. An entry node starts iteration 1.
2. Task, gate, and check nodes run with their existing node rules.
3. The runtime evaluates the loop after the declared evaluation node reaches a terminal verification result.
4. A true success condition completes the loop.
5. A false success condition follows the declared feedback edge and starts the next iteration.
6. The runtime stops at the hard iteration limit or after the configured patience limit.
7. Restore and replay produce the same loop decision without running a command again.

M3.1 parser adapters are deferred until v0.5 is complete.

## 2. Product result

At the end of M4, a user can:

1. Define one bounded loop as part of a workflow.
2. Use an existing typed condition as the loop success condition.
3. Use task, gate, and command-check nodes inside the loop.
4. Run more than one loop iteration.
5. See facts and gate routes reset for the new iteration.
6. Keep prior attempts, results, evidence, and artifacts in history.
7. Let a failed evaluation check drive another repair iteration.
8. Stop after success, the hard limit, or no progress.
9. See the current iteration and exit reason in Pi.
10. Restore the session without starting an executor.
11. Replay the event stream and obtain the same loop state and decision.

## 3. Mandatory architecture rules

### 3.1 Keep the reducer pure

The reducer must not:

- start a process;
- read or write a file;
- call Pi;
- read the clock;
- create an ID;
- use model judgement;
- calculate progress from unstructured text.

The command supplies time and IDs. The reducer validates commands, evaluates typed conditions, compares numeric progress values, and returns events.

### 3.2 Keep node semantics

M4 must not add a loop node kind.

A loop contains normal task, gate, and check nodes. These nodes keep their existing attempt, fact, evidence, verification, retry, and cancellation rules.

The loop runtime controls when the region starts, when current iteration state resets, and when work can leave the region.

### 3.3 Use a single-entry and single-exit iteration region

For v0.5, each loop is a structured iteration region.

The validator must require:

- one declared entry node;
- one declared evaluation node;
- all external incoming dependencies to target the entry node;
- all external outgoing dependencies to originate from the evaluation node;
- each feedback edge to start at the evaluation node;
- each feedback edge to end at the entry node;
- removal of the feedback edges to make the loop subgraph acyclic;
- every loop node to be reachable from the entry node after feedback-edge removal;
- the evaluation node to be reachable from every loop node after feedback-edge removal;
- the loop node set to remain equal to one cyclic strongly connected component.

The entry and evaluation nodes must be task or check nodes in v0.5. A gate can exist inside the iteration region, but it cannot be the entry or evaluation boundary.

These rules make one iteration a directed acyclic graph from entry to evaluation.

### 3.4 Use the existing condition abstract syntax tree

`successWhen` must become a typed `Condition` value. It must not remain executable free text.

The validator must:

- check condition structure and complexity;
- check fact names and types;
- allow upstream facts and facts produced inside the loop;
- reject facts that cannot exist before the evaluation boundary;
- record the condition semantics version with each decision.

The runtime evaluates success without model judgement.

### 3.5 Separate success from progress

Success answers this question:

> Can the loop stop with a successful result?

Progress answers this question:

> Is the current iteration better than the best prior iteration?

A loop can improve without succeeding. A loop can also succeed without producing the best metric value.

The optional progress policy is:

```ts
interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}
```

The progress fact must be numeric.

An improvement must exceed `minDelta`. The default value is zero.

`patience` is valid only when `progress` exists.

### 3.6 Make every decision bounded and ordered

At the evaluation boundary, use this order:

1. Validate that the current iteration can be evaluated.
2. Evaluate the typed success condition.
3. Read and record the progress metric when one exists.
4. Update the best metric and best iteration.
5. Complete the loop when success is true and the evaluation node passed verification.
6. Fail at `max_iterations` when the hard limit is reached.
7. Fail at `no_progress` when patience is exhausted.
8. Otherwise start the next iteration.

The hard limit is mandatory. Patience is an optional earlier stop.

### 3.7 Treat a failed evaluation check as an observation

A failed command check at the evaluation boundary can be a valid loop observation.

When it published the required facts, the runtime can evaluate the loop after verification fails:

- a false success condition can start the next iteration;
- a true success condition cannot complete the loop unless the evaluation node passed verification;
- missing or invalid evaluation facts fail the loop with `evaluation_error`;
- failure of a non-evaluation node does not automatically start another iteration.

This rule lets a failing test check send control back to a repair task without using model judgement.

### 3.8 Isolate current iteration state

When the runtime starts a new iteration, it must:

- keep all prior attempts;
- keep prior check results and artifacts;
- keep prior events;
- remove current facts produced by loop nodes;
- remove current gate route selections inside the loop;
- clear current node evidence inside the loop;
- clear current attempt pointers;
- reset all loop nodes to `pending`;
- make only the entry frontier ready;
- assign new attempt IDs when nodes run again.

Facts and attempts created inside a loop must include the loop ID and iteration number.

A stale result from an older iteration must not change current state.

### 3.9 Use the loop as a downstream barrier

A node outside the loop must not become ready because an internal loop node completed an unsuccessful iteration.

External dependencies from the loop become satisfied only after the loop runtime succeeds.

This rule prevents a transient successful node state from releasing downstream work before the loop decision.

### 3.10 Preserve durable boundaries

Loop events use the existing event store and optimistic sequence checks.

A loop decision and its state-reset events must be in the same accepted command batch. A host crash must not leave the workflow between a `continue` decision and the next iteration reset.

A command check inside a loop keeps the M3 durable order:

```text
store check start
    |
    v
run command
    |
    v
store facts
    |
    v
store raw result
    |
    v
store verification and loop decision
```

Restore must not run a node or check.

## 4. Canonical model

### 4.1 Definition

M4 changes the loop definition to:

```ts
interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: Condition;
  maxIterations: number;
  progress?: LoopProgressDefinition;
  patience?: number;
}
```

### 4.2 Runtime

Add canonical loop runtime state:

```ts
type LoopStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "requires_revision";

type LoopExitReason =
  | "success"
  | "max_iterations"
  | "no_progress"
  | "evaluation_error"
  | "node_failed"
  | "cancelled";

interface LoopIterationRuntime {
  iteration: number;
  startedAt: string;
  evaluatedAt?: string;
  evaluationEventId?: string;
  success?: boolean;
  decision?: "complete" | "continue" | "fail";
  factsUsed?: string[];
  metric?: number;
  improved?: boolean;
}

interface LoopRuntime {
  loopId: string;
  status: LoopStatus;
  iteration: number;
  startedAt?: string;
  completedAt?: string;
  exitReason?: LoopExitReason;
  noProgressCount: number;
  bestMetric?: number;
  bestIteration?: number;
  iterations: LoopIterationRuntime[];
}
```

Add `runtime.loops` to `HypagraphState`.

Attempts and facts can include:

```ts
loopId?: string;
loopIteration?: number;
```

### 4.3 Events

Initial M4 event types are:

- `hypagraph.loop.iteration-started`;
- `hypagraph.loop.evaluated`;
- `hypagraph.loop.completed`;
- `hypagraph.loop.failed`;
- `hypagraph.loop.cancelled`;
- `hypagraph.loop.invalidated`.

The evaluation event records:

- loop ID;
- iteration number;
- success value;
- facts used;
- condition semantics version;
- optional metric;
- optional best metric;
- optional best iteration;
- no-progress count;
- decision;
- exit reason when applicable.

The event must contain the decision result. Replay must not calculate a different decision from later facts.

### 4.4 Commands

Do not add a public command that lets a model select `continue` or `complete`.

The runtime starts iteration 1 when the user starts the ready entry node. It evaluates the loop automatically when the evaluation node completes verification.

An internal helper can produce the loop event batch. The helper remains pure.

Add explicit cancellation or invalidation commands only when a later slice requires them. Do not let a view action change loop state.

## 5. Schema and migration

M4 requires snapshot schema version 3 because canonical loop runtime is new.

Migration rules:

1. A valid version 2 snapshot without loops migrates automatically.
2. A valid version 2 snapshot with textual `successWhen` values remains readable.
3. Migration stores the old text as legacy predicate data and sets the loop runtime to `requires_revision`.
4. The runtime rejects execution of that loop with `loop_predicate_revision_required`.
5. A definition revision must replace the legacy text with a typed condition before execution.
6. Migration must not guess how to parse old predicate text.

New Pi definitions accept only the typed condition form.

## 6. Vertical slices

Each slice must cross the domain model, reducer, projection, persistence, Pi adapter, graph projection, tests, and documentation when those layers are affected. Do not implement M4 as disconnected component layers.

### Slice 1 - Execute one successful iteration

- Status: complete

#### User result

A user can define a typed structured loop, run its entry-to-evaluation path one time, satisfy the success condition, and release downstream work.

#### Add

- typed `successWhen` condition;
- structured loop-region validation;
- schema version 3 and migration framework;
- `runtime.loops`;
- loop iteration metadata on attempts and facts;
- `hypagraph.loop.iteration-started`;
- `hypagraph.loop.evaluated`;
- `hypagraph.loop.completed`;
- loop-aware workflow completion;
- downstream loop barrier;
- Pi definition support;
- graph and text status for iteration 1 and loop success.

#### Rules

- Starting the entry node starts iteration 1 before the attempt-start event.
- Only the declared entry can start an inactive loop.
- The evaluation node triggers the loop decision after verification.
- Success requires a true condition and successful verification of the evaluation node.
- No feedback continuation is available in this slice.

#### Tests

- accept a valid single-entry and single-exit region;
- reject invalid loop boundaries;
- reject a free-text success predicate in a new definition;
- start iteration 1 before the entry attempt;
- bind facts and attempts to iteration 1;
- block external dependants before loop success;
- complete the loop when the condition is true;
- release downstream work after loop success;
- replay to the same state and hash;
- migrate a version 2 snapshot without loops;
- mark a legacy textual loop as `requires_revision`.

#### Done when

A one-iteration loop completes through the real Pi transition and check paths.

### Slice 2 - Follow feedback and start iteration 2

- Status: implemented

#### User result

A false success condition resets the loop region and makes the entry ready for iteration 2.

#### Add

- `continue` loop decisions;
- automatic `hypagraph.loop.iteration-started` for the next iteration;
- loop node reset;
- current fact removal;
- current route removal;
- evidence and current-attempt reset;
- prior attempt and artifact retention;
- stable iteration history;
- graph redraw for the new iteration.

#### Rules

- The evaluation and reset events are one command batch.
- The new iteration starts without a model-selected feedback route.
- Only declared feedback edges can continue the loop.
- The runtime does not reuse attempt IDs.
- Facts from iteration 1 cannot satisfy iteration 2 conditions.

#### Tests

- false success starts iteration 2;
- the entry becomes ready again;
- internal branches and joins reset;
- prior gate routes do not leak into the next iteration;
- prior facts do not leak into the next iteration;
- attempts, results, evidence, and artifacts remain in history;
- stale iteration 1 facts and results are rejected;
- replay reproduces the reset and ready frontier.

#### Done when

A task-based repair loop runs two iterations and keeps correct history.

### Slice 3 - Run a check-driven repair loop

- Status: implemented

#### User result

A failing evaluation check publishes facts, sends control back to the repair entry, and a later passing check completes the loop.

#### Add

- evaluation after failed verification at the declared evaluation node;
- observation rules for failed command checks;
- durable loop decisions in the check verification batch;
- restore and recovery rules for checks inside loop iterations;
- iteration-aware late-result rejection;
- Pi guidance for check-driven loops.

#### Rules

- A failed evaluation check can continue only when required facts are present and valid.
- A failed non-evaluation node does not continue the loop automatically.
- A true success condition cannot complete a loop when the evaluation node failed verification.
- Check retry and loop iteration are separate controls.
- A check retry stays in the same loop iteration.
- A loop continuation creates the next loop iteration.

#### Tests

- failed evaluation check publishes `passed: false` and continues;
- successful later check exits;
- check retry does not increment the loop iteration;
- loop continuation does not reuse the check attempt;
- restore after a stored raw result completes the same loop decision;
- restore before a raw result records interruption without command rerun;
- a late result from an old loop iteration cannot publish facts.

#### Done when

The principal repair-loop product path works through `hypagraph_run_check`.

### Slice 4 - Enforce the hard iteration limit

- Status: implemented

#### User result

A loop that never succeeds stops at `maxIterations` with an explicit failure reason.

#### Add

- `hypagraph.loop.failed`;
- `max_iterations` exit reason;
- workflow failure after loop exhaustion;
- terminal loop status in Pi and graph projections;
- explicit diagnostics when a user tries to continue an exhausted loop.

#### Rules

- The runtime evaluates the final iteration before it reports exhaustion.
- A successful final iteration completes normally.
- An unsuccessful final iteration fails the loop and workflow.
- No node in the exhausted loop can start again.

#### Tests

- stop exactly at the hard limit;
- succeed on the final allowed iteration;
- reject another entry attempt after exhaustion;
- keep all final iteration facts, attempts, and artifacts in history;
- replay gives the same exit reason.

#### Done when

No executable loop can run without a deterministic hard stop.

### Slice 5 - Add progress, loss, best result, and patience

- Status: implemented

#### User result

A user can define a numeric progress metric and stop a loop when it does not improve.

#### Add

- `LoopProgressDefinition`;
- numeric progress-fact validation;
- minimize and maximize directions;
- `minDelta`;
- best metric and best iteration state;
- no-progress count;
- `no_progress` exit reason;
- patience validation and execution;
- Pi display of metric, best result, and remaining patience.

#### Rules

- The first valid metric becomes the best metric.
- An equal metric is not an improvement.
- Improvement must exceed `minDelta`.
- Missing or non-numeric metric data fails with `evaluation_error`.
- Success remains independent of progress.
- Record progress before applying hard-limit or patience decisions.
- Use decision order from section 3.6.

#### Tests

- minimize and maximize metrics;
- first metric selection;
- exact `minDelta` boundaries;
- best iteration retention;
- patience reset after improvement;
- patience increment after no improvement;
- success without improvement;
- improvement without success;
- simultaneous hard-limit and patience condition uses the defined order;
- replay reproduces all metric decisions.

#### Done when

A loop can stop safely on hard bounds and on lack of progress.

### Slice 6 - Harden revision, cancellation, and recovery

#### User result

A running loop remains correct across session restore, branch changes, cancellation, and graph revision.

#### Add

- active-loop revision rules;
- `hypagraph.loop.invalidated`;
- loop cancellation projection;
- loop-aware session branch protection;
- restore validation for current iteration state;
- orphaned active-attempt handling inside a loop;
- optimistic sequence conflict tests for loop batches;
- migration completion tests.

#### Rules

- Reject a graph revision while an attempt in the loop is active.
- A revision that changes a loop definition or loop node invalidates that loop runtime.
- A revised loop starts again at iteration 1 only after its entry becomes ready.
- Cancellation of an active attempt keeps the loop terminal or blocked until an explicit supported action occurs.
- Session restore does not start the entry or evaluation node.
- A branch change rejects results from the old branch and old iteration.

#### Tests

- reject active-loop revision;
- invalidate a completed loop after a relevant revision;
- preserve an unchanged completed loop when safe;
- cancel an active loop check;
- reject a late result after cancellation or branch change;
- restore every event boundary around evaluation and continuation;
- reject sequence conflicts without partial reset.

#### Done when

A crash, restore, revision, or cancellation cannot create an unbounded or ambiguous loop state.

### Slice 7 - Complete the Pi loop product surface

#### User result

A Pi user can understand why a loop is running, continuing, complete, or failed without reading raw events.

#### Add

- loop runtime in `hypagraph_read`;
- compact loop summaries;
- `/hypagraph loop` status output;
- graph-pane iteration, metric, patience, and exit details;
- ready-frontier behavior after continuation;
- loop-specific tool guidance;
- clear diagnostics for legacy predicates, exhausted loops, and evaluation errors.

#### Graph pane

Show:

- loop status;
- current iteration and hard limit;
- evaluation node;
- selected feedback edge;
- last success result;
- current metric;
- best metric and iteration;
- no-progress count and patience;
- exit reason.

The graph pane stays read-only. It must not contain a control that selects a loop decision.

#### Tests

- live redraw after iteration start, evaluation, continuation, completion, and failure;
- wide and narrow terminal layouts;
- current and best metric formatting;
- legacy predicate warning;
- no canonical state change from graph navigation;
- structured read output matches canonical loop runtime.

#### Done when

The live Pi surface explains the loop state and decision from the canonical projection.

### Slice 8 - Dogfood and v0.5 release

#### User result

The complete M4 path is proven in Pi and released as v0.5.

#### Required dogfood graph

```text
bootstrap
    |
    v
implement <------------------+
    |                         |
    v                         |
run-tests                     |
    |                         |
    v                         |
tests.passed == true ? -------+
    | true          | false
    v               |
document            + feedback to implement
```

The dogfood run must include at least three iterations:

1. An unsuccessful evaluation with an initial metric.
2. An unsuccessful evaluation with an improved metric.
3. A successful evaluation that exits the loop.

Also run separate fixtures for:

- hard-limit exhaustion;
- patience exhaustion;
- cancellation;
- restore between iterations;
- restore after a raw check result and before loop evaluation;
- a stale late result from an old iteration.

#### Documentation

Update:

- `README.md`;
- `docs/execution-roadmap.md`;
- event documentation;
- persistence documentation;
- Pi tool and command guidance;
- graph-pane guidance;
- example loop definitions;
- migration notes;
- release notes.

#### Release checks

- all M4 acceptance tests pass;
- CI passes on Ubuntu, macOS, and Windows;
- CI passes on Node.js 22 and 24;
- the dogfood result is recorded;
- package and lock-file versions are 0.5.0;
- the v0.5.0 tag is created from a tested main commit.

#### Done when

A Pi user can run a bounded check-driven repair loop through multiple iterations, see deterministic progress and exit decisions, restore without rerun, and replay the same result.

## 7. Cross-slice test strategy

### 7.1 Determinism

For every loop command and event batch:

- the same state and command produce the same events;
- the same ordered events produce the same snapshot hash;
- events contain the stored decision result;
- replay does not use the current clock or executor;
- property tests vary loop DAG shape, branches, iteration count, and metric values.

### 7.2 Safety properties

Property and example tests must prove:

- iteration never exceeds `maxIterations`;
- only declared feedback edges continue a loop;
- an external node cannot become ready before loop success;
- a new iteration has no current facts from a prior iteration;
- attempt IDs are not reused;
- a stale iteration result cannot change current state;
- patience cannot be used without a progress metric;
- a loop decision cannot depend on untyped text;
- one loop event batch cannot partially commit.

### 7.3 Platform behavior

Command checks inside loops must keep the existing process tests on Linux, macOS, and Windows.

M4 does not add shell execution or a new process runner.

## 8. Out of scope for v0.5

The following work is not part of M4:

- nested loops;
- overlapping loops;
- parallel loop iterations;
- more than one active node attempt;
- model-scored success or progress;
- progress extracted from unstructured text;
- automatic restoration of the best workspace contents;
- automatic check retry controlled by the loop;
- JUnit, lint, coverage, file, or Git parser adapters;
- event-timeline navigation;
- revision comparison UI;
- graph debugger mutation controls;
- delegated node execution.

Parser adapters remain deferred until after v0.5. Replay navigation and debugger actions remain M5 work.

## 9. Implementation order

Implement in this order:

1. Slice 1: one successful iteration;
2. Slice 2: feedback continuation;
3. Slice 3: check-driven repair;
4. Slice 4: hard limit;
5. Slice 5: progress and patience;
6. Slice 6: revision and recovery hardening;
7. Slice 7: Pi product surface;
8. Slice 8: dogfood and release.

Do not start with progress metrics or Pi controls. First prove the canonical iteration lifecycle and feedback reset.

## 10. M4 exit criteria

M4 is complete when:

- new loop definitions use typed success conditions;
- only structured declared regions can execute;
- the runtime can complete one iteration;
- the runtime can follow feedback into later iterations;
- current iteration facts and routes are isolated;
- a failed evaluation check can drive repair;
- the hard iteration limit always stops the loop;
- optional progress and patience decisions are deterministic;
- loop attempts and facts identify their iteration;
- downstream work waits for loop success;
- restore does not run a node or check;
- replay gives the same decisions and state hash;
- Pi shows current iteration, progress, and exit reason;
- the real Pi dogfood path passes;
- v0.5.0 is tagged from a tested main commit.
