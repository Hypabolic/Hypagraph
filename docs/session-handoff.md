# Session handoff: M5B Slice 1 complete to Slice 2

- Handoff date: 2026-07-24
- Repository: `Hypabolic/Hypagraph`
- Canonical branch: `main`
- Last merged baseline: `0bbe7f227fc28262958f29992cece9c663ecad2a`
- Last merged pull request: #62
- Active milestone: M5B Hypagoal
- Completed slice: M5B Slice 1, canonical goal lifecycle
- Next slice: M5B Slice 2, atomic `/hypagoal` creation
- Hypagoal tracking issue: #25
- Completed evaluation foundation: issue #30
- Release marker: v0.6 after M5B dogfood and release evidence

## 1. Read first

Read:

- `AGENTS.md`;
- `docs/hypagoal-vertical-slice-plan.md`;
- `docs/product-spec.md`;
- `docs/automatic-graph-authoring.md`;
- `docs/loop-region-product-model.md`;
- `docs/trusted-evaluation-contract-plan.md`;
- `docs/m5a-dogfood.md`.

Use issue #25 as the authoritative M5B checklist.

## 2. Product decisions that must not change

### 2.1 One canonical workflow

Hypagraph has one executable workflow graph.

Hypagoal controls that workflow. It must not add:

- a goal node;
- a second task model;
- a duplicate workflow definition;
- a parallel completion state machine;
- a model tool that marks a goal complete.

`HypagraphDefinition.goal` remains the human-readable objective.

### 2.2 Workflow state is authoritative

The reducer derives goal completion and failure from canonical workflow state.

There is no `complete-goal` command.

A model narrative, tool result, or Pi message cannot mark the goal complete.

Goal cancellation is explicit control cancellation. It does not rewrite the canonical workflow as successfully completed.

### 2.3 Goal control is continuation control

Hypagoal decides whether Pi may request another agent turn.

It does not decide that semantic task work is complete.

The continuation decision and automatic follow-up side effect belong to Slice 3. Slice 2 must not queue continuation.

### 2.4 Restore must not run autonomous work

Session restore rebuilds canonical state only.

Reload and branch-change pause behavior belongs to Slice 4.

No Slice 2 creation or restore path may silently queue work.

### 2.5 Generic loops and trusted evaluation remain canonical

Hypagoal consumes the existing loop and evaluation state.

It must not create a second loss, loop, evaluator, or outcome model.

A loop is a generic bounded iteration region. Repair is one pattern, not the default purpose.

Only isolated execution can support trusted holdout acceptance.

## 3. M5B Slice 1 delivered

PR #62 adds the canonical event-backed goal lifecycle.

The merged implementation provides:

- `GoalStatus` and `GoalRuntime`;
- optional top-level goal-control state in `HypagraphState`;
- goal state in snapshot hashing;
- `start-goal`;
- `pause-goal`;
- `resume-goal`;
- `cancel-goal`;
- `hypagraph.goal.started`;
- `hypagraph.goal.paused`;
- `hypagraph.goal.resumed`;
- `hypagraph.goal.blocked`;
- `hypagraph.goal.completed`;
- `hypagraph.goal.failed`;
- `hypagraph.goal.cancelled`;
- workflow-derived completion, failure, blockage, and workflow-pause projection;
- explicit recovery from paused or blocked goal state;
- replay and restore validation;
- text, structured, and compact UI summaries;
- source and session compatibility for workflows without goal control.

Structured summaries preserve the workflow objective under `goal`. Goal lifecycle state is exposed under `goalControl`.

### Slice 1 invariants proved

- Goal state belongs to exactly one workflow.
- A second goal cannot start against the same workflow.
- Invalid goal IDs are rejected.
- Completion occurs only after canonical workflow completion.
- Failure occurs only after canonical workflow failure.
- A fabricated `complete-goal` command is rejected without state mutation.
- Blockage includes a durable reason.
- Terminal state includes a completion time and reason.
- Replay reproduces the same goal state and snapshot hash.
- Restore validates identity, timestamps, terminal state, and workflow alignment.
- Workflows without goal state remain unchanged.

## 4. Slice 1 evidence

Implementation baseline:

```text
0bbe7f227fc28262958f29992cece9c663ecad2a
```

PR #62 added:

- `src/domain/goal-policy.ts`;
- goal types, commands, and events in `src/domain/model.ts`;
- reducer synchronization in `src/domain/reducer.ts`;
- goal projection in `src/domain/projection.ts`;
- restore validation in `src/persistence/session-rebuild.ts`;
- lifecycle summaries in `src/ui/format.ts`;
- `tests/goal-lifecycle.test.ts`;
- `tests/goal-failure.test.ts`.

CI #661 passes:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The suite contains 81 test files and 307 tests.

## 5. Current architecture map

### Domain and reducer

- `src/domain/model.ts`: workflow, loop, evaluation, goal, command, and event contracts.
- `src/domain/reducer.ts`: canonical command decisions and workflow-to-goal synchronization.
- `src/domain/projection.ts`: deterministic event projection and hashing.
- `src/domain/goal-policy.ts`: pure workflow-to-goal outcome policy.
- `src/domain/workflow-outcome.ts`: canonical workflow completion and loop policy.

### Authoring and Pi

