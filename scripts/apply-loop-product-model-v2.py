from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old[:140]!r}")
    file.write_text(text.replace(old, new, 1))


def insert_before_once(path: str, marker: str, content: str) -> None:
    file = Path(path)
    text = file.read_text()
    if marker not in text:
        raise SystemExit(f"Required marker was not found in {path}: {marker[:140]!r}")
    file.write_text(text.replace(marker, content + marker, 1))


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


# README
replace_once(
    "README.md",
    "Hypagraph is a graph workflow extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). It turns a coding plan into an explicit graph of tasks, checks, decisions, and bounded repair loops.",
    "Hypagraph is a graph workflow extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). It turns a coding plan into an explicit graph of tasks, checks, decisions, and bounded iteration regions.",
)
replace_once(
    "README.md",
    """```mermaid
flowchart LR
    A[Implement change] --> B[Run checks]
    B --> C{Checks pass?}
    C -- Yes --> D[Document result]
    C -- No --> E[Repair failure]
    E -. bounded retry .-> B
```""",
    """```mermaid
flowchart LR
    A[Prepare candidate] --> B[Evaluate result]
    B --> C{Success condition met?}
    C -- Yes --> D[Publish result]
    C -- No --> E[Start next iteration]
    E -. bounded feedback .-> A
```""",
)
replace_once(
    "README.md",
    "- **Bound repair cycles:** declared loops have explicit limits and success conditions.",
    "- **Run bounded iteration:** declared loop regions have typed success conditions, hard limits, and optional progress and patience rules.",
)
replace_once(
    "README.md",
    "Hypagraph is useful for repository changes that have dependencies, conditional paths, mandatory checks, or repeat-until-passing work.",
    "Hypagraph is useful for repository changes that have dependencies, conditional paths, mandatory checks, or bounded repeated work.",
)
replace_once(
    "README.md",
    """```text
Create a Hypagraph workflow for this change:

1. Inspect the current authentication flow.
2. Implement refresh-token rotation.
3. Run the repository checks.
4. If the checks fail, repair the implementation and run them again.
5. When the checks pass, update the authentication documentation.

Limit the repair loop to three iterations. Keep implementation changes inside src/auth/** and tests/auth/**.
```""",
    """```text
Create a Hypagraph workflow for this migration:

1. Inspect the modules that still use the old parser.
2. Migrate one bounded batch of modules.
3. Run compatibility checks and publish migration.remaining.
4. Continue the batch loop until migration.remaining is zero.
5. Update the migration record.

Limit the batch loop to six iterations. Keep changes inside src/parser/** and tests/parser/**.
```""",
)
replace_once(
    "README.md",
    """A typical run looks like this:

1. Hypagraph validates and stores the graph.
2. The first dependency-free nodes become ready.
3. The agent completes a task and submits evidence.
4. Hypagraph runs the declared command check.
5. The check publishes typed facts such as `tests.passed`.
6. A gate selects the success or repair route.
7. A failed route can enter a bounded repair loop.
8. The workflow completes only when its selected path is complete.""",
    """A typical run looks like this:

1. Hypagraph validates and stores the graph.
2. The first dependency-free nodes, including eligible loop entries, become ready.
3. The agent completes a task and submits evidence.
4. Checks or task nodes publish typed facts.
5. Gates select deterministic routes from those facts.
6. A loop evaluates its typed success condition at its declared boundary.
7. A false result can follow declared feedback and start another bounded iteration.
8. The workflow completes only when its required graph components reach a valid terminal result.""",
)
replace_once(
    "README.md",
    "## Example: check, route, and repair",
    """## Example: check, route, and repair

Repair is one common use of an iteration region. It is not a special loop type.""",
)
replace_once("README.md", "### Bounded loops", "### Bounded iteration regions")
replace_once(
    "README.md",
    "A loop declares a feedback edge, an iteration region, a success condition, and a hard iteration limit. Hypagraph can use it for test-and-repair work without allowing an unbounded agent loop.",
    "A loop declares feedback, an iteration region, a typed success condition, and a hard iteration limit. It can model refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or test-and-repair work. A loop can connect to the main graph or form an independent graph component.",
)
replace_once(
    "README.md",
    "M4 is in progress. Slices 1 to 5 provide multi-iteration task and check repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
    "M4 is in progress. Slices 1 to 5 provide generic multi-iteration regions, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add independent-region outcome policy, recovery hardening, and the complete Pi loop surface.",
)
replace_once(
    "README.md",
    "- [M4 executable bounded loops plan](docs/m4-vertical-slice-plan.md)",
    """- [Loop-region product model](docs/loop-region-product-model.md)
- [M4 executable bounded iteration regions plan](docs/m4-vertical-slice-plan.md)""",
)

