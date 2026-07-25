# Graph capability review against two reference workflows

- Status: analysis
- Updated: 2026-07-25
- Baseline commit: `0d1375a`
- Baseline release: `v0.6`
- Verified baseline: `npm run check` passes. TypeScript reports no error. Vitest runs 95 test files and 461 tests.
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This document compares the current Hypagraph implementation with two reference workflows.

Reference workflow A is an agentic engineering loop. It reads an issue backlog, spawns one agent session for each issue, implements the work in a worktree, runs checks, routes to review, human input, or a hard stop, passes a human gate, and then runs a continuous release loop.

Reference workflow B is a planner and reviewer fan-out. It plans a task, gives the work to a resident worker agent, sends the result to N reviewers at the same time, synthesises the reviews, decides pass or fail, returns feedback to the worker on failure, and presents a result to the user on success.

The document also answers three design questions:

1. can a node run in code mode?
2. can a node perform a presentation action when it returns to the user for approval?
3. does the orchestration of the graph and its loops cost model budget?

## 2. What the implementation provides today

The runtime provides a deterministic execution kernel for one root workflow in one Pi session.

Deterministic parts:

- a pure reducer over an append-only event stream;
- dependency readiness and route-aware invalidation;
- typed facts and typed conditions;
- gate routing without model judgement;
- bounded iteration regions with typed success, hard limits, progress, patience, validity, and failure policy;
- deterministic checks: command, test report, lint report, coverage report, metric report, file assertion, and Git assertion;
- trusted evaluation contracts with purpose, trust, integrity, and evaluation budgets;
- workflow-derived goal completion, failure, blockage, and cancellation;
- turn and token budgets with exactly-once accounting;
- a pure continuation selector with round-robin fairness across independent components;
- durable external-effect ordering, cancellation, retry, restore, and replay;
- a live graph pane.

Model parts:

- one authoring turn which compiles prose into one canonical definition;
- one turn for each selected canonical action;
- one bounded automatic revision when the runtime classifies a blocker.

The model cannot select a route, complete a loop, or complete a goal. This rule is enforced in the reducer and in the tool surface.

## 3. Reference workflow A: agentic engineering loop

| Diagram element | Status | Evidence or gap |
| --- | --- | --- |
| Linear backlog tagged `ready-for-agent` | Absent | The runtime has no external work source, no trigger adapter, and no schedule. A goal starts from one prose objective which a user types. |
| Spawn one agent session for each issue in a new worktree | Absent | There is no executor adapter and no worktree lease. This is planned as M7 and M8. |
| Implement code in a worktree | Partial | Task nodes execute. Execution uses the current Pi session and the current checkout. `scope.paths` with strict mode limits file writes. |
| Tests and checks: lint, build, test suite | Available | Seven check kinds run without a shell, with timeout, retry, cancellation, bounded artifacts, and typed facts. |
| On failure, revise loop | Available | A loop region declares entry, evaluation boundary, feedback edges, typed success, a hard iteration limit, progress, patience, validity, and failure policy. |
| Ready for review, conditions met | Partial | Typed success and gates work. No node can publish a pull request or change external review state. |
| Needs human, paused for input | Absent | The nearest state is `block-node` with goal status `blocked`. That is a fault state. Recovery needs the user to type `/hypagoal resume`. There is no typed user response, no approval fact, and no graph edge from a human answer. |
| Hard stop, limit or budget hit | Available | Goal turn and token budgets, loop iteration limits, patience, and evaluation budgets all produce explicit typed stops. |
| Human gate: review and merge | Absent | There is no approval node and no Git host integration. |
| Merged items queued for release | Absent | The session supports one root workflow and one root goal. There is no queue aggregate and no fan-in from outside the graph. |
| Release candidate, build and test again | Partial | The check kinds exist. The trigger and the queue do not. |
| Promote to production after checks pass | Absent | There is no effect node with external authority, no deployment adapter, and no approval binding. |
| Both loops run continuously | Absent | The design is bounded. A loop must declare a hard iteration limit. A goal reaches a terminal state and stops. There is no daemon, schedule, or automatic re-entry. |

