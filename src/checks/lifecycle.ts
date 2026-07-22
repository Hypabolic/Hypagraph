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
import { createCheckExecutionRequest, executeCheck } from "./execution.js";
import { createCheckFactPublicationCommand } from "./normalization.js";

export type CheckLifecycleStage =
  | "start"
  | "publish"
  | "record"
  | "begin-verification"
  | "complete-verification";

export interface AutomaticCheckLifecycleInput {
  state: HypagraphState;
  executor: CheckExecutor;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal: AbortSignal;
  now?: () => Date;
}

export type AutomaticCheckLifecycleResult =
  | {
      ok: true;
      state: HypagraphState;
      events: DomainEvent[];
      commands: HypagraphCommand[];
      result: CheckResult;
    }
  | {
      ok: false;
      stage: CheckLifecycleStage;
      state: HypagraphState;
      events: DomainEvent[];
      commands: HypagraphCommand[];
      diagnostics: Diagnostic[];
      result?: CheckResult;
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

const failureReason = (result: CheckResult): string => {
  if (result.error?.trim()) return result.error.trim();
  switch (result.status) {
    case "failed": return result.exitCode === undefined ? "The check failed." : `The check failed with exit code ${result.exitCode}.`;
    case "timed_out": return "The check timed out.";
    case "cancelled": return "The check was cancelled.";
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

export async function runAutomaticCheckLifecycle(
  input: AutomaticCheckLifecycleInput,
): Promise<AutomaticCheckLifecycleResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const commands: HypagraphCommand[] = [];
  const correlationId = commandId(state, input.nodeId, input.attemptId, "check-lifecycle");

  const apply = (stage: CheckLifecycleStage, command: HypagraphCommand): AutomaticCheckLifecycleResult | undefined => {
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
      };
    }
    state = reduced.state;
    events.push(...reduced.events);
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
  const startFailure = apply("start", startCommand);
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

  const publication = createCheckFactPublicationCommand(request, result, result.completedAt);
  if (publication.ok && publication.command.type === "publish-facts" && publication.command.facts.length > 0) {
    const publicationCommand: HypagraphCommand = {
      ...publication.command,
      correlationId,
    };
    const publicationFailure = apply("publish", publicationCommand);
    if (publicationFailure) return { ...publicationFailure, result };
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
  const recordFailure = apply("record", recordCommand);
  if (recordFailure) return { ...recordFailure, result };

  const beginCommand: HypagraphCommand = {
    type: "begin-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    commandId: commandId(state, input.nodeId, input.attemptId, "begin-check-verification", result),
    correlationId,
    at: result.completedAt,
  };
  const beginFailure = apply("begin-verification", beginCommand);
  if (beginFailure) return { ...beginFailure, result };

  const normalizationReason = publication.ok
    ? undefined
    : `Check result normalization failed: ${publication.diagnostics.map((item) => item.message).join(" ")}`;
  const requiredFactsReason = requiredFacts.length === 0
    ? undefined
    : `The check did not publish required facts: ${requiredFacts.join(", ")}.`;
  const passed = result.status === "passed" && publication.ok && requiredFacts.length === 0;
  const completeCommand: HypagraphCommand = {
    type: "complete-verification",
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    passed,
    ...(!passed ? { reason: normalizationReason ?? requiredFactsReason ?? failureReason(result) } : {}),
    commandId: commandId(state, input.nodeId, input.attemptId, "complete-check-verification", {
      result,
      normalized: publication.ok,
      requiredFacts,
    }),
    correlationId,
    at: result.completedAt,
  };
  const completeFailure = apply("complete-verification", completeCommand);
  if (completeFailure) return { ...completeFailure, result };

  return { ok: true, state, events, commands, result };
}