# Product specification
replace_once("docs/product-spec.md", "4. bounded feedback and repair loops.", "4. bounded feedback and iteration regions.")
replace_once(
    "docs/product-spec.md",
    "Flat plans encode sequence but not dependency, hide blocked states, accept narrative completion claims, and handle failed verification through unstructured replanning. Hypagraph represents work as bounded node contracts connected by explicit dependency, route, data, and feedback edges.",
    "Flat plans encode sequence but not dependency, hide blocked states, accept narrative completion claims, and handle repeated work through unstructured replanning. Hypagraph represents work as bounded node contracts connected by explicit dependency, route, data, and feedback edges.",
)
replace_once(
    "docs/product-spec.md",
    """### Loop regions

Every cyclic strongly connected component must be explicitly declared. A loop defines entry and evaluation points, feedback edges, success conditions, progress objectives, patience, and hard budgets.

A Boolean success condition determines whether the loop may exit successfully. A separate loss or progress objective determines whether unsuccessful iterations are improving.""",
    """### Loop regions

A loop is a first-class bounded iteration region. It contains normal task, gate, and check nodes. The node contracts define what the loop does. Hypagraph must not encode repair as a loop type or as an implicit loop purpose.

Every cyclic strongly connected component must be explicitly declared. A loop defines entry and evaluation points, feedback edges, success conditions, progress objectives, patience, hard budgets, and failure policy.

A Boolean success condition determines whether the loop may exit successfully. A separate loss or progress objective determines whether unsuccessful iterations are improving.

A loop can model refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or repair.

### Independent loop regions

A loop can connect to the wider graph through its entry and evaluation boundaries. It can also be a disconnected top-level graph component.

Topological independence must also provide state independence. Facts, routes, attempts, iteration counters, progress values, and exit decisions from one loop must not change another loop unless an explicit graph dependency connects them.

A loop failure policy controls whether a failed region fails the complete workflow, blocks only its dependants, or records the failure while unrelated work continues.

The graph projection can show a loop region as one compound graph element with an inspectable internal graph. This gives Hypagraph a hypergraph-like composition without changing the deterministic node and edge kernel.""",
)
replace_once(
    "docs/product-spec.md",
    "7. Delegated mutations occur in isolated workspace leases before integration.",
    """7. Delegated mutations occur in isolated workspace leases before integration.
8. A loop has no implicit repair semantics.
9. An independent loop cannot release, fail, or reset an unrelated graph component.
10. Loop failure and workflow failure are separate decisions controlled by explicit policy.""",
)
replace_once(
    "docs/product-spec.md",
    "Loop iteration, gate evaluation, deterministic check runners, graph visualisation, delegated executors, and bounded parallel scheduling remain planned work.",
    "Multi-iteration loop execution is in progress. Independent-region outcome policy, delegated executors, and bounded parallel scheduling remain planned work.",
)

