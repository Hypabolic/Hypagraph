import { randomUUID } from "node:crypto";
import type {
  Diagnostic,
  DomainEvent,
  EventType,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
  ReducerResult,
} from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import { applyEvent, replayEvents } from "./projection.js";
import { dependenciesAreSatisfied } from "./readiness.js";
import { buildOutgoing } from "./scc.js";
import { sha256 } from "./hash.js";
import { validateDefinition } from "./validate.js";

const reject = (code: string, message: string, location?: string): ReducerResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

interface EventInput {
  type: EventType;
  nodeId?: string;
  attemptId?: string;
  data?: Record<string, unknown>;
}

const makeEvent = (
  state: HypagraphState | undefined,
  command: { commandId: string; correlationId?: string; at: string },
  workflowId: string,
  revision: number,
  input: EventInput,
): DomainEvent => ({
  eventId: randomUUID(),
  workflowId,
  revision,
  sequence: (state?.sequence ?? 0) + 1,
  type: input.type,
  version: HYPAGRAPH_EVENT_VERSION,
  timestamp: command.at,
  causationId: command.commandId,
  correlationId: command.correlationId ?? command.commandId,
  ...(input.nodeId ? { nodeId: input.nodeId } : {}),
  ...(input.attemptId ? { attemptId: input.attemptId } : {}),
  data: input.data ?? {},
});

const append = (
  state: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
  input: EventInput,
): HypagraphState => {
  const event = makeEvent(state, command, state.workflowId, state.revision, input);
  events.push(event);
  return applyEvent(state, event);
};

const appendReadyEvents = (
  state: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
): HypagraphState => {
  let next = state;
  for (const node of next.definition.nodes) {
    const runtime = next.runtime.nodes[node.id];
    if (!runtime || (runtime.status !== "pending" && runtime.status !== "stale")) continue;
    if (!dependenciesAreSatisfied(next, node.id)) continue;
    next = append(next, events, command, { type: "hypagraph.node.ready", nodeId: node.id });
  }
  return next;
};

export function createWorkflow(
  definition: HypagraphDefinition,
  at: string,
  workflowId: string = randomUUID(),
): ReducerResult {
  const diagnostics = validateDefinition(definition);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const command = { commandId: randomUUID(), at };
  const defined = makeEvent(undefined, command, workflowId, 1, {
    type: "hypagraph.workflow.defined",
    data: { definition: structuredClone(definition) },
  });
  const events = [defined];
  let state = applyEvent(undefined, defined);
  state = appendReadyEvents(state, events, command);
  return { ok: true, state, events };
}

const invalidatedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const oldNode = previousById.get(node.id);
    if (!oldNode || sha256(oldNode) !== sha256(node)) changed.add(node.id);
  }
  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of outgoing.get(queue[index]!) ?? []) {
      if (changed.has(dependent)) continue;
      changed.add(dependent);
      queue.push(dependent);
    }
  }
  return changed;
};

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") {
    return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  }
  const events: DomainEvent[] = [];
  let next = state;

  if (command.type === "pause-workflow") {
    if (state.phase === "paused") return reject("workflow_already_paused", "The workflow is already paused.");
    next = append(next, events, command, { type: "hypagraph.workflow.paused" });
    return { ok: true, state: next, events };
  }
  if (command.type === "resume-workflow") {
    if (state.phase !== "paused") return reject("workflow_not_paused", "The workflow is not paused.");
    next = append(next, events, command, { type: "hypagraph.workflow.resumed" });
    next = appendReadyEvents(next, events, command);
    return { ok: true, state: next, events };
  }
  if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you change a node.");

  if (command.type === "revise") {
    const diagnostics = validateDefinition(command.definition);
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    const invalidated = invalidatedNodes(state.definition, command.definition);
    const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, {
      type: "hypagraph.workflow.revised",
      data: { definition: structuredClone(command.definition) },
    });
    events.push(revised);
    next = applyEvent(next, revised);
    for (const nodeId of invalidated) {
      next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    }
    next = appendReadyEvents(next, events, command);
    return { ok: true, state: next, events };
  }

  const node = state.runtime.nodes[command.nodeId];
  if (!node) return reject("unknown_node", `Unknown node '${command.nodeId}'.`, "nodeId");

  switch (command.type) {
    case "start-node": {
      if (state.definition.loops.some((loop) => loop.nodes.includes(command.nodeId))) {
        return reject("loop_execution_pending", "Loop execution is not available in this release.");
      }
      if (node.status !== "ready") return reject("node_not_ready", `Node '${command.nodeId}' is not ready.`);
      if (Object.values(state.runtime.nodes).some((item) => ["starting", "running", "awaiting_evidence", "verifying"].includes(item.status))) {
        return reject("node_already_active", "Another node has an active attempt.");
      }
      next = append(next, events, command, {
        type: "hypagraph.attempt.started",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
      });
      break;
    }
    case "submit-result": {
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) {
        return reject("stale_attempt", "The result does not match the current running attempt.");
      }
      if (state.definition.policy.requireEvidence && command.evidence.length === 0) {
        return reject("evidence_required", `Node '${command.nodeId}' requires evidence.`);
      }
      next = append(next, events, command, {
        type: "hypagraph.attempt.result-submitted",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: { evidence: structuredClone(command.evidence) },
      });
      break;
    }
    case "begin-verification": {
      if (node.status !== "awaiting_evidence" || node.currentAttemptId !== command.attemptId) {
        return reject("attempt_not_submitted", "Submit the current attempt result before verification.");
      }
      next = append(next, events, command, {
        type: "hypagraph.verification.started",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
      });
      break;
    }
    case "complete-verification": {
      if (node.status !== "verifying" || node.currentAttemptId !== command.attemptId) {
        return reject("attempt_not_verifying", "The current attempt is not in verification.");
      }
      next = append(next, events, command, {
        type: command.passed ? "hypagraph.verification.passed" : "hypagraph.verification.failed",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: command.reason ? { reason: command.reason } : {},
      });
      if (command.passed) {
        next = appendReadyEvents(next, events, command);
        if (Object.values(next.runtime.nodes).every((item) => item.status === "succeeded")) {
          next = append(next, events, command, { type: "hypagraph.workflow.completed" });
        }
      }
      break;
    }
    case "block-node": {
      if (!["pending", "ready", "running", "stale", "failed"].includes(node.status)) {
        return reject("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from '${node.status}'.`);
      }
      if (!command.reason.trim()) return reject("block_reason_required", "A blocked node requires a reason.");
      next = append(next, events, command, {
        type: "hypagraph.node.blocked",
        nodeId: command.nodeId,
        data: { reason: command.reason.trim() },
      });
      break;
    }
    case "unblock-node": {
      if (node.status !== "blocked") return reject("node_not_blocked", `Node '${command.nodeId}' is not blocked.`);
      next = append(next, events, command, { type: "hypagraph.node.unblocked", nodeId: command.nodeId });
      next = appendReadyEvents(next, events, command);
      break;
    }
    case "cancel-attempt": {
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) {
        return reject("stale_attempt", "The cancellation does not match the current attempt.");
      }
      next = append(next, events, command, {
        type: "hypagraph.attempt.cancelled",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: command.reason ? { reason: command.reason } : {},
      });
      break;
    }
  }
  return { ok: true, state: next, events };
}

export const reduceHypagraph = handleCommand;
export { replayEvents };

export function assertValid(result: ReducerResult): HypagraphState {
  if (result.ok) return result.state;
  throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n"));
}
