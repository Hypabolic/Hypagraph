import type { DispatchLane } from "../domain/action-dispatch.js";
import { protectsEvaluatorOutput } from "../domain/evaluation-presentation.js";
import { PROTECTED_DETAIL } from "../domain/presentation-redaction.js";
import type { DomainEvent, HypagraphDefinition } from "../domain/model.js";

export type TimelineLane =
  | "workflow"
  | "goal"
  | "dispatch"
  | "node"
  | "check"
  | "code"
  | "effect"
  | "interaction"
  | "evaluation"
  | "fact"
  | "route"
  | "loop"
  | "unknown";

export interface TimelineDispatch {
  dispatchId: string;
  lane: DispatchLane;
}

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
  dispatch?: TimelineDispatch;
  /** The entry starts a new workflow revision. */
  revisionBoundary?: boolean;
  /** The entry hides protected evaluator detail. The runtime withheld the data; it did not lose it. */
  redacted: boolean;
}

const MODEL_LANE_TYPES = new Set([
  "hypagraph.goal.continuation-requested",
  "hypagraph.goal.continuation-abandoned",
  "hypagraph.goal.turn-recorded",
]);

const laneOf = (type: string): TimelineLane => {
  if (type.startsWith("hypagraph.action.")) return "dispatch";
  if (MODEL_LANE_TYPES.has(type)) return "dispatch";
  if (type.startsWith("hypagraph.workflow.")) return "workflow";
  if (type.startsWith("hypagraph.goal.")) return "goal";
  if (type.startsWith("hypagraph.check.")) return "check";
  if (type.startsWith("hypagraph.code.")) return "code";
  if (type.startsWith("hypagraph.effect.")) return "effect";
  if (type.startsWith("hypagraph.interaction.")) return "interaction";
  if (type.startsWith("hypagraph.evaluation.")) return "evaluation";
  if (type === "hypagraph.fact.published") return "fact";
  if (type === "hypagraph.route.selected") return "route";
  if (type.startsWith("hypagraph.loop.")) return "loop";
  if (type.startsWith("hypagraph.node.") || type.startsWith("hypagraph.attempt.") || type.startsWith("hypagraph.verification.")) {
    return "node";
  }
  return "unknown";
};

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;

const list = (value: unknown): string => Array.isArray(value) && value.length > 0
  ? value.map((item) => String(item)).join(", ")
  : "none";

const actionLabel = (action: unknown): string => {
  if (!action || typeof action !== "object") return "an unknown action";
  const value = action as { kind?: string; nodeId?: string; blocker?: { kind?: string; id?: string } };
  switch (value.kind) {
    case "continue-active-task": return `continue task '${value.nodeId}'`;
    case "start-ready-task": return `start task '${value.nodeId}'`;
    case "run-ready-check": return `run check '${value.nodeId}'`;
    case "run-ready-code": return `run code '${value.nodeId}'`;
    case "run-ready-effect": return `run effect '${value.nodeId}'`;
    case "reconcile-indeterminate-effect": return `reconcile effect '${value.nodeId}'`;
    case "evaluate-ready-gate": return `evaluate gate '${value.nodeId}'`;
    case "request-ready-interaction": return `request interaction '${value.nodeId}'`;
    case "request-revision": return `request one bounded revision for ${value.blocker?.kind} '${value.blocker?.id}'`;
    default: return "an unknown action";
  }
};

interface SummaryContext {
  event: DomainEvent;
  redacted: boolean;
  dispatchLane: DispatchLane | undefined;
  /** Replace one free-text value which belongs to, or repeats, protected evaluator detail. */
  safe: (value: string) => string;
}

const checkSummary = ({ event, redacted }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.check.started":
      return redacted
        ? `Check '${event.nodeId}' started a protected evaluator attempt.`
        : `Check '${event.nodeId}' started a ${String(data.checkKind ?? "command")} attempt.`;
    case "hypagraph.check.result-recorded": {
      const result = data.result as { status?: string; exitCode?: number } | undefined;
      const status = result?.status ?? "unknown";
      if (redacted) return `Check '${event.nodeId}' recorded a protected evaluator result with status '${status}'.`;
      const exit = result?.exitCode === undefined ? "" : `, exit code ${result.exitCode}`;
      return `Check '${event.nodeId}' recorded a '${status}' result${exit}.`;
    }
    default: return undefined;
  }
};

