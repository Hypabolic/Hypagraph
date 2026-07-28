import type {
  CodeResult,
  Diagnostic,
  DomainEvent,
  EffectExecutor,
  EffectObservation,
  EffectReconciliationDecision,
  FactInput,
  HypagraphCommand,
  HypagraphState,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { handleCommand } from "../domain/reducer.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import { WorkflowBranchChangedError, WorkflowSequenceConflictError } from "../persistence/event-store.js";
import { createEffectExecutionRequest, executeEffect } from "./execution.js";
import { indeterminateEffectAttempts } from "../domain/effect-policy.js";
import { effectIdempotencyKey } from "../domain/effect-idempotency.js";

export type EffectLifecycleStage =
  | "request"
  | "observe"
  | "indeterminate"
  | "reconcile"
  | "begin-verification"
  | "complete-verification";

export interface EffectLifecycleTransition {
  stage: EffectLifecycleStage;
  state: HypagraphState;
  events: DomainEvent[];
  command: HypagraphCommand;
}

export interface DurableEffectLifecycleInput {
  state: HypagraphState;
  executor: EffectExecutor;
  store: WorkflowEventStore;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal: AbortSignal;
  now?: () => Date;
  onCommit?: (transition: EffectLifecycleTransition) => void;
  /**
   * When true, treat a successful sandbox run without external observation as lost.
   * Tests use this to force indeterminate after the request is stored.
   */
  forceLostResult?: boolean;
}

export type DurableEffectLifecycleResult =
  | {
    ok: true;
    state: HypagraphState;
    events: DomainEvent[];
    commands: HypagraphCommand[];
    observation: EffectObservation;
  }
  | {
    ok: false;
    stage: EffectLifecycleStage;
    state: HypagraphState;
    events: DomainEvent[];
    commands: HypagraphCommand[];
    diagnostics: Diagnostic[];
    observation?: EffectObservation;
  };

const commandId = (
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  action: string,
  data?: unknown,
): string => sha256({
  workflowId: state.workflowId,
  revision: state.revision,
  nodeId,
  attemptId,
  action,
  data: data ?? null,
});

const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : error instanceof WorkflowBranchChangedError
    ? { code: "event_store_branch_changed", message: error.message }
    : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };

const extractExternalIdentityFacts = (
  result: CodeResult,
  contracts: ReadonlyArray<{ name: string; type: FactInput["type"] }>,
): FactInput[] => {
  const facts: FactInput[] = [];
  for (const contract of contracts) {
    const fromResult = result.facts.find((item) => item.name === contract.name);
    if (fromResult) {
      facts.push(structuredClone(fromResult));
      continue;
    }
    if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
      const value = (result.value as Record<string, unknown>)[contract.name];
      if (value !== undefined) {
        facts.push({
          name: contract.name,
          type: contract.type,
          value: value as FactInput["value"],
          evidence: structuredClone(result.evidence),
        });
      }
    }
  }
  return facts;
};

/**
 * Derive the external outcome from host observation, not from sandbox status alone.
 * Sandbox `passed` only means the program finished. External success needs an explicit signal.
 */
export function externalOutcomeFromResult(result: CodeResult): "success" | "failure" | "unknown" {
  const value = result.value && typeof result.value === "object" && !Array.isArray(result.value)
    ? result.value as Record<string, unknown>
    : undefined;
  if (value) {
    if (
      value["effect.ok"] === false
      || value.externalOutcome === "failure"
      || value.decision === "observed-failure"
      || value.decision === "never-reached"
      || value.status === "failed"
    ) {
      return "failure";
    }
    if (
      value["effect.ok"] === true
      || value.externalOutcome === "success"
      || value.decision === "observed-success"
      || value.decision === "found"
      || value.status === "ok"
    ) {
      return "success";
    }
  }
  const okFact = result.facts.find((fact) => fact.name === "effect.ok" || fact.name.endsWith(".ok"));
  if (okFact?.value === false) return "failure";
  if (okFact?.value === true) return "success";
  return "unknown";
}

/** Statuses where the host cannot prove the external outcome after the request was stored. */
const LOST_KNOWLEDGE_STATUSES = new Set(["interrupted", "cancelled", "error", "timed_out"]);

