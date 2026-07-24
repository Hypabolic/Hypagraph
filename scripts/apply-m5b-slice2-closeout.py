from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} target, found {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"Missing {label} start marker")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f"Missing {label} end marker")
    return text[:start_index] + replacement + text[end_index:]


baseline = "3656caf3e62d26d3dc406e93b5b5e71e96cbfae8"

# Replace the obsolete Slice 1 -> Slice 2 handoff with a focused Slice 3 handoff.
Path("docs/session-handoff.md").write_text(f"""# Session handoff: M5B Slice 2 complete to Slice 3

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `{baseline}`
- Last merged pull request: #65 — Add atomic Hypagoal creation
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 2, atomic `/hypagoal` creation
- Current slice: M5B Slice 3, graph-aware continuation
- Hypagoal tracking issue: #25
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/hypagoal-vertical-slice-plan.md`;
4. `docs/goal-family-and-concurrent-execution-plan.md`;
5. `docs/product-spec.md`;
6. `docs/delegation-and-visualisation.md`;
7. `docs/automatic-graph-authoring.md`;
8. `docs/loop-region-product-model.md`;
9. `docs/trusted-evaluation-contract-plan.md`;
10. `docs/execution-roadmap.md`;
11. `docs/m5b-slice-2-dogfood.md`.

Use issue #25 as the active M5B checklist.

The goal-family plan is authoritative for later family scheduling, child goals, isolated executors, worktrees, and physical concurrency. Slice 3 must preserve compatibility with that plan without implementing it.

## 2. Product decisions that must not change

### 2.1 One workflow-local lifecycle per goal

Each Hypagoal owns one canonical Hypagraph workflow.

The existing `GoalRuntime` remains the workflow-local lifecycle for the root and every future child goal. Do not replace or duplicate its commands, events, reducer policy, replay, restore validation, snapshot hashing, or workflow-derived terminal state.

`HypagraphDefinition.goal` remains the human-readable objective. Lifecycle state remains separate under `goalControl`.

There is no goal node, second task model, second workflow definition, parallel completion state machine, `complete-goal` command, or model-owned terminal state.

### 2.2 Root-only is a v0.6 product boundary

The current Pi product surface has one root goal and one root workflow.

This is not a domain invariant that a session can never persist more than one workflow aggregate. Later family persistence composes separate workflow-local goals under one family controller.

Slice 3 must use identities and action contracts that can later be lifted into that family scheduler without replacement.

### 2.3 Workflow state remains authoritative

Goal completion, failure, blockage, cancellation, and pause remain derived from canonical workflow state.

Continuation decides whether another action may be requested or dispatched. It does not decide that semantic work is complete.

### 2.4 Independent components remain independent

A disconnected branch or loop region remains a normal runnable root component.

The continuation selector must inspect all runnable root components. It must not assume that:

- the most recently active component owns the next turn;
- the component which produced the last event has priority;
- a connected main path outranks a disconnected loop automatically;
- an active or completed component can pause, reset, release, fail, or complete an unrelated component.

The v0.6 controller interleaves components through sequential Pi turns. Later family scheduling can apply the same selection contract across multiple workflow aggregates and isolated executors.

### 2.5 Restore remains side-effect free

Restore and replay rebuild canonical state only.

They must not queue a continuation, send a user message, dispatch model work, run a check, invoke an executor, resume a component, or start a subagent.

Reload and branch-change pause behavior belongs to Slice 4.

### 2.6 Existing loop and evaluation semantics remain canonical

Slice 3 consumes existing node readiness, loop state, check policy, gate readiness, evaluation validity, integrity, budget, and failure-policy state.

It must not add a second loop, evaluator, loss, progress, or outcome model.

Trusted holdout acceptance still requires isolated execution. Slice 3 must not claim that isolated execution exists.

## 3. M5B Slice 2 delivered

PR #65 adds atomic root Hypagoal creation.

The merged implementation provides:

- `/hypagoal <objective>`;
- model-facing `hypagoal_start`;
- repository-aware graph-authoring guidance;
- exact preservation of the user objective;
- one pure workflow-plus-goal creation operation;
- deterministic event ordering;
- workflow definition, initial readiness, and goal start in one event batch;
- one append against expected empty sequence;
- candidate validation before persistence;
- no active-state exposure before persistence succeeds;
- explicit workflow, goal, revision, event, session, branch, operation, and correlation identity;
- typed replacement-required results;
- replacement confirmation bound to workflow ID, goal ID, revision, sequence, snapshot hash, session generation, and branch generation;
- stale authoring-operation rejection after session or branch change;
- rejection of silent replacement through `hypagraph_define`;
- replay and restore without work dispatch;
- structured and text output which separates objective and `goalControl`;
- explicit confirmation that autonomous continuation has not started.

### Slice 2 implementation map

- `src/domain/hypagoal-creation.ts`: pure atomic creation operation.
- `src/hypagoal/root-creation.ts`: root product boundary, replacement, validation, and one-append persistence.
- `src/pi/hypagoal.ts`: model schema, authoring prompt, ready-work projection, and output formatting.
- `src/extension.ts`: `/hypagoal`, `hypagoal_start`, authoring lease, and Pi exposure.
- `tests/hypagoal-creation.test.ts`: domain, persistence, replay, restore, conflict, and replacement coverage.
- `tests/hypagoal-pi.test.ts`: command/tool equivalence, authoring identity, smoke, and no-continuation coverage.
- `docs/m5b-slice-2-dogfood.md`: executable evidence.

### Slice 2 evidence

Implementation baseline:

```text
{baseline}
```

Final CI #722 passed:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 83 test files and 333 tests.

## 4. Current architecture map

### Domain and projection

- `src/domain/model.ts`: workflow, goal, loop, evaluation, command, and event contracts.
- `src/domain/reducer.ts`: canonical transitions and workflow-to-goal synchronization.
- `src/domain/projection.ts`: deterministic replay and snapshot hashing.
- `src/domain/readiness.ts`: canonical runnable-node derivation.
- `src/domain/goal-policy.ts`: pure workflow-to-goal outcome policy.
- `src/domain/hypagoal-creation.ts`: atomic creation candidate.

### Root creation and Pi

- `src/hypagoal/root-creation.ts`: current root product boundary.
- `src/pi/hypagoal.ts`: creation schema and presentation.
- `src/extension.ts`: Pi events, commands, tools, authoring state, and UI.
- `skills/hypagraph/SKILL.md`: bundled authoring and execution guidance.

### Persistence and recovery

- `src/persistence/event-store.ts`: optimistic event append and branch leases.
- `src/persistence/pi-session-store.ts`: Pi session event batches.
- `src/persistence/session-rebuild.ts`: replay, snapshot verification, loop validation, and goal validation.

### Future seams

The current Pi adapter exposes one active root. Do not convert that adapter limitation into a workflow-domain invariant.

Later work adds family membership, multiple workflow aggregates, one family scheduler, executor dispatch, workspace leases, and concurrent execution above the current workflow-local lifecycle.

## 5. Current task: M5B Slice 3 — graph-aware continuation

### 5.1 User result

After `/hypagoal` creates the root, Hypagraph can request the next Pi turn automatically until canonical state says to stop.

Slice 3 must complete a multi-node root workflow, including disconnected or independent runnable components, without a manual continuation prompt after every turn.

### 5.2 Pure continuation decision

Add one pure decision function over canonical state.

The function must return a typed decision such as:

```ts
export type GoalContinuationDecision =
  | {{ kind: "stop-completed"; goalId: string; workflowId: string; revision: number }}
  | {{ kind: "stop-paused"; goalId: string; workflowId: string; revision: number }}
  | {{ kind: "stop-blocked"; goalId: string; workflowId: string; revision: number; reason: string }}
  | {{ kind: "stop-failed"; goalId: string; workflowId: string; revision: number; reason: string }}
  | {{ kind: "continue-active-task"; goalId: string; workflowId: string; revision: number; nodeId: string }}
  | {{ kind: "start-ready-task"; goalId: string; workflowId: string; revision: number; nodeId: string }}
  | {{ kind: "run-ready-check"; goalId: string; workflowId: string; revision: number; nodeId: string }}
  | {{ kind: "evaluate-ready-gate"; goalId: string; workflowId: string; revision: number; nodeId: string }}
  | {{ kind: "invariant-error"; goalId?: string; workflowId?: string; revision?: number; reason: string }};
```

Include loop identity when the selected action is materially associated with a loop region. Do not create a root-only action shape which must later be replaced for family scheduling.

The pure function must not call Pi, read the clock, generate IDs, inspect files, run commands, invoke a model, or mutate state.

### 5.3 Deterministic selection across all runnable root components

The selector must enumerate all runnable actions from canonical state before it chooses one.

Selection must be deterministic and tested against stable definition order or another explicit stable key. It must not depend on object-map iteration, wall-clock time, event-recency heuristics, UI focus, or the most recently active component.

At minimum, candidate enumeration must include:

- the current active task when it can continue;
- every ready task;
- every runnable check;
- every ready gate;
- ready work in disconnected branches;
- ready entries or nodes in independent loop components.

No component may starve solely because another component emitted the latest event.

### 5.4 Continuation action identity and stale rejection

Every queued continuation must bind to the exact canonical state which selected it.

At minimum include:

- goal ID;
- workflow ID;
- workflow revision;
- node ID or gate/check identity;
- loop ID when applicable;
- session generation;
- branch generation;
- canonical sequence or snapshot hash where the current adapter supports it;
- continuation ordinal or operation identity.

Before delivery, re-read active state and reject the continuation if any bound identity is stale.

### 5.5 Pi delivery

Use one scheduling authority in the extension.

The adapter may queue at most one continuation. It must not queue when:

- goal control is not active;
- workflow state is terminal;
- a user or tool message has priority;
- another continuation is already queued;
- the session or branch generation changed;
- the selected action is stale;
- no runnable action exists.

`agent_end` can request delivery only after the prior turn's state changes are durable.

The continuation prompt must identify the selected goal, workflow, revision, and node or loop action. It must guide the model to use existing Hypagraph tools and must not bypass node lifecycle rules.

### 5.6 Required tests

Add focused domain and Pi tests proving:

- pure decisions for terminal, paused, blocked, active-task, ready-task, check, and gate states;
- deterministic candidate ordering;
- selection across disconnected branches and independent loops;
- no assumption that the last active component owns the next turn;
- no starvation in a representative interleaving sequence;
- explicit goal and workflow identity on every runnable action;
- revision, sequence/hash, session-generation, and branch-generation stale rejection;
- at most one queued continuation;
- no continuation during creation;
- no continuation during restore or replay;
- no continuation after user interruption;
- command and check lifecycle rules remain canonical;
- one realistic Pi smoke completes a multi-node graph with an independent component without manual follow-up prompts.

### 5.7 Deferred from Slice 3

Do not add:

- token or turn budgets;
- reload-time pause or resume policy;
- automatic graph revision;
- child Hypagoals or family persistence;
- executor or subagent abstraction;
- worktree leases;
- physical concurrency;
- a new loop or evaluation model;
- production isolated evaluation;
- the full administrative `/hypagoal` command surface.

### 5.8 Done when

Slice 3 is complete when:

- continuation decisions are pure, deterministic, replay-compatible, and identity-rich;
- one queued Pi continuation drives the root graph without manual prompts;
- all runnable root components participate in deterministic selection;
- disconnected and independent loop components can progress without recency-based ownership or starvation;
- stale continuation delivery is rejected;
- creation and restore remain side-effect free;
- the action contract can later be lifted into the family scheduler;
- the realistic Pi smoke and full six-target CI matrix pass.

Suggested branch:

```text
agent/m5b-slice-3-graph-aware-continuation
```

Suggested pull request title:

```text
Add graph-aware Hypagoal continuation
```

## 6. Work after Slice 3

Continue M5B in this order:

1. Slice 4: token and turn budgets plus reload safety.
2. Slice 5: loop and trusted-evaluation continuation details and fairness.
3. Slice 6: blockage and bounded revision.
4. Slice 7: complete Pi product surface.
5. Slice 8: dogfood and v0.6 release.

After v0.6:

1. M6: event history, replay, and debugger UI.
2. M7: family persistence, bounded child Hypagoals, executor abstraction, and isolated Pi execution.
3. M8: worktree integration and bounded concurrent scheduling.

Do not tag or release v0.6 during Slice 3.
""")

