# Goal-family and concurrent-execution plan

- Status: accepted product direction
- Date: 2026-07-24
- Current implementation baseline: M5B Slice 1 at `0bbe7f227fc28262958f29992cece9c663ecad2a`
- Depends on: `docs/hypagoal-vertical-slice-plan.md`
- Related architecture: `docs/delegation-and-visualisation.md`
- Research source: https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Hypagraph must support objectives that discover more bounded objectives during execution.

A running Hypagoal can create a child Hypagoal. The child owns a separate canonical Hypagraph. The parent and child remain part of one bounded goal family.

This capability gives Hypagraph recursive goal decomposition without adding model-owned orchestration or an unbounded prose loop.

The initial v0.6 release remains a root-only Hypagoal controller. This plan defines the additive architecture that follows that release.

## 2. Decisions

### 2.1 Keep one workflow for each goal

Each Hypagoal owns exactly one canonical Hypagraph workflow.

Do not embed a complete `HypagraphDefinition` inside a parent node. Do not merge child nodes into the parent workflow definition after execution starts.

A goal family composes independently versioned workflow aggregates.

### 2.2 Preserve the M5B Slice 1 lifecycle

M5B Slice 1 added one optional `GoalRuntime` to `HypagraphState`.

That state remains the canonical lifecycle for the goal which owns that workflow. The future family model must reference and coordinate these workflow-local goal runtimes. It must not replace their reducer, events, replay, hashes, or workflow-derived terminal rules.

The first root goal is therefore the first member of a future one-member goal family.

### 2.3 Use one family controller

Goals and workflows do not own independent schedulers.

One goal-family controller:

- observes every workflow in the family;
- derives runnable actions;
- applies budgets and resource limits;
- selects work;
- dispatches executor attempts;
- validates results;
- commits canonical events.

A child Hypagoal is a workflow aggregate. It is not a subagent and it does not compete for controller ownership.

### 2.4 Suspend only the invoking parent task

A child goal can be created only for an active parent task node.

Creation changes that task to a waiting state such as `waiting_for_child`. It does not pause:

- the parent goal;
- the parent workflow;
- an unrelated branch;
- an independent loop region;
- another child workflow.

The family scheduler recomputes runnable work after creation.

### 2.5 Separate logical and physical concurrency

The domain can contain many runnable components at the same time.

The first implementation can interleave those components through one Pi continuation. This is a valid first vertical slice.

The production design must also execute independent work concurrently through isolated executors. Sequential interleaving is not the final execution model.

### 2.6 Pass explicit context across graph boundaries

An executor receives a bounded context envelope derived from canonical state.

Do not depend on the complete parent chat transcript as the execution contract. A persisted child-agent session can improve continuity, but it is not canonical context.

Loss of an executor session must not make replay or recovery impossible.

## 3. Goal-family model

The planned family projection is similar to:

```ts
export interface GoalParentBinding {
  parentGoalId: string;
  parentWorkflowId: string;
  parentNodeId: string;
}

export interface GoalFamilyMember {
  goalId: string;
  workflowId: string;
  rootGoalId: string;
  parent?: GoalParentBinding;
  depth: number;
  childGoalIds: string[];
}

export interface GoalFamilyRuntime {
  familyId: string;
  rootGoalId: string;
  members: Record<string, GoalFamilyMember>;
  schedulerOrdinal: number;
  createdAt: string;
  updatedAt: string;
}
```

This projection sits above normal `HypagraphState` aggregates.

Each member still stores its existing workflow-local `GoalRuntime` and derives its status from its workflow.

## 4. Parent and child contract

A parent task declares or accepts a child-goal binding with:

- child objective;
- input facts and artifacts;
- output fact contracts;
- output evidence contracts;
- inherited or narrower repository scope;
- allocated token and turn budgets;
- failure policy;
- maximum depth and child-count checks.

A planned binding is similar to:

```ts
export type ChildGoalFailurePolicy =
  | "fail-parent-node"
  | "block-parent-node"
  | "return-for-revision";

export interface ChildGoalBinding {
  childGoalId: string;
  parentNodeId: string;
  inputFacts: string[];
  outputFacts: FactContract[];
  budget: GoalBudget;
  failurePolicy: ChildGoalFailurePolicy;
}
```

A child can be created from a task node only. A check or gate cannot create a child goal.

## 5. Atomic child creation

Child creation must be one family-level atomic operation.

The operation must:

1. validate the parent task and family bounds;
2. validate the child workflow definition;
3. record the parent-child binding;
4. change the parent task to `waiting_for_child`;
5. create and persist the child workflow;
6. start the child workflow-local goal lifecycle;
7. add the child to the family scheduler;
8. leave unrelated runnable components unchanged.

