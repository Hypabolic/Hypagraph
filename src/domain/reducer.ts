import { randomUUID } from "node:crypto";
import { sha256 } from "./hash.js";
import type {
  Diagnostic,
  DomainEvent,
  NodeDefinition,
  NodeRuntime,
  ReducerResult,
  WorkGraphCommand,
  WorkGraphDefinition,
  WorkGraphState,
} from "./model.js";
import { WORKGRAPH_SCHEMA_VERSION } from "./model.js";
import { isNodeReady, readyNodeIds } from "./readiness.js";
import { buildOutgoing } from "./scc.js";
import { validateDefinition } from "./validate.js";

const diagnostic = (code: string, message: string, location?: string): ReducerResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const definitionFingerprint = (node: NodeDefinition): string => sha256(node);

const withSnapshotHash = (state: Omit<WorkGraphState, "snapshotHash">): WorkGraphState => ({
  ...state,
  snapshotHash: sha256(state),
});

const phaseFor = (state: WorkGraphState): WorkGraphState["phase"] => {
  const runtimes = Object.values(state.runtime.nodes);
  if (runtimes.length > 0 && runtimes.every((runtime) => runtime.status === "completed")) return "completed";
  if (runtimes.some((runtime) => runtime.status === "active")) return "running";
  if (readyNodeIds(state).length > 0) return "running";
  if (runtimes.some((runtime) => runtime.status === "blocked")) return "blocked";
  return "running";
};

const finalize = (state: WorkGraphState): WorkGraphState => {
  const phase = phaseFor(state);
  const withoutHash: Omit<WorkGraphState, "snapshotHash"> = {
    schemaVersion: state.schemaVersion,
    workflowId: state.workflowId,
    revision: state.revision,
    phase,
    definition: state.definition,
    runtime: state.runtime,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  return withSnapshotHash(withoutHash);
};

export function createWorkflow(
  definition: WorkGraphDefinition,
  at: string,
  workflowId: string = randomUUID(),
): ReducerResult {
  const diagnostics = validateDefinition(definition);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const nodes: Record<string, NodeRuntime> = {};
  for (const node of definition.nodes) {
    nodes[node.id] = { status: "pending", attempt: 0, evidence: [] };
  }

  const state = finalize(withSnapshotHash({
    schemaVersion: WORKGRAPH_SCHEMA_VERSION,
    workflowId,
    revision: 1,
    phase: "running",
    definition,
    runtime: { nodes },
    createdAt: at,
    updatedAt: at,
  }));
  return { ok: true, state, events: [{ type: "workgraph.workflow.defined" }] };
}

const invalidatedNodes = (
  previous: WorkGraphDefinition,
  next: WorkGraphDefinition,
): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();

  for (const node of next.nodes) {
    const oldNode = previousById.get(node.id);
    if (!oldNode || definitionFingerprint(oldNode) !== definitionFingerprint(node)) changed.add(node.id);
  }

  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    for (const dependent of outgoing.get(node) ?? []) {
      if (changed.has(dependent)) continue;
      changed.add(dependent);
      queue.push(dependent);
    }
  }
  return changed;
};

function revise(state: WorkGraphState, definition: WorkGraphDefinition, at: string): ReducerResult {
  const diagnostics = validateDefinition(definition);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const invalidated = invalidatedNodes(state.definition, definition);
  const nodes: Record<string, NodeRuntime> = {};
  const events: DomainEvent[] = [{ type: "workgraph.workflow.revised" }];

  for (const node of definition.nodes) {
    const previous = state.runtime.nodes[node.id];
    if (!previous) {
      nodes[node.id] = { status: "pending", attempt: 0, evidence: [] };
      continue;
    }
    if (!invalidated.has(node.id)) {
      nodes[node.id] = structuredClone(previous);
      continue;
    }
    const status = previous.status === "completed" ? "stale" : "pending";
    nodes[node.id] = { status, attempt: previous.attempt, evidence: [] };
    if (status === "stale") events.push({ type: "workgraph.node.stale", nodeId: node.id });
  }

  const revised = finalize({
    ...structuredClone(state),
    revision: state.revision + 1,
    phase: "running",
    definition,
    runtime: { nodes },
    updatedAt: at,
  });
  return { ok: true, state: revised, events };
}

