import { randomUUID } from "node:crypto";
import { evaluateCheckStart } from "./check-policy.js";
import type {
  CheckResult,
  Diagnostic,
  DomainEvent,
  EventType,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
  LegacyLoopPredicate,
  LoopDefinition,
  ReducerResult,
} from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import type { PublishedFact } from "./facts.js";
import { validatePublishedFact } from "./facts.js";
import { CONDITION_SEMANTICS_VERSION, evaluateCondition } from "./conditions.js";
import { applyEvent, replayEvents } from "./projection.js";
import { dependenciesAreSatisfied, dependenciesSelectSkip } from "./readiness.js";
import { buildOutgoing } from "./scc.js";
import { sha256 } from "./hash.js";
import { validateDefinition } from "./validate.js";

type Rejection = Extract<ReducerResult, { ok: false }>;
const reject = (code: string, message: string, location?: string): Rejection => ({ ok: false, diagnostics: [{ code, message, ...(location ? { location } : {}) }] });
interface EventInput { type: EventType; nodeId?: string; attemptId?: string; loopId?: string; data?: Record<string, unknown> }

const makeEvent = (state: HypagraphState | undefined, command: { commandId: string; correlationId?: string; at: string }, workflowId: string, revision: number, input: EventInput): DomainEvent => {
  const sequence = (state?.sequence ?? 0) + 1;
  const eventId = sha256({ workflowId, revision, sequence, commandId: command.commandId, type: input.type, nodeId: input.nodeId ?? null, attemptId: input.attemptId ?? null, loopId: input.loopId ?? null });
  return { eventId, workflowId, revision, sequence, type: input.type, version: HYPAGRAPH_EVENT_VERSION, timestamp: command.at, causationId: command.commandId, correlationId: command.correlationId ?? command.commandId, ...(input.nodeId ? { nodeId: input.nodeId } : {}), ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...(input.loopId ? { loopId: input.loopId } : {}), data: input.data ?? {} };
};

const append = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }, input: EventInput): HypagraphState => {
  const event = makeEvent(state, command, state.workflowId, state.revision, input);
  events.push(event);
  return applyEvent(state, event);
};

const appendReadyEvents = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => {
  let next = state;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of next.definition.nodes) {
      const runtime = next.runtime.nodes[node.id];
      if (!runtime || (runtime.status !== "pending" && runtime.status !== "stale")) continue;
      if (!dependenciesAreSatisfied(next, node.id)) continue;
      next = append(next, events, command, { type: dependenciesSelectSkip(next, node.id) ? "hypagraph.node.skipped" : "hypagraph.node.ready", nodeId: node.id });
      changed = true;
    }
  }
  return next;
};

const allLoopsCompleted = (state: HypagraphState): boolean => Object.values(state.runtime.loops).every((loop) => loop.status === "succeeded");
const appendCompletionIfNeeded = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => Object.values(state.runtime.nodes).every((item) => item.status === "succeeded" || item.status === "skipped") && allLoopsCompleted(state) ? append(state, events, command, { type: "hypagraph.workflow.completed" }) : state;

export function createWorkflow(definition: HypagraphDefinition, at: string, workflowId: string = randomUUID()): ReducerResult {
  const diagnostics = validateDefinition(definition);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const command = { commandId: `define:${workflowId}`, at };
  const defined = makeEvent(undefined, command, workflowId, 1, { type: "hypagraph.workflow.defined", data: { definition: structuredClone(definition) } });
  const events = [defined];
  let state = applyEvent(undefined, defined);
  state = appendReadyEvents(state, events, command);
  return { ok: true, state, events };
}

const invalidatedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of next.nodes) { const oldNode = previousById.get(node.id); if (!oldNode || sha256(oldNode) !== sha256(node)) changed.add(node.id); }
  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) for (const dependent of outgoing.get(queue[index]!) ?? []) if (!changed.has(dependent)) { changed.add(dependent); queue.push(dependent); }
  return changed;
};

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined => state.definition.loops.find((loop) => loop.nodes.includes(nodeId));
const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyLoopPredicate>;
  return candidate.kind === "legacy-text" && typeof candidate.text === "string";
};

