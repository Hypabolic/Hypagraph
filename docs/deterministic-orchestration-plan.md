# Deterministic orchestration plan

- Status: proposed
- Spans: a new aggregate node, M7 executor abstraction, M8 bounded concurrency, M8.1 derived fan-out
- Roadmap source: `docs/execution-roadmap.md` sections 8 and 18
- Comparison source: `docs/research/pi-dynamic-workflows-comparison.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Hypagraph must run wide work. A code review which asks five reviewers, a scope
audit across many files, and a best-of-N design comparison are all wide work.

Other agent orchestration products run wide work with a script. A model writes
the script, and the script controls every fan-out, every collection step, and
every decision. That design spends a model turn on orchestration, and it repeats
that cost on each run.

Hypagraph must reach the same product results with one difference. The model
authors the graph one time. After that, the controller performs every
orchestration step in the deterministic lane, and orchestration consumes no
model turn.

## 2. Governing rule

Orchestration is not model work.

The model performs semantic work inside a leaf node. Everything between leaf
nodes is deterministic:

- the controller selects which nodes run;
- the controller starts a bounded set of independent nodes together;
- the controller collects the results of a branch set;
- the controller reduces those results to one typed value;
- a gate routes on that value.

A reduction must never call a model. A model which summarises votes is not a
check. It is one more opinion.

## 3. Product results

A graph author can declare these workflows, and the controller executes each one
with no orchestration turn:

1. **Review quorum.** N reviewers examine the same work with different
   instructions. The controller counts the approvals and compares the count with
   a declared threshold.
2. **Best of N.** N attempts produce a result. N scorers rate each result. The
   controller selects the highest score.
3. **Wide discovery.** N branches search the same target in different ways. The
   controller merges the findings and removes duplicates by a declared key.
4. **Bounded repeat.** The existing loop region repeats discovery until no new
   finding appears. Hypagraph already provides this.

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
  | { kind: "quorum"; fact: string; equals: FactValue; threshold: number }
  | { kind: "ranked"; fact: string; direction: "highest" | "lowest" }
  | { kind: "union"; fact: string; dedupeBy: string; maximumItems: number };
```

### 6.2 Strategies

**`quorum`** counts the branches where `fact` equals `equals`. It publishes a
boolean which reports whether the count reached `threshold`. Use it for a review
quorum.

**`ranked`** selects the branch with the highest or the lowest value of a numeric
fact. It publishes the branch identifier. Use it for best of N.

**`union`** merges an array fact across branches and removes duplicates by the
`dedupeBy` key. It publishes the merged array. `maximumItems` bounds the result.
Use it for wide discovery.

### 6.3 Rules

1. An aggregate node must reduce a complete branch set. It becomes ready only
   when every live branch reached a terminal state.
2. A reduction must be a pure function of the branch facts. It must not read the
   clock, and it must not call a model.
3. A reduction must be total. A strategy must publish a value for an empty
   branch set, or validation must reject an empty set.
4. An aggregate node must publish a declared fact contract, exactly as any other
   producer does.
5. `maximumItems` bounds a union. The node must report the count which it
   removed, so a reader does not read a truncated list as a complete list.

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

## 7. Model-executor node (M7)

A model-executor node performs semantic work in an isolated session. It is the
leaf of every wide workflow.

The definition must declare:

- the instructions for the node;
- the explicit context projection which the node receives;
- the executor tier or the exact model;
- the fact contract which the result must satisfy.

The executor result must pass fact validation before it becomes canonical state.
An invalid result is a failed attempt, not a published fact.

A model-executor node consumes one model turn. It is the only part of a wide
workflow which does.

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
| 3 | Fixed-width quorum region and its evaluation contract | 1, 2 |
| 4 | Model-executor node and the executor contract | 3 |
| 5 | Bounded concurrent selection and workspace leases | 4 |
| 6 | Derived fan-out from a collection fact | 5 |
| 7 | Dogfood and release | 6 |

Slices 1 to 3 are domain work. They need no executor, and tests can cover them
with recorded facts. A fixed-width review quorum therefore becomes available
before M7.

## 11. Acceptance criteria

- A review quorum of N reviewers publishes one boolean verdict, and the workflow
  spends no model turn on the count.
- A best-of-N region selects one branch by a numeric fact with no model turn.
- A union region merges findings, removes duplicates, and reports the removed
  count.
- An aggregate node becomes ready only when every live branch is terminal.
- Replay reproduces every branch identity, every reduction, and every route.
- A gate outside a region cannot read a branch-scoped fact.
- Two branches can publish the same fact name. Two nodes outside a region cannot.
- A model evaluator uses the M5A evaluation contract and its budget.

## 12. Out of scope

- a model which writes an orchestration script at run time;
- a reduction which calls a model;
- an unbounded branch count;
- a resident process which watches branches. Design rule 3.9 rejects one.
