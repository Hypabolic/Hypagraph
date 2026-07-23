import { CONDITION_SEMANTICS_VERSION } from "./conditions.js";
import { sha256 } from "./hash.js";
import type { FactRecord } from "./facts.js";
import type {
  AttemptRuntime,
  CheckResult,
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
  LegacyLoopPredicate,
  LoopDefinition,
  LoopRuntime,
  NodeRuntime,
  RouteSelection,
} from "./model.js";
import { HYPAGRAPH_SCHEMA_VERSION } from "./model.js";
import { workflowBlockedByFailedLoop, workflowCanComplete } from "./workflow-outcome.js";

const hashState = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => ({
  ...state,
  snapshotHash: sha256(state),
});

const emptyNode = (): NodeRuntime => ({ status: "pending", attemptCount: 0, attempts: {}, evidence: [] });

const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyLoopPredicate>;
  return candidate.kind === "legacy-text" && typeof candidate.text === "string";
};

const normaliseDefinition = (definition: HypagraphDefinition): HypagraphDefinition => ({
  ...structuredClone(definition),
  loops: definition.loops.map((loop) => ({
    ...structuredClone(loop),
    successWhen: typeof loop.successWhen === "string"
      ? { kind: "legacy-text", text: loop.successWhen }
      : structuredClone(loop.successWhen),
  })),
});

const emptyLoop = (loop: LoopDefinition): LoopRuntime => {
  const legacy = isLegacyPredicate(loop.successWhen);
  const legacyText = typeof loop.successWhen === "string" ? loop.successWhen : isLegacyPredicate(loop.successWhen) ? loop.successWhen.text : undefined;
  return {
    loopId: loop.id,
    status: legacy ? "requires_revision" : "pending",
    currentIteration: 0,
    maxIterations: loop.maxIterations,
    iterations: [],
    factsUsed: [],
    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),
  };
};

const finalise = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => {
  const nodes = Object.values(state.runtime.nodes);
  const completeState = state as HypagraphState;
  const runnable = nodes.some((node) => ["ready", "starting", "running", "verifying", "awaiting_evidence"].includes(node.status));
  let phase = state.phase;
  if (phase !== "paused" && phase !== "failed" && phase !== "cancelled") {
    if (workflowCanComplete(completeState)) phase = "completed";
    else if (!runnable && (nodes.some((node) => node.status === "blocked") || workflowBlockedByFailedLoop(completeState))) phase = "blocked";
    else phase = "running";
  }
  return hashState({ ...state, phase });
};

const withoutHash = (state: HypagraphState): Omit<HypagraphState, "snapshotHash"> => {
  const { snapshotHash: _snapshotHash, ...rest } = state;
  return rest;
};

const startAttempt = (node: NodeRuntime, attemptId: string, timestamp: string, data: Record<string, unknown>): void => {
  const loopId = typeof data.loopId === "string" ? data.loopId : undefined;
  const iteration = typeof data.iteration === "number" ? data.iteration : undefined;
  const value: AttemptRuntime = {
    attemptId,
    number: node.attemptCount + 1,
    status: "running",
    startedAt: timestamp,
    evidence: [],
    ...(loopId === undefined ? {} : { loopId }),
    ...(iteration === undefined ? {} : { iteration }),
  };
  node.attemptCount += 1;
  node.currentAttemptId = attemptId;
  node.attempts[attemptId] = value;
  node.status = "running";
};

