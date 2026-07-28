# Deterministic orchestration plan

- Status: proposed
- Spans: a new aggregate node, a synthesis node, M7 executor abstraction, M8 bounded concurrency, M8.1 derived fan-out
- Roadmap source: `docs/execution-roadmap.md` sections 8 and 18
- Comparison sources: `docs/research/pi-dynamic-workflows-comparison.md`, `docs/research/grok-build-workflows-comparison.md`
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

### 1.1 Terms

Three different mechanisms attracted the word "evaluator" in earlier drafts.
This plan uses these terms, and it uses no other word for them.

| Term | Meaning |
| --- | --- |
| **Loop boundary** | The node which `evaluateAfter` names. It is the last node of an iteration and the source of the feedback edge. It makes no decision. |
| **Decision reduction** | The quorum aggregate node whose published fact a loop success condition or a gate condition reads. |
| **Evaluator** | A node which holds an M5A evaluation contract: purpose, trust level, integrity, feedback mode, and a budget claim. |

The three mechanisms are separate. The three nodes are not necessarily separate.

In the closed loop of section 3, the loop boundary is one node, and the decision
reduction and the evaluator are the same quorum node.

An evaluation contract governs the trust, the feedback mode, and the budget of a
judgement. It does not select a route. The quorum node therefore holds a
contract and publishes the fact which a success condition reads, and those are
two different properties of one node.

The existing validator uses "evaluator" for the loop boundary in
`invalid_loop_evaluator`, `loop_evaluator_cannot_be_gate`, and
`loop_node_cannot_reach_evaluator`. Those names stay, because a diagnostic code
is a compatibility surface. Read them as "loop boundary". Do not add a new
diagnostic which uses the word in the structural sense.

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

A closed loop needs five separate parts, and they must not be confused:

| Part | Node kind | Turns | Answers |
| --- | --- | --- | --- |
| Attempt | Model executor | 1 | What is the work? |
| Opinions | N model executors in one region | N | Is this work acceptable? |
| Decision | Aggregate, `quorum` | 0 | Does the loop stop? |
| Collection | Aggregate, `collect` | 0 | What did the branches report? |
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

An implementation loop with five reviewers.

The region which the aggregates reduce, as section 5.4 defines it:

```jsonc
{ "id": "code-review",
  "nodes": ["review-correctness", "review-security", "review-tests",
            "review-api", "review-performance"] }
```

The loop:

```jsonc
{
  "id": "implement-until-approved",
  "entry": "implement",
  "nodes": ["implement",
            "review-correctness", "review-security", "review-tests",
            "review-api", "review-performance",
            "review-verdict", "review-findings",
            "review-synthesis"],
  "evaluateAfter": "review-synthesis",
  "successWhen": { "fact": "review.passed", "equals": true },
  "maxIterations": 4,
  "progress": { "fact": "review.readyCount", "direction": "maximize", "minDelta": 1 },
  "patience": 2,
  "feedbackEdges": [{ "from": "review-synthesis", "to": "implement" }],
  "failurePolicy": "block-dependants"
}
```

Each reviewer publishes `review.ready`, which is a boolean, and
`review.findings`, which is an array. The five nodes have no dependency edge
between them, so they are runnable together.

The synthesis node is the loop boundary, and the quorum node is not. Section 3.4
states why.

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

The synthesis node requires `review-verdict` and `review-findings`. It reads
`review.findingList` and publishes `review.feedback`.

One iteration:

1. `implement` produces a diff. That is one model turn.
2. The five reviewers run. That is five model turns.
3. `review-verdict` waits for the last reviewer, then counts. Two of five said
   ready, so `review.passed` is false and `review.readyCount` is 2. That is no
   model turn.
4. `review-findings` collects 11 findings in severity order. That is no model
   turn.
5. `review-synthesis` merges them into a brief. That is one model turn.
6. The loop evaluates after `review-synthesis`. `successWhen` reads
   `review.passed`, which is false, and the iteration limit is not reached, so
   the decision is `continue`.

