import type {
  CheckExecutor,
  CheckResult,
  Diagnostic,
  DomainEvent,
  HypagraphCommand,
  HypagraphState,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { handleCommand } from "../domain/reducer.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import { WorkflowBranchChangedError, WorkflowSequenceConflictError } from "../persistence/event-store.js";
import { enforceCancelledResult } from "./cancellation.js";
import { createCheckExecutionRequest, executeCheck } from "./execution.js";
import { createCheckFactPublicationCommand } from "./normalization.js";
import type { AutomaticCheckLifecycleResult, CheckLifecycleStage, CheckLifecycleTransition } from "./lifecycle.js";

export interface DurableCheckLifecycleInput {
  state: HypagraphState;
  executor: CheckExecutor;
  store: WorkflowEventStore;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal: AbortSignal;
  now?: () => Date;
  onCommit?: (transition: CheckLifecycleTransition) => void;
}

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

const failureReason = (result: CheckResult): string => {
  if (result.error?.trim()) return result.error.trim();
  switch (result.status) {
    case "failed": return result.exitCode === undefined ? "The check failed." : `The check failed with exit code ${result.exitCode}.`;
    case "timed_out": return "The check timed out.";
    case "cancelled": return "The check was cancelled.";
    case "interrupted": return "The check was interrupted before the host stored a result.";
    case "error": return "The check executor returned an error.";
    case "passed": return "";
  }
};

const executorErrorResult = (
  checkKind: CheckResult["checkKind"],
  attemptId: string,
  requestedAt: string,
  completedAt: string,
  cancelled: boolean,
  error: unknown,
): CheckResult => ({
  checkKind,
  attemptId,
  startedAt: requestedAt,
  completedAt,
  status: cancelled ? "cancelled" : "error",
  facts: [],
  evidence: [],
  error: error instanceof Error ? error.message : String(error),
});

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

const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : error instanceof WorkflowBranchChangedError
    ? { code: "event_store_branch_changed", message: error.message }
    : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };

export async function runDurableCheckLifecycle(
  input: DurableCheckLifecycleInput,
): Promise<AutomaticCheckLifecycleResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];
  const correlationId = commandId(state, input.nodeId, input.attemptId, "check-lifecycle");

  const commitOne = async (
    stage: CheckLifecycleStage,
    command: HypagraphCommand,
    result?: CheckResult,
  ): Promise<AutomaticCheckLifecycleResult | undefined> => {
    const reduced = handleCommand(state, command);
    commands.push(structuredClone(command));
    if (!reduced.ok) {
      return { ok: false, stage, state, events, commands, diagnostics: reduced.diagnostics, ...(result ? { result } : {}) };
    }
    try {
      await input.store.append({
        workflowId: state.workflowId,
        expectedSequence: state.sequence,
        events: reduced.events,
        snapshot: reduced.state,
      });
    } catch (error) {
      return { ok: false, stage, state, events, commands, diagnostics: [storeDiagnostic(error)], ...(result ? { result } : {}) };
    }
    state = reduced.state;
    events.push(...reduced.events);
    try {
      input.onCommit?.({ stage, state: structuredClone(state), events: structuredClone(reduced.events), command: structuredClone(command) });
    } catch {
      // A view observer cannot change persistence or canonical state.
    }
    return undefined;
  };

  const startCommand: HypagraphCommand = {
    type: "start-check",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "start-check"),
    correlationId,
    at: input.requestedAt,
  };
  const startFailure = await commitOne("start", startCommand);
  if (startFailure) return startFailure;

  const request = createCheckExecutionRequest(state, input.nodeId, input.attemptId, input.requestedAt);
  let result: CheckResult;
  try {
    result = await executeCheck(input.executor, request, input.signal);
  } catch (error) {
    const completedAt = (input.now ?? (() => new Date()))().toISOString();
    result = executorErrorResult(
      request.definition.kind,
      input.attemptId,
      input.requestedAt,
      completedAt,
      input.signal.aborted,
      error,
    );
  }
  if (input.signal.aborted && result.status !== "cancelled") {
    result = enforceCancelledResult(
      request,
      result,
      input.signal,
      (input.now ?? (() => new Date()))().toISOString(),
    );
  }

  const publication = createCheckFactPublicationCommand(request, result, result.completedAt);
  if (publication.ok && publication.command.type === "publish-facts" && publication.command.facts.length > 0) {
    const publicationCommand: HypagraphCommand = { ...publication.command, correlationId };
    const publicationFailure = await commitOne("publish", publicationCommand, result);
    if (publicationFailure) return publicationFailure;
  }

  const requiredFacts = missingRequiredFacts(state, input.nodeId, input.attemptId);
  const recordCommand: HypagraphCommand = {
    type: "record-check-result",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    result: structuredClone(result),
    commandId: commandId(state, input.nodeId, input.attemptId, "record-check-result", result),
    correlationId,
    at: result.completedAt,
  };
  const recordFailure = await commitOne("record", recordCommand, result);
  if (recordFailure) return recordFailure;

  const normalizationReason = publication.ok
    ? undefined
    : `Check result normalization failed: ${publication.diagnostics.map((item) => item.message).join(" ")}`;
  const requiredFactsReason = requiredFacts.length === 0
    ? undefined
    : `The check did not publish required facts: ${requiredFacts.join(", ")}.`;
  const integrityReason = result.evaluation?.integrity?.status === "invalid"
    ? `The evaluator integrity check failed: ${result.evaluation.integrity.diagnosticCodes[0] ?? "integrity_check_failed"}.`
    : undefined;
  const passed = result.status === "passed" && publication.ok && requiredFacts.length === 0 && integrityReason === undefined;
  const beginCommand: HypagraphCommand = {
    type: "begin-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "begin-check-verification", result),
    correlationId,
    at: result.completedAt,
  };
  const completeCommand: HypagraphCommand = {
    type: "complete-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    passed,
    ...(!passed ? { reason: normalizationReason ?? requiredFactsReason ?? integrityReason ?? failureReason(result) } : {}),
    commandId: commandId(state, input.nodeId, input.attemptId, "complete-check-verification", {
      result,
      normalized: publication.ok,
      requiredFacts,
    }),
    correlationId,
    at: result.completedAt,
  };

  const beforeVerification = state;
  const begun = handleCommand(beforeVerification, beginCommand);
  commands.push(structuredClone(beginCommand));
  if (!begun.ok) return { ok: false, stage: "begin-verification", state, events, commands, diagnostics: begun.diagnostics, result };
  const completed = handleCommand(begun.state, completeCommand);
  commands.push(structuredClone(completeCommand));
  if (!completed.ok) return { ok: false, stage: "complete-verification", state, events, commands, diagnostics: completed.diagnostics, result };
  const verificationEvents = [...begun.events, ...completed.events];
  try {
    await input.store.append({
      workflowId: beforeVerification.workflowId,
      expectedSequence: beforeVerification.sequence,
      events: verificationEvents,
      snapshot: completed.state,
    });
  } catch (error) {
    return { ok: false, stage: "complete-verification", state, events, commands, diagnostics: [storeDiagnostic(error)], result };
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
    // A view observer cannot change persistence or canonical state.
  }

  return { ok: true, state, events, commands, result };
}