# Update the vertical-slice plan.
path = Path("docs/hypagoal-vertical-slice-plan.md")
text = path.read_text()
text = replace_once(text, "- Status: active implementation; Slice 1 complete", "- Status: active implementation; Slices 1 and 2 complete; Slice 3 current", "vertical status")
slice2 = """### Slice 2 - Atomic `/hypagoal` creation — complete

PR #65 delivered:

- `/hypagoal <objective>` and model-facing `hypagoal_start`;
- repository-aware compilation of the smallest useful graph;
- exact preservation of `HypagraphDefinition.goal`;
- one pure workflow-plus-goal creation operation;
- deterministic definition, readiness, and goal-start event ordering;
- one durable append against expected empty sequence;
- candidate replay and restore validation before exposure;
- explicit goal, workflow, revision, sequence, snapshot, session, branch, operation, and correlation identity;
- typed replacement-required results and stale confirmation rejection;
- stale authoring-operation rejection after session or branch change;
- no continuation, executor, subagent, or restore-time side effect;
- realistic Pi command-to-tool smoke evidence.

The merge baseline is `3656caf3e62d26d3dc406e93b5b5e71e96cbfae8`.

CI #722 passes 83 test files and 333 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The one-root rule remains a v0.6 Pi product boundary. The workflow domain remains compatible with later family persistence.

"""
text = replace_between(text, "### Slice 2 - Atomic `/hypagoal` creation — next\n", "### Slice 3 - Graph-aware continuation\n", slice2, "Slice 2 section")
path.write_text(text)

