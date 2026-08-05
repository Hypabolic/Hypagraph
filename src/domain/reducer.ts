import { randomUUID } from "node:crypto";
import { evaluateCheckStart } from "./check-policy.js";
import { evaluateCodeStart } from "./code-policy.js";
import { evaluateEffectStart } from "./effect-policy.js";
import type {
  CheckDefinition,
  CheckResult,
  CodeResult,
  Diagnostic,
  DomainEvent,
  EffectObservation,
  EventType,
  EvidenceReference,
  GoalBlockerIdentity,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
  InteractionDeadline,
  LegacyLoopPredicate,
  LoopDefinition,
  ReducerResult,
} from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import type { FactInput } from "./model.js";
import type { PublishedFact } from "./facts.js";
import { isFactValueOfType, validatePublishedFact } from "./facts.js";
import { CONDITION_SEMANTICS_VERSION, evaluateCondition } from "./conditions.js";
import { applyEvent, replayEvents } from "./projection.js";
import { dependenciesAreSatisfied, dependenciesSelectSkip } from "./readiness.js";
import { buildOutgoing } from "./scc.js";
import { sha256 } from "./hash.js";
import { validateDefinition } from "./validate.js";
import { affectedDependants, loopFailurePolicy, workflowCanComplete } from "./workflow-outcome.js";
import { evaluationBudgetExhaustedForKind, evaluationStartDiagnostic, metricEvaluationKind } from "./evaluation-policy.js";
import { invalidEvaluatorIntegrity, validateEvaluationIntegrityResult } from "./integrity-policy.js";
import { goalIsTerminal, goalOutcomeFromWorkflow } from "./goal-policy.js";
import { continuationActionMatches, isDispatchableGoalContinuation, selectGoalContinuation } from "./goal-continuation.js";
import { blockerIdentityMatches } from "./goal-blockage.js";
import { enumerateRootWorkActions } from "./goal-runnable.js";
import { validateAutomaticRevision } from "./goal-revision-policy.js";
import { formatGoalBudgetStop, goalBudgetStop, validateGoalBudgetDefinition, validateGoalTokenUsage } from "./goal-budget.js";

type Rejection = Extract<ReducerResult, { ok: false }>;
const reject = (code: string, message: string, location?: string): Rejection => ({ ok: false, diagnostics: [{ code, message, ...(location ? { location } : {}) }] });
interface EventInput { type: EventType; nodeId?: string; attemptId?: string; loopId?: string; data?: Record<string, unknown> }

/** Build the absolute interaction deadline from the definition and command time. */
const resolveInteractionDeadline = (
  timeout: NonNullable<NonNullable<HypagraphDefinition["nodes"][number]["interaction"]>["timeout"]>,
  requestedAt: string,
): { ok: true; deadline: InteractionDeadline } | { ok: false; code: string; message: string } => {
  if (timeout.absolute !== undefined && timeout.durationMs !== undefined) {
    return { ok: false, code: "invalid_interaction_timeout_source", message: "An interaction timeout must set durationMs or absolute, not both." };
  }
  if (timeout.absolute !== undefined) {
    if (!timeout.absolute.trim() || !Number.isFinite(Date.parse(timeout.absolute))) {
      return { ok: false, code: "invalid_interaction_timeout_absolute", message: "An interaction timeout absolute must be a valid ISO-8601 timestamp." };
    }
    return { ok: true, deadline: { absolute: timeout.absolute, source: "declared-absolute" } };
  }
  if (timeout.durationMs === undefined) {
    return { ok: false, code: "invalid_interaction_timeout_source", message: "An interaction timeout must set durationMs or absolute." };
  }
  if (!Number.isInteger(timeout.durationMs) || timeout.durationMs < 1) {
    return { ok: false, code: "invalid_interaction_timeout_duration", message: "An interaction timeout durationMs must be a positive integer." };
  }
  const requestedMs = Date.parse(requestedAt);
  if (!Number.isFinite(requestedMs)) {
    return { ok: false, code: "invalid_interaction_request_time", message: "The interaction request time must be a valid ISO-8601 timestamp." };
  }
  return {
    ok: true,
    deadline: {
      absolute: new Date(requestedMs + timeout.durationMs).toISOString(),
      source: "requested-at-plus-duration",
    },
  };
};

/** Report whether the stored deadline has passed at the evaluation time. */
const interactionDeadlinePassed = (deadlineAbsolute: string, evaluationAt: string): boolean | undefined => {
  const deadlineMs = Date.parse(deadlineAbsolute);
  const evaluationMs = Date.parse(evaluationAt);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(evaluationMs)) return undefined;
  return evaluationMs >= deadlineMs;
};

/** Publish declared response facts and pass verification for an interaction attempt. */
const publishInteractionFacts = (
  next: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  published: FactInput[],
  evidence: EvidenceReference[],
  reason: string,
): ReducerResult => {
  const definitionNode = next.definition.nodes.find((item) => item.id === nodeId)!;
  const attempt = next.runtime.nodes[nodeId]!.attempts[attemptId]!;
  let current = next;
  for (const input of published) {
    const fact: PublishedFact = {
      name: input.name,
      type: input.type,
      value: structuredClone(input.value),
      producerNodeId: nodeId,
      attemptId,
      revision: state.revision,
      evidence: structuredClone(input.evidence ?? evidence),
      ...(attempt.loopId === undefined ? {} : { loopId: attempt.loopId }),
      ...(attempt.iteration === undefined ? {} : { iteration: attempt.iteration }),
    };
    const validated = validatePublishedFact(fact, {
      contracts: definitionNode.produces ?? [],
      currentRevision: state.revision,
      currentAttemptId: attemptId,
    });
    if (!validated.ok) return reject(validated.code, validated.message, `facts.${input.name}`);
    current = append(current, events, command, {
      type: "hypagraph.fact.published",
      nodeId,
      attemptId,
      data: { fact: structuredClone(validated.fact) },
    });
  }
  const missing = requiredFactsArePresent(current, nodeId, attemptId);
  if (missing.length > 0) return reject("required_facts_missing", `Node '${nodeId}' did not publish required facts: ${missing.join(", ")}.`);
  current = append(current, events, command, {
    type: "hypagraph.verification.passed",
    nodeId,
    attemptId,
    data: { reason },
  });
  current = appendReadyEvents(current, events, command);
  current = appendCompletionIfNeeded(current, events, command);
  return { ok: true, state: current, events };
};

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

const GOAL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const appendGoalOutcomeIfNeeded = (
  state: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
): HypagraphState => {
  const outcome = goalOutcomeFromWorkflow(state);
  if (!outcome || !state.goal) return state;
  return append(state, events, command, {
    type: outcome.type,
    data: { goalId: state.goal.goalId, reason: outcome.reason },
  });
};

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
  state.definition.loops.find((loop) => loop.nodes.some((nodeId) => {
    const status = state.runtime.nodes[nodeId]?.status ?? "pending";
    return ACTIVE_ATTEMPT_STATUSES.has(status) || status === "waiting_for_child";
  }));

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

const nodeHasOpenAttempt = (item: HypagraphState["runtime"]["nodes"][string]): boolean =>
  ACTIVE_ATTEMPT_STATUSES.has(item.status)
  || Object.values(item.attempts).some(
    (attempt) => attempt.status === "running" || attempt.status === "submitted" || attempt.status === "verifying",
  );

/**
 * True when another node holds exclusive active-attempt ownership.
 * Interaction wait and child wait do not block independent work starts.
 */
const exclusiveActiveAttemptExists = (state: HypagraphState): boolean =>
  Object.values(state.runtime.nodes).some((item) => {
    // An unanswered interaction waits without holding exclusive active-attempt ownership.
    if (item.status === "awaiting_response") return false;
    // A parent task waiting for a child goal suspends only that task.
    if (item.status === "waiting_for_child") return false;
    return nodeHasOpenAttempt(item);
  });

/**
 * True when starting a check is blocked by non-check active work.
 *
 * Independent ready checks may run concurrently (parallel components).
 * An active task, code, or effect attempt still blocks a new check start.
 */
