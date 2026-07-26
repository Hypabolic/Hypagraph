import type { DomainEvent, HypagraphState } from "../domain/model.js";
import { applyEvent } from "../domain/projection.js";

export interface RevisionSegment {
  revision: number;
  firstSequence: number;
  /** The last sequence of the revision. It is absent for the current revision. */
  lastSequence?: number;
  eventCount: number;
  invalidatedNodeIds: string[];
  invalidatedLoopIds: string[];
}

/**
 * Split the stored stream into one segment for each workflow revision.
 *
 * A revision boundary is a `hypagraph.workflow.revised` event. Each segment reports
 * the nodes and the loops which the revision invalidated, so the user can read which
 * earlier results no longer apply.
 */
export function projectRevisionHistory(events: readonly DomainEvent[]): RevisionSegment[] {
  const segments: RevisionSegment[] = [];
  for (const event of events) {
    let current = segments.at(-1);
    if (!current || event.revision !== current.revision) {
      if (current) current.lastSequence = event.sequence - 1;
      current = {
        revision: event.revision,
        firstSequence: event.sequence,
        eventCount: 0,
        invalidatedNodeIds: [],
        invalidatedLoopIds: [],
      };
      segments.push(current);
    }
    current.eventCount += 1;
    if (event.type === "hypagraph.node.invalidated" && event.nodeId) current.invalidatedNodeIds.push(event.nodeId);
    if (event.type === "hypagraph.loop.invalidated" && event.loopId) current.invalidatedLoopIds.push(event.loopId);
  }
  return segments;
}

export interface StaleResult {
  nodeId: string;
  kind: string;
  /** The revision which invalidated the node. */
  revision: number;
  /** The status of the node now. An invalidated node returns to `ready` once its dependencies allow it. */
  status: string;
  attemptCount: number;
  /** The node stored a result which no longer applies. */
  discardedResult: boolean;
  lastAttemptId?: string;
  lastCheckStatus?: string;
}

/**
 * Report each node which the current revision invalidated.
 *
 * A revision invalidates an affected node. The node returns to `ready` when its
 * dependencies allow it, and it stays `stale` while they do not. Status alone therefore
 * does not identify a discarded result, so this projection reads the invalidation events
 * of the current revision and joins them with the attempt history.
 */
export function projectStaleResults(
  state: HypagraphState,
  events: readonly DomainEvent[],
): StaleResult[] {
  const invalidations = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "hypagraph.node.invalidated") continue;
    if (event.revision !== state.revision || event.nodeId === undefined) continue;
    if (!invalidations.has(event.nodeId)) invalidations.set(event.nodeId, event.sequence);
  }
  if (invalidations.size === 0) return [];

  // The discarded result belongs to the state before the invalidation. A node which runs
  // again after the revision must not report its new attempt as the discarded one.
  const beforeCache = new Map<number, HypagraphState>();
  const stateBefore = (sequence: number): HypagraphState | undefined => {
    const cached = beforeCache.get(sequence);
    if (cached) return cached;
    let replayed: HypagraphState | undefined;
    for (const event of events) {
      if (event.sequence >= sequence) break;
      replayed = applyEvent(replayed, event);
    }
    if (replayed) beforeCache.set(sequence, replayed);
    return replayed;
  };

  const values: StaleResult[] = [];
  for (const nodeId of [...invalidations.keys()].sort()) {
    const node = state.definition.nodes.find((item) => item.id === nodeId);
    const runtime = state.runtime.nodes[nodeId];
    if (!node || !runtime) continue;
    const before = stateBefore(invalidations.get(nodeId)!)?.runtime.nodes[nodeId];
    const lastAttemptId = before?.currentAttemptId;
    const lastCheckStatus = lastAttemptId ? before?.attempts[lastAttemptId]?.checkResult?.status : undefined;
    const attemptCount = before?.attemptCount ?? 0;
    values.push({
      nodeId,
      kind: node.kind ?? "task",
      revision: state.revision,
      // The status is the status now. The attempt data is the data before the revision.
      status: runtime.status,
      attemptCount,
      discardedResult: attemptCount > 0,
      ...(lastAttemptId === undefined ? {} : { lastAttemptId }),
      ...(lastCheckStatus === undefined ? {} : { lastCheckStatus }),
    });
  }
  return values;
}

export function renderRevisionHistory(events: readonly DomainEvent[], state: HypagraphState): string {
  const segments = projectRevisionHistory(events);
  const stale = projectStaleResults(state, events);
  const lines = [`Hypagraph revision history: ${segments.length} revisions through sequence ${state.sequence}.`];
  for (const segment of segments) {
    const range = segment.lastSequence === undefined
      ? `${segment.firstSequence} to current`
      : `${segment.firstSequence} to ${segment.lastSequence}`;
    lines.push(`- revision ${segment.revision}: sequence ${range}; ${segment.eventCount} events`);
    if (segment.invalidatedNodeIds.length > 0) {
      lines.push(`  invalidated nodes: ${segment.invalidatedNodeIds.join(", ")}`);
    }
    if (segment.invalidatedLoopIds.length > 0) {
      lines.push(`  invalidated loops: ${segment.invalidatedLoopIds.join(", ")}`);
    }
  }
  const discarded = stale.filter((item) => item.discardedResult);
  lines.push(discarded.length === 0
    ? "Discarded results: none."
    : `Discarded results: ${discarded.map((item) => `${item.nodeId} is now ${item.status} (${item.attemptCount} attempts${item.lastCheckStatus ? `, last check ${item.lastCheckStatus}` : ""})`).join("; ")}`);
  const waiting = stale.filter((item) => item.status === "stale");
  lines.push(waiting.length === 0
    ? "Stale nodes: none."
    : `Stale nodes: ${waiting.map((item) => item.nodeId).join(", ")}`);
  return lines.join("\n");
}