# Execution roadmap
replace_once("docs/execution-roadmap.md", "| M4 | v0.5 | Executable bounded loops |", "| M4 | v0.5 | Executable bounded iteration regions |")
replace_once(
    "docs/execution-roadmap.md",
    "7. Run bounded repair loops.",
    "7. Run bounded iteration regions for refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, and repair.",
)
replace_once(
    "docs/execution-roadmap.md",
    """Execute declared cyclic regions as deterministic bounded iteration regions.

A valid v0.5 loop has one entry, one evaluation boundary, typed success rules, declared feedback, a hard iteration limit, and optional numeric progress and patience rules.""",
    """Execute declared cyclic regions as deterministic bounded iteration regions.

A valid v0.5 loop has one entry, one evaluation boundary, typed success rules, declared feedback, a hard iteration limit, optional numeric progress and patience rules, and an explicit failure policy.

A loop can be connected to the main graph or be an independent graph component. Repair is one use case. It is not a loop type.""",
)
replace_once(
    "docs/execution-roadmap.md",
    """1. Execute one successful iteration.
2. Follow feedback and start iteration 2.
3. Run a check-driven repair loop.
4. Enforce the hard iteration limit.
5. Add progress, loss, best result, and patience.
6. Harden revision, cancellation, and recovery.
7. Complete the Pi loop product surface.
8. Dogfood and release v0.5.""",
    """1. Execute one successful iteration.
2. Follow feedback and start iteration 2.
3. Support a failed evaluation check as one loop observation.
4. Enforce the hard iteration limit.
5. Add progress, loss, best result, and patience.
6. Add independent loop regions and explicit outcome policy.
7. Harden revision, cancellation, and recovery.
8. Complete the Pi loop product surface.
9. Dogfood and release v0.5.""",
)
replace_once(
    "docs/execution-roadmap.md",
    """- selected feedback edge;
- iteration history;
- exit reason.""",
    """- selected feedback edge;
- iteration history;
- exit reason;
- failure policy;
- graph-component identity.""",
)
replace_once("docs/execution-roadmap.md", "- [ ] A failed evaluation check can drive a repair iteration.", "- [ ] A failed evaluation check can provide a valid loop observation.")
replace_once(
    "docs/execution-roadmap.md",
    """- [ ] Pi shows current iteration, progress, and exit reason.
- [ ] The v0.5 dogfood and release checks pass.""",
    """- [ ] Pi shows current iteration, progress, and exit reason.
- [ ] Two disconnected loop regions can run without state coupling.
- [ ] A loop failure policy determines its effect on the workflow and its dependants.
- [ ] The domain model and public guidance do not assign repair semantics to loops.
- [ ] The v0.5 dogfood and release checks pass.""",
)
replace_once("docs/execution-roadmap.md", "Run independent delegated nodes safely.", "Run independent delegated nodes and loop regions safely.")
replace_once(
    "docs/execution-roadmap.md",
    """- Independent nodes can run together.
- Conflicting nodes cannot run together.""",
    """- Independent nodes can run together.
- Independent loop regions can overlap in execution when budgets permit.
- Conflicting nodes and loop regions cannot run together.""",
)
replace_once("docs/execution-roadmap.md", "- loops are bounded and replayable;", "- iteration regions are bounded, policy-driven, independent when disconnected, and replayable;")

# M4 plan
replace_once("docs/m4-vertical-slice-plan.md", "# M4 executable bounded loops vertical-slice plan", "# M4 executable bounded iteration regions vertical-slice plan")
replace_once("docs/m4-vertical-slice-plan.md", "- Status: planned", "- Status: active")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """M4 makes declared cyclic graph regions executable.

A loop is not a model instruction to repeat work. It is a deterministic runtime region with a typed success condition, a hard iteration limit, optional progress rules, durable iteration history, and an explicit exit reason.

M4 must let a Pi user run a repair loop in which:

1. An entry node starts iteration 1.
2. Task, gate, and check nodes run with their existing node rules.
3. The runtime evaluates the loop after the declared evaluation node reaches a terminal verification result.
4. A true success condition completes the loop.
5. A false success condition follows the declared feedback edge and starts the next iteration.
6. The runtime stops at the hard iteration limit or after the configured patience limit.
7. Restore and replay produce the same loop decision without running a command again.""",
    """M4 makes declared cyclic graph regions executable.

A loop is a first-class bounded iteration region. It is not a model instruction to repeat work, and it is not a repair-specific construct. It is a deterministic runtime region with a typed success condition, a hard iteration limit, optional progress rules, durable iteration history, explicit outcome policy, and an explicit exit reason.

M4 must let a Pi user run an iteration region in which:

1. An entry node starts iteration 1.
2. Task, gate, and check nodes run with their existing node rules.
3. The runtime evaluates the loop after the declared evaluation node reaches a terminal verification result.
4. A true success condition completes the loop.
5. A false success condition follows declared feedback and starts the next iteration.
6. The runtime stops at the hard iteration limit or after the configured patience limit.
7. The region outcome policy controls the effect of failure on the wider workflow.
8. A disconnected region can run without state coupling to another graph component.
9. Restore and replay produce the same loop decision without running a command again.

The same model must support refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, and repair.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """1. Define one bounded loop as part of a workflow.
2. Use an existing typed condition as the loop success condition.
3. Use task, gate, and command-check nodes inside the loop.
4. Run more than one loop iteration.
5. See facts and gate routes reset for the new iteration.
6. Keep prior attempts, results, evidence, and artifacts in history.
7. Let a failed evaluation check drive another repair iteration.
8. Stop after success, the hard limit, or no progress.
9. See the current iteration and exit reason in Pi.
10. Restore the session without starting an executor.
11. Replay the event stream and obtain the same loop state and decision.""",
    """1. Define one bounded iteration region as part of a workflow.