interface PreparedLoopStart { state: HypagraphState; loopId?: string; iteration?: number }
const prepareLoopStart = (
  state: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
  nodeId: string,
): PreparedLoopStart | Rejection => {
  const definition = loopForNode(state, nodeId);
  if (!definition) return { state };
  const runtime = state.runtime.loops[definition.id];
  if (!runtime) return reject("loop_runtime_missing", `Loop '${definition.id}' has no runtime state.`);
  if (runtime.status === "requires_revision") return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  if (runtime.status === "succeeded") return reject("loop_already_completed", `Loop '${definition.id}' is complete.`);
  if (runtime.status === "pending") {
    if (nodeId !== definition.entry) return reject("loop_entry_required", `Start loop '${definition.id}' at entry node '${definition.entry}'.`);
    const next = append(state, events, command, {
      type: "hypagraph.loop.iteration-started",
      loopId: definition.id,
      data: { loopId: definition.id, iteration: 1, maxIterations: definition.maxIterations },
    });
    return { state: next, loopId: definition.id, iteration: 1 };
  }
  return { state, loopId: definition.id, iteration: runtime.currentIteration };
};

const requiredFactsArePresent = (state: HypagraphState, nodeId: string, attemptId: string): string[] => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (!definition || !attempt) return [];
  return (definition.produces ?? []).filter((contract) => contract.required).filter((contract) => {
    const fact = state.runtime.facts[contract.name];
    return !fact
      || fact.producerNodeId !== nodeId
      || fact.attemptId !== attemptId
      || fact.revision !== state.revision
      || fact.loopId !== attempt.loopId
      || fact.iteration !== attempt.iteration;
  }).map((contract) => contract.name);
};

const activeAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => ["starting", "running", "awaiting_evidence", "verifying"].includes(item.status));

const validateCheckResult = (result: CheckResult, attemptId: string, checkKind: string): Rejection | undefined => {
  if (result.attemptId !== attemptId) return reject("stale_check_result", "The check result does not match the current attempt.");
  if (result.checkKind !== checkKind) return reject("check_kind_mismatch", `The result kind '${result.checkKind}' does not match check kind '${checkKind}'.`);
  if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))) return reject("invalid_check_timestamps", "The check result must contain valid start and completion timestamps.");
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) return reject("invalid_check_duration", "The check completion time must not be before its start time.");
  return undefined;
};

interface LoopEvaluation {
  loopId: string;
  iteration: number;
  success: boolean;
  factsUsed: string[];
  semanticsVersion: number;
}