The second iteration reaches a count of 4. `review.passed` becomes true, the
loop exits with `exitReason: "success"`, and `review.readyCount` moved from 2 to
4, so the patience limit did not apply.

The loop can stop four ways, and each way is a separate `LoopExitReason` in the
event history: `success`, `max_iterations`, `no_progress`, and
`evaluation_budget`. A script which writes `while (!approved)` records one.

### 3.4 The loop boundary is the synthesis node

The loop boundary is the last node of an iteration. It is not the node which
supplies the success condition, and it holds no evaluation contract.

Three existing validator rules decide this. Each diagnostic name uses
"evaluator" in the structural sense which section 1.1 records:

| Rule | Diagnostic | Result |
| --- | --- | --- |
| Feedback must go from the boundary to the entry | `invalid_feedback_boundary` | The boundary is the feedback source |
| Every loop node must reach the boundary | `loop_node_cannot_reach_evaluator` | The boundary is last |
| An external consumer must leave through the boundary | `loop_external_output_not_evaluator` | The boundary is the one exit |

The synthesis node is the only node which satisfies all three. It produces the
feedback, and every other node of the iteration comes before it.

A quorum node as the boundary fails the second rule. The synthesis node is in
the loop and it cannot reach the quorum node, because it comes after it.

The success condition still reads the quorum fact. This is the separation rule
of section 3.2 in structural form: the node which closes an iteration is not the
node which decides whether another iteration runs.

One cost follows. The final iteration passes the quorum and still spends a
synthesis turn, because the boundary runs before the loop evaluates. One turn
for each completed loop is an acceptable cost. Do not add a gate to avoid it,
because a gate inside the loop adds a route which the loop must then reason
about.

One validator message needs an update. `loop_evaluator_cannot_be_gate` reads
"must be a task or check node", and a model-executor node is neither. The test
rejects a gate only, so the behaviour is correct and the text is not. Slice 4
must correct it.

### 3.5 What this pattern changes in the current loop rules

The pattern reads a progress fact which the boundary node does not produce, and
it puts the evaluation contract on a node which is not the boundary. Both extend
current assumptions. State the delta here, so an implementer does not read
silence as agreement.

**A progress fact may come from any node of the iteration.**
`assessEvaluationAuthoring` reports `progress_source_not_metric_report` when a
loop declares numeric progress and its boundary is not a metric-report check.
The advisory text asks the author to confirm that a deterministic instrument
produces the progress fact.

In this pattern the answer is yes, and the instrument is the quorum aggregate.
`review.readyCount` is a count over typed facts, which is more deterministic
than a metric-report check, because a metric-report check runs a command.

The advisory assumes that the boundary node produces the progress fact. Slice 3
must widen the test: the advisory must pass when a metric-report check **or** an
aggregate node inside the loop publishes the progress fact.

**The evaluation contract sits on the quorum node.** Section 6.4 puts the M5A
contract there, because the quorum is the node which judges. The reviewers are
the model-executor branch nodes whose attempts the contract budgets. The
synthesis node claims none, and section 7.2 states that.

The `evaluation_budget` loop exit therefore means one thing: the reviewers
exhausted the declared budget before the quorum reached its threshold. The loop
stops with no verdict rather than continue with a partial branch set, which
rule 1 of section 6.3 forbids in any case.

## 4. Parity with a script orchestrator

| Script primitive | Hypagraph form | State |
| --- | --- | --- |
| Bounded repeat until dry | Loop region with typed success, iteration limit, and patience | Complete, and stronger |
| Conditional gate | Gate on typed facts | Complete |
| Retry | Check retry policy with backoff and retry statuses | Complete |
| Human approval | Interaction node, closed or open | M6.1 Slice 1.1, in progress |
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

### 5.4 The fixed region