2. Use an existing typed condition as the loop success condition.
3. Use task, gate, and command-check nodes inside the region.
4. Run more than one iteration.
5. See facts and gate routes reset for the new iteration.
6. Keep prior attempts, results, evidence, and artifacts in history.
7. Use a failed evaluation check as one valid observation when its facts are complete.
8. Stop after success, the hard limit, or no progress.
9. Define how a failed region affects the workflow.
10. Define a loop as an independent graph component.
11. See the current iteration, progress, outcome policy, and exit reason in Pi.
12. Restore the session without starting an executor.
13. Replay the event stream and obtain the same loop state and decision.""",
)
replace_once("docs/m4-vertical-slice-plan.md", "### 3.3 Use a single-entry and single-exit iteration region", "### 3.3 Use a single-entry and single-evaluation iteration region")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """5. Complete the loop when success is true and the evaluation node passed verification.
6. Fail at `max_iterations` when the hard limit is reached.
7. Fail at `no_progress` when patience is exhausted.
8. Otherwise start the next iteration.""",
    """5. Complete the loop when success is true and the evaluation node passed verification.
6. Select `max_iterations` when the hard limit is reached.
7. Select `no_progress` when patience is exhausted.
8. Apply the failure policy when the loop has a failure exit reason.
9. Otherwise start the next iteration.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    "This rule lets a failing test check send control back to a repair task without using model judgement.",
    "This rule lets a failing test check provide a valid observation and follow feedback without using model judgement. It is one loop pattern, not the definition of a loop.",
)
insert_before_once(
    "docs/m4-vertical-slice-plan.md",
    "### 3.10 Preserve durable boundaries",
    """### 3.10 Support independent loop regions and explicit outcomes

A loop can have no external incoming or outgoing dependencies. In that case, it is an independent top-level graph component.

Independent means:

- the loop entry can become ready without another graph component;
- its facts, routes, attempts, progress values, and iteration resets remain local to the loop;
- its continuation does not reset or release an unrelated component;
- its failure does not fail the complete workflow unless its policy says to do so;
- its success does not satisfy an unrelated dependency.

Add this failure policy:

```ts
type LoopFailurePolicy =
  | "fail-workflow"
  | "block-dependants"
  | "record-and-continue";
```

The default is `fail-workflow` for compatibility.

Use these rules:

- `fail-workflow` makes loop failure a workflow failure.
- `block-dependants` keeps direct and transitive dependants blocked and lets unrelated ready work continue.
- `record-and-continue` records the failed region and lets unrelated work continue. A direct dependant still cannot pass the loop success barrier.
- All loop regions must reach a terminal state before the workflow lifecycle can complete.
- A recorded loop failure does not prevent a successful workflow result when it has no blocked required dependants and no `fail-workflow` policy applies.
- M4 can execute independent regions sequentially through the current one-active-attempt rule.
- M7 adds bounded concurrent dispatch for independent regions. M4 must not require a later domain-model change to add that concurrency.

The graph projection must show each loop as a compound region. A disconnected loop appears as a separate top-level component.

""",
)
replace_once("docs/m4-vertical-slice-plan.md", "### 3.10 Preserve durable boundaries", "### 3.11 Preserve durable boundaries")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: Condition;
  maxIterations: number;
  progress?: LoopProgressDefinition;
  patience?: number;
}""",
    """type LoopFailurePolicy =
  | "fail-workflow"
  | "block-dependants"
  | "record-and-continue";

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
  failurePolicy?: LoopFailurePolicy;
}""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- decision;
- exit reason when applicable.""",
    """- decision;
