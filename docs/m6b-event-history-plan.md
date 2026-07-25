# M6B event history, replay, and debugger UI vertical-slice plan

- Status: active
- Milestone: M6B
- Release marker: v0.7
- Prerequisite: M6A deterministic dispatch lane
- Must complete before: M6.1 interaction and approval nodes
- Roadmap source: `docs/execution-roadmap.md` section 8
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

M6B makes execution and decisions inspectable.

Hypagraph already stores an append-only event stream. It already rebuilds the same state from that stream. The user cannot yet read the stream, move through it, or ask why the runtime made a decision.

The runtime knows the answer to each of these questions. The product does not show it.

## 2. Product result

The user can:

- read the event timeline for the active workflow;
- replay canonical state to any event;
- compare replay state with live state;
- ask why a node or a goal is not runnable, and receive the canonical reason;
- read revision boundaries and stale results;
- keep graph positions stable across a small revision.

A directly dispatched action from M6A appears in the timeline. The timeline shows its lane, and it separates that action from a delivered model turn.

## 3. Problem statement in the current code

The event model is complete. The presentation is absent.

1. `applyEvent` and `replayEvents` rebuild state from events. Neither function can stop at a chosen sequence.
2. The event store keeps `PersistedEventBatch` entries in the Pi session branch. No projection reads them for presentation.
3. `projectGraphView`, `workflowSummary`, and `projectHypagoalSurface` project the live snapshot only. Each one accepts a `HypagraphState`, so each one can already project a replayed state. No surface passes one.
4. `renderHypagoalStatus` explains the next action. It does not explain why another node is not the next action.
5. The graph pane renders the live view. It has no timeline, no selected event, and no replay mode.

M6B adds projection and presentation. M6B does not change the reducer, the event model, or the schema.

## 4. Contracts

### 4.1 Timeline entry

```ts
export type TimelineLane = "workflow" | "node" | "check" | "fact" | "route" | "loop" | "evaluation" | "goal" | "dispatch";

export interface TimelineEntry {
  sequence: number;
  eventId: string;
  type: string;
  timestamp: string;
  revision: number;
  lane: TimelineLane;
  summary: string;
  nodeId?: string;
  attemptId?: string;
  loopId?: string;
  dispatch?: { dispatchId: string; lane: "deterministic" | "model" | "executor" };
  redacted: boolean;
}
```

### 4.2 Replay result

```ts
export interface ReplayResult {
  sequence: number;
  state: HypagraphState;
  entry: TimelineEntry;
}
```

### 4.3 Decision explanation

```ts
export type NotRunnableReason =
  | { kind: "dependency"; blockedBy: string[] }
  | { kind: "skipped-route"; gateNodeId: string; outcomeId: string }
  | { kind: "terminal"; status: string }
  | { kind: "loop-exhausted"; loopId: string; exitReason: string }
  | { kind: "check-policy"; code: string; message: string }
  | { kind: "active-elsewhere"; nodeId: string }
  | { kind: "goal-stopped"; code: string; reason: string }
  | { kind: "runnable" };

export interface NodeExplanation {
  nodeId: string;
  status: string;
  reason: NotRunnableReason;
}
```

## 5. Mandatory rules

### 5.1 Keep the reducer pure

M6B adds projection functions only. A projection must not store an event, call an executor, read the clock, or change canonical state.

### 5.2 Never repeat an effect during replay

Replay rebuilds state from stored events. Replay must not run a check, call an executor, or perform an external effect. This rule already holds for `replayEvents`. Each new replay entry point must keep it.

### 5.3 Use one projection for live state and replay state

The live view and the replay view must call the same projection functions. A separate history projection would drift from the live projection and would break the comparison in section 2.

`projectGraphView`, `workflowSummary`, and `projectHypagoalSurface` each accept a `HypagraphState` today. Each history surface must pass a replayed `HypagraphState` to the same function.

### 5.4 Keep protected evaluator data protected

A history view must apply the existing redaction. A protected evaluator command, report path, raw report, standard output, standard error, and failure reason must stay protected in the timeline, in the replay view, and in every explanation.

The timeline entry must record `redacted` when it hides evaluator detail, so the user knows that the runtime withheld data and did not lose it.

### 5.5 Project an unknown event type

M7 adds family and executor events. M8 adds workspace and integration events. A stored event with an unknown type must project to a generic timeline entry. It must not throw and must not stop the timeline.

This rule gives the projection seam which the roadmap requires.

### 5.6 Bound the rendered timeline

An event stream has no fixed length. A timeline surface must page. A default page must show the most recent events. Replay must accept a sequence, not a scan of the complete stream for each key press.

### 5.7 Add no persisted state

History is derived. M6B must not add a schema version, an event type, or a stored field.

This rule keeps M6B free of the migration question and keeps the milestone reversible.

### 5.8 Keep graph positions stable

`graphLayoutKey` already derives a layout key. A small revision must not move unrelated nodes. The debugger must reuse this key when it renders a historical revision.

## 6. Vertical slices

### Slice 1 - Timeline projection

Scope:

1. Add `projectEventTimeline(events)` which returns `TimelineEntry[]`.
2. Classify each current event type into a lane.
3. Summarize each event in one short sentence.
4. Apply evaluator redaction and set `redacted`.
5. Project an unknown event type to a generic entry.

Tests:

