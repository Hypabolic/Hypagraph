import type { DomainEvent, HypagraphState } from "../domain/model.js";
import { explainGoal, explainNode } from "../history/explain.js";
import { compareReplayWithLive, replayToSequence, type ReplayComparison } from "../history/replay.js";
import {
  filterTimelineByLane,
  pageTimeline,
  projectEventTimeline,
  type TimelineEntry,
  type TimelineLane,
} from "../history/timeline.js";
import { renderWorkflow } from "./format.js";

export const DEFAULT_HISTORY_PAGE = 20;

/**
 * Every selectable lane.
 *
 * The type is a total record of `TimelineLane`. A new lane therefore fails the
 * type check until it appears here, so a lane cannot become unselectable.
 */
const TIMELINE_LANE_SET: Record<TimelineLane, true> = {
  workflow: true,
  goal: true,
  dispatch: true,
  node: true,
  check: true,
  interaction: true,
  evaluation: true,
  fact: true,
  route: true,
  loop: true,
  unknown: true,
};

export const TIMELINE_LANES: readonly TimelineLane[] = Object.keys(TIMELINE_LANE_SET) as TimelineLane[];

export function isTimelineLane(value: string): value is TimelineLane {
  return (TIMELINE_LANES as readonly string[]).includes(value);
}

const marker = (entry: TimelineEntry): string => {
  if (entry.dispatch) return entry.dispatch.lane === "model" ? "M" : entry.dispatch.lane === "deterministic" ? "D" : "X";
  return entry.redacted ? "P" : " ";
};

const entryLine = (entry: TimelineEntry): string =>
  `${String(entry.sequence).padStart(5)} ${marker(entry)} r${entry.revision} ${entry.lane.padEnd(10)} ${entry.summary}`;

export interface HistoryPageRequest {
  limit?: number;
  offset?: number;
  lane?: TimelineLane;
}

/** Render one bounded page of the event timeline. */
export function renderEventTimeline(
  events: readonly DomainEvent[],
  request: HistoryPageRequest = {},
): string {
  if (events.length === 0) return "The active Hypagraph has no stored events.";
  const all = projectEventTimeline(events);
  const selected = request.lane ? filterTimelineByLane(all, request.lane) : all;
  if (selected.length === 0) return `The event timeline has no '${request.lane}' entry.`;

  const page = pageTimeline(selected, request.limit ?? DEFAULT_HISTORY_PAGE, request.offset);
  const first = page.entries[0]?.sequence ?? 0;
  const last = page.entries.at(-1)?.sequence ?? 0;
  const scope = request.lane ? ` in lane '${request.lane}'` : "";
  const lines = [
    `Hypagraph event timeline${scope}: ${page.entries.length} of ${page.total} entries, sequence ${first} to ${last}.`,
    "Marker: M model lane, D deterministic lane, X executor lane, P protected evaluator.",
    ...page.entries.map(entryLine),
  ];
  if (page.offset + page.entries.length < page.total) {
    lines.push(`Use a later offset to read the remaining ${page.total - page.offset - page.entries.length} entries.`);
  }
  return lines.join("\n");
}

const comparisonLines = (comparison: ReplayComparison): string[] => {
  if (comparison.identical) return ["Difference from live: none. The replay reached the live sequence."];
  const lines = [`Difference from live sequence ${comparison.liveSequence}:`];
  if (comparison.phaseChanged) lines.push(`- workflow phase ${comparison.replayPhase} became ${comparison.livePhase}`);
  if (comparison.goalStatusChanged) {
    lines.push(`- goal status ${comparison.replayGoalStatus ?? "none"} became ${comparison.liveGoalStatus ?? "none"}`);
  }
  for (const node of comparison.nodes) lines.push(`- node ${node.nodeId}: ${node.replayStatus} became ${node.liveStatus}`);
  for (const route of comparison.routes) {
    lines.push(`- route ${route.nodeId}: ${route.replayOutcomeId ?? "none"} became ${route.liveOutcomeId ?? "none"}`);
  }
  for (const loop of comparison.loops) {
    lines.push(`- loop ${loop.loopId}: ${loop.replayStatus ?? "none"} iteration ${loop.replayIteration ?? 0} became ${loop.liveStatus ?? "none"} iteration ${loop.liveIteration ?? 0}`);
  }
  if (comparison.addedFacts.length > 0) lines.push(`- facts published after this event: ${comparison.addedFacts.join(", ")}`);
  if (comparison.removedFacts.length > 0) lines.push(`- facts removed after this event: ${comparison.removedFacts.join(", ")}`);
  lines.push(`- charged model turns increased by ${comparison.consumedTurnsDelta}`);
  lines.push(`- scheduled actions increased by ${comparison.scheduledActionsDelta}`);
  return lines;
};

/** Render the replayed workflow at one sequence, with its difference from live state. */
export function renderReplayAtSequence(
  events: readonly DomainEvent[],
  liveState: HypagraphState,
  sequence: number,
): string {
  const replay = replayToSequence(events, sequence);
  const comparison = compareReplayWithLive(replay.state, liveState);
  return [
    `Hypagraph replay at sequence ${replay.sequence} of ${liveState.sequence}.`,
    `Event: ${replay.entry.type}`,
    `Summary: ${replay.entry.summary}`,
    "",
    renderWorkflow(replay.state),
    "",
    ...comparisonLines(comparison),
    "",
    "Replay reads stored events only. It runs no check and calls no executor.",
  ].join("\n");
}

/** Render the canonical reason for one node, or for every node when no node is named. */
export function renderExplanation(state: HypagraphState, nodeId?: string): string {
  if (nodeId !== undefined) {
    const explanation = explainNode(state, nodeId);
    return [
      `Node '${explanation.nodeId}' is ${explanation.status} (${explanation.kind}).`,
      `Reason: ${explanation.reason.kind}`,
      explanation.summary,
    ].join("\n");
  }

  const goal = explainGoal(state);
  const lines = [
    `Goal: ${goal.goalStatus ?? "none"}`,
    `Decision: ${goal.decision}`,
    goal.summary,
    `Runnable nodes: ${goal.runnableNodeIds.join(", ") || "none"}`,
    "Nodes:",
  ];
  for (const node of state.definition.nodes) {
    const explanation = explainNode(state, node.id);
    lines.push(`- ${explanation.nodeId}: ${explanation.status}; ${explanation.summary}`);
  }
  return lines.join("\n");
}

export interface HistorySurface {
  totalEvents: number;
  firstSequence: number;
  lastSequence: number;
  entries: TimelineEntry[];
}

/** Project the model-visible history page. The redaction of the timeline holds. */
export function projectModelVisibleHistory(
  events: readonly DomainEvent[],
  request: HistoryPageRequest = {},
): HistorySurface {
  const all = projectEventTimeline(events);
  const selected = request.lane ? filterTimelineByLane(all, request.lane) : all;
  const page = pageTimeline(selected, request.limit ?? DEFAULT_HISTORY_PAGE, request.offset);
  return {
    totalEvents: all.length,
    firstSequence: all[0]?.sequence ?? 0,
    lastSequence: all.at(-1)?.sequence ?? 0,
    entries: page.entries,
  };
}