# Update the execution roadmap.
path = Path("docs/execution-roadmap.md")
text = path.read_text()
text = replace_once(text, "- Current implementation baseline: `0bbe7f227fc28262958f29992cece9c663ecad2a`", f"- Current implementation baseline: `{baseline}`", "roadmap baseline")
text = replace_once(text, "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slice 1 complete |", "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1 and 2 complete |", "roadmap milestone status")
text = replace_once(text, "1. Canonical goal lifecycle — complete in PR #62.\n2. Atomic `/hypagoal` creation — next.\n3. Graph-aware continuation.", "1. Canonical goal lifecycle — complete in PR #62.\n2. Atomic `/hypagoal` creation — complete in PR #65.\n3. Graph-aware continuation — current.", "roadmap slice status")
insert = """### Slice 2 result

M5B Slice 2 provides:

- `/hypagoal <objective>` and `hypagoal_start`;
- repository-aware root graph authoring;
- exact objective preservation;
- one deterministic workflow-definition, readiness, and goal-start event batch;
- one-append persistence with no partial active state;
- typed, state-bound replacement confirmation;
- explicit creation, workflow, goal, revision, sequence, session, branch, and correlation identity;
- replay and restore without autonomous work;
- complete dogfood evidence in `docs/m5b-slice-2-dogfood.md`.

Slice 3 must select deterministically across every runnable root component. It must include goal and workflow identity on continuation actions, support disconnected and independent loop components, avoid recency-based component ownership, and preserve a direct lift into the later family scheduler.

"""
text = replace_once(text, "### M5B architecture constraints\n", insert + "### M5B architecture constraints\n", "roadmap Slice 2 result insertion")
path.write_text(text)