- exit reason when applicable;
- failure policy when failure applies;
- derived workflow effect when failure applies.""",
)
replace_once("docs/m4-vertical-slice-plan.md", "A task-based repair loop runs two iterations and keeps correct history.", "A task-based iteration region runs two iterations and keeps correct history.")
replace_once("docs/m4-vertical-slice-plan.md", "### Slice 3 - Run a check-driven repair loop", "### Slice 3 - Support failed evaluation checks as loop observations")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    "A failing evaluation check publishes facts, sends control back to the repair entry, and a later passing check completes the loop.",
    "A failing evaluation check can publish a complete observation, follow declared feedback, and let a later valid observation complete the loop.",
)
replace_once("docs/m4-vertical-slice-plan.md", "The principal repair-loop product path works through `hypagraph_run_check`.", "The failed-check observation pattern works through `hypagraph_run_check` without adding repair semantics to the loop model.")
replace_once("docs/m4-vertical-slice-plan.md", "- workflow failure after loop exhaustion;", "- default workflow failure after loop exhaustion before outcome policy is available;")
replace_once("docs/m4-vertical-slice-plan.md", "- An unsuccessful final iteration fails the loop and workflow.", "- An unsuccessful final iteration fails the loop. Slice 6 applies its failure policy to the workflow and dependants.")
insert_before_once(
    "docs/m4-vertical-slice-plan.md",
    "### Slice 6 - Harden revision, cancellation, and recovery",
    """### Slice 6 - Add independent loop regions and outcome policy

#### User result

A workflow can contain two disconnected loop regions. Each region keeps independent state, and one region can fail without terminating unrelated work when its policy permits that result.

#### Add

- `LoopFailurePolicy`;
- default `fail-workflow` migration behavior;
- disconnected-loop validation fixtures;
- loop-local fact, route, attempt, and progress isolation tests;
- workflow result aggregation across terminal loop regions;
- `block-dependants` behavior;
- `record-and-continue` behavior;
- graph-component identity in projections;
- compound-region rendering for disconnected loops;
- Pi status text for failure policy and local outcome.

#### Rules

- A disconnected loop is valid.
- Starting or continuing one loop must not reset another loop.
- A loop success releases only explicit dependants.
- A loop failure follows its declared policy.
- `record-and-continue` does not release dependants that require loop success.
- Unrelated ready nodes remain executable after a local loop failure.
- Workflow completion waits for every loop region to become terminal.
- Sequential execution in M4 must preserve the same semantics that M7 concurrency will use.

#### Tests

- validate two disconnected loops;
- make both entries ready;
- run iterations in interleaved order;
- prove that facts and route selections do not leak between loops;
- complete one loop while another remains active;
- fail one loop with each failure policy;
- keep unrelated work ready after `block-dependants` and `record-and-continue`;
- prevent direct dependants from passing a failed loop barrier;
- replay the same component outcomes and workflow result;
- render two top-level loop regions in Pi.

#### Done when

Loop regions are semantically independent when the graph does not connect them, even though M4 still dispatches one active attempt at a time.

""",
)
replace_once("docs/m4-vertical-slice-plan.md", "### Slice 6 - Harden revision, cancellation, and recovery", "### Slice 7 - Harden revision, cancellation, and recovery")
replace_once("docs/m4-vertical-slice-plan.md", "### Slice 7 - Complete the Pi loop product surface", "### Slice 8 - Complete the Pi loop product surface")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- no-progress count and patience;
- exit reason.""",
    """- no-progress count and patience;
- failure policy;
- graph-component identity;
- local outcome and workflow effect;
- exit reason.""",
)
replace_once("docs/m4-vertical-slice-plan.md", "### Slice 8 - Dogfood and v0.5 release", "### Slice 9 - Dogfood and v0.5 release")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """#### Required dogfood graph

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
- a stale late result from an old iteration.""",
    """#### Required dogfood workflows

Dogfood at least these loop purposes:

1. A refinement or optimization region that records a metric, improves, and succeeds.
2. A bounded batch-processing region that exits when no items remain.
3. A check-and-repair region that uses a failed check as an observation.
4. Two disconnected loop regions in one workflow.

The independent-region workflow must prove:

- both entries can become ready;
- the regions can run in interleaved order;
- one region can complete while the other continues;
- one region can use `record-and-continue` without terminating unrelated work;
- state, facts, routes, progress, and iteration resets do not cross region boundaries.

For the progress workflow, include at least three iterations:

1. An unsuccessful evaluation with an initial metric.
2. An unsuccessful evaluation with an improved metric.
3. A successful evaluation that exits the loop.

Also run separate fixtures for:

- hard-limit exhaustion;
- patience exhaustion;
- each failure policy;
- cancellation;
- restore between iterations;
- restore after a raw check result and before loop evaluation;
- a stale late result from an old iteration.""",
)
replace_once("docs/m4-vertical-slice-plan.md", "A Pi user can run a bounded check-driven repair loop through multiple iterations, see deterministic progress and exit decisions, restore without rerun, and replay the same result.", "A Pi user can run generic bounded iteration regions through multiple iterations, combine connected and independent regions, see deterministic progress and outcome decisions, restore without rerun, and replay the same result.")
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- patience cannot be used without a progress metric;
- a loop decision cannot depend on untyped text;
- one loop event batch cannot partially commit.""",
    """- patience cannot be used without a progress metric;
