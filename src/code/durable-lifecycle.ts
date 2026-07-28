import type {
  CodeExecutor,
  CodeResult,
  Diagnostic,
  DomainEvent,
  HypagraphCommand,
  HypagraphState,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { handleCommand } from "../domain/reducer.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import { WorkflowBranchChangedError, WorkflowSequenceConflictError } from "../persistence/event-store.js";
import { createCodeExecutionRequest, executeCode } from "./execution.js";
import { createCodeFactPublicationCommand } from "./normalization.js";
import { captureScopeBaseline, verifyCodeScope } from "./scope-verification.js";
import { codeNodeHasWorkspaceMutation } from "../domain/code-authoring.js";

export type CodeLifecycleStage =
  | "start"
  | "publish"
  | "record"
  | "begin-verification"
  | "complete-verification";

export interface CodeLifecycleTransition {
  stage: CodeLifecycleStage;
  state: HypagraphState;
  events: DomainEvent[];
  command: HypagraphCommand;
}

export interface DurableCodeLifecycleInput {
  state: HypagraphState;
  executor: CodeExecutor;
  store: WorkflowEventStore;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal: AbortSignal;
  rootDirectory?: string;
  now?: () => Date;
  onCommit?: (transition: CodeLifecycleTransition) => void;
}

export type DurableCodeLifecycleResult =
  | {
    ok: true;
    state: HypagraphState;
    events: DomainEvent[];
    commands: HypagraphCommand[];
    result: CodeResult;
  }
  | {
    ok: false;
    stage: CodeLifecycleStage;
    state: HypagraphState;
    events: DomainEvent[];
    commands: HypagraphCommand[];
    diagnostics: Diagnostic[];
    result?: CodeResult;
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

const failureReason = (result: CodeResult): string => {
  if (result.error?.trim()) return result.error.trim();
  switch (result.status) {
    case "failed": return "The code program failed.";
    case "timed_out": return "The code program timed out.";
    case "cancelled": return "The code program was cancelled.";
    case "interrupted": return "The code program was interrupted before the host stored a result.";
    case "error": return "The code executor returned an error.";
    case "passed": return "";
  }
};

const executorErrorResult = (
  attemptId: string,
  requestedAt: string,
  completedAt: string,
  cancelled: boolean,
  error: unknown,
): CodeResult => ({
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

/**
 * Durable code lifecycle: store start, run, store result, publish facts, verify.
 * Replay reads the recorded result and never runs the program again.
 */
export async function runDurableCodeLifecycle(
  input: DurableCodeLifecycleInput,
): Promise<DurableCodeLifecycleResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];
  const correlationId = commandId(state, input.nodeId, input.attemptId, "code-lifecycle");

  const commitOne = async (
    stage: CodeLifecycleStage,
    command: HypagraphCommand,
    result?: CodeResult,
  ): Promise<DurableCodeLifecycleResult | undefined> => {
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
      // A view observer cannot change persistence or canonical state.
    }
    return undefined;
  };

  const startCommand: HypagraphCommand = {
    type: "start-code",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "start-code"),
    correlationId,
    at: input.requestedAt,
  };
  const startFailure = await commitOne("start", startCommand);
  if (startFailure) return startFailure;

  const request = createCodeExecutionRequest(state, input.nodeId, input.attemptId, input.requestedAt);
  const mutating = codeNodeHasWorkspaceMutation(request.definition.execution.capabilities);
  let baseline: Awaited<ReturnType<typeof captureScopeBaseline>> | undefined;
  let result: CodeResult | undefined;

  if (mutating && !input.rootDirectory) {
    result = {
      attemptId: input.attemptId,
      startedAt: input.requestedAt,
      completedAt: (input.now ?? (() => new Date()))().toISOString(),
      status: "failed",
      facts: [],
      evidence: [],
      error: "A mutating code program requires a workspace root for scope verification.",
      scopeVerification: {
        passed: false,
        error: "A mutating code program requires a workspace root for scope verification.",
      },
    };
  } else if (mutating && input.rootDirectory) {
    try {
      baseline = await captureScopeBaseline(input.rootDirectory, input.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        attemptId: input.attemptId,
        startedAt: input.requestedAt,
        completedAt: (input.now ?? (() => new Date()))().toISOString(),
        status: "error",
        facts: [],
        evidence: [],
        error: `Scope baseline capture failed: ${message}`,
        scopeVerification: { passed: false, error: message },
      };
    }
  }

  if (!result) {
    try {
      result = await executeCode(input.executor, request, input.signal);
    } catch (error) {
      const completedAt = (input.now ?? (() => new Date()))().toISOString();
      result = executorErrorResult(
        input.attemptId,
        input.requestedAt,
        completedAt,
        input.signal.aborted,
        error,
      );
    }

    if (input.signal.aborted && result.status !== "cancelled") {
      result = {
        ...result,
        status: "cancelled",
        completedAt: (input.now ?? (() => new Date()))().toISOString(),
        error: result.error ?? "The code execution was cancelled.",
      };
    }

    // Always verify mutating programs when a workspace root is available.
    // A failed, timed-out, or cancelled program may still have written outside scope.
    if (mutating && input.rootDirectory) {
      const scope = await verifyCodeScope({
        rootDirectory: input.rootDirectory,
        scopePaths: request.scopePaths ?? [],
        capabilities: request.definition.execution.capabilities,
        ...(baseline === undefined ? {} : { baseline }),
        signal: input.signal,
      });
      result = { ...result, scopeVerification: scope };
      if (!scope.passed && result.status === "passed") {
        result = {
          ...result,
          status: "failed",
          facts: [],
          error: scope.error ?? "Scope verification failed for the mutating code program.",
        };
      }
    }
  }

  const publication = createCodeFactPublicationCommand(request, result, result.completedAt);
  if (publication.ok && publication.command.type === "publish-facts" && publication.command.facts.length > 0) {
    const publicationCommand: HypagraphCommand = { ...publication.command, correlationId };
    const publicationFailure = await commitOne("publish", publicationCommand, result);
    if (publicationFailure) return publicationFailure;
  }

  const requiredFacts = missingRequiredFacts(state, input.nodeId, input.attemptId);
  const recordCommand: HypagraphCommand = {
    type: "record-code-result",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    result: structuredClone(result),
    commandId: commandId(state, input.nodeId, input.attemptId, "record-code-result", result),
    correlationId,
    at: result.completedAt,
  };
  const recordFailure = await commitOne("record", recordCommand, result);
  if (recordFailure) return recordFailure;

  const normalizationReason = publication.ok
    ? undefined
    : `Code result normalization failed: ${publication.diagnostics.map((item) => item.message).join(" ")}`;
  const requiredFactsReason = requiredFacts.length === 0
    ? undefined
    : `The code node did not publish required facts: ${requiredFacts.join(", ")}.`;
  const scopeReason = result.scopeVerification && !result.scopeVerification.passed
    ? result.scopeVerification.error ?? "Scope verification failed."
    : undefined;
  const passed = result.status === "passed"
    && publication.ok
    && requiredFacts.length === 0
    && scopeReason === undefined;

  const beginCommand: HypagraphCommand = {
    type: "begin-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "begin-code-verification", result),
    correlationId,
    at: result.completedAt,
  };
  const completeCommand: HypagraphCommand = {
    type: "complete-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    passed,
    ...(!passed
      ? { reason: normalizationReason ?? requiredFactsReason ?? scopeReason ?? failureReason(result) }
      : {}),
    commandId: commandId(state, input.nodeId, input.attemptId, "complete-code-verification", {
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
    // A view observer cannot change persistence or canonical state.
  }

  return { ok: true, state, events, commands, result };
}