# Update the product specification.
path = Path("docs/product-spec.md")
text = path.read_text()
text = replace_once(text, "- Version: implementation baseline through M5B Slice 1", "- Version: implementation baseline through M5B Slice 2", "product version")
text = replace_once(text, "- Current baseline: `0bbe7f227fc28262958f29992cece9c663ecad2a`", f"- Current baseline: `{baseline}`", "product baseline")
text = replace_once(text, "M5B Slice 1 implements the workflow-local `GoalRuntime`, commands, events, replay, restore validation, and workflow-derived terminal projection.\n\nThe v0.6 product supports one root Hypagoal in one Pi session.", "M5B Slice 1 implements the workflow-local `GoalRuntime`, commands, events, replay, restore validation, and workflow-derived terminal projection.\n\nM5B Slice 2 implements atomic root creation through `/hypagoal` and `hypagoal_start`. It preserves the exact prose objective, persists definition, initial readiness, and goal start in one event batch, requires state-bound replacement confirmation, and does not queue continuation.\n\nThe v0.6 product supports one root Hypagoal in one Pi session.", "product Hypagoal Slice 2")
text = replace_once(text, "- goal replay, restore validation, hashing, and UI summaries.", "- goal replay, restore validation, hashing, and UI summaries;\n- atomic root Hypagoal creation from ordinary prose;\n- typed stale-safe root replacement;\n- explicit creation and correlation identity;\n- creation and restore without autonomous continuation.", "product implementation bullets")
text = replace_once(text, "M5B Slice 1 is complete in PR #62. Slice 2, atomic root `/hypagoal` creation, is the current implementation target.", "M5B Slices 1 and 2 are complete in PRs #62 and #65. Slice 3, graph-aware continuation across all runnable root components, is the current implementation target.", "product current target")
text = replace_once(text, "4. M5B root Hypagoal autonomous controller — active; Slice 1 complete.", "4. M5B root Hypagoal autonomous controller — active; Slices 1 and 2 complete.", "product delivery status")
text = replace_once(text, "CI #661 passes:", "CI #722 passes:", "product CI number")
text = replace_once(text, "The complete suite contains 81 test files and 307 tests.", "The complete suite contains 83 test files and 333 tests.", "product test count")
path.write_text(text)