const codeSummary = ({ event }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.code.started":
      return `Code node '${event.nodeId}' started a sandbox attempt.`;
    case "hypagraph.code.result-recorded": {
      const result = data.result as { status?: string } | undefined;
      const status = result?.status ?? "unknown";
      return `Code node '${event.nodeId}' recorded a '${status}' result.`;
    }
    default: return undefined;
  }
};

const effectSummary = ({ event, safe }: SummaryContext): string | undefined => {
  const data = event.data;
  const observation = data.observation as {
    durableState?: string;
    observedOutcome?: string;
    idempotencyKey?: string;
    lastReconciliationDecision?: string;
    error?: string;
  } | undefined;
  switch (event.type) {
    case "hypagraph.effect.requested":
      return `Effect node '${event.nodeId}' stored requested before the external call`
        + (observation?.idempotencyKey ? ` with key ${observation.idempotencyKey.slice(0, 12)}…` : ".");
    case "hypagraph.effect.observed":
      return `Effect node '${event.nodeId}' observed ${observation?.observedOutcome ?? "an outcome"}.`;
    case "hypagraph.effect.indeterminate":
      return `Effect node '${event.nodeId}' became indeterminate`
        + (observation?.error ? `: ${safe(observation.error)}` : ".");
    case "hypagraph.effect.reconciled":
      return `Effect node '${event.nodeId}' reconciliation decided '${String(data.decision ?? "unknown")}'`
        + (observation?.durableState ? ` (durable ${observation.durableState})` : ".");
    default: return undefined;
  }
};

const interactionSummary = ({ event }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.interaction.requested":
      return `Interaction '${event.nodeId}' requested an answer.`;
    case "hypagraph.interaction.presented": {
      const status = typeof data.status === "string" ? data.status : "unknown";
      return status === "succeeded"
        ? `Interaction '${event.nodeId}' presented its question.`
        : `Interaction '${event.nodeId}' presentation ${status}.`;
    }
    case "hypagraph.interaction.answered":
      return `Interaction '${event.nodeId}' received response '${String(data.responseId ?? "unknown")}'.`;
    case "hypagraph.interaction.expired":
      return `Interaction '${event.nodeId}' expired before an answer.`;
    default: return undefined;
  }
};

