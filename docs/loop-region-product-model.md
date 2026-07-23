# Loop-region product model

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