# Add the implemented root-authoring contract to automatic authoring documentation.
path = Path("docs/automatic-graph-authoring.md")
text = path.read_text()
section = """## Atomic root Hypagoal authoring

`/hypagoal <objective>` starts a read-only repository-authoring turn.

The authoring path must:

1. preserve the exact objective in `HypagraphDefinition.goal`;
2. inspect relevant repository state;
3. compile the smallest valid canonical workflow;
4. keep independent top-level components independent;
5. add tasks, checks, gates, loops, and metrics only when repository evidence justifies them;
6. return advisories separately from canonical definition fields;
7. submit the complete definition through `hypagoal_start` once.

The command binds the authoring turn to an explicit operation identity and the current session and branch generations. The tool rejects a missing or stale authoring identity.

The creation service validates the complete projected workflow and workflow-local goal lifecycle, then persists definition, initial readiness, and goal start in one event batch. It exposes no candidate state before persistence succeeds.

Creation does not start a task, run a check, queue a continuation, invoke an executor, or resume an independent component. Restore remains side-effect free.

If a root already exists, replacement requires confirmation bound to the exact current workflow, goal, revision, sequence, snapshot hash, session generation, and branch generation. The one-root restriction is a v0.6 product rule, not a permanent workflow-domain invariant.

"""
text = replace_once(text, "## 3. Smallest useful graph\n", section + "## 3. Smallest useful graph\n", "automatic authoring root section")
path.write_text(text)