const nodeSummary = ({ event, redacted, safe }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.node.ready": return `Node '${event.nodeId}' became ready.`;
    case "hypagraph.node.skipped": return `Node '${event.nodeId}' was skipped.`;
    case "hypagraph.node.invalidated": return `Node '${event.nodeId}' became stale after a revision.`;
    case "hypagraph.node.blocked":
      return `Node '${event.nodeId}' was blocked as ${String(data.blockerKind ?? "unknown")}: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.node.unblocked": return `Node '${event.nodeId}' was unblocked.`;
    case "hypagraph.attempt.started": return `Attempt ${event.attemptId} started on node '${event.nodeId}'.`;
    case "hypagraph.attempt.result-submitted":
      return `Node '${event.nodeId}' submitted a result with ${count(data.evidence)} evidence references.`;
    case "hypagraph.attempt.cancelled":
      return `Attempt ${event.attemptId} on node '${event.nodeId}' was cancelled.`;
    case "hypagraph.verification.started": return `Verification started on node '${event.nodeId}'.`;
    case "hypagraph.verification.passed": return `Node '${event.nodeId}' passed verification.`;
    case "hypagraph.verification.failed": {
      if (redacted) return `Node '${event.nodeId}' failed verification. The evaluator reason is protected.`;
      const reason = text(data.reason);
      return reason ? `Node '${event.nodeId}' failed verification: ${reason}` : `Node '${event.nodeId}' failed verification.`;
    }
    default: return undefined;
  }
};

const loopSummary = ({ event }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.loop.iteration-started":
      return `Loop '${event.loopId}' started iteration ${String(data.iteration)} of ${String(data.maxIterations)}.`;
    case "hypagraph.loop.evaluated":
      return `Loop '${event.loopId}' evaluated iteration ${String(data.iteration)}: valid ${String(data.valid)}, success ${String(data.success)}.`;
    case "hypagraph.loop.completed":
      return `Loop '${event.loopId}' completed at iteration ${String(data.iteration)} through ${String(data.exitReason)}.`;
    case "hypagraph.loop.failed":
      return `Loop '${event.loopId}' failed at iteration ${String(data.iteration)} through ${String(data.exitReason)}.`;
    case "hypagraph.loop.blocked": return `Loop '${event.loopId}' blocked its dependants.`;
    case "hypagraph.loop.invalidated": return `Loop '${event.loopId}' became stale after a revision.`;
    default: return undefined;
  }
};

const goalSummary = ({ event, safe }: SummaryContext): string | undefined => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.goal.started": return "The goal started.";
    case "hypagraph.goal.paused": return `The goal paused through ${String(data.cause ?? "explicit")}: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.resumed": return "The goal resumed.";
    case "hypagraph.goal.blocked": return `The goal blocked: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.completed": return "The goal completed.";
    case "hypagraph.goal.failed": return `The goal failed: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.cancelled": return `The goal was cancelled: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.budget-limited": return `The goal stopped on its budget: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.revision-requested": return "The goal requested one bounded revision.";
    case "hypagraph.goal.revision-rejected": return `The bounded revision was rejected: ${String(data.outcomeCode ?? "unknown")}.`;
    case "hypagraph.goal.revision-abandoned": return `The bounded revision was abandoned: ${String(data.outcomeCode ?? "unknown")}.`;
    case "hypagraph.goal.revision-applied": return `The bounded revision was applied as revision ${String(data.appliedRevision)}.`;
    default: return undefined;
  }
};

const dispatchSummary = ({ event, dispatchLane, safe }: SummaryContext): string | undefined => {
  const data = event.data;
  const lane = dispatchLane ?? "model";
  switch (event.type) {
    case "hypagraph.action.selected": {
      const dispatch = data.dispatch as { action?: unknown; schedulerOrdinal?: number } | undefined;
      return `The scheduler selected ${actionLabel(dispatch?.action)} in the ${lane} lane at ordinal ${String(dispatch?.schedulerOrdinal)}.`;
    }
    case "hypagraph.action.dispatched": return `The ${lane} lane dispatched the selected action.`;
    case "hypagraph.action.completed": return `The ${lane} lane completed the dispatched action.`;
    case "hypagraph.action.failed":
      return `The ${lane} lane failed the dispatched action: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.action.interrupted":
      return `The ${lane} lane interrupted the dispatched action: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.continuation-requested":
      return `The model lane selected ${actionLabel(data.action)} at ordinal ${String(data.ordinal)}.`;
    case "hypagraph.goal.continuation-abandoned":
      return `The model lane abandoned its action: ${safe(text(data.reason) ?? "no reason was given")}.`;
    case "hypagraph.goal.turn-recorded": {
      const usage = data.usage as { totalTokens?: number } | undefined;
      return `The model lane charged one turn and ${String(usage?.totalTokens ?? 0)} tokens.`;
    }
    default: return undefined;
  }
};

const otherSummary = ({ event, redacted }: SummaryContext): string => {
  const data = event.data;
  switch (event.type) {
    case "hypagraph.workflow.defined": return "The workflow was defined.";
    case "hypagraph.workflow.revised": return `The workflow was revised to revision ${event.revision}.`;
    case "hypagraph.workflow.paused": return "The workflow paused.";
    case "hypagraph.workflow.resumed": return "The workflow resumed.";
    case "hypagraph.workflow.completed": return "The workflow completed.";
    case "hypagraph.workflow.failed": return "The workflow failed.";
    case "hypagraph.evaluation.started":
      return `Node '${event.nodeId}' started a ${String(data.kind ?? "development")} evaluation.`;
    case "hypagraph.fact.published": {
      const fact = data.fact as { name?: string; value?: unknown } | undefined;
      if (redacted) return `Node '${event.nodeId}' published protected evaluator fact '${String(fact?.name)}'.`;
      return `Node '${event.nodeId}' published fact '${String(fact?.name)}' as ${JSON.stringify(fact?.value)}.`;
    }
    case "hypagraph.route.selected":
      return `Gate '${event.nodeId}' selected outcome '${String(data.outcomeId)}' and routed to ${list(data.targetNodeIds)}.`;
    default: return `The workflow stored event '${event.type}'.`;
  }
};

const summarize = (context: SummaryContext): string =>
  checkSummary(context)
  ?? codeSummary(context)
  ?? effectSummary(context)
  ?? interactionSummary(context)
  ?? nodeSummary(context)
  ?? loopSummary(context)
  ?? goalSummary(context)
  ?? dispatchSummary(context)
  ?? otherSummary(context);

/** Report whether an event carries free text which repeats a protected secret. */
const secretInSummary = (event: DomainEvent, secrets: ReadonlySet<string>): boolean => {
  if (secrets.size === 0) return false;
  const value = event.data.reason;
  return typeof value === "string" && secrets.has(value);
};

const definitionOf = (event: DomainEvent): HypagraphDefinition | undefined => {
  if (event.type !== "hypagraph.workflow.defined" && event.type !== "hypagraph.workflow.revised") return undefined;
  const definition = event.data.definition;
  return definition && typeof definition === "object" ? definition as HypagraphDefinition : undefined;
};

const protectedNodeIds = (definition: HypagraphDefinition | undefined): Set<string> => {
  const values = new Set<string>();
  for (const node of definition?.nodes ?? []) {
    if (protectsEvaluatorOutput(node.check)) values.add(node.id);
  }
  return values;
};

/**
 * Project a stored event stream into a presentation timeline.
 *
 * The projection is pure. It reads the definition from the workflow-defined and
 * workflow-revised events, so it applies the correct evaluator redaction at each
 * revision. An unknown event type projects to a generic entry, which gives the
 * seam for the later family, executor, workspace, and integration namespaces.
 */
export function projectEventTimeline(events: readonly DomainEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const dispatchLanes = new Map<string, DispatchLane>();
  // Free text which a protected evaluator produced. A later goal or dispatch event can
  // repeat it, and those events carry no node, so ownership alone cannot protect them.
  const secrets = new Set<string>();
  let protectedNodes = new Set<string>();

  for (const event of events) {
    const definition = definitionOf(event);
    if (definition) protectedNodes = protectedNodeIds(definition);

    if (event.type === "hypagraph.action.selected") {
      const dispatch = event.data.dispatch as { dispatchId?: string; lane?: DispatchLane } | undefined;
      if (dispatch?.dispatchId && dispatch.lane) dispatchLanes.set(dispatch.dispatchId, dispatch.lane);
    }

    const dispatchId = event.type.startsWith("hypagraph.action.")
      ? String((event.data.dispatch as { dispatchId?: string } | undefined)?.dispatchId ?? event.data.dispatchId ?? "")
      : MODEL_LANE_TYPES.has(event.type)
        ? String(event.data.operationId ?? event.data.continuationOperationId ?? "")
        : "";
    const dispatchLane = event.type.startsWith("hypagraph.action.")
      ? dispatchLanes.get(dispatchId)
      : MODEL_LANE_TYPES.has(event.type) ? "model" as const : undefined;

    const redacted = event.nodeId !== undefined && protectedNodes.has(event.nodeId);
    if (redacted) {
      const result = event.data.result as { error?: unknown; stdoutRef?: unknown; stderrRef?: unknown } | undefined;
      for (const value of [event.data.reason, result?.error, result?.stdoutRef, result?.stderrRef]) {
        if (typeof value === "string" && value.trim().length > 0) secrets.add(value);
      }
    }
    const safe = (value: string): string => redacted || secrets.has(value) ? PROTECTED_DETAIL : value;
    entries.push({
      sequence: event.sequence,
      eventId: event.eventId,
      type: event.type,
      timestamp: event.timestamp,
      revision: event.revision,
      lane: laneOf(event.type),
      summary: summarize({ event, redacted, dispatchLane, safe }),
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.loopId === undefined ? {} : { loopId: event.loopId }),
      ...(dispatchId && dispatchLane ? { dispatch: { dispatchId, lane: dispatchLane } } : {}),
      ...(event.type === "hypagraph.workflow.revised" ? { revisionBoundary: true } : {}),
      redacted: redacted || secretInSummary(event, secrets),
    });
  }

  return entries;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  total: number;
  offset: number;
}

/**
 * Take one bounded page of the timeline.
 *
 * The default page shows the most recent entries. An event stream has no fixed
 * length, so no surface may render the complete timeline.
 */
export function pageTimeline(
  entries: readonly TimelineEntry[],
  limit: number,
  offset?: number,
): TimelinePage {
  const size = Math.max(1, Math.floor(limit));
  const start = offset === undefined
    ? Math.max(0, entries.length - size)
    : Math.min(Math.max(0, Math.floor(offset)), Math.max(0, entries.length - 1));
  return {
    entries: entries.slice(start, start + size).map((entry) => structuredClone(entry)),
    total: entries.length,
    offset: start,
  };
}

export function filterTimelineByLane(
  entries: readonly TimelineEntry[],
  lane: TimelineLane,
): TimelineEntry[] {
  return entries.filter((entry) => entry.lane === lane).map((entry) => structuredClone(entry));
}