const concurrentCheckStartBlocked = (state: HypagraphState): boolean => {
  for (const [nodeId, item] of Object.entries(state.runtime.nodes)) {
    if (item.status === "awaiting_response" || item.status === "waiting_for_child") continue;
    if (!nodeHasOpenAttempt(item)) continue;
    const kind = state.definition.nodes.find((node) => node.id === nodeId)?.kind ?? "task";
    // Another check may already be running on an independent branch.
    if (kind === "check") continue;
    return true;
  }
  return false;
};

/**
 * True when revision is unsafe because an open attempt still owns workflow identity.
 * A parent task waiting for a child still blocks revision so the binding target remains valid.
 */
const revisionBlockingAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => {
  if (item.status === "awaiting_response") return false;
  if (item.status === "waiting_for_child") return true;
  return nodeHasOpenAttempt(item);
});

/** Exclusive active-attempt ownership for concurrent work starts (tasks, code, effects). */
const activeAttemptExists = exclusiveActiveAttemptExists;

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

const validateCodeResult = (result: CodeResult, attemptId: string): Rejection | undefined => {
  if (result.attemptId !== attemptId) return reject("stale_code_result", "The code result does not match the current attempt.");
  if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))) {
    return reject("invalid_code_timestamps", "The code result must contain valid start and completion timestamps.");
  }
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    return reject("invalid_code_duration", "The code completion time must not be before its start time.");
  }
  return undefined;
};

const validateEffectObservation = (
  observation: EffectObservation,
  attemptId: string,
  expectedKey: string | undefined,
  expectedStates: ReadonlySet<EffectObservation["durableState"]>,
): Rejection | undefined => {
  if (!observation.idempotencyKey.trim()) {
    return reject("effect_idempotency_key_required", "An effect observation requires an idempotency key.");
  }
  if (expectedKey !== undefined && observation.idempotencyKey !== expectedKey) {
    return reject("effect_idempotency_key_mismatch", "The effect observation idempotency key does not match the request.");
  }
  if (!expectedStates.has(observation.durableState)) {
    return reject(
      "effect_observation_state_invalid",
      `The effect observation durable state '${observation.durableState}' is not valid for this command.`,
    );
  }
  if (!Number.isFinite(Date.parse(observation.requestedAt))) {
    return reject("invalid_effect_request_time", "The effect observation requires a valid request timestamp.");
  }
  if (observation.durableState === "observed") {
    if (observation.observedOutcome !== "success" && observation.observedOutcome !== "failure") {
      return reject("effect_observed_outcome_required", "An observed effect requires outcome success or failure.");
    }
    if (!observation.observedAt || !Number.isFinite(Date.parse(observation.observedAt))) {
      return reject("invalid_effect_observed_time", "An observed effect requires a valid observation timestamp.");
    }
  }
  if (observation.reconciliationAttempts < 0 || !Number.isInteger(observation.reconciliationAttempts)) {
    return reject("invalid_effect_reconciliation_count", "The reconciliation attempt count must be a non-negative integer.");
  }
  void attemptId;
  return undefined;
};