A failed operation creates no child workflow, no child goal, and no parent wait state.

The operation must not transfer controller ownership to the child.

## 6. Child completion and return

A child terminal result maps to its parent binding.

### Completed child

The controller:

1. validates declared child output facts, evidence, and artifacts;
2. records the return against the parent binding;
3. makes the parent task runnable for integration or verification.

Child completion does not complete the parent task automatically. The parent can still require integration, repository-wide checks, or additional evidence.

### Failed or blocked child

The controller applies the declared child failure policy.

### Budget-limited child

Budget exhaustion is not success. The controller records partial outputs and the stop reason, then applies the child failure policy.

### Cancelled child

Cancellation cannot complete the parent task. The controller applies explicit cancellation and parent-binding policy.

A stale result from a child workflow, revision, node, attempt, workspace lease, or family generation cannot change current state.

## 7. Family scheduler

The family scheduler sees the union of runnable actions from:

- the root workflow;
- connected and disconnected root components;
- independent loop regions;
- child workflows;
- deeper descendant workflows.

A planned action identity contains:

```ts
export interface ScheduledActionIdentity {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId?: string;
  loopId?: string;
  attemptId?: string;
}
```

The initial root-only Pi controller can still queue no more than one continuation. Later executors can run more than one selected attempt at the same time.

Only the family scheduler can dispatch work. A child goal, loop, worker, or model tool cannot enqueue autonomous work directly.

### 7.1 Deterministic selection

Selection must use deterministic policy and stable tie-breaking.

The policy should prioritize:

1. completion of an active atomic operation;
2. cancellation, recovery, and stale-result handling;
3. ready checks and gates which unblock work;
4. critical dependency-path work;
5. loop evaluation and hard-bound work;
6. other runnable components with age-based fairness.

The selected action and reason must be event-backed. Replay must not depend on a later scheduler implementation producing the same choice.

### 7.2 Resource constraints

Dispatch must respect:

- global concurrency limit;
- per-executor limit;
- per-goal limit when configured;
- dependencies and routes;
- loop ordering;
- concurrency groups;
- workspace leases;
- integration serialization;
- family budgets.

The initial concurrent default should be two isolated attempts.

## 8. Independent loops

An independent loop stays runnable when another component creates or executes a child goal.

Child creation cannot reset, pause, release, fail, or complete that loop.

A bounded loop still terminates through typed success, hard limit, patience, evaluation budget, cancellation, or explicit failure policy.

For auxiliary work which should run only while the root goal is active, add a later component completion policy:

```ts
export type ComponentCompletionPolicy =
  | "required"
  | "cancel-on-parent-completion";
```

`required` keeps current workflow-completion semantics.

`cancel-on-parent-completion` permits bounded auxiliary activity and records deterministic cancellation during successful family shutdown.

Detached execution which outlives the root goal is deferred. It requires separate ownership and persistence rules.

## 9. Context envelope

Every model executor receives a materialized context envelope.

The envelope should contain:

- family, goal, workflow, revision, node, and attempt identity;
- root and local objectives;
- goal ancestry breadcrumbs;
- node intent and acceptance criteria;
- read and write scopes;
- required evidence;
- selected upstream facts;
- selected artifacts;
- predecessor summaries;
- workspace lease and base revision;
- attempt budget;
- structured result protocol.

Dependency, route, data, feedback, and child-return edges determine which context enters the envelope.

The envelope must be bounded, inspectable, hashable, and reproducible from canonical state.

## 10. Executor contract

A child Hypagoal and a node executor are different concepts.

A child Hypagoal defines more canonical work. An executor performs one selected node attempt.

The planned executor interface must return structured data:

```ts
export interface ExecutorResult {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  outcome: "submitted" | "failed" | "cancelled" | "timed_out" | "interrupted";
  facts: FactInput[];
  evidence: EvidenceReference[];
  artifacts: ArtifactReference[];
  summary: string;
  diagnostics: ExecutorDiagnostic[];
  usage: ExecutorUsage;
  workspace?: ExecutorWorkspaceResult;
}
```

The worker does not mutate graph or family state. It submits an untrusted result envelope. The controller validates and commits state changes.

## 11. Isolated Pi executor

The first model executor should launch Pi in isolated RPC mode.

The implementation can reuse or adapt the MIT-licensed process lifecycle from `pi-codex-subagents`:

- Pi RPC process bootstrap;
- JSONL request correlation;
- explicit provider and model selection;
- explicit tool, skill, extension, and prompt loading;
- child-session persistence;
- process ownership verification;
- streaming activity events;
- steering and interruption;
- process-tree termination;
- crash and orphan reconciliation;
- bounded output storage.