Sections 5.1 to 5.3 use the word "region" and do not define it. Define it here,
because an aggregate node names one and the worked example needs it.

A fixed region is a declared set of nodes. Each node in the set is one branch,
and the node identifier is the branch identifier:

```ts
export interface RegionDefinition {
  id: string;
  /** The branch nodes. Each one is one branch. */
  nodes: string[];
}
```

A region hangs at the definition root, beside `loops`:

```ts
export interface HypagraphDefinition {
  // ...
  loops: LoopDefinition[];
  regions: RegionDefinition[];
}
```

A region is not loop-local. A wide discovery workflow uses a region with no
loop, and the closed loop of section 3 puts a region inside a loop. The two are
independent, so neither one contains the other.

```jsonc
{ "id": "code-review",
  "nodes": ["review-correctness", "review-security", "review-tests",
            "review-api", "review-performance"] }
```

Rules:

1. The branch identifier of a fact is the identifier of the node which published
   it. Replay reproduces it with no counter and no clock.
2. A region must declare two or more nodes.
3. The nodes of a region must have no dependency edge between them, so they are
   runnable together.
4. A node belongs to one region only.
5. A region needs no new execution mechanism. The controller already returns
   every runnable action, and the nodes of a fixed region are runnable together
   because nothing orders them.

Rule 5 is the reason a fixed region costs so little. The width is known when the
author writes the graph, so the region is a naming construct over nodes which
the graph already contains. Section 9 adds the derived form, where the width is
known only at run time, and only that form needs new execution machinery.

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
5. A `collect` result must have the total order of rule 9 before the runtime
   applies `maximumItems`. A list which is cut at a bound with no order can lose
   the most important item, and it loses a different item on each run.
6. A `collect` node must publish the number of items which `maximumItems`
   removed. A reader must not read a truncated list as a complete list.
7. An aggregate node may **carry** any field, and it must not **decide** by a
   prose field. A payload which the node copies without inspection has no
   limit. A field which the node compares, counts, ranks, or sorts by must not
   be prose. Section 6.3.1 makes this decidable.
8. `quorum` and `ranked` therefore name a scalar fact only. `collect` names an
   array fact whose items may hold prose, and every key in its `orderBy` must
   satisfy rule 7.
9. An `orderBy` key must give a total order. A closed value list orders by the
   position of the value in the list, not by its text. An identifier orders by
   code point, and the plan states no other collation. A key which leaves two
   items equal falls to the next key, and the branch identifier is the final
   key.

Rules 7 to 9 draw one line. The `message` field of a finding travels through a
`collect` node untouched and reaches the synthesis node. No strategy reads it,
because reading it is interpretation. Section 6.5 states why.

#### 6.3.1 Which fields a strategy may name

"Free text" is not a decidable test. A path is a string, and a sentence is a
string. The fact contract must therefore declare the kind of each field, and the
validator decides from the declaration:

| Field kind | Example | A strategy may name it |
| --- | --- | --- |
| `boolean` | `review.ready` | Yes |
| `number` | `score` | Yes |
| `enum` | `severity`, `category` | Yes |
| `identifier` | `file`, `symbol`, a branch id | Order only |
| `prose` | `message`, a rationale | No |

An `identifier` is a string which names a thing. A model does not compose it, it
reports it, and two reports of one thing are the same string. It orders by code
point, which is deterministic and total.

A `prose` field is a string which a model composes. Two reports of one thing are
different strings. An order over it is deterministic and meaningless, and a
meaningless order in front of `maximumItems` drops items by alphabet. That is
the reason for the ban, and it is a different reason from the ban on semantic
comparison.

`orderBy` accepts `boolean`, `number`, `enum`, and `identifier`. The `equals` of
a quorum and the numeric fact of a `ranked` accept `boolean`, `number`, and
`enum` only, because an order over identifiers is meaningful and an equality
test between composed identifiers is not reliable.

The `orderBy` of section 3.3 is therefore valid. `severity` is an `enum` and
`file` is an `identifier`.