Result: the middle of workflow A is the strongest part of the current product. The implement, check, revise, and hard-stop path is available now. The two ends are absent. Both ends cross a process boundary which the kernel does not yet cross.

## 4. Reference workflow B: planner and reviewer fan-out

| Diagram element | Status | Evidence or gap |
| --- | --- | --- |
| Task to Planner | Available | The bundled skill and `hypagoal_start` compile prose into one canonical graph in one turn. |
| Plan Reviewer and plan feedback | Partial | A review node is representable. A plan-feedback cycle is not. The only automatic re-plan path is the one bounded revision. It permits one attempt, it needs a classified blocker, and it rejects weakening changes. |
| Worker as a resident agent | Absent | A node cannot declare an executor, an agent identity, or a session lifetime. |
| Fan-out to Reviewer 1 to N at the same time | Absent, and a hard blocker | `enumerateRootWorkActions` returns an empty list when more than one node is active. The controller queues one continuation. Execution is strictly sequential. |
| A runtime-sized number of reviewers | Absent | A definition is static. There is no map region over a runtime collection. |
| Resident agent against ephemeral worker | Absent | The model has no node lifetime concept. |
| Synthesise | Available | `requires` gives structural fan-in. |
| Pass decision | Available | A gate evaluates a typed condition over published facts. |
| No, return feedback to Worker | Available | A loop feedback edge provides this. |
| Turn into haiku | Available | This is an ordinary task node. |
| Send to user | Absent | There is no output node. A result reaches the user as incidental chat text. It is not a canonical node with evidence. |

Result: every structural element of workflow B except fan-out is available or close. Parallel fan-out is the single hard blocker. Dynamic N and the final user-facing output node are the next two gaps.

## 5. Question 1: code mode nodes

### Current state

Code mode is partly available today, for observation only.

A `metric-report` check runs a bounded command without a shell, reads one JSON report inside the workspace, and publishes declared typed facts of type boolean, integer, number, or string. The `evaluation` block is optional. A metric report without an `evaluation` block is a plain code-to-facts node.

A `command` check publishes only `passed`, `status`, `exitCode`, `durationMs`, `timedOut`, and `cancelled`.

### What is missing

1. A check is in the check lane. It has no writable scope, no evidence submission, and no verification step. A mutating command is therefore unbounded and unverified.
2. A command has no input contract. Arguments are static in the definition. A command cannot read facts which earlier nodes published.
3. Generic fact output is tied to the metric and evaluation vocabulary.

### Reference implementation: pi-fabric