export function applyEvent(state: HypagraphState | undefined, event: DomainEvent): HypagraphState {
  if (event.type === "hypagraph.workflow.defined") {
    const definition = normaliseDefinition(event.data.definition as HypagraphDefinition);
    const nodes = Object.fromEntries(definition.nodes.map((node) => [node.id, emptyNode()]));
    const loops = Object.fromEntries(definition.loops.map((loop) => [loop.id, emptyLoop(loop)]));
    return finalise({
      schemaVersion: HYPAGRAPH_SCHEMA_VERSION,
      workflowId: event.workflowId,
      revision: event.revision,
      sequence: event.sequence,
      phase: "running",
      definition,
      runtime: { nodes, facts: {}, routes: {}, loops },
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
  }
  if (!state) throw new Error("The first event must define the workflow.");
  if (event.workflowId !== state.workflowId) throw new Error("The event belongs to a different workflow.");
  if (event.sequence !== state.sequence + 1) throw new Error("The event sequence is not contiguous.");

  const next = structuredClone(state);
  next.runtime.routes ??= {};
  next.runtime.loops ??= {};
  next.sequence = event.sequence;
  next.revision = event.revision;
  next.updatedAt = event.timestamp;
  const node = event.nodeId ? next.runtime.nodes[event.nodeId] : undefined;
  const attempt = node && event.attemptId ? node.attempts[event.attemptId] : undefined;

  switch (event.type) {
    case "hypagraph.workflow.revised": {
      next.phase = "running";
      next.definition = normaliseDefinition(event.data.definition as HypagraphDefinition);
      const retainedNodes = next.runtime.nodes;
      const retainedLoops = next.runtime.loops;
      next.runtime.nodes = {};
      for (const definitionNode of next.definition.nodes) next.runtime.nodes[definitionNode.id] = retainedNodes[definitionNode.id] ?? emptyNode();
      next.runtime.loops = {};
      for (const definitionLoop of next.definition.loops) {
        const retained = retainedLoops[definitionLoop.id];
        next.runtime.loops[definitionLoop.id] = isLegacyPredicate(definitionLoop.successWhen)
          ? emptyLoop(definitionLoop)
          : retained?.status === "requires_revision" || retained === undefined
            ? emptyLoop(definitionLoop)
            : retained;
      }
      for (const gateNodeId of Object.keys(next.runtime.routes)) {
        if (!next.runtime.nodes[gateNodeId]) delete next.runtime.routes[gateNodeId];
      }
      break;
    }
    case "hypagraph.workflow.paused": next.phase = "paused"; break;
    case "hypagraph.workflow.resumed": next.phase = "running"; break;
    case "hypagraph.workflow.completed": next.phase = "completed"; break;
    case "hypagraph.workflow.failed": next.phase = "failed"; break;
    case "hypagraph.node.ready": if (node) node.status = "ready"; break;
    case "hypagraph.node.skipped": if (node) node.status = "skipped"; break;
    case "hypagraph.node.invalidated":
      if (node) {
        node.status = "stale";
        delete node.currentAttemptId;
        node.evidence = [];
        delete next.runtime.routes[event.nodeId!];
        for (const [name, fact] of Object.entries(next.runtime.facts)) {
          if (fact.producerNodeId === event.nodeId) delete next.runtime.facts[name];
        }
      }
      break;
    case "hypagraph.node.blocked":
      if (node) {
        node.status = "blocked";
        node.blockedReason = String(event.data.reason ?? "");
      }
      break;
    case "hypagraph.node.unblocked":
      if (node) {
        node.status = "pending";
        delete node.blockedReason;
      }
      break;
    case "hypagraph.attempt.started":
      if (node && event.attemptId) startAttempt(node, event.attemptId, event.timestamp, event.data);
      break;
    case "hypagraph.check.started":
      if (node && event.attemptId) {
        if (event.data.retry === true && event.nodeId) {
          for (const [name, fact] of Object.entries(next.runtime.facts)) {
            if (fact.producerNodeId === event.nodeId) delete next.runtime.facts[name];
          }
        }
        startAttempt(node, event.attemptId, event.timestamp, event.data);
      }
      break;
    case "hypagraph.check.result-recorded":
      if (node && attempt) {
        const result = structuredClone(event.data.result as CheckResult);
        attempt.status = "submitted";
        attempt.submittedAt = event.timestamp;
        attempt.checkResult = result;
        attempt.evidence = structuredClone(result.evidence);
        node.evidence = structuredClone(result.evidence);
        node.status = "awaiting_evidence";
      }
      break;
    case "hypagraph.fact.published":
      if (event.nodeId && event.attemptId) {
        const fact = event.data.fact as Omit<FactRecord, "eventId" | "sequence">;
        next.runtime.facts[fact.name] = {
          ...structuredClone(fact),
          eventId: event.eventId,
          sequence: event.sequence,
        };
      }
      break;
    case "hypagraph.route.selected":
      if (node && event.nodeId) {
        const route = event.data as Pick<RouteSelection, "outcomeId" | "targetNodeIds" | "factsUsed"> & { semanticsVersion?: number };
        next.runtime.routes[event.nodeId] = {
          gateNodeId: event.nodeId,
          outcomeId: route.outcomeId,
          targetNodeIds: structuredClone(route.targetNodeIds),
          factsUsed: structuredClone(route.factsUsed),
          semanticsVersion: route.semanticsVersion ?? CONDITION_SEMANTICS_VERSION,
          eventId: event.eventId,
          sequence: event.sequence,
        };
        node.status = "succeeded";
      }
      break;
    case "hypagraph.attempt.result-submitted":
      if (node && attempt) {
        const evidence = event.data.evidence as AttemptRuntime["evidence"];
        attempt.status = "submitted";
        attempt.submittedAt = event.timestamp;
        attempt.evidence = structuredClone(evidence);
        node.evidence = structuredClone(evidence);
        node.status = "awaiting_evidence";
      }
      break;
    case "hypagraph.verification.started":
      if (node && attempt) {
        attempt.status = "verifying";
        node.status = "verifying";
      }
      break;
    case "hypagraph.verification.passed":
      if (node && attempt) {
        attempt.status = "succeeded";
        attempt.completedAt = event.timestamp;
        node.status = "succeeded";
      }
      break;
    case "hypagraph.verification.failed":
      if (node && attempt) {
        attempt.status = "failed";
        attempt.completedAt = event.timestamp;
        attempt.failureReason = String(event.data.reason ?? "Verification failed.");
        node.status = "failed";
      }
      break;
    case "hypagraph.attempt.cancelled":
      if (node && attempt) {
        attempt.status = "cancelled";
        attempt.completedAt = event.timestamp;
        if (typeof event.data.reason === "string") attempt.failureReason = event.data.reason;
        node.status = "cancelled";
        delete node.currentAttemptId;
      }
      break;
    case "hypagraph.loop.invalidated": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const definition = next.definition.loops.find((loop) => loop.id === loopId);
      if (definition) {
        next.runtime.loops[loopId] = emptyLoop(definition);
        const loopNodes = new Set(definition.nodes);
        for (const [name, fact] of Object.entries(next.runtime.facts)) {
          if (loopNodes.has(fact.producerNodeId)) delete next.runtime.facts[name];
        }
        for (const nodeId of definition.nodes) {
          const loopNode = next.runtime.nodes[nodeId];
          if (!loopNode) continue;
          loopNode.status = "stale";
          delete loopNode.currentAttemptId;
          loopNode.evidence = [];
          delete loopNode.blockedReason;
          delete next.runtime.routes[nodeId];
        }
      }
      break;
    }
    case "hypagraph.loop.blocked": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "blocked";
        runtime.blockedAt = event.timestamp;
        runtime.blockedReason = String(event.data.reason ?? "The loop requires explicit recovery.");
        if (event.attemptId) runtime.blockedAttemptId = event.attemptId;
      }
      if (node && event.attemptId && node.currentAttemptId === event.attemptId) delete node.currentAttemptId;
      break;
    }
    case "hypagraph.loop.iteration-started": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      const definition = next.definition.loops.find((loop) => loop.id === loopId);
      if (runtime && definition) {
        const iteration = Number(event.data.iteration);
        if (iteration > 1) {
          const loopNodes = new Set(definition.nodes);
          for (const [name, fact] of Object.entries(next.runtime.facts)) {
            if (loopNodes.has(fact.producerNodeId)) delete next.runtime.facts[name];
          }
          for (const nodeId of definition.nodes) {
            const nodeRuntime = next.runtime.nodes[nodeId];
            if (!nodeRuntime) continue;
            nodeRuntime.status = "pending";
            delete nodeRuntime.currentAttemptId;
            nodeRuntime.evidence = [];
            delete nodeRuntime.blockedReason;
            delete next.runtime.routes[nodeId];
          }
        }
        runtime.status = "running";
        runtime.currentIteration = iteration;
        delete runtime.blockedAt;
        delete runtime.blockedReason;
        delete runtime.blockedAttemptId;
        runtime.startedAt ??= event.timestamp;
        if (!runtime.iterations.some((item) => item.iteration === iteration)) {
          runtime.iterations.push({ iteration, startedAt: event.timestamp, factsUsed: [] });
        }
      }
      break;
    }
    case "hypagraph.loop.evaluated": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        const iteration = Number(event.data.iteration);
        const record = runtime.iterations.find((item) => item.iteration === iteration);
        const success = event.data.success === true;
        const factsUsed = Array.isArray(event.data.factsUsed) ? event.data.factsUsed.filter((item): item is string => typeof item === "string") : [];
        const semanticsVersion = Number(event.data.semanticsVersion ?? CONDITION_SEMANTICS_VERSION);
        const decision = event.data.decision === "complete" ? "complete" : event.data.decision === "continue" ? "continue" : event.data.decision === "fail" ? "fail" : "pending";
        if (record) {
          record.evaluatedAt = event.timestamp;
          record.evaluationEventId = event.eventId;
          record.evaluationSequence = event.sequence;
          record.success = success;
          record.factsUsed = structuredClone(factsUsed);
          record.semanticsVersion = semanticsVersion;
          record.decision = decision;
          if (typeof event.data.metric === "number") record.metric = event.data.metric;
          if (typeof event.data.improved === "boolean") record.improved = event.data.improved;
          if (typeof event.data.bestMetric === "number") record.bestMetric = event.data.bestMetric;
          if (typeof event.data.bestIteration === "number") record.bestIteration = event.data.bestIteration;
          if (typeof event.data.noProgressCount === "number") record.noProgressCount = event.data.noProgressCount;
        }
        runtime.lastSuccess = success;
        runtime.factsUsed = structuredClone(factsUsed);
        runtime.semanticsVersion = semanticsVersion;
        if (typeof event.data.metric === "number") runtime.currentMetric = event.data.metric;
        if (typeof event.data.bestMetric === "number") runtime.bestMetric = event.data.bestMetric;
        if (typeof event.data.bestIteration === "number") runtime.bestIteration = event.data.bestIteration;
        if (typeof event.data.noProgressCount === "number") runtime.noProgressCount = event.data.noProgressCount;
      }
      break;
    }
    case "hypagraph.loop.completed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "succeeded";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "success";
      }
      break;
    }
    case "hypagraph.loop.failed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "failed";
        runtime.completedAt = event.timestamp;
        const reason = event.data.exitReason;
        runtime.exitReason = reason === "no_progress" || reason === "evaluation_error" ? reason : "max_iterations";
        const policy = event.data.failurePolicy;
        if (policy === "fail-workflow" || policy === "block-dependants" || policy === "record-and-continue") runtime.failurePolicy = policy;
      }
      break;
    }
  }
  return finalise(withoutHash(next));
}

export function replayEvents(events: readonly DomainEvent[]): HypagraphState {
  if (events.length === 0) throw new Error("The event stream is empty.");
  let state: HypagraphState | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state!;
}