### 6.4 Why a quorum node holds the evaluation contract

M5A already provides evaluation contracts. A contract declares purpose, trust
level, integrity, version, and fingerprint. It also declares the feedback mode,
and it applies an evaluation budget.

The quorum node is the evaluator of the loop, in the section 1.1 sense. It is
the node which judges, its trust is model-based, and its branch nodes are the
model calls which the budget must limit. Put the M5A contract there. The budget
limits, the protected feedback rule, and the redaction policy then apply with no
new mechanism.

The contract does not go on the loop boundary. Section 3.5 states the result for
the `evaluation_budget` exit reason.

#### 6.4.1 This is a schema extension, not pure reuse

The M5A policy applies with no new mechanism. The M5A **schema** does not.

Today an evaluation contract lives on a metric-report check
(`MetricReportCheckDefinition.evaluation`), and the node which holds the
contract is the node which runs. In this pattern the holder and the runner are
different: the quorum node holds the contract, and the branch nodes run.

Slice 3 must therefore add two bindings:

1. An `aggregate` node may carry an evaluation contract. `assessEvaluationAuthoring`
   collects contracts from metric-report checks only, so it must also collect
   them from aggregate nodes.
2. Budget accounting charges the model-executor attempts of the region which the
   aggregate reduces. One iteration of a five-reviewer region claims five
   evaluations, not one.

Do not read section 6.4 as "no code changes". Read it as "no new policy". The
trust levels, the protected feedback rule, and the redaction policy need no new
design, and the binding between a contract and the attempts it governs does.

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
section 6.3 follows from the same argument: a strategy which decides by a
`prose` field must interpret it, and interpretation is not a reduction.

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

A synthesis node holds no M5A evaluation contract, and it claims no evaluation
budget. It publishes no verdict, so there is nothing for a contract to govern.
The quorum node holds the contract, and section 6.4 covers it.

A synthesis node is normally the loop boundary. Section 1.1 keeps the two ideas
apart: the boundary closes an iteration, and an evaluation contract governs a
judgement. The synthesis node does the first and not the second.

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
| 1 | Branch-scoped facts and the fixed region of section 5.4 | none |
| 2 | Aggregate node with the three strategies | 1 |
| 3 | Fixed-width quorum region, the contract bindings of section 6.4.1, the `routes_on_synthesis_fact` diagnostic, and the widened progress advisory of section 3.5 | 1, 2 |
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
- A closed loop passes the existing loop validator with the synthesis node as
  `evaluateAfter` and the quorum fact in `successWhen`.
- A loop whose progress fact comes from an aggregate node inside the loop does
  not report `progress_source_not_metric_report`.
- A `collect` node carries a `prose` field through to the synthesis node, and no
  strategy reads it.
- An `orderBy` key which names an `identifier` field passes validation. A key
  which names a `prose` field fails it.
- A quorum `equals` which names a `prose` or an `identifier` field fails
  validation.
- A best-of-N region selects one branch by a numeric fact with no model turn.
- A `collect` region keeps every item, orders the result before it applies
  `maximumItems`, and reports the removed count.
- Two runs of one `collect` region over one branch set produce one identical
  order.
- An aggregate node becomes ready only when every live branch is terminal.
- Replay reproduces every branch identity, every reduction, and every route.
- A gate outside a region cannot read a branch-scoped fact.
- Two branches can publish the same fact name. Two nodes outside a region cannot.
- The quorum node holds the M5A evaluation contract, and its branch nodes claim
  the evaluation budget. The loop boundary claims none.

## 12. Out of scope

- a model which writes an orchestration script at run time;
- a reduction which calls a model. A leaf node which calls a model is in scope,
  and section 7.2 defines one;
- a routing decision which reads a model summary;
- a reduction which removes duplicates. Section 6.5 states why;
- an unbounded branch count;
- a resident process which watches branches. Design rule 3.9 rejects one.