`pi-fabric` (https://github.com/monotykamary/pi-fabric) is a programmable tool and agent runtime for Pi. It is MIT licensed. At version 0.25.10 it depends on the same Pi 0.80.x peer line which Hypagraph uses.

Its execution model is one type-checked TypeScript program in a QuickJS sandbox. The sandbox denies `process`, `require`, the file system, the network, and subprocess globals. Every side effect crosses a JSON-only host bridge into an action registry, which applies schemas, approvals, audit records, timeouts, and cancellation. The program reaches Pi tools through `pi.*`, MCP servers through `mcp.<server>.<method>()`, and runtime-discovered tools through `tools.call({ ref, args })`. Only the returned value enters the model context. Each execution receives a fresh context.

This is a better mechanism for a Hypagraph code node than a bounded command with a JSON report file.

### Two possible placements

The placement decides whether pi-fabric complements Hypagraph or replaces it.

Placement A is the node body. The program performs the work of one node. The graph keeps sequencing, readiness, routing, iteration, evidence, and replay. Hypagraph must adopt this placement.

Placement B is the orchestrator. The model writes one program which contains the branching, the loops, and the fan-out for the whole workflow. This is what the bundled workflow, council, and swarm skills do. Hypagraph must reject this placement. Control flow inside an opaque program is not a gate, a loop region, a typed fact, or a replayable decision. Placement B would remove the property which the rest of this document identifies as the strongest part of the product.

### Proposal: a `code` node kind on a sandbox executor

Add a task-lane node whose body is a program, and run it behind the existing executor seam:

- execution: run the program in the QuickJS sandbox. This replaces the earlier proposal to reuse `CommandExecutionDefinition` with `spawn`. It removes the unbounded mutation risk of a raw command, because the sandbox denies file, network, and subprocess access, and every effect crosses the bridge.
- input: inject the declared fact inputs as typed bindings. The sandbox already throws on an undeclared key instead of returning `undefined`. This satisfies the bounded-context rule in the roadmap section 3.7 and removes the need to materialise a JSON input file.
- output: validate the returned object against the node `produces` contract in the controller. Do not trust the bridge validation. The pi-fabric documentation states that directive output is schema validated and still untrusted.
- scope: verify a mutating program with the existing `git-assertion` instrument and `changed-paths`.
- lane: keep task semantics of attempt, evidence, and verification, and use no model turn.

### Constraints which Hypagraph must add

pi-fabric lets the model write the program at call time. Hypagraph cannot allow this inside a node, because every definition must pass validation before execution.

1. Author the program during the authoring turn or the bounded revision turn. Store it in `HypagraphDefinition`. Include it in the snapshot hash.
2. Run the TypeScript check at definition time, not only at execution time.
3. Keep the sandbox on the executor side. The reducer must stay pure, as required by `AGENTS.md`.
4. Record the program result as an event and use the existing durable order of store start, run effect, store raw result, publish facts. Replay must replay the recorded result. Replay must never run the program again.
5. Route a program which the runtime discovers later through `hypagraph_revise` or the bounded-revision path.

### What this mechanism does not solve

A code node cannot perform semantic work. The reviewers in reference workflow B need model judgement, so they need the M7 executor, not a sandbox program.

`Promise.all` inside one program is not graph fan-out. It hides the branches from the graph. It removes per-branch attempts, evidence, retry, graph-pane visibility, and replay granularity. Use it only for deterministic input and output inside one node. Do not use it for the reviewer fan-out in reference workflow B, and do not use it in place of N6.

### Effect on other gaps

- N5 effect nodes become much cheaper. An effect node becomes a code node with an idempotency key. The MCP surface removes the need for one adapter for each external service.
- N1 presentation actions become cheaper. A node can run a skill or render a report through the bridge without a model turn. The typed response contract and the non-fault wait state remain Hypagraph work.
- M7 keeps its scope. A sandbox executor is a second executor kind behind the same seam, next to the planned isolated Pi executor. It confirms the shape of the seam. It does not replace it.

## 6. Question 2: presentation and approval nodes

### Current state

Nothing is first class. `EvidenceReference` accepts `kind: "approval"`, but that is only a label on a reference. There is no approval node, no user response contract, and no skill invocation surface.

### Proposal: an `interaction` node kind

An interaction node has three parts.

1. Presentation effect. The node performs one bounded presentation action before it asks the question. Effect kinds can include:
   - `skill`: run a named Pi skill, for example a plan annotation skill;
   - `command`: produce an artifact;
   - `report`: render an HTML or Markdown artifact from a canonical projection.
   Reuse the `CheckExecutor` seam. It is already transport neutral. Reuse the durable lifecycle order: store the request, perform the effect, store the observation, then publish facts.

2. Typed response contract. The node declares the permitted responses. Each response maps to typed facts. Free text is captured as evidence only. Free text must never select a route. Routing then uses an ordinary gate over the published facts, so the change adds no new routing semantics.

3. A non-fault wait state. Add node status `awaiting_response` and goal status `awaiting_user`. Add events `hypagraph.interaction.requested` and `hypagraph.interaction.answered`. The controller must not treat the wait as blockage, must not consume budget during the wait, and must resume from a typed user event.

Restore policy needs one decision. The current policy pauses an active goal after a reload. An unanswered interaction must survive a reload and must be presented again. It must not force the whole goal into a manual pause.

## 7. Question 3: orchestration cost

### The orchestration is already deterministic

Selection, readiness, routing, loop decisions, completion, and budgets are all pure code. `selectGoalContinuation` is a pure function of canonical state. The model cannot choose a route or complete a goal. This part already meets the intent, and it is the strongest property of the system.

### The remaining cost is dispatch, not orchestration

Every selected action is delivered as a Pi follow-up through `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Every delivered continuation is charged one substantive turn and its tokens.

Two of the four work actions need no reasoning:

- `run-ready-check` runs through `runPiCheck`, which is a function of state, executor, and store;
- `evaluate-ready-gate` is one `evaluate-gate` reducer command.

The model turn exists only to make the tool call.

A graph with three tasks, four checks, and two gates therefore costs at least nine model turns. Six of those turns perform no reasoning. Inside an iteration region the ratio becomes worse, because each iteration adds one evaluation check turn and one gate turn.

### Proposal: a deterministic dispatch lane

When the selector returns `run-ready-check` or `evaluate-ready-gate`, execute the action in the controller process and then select again. Queue a Pi follow-up only for `start-ready-task`, `continue-active-task`, and `request-revision`.

Effects:

- the reducer, the events, and the state-bound identity rules do not change;
- a deterministic action consumes no turn and no tokens;
- the largest avoidable model cost is removed;
- one class of stale-continuation failure is removed, because no state can change during a wait for a model turn;
- task work becomes the only model surface, which is what the later executor abstraction needs.

Constraints to respect:

- keep `hypagraph_run_check` for manual use;
- keep cancellation working through the existing active-execution registry;
- re-check the no-canonical-progress guard, because it compares sequences across a delivered turn.

This change is small, it adds no new domain concept, and it should be done first.

## 8. Gap list

Already planned in `docs/execution-roadmap.md`:

- M6: event history, replay, and debugger UI;
- M7: goal families, child goals, executor abstraction, and isolated Pi execution;
- M8: worktree leases, integration, and bounded concurrency;
- M9: ACP and named CLI adapters.

Not yet planned:

- N1: interaction and approval nodes, with skill and report presentation effects, typed responses, and a non-fault wait state;
- N2: a deterministic dispatch lane for checks and gates;
- N3: a `code` node kind on a sandbox executor, with injected fact input, validated fact output, and scope verification. See section 5 for the pi-fabric reference implementation;
- N4: external work sources, triggers, schedules, and a continuous service mode with one bounded goal for each item;
- N5: effect nodes with external authority, for example open a pull request, merge, deploy, or notify, with idempotency keys and durable effect ordering;
- N6: dynamic fan-out over a runtime collection. Reviewer 1 to N needs this. "Merged items queued for release" needs the same mechanism.

## 9. Distance to each reference workflow

Workflow B without the human parts needs M7, M8, and N6. That is the next two planned milestones plus dynamic fan-out.

Workflow B in full also needs N1 for plan approval and a user-facing output node.

Workflow A needs everything above, and also N4 and N5. It is the further target for two reasons. It crosses three external process boundaries, which are the issue tracker, the Git host, and the deployment target. It also requires continuous operation, which conflicts with the current bounded and terminal goal model. That conflict is a product decision, not only an implementation gap.

## 10. Recommended order

1. N2 deterministic dispatch. It is small, it adds no domain concept, and it removes the largest avoidable model cost.
2. N1 interaction nodes. They unblock the human gate in both reference workflows, and they reuse the executor and durable-lifecycle seams which already exist.
3. N3 code mode on a sandbox executor. It completes the deterministic lane and it makes N5 a special case. Hypagraph adopts the pi-fabric execution pattern behind a Hypagraph-owned adapter. It does not depend on the pi-fabric package. The decision and the adapter contract are in `docs/code-node-adapter-plan.md`.
4. M7 and M8 as planned. They provide the executor abstraction, the worktree isolation, and the concurrency which fan-out needs.
5. N6 dynamic fan-out.
6. N4 and N5 for the complete engineering loop.

Scheduling note: M6 is the active milestone. N1 and N2 add event types and node statuses. Complete N2 and N1 before or with M6, so that the history and replay views do not need rework.