const publishObservationFacts = (
  state: HypagraphState,
  events: DomainEvent[],
  command: HypagraphCommand,
  nodeId: string,
  attemptId: string,
  facts: FactInput[],
): { ok: true; state: HypagraphState } | Rejection => {
  if (facts.length === 0) return { ok: true, state };
  if (new Set(facts.map((fact) => fact.name)).size !== facts.length) {
    return reject("duplicate_fact_input", "A publication command must not contain the same fact more than one time.");
  }
  const definitionNode = state.definition.nodes.find((item) => item.id === nodeId);
  if (!definitionNode) return reject("unknown_node", `Unknown node '${nodeId}'.`, "nodeId");
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (!attempt) return reject("stale_fact_attempt", "The facts do not match the current attempt.");
  let next = state;
  for (const input of facts) {
    const fact: PublishedFact = {
      name: input.name,
      type: input.type,
      value: structuredClone(input.value),
      producerNodeId: nodeId,
      attemptId,
      revision: state.revision,
      evidence: structuredClone(input.evidence ?? []),
      ...(attempt.loopId === undefined ? {} : { loopId: attempt.loopId }),
      ...(attempt.iteration === undefined ? {} : { iteration: attempt.iteration }),
    };
    const result = validatePublishedFact(fact, {
      contracts: definitionNode.produces ?? [],
      currentRevision: state.revision,
      currentAttemptId: attemptId,
    });
    if (!result.ok) return reject(result.code, result.message, `facts.${input.name}`);
    next = append(next, events, command, {
      type: "hypagraph.fact.published",
      nodeId,
      attemptId,
      data: { fact: structuredClone(result.fact) },
    });
  }
  return { ok: true, state: next };
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
  if (command.type !== "revise" && command.type !== "record-goal-turn-usage" && command.type !== "apply-goal-revision" && command.type !== "abandon-goal-revision" && ["completed", "failed", "cancelled"].includes(state.phase)) {
    if (state.phase === "failed" && "nodeId" in command) {
      const exhausted = exhaustedLoopForNode(state, command.nodeId);
      if (exhausted) return reject("loop_exhausted", `Loop '${exhausted.id}' reached its limit of ${exhausted.maxIterations} iterations. It cannot start another iteration.`);
    }
    return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  }
  const events: DomainEvent[] = [];
  let next = state;
  if (command.type === "start-goal") {
    if (state.goal) return reject("goal_already_started", `Goal '${state.goal.goalId}' already controls this workflow.`);
    if (!GOAL_ID_PATTERN.test(command.goalId)) return reject("invalid_goal_id", "A goal ID must start with a lower-case letter and contain at most 64 lower-case letters, numbers, underscores, or hyphens.", "goalId");
    const budgetDiagnostics = validateGoalBudgetDefinition(command.budget);
    if (budgetDiagnostics.length > 0) return { ok: false, diagnostics: budgetDiagnostics };
    next = append(next, events, command, { type: "hypagraph.goal.started", data: { goalId: command.goalId, ...(command.budget ? { budget: structuredClone(command.budget) } : {}) } });
    next = appendGoalOutcomeIfNeeded(next, events, command);
    return { ok: true, state: next, events };
  }
  if (command.type === "pause-goal") {
    if (!state.goal) return reject("goal_not_started", "This workflow has no goal-control state.");
    const automatic = state.goal.automaticRevision.lastAttempt;
    if (automatic?.outcome === "pending") {
      next = append(next, events, command, {
        type: "hypagraph.goal.revision-abandoned",
        data: { goalId: state.goal.goalId, operationId: automatic.operationId, outcomeCode: "goal_paused", reason: command.reason?.trim() || "The goal was paused before the automatic revision completed." },
      });
    }
    if (goalIsTerminal(state.goal) && command.cause !== "usage_invalid") return reject("terminal_goal", `The goal is ${state.goal.status}.`);
    if (state.goal.status === "paused") return reject("goal_already_paused", "The goal is already paused.");
    if (state.goal.status === "blocked" && command.cause !== "session_reload" && command.cause !== "branch_change") return reject("goal_blocked", "Revise the blocked workflow before you resume or pause the goal.");
    next = append(next, events, command, { type: "hypagraph.goal.paused", data: { goalId: state.goal.goalId, reason: command.reason?.trim() || "The goal was paused explicitly.", cause: command.cause ?? "explicit" } });
    return { ok: true, state: next, events };
  }
  if (command.type === "resume-goal") {
    if (!state.goal) return reject("goal_not_started", "This workflow has no goal-control state.");
    if (goalIsTerminal(state.goal)) return reject("terminal_goal", `The goal is ${state.goal.status}.`);
    if (state.goal.status !== "paused" && state.goal.status !== "blocked") return reject("goal_not_paused", "The goal is not paused or blocked.");
    if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you resume the goal.");
    if (state.phase === "blocked") return reject("workflow_blocked", "Revise or unblock the workflow before you resume the goal.");
    next = append(next, events, command, { type: "hypagraph.goal.resumed", data: { goalId: state.goal.goalId } });
    const budgetStop = goalBudgetStop(next.goal!.budget, command.at);
    if (budgetStop) {
      next = append(next, events, command, { type: "hypagraph.goal.budget-limited", data: { goalId: next.goal!.goalId, stop: budgetStop, reason: formatGoalBudgetStop(budgetStop) } });
    } else {
      next = appendGoalOutcomeIfNeeded(next, events, command);
    }
    return { ok: true, state: next, events };
  }
  if (command.type === "cancel-goal") {
    if (!state.goal) return reject("goal_not_started", "This workflow has no goal-control state.");
    if (goalIsTerminal(state.goal)) return reject("terminal_goal", `The goal is ${state.goal.status}.`);
    next = append(next, events, command, { type: "hypagraph.goal.cancelled", data: { goalId: state.goal.goalId, reason: command.reason?.trim() || "The goal was cancelled explicitly." } });
    return { ok: true, state: next, events };
  }
  if (command.type === "request-goal-continuation") {
    if (!state.goal) return reject("goal_not_started", "This workflow has no goal-control state.");
    if (state.goal.status !== "active" && !(state.goal.status === "blocked" && command.action.kind === "request-revision")) return reject("goal_not_active", `The goal is ${state.goal.status}.`);
    if (state.goal.pendingContinuation) return reject("goal_continuation_pending", "The goal already has a durable pending continuation.");
    if (!Number.isSafeInteger(command.sessionGeneration) || command.sessionGeneration < 0 || !Number.isSafeInteger(command.branchGeneration) || command.branchGeneration < 0) return reject("invalid_goal_continuation_generation", "Continuation generations must be non-negative safe integers.");
    if (command.goalId !== state.goal.goalId) return reject("stale_goal_continuation", "The continuation belongs to a different goal.", "goalId");
    if (command.workflowId !== state.workflowId) return reject("stale_goal_continuation", "The continuation belongs to a different workflow.", "workflowId");
    if (command.expectedRevision !== state.revision) return reject("stale_goal_continuation", "The workflow revision changed before the continuation request was stored.", "expectedRevision");
    if (command.expectedSequence !== state.sequence) return reject("stale_goal_continuation", "The workflow sequence changed before the continuation request was stored.", "expectedSequence");
    if (command.expectedSnapshotHash !== state.snapshotHash) return reject("stale_goal_continuation", "The workflow snapshot changed before the continuation request was stored.", "expectedSnapshotHash");
    if (command.expectedContinuationOrdinal !== state.goal.continuationOrdinal) return reject("stale_goal_continuation", "The continuation ordinal changed before the continuation request was stored.", "expectedContinuationOrdinal");
    const budgetStop = goalBudgetStop(state.goal.budget, command.at);
    if (budgetStop) {
      next = append(next, events, command, { type: "hypagraph.goal.budget-limited", data: { goalId: state.goal.goalId, stop: budgetStop, reason: formatGoalBudgetStop(budgetStop) } });
      return { ok: true, state: next, events };
    }
    const selected = selectGoalContinuation(state);
    if (!isDispatchableGoalContinuation(selected)) {
      return reject("goal_continuation_not_runnable", selected.kind === "invariant-error" ? selected.reason : `The goal cannot continue from '${selected.kind}'.`);
    }
    if (!continuationActionMatches(selected, command.action)) return reject("stale_goal_continuation", "The selected continuation action changed before the request was stored.", "action");
    if (command.action.kind === "request-revision") {
      if (state.goal.status === "active") {
        next = append(next, events, command, { type: "hypagraph.goal.blocked", data: { goalId: state.goal.goalId, reason: command.action.blocker.reason } });
      }
      next = append(next, events, command, {
        type: "hypagraph.goal.revision-requested",
        data: {
          goalId: state.goal.goalId,
          operationId: command.commandId,
          blocker: structuredClone(command.action.blocker),
          sourceRevision: command.action.blocker.sourceRevision,
          sourceSequence: command.action.blocker.sourceSequence,
          sourceSnapshotHash: command.action.blocker.sourceSnapshotHash,
          sessionGeneration: command.sessionGeneration,
          branchGeneration: command.branchGeneration,
        },
      });
    }
    const ordinal = state.goal.continuationOrdinal + 1;
    next = append(next, events, command, {
      type: "hypagraph.goal.continuation-requested",
      ...(command.action.kind === "request-revision" ? {} : { nodeId: command.action.nodeId }),
      ...(command.action.kind !== "request-revision" && command.action.loopId ? { loopId: command.action.loopId } : {}),
      data: {
        goalId: state.goal.goalId,
        operationId: command.commandId,
        ordinal,
        action: structuredClone(command.action),
        selectedRevision: state.revision,
        selectedSequence: state.sequence,
        selectedSnapshotHash: state.snapshotHash,
        sessionGeneration: command.sessionGeneration,
        branchGeneration: command.branchGeneration,
      },
    });
    return { ok: true, state: next, events };
  }
  if (command.type === "abandon-goal-continuation") {
    const pending = state.goal?.pendingContinuation;
    if (!state.goal || !pending) return reject("goal_continuation_not_pending", "The goal has no durable pending continuation.");
    if (command.goalId !== state.goal.goalId || command.workflowId !== state.workflowId || command.expectedRevision !== state.revision || command.expectedSequence !== state.sequence || command.expectedSnapshotHash !== state.snapshotHash) return reject("stale_goal_continuation", "The continuation state changed before abandonment.");
    if (command.continuationOperationId !== pending.operationId || command.continuationOrdinal !== pending.ordinal || command.requestSequence !== pending.requestSequence || command.sessionGeneration !== pending.sessionGeneration || command.branchGeneration !== pending.branchGeneration) return reject("stale_goal_continuation", "The continuation identity changed before abandonment.");
    const automatic = state.goal.automaticRevision.lastAttempt;
    if (pending.action.kind === "request-revision" && automatic?.operationId === pending.operationId && automatic.outcome === "pending") {
      next = append(next, events, command, { type: "hypagraph.goal.revision-abandoned", data: { goalId: state.goal.goalId, operationId: automatic.operationId, outcomeCode: "continuation_abandoned", reason: command.reason } });
    }
    next = append(next, events, command, { type: "hypagraph.goal.continuation-abandoned", data: { goalId: state.goal.goalId, operationId: pending.operationId, reason: command.reason } });
    return { ok: true, state: next, events };
  }
  if (command.type === "apply-goal-revision" || command.type === "abandon-goal-revision") {
    const goal = state.goal;
    const pending = goal?.pendingContinuation;
    const automatic = goal?.automaticRevision.lastAttempt;
    if (!goal || !pending || pending.action.kind !== "request-revision" || !automatic) return reject("goal_revision_not_pending", "The goal has no pending automatic revision request.");
    const staleReason = command.goalId !== goal.goalId || command.workflowId !== state.workflowId || command.expectedRevision !== state.revision || command.expectedSequence !== state.sequence || command.expectedSnapshotHash !== state.snapshotHash
      ? "The workflow changed before the revision proposal was processed."
      : state.sequence !== pending.requestSequence
        ? "The workflow sequence changed after the revision request."
        : command.revisionOperationId !== automatic.operationId || command.continuationOperationId !== pending.operationId || command.continuationOrdinal !== pending.ordinal || command.requestSequence !== pending.requestSequence || command.sessionGeneration !== pending.sessionGeneration || command.branchGeneration !== pending.branchGeneration
          ? "The automatic revision identity changed before the proposal was processed."
          : !blockerIdentityMatches(command.type === "apply-goal-revision" ? command.blocker : pending.action.blocker, pending.action.blocker)
            ? "The canonical blocker changed before the proposal was processed."
            : undefined;
    if (staleReason) {
      const belongsToConsumedAttempt = command.type === "apply-goal-revision"
        && automatic.outcome === "pending"
        && automatic.operationId === command.revisionOperationId;
      if (!belongsToConsumedAttempt) return reject("stale_goal_revision", staleReason);
      next = append(next, events, command, {
        type: "hypagraph.goal.revision-abandoned",
        data: { goalId: goal.goalId, operationId: automatic.operationId, outcomeCode: "stale_goal_revision", reason: staleReason },
      });
      return { ok: true, state: next, events };
    }
    if (automatic.outcome !== "pending") return reject("goal_revision_already_resolved", "The automatic revision request already has an outcome.");
    if (command.type === "abandon-goal-revision") {
      next = append(next, events, command, { type: "hypagraph.goal.revision-abandoned", data: { goalId: goal.goalId, operationId: automatic.operationId, outcomeCode: command.outcomeCode, reason: command.reason } });
      return { ok: true, state: next, events };
    }
    if (revisionBlockingAttemptExists(state)) {
      return reject(
        "active_revision_not_allowed",
        "An active attempt, check, or parent task waiting for a child must finish or be cancelled before revision.",
      );
    }
    const safeguards = validateAutomaticRevision(state.definition, command.definition);
    const structural = validateDefinition(command.definition);
    const rejection = [...safeguards, ...structural];
    if (rejection.length > 0) {
      next = append(next, events, command, { type: "hypagraph.goal.revision-rejected", data: { goalId: goal.goalId, operationId: automatic.operationId, outcomeCode: rejection[0]!.code, reason: rejection[0]!.message, diagnostics: structuredClone(rejection) } });
      return { ok: true, state: next, events };
    }
    const revised = handleCommand(state, { type: "revise", definition: command.definition, commandId: `${command.commandId}:workflow`, correlationId: command.correlationId ?? command.commandId, at: command.at });
    if (!revised.ok) return revised;
    if (revised.state.phase !== "running" || enumerateRootWorkActions(revised.state).length === 0) {
      next = append(next, events, command, { type: "hypagraph.goal.revision-rejected", data: { goalId: goal.goalId, operationId: automatic.operationId, outcomeCode: "automatic_revision_still_blocked", reason: "The proposed definition leaves no valid runnable path." } });
      return { ok: true, state: next, events };
    }
    next = revised.state;
    events.push(...revised.events);
    next = append(next, events, command, { type: "hypagraph.goal.revision-applied", data: { goalId: goal.goalId, operationId: automatic.operationId, appliedRevision: next.revision } });
    next = append(next, events, command, { type: "hypagraph.goal.resumed", data: { goalId: goal.goalId, reason: "The bounded automatic revision restored a runnable path." } });
    return { ok: true, state: next, events };
  }
  if (command.type === "record-goal-turn-usage") {
    const goal = state.goal;
    const pending = goal?.pendingContinuation;
    if (!goal) return reject("goal_not_started", "This workflow has no goal-control state.");
    if (goal.budget.lastAccountedTurn?.turnId === command.turnId) return reject("duplicate_goal_turn_usage", `Turn '${command.turnId}' was already accounted.`);
    if (!pending) return reject("goal_continuation_not_pending", "The completed turn has no durable pending continuation.");
    if (command.goalId !== goal.goalId || command.workflowId !== state.workflowId || command.expectedRevision !== state.revision || command.expectedSequence !== state.sequence || command.expectedSnapshotHash !== state.snapshotHash) return reject("stale_goal_turn_usage", "The workflow changed before turn usage was recorded.");
    if (command.continuationOperationId !== pending.operationId || command.continuationOrdinal !== pending.ordinal || command.requestSequence !== pending.requestSequence || command.selectedSequence !== pending.selectedSequence || command.selectedSnapshotHash !== pending.selectedSnapshotHash || command.sessionGeneration !== pending.sessionGeneration || command.branchGeneration !== pending.branchGeneration) return reject("stale_goal_turn_usage", "The turn usage identity does not match the durable continuation.");
    const usageDiagnostics = validateGoalTokenUsage(command.usage);
    if (usageDiagnostics.length > 0) return { ok: false, diagnostics: usageDiagnostics };
    next = append(next, events, command, { type: "hypagraph.goal.turn-recorded", data: { goalId: goal.goalId, turnId: command.turnId, continuationOperationId: pending.operationId, continuationOrdinal: pending.ordinal, source: command.source, usage: structuredClone(command.usage) } });
    if (next.goal?.status === "active") {
      const stop = goalBudgetStop(next.goal.budget, command.at);
      if (stop) next = append(next, events, command, { type: "hypagraph.goal.budget-limited", data: { goalId: next.goal.goalId, stop, reason: formatGoalBudgetStop(stop) } });
    }
    return { ok: true, state: next, events };
  }
  if (command.type === "pause-workflow") { if (state.phase === "paused") return reject("workflow_already_paused", "The workflow is already paused."); next = append(next, events, command, { type: "hypagraph.workflow.paused" }); next = appendGoalOutcomeIfNeeded(next, events, command); return { ok: true, state: next, events }; }
  if (command.type === "resume-workflow") { if (state.phase !== "paused") return reject("workflow_not_paused", "The workflow is not paused."); next = append(next, events, command, { type: "hypagraph.workflow.resumed" }); next = appendReadyEvents(next, events, command); next = appendGoalOutcomeIfNeeded(next, events, command); return { ok: true, state: next, events }; }
  if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you change a node.");
  if (command.type === "revise") {
    const activeLoop = activeLoopForRevision(state);
    if (activeLoop) return reject("active_loop_revision_not_allowed", `Loop '${activeLoop.id}' has an active attempt. Cancel or finish it before revision.`, `loops.${activeLoop.id}`);
    if (revisionBlockingAttemptExists(state)) {
      return reject(
        "active_revision_not_allowed",
        "An active attempt, check, or parent task waiting for a child must finish or be cancelled before revision.",
      );
    }
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const directChanges = directlyChangedNodes(state.definition, command.definition);
    const invalidatedLoops = invalidatedLoopIds(state.definition, command.definition, directChanges);
    const invalidated = invalidatedNodes(state.definition, command.definition, invalidatedLoops);
    const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const loopId of [...invalidatedLoops].sort()) next = append(next, events, command, { type: "hypagraph.loop.invalidated", loopId, data: { loopId, reason: "definition_revision" } });
    for (const nodeId of [...invalidated].sort()) if (next.runtime.nodes[nodeId]) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    next = appendReadyEvents(next, events, command); next = appendGoalOutcomeIfNeeded(next, events, command); return { ok: true, state: next, events };
  }

  const node = state.runtime.nodes[command.nodeId];
  if (!node) return reject("unknown_node", `Unknown node '${command.nodeId}'.`, "nodeId");
  const definitionNode = state.definition.nodes.find((item) => item.id === command.nodeId)!;

  switch (command.type) {
    case "start-node": {
      const kind = definitionNode.kind ?? "task";
      if (kind === "gate") return reject("gate_start_not_allowed", "Evaluate a gate instead of starting it.");
      if (kind === "check") return reject("check_start_required", "Start a check with the check execution command.");
      if (kind === "code") return reject("code_start_required", "Start a code node with the code execution command.");
      if (kind === "effect") return reject("effect_request_required", "Start an effect node with the effect request command.");
      if (kind === "interaction") return reject("interaction_request_required", "Request an interaction with the interaction request command.");
      if (node.status !== "ready") return reject("node_not_ready", `Node '${command.nodeId}' is not ready.`);
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, { type: "hypagraph.attempt.started", nodeId: command.nodeId, attemptId: command.attemptId, data: { ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }), ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }) } });
      break;
    }
    case "request-interaction": {
      if ((definitionNode.kind ?? "task") !== "interaction" || !definitionNode.interaction) return reject("node_not_interaction", `Node '${command.nodeId}' is not an interaction.`);
      if (node.status !== "ready") return reject("node_not_ready", `Node '${command.nodeId}' is not ready.`);
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      let deadline: InteractionDeadline | undefined;
      let timeoutPolicy: { onTimeout: "block" | "select"; selectResponseId?: string } | undefined;
      if (definitionNode.interaction.timeout) {
        const resolved = resolveInteractionDeadline(definitionNode.interaction.timeout, command.at);
        if (!resolved.ok) return reject(resolved.code, resolved.message, "timeout");
        deadline = resolved.deadline;
        timeoutPolicy = {
          onTimeout: definitionNode.interaction.timeout.onTimeout,
          ...(definitionNode.interaction.timeout.selectResponseId === undefined
            ? {}
            : { selectResponseId: definitionNode.interaction.timeout.selectResponseId }),
        };
      }
      next = append(next, events, command, {
        type: "hypagraph.interaction.requested",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          question: definitionNode.interaction.question,
          presentation: structuredClone(definitionNode.interaction.presentation),
          responseIds: (definitionNode.interaction.responses ?? []).map((response) => response.id),
          ...(deadline === undefined ? {} : { deadline: structuredClone(deadline) }),
          ...(timeoutPolicy === undefined ? {} : { timeoutPolicy: structuredClone(timeoutPolicy) }),
          ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }),
          ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }),
        },
      });
      break;
    }
    case "present-interaction": {
      if ((definitionNode.kind ?? "task") !== "interaction" || !definitionNode.interaction) return reject("node_not_interaction", `Node '${command.nodeId}' is not an interaction.`);
      if (node.status !== "awaiting_response" || node.currentAttemptId !== command.attemptId) {
        return reject("interaction_not_awaiting", `Interaction '${command.nodeId}' is not awaiting a response for this attempt.`);
      }
      const existing = node.attempts[command.attemptId]?.presentation;
      if (existing) return reject("interaction_already_presented", `Interaction '${command.nodeId}' already has a presentation observation for this attempt.`);
      const result = command.result;
      if (!result || typeof result !== "object") return reject("interaction_presentation_result_required", "A presentation result is required.", "result");
      if (result.status !== "succeeded" && result.status !== "failed" && result.status !== "timed_out" && result.status !== "cancelled" && result.status !== "error") {
        return reject("invalid_interaction_presentation_status", `Presentation status '${String(result.status)}' is not valid.`, "result.status");
      }
      if (result.kind !== "none" && result.kind !== "report" && result.kind !== "command") {
        return reject("invalid_interaction_presentation_kind", `Presentation kind '${String(result.kind)}' is not valid.`, "result.kind");
      }
      const declaredKind = definitionNode.interaction.presentation.kind;
      if (result.kind !== declaredKind) {
        return reject(
          "interaction_presentation_kind_mismatch",
          `Presentation kind '${result.kind}' does not match the declared kind '${declaredKind}'.`,
          "result.kind",
        );
      }
      if (!result.presentedAt?.trim()) return reject("interaction_presentation_time_required", "A presentation timestamp is required.", "result.presentedAt");
      if (result.status === "succeeded" && declaredKind === "report" && !result.artifactRef?.trim()) {
        return reject(
          "interaction_presentation_artifact_required",
          `A successful report presentation requires an artifact reference.`,
          "result.artifactRef",
        );
      }
      next = append(next, events, command, {
        type: "hypagraph.interaction.presented",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          status: result.status,
          kind: result.kind,
          presentedAt: result.presentedAt,
          ...(result.artifactRef === undefined ? {} : { artifactRef: result.artifactRef }),
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.evidence === undefined ? {} : { evidence: structuredClone(result.evidence) }),
        },
      });
      break;
    }
    case "answer-interaction": {
      if ((definitionNode.kind ?? "task") !== "interaction" || !definitionNode.interaction) return reject("node_not_interaction", `Node '${command.nodeId}' is not an interaction.`);
      if (node.status !== "awaiting_response" || node.currentAttemptId !== command.attemptId) {
        return reject("interaction_not_awaiting", `Interaction '${command.nodeId}' is not awaiting a response for this attempt.`);
      }
      // A failed presentation ends the wait through node status (projection sets failed).
      // Report and command presentations require a successful observation before answer.
      // Kind "none" may skip the observation for Slice 1 compatibility.
      const presentationKind = definitionNode.interaction.presentation.kind;
      const presentation = node.attempts[command.attemptId]?.presentation;
      if (presentationKind !== "none" && presentation?.status !== "succeeded") {
        return reject(
          "interaction_presentation_observation_required",
          `Interaction '${command.nodeId}' requires a successful presentation observation before an answer.`,
        );
      }
      const open = definitionNode.interaction.openAnswer;
      const freeTextDef = definitionNode.interaction.freeText;
      const feedbackDef = definitionNode.interaction.feedback;
      // Attempt evidence holds the durable free-text body. Fact evidence stays short.
      const attemptEvidence = structuredClone(command.evidence ?? []);
      const factEvidence = structuredClone(command.evidence ?? []);
      let published: FactInput[];
      let answeredData: Record<string, unknown>;
      let freeTextBody: string | undefined;
      let freeTextArtifactRef: string | undefined;
      let freeBytes = 0;

      if (command.freeText !== undefined || command.freeTextArtifact !== undefined) {
        if (open) {
          return reject(
            "interaction_free_text_open_question",
            `Interaction '${command.nodeId}' is an open question. Use openText for the answer.`,
            "freeText",
          );
        }
        if (!freeTextDef) {
          return reject(
            "interaction_free_text_not_declared",
            `Interaction '${command.nodeId}' does not declare freeText notes.`,
            "freeText",
          );
        }
        if (command.freeText === undefined || command.freeText.trim().length === 0) {
          return reject(
            "interaction_free_text_required",
            `Interaction free-text notes require the full bounded text on the answer command.`,
            "freeText",
          );
        }
        freeTextBody = command.freeText;
        freeBytes = Buffer.byteLength(freeTextBody, "utf8");
        if (freeBytes > freeTextDef.maxBytes) {
          return reject(
            "interaction_free_text_too_large",
            `The free-text notes exceed the maximum of ${freeTextDef.maxBytes} bytes.`,
            "freeText",
          );
        }
        if (command.freeTextArtifact !== undefined) {
          if (!command.freeTextArtifact.ref?.trim()) {
            return reject(
              "interaction_free_text_ref_required",
              `A free-text notes artifact requires a stored identity reference.`,
              "freeTextArtifact.ref",
            );
          }
          if (command.freeTextArtifact.byteLength === undefined) {
            return reject(
              "interaction_free_text_byte_length_required",
              `A free-text notes artifact requires byteLength so the declared maxBytes bound can be enforced.`,
              "freeTextArtifact.byteLength",
            );
          }
          if (!Number.isInteger(command.freeTextArtifact.byteLength) || command.freeTextArtifact.byteLength < 0) {
            return reject(
              "invalid_interaction_free_text_byte_length",
              `A free-text notes artifact byteLength must be a non-negative integer.`,
              "freeTextArtifact.byteLength",
            );
          }
          if (command.freeTextArtifact.byteLength !== freeBytes) {
            return reject(
              "interaction_free_text_byte_length_mismatch",
              `A free-text notes artifact byteLength must match the freeText body size of ${freeBytes} bytes.`,
              "freeTextArtifact.byteLength",
            );
          }
          freeTextArtifactRef = command.freeTextArtifact.ref;
        }
        const freeTextRef = freeTextArtifactRef
          ?? `interaction:${command.nodeId}:${command.attemptId}:free-text`;
        // Full notes body on attempt evidence for durable restore.
        attemptEvidence.push({
          ref: freeTextRef,
          kind: freeTextArtifactRef ? "file" : "note",
          summary: freeTextBody,
        });
        // Short summary only on published facts. Do not duplicate the full body.
        const previewLimit = 120;
        const preview = freeTextBody.length <= previewLimit
          ? freeTextBody
          : `${freeTextBody.slice(0, previewLimit)}...`;
        factEvidence.push({
          ref: freeTextRef,
          kind: freeTextArtifactRef ? "file" : "note",
          summary: `Free-text notes (${freeBytes} bytes): ${preview}`,
        });
      }

      let feedbackArtifactRef: string | undefined;
      if (command.feedbackArtifact !== undefined) {
        if (!feedbackDef) {
          return reject(
            "interaction_feedback_not_declared",
            `Interaction '${command.nodeId}' does not declare feedback.`,
            "feedbackArtifact",
          );
        }
        if (!command.feedbackArtifact.ref?.trim()) {
          return reject(
            "interaction_feedback_ref_required",
            `A feedback artifact requires a stored identity reference.`,
            "feedbackArtifact.ref",
          );
        }
        // The host must measure stored bytes and pass byteLength so the reducer
        // can enforce the declared bound without reading the artifact store.
        if (command.feedbackArtifact.byteLength === undefined) {
          return reject(
            "interaction_feedback_byte_length_required",
            `A feedback artifact requires byteLength so the declared maxBytes bound can be enforced.`,
            "feedbackArtifact.byteLength",
          );
        }
        if (!Number.isInteger(command.feedbackArtifact.byteLength) || command.feedbackArtifact.byteLength < 0) {
          return reject(
            "invalid_interaction_feedback_byte_length",
            `A feedback artifact byteLength must be a non-negative integer.`,
            "feedbackArtifact.byteLength",
          );
        }
        if (command.feedbackArtifact.byteLength > feedbackDef.maxBytes) {
          return reject(
            "interaction_feedback_too_large",
            `The feedback artifact exceeds the maximum of ${feedbackDef.maxBytes} bytes.`,
            "feedbackArtifact",
          );
        }
        // When the definition declares mediaType, use it as the authority.
        // An omitted command mediaType defaults to the declared type.
        // A present command mediaType must match exactly.
        if (feedbackDef.mediaType !== undefined) {
          if (
            command.feedbackArtifact.mediaType !== undefined
            && command.feedbackArtifact.mediaType !== feedbackDef.mediaType
          ) {
            return reject(
              "interaction_feedback_media_type_mismatch",
              `Feedback mediaType '${command.feedbackArtifact.mediaType}' does not match the declared mediaType '${feedbackDef.mediaType}'.`,
              "feedbackArtifact.mediaType",
            );
          }
        }
        feedbackArtifactRef = command.feedbackArtifact.ref;
        const feedbackEvidence = {
          ref: feedbackArtifactRef,
          kind: "file" as const,
          summary: `Structured feedback artifact (${command.feedbackArtifact.byteLength} bytes)`,
        };
        attemptEvidence.push(feedbackEvidence);
        factEvidence.push(feedbackEvidence);
      }

      if (open) {
        if (command.responseId !== undefined) return reject("interaction_response_not_allowed", `Interaction '${command.nodeId}' asks an open question and accepts no response option.`, "responseId");
        if (command.openText === undefined || command.openText.trim().length === 0) {
          return reject("interaction_open_text_required", `Interaction '${command.nodeId}' requires a typed answer.`, "openText");
        }
        const bytes = Buffer.byteLength(command.openText, "utf8");
        if (bytes > open.maxBytes) return reject("interaction_open_text_too_large", `The typed answer exceeds the maximum of ${open.maxBytes} bytes.`, "openText");
        published = [{ name: open.fact, type: "string", value: command.openText }];
        attemptEvidence.push({ ref: `interaction:${command.nodeId}:${command.attemptId}:open-answer`, kind: "note", summary: command.openText });
        factEvidence.push({ ref: `interaction:${command.nodeId}:${command.attemptId}:open-answer`, kind: "note", summary: command.openText });
        answeredData = {
          openTextBytes: bytes,
          evidence: structuredClone(attemptEvidence),
          ...(feedbackArtifactRef === undefined ? {} : { feedbackArtifactRef }),
        };
      } else {
        if (command.openText !== undefined) return reject("interaction_open_text_not_allowed", `Interaction '${command.nodeId}' asks a closed question and accepts no typed answer.`, "openText");
        const response = (definitionNode.interaction.responses ?? []).find((item) => item.id === command.responseId);
        if (!response) {
          const known = (definitionNode.interaction.responses ?? []).map((item) => `'${item.id}'`).join(", ");
          return reject("unknown_interaction_response", `Interaction '${command.nodeId}' has no response '${command.responseId}'. It declares ${known}.`, "responseId");
        }
        published = structuredClone(response.publish);
        answeredData = {
          responseId: response.id,
          evidence: structuredClone(attemptEvidence),
          ...(freeTextBody === undefined ? {} : { freeText: freeTextBody, freeTextBytes: freeBytes }),
          ...(freeTextArtifactRef === undefined ? {} : { freeTextArtifactRef }),
          ...(feedbackArtifactRef === undefined ? {} : { feedbackArtifactRef }),
        };
      }

      next = append(next, events, command, {
        type: "hypagraph.interaction.answered",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: answeredData,
      });
      const publishedResult = publishInteractionFacts(
        next,
        events,
        command,
        state,
        command.nodeId,
        command.attemptId,
        published,
        factEvidence,
        open ? "The typed answer was accepted." : `Interaction response '${command.responseId}' was accepted.`,
      );
      if (!publishedResult.ok) return publishedResult;
      next = publishedResult.state;
      break;
    }
    case "expire-interaction": {
      if ((definitionNode.kind ?? "task") !== "interaction" || !definitionNode.interaction) {
        return reject("node_not_interaction", `Node '${command.nodeId}' is not an interaction.`);
      }
      if (node.status !== "awaiting_response" || node.currentAttemptId !== command.attemptId) {
        return reject("interaction_not_awaiting", `Interaction '${command.nodeId}' is not awaiting a response for this attempt.`);
      }
      const attempt = node.attempts[command.attemptId];
      if (!attempt?.deadline || !attempt.timeoutPolicy) {
        return reject(
          "interaction_deadline_missing",
          `Interaction '${command.nodeId}' has no stored deadline for this attempt.`,
        );
      }
      const passed = interactionDeadlinePassed(attempt.deadline.absolute, command.at);
      if (passed === undefined) {
        return reject(
          "invalid_interaction_deadline_evaluation_time",
          `The deadline evaluation time must be a valid ISO-8601 timestamp.`,
          "at",
        );
      }
      if (!passed) {
        return reject(
          "interaction_deadline_not_passed",
          `Interaction '${command.nodeId}' deadline '${attempt.deadline.absolute}' has not passed at '${command.at}'.`,
        );
      }

      const onTimeout = attempt.timeoutPolicy.onTimeout;
      if (onTimeout === "block") {
        const reason = `The interaction deadline '${attempt.deadline.absolute}' passed before an answer.`;
        next = append(next, events, command, {
          type: "hypagraph.interaction.expired",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          data: {
            onTimeout: "block",
            deadline: structuredClone(attempt.deadline),
            reason,
          },
        });
        break;
      }

      // onTimeout select: publish the declared default response facts.
      const selectResponseId = attempt.timeoutPolicy.selectResponseId;
      const response = (definitionNode.interaction.responses ?? []).find((item) => item.id === selectResponseId);
      if (!response) {
        return reject(
          "interaction_timeout_select_unknown",
          `Interaction '${command.nodeId}' timeout selectResponseId '${selectResponseId}' is not a declared response.`,
        );
      }
      const evidence: EvidenceReference[] = [{
        ref: `interaction:${command.nodeId}:${command.attemptId}:timeout-select`,
        kind: "note",
        summary: `Timeout selected response '${response.id}'.`,
      }];
      next = append(next, events, command, {
        type: "hypagraph.interaction.expired",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          onTimeout: "select",
          selectResponseId: response.id,
          deadline: structuredClone(attempt.deadline),
          evidence: structuredClone(evidence),
          reason: `The interaction deadline '${attempt.deadline.absolute}' passed. The default response '${response.id}' was selected.`,
        },
      });
      const publishedResult = publishInteractionFacts(
        next,
        events,
        command,
        state,
        command.nodeId,
        command.attemptId,
        structuredClone(response.publish),
        evidence,
        `Timeout selected interaction response '${response.id}'.`,
      );
      if (!publishedResult.ok) return publishedResult;
      next = publishedResult.state;
      break;
    }
    case "start-check": {
      if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) return reject("node_not_check", `Node '${command.nodeId}' is not a check.`);
      const eligibility = evaluateCheckStart(node, definitionNode.check, command.attemptId, command.at);
      if (!eligibility.ok) return { ok: false, diagnostics: [eligibility.diagnostic] };
      // Independent ready checks may run together. Tasks, code, and effects stay exclusive.
      if (concurrentCheckStartBlocked(state)) {
        return reject("node_already_active", "Another node has an active attempt.");
      }
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
    case "start-code": {
      if ((definitionNode.kind ?? "task") !== "code" || !definitionNode.code) {
        return reject("node_not_code", `Node '${command.nodeId}' is not a code node.`);
      }
      const eligibility = evaluateCodeStart(node, definitionNode.code, command.attemptId, command.at);
      if (!eligibility.ok) return { ok: false, diagnostics: [eligibility.diagnostic] };
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, {
        type: "hypagraph.code.started",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          retry: eligibility.retry,
          ...(eligibility.previousAttemptId ? { previousAttemptId: eligibility.previousAttemptId } : {}),
          ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }),
          ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }),
        },
      });
      break;
    }
    case "record-code-result": {
      if ((definitionNode.kind ?? "task") !== "code" || !definitionNode.code) {
        return reject("node_not_code", `Node '${command.nodeId}' is not a code node.`);
      }
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) {
        return reject("stale_code_attempt", "The code result does not match the current running attempt.");
      }
      const invalidCode = validateCodeResult(command.result, command.attemptId);
      if (invalidCode) return invalidCode;
      next = append(next, events, command, {
        type: "hypagraph.code.result-recorded",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: { result: structuredClone(command.result) },
      });
      break;
    }
    case "request-effect": {
      if ((definitionNode.kind ?? "task") !== "effect" || !definitionNode.effect) {
        return reject("node_not_effect", `Node '${command.nodeId}' is not an effect node.`);
      }
      const eligibility = evaluateEffectStart(node, definitionNode.effect, command.attemptId);
      if (!eligibility.ok) return { ok: false, diagnostics: [eligibility.diagnostic] };
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      if (!command.idempotencyKey.trim()) {
        return reject("effect_idempotency_key_required", "A request-effect command requires an idempotency key.");
      }
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      const requestedObservation: EffectObservation = {
        durableState: "requested",
        idempotencyKey: command.idempotencyKey,
        requestedAt: command.at,
        reconciliationAttempts: 0,
        evidence: [],
      };
      next = append(next, events, command, {
        type: "hypagraph.effect.requested",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          observation: structuredClone(requestedObservation),
          ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }),
          ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }),
        },
      });
      break;
    }
    case "record-effect-observed": {
      if ((definitionNode.kind ?? "task") !== "effect" || !definitionNode.effect) {
        return reject("node_not_effect", `Node '${command.nodeId}' is not an effect node.`);
      }
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) {
        return reject("stale_effect_attempt", "The effect observation does not match the current running attempt.");
      }
      const current = node.attempts[command.attemptId]?.effectObservation;
      if (!current || current.durableState !== "requested") {
        return reject("effect_not_requested", "The effect must be requested before it can be observed.");
      }
      const invalidObservation = validateEffectObservation(
        command.observation,
        command.attemptId,
        current.idempotencyKey,
        new Set(["observed"]),
      );
      if (invalidObservation) return invalidObservation;
      next = append(next, events, command, {
        type: "hypagraph.effect.observed",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: { observation: structuredClone(command.observation) },
      });
      if (command.observation.observedOutcome === "success") {
        const facts = [
          ...(command.observation.externalIdentityFacts ?? []),
          ...((command.observation.effectProgramResult?.facts ?? []).filter(
            (fact) => !(command.observation.externalIdentityFacts ?? []).some((item) => item.name === fact.name),
          )),
        ];
        const published = publishObservationFacts(next, events, command, command.nodeId, command.attemptId, facts);
        if (!published.ok) return published;
        next = published.state;
      } else {
        // Observed external failure is a normal failure. Block dependants only when policy requires.
        next = appendReadyEvents(next, events, command);
        next = appendCompletionIfNeeded(next, events, command);
        next = appendGoalOutcomeIfNeeded(next, events, command);
      }
      break;
    }
    case "record-effect-indeterminate": {
      if ((definitionNode.kind ?? "task") !== "effect" || !definitionNode.effect) {
        return reject("node_not_effect", `Node '${command.nodeId}' is not an effect node.`);
      }
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) {
        return reject("stale_effect_attempt", "The effect observation does not match the current running attempt.");
      }
      const current = node.attempts[command.attemptId]?.effectObservation;
      if (!current || current.durableState !== "requested") {
        return reject("effect_not_requested", "The effect must be requested before it can become indeterminate.");
      }
      const invalidObservation = validateEffectObservation(
        command.observation,
        command.attemptId,
        current.idempotencyKey,
        new Set(["indeterminate"]),
      );
      if (invalidObservation) return invalidObservation;
      const policy = definitionNode.effect.onIndeterminate;
      next = append(next, events, command, {
        type: "hypagraph.effect.indeterminate",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          observation: structuredClone(command.observation),
          policy,
        },
      });
      if (policy === "fail-workflow") {
        next = append(next, events, command, {
          type: "hypagraph.workflow.failed",
          data: {
            reason: "effect_indeterminate",
            nodeId: command.nodeId,
            attemptId: command.attemptId,
          },
        });
        next = appendGoalOutcomeIfNeeded(next, events, command);
      }
      // block-dependants: node is blocked. Dependants stay pending. No silent continue.
      break;
    }
    case "record-effect-reconciled": {
      if ((definitionNode.kind ?? "task") !== "effect" || !definitionNode.effect) {
        return reject("node_not_effect", `Node '${command.nodeId}' is not an effect node.`);
      }
      const attempt = node.attempts[command.attemptId];
      const current = attempt?.effectObservation;
      if (!current || current.durableState !== "indeterminate") {
        return reject(
          "effect_not_indeterminate",
          "Only an indeterminate effect can be reconciled.",
        );
      }
      if (node.status !== "blocked" && node.status !== "failed") {
        return reject(
          "effect_reconcile_not_allowed",
          `The effect node cannot reconcile from '${node.status}'.`,
        );
      }
      const invalidObservation = validateEffectObservation(
        command.observation,
        command.attemptId,
        current.idempotencyKey,
        new Set(command.decision === "undecidable" ? ["indeterminate"] : ["observed"]),
      );
      if (invalidObservation) return invalidObservation;
      if (command.decision === "observed-success" && command.observation.observedOutcome !== "success") {
        return reject("effect_reconcile_outcome_mismatch", "observed-success requires observedOutcome success.");
      }
      if (command.decision === "observed-failure" && command.observation.observedOutcome !== "failure") {
        return reject("effect_reconcile_outcome_mismatch", "observed-failure requires observedOutcome failure.");
      }
      if (command.decision === "undecidable" && command.observation.durableState !== "indeterminate") {
        return reject("effect_reconcile_outcome_mismatch", "undecidable reconciliation must keep indeterminate state.");
      }
      next = append(next, events, command, {
        type: "hypagraph.effect.reconciled",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          decision: command.decision,
          observation: structuredClone(command.observation),
        },
      });
      if (command.decision === "observed-success") {
        const facts = [
          ...(command.observation.externalIdentityFacts ?? []),
          ...((command.observation.effectProgramResult?.facts ?? []).filter(
            (fact) => !(command.observation.externalIdentityFacts ?? []).some((item) => item.name === fact.name),
          )),
        ];
        const published = publishObservationFacts(next, events, command, command.nodeId, command.attemptId, facts);
        if (!published.ok) return published;
        next = published.state;
      } else if (command.decision === "observed-failure") {
        next = appendReadyEvents(next, events, command);
        next = appendCompletionIfNeeded(next, events, command);
        next = appendGoalOutcomeIfNeeded(next, events, command);
      }
      // undecidable: remain blocked and continue to block dependants.
      break;
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
    case "block-node": {
      if (!["pending", "ready", "running", "stale", "failed"].includes(node.status)) {
        return reject("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from '${node.status}'.`);
      }
      if (!command.reason.trim()) return reject("block_reason_required", "A blocked node requires a reason.");
      const blockReason = command.reason.trim();
      // A block ends active work on the node. Close the open attempt first so the
      // durable history stays explicit and automatic revision remains eligible.
      if (node.currentAttemptId) {
        const attempt = node.attempts[node.currentAttemptId];
        if (attempt && (attempt.status === "running" || attempt.status === "submitted" || attempt.status === "verifying")) {
          const loop = loopForNode(state, command.nodeId);
          next = append(next, events, command, {
            type: "hypagraph.attempt.cancelled",
            nodeId: command.nodeId,
            attemptId: node.currentAttemptId,
            ...(loop ? { loopId: loop.id } : {}),
            data: {
              reason: `The node was blocked: ${blockReason}`,
              ...(attempt.iteration === undefined ? {} : { iteration: attempt.iteration }),
            },
          });
        }
      }
      next = append(next, events, command, {
        type: "hypagraph.node.blocked",
        nodeId: command.nodeId,
        data: { reason: blockReason, blockerKind: command.blockerKind ?? "unknown" },
      });
      break;
    }
    case "unblock-node": { if (node.status !== "blocked") return reject("node_not_blocked", `Node '${command.nodeId}' is not blocked.`); next = append(next, events, command, { type: "hypagraph.node.unblocked", nodeId: command.nodeId }); next = appendReadyEvents(next, events, command); break; }
    case "wait-for-child": {
      if ((definitionNode.kind ?? "task") !== "task") {
        return reject(
          "child_goal_parent_not_task",
          `Node '${command.nodeId}' cannot wait for a child goal. Only a task node can create a child goal.`,
          "nodeId",
        );
      }
      // Allow wait from an active attempt, or re-wait while already waiting_for_child
      // on the same attempt (sibling create for multi-child wait set).
      const canWaitForChild = ACTIVE_ATTEMPT_STATUSES.has(node.status)
        || node.status === "waiting_for_child";
      if (!canWaitForChild) {
        return reject(
          "child_goal_parent_not_active",
          `Node '${command.nodeId}' cannot wait for a child from status '${node.status}'. `
          + "The parent task must be in an active attempt state "
          + "or already waiting for a child on the same attempt.",
          "nodeId",
        );
      }
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) {
        return reject(
          "stale_attempt",
          "The wait-for-child command does not match the current attempt.",
          "attemptId",
        );
      }
      if (typeof command.childGoalId !== "string" || !command.childGoalId.trim()) {
        return reject("invalid_child_goal_id", "The child goal ID must be a non-empty string.", "childGoalId");
      }
      if (typeof command.bindingId !== "string" || !command.bindingId.trim()) {
        return reject("invalid_child_binding_id", "The child binding ID must be a non-empty string.", "bindingId");
      }
      next = append(next, events, command, {
        type: "hypagraph.task.waiting-for-child",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          childGoalId: command.childGoalId,
          bindingId: command.bindingId,
        },
      });
      break;
    }
    case "record-child-return": {
      if ((definitionNode.kind ?? "task") !== "task") {
        return reject(
          "child_goal_parent_not_task",
          `Node '${command.nodeId}' cannot record a child return. Only a task node can wait for a child goal.`,
          "nodeId",
        );
      }
      if (node.status !== "waiting_for_child") {
        return reject(
          "child_return_parent_not_waiting",
          `Node '${command.nodeId}' is '${node.status}'. A child return requires waiting_for_child status.`,
          "nodeId",
        );
      }
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) {
        return reject(
          "stale_child_return",
          "The child return does not match the current parent attempt.",
          "attemptId",
        );
      }
      if (typeof command.childGoalId !== "string" || !command.childGoalId.trim()) {
        return reject("invalid_child_goal_id", "The child goal ID must be a non-empty string.", "childGoalId");
      }
      if (typeof command.bindingId !== "string" || !command.bindingId.trim()) {
        return reject("invalid_child_binding_id", "The child binding ID must be a non-empty string.", "bindingId");
      }
      const allowedOutcomes = new Set(["completed", "failed", "cancelled", "budget_limited"]);
      if (!allowedOutcomes.has(command.outcome)) {
        return reject(
          "invalid_child_return_outcome",
          `Unsupported child return outcome '${String(command.outcome)}'.`,
          "outcome",
        );
      }
      const allowedEffects = new Set(["resume", "fail-parent-node", "block-parent-node", "return-for-revision"]);
      if (!allowedEffects.has(command.parentEffect)) {
        return reject(
          "invalid_child_return_parent_effect",
          `Unsupported child return parent effect '${String(command.parentEffect)}'.`,
          "parentEffect",
        );
      }
      if (command.outcome === "completed" && command.parentEffect !== "resume") {
        return reject(
          "invalid_child_return_parent_effect",
          "A completed child return must use parent effect 'resume'.",
          "parentEffect",
        );
      }
      if (command.outcome !== "completed" && command.parentEffect === "resume") {
        return reject(
          "invalid_child_return_parent_effect",
          "A non-completed child return cannot use parent effect 'resume'.",
          "parentEffect",
        );
      }
      if (command.remainWaiting === true) {
        if (command.outcome !== "completed" || command.parentEffect !== "resume") {
          return reject(
            "invalid_child_return_remain_waiting",
            "remainWaiting is valid only for a completed child return with parent effect 'resume'.",
            "remainWaiting",
          );
        }
      }
      if (command.parentEffect === "return-for-revision") {
        const revision = state.goal?.automaticRevision;
        if (!state.goal || !revision || revision.consumedAttempts >= revision.maximumAttempts) {
          return reject(
            "child_return_revision_exhausted",
            "A child return cannot request revision when the parent goal automatic revision "
            + "allowance is exhausted.",
            "parentEffect",
          );
        }
      }

      const reason = command.reason?.trim()
        || (command.outcome === "completed"
          ? "The child goal returned successfully."
          : command.outcome === "budget_limited"
            ? "The child goal stopped because its budget was exhausted."
            : command.outcome === "cancelled"
              ? "The child goal was cancelled."
              : "The child goal failed.");

      if (command.outcome === "completed") {
        const facts = command.facts ?? [];
        if (new Set(facts.map((fact) => fact.name)).size !== facts.length) {
          return reject(
            "duplicate_child_return_fact",
            "A child return must not publish the same fact more than once.",
            "facts",
          );
        }
        for (const input of facts) {
          if (typeof input.name !== "string" || !input.name.trim()) {
            return reject("invalid_child_return_facts", "Each returned fact requires a non-empty name.", "facts");
          }
          if (!isFactValueOfType(input.type, input.value)) {
            return reject(
              "fact_value_invalid",
              `Fact '${input.name}' has an invalid value for type '${input.type}'.`,
              `facts.${input.name}`,
            );
          }
        }
        const attempt = node.attempts[command.attemptId]!;
        for (const input of facts) {
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
          next = append(next, events, command, {
            type: "hypagraph.fact.published",
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            data: { fact: structuredClone(fact) },
          });
        }
        next = append(next, events, command, {
          type: "hypagraph.task.child-returned",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          data: {
            childGoalId: command.childGoalId,
            bindingId: command.bindingId,
            outcome: command.outcome,
            parentEffect: command.parentEffect,
            reason,
            ...(command.remainWaiting === true ? { remainWaiting: true } : {}),
            ...(command.evidence ? { evidence: structuredClone(command.evidence) } : {}),
          },
        });
      } else {
        next = append(next, events, command, {
          type: "hypagraph.task.child-return-failed",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          data: {
            childGoalId: command.childGoalId,
            bindingId: command.bindingId,
            outcome: command.outcome,
            parentEffect: command.parentEffect,
            reason,
            ...(command.evidence ? { evidence: structuredClone(command.evidence) } : {}),
          },
        });
        if (command.parentEffect === "return-for-revision" && next.goal && next.goal.status === "active") {
          const goalId = next.goal.goalId;
          const revisionAllowance = next.goal.automaticRevision;
          if (revisionAllowance.consumedAttempts < revisionAllowance.maximumAttempts) {
            // Capture selection identity after the parent node effect and before revision events.
            const selectedRevision = next.revision;
            const selectedSequence = next.sequence;
            const selectedSnapshotHash = next.snapshotHash;
            const ordinal = next.goal.continuationOrdinal + 1;
            const blocker: GoalBlockerIdentity = {
              kind: "blocked-node",
              id: command.nodeId,
              reason,
              sourceRevision: selectedRevision,
              sourceSequence: selectedSequence,
              sourceSnapshotHash: selectedSnapshotHash,
            };
            next = append(next, events, command, {
              type: "hypagraph.goal.blocked",
              data: { goalId, reason },
            });
            next = append(next, events, command, {
              type: "hypagraph.goal.revision-requested",
              data: {
                goalId,
                operationId: command.commandId,
                blocker: structuredClone(blocker),
                sourceRevision: blocker.sourceRevision,
                sourceSequence: blocker.sourceSequence,
                sourceSnapshotHash: blocker.sourceSnapshotHash,
                sessionGeneration: 0,
                branchGeneration: 0,
              },
            });
            next = append(next, events, command, {
              type: "hypagraph.goal.continuation-requested",
              data: {
                goalId,
                operationId: command.commandId,
                ordinal,
                action: { kind: "request-revision", blocker: structuredClone(blocker) },
                selectedRevision,
                selectedSequence,
                selectedSnapshotHash,
                sessionGeneration: 0,
                branchGeneration: 0,
              },
            });
          }
        }
      }
      break;
    }
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
  next = appendGoalOutcomeIfNeeded(next, events, command);
  return { ok: true, state: next, events };
}

export const reduceHypagraph = handleCommand;
export { replayEvents };
export function assertValid(result: ReducerResult): HypagraphState { if (result.ok) return result.state; throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n")); }