Hypagraph must not copy these product semantics from that extension:

- raw final text as the canonical result;
- model-controlled spawning as the scheduler;
- concurrent mutation in one checkout;
- child completion which directly triggers an uncontrolled Pi turn;
- agent names as canonical attempt identity.

The reusable code must sit behind a Hypagraph-owned executor adapter.

## 12. Workspace isolation and integration

Each mutating attempt uses one git worktree and one workspace lease by default.

The controller must:

1. acquire a compatible lease;
2. create or prepare the worktree;
3. start the executor in that worktree;
4. validate changed paths and result identity;
5. validate evidence and artifacts;
6. integrate the worker commit into the base workspace;
7. enter explicit integration-conflicted state on conflict;
8. run post-integration checks in the base workspace;
9. complete the node only after integration succeeds.

Execution success and integration success remain separate states.

## 13. Bounds and budgets

Recursive creation must be bounded by configuration and root policy.

The initial family limits should include:

- maximum goal depth;
- maximum children for one goal;
- maximum total goals in one family;
- maximum concurrent attempts;
- maximum concurrent mutating attempts;
- token and turn budget for the root family;
- child allocation limits;
- maximum automatic child-creation attempts for one parent node.

Descendant usage is charged to the root family budget. A child allocation reserves or consumes part of that budget. It does not create new unaccounted capacity.

Child scope must equal or narrow the scope available to its parent binding.

## 14. Persistence and replay

Current Pi session persistence restores one latest workflow. Goal families require an additive family persistence layer.

A planned persisted shape is:

```ts
export interface PersistedGoalFamily {
  familyEvents: GoalFamilyEvent[];
  familySnapshot: GoalFamilyRuntime;
  workflows: Record<string, PersistedHypagraph>;
}
```

Per-workflow sequence numbers remain valid.

Cross-workflow operations also require a family sequence or transaction ordinal. Atomic child creation and child return must commit all affected family and workflow events as one accepted operation.

Correlation and causation IDs must connect:

- parent request;
- child creation;
- executor attempts;
- child terminal result;
- parent return processing.

Replay must reproduce family membership, bindings, scheduler selections, budgets, child outcomes, and parent effects.

## 15. Delivery sequence

### M5B and v0.6

Keep the current root-only Hypagoal release plan.

M5B must:

- preserve the completed Slice 1 workflow-local lifecycle;
- complete root atomic creation, continuation, budgets, loop integration, revision, UI, and dogfood;
- keep one active root goal in the Pi session;
- keep one queued Pi continuation;
- avoid persistence choices which require one session to equal one workflow forever;
- define continuation identities with goal and workflow IDs so they can lift into the family scheduler.

Nested Hypagoals and delegated execution remain deferred from the v0.6 release. They are accepted product direction, not rejected scope.

### M6 and v0.7

Deliver event history, replay, and debugger UI.

Also make the projections able to show future family, scheduler, executor, and workspace events without changing the workflow reducer.

### M7 and v0.8

Deliver execution composition in these vertical slices:

1. family persistence and root-as-single-member migration;
2. family scheduler with sequential dispatch;
3. bounded child-goal creation and return;
4. executor abstraction and structured context/result contracts;
5. isolated Pi RPC executor;
6. nested graph and goal-family UI.

M7 can expose child goals with sequential or limited dispatch. It must keep the architecture ready for physical concurrency.

### M8 and v0.9

Deliver safe concurrent execution:

1. worktree leases;
2. integration lifecycle;
3. bounded concurrent scheduling;
4. concurrent independent loops and child workflows;
5. fairness and resource limits;
6. crash recovery with active isolated attempts;
7. post-integration checks and stale integration rejection.

Nested Hypagoals become production-complete only when this isolation and concurrency path passes dogfood.

### M9 and v0.10

Add ACP and named direct CLI executors behind the same executor contract.

## 16. Required future dogfood

The family and concurrency dogfood must prove:

1. a root Hypagoal creates one child Hypagoal;
2. the child creates one grandchild within configured depth;
3. an independent root loop continues while child work runs;
4. at least two compatible isolated attempts execute concurrently;
5. conflicting workspace leases prevent unsafe concurrency;
6. each executor receives a reproducible context envelope;
7. descendant usage is charged to the family budget;
8. child outputs return through declared fact and evidence contracts;
9. child completion does not bypass parent integration or verification;
10. each child failure policy has deterministic parent effect;
11. restore while a child and an independent loop are active is safe;
12. stale child, executor, and integration results are rejected;
13. replay reproduces scheduler choices and the same terminal family result;
14. a worker cannot mutate canonical graph or family state directly;
15. loss of an optional child Pi session does not lose canonical execution context.
