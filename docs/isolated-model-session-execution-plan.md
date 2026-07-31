# Isolated model-session execution plan

- Status: slices 1–3 and 6–7 code complete; slices 4–5 deferred
- Applies to: root and family Hypagoal model-lane dispatch
- Related: `docs/goal-family-and-concurrent-execution-plan.md`, `docs/delegation-and-visualisation.md`, `docs/durable-lifecycle-storage.md`, `docs/authoring-tools-and-project-store-plan.md`, `docs/research/grok-build-workflows-comparison.md`
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This plan defines the work required to meet the product intent below.

**Product intent**

The main Pi session is the orchestrator. It is not the default runner for model node work.

Each model node attempt must run in:

- its own isolated session, or
- an explicit fork or resume of another worker session,

not in the main orchestrator thread.

This matches the Grok Build workflow product shape: the host drives the run; each unit of semantic agent work is a cold or resumed subagent session; results return as structured data; the orchestrator conversation stays free of implement turns.

Hypagraph must reach that product shape **without** adopting Rhai script orchestration as the kernel. The graph controller remains the only authority for selection, budgets, settlement, and completion.

## 2. Current behaviour

### 2.1 What is already implemented

| Capability | Status |
| --- | --- |
| Pure controller selection after authoring | Shipped |
| Deterministic lane for checks, gates, code, effects | Shipped |
| Executor abstraction and structured results | Shipped |
| `current-session` executor | Shipped; root model path still uses it |
| `isolated-pi` RPC executor | Shipped as adapter |
| ACP and CLI executors | Shipped as adapters |
| Worktree isolation for mutating concurrent attempts | Shipped (M8) |
| Family concurrent default kind `isolated-pi` | Shipped for that dispatch path |
| Root model-lane follow-up in the live Pi session | Shipped; this is the gap |

### 2.2 Root path today

After `hypagoal_start`, the root controller selects a model-lane action and does this:

1. store `request-goal-continuation`;
2. build a continuation prompt;
3. call `pi.sendUserMessage(..., { deliverAs: "followUp" })` in the **same** session.

The orchestrator chat then implements the node. That violates the product intent.

### 2.3 Terminology

Use these terms consistently.

| Term | Meaning |
| --- | --- |
| Orchestrator session | The main Pi session where the user runs `/hypagoal`, status, pause, resume, and chat |
| Worker session | An isolated process or RPC session that performs one model node attempt |
| Model node | A node whose selected action needs a model turn (task, automatic revision, and any future model-executor kind) |
| Deterministic node | A node the host runs without a model turn (check, gate, code, effect when deterministic) |
| Session fork | A new worker session that starts from a recorded prior worker session identity |
| Session affinity | Policy that routes a later attempt to the same worker lineage through fork or resume |

A child Hypagoal remains a nested workflow, not a worker session. A worker session executes one selected attempt for one node.

## 3. Decision

### 3.1 Default routing

For every model-lane node attempt:

1. Default executor kind is `isolated-pi` (or a configured default non-current-session kind such as `acp`).
2. The orchestrator session must not perform the attempt body.
3. The orchestrator may only select, dispatch, await, settle, present status, and talk with the user.

### 3.2 Explicit exceptions

These may use the orchestrator session:

1. **Authoring turn** for `/hypagoal` and draft construction. Authoring creates the graph. It must not implement repository work.
2. **User-facing interaction nodes** that must present UI in the live session, unless a later design moves interaction presentation to a dedicated surface.
3. **Explicit opt-in** `current-session` profile on a node, only when the definition sets it. Product default must not set it.
4. **Diagnostic host commands** such as `/hypagoal status` and `/hypagraph executor`.

These must never use the orchestrator session for attempt body work:

1. ordinary task nodes;
2. loop task bodies;
3. automatic revision turns that change repository files or graph content through model tools;
4. child-goal task nodes;
5. any future model-executor node.

### 3.3 Grok Build alignment

Borrow these product properties:

| Grok Build | Hypagraph target |
| --- | --- |
| Workflow host stays the driver | Graph controller stays the driver |
| `agent()` runs outside the main chat | Model node attempt runs in a worker session |
| Result returns to the host | Structured `ExecutorResult` settles through the controller |
| Optional `resume_from` for continuity | Optional session fork or resume policy |
| Parallel agents for fan-out | Concurrent isolated attempts under M8 limits |

Do not borrow:

- script-owned completion;
- model-owned spawning as the scheduler;
- raw assistant text as the only result contract.

### 3.4 Source of truth

Unchanged.

- Canonical state remains the event stream (and project event log when that store lands).
- Worker sessions are executors. They submit untrusted results.
- Only the controller commits transitions.

