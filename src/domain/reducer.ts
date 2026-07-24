import { randomUUID } from "node:crypto";
import { evaluateCheckStart } from "./check-policy.js";
import type {
  CheckDefinition,
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
import { affectedDependants, loopFailurePolicy, workflowCanComplete } from "./workflow-outcome.js";
import { evaluationBudgetExhaustedForKind, evaluationStartDiagnostic, metricEvaluationKind } from "./evaluation-policy.js";
import { invalidEvaluatorIntegrity, validateEvaluationIntegrityResult } from "./integrity-policy.js";

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

const appendCompletionIfNeeded = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => workflowCanComplete(state) ? append(state, events, command, { type: "hypagraph.workflow.completed" }) : state;

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

const ACTIVE_ATTEMPT_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

const directlyChangedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const oldNode = previousById.get(node.id);
    if (!oldNode || sha256(oldNode) !== sha256(node)) changed.add(node.id);
  }
  return changed;
};

const invalidatedLoopIds = (previous: HypagraphDefinition, next: HypagraphDefinition, changedNodes: ReadonlySet<string>): Set<string> => {
  const previousById = new Map(previous.loops.map((loop) => [loop.id, loop]));
  const changed = new Set<string>();
  for (const loop of next.loops) {
    const oldLoop = previousById.get(loop.id);
    if (!oldLoop || sha256(oldLoop) !== sha256(loop) || loop.nodes.some((nodeId) => changedNodes.has(nodeId))) changed.add(loop.id);
  }
  return changed;
};

const invalidatedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition, loopIds: ReadonlySet<string>): Set<string> => {
  const changed = directlyChangedNodes(previous, next);
  for (const loop of next.loops) if (loopIds.has(loop.id)) for (const nodeId of loop.nodes) changed.add(nodeId);
  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of outgoing.get(queue[index]!) ?? []) {
      if (!changed.has(dependent)) { changed.add(dependent); queue.push(dependent); }
    }
  }
  return changed;
};

const activeLoopForRevision = (state: HypagraphState): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.some((nodeId) => ACTIVE_ATTEMPT_STATUSES.has(state.runtime.nodes[nodeId]?.status ?? "pending")));

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
  if (runtime.status === "blocked") return reject("loop_blocked", `Loop '${definition.id}' is blocked: ${runtime.blockedReason ?? "explicit recovery is required"}. Revise the affected region before it runs again.`);
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

const activeAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => ACTIVE_ATTEMPT_STATUSES.has(item.status));

const validateCheckResult = (result: CheckResult, attemptId: string, definition: CheckDefinition): Rejection | undefined => {
  if (result.attemptId !== attemptId) return reject("stale_check_result", "The check result does not match the current attempt.");
  if (result.checkKind !== definition.kind) return reject("check_kind_mismatch", `The result kind '${result.checkKind}' does not match check kind '${definition.kind}'.`);
  if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))) return reject("invalid_check_timestamps", "The check result must contain valid start and completion timestamps.");
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) return reject("invalid_check_duration", "The check completion time must not be before its start time.");
  if (definition.kind === "metric-report") {
    const diagnostics = validateEvaluationIntegrityResult(definition, result);
    if (diagnostics.length > 0) return { ok: false, diagnostics };
  }
  return undefined;
};

interface LoopEvaluation {
  loopId: string;
  iteration: number;
  valid: boolean;
  validityFactsUsed: string[];
  invalidEvaluationCount: number;
  success: boolean;
  factsUsed: string[];
  semanticsVersion: number;
  metric?: number;
  improved?: boolean;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount: number;
  evaluationError?: string;
  evaluatorIntegrity?: NonNullable<CheckResult["evaluation"]>["integrity"];
}

const currentProgressMetric = (state: HypagraphState, definition: LoopDefinition, iteration: number): number | undefined => {
  if (!definition.progress) return undefined;
  const fact = state.runtime.facts[definition.progress.fact];
  return fact
    && typeof fact.value === "number"
    && Number.isFinite(fact.value)
    && fact.loopId === definition.id
    && fact.iteration === iteration
    ? fact.value
    : undefined;
};