- a loop decision cannot depend on untyped text;
- one loop cannot reset facts, routes, attempts, or progress state in another loop;
- a loop failure follows its declared failure policy;
- one loop event batch cannot partially commit.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """1. Slice 1: one successful iteration;
2. Slice 2: feedback continuation;
3. Slice 3: check-driven repair;
4. Slice 4: hard limit;
5. Slice 5: progress and patience;
6. Slice 6: revision and recovery hardening;
7. Slice 7: Pi product surface;
8. Slice 8: dogfood and release.""",
    """1. Slice 1: one successful iteration;
2. Slice 2: feedback continuation;
3. Slice 3: failed-check observations;
4. Slice 4: hard limit;
5. Slice 5: progress and patience;
6. Slice 6: independent regions and outcome policy;
7. Slice 7: revision and recovery hardening;
8. Slice 8: Pi product surface;
9. Slice 9: dogfood and release.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- a failed evaluation check can drive repair;
- the hard iteration limit always stops the loop;
- optional progress and patience decisions are deterministic;
- loop attempts and facts identify their iteration;
- downstream work waits for loop success;""",
    """- a failed evaluation check can provide a valid observation;
- the hard iteration limit always stops the loop;
- optional progress and patience decisions are deterministic;
- loop attempts and facts identify their iteration;
- disconnected loops keep independent state;
- loop failure policy controls workflow and dependant effects;
- downstream work waits for loop success;""",
)

# Hypagoal
replace_once(
    "docs/hypagoal-vertical-slice-plan.md",
    "Hypagoal must use the full Hypagraph runtime. It must use node contracts, typed facts, deterministic gates, evidence, checks, bounded loops, progress rules, and replay.",
    "Hypagoal must use the full Hypagraph runtime. It must use node contracts, typed facts, deterministic gates, evidence, checks, bounded iteration regions, progress rules, explicit loop outcome policies, and replay.",
)
replace_once("docs/hypagoal-vertical-slice-plan.md", "4. Run bounded repair loops.", "4. Run bounded iteration regions for refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or repair.")
replace_once("docs/hypagoal-vertical-slice-plan.md", "- Loop: repair-tests, iteration 3 of 6", "- Loop: parser-quality, iteration 3 of 6")
insert_before_once(
    "docs/hypagoal-vertical-slice-plan.md",
    "Translate a user objective into these graph elements:",
    """Use these loop-authoring rules:

- Do not infer that a loop is a repair loop.
- Define the loop purpose through node intent, facts, checks, success conditions, and progress rules.
- Use a disconnected loop region when work has an independent bounded lifecycle.
- Define the failure policy for each loop.
- Do not connect independent regions only to force global completion order.
- Let explicit dependencies carry data or control between regions.

""",
)

# Trusted evaluation
replace_once(
    "docs/trusted-evaluation-contract-plan.md",
    "M4 already adds the runtime part of a loss function. It adds a numeric progress fact, a minimize or maximize direction, a minimum improvement value, best-result tracking, patience, and a no-progress stop reason.",
    "M4 already adds the runtime part of a loss function. It adds a numeric progress fact, a minimize or maximize direction, a minimum improvement value, best-result tracking, patience, and a no-progress stop reason for any bounded iteration region.",
)
insert_before_once(
    "docs/trusted-evaluation-contract-plan.md",
    "## 2. Decision",
    """A trusted evaluation contract can run inside the evaluated iteration region or in a separate graph component. The graph must connect the evaluator through explicit facts or artifacts when its result controls another region.

This capability applies to refinement, optimization, search, repeated evaluation, and repair. It must not make repair the default loop purpose.

""",
)

# Graph visualisation
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop regions;
- loop feedback edges;""",
    """- loop regions;
- independent top-level graph components;
- loop feedback edges;""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  readyNodeIds: string[];""",
    """  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  components: GraphViewComponent[];
  readyNodeIds: string[];""",
)
insert_before_once(
    "docs/pi-graph-visualisation-plan.md",
    "A graph node includes:",
    """A graph component includes:

- a stable component ID;
- member node IDs;
- member loop IDs;
- whether it has an edge to another component after loop collapse;
- its derived terminal outcome when one exists.