- every current event type produces one entry with the correct lane;
- an unknown event type produces a generic entry and does not throw;
- a protected evaluator event hides its command, report, and output, and sets `redacted`;
- a deterministic dispatch entry reports lane `deterministic`, and a model continuation entry reports lane `model`;
- the timeline order matches the stored sequence order.

Exit: the complete event stream has a typed presentation model. No surface uses it yet.

### Slice 2 - Replay to an event

Scope:

1. Add `replayToSequence(events, sequence)` which returns a `ReplayResult`.
2. Reject a sequence which the stream does not contain, with a clear error.
3. Add `compareReplayWithLive(replayState, liveState)` which reports the differing node statuses, routes, loops, facts, and goal state.

Tests:

- replay to the final sequence equals the stored snapshot;
- replay to an intermediate sequence produces the historical state, and not the live state;
- replay runs no check and calls no executor;
- the comparison reports an empty difference when the sequences match;
- the comparison reports the changed nodes, routes, and goal fields for an earlier sequence.

Exit: the runtime can produce any historical state on demand.

### Slice 3 - Decision explanation

Scope:

1. Add `explainNode(state, nodeId)` which returns a `NodeExplanation`.
2. Add `explainGoal(state)` which reports the canonical stop or continuation decision.
3. Reuse `dependenciesAreSatisfied`, `evaluateCheckStart`, `classifyGoalBlockage`, and `selectGoalContinuation`. Do not restate their rules.

Tests:

- a pending node reports its unsatisfied dependencies by ID;
- a skipped node reports the gate and the outcome which skipped it;
- a check which cannot retry reports the canonical check-policy code;
- a node inside an exhausted loop reports the loop and the exit reason;
- a runnable node reports `runnable`;
- a stopped goal reports the canonical stop code and reason;
- an explanation for a protected evaluator node hides evaluator detail.

Exit: the runtime can answer "why is this not runnable" from canonical state alone.

### Slice 4 - The `/hypagraph history` surface

Scope:

1. Add a `history` action to the `/hypagraph` command. It renders the most recent timeline page.
2. Add `history <sequence>` which renders the replayed state at that sequence through `renderWorkflow`.
3. Add `explain <nodeId>` which renders the node explanation.
4. Add a model-visible history read through `hypagraph_read`, with the same redaction.

Tests:

- the default page renders the most recent entries and reports the total count;
- a requested sequence renders the historical workflow view;
- an out-of-range sequence reports a clear error and changes no state;
- the explain action renders the canonical reason;
- the model-visible history hides protected evaluator detail;
- the narrow and the wide rendering each stay inside the requested width.

Exit: a user can read history and explanations without leaving Pi.

### Slice 5 - The debugger pane

Scope:

1. Add a timeline mode to the graph pane.
2. Let the user select an event and render the graph at that event.
3. Show the live and replay difference from Slice 2 next to the graph.
4. Keep graph positions stable across a small revision through `graphLayoutKey`.
5. Return to live mode with one key.

Tests:

- the pane renders a selected historical event and marks the mode as replay;
- the pane returns to live state and clears the replay mode;
- a revision which adds one node does not move the unrelated nodes;
- the replay mode performs no canonical change and no external effect;
- the pane renders inside a narrow terminal width.

Exit: the user can move through execution visually.

### Slice 6 - Revisions, stale results, and future seams

Scope:

1. Mark each revision boundary in the timeline.
2. Report an invalidated node and an invalidated loop at its revision.
3. Report a stale result which the runtime rejected.
4. Confirm the generic projection for the future family, executor, workspace, and integration namespaces with a fixture.

Tests:

- a revision boundary appears once for each `hypagraph.workflow.revised` event;
- an invalidated node and an invalidated loop appear at their revision;
- a stale result appears with its canonical rejection reason;
- a fixture event in the `hypagraph.family.*` namespace projects to a generic entry;
- replay across a revision boundary produces the correct historical definition.

Exit: history describes the complete canonical record, and the later milestones have a defined seam.

### Slice 7 - Dogfood and release

Scope:

1. Run one realistic objective which contains tasks, checks, gates, one iteration region, and one revision.
2. Inspect the timeline, replay to three events, and explain one blocked node.
3. Record evidence in `docs/m6b-dogfood.md`.
4. Update the README status list and the changelog.

## 7. Acceptance criteria

- Replay to any event produces the correct historical state.
- Live and replay views use common projection code.
- The user can identify why a node or a goal is not runnable.
- Protected evaluator data remains protected in every history view.
- The future family, executor, workspace, and integration namespaces project through a defined seam.
- The history view shows a directly dispatched M6A action and separates it from a delivered model turn.
- Replay performs no check, no executor call, and no external effect.
- M6B adds no schema version, no event type, and no stored field.

## 8. Out of scope

- a persisted history index, because the event stream is the record;
- an event search language, because a page and a lane filter meet the stated need;
- family and executor history, which belong to M7;
- interaction history, which belongs to M6.1;
- any change to node, attempt, check, fact, route, loop, evaluation, goal, or dispatch event semantics.

## 9. Open question for the milestone owner

Section 5.6 requires a paged timeline. The event stream currently reaches Pi through the session branch, and `restoreLatestSession` reads every entry to rebuild the latest snapshot.

A long-running goal can produce a large stream. Confirm one of these before Slice 4:

1. the timeline reads the session branch on each request, which needs no new state and costs one scan for each page;
2. the extension holds the projected timeline in memory for the active session, which costs memory and needs an invalidation rule on reload and branch change.

Option 1 keeps rule 5.7 and is the recommended default. Option 2 is a performance decision which needs a measured reason.