function transition(
  state: WorkGraphState,
  command: Extract<WorkGraphCommand, { type: "transition" }>,
): ReducerResult {
  const node = state.definition.nodes.find((candidate) => candidate.id === command.nodeId);
  const current = state.runtime.nodes[command.nodeId];
  if (!node || !current) return diagnostic("unknown_node", `Unknown node '${command.nodeId}'.`, "nodeId");
  if (state.phase === "completed" || state.phase === "cancelled") {
    return diagnostic("terminal_workflow", `Cannot transition a ${state.phase} workflow.`);
  }

  const next = structuredClone(state);
  const runtime = next.runtime.nodes[command.nodeId]!;
  const events: DomainEvent[] = [];

  switch (command.action) {
    case "start": {
      const loop = state.definition.loops.find((candidate) => candidate.nodes.includes(command.nodeId));
      if (loop) {
        return diagnostic(
          "loop_execution_pending",
          `Loop '${loop.id}' is structurally valid, but loop iteration and success evaluation are not implemented in this release.`,
        );
      }
      if (!isNodeReady(state, command.nodeId)) {
        return diagnostic("node_not_ready", `Node '${command.nodeId}' is not ready; its dependencies or status prevent it from starting.`);
      }
      const active = Object.entries(state.runtime.nodes).find(([, value]) => value.status === "active");
      if (active) return diagnostic("node_already_active", `Node '${active[0]}' is already active. Complete or block it first.`);
      runtime.status = "active";
      runtime.attempt += 1;
      runtime.startedAt = command.at;
      delete runtime.blockedReason;
      events.push({ type: "workgraph.node.started", nodeId: command.nodeId, data: { attempt: runtime.attempt } });
      break;
    }
    case "complete": {
      if (current.status !== "active") return diagnostic("node_not_active", `Node '${command.nodeId}' must be active before completion.`);
      const evidence = command.evidence ?? [];
      if (state.definition.policy.requireEvidence && evidence.length === 0) {
        return diagnostic("evidence_required", `Node '${command.nodeId}' requires at least one evidence reference.`);
      }
      runtime.status = "completed";
      runtime.evidence = structuredClone(evidence);
      runtime.completedAt = command.at;
      events.push({ type: "workgraph.node.completed", nodeId: command.nodeId, data: { evidenceCount: evidence.length } });
      break;
    }
    case "block": {
      if (current.status !== "active" && current.status !== "pending" && current.status !== "stale") {
        return diagnostic("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from status '${current.status}'.`);
      }
      if (!command.reason?.trim()) return diagnostic("block_reason_required", "Blocking a node requires a reason.", "reason");
      runtime.status = "blocked";
      runtime.blockedReason = command.reason.trim();
      events.push({ type: "workgraph.node.blocked", nodeId: command.nodeId, data: { reason: runtime.blockedReason } });
      break;
    }
    case "unblock": {
      if (current.status !== "blocked") return diagnostic("node_not_blocked", `Node '${command.nodeId}' is not blocked.`);
      runtime.status = "pending";
      delete runtime.blockedReason;
      events.push({ type: "workgraph.node.unblocked", nodeId: command.nodeId });
      break;
    }
  }

  next.updatedAt = command.at;
  const finalized = finalize(next);
  if (finalized.phase === "completed") {
    events.push({ type: "workgraph.workflow.completed" });
  }
  return { ok: true, state: finalized, events };
}

export function reduceWorkGraph(state: WorkGraphState, command: WorkGraphCommand): ReducerResult {
  if (command.type === "revise") return revise(state, command.definition, command.at);
  return transition(state, command);
}

export function assertValid(result: ReducerResult): WorkGraphState {
  if (result.ok) return result.state;
  throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n"));
}