const prepareLoopEvaluation = (state: HypagraphState, nodeId: string): LoopEvaluation | Rejection | undefined => {
  const definition = state.definition.loops.find((loop) => loop.evaluateAfter === nodeId);
  if (!definition) return undefined;
  const runtime = state.runtime.loops[definition.id];
  if (!runtime || runtime.status !== "running") return reject("loop_not_running", `Loop '${definition.id}' is not running.`);
  if (isLegacyPredicate(definition.successWhen)) return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  const result = evaluateCondition(definition.successWhen, state.runtime.facts);
  if (!result.ok) return reject(result.code, result.message, `loops.${definition.id}.successWhen`);
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: result.factsUsed,
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
  };
};

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (["completed", "failed", "cancelled"].includes(state.phase)) return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  const events: DomainEvent[] = [];
  let next = state;
  if (command.type === "pause-workflow") { if (state.phase === "paused") return reject("workflow_already_paused", "The workflow is already paused."); next = append(next, events, command, { type: "hypagraph.workflow.paused" }); return { ok: true, state: next, events }; }
  if (command.type === "resume-workflow") { if (state.phase !== "paused") return reject("workflow_not_paused", "The workflow is not paused."); next = append(next, events, command, { type: "hypagraph.workflow.resumed" }); next = appendReadyEvents(next, events, command); return { ok: true, state: next, events }; }
  if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you change a node.");
  if (command.type === "revise") {
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const invalidated = invalidatedNodes(state.definition, command.definition); const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const nodeId of invalidated) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    next = appendReadyEvents(next, events, command); return { ok: true, state: next, events };
  }

  const node = state.runtime.nodes[command.nodeId];
  if (!node) return reject("unknown_node", `Unknown node '${command.nodeId}'.`, "nodeId");
  const definitionNode = state.definition.nodes.find((item) => item.id === command.nodeId)!;

  switch (command.type) {
    case "start-node": {
      const kind = definitionNode.kind ?? "task";
      if (kind === "gate") return reject("gate_start_not_allowed", "Evaluate a gate instead of starting it.");
      if (kind === "check") return reject("check_start_required", "Start a check with the check execution command.");
      if (node.status !== "ready") return reject("node_not_ready", `Node '${command.nodeId}' is not ready.`);
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, { type: "hypagraph.attempt.started", nodeId: command.nodeId, attemptId: command.attemptId, data: { ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }), ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }) } });
      break;
    }
    case "start-check": {
      if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) return reject("node_not_check", `Node '${command.nodeId}' is not a check.`);
      const eligibility = evaluateCheckStart(node, definitionNode.check, command.attemptId, command.at);
      if (!eligibility.ok) return { ok: false, diagnostics: [eligibility.diagnostic] };
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, {
        type: "hypagraph.check.started",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          checkKind: definitionNode.check.kind,
          retry: eligibility.retry,
          ...(eligibility.previousAttemptId ? { previousAttemptId: eligibility.previousAttemptId } : {}),
          ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }),
          ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }),
        },
      });
      break;
    }
    case "record-check-result": {
      if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) return reject("node_not_check", `Node '${command.nodeId}' is not a check.`);
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) return reject("stale_check_attempt", "The check result does not match the current running attempt.");
      const invalid = validateCheckResult(command.result, command.attemptId, definitionNode.check.kind); if (invalid) return invalid;
      next = append(next, events, command, { type: "hypagraph.check.result-recorded", nodeId: command.nodeId, attemptId: command.attemptId, data: { result: structuredClone(command.result) } }); break;
    }
    case "evaluate-gate": {
      if ((definitionNode.kind ?? "task") !== "gate" || !definitionNode.gate) return reject("node_not_gate", `Node '${command.nodeId}' is not a gate.`);
      if (node.status !== "ready") return reject("gate_not_ready", `Gate '${command.nodeId}' is not ready.`);
      if (state.runtime.routes[command.nodeId]) return reject("gate_already_evaluated", `Gate '${command.nodeId}' already selected a route.`);
      const result = evaluateCondition(definitionNode.gate.condition, state.runtime.facts); if (!result.ok) return reject(result.code, result.message, `nodes.${command.nodeId}.gate.condition`);
      const selected = result.value ? definitionNode.gate.onTrue : definitionNode.gate.onFalse; const unselected = result.value ? definitionNode.gate.onFalse : definitionNode.gate.onTrue;
      next = append(next, events, command, { type: "hypagraph.route.selected", nodeId: command.nodeId, data: { outcomeId: result.value ? "true" : "false", targetNodeIds: structuredClone(selected), factsUsed: result.factsUsed, semanticsVersion: CONDITION_SEMANTICS_VERSION } });
      for (const nodeId of unselected) { const runtime = next.runtime.nodes[nodeId]; if (runtime && ["pending", "ready", "stale"].includes(runtime.status)) next = append(next, events, command, { type: "hypagraph.node.skipped", nodeId }); }
      next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); break;
    }
    case "publish-facts": {
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_fact_attempt", "The facts do not match the current attempt.");
      if (node.status !== "running") return reject("fact_publication_not_allowed", `Node '${command.nodeId}' cannot publish facts from '${node.status}'.`);
      if (command.facts.length === 0) return reject("facts_required", "Publish at least one fact.");
      if (new Set(command.facts.map((fact) => fact.name)).size !== command.facts.length) return reject("duplicate_fact_input", "A publication command must not contain the same fact more than one time.");
      const attempt = node.attempts[command.attemptId]!;
      const validated: PublishedFact[] = [];
      for (const input of command.facts) {
        const fact: PublishedFact = {
          name: input.name,
          type: input.type,
          value: structuredClone(input.value),
          producerNodeId: command.nodeId,
          attemptId: command.attemptId,
          revision: state.revision,
          evidence: structuredClone(input.evidence ?? []),
          ...(attempt.loopId === undefined ? {} : { loopId: attempt.loopId }),
          ...(attempt.iteration === undefined ? {} : { iteration: attempt.iteration }),
        };
        const result = validatePublishedFact(fact, { contracts: definitionNode.produces ?? [], currentRevision: state.revision, currentAttemptId: command.attemptId }); if (!result.ok) return reject(result.code, result.message, `facts.${input.name}`); validated.push(result.fact);
      }
      for (const fact of validated) next = append(next, events, command, { type: "hypagraph.fact.published", nodeId: command.nodeId, attemptId: command.attemptId, data: { fact: structuredClone(fact) } }); break;
    }
    case "submit-result": { if (node.status !== "running" || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The result does not match the current running attempt."); if (state.definition.policy.requireEvidence && command.evidence.length === 0) return reject("evidence_required", `Node '${command.nodeId}' requires evidence.`); next = append(next, events, command, { type: "hypagraph.attempt.result-submitted", nodeId: command.nodeId, attemptId: command.attemptId, data: { evidence: structuredClone(command.evidence) } }); break; }
    case "begin-verification": { if (node.status !== "awaiting_evidence" || node.currentAttemptId !== command.attemptId) return reject("attempt_not_submitted", "Submit the current attempt result before verification."); next = append(next, events, command, { type: "hypagraph.verification.started", nodeId: command.nodeId, attemptId: command.attemptId }); break; }
    case "complete-verification": {
      if (node.status !== "verifying" || node.currentAttemptId !== command.attemptId) return reject("attempt_not_verifying", "The current attempt is not in verification.");
      if (command.passed) {
        const missing = requiredFactsArePresent(state, command.nodeId, command.attemptId);
        if (missing.length > 0) return reject("required_facts_missing", `Node '${command.nodeId}' did not publish required facts: ${missing.join(", ")}.`);
      }
      const evaluation = command.passed ? prepareLoopEvaluation(state, command.nodeId) : undefined;
      if (evaluation && "ok" in evaluation) return evaluation;
      next = append(next, events, command, { type: command.passed ? "hypagraph.verification.passed" : "hypagraph.verification.failed", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} });
      if (evaluation) {
        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const decision = evaluation.success ? "complete" : canContinue ? "continue" : "pending";
        next = append(next, events, command, {
          type: "hypagraph.loop.evaluated",
          loopId: evaluation.loopId,
          data: {
            loopId: evaluation.loopId,
            iteration: evaluation.iteration,
            success: evaluation.success,
            factsUsed: structuredClone(evaluation.factsUsed),
            semanticsVersion: evaluation.semanticsVersion,
            decision,
          },
        });
        if (evaluation.success) {
          next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
        } else if (canContinue) {
          next = append(next, events, command, {
            type: "hypagraph.loop.iteration-started",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration + 1,
              previousIteration: evaluation.iteration,
              maxIterations: loopRuntime.maxIterations,
              reason: "feedback",
            },
          });
          next = appendReadyEvents(next, events, command);
        }
      }
      if (command.passed) { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
      break;
    }
    case "block-node": { if (!["pending", "ready", "running", "stale", "failed"].includes(node.status)) return reject("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from '${node.status}'.`); if (!command.reason.trim()) return reject("block_reason_required", "A blocked node requires a reason."); next = append(next, events, command, { type: "hypagraph.node.blocked", nodeId: command.nodeId, data: { reason: command.reason.trim() } }); break; }
    case "unblock-node": { if (node.status !== "blocked") return reject("node_not_blocked", `Node '${command.nodeId}' is not blocked.`); next = append(next, events, command, { type: "hypagraph.node.unblocked", nodeId: command.nodeId }); next = appendReadyEvents(next, events, command); break; }
    case "cancel-attempt": { if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The cancellation does not match the current attempt."); next = append(next, events, command, { type: "hypagraph.attempt.cancelled", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} }); break; }
  }
  return { ok: true, state: next, events };
}

export const reduceHypagraph = handleCommand;
export { replayEvents };
export function assertValid(result: ReducerResult): HypagraphState { if (result.ok) return result.state; throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n")); }