## 4. Target control flow

```text
User / orchestrator session
        |
        | /hypagoal, status, pause, resume, chat
        v
  Controller (host)
        |
        | select next action
        +-- deterministic node --> run in host --> settle --> select again
        |
        +-- model node --> materialize executor context
                         --> start or fork worker session
                         --> await structured result
                         --> validate and settle
                         --> select again
```

The orchestrator session must not receive an implement continuation prompt for a model node under default policy.

## 5. Session model

### 5.1 Cold session (default)

Each model node attempt starts a fresh worker session with:

- attempt identity in the context envelope;
- bounded projected facts, artifacts, scope, and budgets;
- node contract and writable scope;
- no orchestrator chat history;
- no sibling attempt history unless affinity policy supplies a fork source.

This is the default, like a cold Grok `agent()` call.

### 5.2 Session fork and resume

Some work needs continuity across attempts, for example:

- the same task continues after a partial submit;
- a loop iteration should keep prior local investigation context for one node lineage;
- a revision should see the same worker’s recent diagnosis.

Support two explicit mechanisms.

**Fork**

- Create a new worker session from a recorded source session id.
- The new attempt gets a new attempt id.
- The source session remains immutable history.

**Resume**

- Continue the same worker process or durable session when the adapter supports it.
- Allowed only while the attempt identity and node contract still match controller expectations.
- Reload, cancel, timeout, and crash still settle through normal interrupted paths.

Affinity is controller policy. The model cannot invent a fork target.

### 5.3 Affinity policy

Declare affinity on the node or profile:

```ts
type SessionAffinityPolicy =
  | { kind: "none" }                 // default: cold session
  | { kind: "same-node-lineage" }     // fork or resume last successful or last open attempt on this node
  | { kind: "same-loop-lineage" }     // optional later: reuse within one loop region and node
  | { kind: "explicit-session"; sessionId: string }; // advanced; host-validated
```

Default is `none`.

Do not default to reusing one long-lived worker for the whole workflow. That recreates main-thread coupling.

### 5.4 What the worker may see

The worker receives only the executor context envelope:

- family, goal, workflow, revision, node, attempt ids;
- objective and node contract;
- selected upstream facts and artifact refs;
- scope and workspace lease when present;
- attempt budgets;
- public loop and evaluation guidance when the action is in a loop;
- structured completion instructions (publish, submit, fail, cancel shapes).

The worker must not receive:

- full orchestrator chat;
- protected evaluator secrets beyond declared feedback mode;
- authority to mark the goal complete;
- authority to dispatch another node.

## 6. Orchestrator session duties

The main session remains responsible for:

1. authoring and draft construction;
2. presenting status, graphs, budgets, and executor host state;
3. user pause, resume, cancel, and replacement confirmation;
4. answering user questions about the run;
5. optional interaction-node UI;
6. receiving controller notifications when attempts start, settle, fail, or need user input.

The main session must not:

1. edit repository files for a selected task under default policy;
2. call task completion tools as if it were the worker, except for explicit `current-session` opt-in;
3. invent the next node outside controller selection.

## 7. Dispatch replacement

### 7.1 Remove default model-lane follow-up

Replace the root path that does:

```text
request-goal-continuation -> sendUserMessage(followUp)
```

with:

```text
select model action
  -> create attempt identity
  -> resolve executor profile (default isolated-pi)
  -> resolve affinity (default none)
  -> materialize context envelope
  -> acquire workspace lease when mutation requires it
  -> dispatch worker session
  -> record in-flight executor state
  -> on result: settleExecutorResult
  -> select next action
```

### 7.2 Continuation request semantics

Keep a durable “work is pending” concept, but rename product meaning if needed:

- old: pending continuation means a model turn is queued in this Pi session;
- new: pending model attempt means a worker session is in flight for a selected action.

Events must distinguish:

- orchestrator follow-up pending (legacy or interaction-only);
- isolated executor attempt pending.

Replay and restore must rebuild in-flight executor state and must not re-prompt the orchestrator to implement the node.

### 7.3 Settlement

All worker completions use the shared settlement path already used by isolated executors:

- validate identity;
- validate facts and evidence;
- apply submit, fail, cancel, timeout, or interrupt outcomes;
- charge usage to goal and family budgets;
- never trust free text alone for completion.

### 7.4 Failure and cancellation

| Case | Required behaviour |
| --- | --- |
| Worker crash | Settle interrupted; controller may retry per policy |
| User cancel | Host tears down worker; settle cancelled |
| Timeout | Settle timed_out |
| Orchestrator reload | Do not leave a silent in-flight worker; reconcile or interrupt per durable lifecycle rules |
| Stale result | Reject by attempt and snapshot identity |