const prepareLoopEvaluation = (state: HypagraphState, nodeId: string): LoopEvaluation | Rejection | undefined => {
  const definition = state.definition.loops.find((loop) => loop.evaluateAfter === nodeId);
  if (!definition) return undefined;
  const runtime = state.runtime.loops[definition.id];
  if (!runtime || runtime.status !== "running") return reject("loop_not_running", `Loop '${definition.id}' is not running.`);
  if (isLegacyPredicate(definition.successWhen)) return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);

  const evaluatorNode = state.runtime.nodes[nodeId];
  const evaluatorResult = evaluatorNode?.currentAttemptId === undefined ? undefined : evaluatorNode.attempts[evaluatorNode.currentAttemptId]?.checkResult;
  const evaluatorIntegrity = evaluatorResult?.evaluation?.integrity;
  const integrityValid = evaluatorIntegrity?.status !== "invalid";
  const validity = definition.evaluation ? evaluateCondition(definition.evaluation.validWhen, state.runtime.facts) : undefined;
  if (validity && !validity.ok) return reject(validity.code, validity.message, `loops.${definition.id}.evaluation.validWhen`);
  const valid = integrityValid && (validity?.value ?? true);
  const validityFactsUsed = validity?.factsUsed ?? [];
  const invalidEvaluationCount = valid || !definition.evaluation ? (runtime.invalidEvaluationCount ?? 0) : (runtime.invalidEvaluationCount ?? 0) + 1;
  const metric = currentProgressMetric(state, definition, runtime.currentIteration);
  if (!valid) {
    return {
      loopId: definition.id,
      iteration: runtime.currentIteration,
      valid: false,
      validityFactsUsed,
      invalidEvaluationCount,
      success: false,
      factsUsed: [...new Set([...validityFactsUsed, ...(definition.progress ? [definition.progress.fact] : [])])],
      semanticsVersion: CONDITION_SEMANTICS_VERSION,
      ...(metric === undefined ? {} : { metric }),
      noProgressCount: runtime.noProgressCount ?? 0,
      ...(evaluatorIntegrity === undefined ? {} : { evaluatorIntegrity: structuredClone(evaluatorIntegrity) }),
    };
  }

  const result = evaluateCondition(definition.successWhen, state.runtime.facts);
  if (!result.ok) return reject(result.code, result.message, `loops.${definition.id}.successWhen`);
  if (!definition.progress) {
    return {
      loopId: definition.id,
      iteration: runtime.currentIteration,
      valid: true,
      validityFactsUsed,
      invalidEvaluationCount,
      success: result.value,
      factsUsed: [...new Set([...validityFactsUsed, ...result.factsUsed])],
      semanticsVersion: CONDITION_SEMANTICS_VERSION,
      noProgressCount: runtime.noProgressCount ?? 0,
      ...(evaluatorIntegrity === undefined ? {} : { evaluatorIntegrity: structuredClone(evaluatorIntegrity) }),
    };
  }
  if (metric === undefined) {
    return {
      loopId: definition.id,
      iteration: runtime.currentIteration,
      valid: true,
      validityFactsUsed,
      invalidEvaluationCount,
      success: result.value,
      factsUsed: [...new Set([...validityFactsUsed, ...result.factsUsed, definition.progress.fact])],
      semanticsVersion: CONDITION_SEMANTICS_VERSION,
      noProgressCount: runtime.noProgressCount ?? 0,
      evaluationError: `Loop '${definition.id}' requires numeric progress fact '${definition.progress.fact}' from iteration ${runtime.currentIteration}.`,
      ...(evaluatorIntegrity === undefined ? {} : { evaluatorIntegrity: structuredClone(evaluatorIntegrity) }),
    };
  }
  const first = runtime.bestMetric === undefined;
  const delta = first ? undefined : definition.progress.direction === "maximize" ? metric - runtime.bestMetric! : runtime.bestMetric! - metric;
  const improved = first || (delta! > (definition.progress.minDelta ?? 0));
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    valid: true,
    validityFactsUsed,
    invalidEvaluationCount,
    success: result.value,
    factsUsed: [...new Set([...validityFactsUsed, ...result.factsUsed, definition.progress.fact])],
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
    metric,
    improved,
    ...(improved ? { bestMetric: metric, bestIteration: runtime.currentIteration } : {
      ...(runtime.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
      ...(runtime.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
    }),
    noProgressCount: improved ? 0 : (runtime.noProgressCount ?? 0) + 1,
    ...(evaluatorIntegrity === undefined ? {} : { evaluatorIntegrity: structuredClone(evaluatorIntegrity) }),
  };
};