export interface ParallelCheckBatchItem {
  nodeId: string;
  attemptId: string;
}

export interface ParallelDurableCheckLifecycleInput {
  state: HypagraphState;
  executor: CheckExecutor;
  store: WorkflowEventStore;
  items: readonly ParallelCheckBatchItem[];
  requestedAt: string;
  signal: AbortSignal;
  now?: () => Date;
  onCommit?: (transition: CheckLifecycleTransition) => void;
  /**
   * Called after every check in the batch has started (status running)
   * and before external execution. Used for live graph paint and demo hold.
   */
  onAllStarted?: (state: HypagraphState) => void | Promise<void>;
}

/**
 * Run several independent ready checks with overlapping execution.
 *
 * Order:
 * 1. Commit start-check for every item (sequential; store identity stays linear).
 * 2. Call onAllStarted so the UI can show every path running.
 * 3. Execute external check processes concurrently.
 * 4. Commit results and verification for every item (sequential).
 */
export async function runParallelDurableCheckLifecycle(
  input: ParallelDurableCheckLifecycleInput,
): Promise<AutomaticCheckLifecycleResult> {
  if (input.items.length === 0) {
    return {
      ok: false,
      stage: "start",
      state: input.state,
      events: [],
      commands: [],
      diagnostics: [{ code: "parallel_check_batch_empty", message: "A parallel check batch requires at least one check." }],
    };
  }
  if (input.items.length === 1) {
    const only = input.items[0]!;
    return runDurableCheckLifecycle({
      state: input.state,
      executor: input.executor,
      store: input.store,
      nodeId: only.nodeId,
      attemptId: only.attemptId,
      requestedAt: input.requestedAt,
      signal: input.signal,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.onCommit === undefined ? {} : { onCommit: input.onCommit }),
    });
  }

  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];

  const commitOne = async (
    stage: CheckLifecycleStage,
    command: HypagraphCommand,
    result?: CheckResult,
  ): Promise<AutomaticCheckLifecycleResult | undefined> => {
    const reduced = handleCommand(state, command);
    commands.push(structuredClone(command));
    if (!reduced.ok) {
      return { ok: false, stage, state, events, commands, diagnostics: reduced.diagnostics, ...(result ? { result } : {}) };
    }
    try {
      await input.store.append({
        workflowId: state.workflowId,
        expectedSequence: state.sequence,
        events: reduced.events,
        snapshot: reduced.state,
      });
    } catch (error) {
      return { ok: false, stage, state, events, commands, diagnostics: [storeDiagnostic(error)], ...(result ? { result } : {}) };
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
      // Observer cannot change state.
    }
    return undefined;
  };

  type StartedJob = {
    nodeId: string;
    attemptId: string;
    correlationId: string;
    request: ReturnType<typeof createCheckExecutionRequest>;
  };
  const started: StartedJob[] = [];

  // Phase 1: start every check so independent paths show as running together.
  for (const item of input.items) {
    const correlationId = commandId(state, item.nodeId, item.attemptId, "check-lifecycle");
    const startCommand: HypagraphCommand = {
      type: "start-check",
      nodeId: item.nodeId,
      attemptId: item.attemptId,
      commandId: commandId(state, item.nodeId, item.attemptId, "start-check"),
      correlationId,
      at: input.requestedAt,
    };
    const startFailure = await commitOne("start", startCommand);
    if (startFailure) return startFailure;
    let request: ReturnType<typeof createCheckExecutionRequest>;
    try {
      request = createCheckExecutionRequest(state, item.nodeId, item.attemptId, input.requestedAt);
    } catch (error) {
      return {
        ok: false,
        stage: "start",
        state,
        events,
        commands,
        diagnostics: [{
          code: "parallel_check_request_failed",
          message: error instanceof Error ? error.message : String(error),
          location: item.nodeId,
        }],
      };
    }
    started.push({
      nodeId: item.nodeId,
      attemptId: item.attemptId,
      correlationId,
      request,
    });
  }

  try {
    await input.onAllStarted?.(structuredClone(state));
  } catch {
    // Observer cannot change state.
  }

  // Phase 2: run external processes concurrently.
  const executed = await Promise.all(started.map(async (job) => {
    let result: CheckResult;
    try {
      result = await executeCheck(input.executor, job.request, input.signal);
    } catch (error) {
      const completedAt = (input.now ?? (() => new Date()))().toISOString();
      result = executorErrorResult(
        job.request.definition.kind,
        job.attemptId,
        input.requestedAt,
        completedAt,
        input.signal.aborted,
        error,
      );
    }
    if (input.signal.aborted && result.status !== "cancelled") {
      result = enforceCancelledResult(
        job.request,
        result,
        input.signal,
        (input.now ?? (() => new Date()))().toISOString(),
      );
    }
    return { job, result };
  }));

  // Phase 3: record and verify each result in stable order.
  let lastResult: CheckResult | undefined;
  for (const { job, result } of executed) {
    lastResult = result;
    const publication = createCheckFactPublicationCommand(job.request, result, result.completedAt);
    if (publication.ok && publication.command.type === "publish-facts" && publication.command.facts.length > 0) {
      const publicationCommand: HypagraphCommand = { ...publication.command, correlationId: job.correlationId };
      const publicationFailure = await commitOne("publish", publicationCommand, result);
      if (publicationFailure) return publicationFailure;
    }
    const requiredFacts = missingRequiredFacts(state, job.nodeId, job.attemptId);
    const recordCommand: HypagraphCommand = {
      type: "record-check-result",
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      result: structuredClone(result),
      commandId: commandId(state, job.nodeId, job.attemptId, "record-check-result", result),
      correlationId: job.correlationId,
      at: result.completedAt,
    };
    const recordFailure = await commitOne("record", recordCommand, result);
    if (recordFailure) return recordFailure;

    const normalizationReason = publication.ok
      ? undefined
      : `Check result normalization failed: ${publication.diagnostics.map((item) => item.message).join(" ")}`;
    const requiredFactsReason = requiredFacts.length === 0
      ? undefined
      : `The check did not publish required facts: ${requiredFacts.join(", ")}.`;
    const integrityReason = result.evaluation?.integrity?.status === "invalid"
      ? `The evaluator integrity check failed: ${result.evaluation.integrity.diagnosticCodes[0] ?? "integrity_check_failed"}.`
      : undefined;
    const passed = result.status === "passed" && publication.ok && requiredFacts.length === 0 && integrityReason === undefined;
    const beginCommand: HypagraphCommand = {
      type: "begin-verification",
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      commandId: commandId(state, job.nodeId, job.attemptId, "begin-check-verification", result),
      correlationId: job.correlationId,
      at: result.completedAt,
    };
    const completeCommand: HypagraphCommand = {
      type: "complete-verification",
      nodeId: job.nodeId,
      attemptId: job.attemptId,
      passed,
      ...(!passed ? { reason: normalizationReason ?? requiredFactsReason ?? integrityReason ?? failureReason(result) } : {}),
      commandId: commandId(state, job.nodeId, job.attemptId, "complete-check-verification", {
        result,
        normalized: publication.ok,
        requiredFacts,
      }),
      correlationId: job.correlationId,
      at: result.completedAt,
    };

    const beforeVerification = state;
    const begun = handleCommand(beforeVerification, beginCommand);
    commands.push(structuredClone(beginCommand));
    if (!begun.ok) {
      return { ok: false, stage: "begin-verification", state, events, commands, diagnostics: begun.diagnostics, result };
    }
    const completed = handleCommand(begun.state, completeCommand);
    commands.push(structuredClone(completeCommand));
    if (!completed.ok) {
      return { ok: false, stage: "complete-verification", state, events, commands, diagnostics: completed.diagnostics, result };
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
        result,
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
      // Observer cannot change state.
    }
  }

  return {
    ok: true,
    state,
    events,
    commands,
    result: lastResult!,
  };
}
