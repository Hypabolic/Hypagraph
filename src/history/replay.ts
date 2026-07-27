import type { DomainEvent, HypagraphState } from "../domain/model.js";
import { applyEvent } from "../domain/projection.js";
import { projectEventTimeline, type TimelineEntry } from "./timeline.js";

export interface ReplayResult {
  sequence: number;
  state: HypagraphState;
  entry: TimelineEntry;
}

/**
 * Rebuild canonical state at one stored sequence.
 *
 * Replay reads stored events only. It must not run a check, call an executor, or
 * perform an external effect. The runtime already keeps that rule in `replayEvents`.
 */
export function replayToSequence(
  events: readonly DomainEvent[],
  sequence: number,
): ReplayResult {
  if (events.length === 0) throw new Error("The event stream is empty.");
  if (!Number.isSafeInteger(sequence)) throw new Error("A replay sequence must be a safe integer.");

  const first = events[0]!.sequence;
  const last = events[events.length - 1]!.sequence;
  if (sequence < first || sequence > last) {
    throw new Error(`The event stream has no sequence ${sequence}. It holds sequence ${first} to ${last}.`);
  }

  let state: HypagraphState | undefined;
  let applied = 0;
  for (const event of events) {
    if (event.sequence > sequence) break;
    state = applyEvent(state, event);
    applied += 1;
  }
  if (!state || state.sequence !== sequence) {
    throw new Error(`The event stream has no sequence ${sequence}.`);
  }

  const entry = projectEventTimeline(events.slice(0, applied)).at(-1)!;
  return { sequence, state, entry };
}

export interface NodeDifference {
  nodeId: string;
  replayStatus: string;
  liveStatus: string;
}

export interface RouteDifference {
  nodeId: string;
  replayOutcomeId?: string;
  liveOutcomeId?: string;
}

export interface LoopDifference {
  loopId: string;
  replayStatus?: string;
  liveStatus?: string;
  replayIteration?: number;
  liveIteration?: number;
}

export interface ReplayComparison {
  replaySequence: number;
  liveSequence: number;
  identical: boolean;
  phaseChanged: boolean;
  replayPhase: string;
  livePhase: string;
  goalStatusChanged: boolean;
  replayGoalStatus?: string;
  liveGoalStatus?: string;
  nodes: NodeDifference[];
  routes: RouteDifference[];
  loops: LoopDifference[];
  addedFacts: string[];
  removedFacts: string[];
  consumedTurnsDelta: number;
  scheduledActionsDelta: number;
}

const scheduledActions = (state: HypagraphState): number =>
  state.goal?.schedulerOrdinal ?? state.goal?.continuationOrdinal ?? 0;

/**
 * Report the canonical difference between a replayed state and the live state.
 *
 * The comparison reads canonical fields only. It is the basis of the live and
 * replay comparison which the debugger renders.
 */
export function compareReplayWithLive(
  replayState: HypagraphState,
  liveState: HypagraphState,
): ReplayComparison {
  const nodeIds = [...new Set([
    ...Object.keys(replayState.runtime.nodes),
    ...Object.keys(liveState.runtime.nodes),
  ])].sort();
  const nodes: NodeDifference[] = [];
  for (const nodeId of nodeIds) {
    const replayStatus = replayState.runtime.nodes[nodeId]?.status ?? "absent";
    const liveStatus = liveState.runtime.nodes[nodeId]?.status ?? "absent";
    if (replayStatus !== liveStatus) nodes.push({ nodeId, replayStatus, liveStatus });
  }

  const routeIds = [...new Set([
    ...Object.keys(replayState.runtime.routes),
    ...Object.keys(liveState.runtime.routes),
  ])].sort();
  const routes: RouteDifference[] = [];
  for (const nodeId of routeIds) {
    const replayOutcomeId = replayState.runtime.routes[nodeId]?.outcomeId;
    const liveOutcomeId = liveState.runtime.routes[nodeId]?.outcomeId;
    if (replayOutcomeId !== liveOutcomeId) {
      routes.push({
        nodeId,
        ...(replayOutcomeId === undefined ? {} : { replayOutcomeId }),
        ...(liveOutcomeId === undefined ? {} : { liveOutcomeId }),
      });
    }
  }

  const loopIds = [...new Set([
    ...Object.keys(replayState.runtime.loops),
    ...Object.keys(liveState.runtime.loops),
  ])].sort();
  const loops: LoopDifference[] = [];
  for (const loopId of loopIds) {
    const replay = replayState.runtime.loops[loopId];
    const live = liveState.runtime.loops[loopId];
    if (replay?.status !== live?.status || replay?.currentIteration !== live?.currentIteration) {
      loops.push({
        loopId,
        ...(replay?.status === undefined ? {} : { replayStatus: replay.status }),
        ...(live?.status === undefined ? {} : { liveStatus: live.status }),
        ...(replay?.currentIteration === undefined ? {} : { replayIteration: replay.currentIteration }),
        ...(live?.currentIteration === undefined ? {} : { liveIteration: live.currentIteration }),
      });
    }
  }

  const replayFacts = new Set(Object.keys(replayState.runtime.facts));
  const liveFacts = new Set(Object.keys(liveState.runtime.facts));
  const addedFacts = [...liveFacts].filter((name) => !replayFacts.has(name)).sort();
  const removedFacts = [...replayFacts].filter((name) => !liveFacts.has(name)).sort();

  const phaseChanged = replayState.phase !== liveState.phase;
  const replayGoalStatus = replayState.goal?.status;
  const liveGoalStatus = liveState.goal?.status;
  const goalStatusChanged = replayGoalStatus !== liveGoalStatus;

  return {
    replaySequence: replayState.sequence,
    liveSequence: liveState.sequence,
    identical: replayState.snapshotHash === liveState.snapshotHash,
    phaseChanged,
    replayPhase: replayState.phase,
    livePhase: liveState.phase,
    goalStatusChanged,
    ...(replayGoalStatus === undefined ? {} : { replayGoalStatus }),
    ...(liveGoalStatus === undefined ? {} : { liveGoalStatus }),
    nodes,
    routes,
    loops,
    addedFacts,
    removedFacts,
    consumedTurnsDelta: (liveState.goal?.budget.consumedTurns ?? 0) - (replayState.goal?.budget.consumedTurns ?? 0),
    scheduledActionsDelta: scheduledActions(liveState) - scheduledActions(replayState),
  };
}