const isFailedCheckLoopObservation = (state: HypagraphState, nodeId: string, attemptId: string): boolean => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  if ((definition?.kind ?? "task") !== "check") return false;
  if (!state.definition.loops.some((loop) => loop.evaluateAfter === nodeId)) return false;
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (attempt?.checkResult?.status !== "failed" && !invalidEvaluatorIntegrity(attempt?.checkResult)) return false;
  return requiredFactsArePresent(state, nodeId, attemptId).length === 0;
};

const exhaustedLoopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => {
    const runtime = state.runtime.loops[loop.id];
    return loop.nodes.includes(nodeId) && runtime?.status === "failed" && runtime.exitReason === "max_iterations";
  });

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (command.type !== "revise" && ["completed", "failed", "cancelled"].includes(state.phase)) {
    if (state.phase === "failed" && "nodeId" in command) {
      const exhausted = exhaustedLoopForNode(state, command.nodeId);
      if (exhausted) return reject("loop_exhausted", `Loop '${exhausted.id}' reached its limit of ${exhausted.maxIterations} iterations. It cannot start another iteration.`);
    }
    return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  }
  const events: DomainEvent[] = [];
  let next = state;
  if (command.type === "pause-workflow") { if (state.phase === "paused") return reject("workflow_already_paused", "The workflow is already paused."); next = append(next, events, command, { type: "hypagraph.workflow.paused" }); return { ok: true, state: next, events }; }
  if (command.type === "resume-workflow") { if (state.phase !== "paused") return reject("workflow_not_paused", "The workflow is not paused."); next = append(next, events, command, { type: "hypagraph.workflow.resumed" }); next = appendReadyEvents(next, events, command); return { ok: true, state: next, events }; }
  if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you change a node.");
  if (command.type === "revise") {
    const activeLoop = activeLoopForRevision(state);
    if (activeLoop) return reject("active_loop_revision_not_allowed", `Loop '${activeLoop.id}' has an active attempt. Cancel or finish it before revision.`, `loops.${activeLoop.id}`);
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const directChanges = directlyChangedNodes(state.definition, command.definition);
    const invalidatedLoops = invalidatedLoopIds(state.definition, command.definition, directChanges);
    const invalidated = invalidatedNodes(state.definition, command.definition, invalidatedLoops);
    const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const loopId of [...invalidatedLoops].sort()) next = append(next, events, command, { type: "hypagraph.loop.invalidated", loopId, data: { loopId, reason: "definition_revision" } });
    for (const nodeId of [...invalidated].sort()) if (next.runtime.nodes[nodeId]) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
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
      const evaluationKind = definitionNode.check.kind === "metric-report" ? metricEvaluationKind(definitionNode.check) : undefined;
      if (evaluationKind) {
        const budgetDiagnostic = evaluationStartDiagnostic(state.definition, state.runtime.evaluations, evaluationKind);
        if (budgetDiagnostic) return reject(budgetDiagnostic.code, budgetDiagnostic.message, "evaluation.budget");
      }
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      if (evaluationKind) {
        next = append(next, events, command, {
          type: "hypagraph.evaluation.started",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          data: { kind: evaluationKind },
        });
      }
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
      const invalid = validateCheckResult(command.result, command.attemptId, definitionNode.check); if (invalid) return invalid;
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
      const checkResultStatus = definitionNode.check ? node.attempts[command.attemptId]?.checkResult?.status : undefined;
      const integrityInvalid = invalidEvaluatorIntegrity(node.attempts[command.attemptId]?.checkResult) !== undefined;
      const verificationPassed = command.passed && !integrityInvalid;
      const interruptedLoopCheck = !command.passed && (checkResultStatus === "cancelled" || checkResultStatus === "interrupted");
      const failedCheckObservation = !verificationPassed && isFailedCheckLoopObservation(state, command.nodeId, command.attemptId);
      const evaluation = verificationPassed || failedCheckObservation ? prepareLoopEvaluation(state, command.nodeId) : undefined;
      if (evaluation && "ok" in evaluation) return evaluation;
      next = append(next, events, command, {
        type: verificationPassed ? "hypagraph.verification.passed" : "hypagraph.verification.failed",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: command.reason
          ? { reason: command.reason }
          : integrityInvalid
            ? { reason: "The evaluator integrity check failed." }
            : {},
      });
      if (evaluation) {
        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const loopDefinition = next.definition.loops.find((loop) => loop.id === evaluation.loopId)!;
        const evaluationFailed = evaluation.evaluationError !== undefined;
        const invalidLimitReached = !evaluationFailed && !evaluation.valid && loopDefinition.evaluation !== undefined && evaluation.invalidEvaluationCount >= loopDefinition.evaluation.maximumInvalidEvaluations;
        const completes = !evaluationFailed && evaluation.valid && verificationPassed && evaluation.success;
        const evaluatorCheck = next.definition.nodes.find((item) => item.id === loopDefinition.evaluateAfter)?.check;
        const evaluatorKind = evaluatorCheck?.kind === "metric-report" ? metricEvaluationKind(evaluatorCheck) : undefined;
        const evaluationBudgetExhausted = !evaluationFailed && !completes && !invalidLimitReached && evaluatorKind !== undefined && evaluationBudgetExhaustedForKind(next, evaluatorKind);
        const exhausted = !evaluationFailed && !completes && !invalidLimitReached && !evaluationBudgetExhausted && !!loopRuntime && evaluation.iteration >= loopRuntime.maxIterations;
        const patienceExhausted = !evaluationFailed && evaluation.valid && !completes && !evaluationBudgetExhausted && !exhausted && loopDefinition.patience !== undefined && evaluation.noProgressCount >= loopDefinition.patience;
        const canContinue = !evaluationFailed && !completes && !invalidLimitReached && !evaluationBudgetExhausted && !exhausted && !patienceExhausted && (!evaluation.valid || !evaluation.success) && !!loopRuntime;
        const exitReason = evaluationFailed ? "evaluation_error" : invalidLimitReached ? "invalid_evaluations" : evaluationBudgetExhausted ? "evaluation_budget" : exhausted ? "max_iterations" : patienceExhausted ? "no_progress" : undefined;
        const decision = completes ? "complete" : canContinue ? "continue" : exitReason ? "fail" : "pending";
        next = append(next, events, command, {
          type: "hypagraph.loop.evaluated",
          loopId: evaluation.loopId,
          data: {
            loopId: evaluation.loopId,
            iteration: evaluation.iteration,
            valid: evaluation.valid,
            validityFactsUsed: structuredClone(evaluation.validityFactsUsed),
            invalidEvaluationCount: evaluation.invalidEvaluationCount,
            success: evaluation.success,
            factsUsed: structuredClone(evaluation.factsUsed),
            semanticsVersion: evaluation.semanticsVersion,
            decision,
            verificationPassed,
            noProgressCount: evaluation.noProgressCount,
            ...(evaluation.metric === undefined ? {} : { metric: evaluation.metric }),
            ...(evaluation.improved === undefined ? {} : { improved: evaluation.improved }),
            ...(evaluation.bestMetric === undefined ? {} : { bestMetric: evaluation.bestMetric }),
            ...(evaluation.bestIteration === undefined ? {} : { bestIteration: evaluation.bestIteration }),
            ...(evaluation.evaluationError === undefined ? {} : { evaluationError: evaluation.evaluationError }),
            ...(evaluation.evaluatorIntegrity === undefined ? {} : { evaluatorIntegrity: structuredClone(evaluation.evaluatorIntegrity) }),
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
            ...(exitReason === undefined ? {} : { exitReason }),
          },
        });
        if (completes) {
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
              reason: evaluation.valid ? "feedback" : "invalid_evaluation",
            },
          });
          next = appendReadyEvents(next, events, command);
        } else if (exitReason) {
          const failurePolicy = loopFailurePolicy(loopDefinition);
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime?.maxIterations ?? loopDefinition.maxIterations,
              exitReason,
              failurePolicy,
              invalidEvaluationCount: evaluation.invalidEvaluationCount,
              ...(next.runtime.evaluations === undefined ? {} : { evaluationCounts: structuredClone(next.runtime.evaluations) }),
              ...(loopDefinition.evaluation === undefined ? {} : { maximumInvalidEvaluations: loopDefinition.evaluation.maximumInvalidEvaluations }),
              ...(evaluation.evaluationError === undefined ? {} : { error: evaluation.evaluationError }),
            },
          });
          if (failurePolicy === "fail-workflow") {
            next = append(next, events, command, {
              type: "hypagraph.workflow.failed",
              data: {
                reason: "loop_failed",
                loopId: evaluation.loopId,
                exitReason,
                failurePolicy,
              },
            });
          } else if (failurePolicy === "block-dependants") {
            for (const nodeId of affectedDependants(next.definition, evaluation.loopId)) {
              const dependent = next.runtime.nodes[nodeId];
              if (dependent && ["pending", "ready", "stale"].includes(dependent.status)) {
                next = append(next, events, command, {
                  type: "hypagraph.node.blocked",
                  nodeId,
                  loopId: evaluation.loopId,
                  data: {
                    reason: `Loop '${evaluation.loopId}' failed with '${exitReason}'.`,
                    loopId: evaluation.loopId,
                    failurePolicy,
                  },
                });
              }
            }
          }
        }
      }
      if (interruptedLoopCheck) {
        const loop = loopForNode(next, command.nodeId);
        const runtime = loop ? next.runtime.loops[loop.id] : undefined;
        if (loop && runtime?.status === "running") {
          const reason = command.reason?.trim() || (checkResultStatus === "cancelled" ? "The active loop check was cancelled." : "The active loop check was interrupted during restore.");
          next = append(next, events, command, {
            type: "hypagraph.loop.blocked",
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            loopId: loop.id,
            data: { loopId: loop.id, iteration: runtime.currentIteration, reason, resultStatus: checkResultStatus },
          });
        }
      }
      if ((verificationPassed || evaluation !== undefined) && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
      break;
    }
    case "block-node": { if (!["pending", "ready", "running", "stale", "failed"].includes(node.status)) return reject("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from '${node.status}'.`); if (!command.reason.trim()) return reject("block_reason_required", "A blocked node requires a reason."); next = append(next, events, command, { type: "hypagraph.node.blocked", nodeId: command.nodeId, data: { reason: command.reason.trim() } }); break; }
    case "unblock-node": { if (node.status !== "blocked") return reject("node_not_blocked", `Node '${command.nodeId}' is not blocked.`); next = append(next, events, command, { type: "hypagraph.node.unblocked", nodeId: command.nodeId }); next = appendReadyEvents(next, events, command); break; }
    case "cancel-attempt": {
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The cancellation does not match the current attempt.");
      const loop = loopForNode(state, command.nodeId);
      const attempt = node.attempts[command.attemptId];
      const reason = command.reason?.trim() || "The active attempt was cancelled.";
      next = append(next, events, command, {
        type: "hypagraph.attempt.cancelled",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        ...(loop ? { loopId: loop.id } : {}),
        data: { reason, ...(attempt?.iteration === undefined ? {} : { iteration: attempt.iteration }) },
      });
      if (loop && next.runtime.loops[loop.id]?.status === "running") {
        next = append(next, events, command, {
          type: "hypagraph.loop.blocked",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          loopId: loop.id,
          data: { loopId: loop.id, iteration: attempt?.iteration ?? next.runtime.loops[loop.id]!.currentIteration, reason, resultStatus: "cancelled" },
        });
      }
      break;
    }
  }
  return { ok: true, state: next, events };
}

export const reduceHypagraph = handleCommand;
export { replayEvents };
export function assertValid(result: ReducerResult): HypagraphState { if (result.ok) return result.state; throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n")); }