## 8. Authoring defaults

### 8.1 Node and profile defaults

When a definition omits an executor profile on a model node:

- assign default profile `{ profileId: "isolated-pi-default", kind: "isolated-pi" }`.

When a definition sets `kind: "current-session"`:

- accept only as explicit opt-in;
- surface an authoring advisory that the orchestrator will perform that node.

### 8.2 Recipe and construction tools

When constructor authoring lands (`docs/authoring-tools-and-project-store-plan.md`):

- recipes must not set current-session;
- loop recipe tasks use isolated-pi;
- import of old fixtures may keep current-session only if tests require it.

### 8.3 Skill and prompts

Update skill and continuation guidance:

1. orchestrator implements no task body by default;
2. worker prompts teach publish, submit, evidence, and scope only for the selected node;
3. remove “continue implementation in this turn” language from orchestrator continuations.

## 9. Interaction with other systems

### 9.1 Deterministic lane

Unchanged. Checks, gates, code, and deterministic effects stay in the host. They need no worker session.

### 9.2 Worktrees

Mutating isolated attempts keep M8 worktree rules:

- lease;
- prepare worktree;
- run worker in worktree cwd;
- validate and integrate;
- conflict state on failure.

Cold sessions and forks both respect the active lease for that attempt.

### 9.3 Budgets

Each worker attempt charges:

- model turns and tokens from executor usage;
- evaluation budgets when applicable;
- family and goal limits already defined.

Orchestrator status and user chat turns are not task attempts. Define clearly whether orchestrator chat consumes goal turn budget. Recommended default:

- charge only worker model usage and explicit revision attempts against the goal budget;
- do not charge pure status questions in the orchestrator session.

Record the decision in implementation if product chooses differently.

### 9.4 Project store

When `.hypagraph` project storage lands:

- store worker session ids and attempt indexes under the workflow or family store;
- store bounded worker transcripts only when configured;
- do not treat worker transcripts as canonical state.

### 9.5 UI

Show in status and family surfaces:

- orchestrator vs worker role;
- active worker sessions;
- attempt id, node id, executor kind, affinity source;
- cancel action for in-flight workers.

The live graph must not imply that the main chat is performing a task when a worker owns the attempt.

## 10. Compatibility and migration

### 10.1 Behaviour change

This is a breaking product behaviour change for users who rely on implement turns in the same chat.

Migration rules:

1. New runs default to isolated model sessions.
2. Existing definitions without profiles get isolated-pi on load or on next revision projection.
3. Tests that assumed current-session follow-ups must move to executor harnesses.
4. A temporary settings flag may restore legacy current-session routing for dogfood comparison. Default off. Remove after one release cycle unless product keeps an advanced opt-in.

### 10.2 Schema

If node definitions gain affinity or default profile fields, include schema version handling per repository rules.

Before first external adoption of those fields, unsupported stored values may reject with a clear error. Prefer additive optional fields with defaults.

## 11. Non-goals

This plan does not:

1. make the model the scheduler;
2. replace the graph with Grok Rhai scripts;
3. require a worker session for deterministic nodes;
4. make every child Hypagoal a process (child goals are workflows; their tasks still use workers);
5. stream full worker chat into the orchestrator context by default;
6. implement keyword arming or authoring constructors (separate plans);
7. solve protected isolated evaluators (separate trust adapter work).

## 12. Implementation slices

### Slice 1. Routing policy and defaults — done

Deliver:

- default model-node profile resolution to `isolated-pi`;
- explicit `current-session` opt-in only;
- pure policy tests for profile resolution;
- authoring advisory helper for current-session.

### Slice 2. Root dispatch through isolated executor — done (code)

Deliver:

- replace root `sendUserMessage` implement follow-up with `dispatchIsolatedPiAttempt` for default tasks;
- host in-flight attempt records for root goals;
- settlement on completion with auto-verify after submit;
- no implement prompt in orchestrator session for default tasks;
- live dogfood with a real Pi worker process remains pending.

### Slice 3. Restore, cancel, and orphan reconciliation — done (code)

Deliver:

- reload and branch-change teardown of in-flight workers;
- user cancel from `/hypagraph executor cancel` with task cancel;
- double-settle rejection tests;
- timeout and crash settlement use existing isolated adapter paths.

### Slice 4. Session fork and affinity — deferred

Deliver:

- record worker session ids on attempt completion;
- affinity policy `none` and `same-node-lineage`;
- fork or resume adapter support in isolated-pi;
- tests that a second attempt can fork the first when policy requests it;
- default remains cold session.

