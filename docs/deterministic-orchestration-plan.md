# Deterministic orchestration plan

- Status: proposed
- Spans: a new aggregate node, a synthesis node, M7 executor abstraction, M8 bounded concurrency, M8.1 derived fan-out
- Roadmap source: `docs/execution-roadmap.md` sections 8 and 18
- Comparison source: `docs/research/pi-dynamic-workflows-comparison.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Hypagraph must run wide work. A code review which asks five reviewers, a scope
audit across many files, and a best-of-N design comparison are all wide work.

The primary shape is a closed feedback loop. A worker produces work, many
reviewers examine it, and the loop repeats until the reviewers agree. Section
3.1 defines it. Wide work with no loop is the simple case of the same
mechanism.

Other agent orchestration products run wide work with a script. A model writes
the script, and the script controls every fan-out, every collection step, and
every decision. That design spends a model turn on orchestration, and it repeats
that cost on each run.

Hypagraph must reach the same product results with one difference. The model
authors the graph one time. After that, the controller performs every
orchestration step in the deterministic lane, and orchestration consumes no
model turn.

A model still does the thinking, and a wide workflow still spends many model
turns. Section 2.2 states the exact claim.

## 2. Governing rule

Orchestration is not model work.

The model performs semantic work inside a leaf node. The control flow between
leaf nodes is deterministic:

- the controller selects which nodes run;
- the controller starts a bounded set of independent nodes together;
- the controller collects the results of a branch set;
- the controller reduces those results to one typed value;
- a gate routes on that value;
- a loop compares that value with its success condition.

### 2.1 What the rule does not say

The rule limits control flow. It does not limit how many leaf nodes a region
contains, and it does not make a leaf node cheaper because it sits between two
other leaf nodes.

A node which reads the output of many branches and writes a summary is semantic
work. It is a leaf node, it consumes a model turn, and it is permitted. Section
7.2 defines it.

The two rules which stay absolute:

1. A reduction must never call a model. An aggregate node computes a typed value
   from typed facts, and nothing else.
2. A routing decision must never read a model summary. A gate condition and a
   loop success condition read the reduced fact only.

A model which summarises votes is not a count. It is one more opinion, and an
opinion must not decide whether a loop stops.

### 2.2 The claim which this plan makes

No model decides what happens next.

The claim is about control, not about turn count. A closed loop can spend many
model turns for each iteration. It spends none on the decision to iterate.

## 3. Product results

A graph author can declare these workflows, and the controller executes each one
with no orchestration turn:

1. **Closed feedback loop.** A worker node produces work. N reviewers examine it
   with different instructions. The controller counts the approvals against a
   declared threshold, and the loop continues or stops on that count. Section
   3.1 gives the shape.
2. **Best of N.** N attempts produce a result. N scorers rate each result. The
   controller selects the highest score.
3. **Wide discovery.** N branches search the same target in different ways. The
   controller collects the findings in a stable order with the branch which
   produced each one.
4. **Bounded repeat.** The existing loop region repeats discovery until no new
   finding appears. Hypagraph already provides this.

### 3.1 The closed feedback loop

This is the primary shape. Result 1 is one instance of it, and a deep research
loop or a design loop is another.

A closed loop needs four separate parts, and they must not be confused:

| Part | Node kind | Turns | Answers |
| --- | --- | --- | --- |
| Attempt | Model executor | 1 | What is the work? |
| Opinions | N model executors in one region | N | Is this work acceptable? |
| Decision | Aggregate, `quorum` | 0 | Does the loop stop? |
| Feedback | Model executor, section 7.2 | 1 | What must the next attempt change? |

The decision part is the reason the aggregate node exists. N reviewers produce N
booleans, and N booleans are not an exit condition. The quorum reduces them to
one typed fact, so `successWhen` compares a declared value instead of reading an
opinion.

The feedback part is model work. No typed reduction can merge overlapping
findings, resolve two reviewers who ask for opposite changes, or order the work
by what matters. A model does that, and it costs one turn for each iteration.

The cost for each iteration is therefore N + 2 model turns. None of them decides
whether the loop runs again.

### 3.2 The separation rule

Route on closed values. Carry open values as payload.

The loop success condition reads the quorum fact and nothing else. The synthesis
output travels the feedback edge to the next attempt, and it never reaches a
gate condition or a loop success condition.

Two results follow:

1. The count passes and the loop stops, even when the synthesis node is not
   content.
2. The count fails and the loop continues, even when the synthesis node reports
   that the work is complete.

The validator already enforces the same principle for an interaction node with
the `gate_routes_on_open_answer` diagnostic. This plan extends it. Section 7.3
states the diagnostic.

### 3.3 A worked example

An implementation loop with five reviewers. The loop region:

```jsonc
{
  "id": "implement-until-approved",
  "entry": "implement",
  "nodes": ["implement",
            "review-correctness", "review-security", "review-tests",
            "review-api", "review-performance",
            "review-verdict", "review-findings",
            "review-synthesis"],
  "evaluateAfter": "review-verdict",
  "successWhen": { "fact": "review.passed", "equals": true },
  "maxIterations": 4,
  "progress": { "fact": "review.readyCount", "direction": "maximize", "minDelta": 1 },
  "patience": 2,
  "feedbackEdges": [{ "from": "review-synthesis", "to": "implement" }],
  "failurePolicy": "block-dependants"
}
```

The five reviewer nodes have no dependency edge between them, so they are
runnable together. Each one publishes `review.ready`, which is a boolean, and
`review.findings`, which is an array.

The decision:

```jsonc
{
  "id": "review-verdict", "kind": "aggregate", "region": "code-review",
  "strategy": {
    "kind": "quorum",
    "fact": "review.ready", "equals": true, "threshold": 4,
    "publishesCount": "review.readyCount"
  },
  "publishes": "review.passed"
}
```

The collection:

```jsonc
{
  "id": "review-findings", "kind": "aggregate", "region": "code-review",
  "strategy": {
    "kind": "collect",
    "fact": "review.findings",
    "orderBy": [
      { "field": "severity", "direction": "ascending",
        "values": ["critical", "major", "minor"] },
      { "field": "file", "direction": "ascending" }
    ],
    "maximumItems": 60
  },
  "publishes": "review.findingList"
}
```

The synthesis node reads `review.findingList` and publishes `review.feedback`.
The feedback edge carries it to `implement`.

One iteration:

1. `implement` produces a diff. That is one model turn.
2. The five reviewers run. That is five model turns.
3. `review-verdict` waits for the last reviewer, then counts. Two of five said
   ready, so `review.passed` is false and `review.readyCount` is 2. That is no
   model turn.
4. `review-findings` collects 11 findings in severity order. That is no model
   turn.
5. `review-synthesis` merges them into a brief. That is one model turn.
6. The loop evaluates after `review-verdict`. `successWhen` is false, and the
   iteration limit is not reached, so the decision is `continue`.

The second iteration reaches a count of 4. `review.passed` becomes true, the
loop exits with `exitReason: "success"`, and `review.readyCount` moved from 2 to
4, so the patience limit did not apply.

The loop can stop four ways, and each way is a separate `LoopExitReason` in the
event history: `success`, `max_iterations`, `no_progress`, and
`evaluation_budget`. A script which writes `while (!approved)` records one.

## 4. Parity with a script orchestrator

| Script primitive | Hypagraph form | State |
| --- | --- | --- |
| Bounded repeat until dry | Loop region with typed success, iteration limit, and patience | Complete, and stronger |
| Conditional gate | Gate on typed facts | Complete |
| Retry | Check retry policy with backoff and retry statuses | Complete |
| Human approval | Interaction node, closed or open | Complete |
| Structured output | Fact contracts and validation | Wire executor output to contracts |
| Phase grouping | A barrier node which requires the previous set | Expressible today |
| Concurrent branches | Independent nodes with no dependency edge | Modelled, not executed |
| Isolated agent call | Model-executor node | M7 |
| Fan out over a collection | Derived fan-out region | M8.1 |
| Vote count and best-of-N | Aggregate node | New, section 6 |
| Collate branch results into a brief | Synthesis node | New, section 7.2 |
| Worktree isolation | Workspace lease and per-attempt worktree | M8 |

Hypagraph already provides four primitives, and one of them is stronger than the
script form. A loop region requires a typed success condition and an explicit
failure policy. A script loop requires neither.

## 5. Prerequisite: branch-scoped facts

This change must come first. Every later section depends on it.

### 5.1 The current limit

The fact store is one flat map. `applyEvent` writes
`next.runtime.facts[fact.name]`, so one name holds one record.

Validation also rejects two producers for one fact name with the
`conflicting_fact_producer` diagnostic.

Five reviewers which each publish `review.approved` therefore fail validation.
They would also overwrite each other if validation permitted them.

### 5.2 The change

Address a fact by its name and its branch.

`PublishedFact` already carries `loopId` and `iteration`. A loop iteration is
already one instance dimension, so the record shape needs one more field:

```ts
export interface PublishedFact {
  name: string;
  // ...
  loopId?: string;
  iteration?: number;
  /** The fan-out branch which published the fact. */
  branchId?: string;
}
```

The store must key a fact by name and branch. A fact with no branch keeps its
current behaviour.

### 5.3 Rules

1. Two nodes in different branches of one region can publish the same fact name.
2. Two nodes outside a region must not publish the same fact name. The existing
   diagnostic stays for that case.
3. A required fact is present when every live branch published it.
4. A gate outside a region must not read a branch-scoped fact directly. It reads
   the reduced fact which an aggregate node publishes.

Rule 4 keeps routing deterministic. A gate must never depend on which branch
finished first.

## 6. The aggregate node

Add node kind `aggregate`. An aggregate node reads the facts of one branch set
and publishes one typed fact. It runs in the deterministic lane and consumes no
model turn.

### 6.1 Definition

```ts
export interface AggregateDefinition {
  kind: "aggregate";
  version: 1;
  /** The region whose branches this node reduces. */
  region: string;
  strategy: AggregateStrategy;
  /** The fact which this node publishes. */
  publishes: string;
}