Component identity is a projection value. It is not a new workflow node and it is not a domain event.

""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- feedback edges;
- maximum iteration count;
- current iteration when M4 provides it.""",
    """- feedback edges;
- maximum iteration count;
- current iteration when M4 provides it;
- failure policy when M4 provides it;
- graph-component ID;
- local outcome and workflow effect.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """Process loops before normal layout:

1. Find strongly connected components.
2. Match declared loop regions.
3. Collapse each loop to one compound layout node.
4. Layout the condensation graph from left to right.
5. Expand each loop region.
6. Route feedback edges on a separate lane.
7. Preserve stable positions when the graph revision changes.""",
    """Process loop regions and graph components before normal layout:

1. Find strongly connected components.
2. Match declared loop regions.
3. Collapse each loop to one compound layout node.
4. Find weakly connected top-level graph components in the condensation graph.
5. Layout each component from left to right.
6. Place disconnected components with stable spacing and ordering.
7. Expand each loop region.
8. Route feedback edges on a separate lane.
9. Preserve stable positions when the graph revision changes.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """+ loop repair [0/3] -------------------+
| [fix] --------> [test]               |
|   ^                |                 |
|   +----------------+ feedback        |
+--------------------------------------+""",
    """+ loop quality [0/3] ------------------+
| [draft] ------> [evaluate]           |
|   ^                |                 |
|   +----------------+ feedback        |
+--------------------------------------+""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop group projection;
- deterministic tests.""",
    """- loop group projection;
- top-level graph-component identity;
- loop failure-policy and local-outcome projection;
- deterministic tests.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop boundaries and feedback lanes;
- clipping and ASCII fallback.""",
    """- loop boundaries and feedback lanes;
- disconnected component placement;
- clipping and ASCII fallback.""",
)
replace_once("docs/pi-graph-visualisation-plan.md", "Done when representative task, gate, check, branch, join, and loop graphs render in snapshot tests.", "Done when representative task, gate, check, branch, join, connected-loop, and disconnected-loop graphs render in snapshot tests.")

# Bundled skill
replace_once("skills/hypagraph/SKILL.md", "Use Hypagraph when a coding request has dependent steps, risky sequence requirements, typed outcomes, deterministic routing, multiple ready nodes, or an implement-test-repair cycle.", "Use Hypagraph when a coding request has dependent steps, risky sequence requirements, typed outcomes, deterministic routing, multiple ready nodes, or bounded repeated work.")
replace_once(
    "skills/hypagraph/SKILL.md",
    """Do not add an accidental cycle. A deliberate cycle must be a declared loop. For v0.5, the loop must be a structured single-entry and single-exit region. Its nodes must be the same as one cyclic strongly connected component. Feedback must go from the evaluation node to the entry node. `successWhen` must use the typed condition structure. The loop must have a hard `maxIterations` limit.

M4 Slices 1 to 5 execute bounded task-based and command-check repair loops. Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Do not select loop decisions manually.""",
    """Do not add an accidental cycle. A deliberate cycle must be a declared bounded iteration region. For v0.5, the region must have one entry and one evaluation boundary. Its nodes must be the same as one cyclic strongly connected component. Feedback must go from the evaluation node to the entry node. `successWhen` must use the typed condition structure. The loop must have a hard `maxIterations` limit.