const missingRequiredFacts = (state: HypagraphState, nodeId: string, attemptId: string): string[] => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  if (!definition) return [];
  return (definition.produces ?? [])
    .filter((contract) => contract.required)
    .filter((contract) => {
      const fact = state.runtime.facts[contract.name];
      return !fact
        || fact.producerNodeId !== nodeId
        || fact.attemptId !== attemptId
        || fact.revision !== state.revision;
    })
    .map((contract) => contract.name);
};

/**
 * Durable effect lifecycle: store requested, run external effect, store observed or indeterminate.
 * Never starts the external call before the request event is stored.
 */
export async function runDurableEffectLifecycle(
  input: DurableEffectLifecycleInput,
): Promise<DurableEffectLifecycleResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];
  const correlationId = commandId(state, input.nodeId, input.attemptId, "effect-lifecycle");
  const now = input.now ?? (() => new Date());

  const commitOne = async (
    stage: EffectLifecycleStage,
    command: HypagraphCommand,
    observation?: EffectObservation,
  ): Promise<DurableEffectLifecycleResult | undefined> => {
    const reduced = handleCommand(state, command);
    commands.push(structuredClone(command));
    if (!reduced.ok) {
      return {
        ok: false,
        stage,
        state,
        events,
        commands,
        diagnostics: reduced.diagnostics,
        ...(observation ? { observation } : {}),
      };
    }
    try {
      await input.store.append({
        workflowId: state.workflowId,
        expectedSequence: state.sequence,
        events: reduced.events,
        snapshot: reduced.state,
      });
    } catch (error) {
      return {
        ok: false,
        stage,
        state,
        events,
        commands,
        diagnostics: [storeDiagnostic(error)],
        ...(observation ? { observation } : {}),
      };
    }
    state = reduced.state;
    events.push(...reduced.events);
    try {
      input.onCommit?.({
        stage,
        state: structuredClone(state),
        events: structuredClone(reduced.events),
        command: structuredClone(command),
      });
    } catch {
      // A view observer cannot change persistence or canonical state.
    }
    return undefined;
  };

  const idempotencyKey = effectIdempotencyKey({
    workflowId: state.workflowId,
    revision: state.revision,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
  });

  const requestCommand: HypagraphCommand = {
    type: "request-effect",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    idempotencyKey,
    commandId: commandId(state, input.nodeId, input.attemptId, "request-effect"),
    correlationId,
    at: input.requestedAt,
  };
  const requestFailure = await commitOne("request", requestCommand);
  if (requestFailure) return requestFailure;

  // Request is durable. Only now may the external call start.
  const effectRequest = createEffectExecutionRequest(
    state,
    input.nodeId,
    input.attemptId,
    input.requestedAt,
    "effect",
  );

  let result: CodeResult;
  try {
    result = await executeEffect(input.executor, effectRequest, input.signal);
  } catch (error) {
    result = {
      attemptId: input.attemptId,
      startedAt: input.requestedAt,
      completedAt: now().toISOString(),
      status: input.signal.aborted ? "cancelled" : "interrupted",
      facts: [],
      evidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const definition = state.definition.nodes.find((item) => item.id === input.nodeId)?.effect;
  const externalFacts = definition
    ? extractExternalIdentityFacts(result, definition.externalIdentity)
    : [];
  const externalOutcome = externalOutcomeFromResult(result);

  // After requested is durable, lost knowledge is never observed failure.
  // cancelled, interrupted, error, and timed_out cannot prove the external outcome.
  // A sandbox pass without an explicit external success/failure signal is also indeterminate.
  const lostKnowledge = input.forceLostResult
    || LOST_KNOWLEDGE_STATUSES.has(result.status)
    || (result.status === "failed" && externalOutcome === "unknown")
    || (result.status === "passed" && externalOutcome === "unknown");

  if (lostKnowledge) {
    const observation: EffectObservation = {
      durableState: "indeterminate",
      idempotencyKey,
      requestedAt: input.requestedAt,
      executionStatus: result.status,
      reconciliationAttempts: 0,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.bridgeCalls === undefined ? {} : { bridgeCalls: result.bridgeCalls }),
      evidence: structuredClone(result.evidence),
      error: result.error?.trim()
        || (input.forceLostResult
          ? "The external effect result is indeterminate."
          : "The host cannot confirm the external effect outcome. The effect is indeterminate."),
      effectProgramResult: structuredClone(result),
    };
    const indeterminateCommand: HypagraphCommand = {
      type: "record-effect-indeterminate",
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      observation: structuredClone(observation),
      commandId: commandId(state, input.nodeId, input.attemptId, "record-effect-indeterminate", observation),
      correlationId,
      at: result.completedAt,
    };
    const indeterminateFailure = await commitOne("indeterminate", indeterminateCommand, observation);
    if (indeterminateFailure) return indeterminateFailure;
    return { ok: true, state, events, commands, observation };
  }

  // Confirmed external outcome. executionStatus remains the sandbox status.
  const observedOutcome = externalOutcome === "success" ? "success" : "failure";
  const observation: EffectObservation = {
    durableState: "observed",
    idempotencyKey,
    requestedAt: input.requestedAt,
    observedAt: result.completedAt,
    observedOutcome,
    executionStatus: result.status,
    ...(externalFacts.length > 0 ? { externalIdentityFacts: externalFacts } : {}),
    reconciliationAttempts: 0,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.bridgeCalls === undefined ? {} : { bridgeCalls: result.bridgeCalls }),
    evidence: structuredClone(result.evidence),
    ...(observedOutcome === "success" ? {} : { error: result.error?.trim() || "The external effect failed." }),
    effectProgramResult: structuredClone(result),
  };

  const observeCommand: HypagraphCommand = {
    type: "record-effect-observed",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    observation: structuredClone(observation),
    commandId: commandId(state, input.nodeId, input.attemptId, "record-effect-observed", observation),
    correlationId,
    at: result.completedAt,
  };
  const observeFailure = await commitOne("observe", observeCommand, observation);
  if (observeFailure) return observeFailure;

  if (observation.observedOutcome !== "success") {
    return { ok: true, state, events, commands, observation };
  }

  const requiredFacts = missingRequiredFacts(state, input.nodeId, input.attemptId);
  const passed = requiredFacts.length === 0;
  const beginCommand: HypagraphCommand = {
    type: "begin-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "begin-effect-verification", observation),
    correlationId,
    at: result.completedAt,
  };
  const completeCommand: HypagraphCommand = {
    type: "complete-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    passed,
    ...(!passed
      ? { reason: `The effect node did not publish required facts: ${requiredFacts.join(", ")}.` }
      : {}),
    commandId: commandId(state, input.nodeId, input.attemptId, "complete-effect-verification", {
      observation,
      requiredFacts,
    }),
    correlationId,
    at: result.completedAt,
  };

  const beforeVerification = state;
  const begun = handleCommand(beforeVerification, beginCommand);
  commands.push(structuredClone(beginCommand));
  if (!begun.ok) {
    return { ok: false, stage: "begin-verification", state, events, commands, diagnostics: begun.diagnostics, observation };
  }
  const completed = handleCommand(begun.state, completeCommand);
  commands.push(structuredClone(completeCommand));
  if (!completed.ok) {
    return { ok: false, stage: "complete-verification", state, events, commands, diagnostics: completed.diagnostics, observation };
  }
  const verificationEvents = [...begun.events, ...completed.events];
  try {
    await input.store.append({
      workflowId: beforeVerification.workflowId,
      expectedSequence: beforeVerification.sequence,
      events: verificationEvents,
      snapshot: completed.state,
    });
  } catch (error) {
    return {
      ok: false,
      stage: "complete-verification",
      state,
      events,
      commands,
      diagnostics: [storeDiagnostic(error)],
      observation,
    };
  }
  state = completed.state;
  events.push(...verificationEvents);
  try {
    input.onCommit?.({
      stage: "complete-verification",
      state: structuredClone(state),
      events: structuredClone(verificationEvents),
      command: structuredClone(completeCommand),
    });
  } catch {
    // ignore observer errors
  }

  return { ok: true, state, events, commands, observation };
}