export type AggregateStrategy =
  | {
      kind: "quorum";
      fact: string;
      equals: FactValue;
      threshold: number;
      /** A declared numeric fact which receives the match count. */
      publishesCount?: string;
    }
  | { kind: "ranked"; fact: string; direction: "highest" | "lowest" }
  | {
      kind: "collect";
      fact: string;
      /** The declared fields which order the result. */
      orderBy: AggregateOrderKey[];
      maximumItems: number;
    };

export interface AggregateOrderKey {
  field: string;
  direction: "ascending" | "descending";
  /** A closed value list. The order of this list is the sort order. */
  values?: FactValue[];
}
```

### 6.2 Strategies

**`quorum`** counts the branches where `fact` equals `equals`. It publishes a
boolean which reports whether the count reached `threshold`. Use it for the
decision part of a closed loop.

`publishesCount` writes the match count to a second declared fact. A loop
progress definition needs this. Five reviewers with two approvals in the first
iteration and four in the second show progress, and
`{ fact: "review.readyCount", direction: "maximize", minDelta: 1 }` measures it
with no interpretation.

**`ranked`** selects the branch with the highest or the lowest value of a numeric
fact. It publishes the branch identifier. Use it for best of N.

**`collect`** concatenates an array fact across branches into one array in a
stable order. Each item keeps the identifier of the branch which produced it.
`maximumItems` bounds the result. Use it to assemble the input of a synthesis
node, and use it for wide discovery.

`collect` does not remove duplicates. An earlier version of this plan gave it a
`dedupeBy` key, and that was wrong. Section 6.5 states why.

### 6.3 Rules

1. An aggregate node must reduce a complete branch set. It becomes ready only
   when every live branch reached a terminal state.
2. A reduction must be a pure function of the branch facts. It must not read the
   clock, and it must not call a model.
3. A reduction must be total. A strategy must publish a value for an empty
   branch set, or validation must reject an empty set.
4. An aggregate node must publish a declared fact contract, exactly as any other
   producer does. This applies to `publishesCount`.
5. A `collect` result must have a total order before the runtime applies
   `maximumItems`. `orderBy` supplies it, and the branch identifier is the final
   tie-break. A list which is cut at a bound with no order can lose the most
   important item, and it loses a different item on each run.
6. A `collect` node must publish the number of items which `maximumItems`
   removed. A reader must not read a truncated list as a complete list.
7. An aggregate node must not read free text. Every fact which a strategy names
   must be a boolean, a number, or a closed value list. Section 6.5 states why.

### 6.4 Why a quorum is an evaluation

M5A already provides evaluation contracts. A contract declares evaluator
purpose, trust level, integrity, version, and fingerprint. It also declares the
feedback mode, and it applies an evaluation budget.

A review quorum is an evaluator whose trust is model-based. Reuse the M5A
contract for it. The budget limits, the protected feedback rule, and the
redaction policy then apply with no new mechanism.

Validation already reports `isolated_evaluator_unavailable` with the text
"Isolated evaluator trust is unavailable until an isolated evaluator adapter
exists." The M7 executor is that adapter.

### 6.5 Why a reduction must not remove duplicates

Two reviewers report the same defect in different words. A key which merges them
must decide that two texts mean one thing, and that decision is semantic.

A structural key does not solve this. A key of file, symbol, and category merges
two different defects in one function, and the second defect disappears with no
record. A free-text key merges nothing at all, because two reviewers never write
the same sentence.

The failure modes are not equal:

| Design | Failure | Cost |
| --- | --- | --- |
| No duplicate removal | The list repeats an item | Context bytes in the next node |
| A structural key | The list drops a true item in silence | A defect reaches the user |

A reduction must therefore never drop an item. `collect` keeps every item, and a
synthesis node merges them, because a synthesis node understands them. Rule 7 of
section 6.3 follows from the same argument: a strategy which reads free text
must interpret it, and interpretation is not a reduction.

## 7. Model-executor node (M7)

A model-executor node performs semantic work in an isolated session. It is the
leaf of every wide workflow.

### 7.1 Definition

The definition must declare:

- the instructions for the node;
- the explicit context projection which the node receives;
- the executor tier or the exact model;
- the fact contract which the result must satisfy.

The executor result must pass fact validation before it becomes canonical state.
An invalid result is a failed attempt, not a published fact.

A model-executor node consumes one model turn.

### 7.2 The synthesis node

A synthesis node is a model-executor node with one purpose. It reads the
collected output of a branch set, and it publishes the brief which the next
attempt receives.

It performs the work which no reduction can perform:

- it merges findings which describe one defect in different words;
- it reports two branches which request opposite changes;
- it orders the work by importance, not by branch order;
- it drops a finding which the previous iteration already answered.

The definition adds two requirements to section 7.1:

1. The node must receive the `collect` fact of the region, and it must receive
   the truncation count with it.
2. The node must publish a declared fact which only a feedback edge reads.

A synthesis node is not an evaluator. It publishes no verdict, so it needs no
M5A evaluation contract and it draws on no evaluation budget. The quorum node is
the evaluator, and section 6.4 covers it.

### 7.3 The routing ban

A gate condition and a loop success condition must not read a synthesis fact.

Add the diagnostic `routes_on_synthesis_fact`. The text: "Node '<id>' cannot
route on the synthesis fact '<name>'. Route on the aggregate fact instead."

This matches `gate_routes_on_open_answer`, which stops a gate from routing on
the free text of an interaction node. The two diagnostics state one rule. A
routing decision reads a closed value. A model writes an open value, and an open
value travels as payload.

Without the ban, a graph author can write a loop whose exit depends on a model
which says that the work is complete. The loop then has no closed exit
condition, and the plan delivers nothing.

## 8. Bounded concurrency (M8)

`enumerateGoalContinuationCandidates` already returns every runnable action.
`selectGoalContinuation` then selects one action by the continuation ordinal.

Concurrency changes the selection step only. The controller selects up to K
independent actions instead of one.

Rules:

1. K has a declared default and a hard maximum.
2. Two concurrent attempts must not share a workspace. M8 workspace leases give
   each attempt its own worktree.
3. Concurrency must not change the canonical event order. The event stream stays
   one sequence.
4. A budget stop must stop every lane, exactly as M6A requires.

## 9. Derived fan-out (M8.1)

A derived fan-out region creates one branch for each item of a collection fact.

Roadmap section 18 asks for one confirmed use case before this work starts. A
review across the changed files of a diff is that use case. The file count is
known only at run time.

Rules:

1. A region must declare a maximum branch count. The runtime must reject a
   collection which exceeds it.
2. A region must declare the fact which supplies the collection.
3. Branch identity must be stable and deterministic, so replay reproduces the
   same branch set.
4. A fixed branch count needs no derived fan-out. A review quorum of five
   reviewers is fixed at authoring time.

Rule 4 matters for sequencing. A fixed-width quorum needs sections 5 and 6 only.

## 10. Slice sequence

| Slice | Result | Depends on |
| --- | --- | --- |
| 1 | Branch-scoped facts | none |
| 2 | Aggregate node with the three strategies | 1 |
| 3 | Fixed-width quorum region, its evaluation contract, and the `routes_on_synthesis_fact` diagnostic | 1, 2 |
| 4 | Model-executor node and the executor contract | 3 |
| 5 | Synthesis node and the closed feedback loop end to end | 4 |
| 6 | Bounded concurrent selection and workspace leases | 4 |
| 7 | Derived fan-out from a collection fact | 6 |
| 8 | Dogfood and release | 5, 7 |

Slices 1 to 3 are domain work. They need no executor, and tests can cover them
with recorded facts.

The decision part of a closed loop therefore lands before M7, and the feedback
part does not. A quorum which routes a loop is testable in slice 3 with recorded
reviewer facts. A loop which reviews real work needs slice 4, and a loop which
feeds a real brief to the next attempt needs slice 5.

State this plainly in the slice 3 report. A quorum with no synthesis node is a
loop which repeats an attempt with no new information, and it is not the product
result.

## 11. Acceptance criteria

- A review quorum of N reviewers publishes one boolean verdict, and the workflow
  spends no model turn on the count.
- A quorum publishes the match count, and a loop progress definition reads it.
- A closed loop continues or stops on the quorum fact only. A synthesis node
  which disagrees with the count does not change the decision.
- A synthesis node reads the collected branch output and publishes the brief
  which the feedback edge carries to the next attempt.
- A gate or a loop success condition which reads a synthesis fact fails
  validation with `routes_on_synthesis_fact`.
- A best-of-N region selects one branch by a numeric fact with no model turn.
- A `collect` region keeps every item, orders the result before it applies
  `maximumItems`, and reports the removed count.
- Two runs of one `collect` region over one branch set produce one identical
  order.
- An aggregate node becomes ready only when every live branch is terminal.
- Replay reproduces every branch identity, every reduction, and every route.
- A gate outside a region cannot read a branch-scoped fact.
- Two branches can publish the same fact name. Two nodes outside a region cannot.
- A model evaluator uses the M5A evaluation contract and its budget.

## 12. Out of scope

- a model which writes an orchestration script at run time;
- a reduction which calls a model. A leaf node which calls a model is in scope,
  and section 7.2 defines one;
- a routing decision which reads a model summary;
- a reduction which removes duplicates. Section 6.5 states why;
- an unbounded branch count;
- a resident process which watches branches. Design rule 3.9 rejects one.
