# M5B Slice 3 graph-aware continuation dogfood

- Status: complete
- Dogfood date: 2026-07-24
- Implementation pull request: #67
- Tracking issue: #25
- CI run: #770
- Test result: 85 test files and 357 tests
- Matrix: Ubuntu, macOS, and Windows with Node.js 22 and 24
- Executable evidence: `tests/hypagoal-continuation.test.ts` and `tests/hypagoal-continuation-pi.test.ts`

## 1. Purpose

This record proves the M5B Slice 3 continuation path through the pure domain selector, canonical continuation-request event, Pi `agent_end` scheduling hook, state-bound follow-up delivery, normal task and gate lifecycle tools, replay, restore, and stale-delivery protection.

Slice 3 uses one root goal and one root workflow. The action and scheduling contracts keep explicit workflow-local identity so the same selector result can later become a candidate in the goal-family scheduler.

## 2. Pure continuation decision

`src/domain/goal-continuation.ts` derives one typed decision from canonical state.

A runnable action contains:

- goal ID;
- workflow ID;
- workflow revision;
- canonical event sequence;
- snapshot hash;
- continuation ordinal;
- action kind;
- node ID;
- loop ID when the node belongs to a loop region.

The selector does not call Pi, read the clock, create IDs, inspect files, run commands, invoke a model, or mutate state.

It returns explicit stop decisions for completed, paused, blocked, failed, and cancelled goals. Invalid workflow or goal combinations return an invariant error instead of a guessed action.

## 3. Deterministic component selection

The selector enumerates candidates in stable workflow-definition order.

Candidate enumeration covers:

- the current active task;
- every ready task;
- every runnable check;
- every ready gate;
- disconnected top-level branches;
- nodes in independent loop components.

`GoalRuntime.continuationOrdinal` is the event-backed round-robin cursor. The cursor makes the selection replayable and prevents the last event, current UI focus, or most recently active component from owning the next turn.

The domain test starts with a loop component before an independent task in definition order. After the first loop action, the next deterministic selection is the independent task even though the loop still has runnable work.

## 4. Canonical request and stale protection

The controller stores `hypagraph.goal.continuation-requested` before it sends the Pi follow-up.

The reducer re-selects the canonical action and rejects the request when any supplied identity is stale:

- goal ID;
- workflow ID;
- workflow revision;
- event sequence;
- snapshot hash;
- continuation ordinal;
- selected node or loop action.

Projection increments the continuation ordinal from the durable event. Replay reproduces the same workflow state, goal state, snapshot hash, and next selection cursor.

Before delivery, the Pi adapter validates the committed request against:

- current session generation;
- current branch generation;
- current goal and workflow;
- current revision;
- committed sequence;
- committed snapshot hash;
- requested continuation ordinal;
- current action readiness.

A stale continuation receives an inert control prompt. Mutating file and Hypagraph tools are blocked for that stale turn.

## 5. Pi-level smoke

The Pi extension smoke starts from this ordinary root objective:

```text
Complete a routed feature and one independent documentation task.
```

The authored graph contains:

1. a feature implementation task which publishes a route fact;
2. a disconnected documentation task;
3. a deterministic route gate;
4. primary and alternate routed finish tasks.

The smoke proves this automatic sequence:

```text
implement
  -> document
  -> route gate
  -> primary finish
  -> completed root goal
```

No manual continuation prompt is inserted between actions.

The smoke also proves:

- the independent component is selected before the gate after the first continuation request;
- the gate uses `hypagraph_transition` with the deterministic evaluate action;
- the unselected route is skipped canonically;
- the selected route completes normally;
- goal completion remains workflow-derived;
- four continuation requests produce continuation ordinal four;
- no continuation is queued after the terminal state;
- dynamic tool exposure is restored after each continuation turn.

## 6. User priority and no-progress behavior

A queued extension follow-up never overrides a different user prompt.

An interactive streaming steer or follow-up suppresses automatic continuation for that turn.

The adapter queues at most one continuation. If a delivered continuation produces no canonical state change, automatic continuation stops with a warning instead of creating an unbounded prose loop.

## 7. Restore and creation boundaries

Atomic `/hypagoal` creation still exposes no continuation before the creation turn ends.

Restore and replay clear adapter-local pending delivery state and do not queue a follow-up, dispatch model work, run a check, invoke an executor, or resume an independent component.

Existing interrupted-check and loop recovery remains canonical recovery behavior. It does not schedule semantic continuation.

## 8. Architectural review

The final implementation adds no:

- second workflow or task model;
- goal-family aggregate;
- child-goal state;
- executor or subagent abstraction;
- worktree state;
- physical concurrency;
- duplicate loop or evaluation semantics;
- model-owned completion path;
- restore-time semantic work dispatch.

The pure selector is workflow-local. The Pi extension is the only v0.6 scheduling authority. A later family scheduler can enumerate these same identity-rich workflow candidates across multiple member workflows without replacing the Slice 1 lifecycle or Slice 3 action contract.

## 9. CI evidence

CI #770 passed:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

The complete suite passed:

```text
Test Files  85 passed (85)
Tests       357 passed (357)
```

## 10. Slice decision

M5B Slice 3 satisfies the graph-aware continuation boundary:

- continuation decisions are pure and deterministic;
- runnable actions have explicit goal, workflow, revision, node, loop, sequence, snapshot, and ordinal identity;
- one durable request precedes each Pi follow-up;
- stale delivery is rejected;
- user messages retain priority;
- disconnected and independent loop components participate in deterministic selection;
- no component owns the next turn because it emitted the latest event;
- creation, replay, and restore do not start autonomous semantic work;
- no later goal-family or executor functionality was pulled into v0.6.

M5B Slice 4 can now add token and turn budgets plus reload and branch-change pause behavior over this continuation contract.