Do not assume that a loop is for repair. Use node contracts and facts to define refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or repair. A loop can be a disconnected graph component. Keep its facts, routes, progress, attempts, and iteration state independent from other regions. Define how loop failure affects the workflow.

Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`.

A failed evaluation check is one valid loop observation. It can continue only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select loop decisions manually.""",
)

write(
    "docs/loop-region-product-model.md",
    """# Loop-region product model

- Status: accepted product direction
- Applies to: M4 and later milestones
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Decision

A Hypagraph loop is a first-class bounded iteration region.

A loop is not a repair construct. Repair is one use case.

The loop purpose comes from:

- node intent;
- node contracts;
- produced facts;
- checks;
- the typed success condition;
- optional progress rules;
- declared feedback;
- hard budgets;
- failure policy.

The domain model must not add a `repair` loop type or infer repair behavior from node names.

## 2. Product scope

The same loop model must support:

- refinement;
- optimization;
- candidate generation and scoring;
- bounded search;
- batch processing;
- repeated evaluation;
- reconciliation;
- polling with a deterministic stop condition;
- migration through a finite work set;
- test, repair, and retest.

These are examples. They are not separate loop kinds.

## 3. Region structure

For v0.5, a loop is a structured region with:

- one entry node;
- one evaluation boundary;
- one or more declared feedback edges;
- a typed success condition;
- a hard iteration limit;
- optional numeric progress;
- optional patience;
- an explicit failure policy.

The nodes inside a loop remain normal task, gate, and check nodes.

Removing feedback edges must make one iteration acyclic.

## 4. Connected and independent regions

A connected loop receives input from the wider graph or releases explicit dependants after success.

An independent loop is a disconnected top-level graph component. It can start when its entry is ready without waiting for another component.

Independent regions must have independent:

- node runtime state;
- attempts;
- facts;
- gate routes;
- progress values;
- patience counters;
- iteration resets;
- event decisions;
- exit reasons.

A region can affect another region only through an explicit dependency, fact, artifact, route, or future declared region edge.

## 5. Outcome policy

Add this policy:

```ts
type LoopFailurePolicy =
  | "fail-workflow"
  | "block-dependants"
  | "record-and-continue";
```

The default is `fail-workflow` for compatibility.

### 5.1 `fail-workflow`

A terminal loop failure fails the workflow.

Use this when the region is mandatory for the workflow result.

### 5.2 `block-dependants`

A terminal loop failure blocks nodes that require loop success. Unrelated ready work can continue.

Use this when the user can inspect or revise the blocked path.

### 5.3 `record-and-continue`

A terminal loop failure is part of the event history and workflow result data. It does not fail unrelated work.

A direct dependant still cannot pass the loop-success barrier.

Use this for independent diagnostics, bounded experiments, optional analysis, or best-effort auxiliary work.

## 6. Workflow result aggregation

Workflow completion must not use the rule that every loop must succeed.

Use these rules:

1. Every loop region must become terminal before the workflow lifecycle completes.
2. A `fail-workflow` failure makes the workflow fail.
3. A failed region does not release dependants that require success.
4. A blocked required path makes the workflow blocked when no permitted work remains.
5. A `record-and-continue` failure can coexist with a successful workflow result when it has no blocked required dependant.
6. Success in one region does not satisfy another region without an explicit graph connection.

The event stream must store the region outcome and the derived workflow result. Replay must not calculate a different result from later state.

## 7. Scheduling

M4 establishes semantic independence.

M4 can keep the current one-active-attempt execution rule. Two independent regions can run in interleaved order without state coupling.

M7 adds bounded concurrent dispatch. The M4 model must already contain enough region and outcome information to add concurrency without a schema redesign.

Concurrency checks must include:

- dependency relations;
- region-order constraints;
- workspace conflicts;
- executor limits;
- concurrency groups;
- shared mutable resources.

## 8. Graph projection

The graph pane must show a loop as a compound region with:

- region ID;
- status;
- current iteration and hard limit;
- entry and evaluation nodes;
- feedback edges;
- success result;
- progress and best result;
- failure policy;
- exit reason.

A disconnected loop appears as a separate top-level component.

The user can expand the region to inspect its internal nodes and iteration state.

## 9. Compatibility

Existing definitions that omit `failurePolicy` use `fail-workflow`.

Existing repair workflows remain valid. They become one instance of the generic iteration-region model.

No migration can infer a different failure policy from node names or descriptions.

## 10. Acceptance criteria

The product direction is met when:

- public documentation uses `bounded iteration region` as the canonical term;
- repair is presented as one example;
- two disconnected loops validate;
- each disconnected loop can start from its own entry;
- one loop cannot reset or release another loop;
- loop facts and progress do not leak between regions;
- failure policy controls workflow impact;
- workflow result aggregation supports recorded local failure;
- Pi shows disconnected loop components and local outcomes;
- M7 can add concurrent region execution without changing the M4 domain meaning.
""",
)

for path in [
    "README.md",
    "docs/product-spec.md",
    "docs/execution-roadmap.md",
    "docs/m4-vertical-slice-plan.md",
    "docs/hypagoal-vertical-slice-plan.md",
    "docs/trusted-evaluation-contract-plan.md",
    "docs/pi-graph-visualisation-plan.md",
    "docs/loop-region-product-model.md",
    "skills/hypagraph/SKILL.md",
]:
    if b"\x00" in Path(path).read_bytes():
        raise SystemExit(f"NUL control character found in {path}")
