import { sha256 } from "./hash.js";
import type { FactRecord } from "./facts.js";
import type { AttemptRuntime, DomainEvent, HypagraphState, NodeRuntime } from "./model.js";
import { HYPAGRAPH_SCHEMA_VERSION } from "./model.js";

const hashState = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => ({
  ...state,
  snapshotHash: sha256(state),
});

const emptyNode = (): NodeRuntime => ({ status: "pending", attemptCount: 0, attempts: {}, evidence: [] });

const finalise = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => {
  const nodes = Object.values(state.runtime.nodes);
  let phase = state.phase;
  if (nodes.length > 0 && nodes.every((node) => node.status === "succeeded")) phase = "completed";
  else if (nodes.some((node) => node.status === "blocked") && !nodes.some((node) => ["ready", "running", "verifying", "awaiting_evidence"].includes(node.status))) phase = "blocked";
  else if (phase !== "paused" && phase !== "failed" && phase !== "cancelled") phase = "running";
  return hashState({ ...state, phase });
};

const withoutHash = (state: HypagraphState): Omit<HypagraphState, "snapshotHash"> => {
  const { snapshotHash: _snapshotHash, ...rest } = state;
  return rest;
};

export function applyEvent(state: HypagraphState | undefined, event: DomainEvent): HypagraphState {
  if (event.type === "hypagraph.workflow.defined") {
    const definition = event.data.definition as HypagraphState["definition"];
    const nodes = Object.fromEntries(definition.nodes.map((node) => [node.id, emptyNode()]));
    return finalise({
      schemaVersion: HYPAGRAPH_SCHEMA_VERSION,
      workflowId: event.workflowId,
      revision: event.revision,
      sequence: event.sequence,
      phase: "running",
      definition,
      runtime: { nodes, facts: {} },
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
  }
  if (!state) throw new Error("The first event must define the workflow.");
  if (event.workflowId !== state.workflowId) throw new Error("The event belongs to a different workflow.");
  if (event.sequence !== state.sequence + 1) throw new Error("The event sequence is not contiguous.");

  const next = structuredClone(state);
  next.sequence = event.sequence;
  next.revision = event.revision;
  next.updatedAt = event.timestamp;
  const node = event.nodeId ? next.runtime.nodes[event.nodeId] : undefined;
  const attempt = node && event.attemptId ? node.attempts[event.attemptId] : undefined;

  switch (event.type) {
    case "hypagraph.workflow.revised": {
      next.definition = event.data.definition as HypagraphState["definition"];
      const retained = next.runtime.nodes;
      next.runtime.nodes = {};
      for (const definitionNode of next.definition.nodes) next.runtime.nodes[definitionNode.id] = retained[definitionNode.id] ?? emptyNode();
      break;
    }
    case "hypagraph.workflow.paused": next.phase = "paused"; break;
    case "hypagraph.workflow.resumed": next.phase = "running"; break;
    case "hypagraph.workflow.completed": next.phase = "completed"; break;
    case "hypagraph.workflow.failed": next.phase = "failed"; break;
    case "hypagraph.node.ready": if (node) node.status = "ready"; break;
    case "hypagraph.node.invalidated":
      if (node) {
        node.status = "stale";
        delete node.currentAttemptId;
        node.evidence = [];
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
      if (node && event.attemptId) {
        const value: AttemptRuntime = { attemptId: event.attemptId, number: node.attemptCount + 1, status: "running", startedAt: event.timestamp, evidence: [] };
        node.attemptCount += 1;
        node.currentAttemptId = event.attemptId;
        node.attempts[event.attemptId] = value;
        node.status = "running";
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
      }
      break;
  }
  return finalise(withoutHash(next));
}

export function replayEvents(events: readonly DomainEvent[]): HypagraphState {
  if (events.length === 0) throw new Error("The event stream is empty.");
  let state: HypagraphState | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state!;
}