### Slice 5. Automatic revision and loop task bodies — deferred

Deliver:

- automatic revision model work uses worker sessions;
- loop task iterations use cold or affinity policy as configured;
- orchestrator only receives loop status, not implement body.

### Slice 6. Interaction and current-session boundaries — done (code)

Deliver:

- interaction nodes remain orchestrator-safe;
- block accidental task tools in orchestrator while a worker owns the active task;
- clear diagnostics when the orchestrator tries to act as the worker.

### Slice 7. UI, skill, and docs — done (partial)

Deliver:

- status and executor surfaces for worker attempts;
- skill product rules for orchestrator versus worker;
- release notes for the behaviour break deferred to packaging;
- suite-wide test flag `HYPAGRAPH_LEGACY_CURRENT_SESSION` keeps old follow-up fixtures; product default remains isolated-pi.

## 13. Acceptance criteria

1. After `/hypagoal` authoring, the first ready task does not produce an implement follow-up in the orchestrator session under default policy.
2. That task starts an isolated worker session with a distinct process or RPC session identity.
3. Repository file edits for the task occur under the worker (and worktree when required), not under orchestrator tool calls.
4. Settlement uses structured executor results and attempt identity.
5. Deterministic checks and gates still run in the host without worker sessions.
6. Explicit `current-session` nodes still run in the orchestrator when opted in.
7. Reload does not strand an invisible worker without reconciliation.
8. Cancel from the orchestrator stops the worker and settles cancelled.
9. Cold session is the default. Affinity is opt-in and tested.
10. The pure domain reducer still does not spawn processes or read the clock for reduction decisions beyond existing allowed host metadata boundaries.

## 14. Risks

1. **Latency and cost** — cold sessions lose chat cache warmth. Mitigate with optional affinity and smaller envelopes.
2. **Weaker local continuity** — workers lack orchestrator banter. Mitigate with better context envelopes and node contracts, not by returning work to the main thread.
3. **Pi RPC operational fragility** — process bootstrap, providers, and tool loading must be production-hardened. Use existing isolated-pi adapter and expand tests.
4. **Double-writer bugs** — orchestrator and worker both editing files. Mitigate with tool blocking in orchestrator while a worker owns the active mutating attempt.
5. **Interaction UX** — human gates still need the main session. Keep interaction as an explicit exception.
6. **Test migration cost** — many root continuation tests assume same-session follow-ups. Plan a dedicated harness rewrite in Slice 2.

## 15. Open decisions

Record answers before the affected slice.

1. Is the default worker kind always `isolated-pi`, or configurable to `acp` at project settings level?
2. Do orchestrator-only chat turns consume goal turn budget?
3. Does automatic revision default to cold session or `same-node-lineage` from the blocked task attempt?
4. Are worker transcripts stored under `.hypagraph` by default, opt-in, or never?
5. How long does the temporary legacy current-session settings flag remain?

Recommended defaults:

1. Default `isolated-pi`; allow project setting override to `acp` when configured.
2. Do not charge pure orchestrator status chat to the goal task budget.
3. Automatic revision uses cold session with the blockage and graph projection in the envelope; optional later affinity.
4. Worker transcripts opt-in; store ids and usage always.
5. Legacy flag for one release, then remove from defaults. Keep explicit per-node opt-in.

## 16. Relation to other plans

| Plan | Relation |
| --- | --- |
| `docs/goal-family-and-concurrent-execution-plan.md` | Defines executors and isolation. This plan makes isolated workers the default root path, not only the concurrent family path. |
| `docs/delegation-and-visualisation.md` | Subagent means attempt executor. This plan enforces that boundary in product routing. |
| `docs/authoring-tools-and-project-store-plan.md` | Authoring stays in the orchestrator. Execution leaves it. Project store can record worker metadata. |
| `docs/trigger-and-command-surface-plan.md` | Arming still starts work; it must not imply same-session implementation. |
| `docs/research/grok-build-workflows-comparison.md` | UX reference for host-driven subagent units of work. |

## 17. Immediate next work

1. Accept or amend this plan and the open decisions in section 15.
2. Implement Slice 1 and Slice 2 first. They close the user-visible defect that implement work runs in the authoring session.
3. Implement Slice 3 before broad dogfood.
4. Add Slice 4 affinity only after cold-session default is stable.
5. Update skill, README, and release notes in Slice 7 with the behaviour break.
6. Keep authoring-tool and keyword-arming plans sequenced so weak authoring does not mass-produce graphs that still execute correctly in workers.