- `src/extension.ts`: Pi commands and tools.
- `src/pi/definition.ts`: definition schemas and normalization.
- `skills/hypagraph/SKILL.md`: bundled model guidance.
- `docs/automatic-graph-authoring.md`: graph compilation model.

### Persistence

- `src/persistence/event-store.ts`: optimistic event persistence.
- `src/persistence/session-rebuild.ts`: restore, replay verification, and goal/loop validation.
- `src/pi/session-branch.ts`: session generation and stale-result protection.

## 6. Next task: M5B Slice 2

### User result

A user enters one prose `/hypagoal` objective. Hypagraph inspects the repository, creates one valid workflow, starts goal control, and persists the complete state atomically.

This slice creates the controller. It does not yet continue work automatically.

### Add

- `/hypagoal <objective>` command parsing;
- model-facing `hypagoal_start` tool;
- repository inspection guidance before graph creation;
- reuse of the existing automatic graph-authoring contract;
- one atomic workflow-plus-goal creation operation;
- replacement confirmation when a canonical workflow or goal already exists;
- strict validation before any state becomes canonical;
- one durable event batch containing workflow definition, readiness, and goal start;
- clear diagnostics for invalid definitions, invalid goal identity, conflicts, and stale session state;
- structured and text confirmation of the created objective, workflow, ready work, and goal-control status;
- Pi and persistence tests;
- one real Pi smoke test from ordinary prose.

### Atomicity rule

An invalid creation attempt must create no canonical workflow and no goal state.

Do not persist the workflow first and start the goal in a second fallible operation.

Build and validate the complete creation result in memory, then persist one event batch against expected sequence zero.

If persistence reports a branch or sequence conflict, do not present the candidate state as active.

### Replacement rule

The first release supports one canonical workflow and one goal per Pi session.

If either already exists:

- do not silently replace it;
- show the existing state;
- require explicit replacement confirmation;
- reject stale confirmation after the session generation or canonical sequence changes.

### Authoring rule

The user describes an objective, not a graph.

The skill must:

1. inspect relevant repository context;
2. compile the smallest valid graph-backed work contract;
3. use typed gates and checks where the objective requires them;
4. use generic bounded regions where repetition is required;
5. add metric progress only when a defensible deterministic metric exists;
6. preserve the exact user objective in `HypagraphDefinition.goal`;
7. return useful advisories without inventing unjustified evaluation contracts.

### Public surface for this slice

- Pi command: `/hypagoal <objective>`;
- model tool: `hypagoal_start`.

Administrative status, pause, resume, cancel, and graph subcommands remain scheduled for Slice 7 unless the command parser needs a minimal non-public seam now.

### Deferred

Do not add:

- automatic continuation;
- queued follow-ups;
- token or turn budgets;
- reload-time pause;
- bounded automatic revision;
- production isolated evaluation;
- a second workflow model.

### Done when

Slice 2 is complete when:

- one prose objective produces one valid workflow and one active goal;
- workflow and goal creation are one atomic persisted operation;
- an invalid graph leaves no canonical state;
- duplicate state requires explicit replacement confirmation;
- stale replacement confirmation is rejected;
- the objective remains the canonical definition goal;
- no continuation is queued;
- restore reproduces the created workflow and goal without running work;
- a real Pi smoke test proves the ordinary user path;
- all six CI jobs pass.

Suggested branch:

```text
agent/m5b-slice-2-hypagoal-creation
```

Suggested pull request title:

```text
Add atomic Hypagoal creation
```

## 7. Work after Slice 2

Continue M5B in this order:

1. Slice 3: graph-aware continuation.
2. Slice 4: token and turn budgets plus reload safety.
3. Slice 5: loop and trusted-evaluation continuation.
4. Slice 6: blockage and bounded revision.
5. Slice 7: complete Pi product surface.
6. Slice 8: dogfood and v0.6 release.

## 8. Release warning

The package version remains `0.5.0` during M5B development.

Do not tag current `main` as `v0.5.0`.

The intended historical v0.5 tag target remains:

```text
88ec3950bcbc07ce7148d940d0c65f6b176f3bc9
```

The v0.6 version and tag must wait until M5B dogfood and release evidence pass on a tested main commit.

## 9. Known hazards

- Do not create a second goal definition that duplicates the graph.
- Do not make model text authoritative for completion.
- Do not expose `start-goal` as an independent public path that can create mismatched state.
- Do not persist a workflow before the complete atomic creation result is valid.
- Do not queue autonomous work during creation or restore.
- Do not infer repair semantics for generic loops.
- Do not weaken M5A validity, trust, budget, or protected-output rules.
- Preserve event ordering, optimistic sequence checks, branch generation, and stale-result identity.
- Connector-authored commits can suppress push-triggered Actions. Use the PR `ready_for_review` trigger when required.
- Temporary patch workflows must remove themselves and must not remain in final diffs.

## 10. Successful next handoff

The next handoff is ready when:

- M5B Slice 2 is merged;
- issue #25 marks Slice 2 complete;
- `/hypagoal` creates workflow and goal atomically;
- invalid creation leaves no canonical state;
- replacement is explicit and stale-safe;
- no continuation runs during creation or restore;
- the real Pi smoke test passes;
- all six CI jobs pass;
- this document points to graph-aware continuation.