export interface DurableEffectReconcileInput {
  state: HypagraphState;
  executor: EffectExecutor;
  store: WorkflowEventStore;
  nodeId: string;
  attemptId: string;
  at: string;
  signal: AbortSignal;
  now?: () => Date;
  onCommit?: (transition: EffectLifecycleTransition) => void;
}

/**
 * Reconcile one indeterminate effect through the declared read-only query program.
 * Must run before the controller selects new work.
 */
export async function runDurableEffectReconcile(
  input: DurableEffectReconcileInput,
): Promise<DurableEffectLifecycleResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];
  const correlationId = commandId(state, input.nodeId, input.attemptId, "effect-reconcile");
  const now = input.now ?? (() => new Date());

  const commitOne = async (
    stage: EffectLifecycleStage,
    command: HypagraphCommand,
    observation?: EffectObservation,
  ): Promise<DurableEffectLifecycleResult | undefined> => {
    const reduced = handleCommand(state, command);
    commands.push(structuredClone(command));
    if (!reduced.ok) {
      return {
        ok: false,
        stage,
        state,
        events,
        commands,
        diagnostics: reduced.diagnostics,
        ...(observation ? { observation } : {}),
      };
    }
    try {
      await input.store.append({
        workflowId: state.workflowId,
        expectedSequence: state.sequence,
        events: reduced.events,
        snapshot: reduced.state,
      });
    } catch (error) {
      return {
        ok: false,
        stage,
        state,
        events,
        commands,
        diagnostics: [storeDiagnostic(error)],
        ...(observation ? { observation } : {}),
      };
    }
    state = reduced.state;
    events.push(...reduced.events);
    try {
      input.onCommit?.({
        stage,
        state: structuredClone(state),
        events: structuredClone(reduced.events),
        command: structuredClone(command),
      });
    } catch {
      // ignore
    }
    return undefined;
  };

  const runtime = state.runtime.nodes[input.nodeId];
  const current = runtime?.attempts[input.attemptId]?.effectObservation
    ?? indeterminateEffectAttempts(runtime ?? { status: "pending", attemptCount: 0, attempts: {}, evidence: [] })[0]?.observation;
  if (!current || current.durableState !== "indeterminate") {
    return {
      ok: false,
      stage: "reconcile",
      state,
      events,
      commands,
      diagnostics: [{
        code: "effect_not_indeterminate",
        message: `Effect node '${input.nodeId}' attempt '${input.attemptId}' is not indeterminate.`,
      }],
    };
  }

  const reconcileRequest = createEffectExecutionRequest(
    state,
    input.nodeId,
    input.attemptId,
    input.at,
    "reconcile",
  );

  let result: CodeResult;
  try {
    result = await executeEffect(input.executor, reconcileRequest, input.signal);
  } catch (error) {
    result = {
      attemptId: input.attemptId,
      startedAt: input.at,
      completedAt: now().toISOString(),
      status: "error",
      facts: [],
      evidence: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const decision = interpretReconcileResult(result);
  const definition = state.definition.nodes.find((item) => item.id === input.nodeId)?.effect;
  const externalFacts = definition
    ? extractExternalIdentityFacts(result, definition.externalIdentity)
    : [];

  let observation: EffectObservation;
  if (decision === "undecidable") {
    observation = {
      ...structuredClone(current),
      durableState: "indeterminate",
      reconciliationAttempts: current.reconciliationAttempts + 1,
      lastReconciliationAt: result.completedAt,
      lastReconciliationDecision: "undecidable",
      reconcileProgramResult: structuredClone(result),
      error: result.error?.trim() || current.error || "Reconciliation could not decide the external effect outcome.",
      evidence: [...current.evidence, ...result.evidence],
    };
  } else if (decision === "observed-success") {
    const identityFacts = externalFacts.length > 0 ? externalFacts : current.externalIdentityFacts;
    observation = {
      ...structuredClone(current),
      durableState: "observed",
      observedAt: result.completedAt,
      observedOutcome: "success",
      ...(identityFacts === undefined ? {} : { externalIdentityFacts: identityFacts }),
      reconciliationAttempts: current.reconciliationAttempts + 1,
      lastReconciliationAt: result.completedAt,
      lastReconciliationDecision: "observed-success",
      reconcileProgramResult: structuredClone(result),
      evidence: [...current.evidence, ...result.evidence],
      ...(result.value !== undefined || current.value !== undefined
        ? { value: result.value ?? current.value }
        : {}),
    };
  } else {
    observation = {
      ...structuredClone(current),
      durableState: "observed",
      observedAt: result.completedAt,
      observedOutcome: "failure",
      reconciliationAttempts: current.reconciliationAttempts + 1,
      lastReconciliationAt: result.completedAt,
      lastReconciliationDecision: "observed-failure",
      reconcileProgramResult: structuredClone(result),
      error: result.error?.trim() || "Reconciliation observed that the external effect did not complete.",
      evidence: [...current.evidence, ...result.evidence],
      ...(result.value !== undefined || current.value !== undefined
        ? { value: result.value ?? current.value }
        : {}),
    };
  }

  const reconcileCommand: HypagraphCommand = {
    type: "record-effect-reconciled",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    decision,
    observation: structuredClone(observation),
    commandId: commandId(state, input.nodeId, input.attemptId, "record-effect-reconciled", {
      decision,
      observation,
    }),
    correlationId,
    at: result.completedAt,
  };
  const reconcileFailure = await commitOne("reconcile", reconcileCommand, observation);
  if (reconcileFailure) return reconcileFailure;

  if (decision !== "observed-success") {
    return { ok: true, state, events, commands, observation };
  }

  const requiredFacts = missingRequiredFacts(state, input.nodeId, input.attemptId);
  const passed = requiredFacts.length === 0;
  const beginCommand: HypagraphCommand = {
    type: "begin-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "begin-effect-reconcile-verification", observation),
    correlationId,
    at: result.completedAt,
  };
  const completeCommand: HypagraphCommand = {
    type: "complete-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    passed,
    ...(!passed
      ? { reason: `The effect node did not publish required facts: ${requiredFacts.join(", ")}.` }
      : {}),
    commandId: commandId(state, input.nodeId, input.attemptId, "complete-effect-reconcile-verification", {
      observation,
      requiredFacts,
    }),
    correlationId,
    at: result.completedAt,
  };

  const beforeVerification = state;
  const begun = handleCommand(beforeVerification, beginCommand);
  commands.push(structuredClone(beginCommand));
  if (!begun.ok) {
    return { ok: false, stage: "begin-verification", state, events, commands, diagnostics: begun.diagnostics, observation };
  }
  const completed = handleCommand(begun.state, completeCommand);
  commands.push(structuredClone(completeCommand));
  if (!completed.ok) {
    return { ok: false, stage: "complete-verification", state, events, commands, diagnostics: completed.diagnostics, observation };
  }
  const verificationEvents = [...begun.events, ...completed.events];
  try {
    await input.store.append({
      workflowId: beforeVerification.workflowId,
      expectedSequence: beforeVerification.sequence,
      events: verificationEvents,
      snapshot: completed.state,
    });
  } catch (error) {
    return {
      ok: false,
      stage: "complete-verification",
      state,
      events,
      commands,
      diagnostics: [storeDiagnostic(error)],
      observation,
    };
  }
  state = completed.state;
  events.push(...verificationEvents);
  try {
    input.onCommit?.({
      stage: "complete-verification",
      state: structuredClone(state),
      events: structuredClone(verificationEvents),
      command: structuredClone(completeCommand),
    });
  } catch {
    // ignore
  }

  return { ok: true, state, events, commands, observation };
}

function interpretReconcileResult(result: CodeResult): EffectReconciliationDecision {
  if (result.status !== "passed") {
    // A failed query is not proof of never-reached. Keep undecidable unless the program decides.
    if (result.value && typeof result.value === "object") {
      const decision = (result.value as { decision?: string }).decision;
      if (decision === "observed-failure" || decision === "never-reached") return "observed-failure";
      if (decision === "observed-success") return "observed-success";
    }
    return "undecidable";
  }
  if (result.value && typeof result.value === "object") {
    const decision = (result.value as { decision?: string }).decision;
    if (decision === "observed-success" || decision === "found") return "observed-success";
    if (decision === "observed-failure" || decision === "never-reached") return "observed-failure";
    if (decision === "undecidable") return "undecidable";
    const found = (result.value as { found?: boolean }).found;
    if (found === true) {
      const outcome = (result.value as { outcome?: string }).outcome;
      if (outcome === "failure") return "observed-failure";
      return "observed-success";
    }
    if (found === false) return "observed-failure";
  }
  return "undecidable";
}
