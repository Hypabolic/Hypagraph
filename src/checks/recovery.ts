import type { CheckResult, DomainEvent, HypagraphCommand, HypagraphState } from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { applyCommandsAndCommit } from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";

export interface CheckRecoveryInput {
  state: HypagraphState;
  store: WorkflowEventStore;
  at: string;
  onCommit?: (state: HypagraphState, events: DomainEvent[]) => void;
}

export interface CheckRecoveryResult {
  state: HypagraphState;
  events: DomainEvent[];
  recoveredAttemptIds: string[];
}

const recoveryCommandId = (
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
  recovery: 1,
});

const missingRequiredFacts = (state: HypagraphState, nodeId: string, attemptId: string): string[] => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  return (definition?.produces ?? [])
    .filter((contract) => contract.required)
    .filter((contract) => {
      const fact = state.runtime.facts[contract.name];
      const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
      return !fact
        || fact.producerNodeId !== nodeId
        || fact.attemptId !== attemptId
        || fact.revision !== state.revision
        || fact.loopId !== attempt?.loopId
        || fact.iteration !== attempt?.iteration;
    })
    .map((contract) => contract.name);
};

const storedResultFailureReason = (result: CheckResult, missingFacts: readonly string[]): string | undefined => {
  if (result.status === "interrupted") {
    return result.error?.trim() || "The check was interrupted.";
  }
  if (missingFacts.length > 0) return `The check did not publish required facts: ${missingFacts.join(", ")}.`;
  if (result.status === "passed") return undefined;
  if (result.error?.trim()) return result.error.trim();
  if (result.status === "failed") return result.exitCode === undefined
    ? "The check failed."
    : `The check failed with exit code ${result.exitCode}.`;
  if (result.status === "timed_out") return "The check timed out.";
  if (result.status === "cancelled") return "The check was cancelled.";
  return "The check executor returned an error.";
};

export async function recoverInterruptedChecks(input: CheckRecoveryInput): Promise<CheckRecoveryResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const recoveredAttemptIds: string[] = [];

  for (const definitionNode of [...state.definition.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) continue;
    const runtime = state.runtime.nodes[definitionNode.id];
    const attemptId = runtime?.currentAttemptId;
    if (!runtime || !attemptId || !["starting", "running", "awaiting_evidence", "verifying"].includes(runtime.status)) continue;
    const attempt = runtime.attempts[attemptId];
    if (!attempt) continue;

    const correlationId = recoveryCommandId(state, definitionNode.id, attemptId, "recover-check");
    const commands: HypagraphCommand[] = [];
    let result = attempt.checkResult;

    if (runtime.status === "starting" || runtime.status === "running") {
      result = {
        checkKind: definitionNode.check.kind,
        attemptId,
        startedAt: attempt.startedAt,
        completedAt: input.at,
        status: "interrupted",
        facts: [],
        evidence: [],
        error: "The host stopped before it stored a check result. The attempt is interrupted.",
      };
      commands.push({
        type: "record-check-result",
        nodeId: definitionNode.id,
        attemptId,
        result,
        commandId: recoveryCommandId(state, definitionNode.id, attemptId, "record-interrupted-result", result),
        correlationId,
        at: input.at,
      });
    }

    if (!result) continue;
    const missingFacts = missingRequiredFacts(state, definitionNode.id, attemptId);
    const failureReason = storedResultFailureReason(result, missingFacts);
    if (runtime.status !== "verifying") {
      commands.push({
        type: "begin-verification",
        nodeId: definitionNode.id,
        attemptId,
        commandId: recoveryCommandId(state, definitionNode.id, attemptId, "begin-recovery-verification", result),
        correlationId,
        at: input.at,
      });
    }
    commands.push({
      type: "complete-verification",
      nodeId: definitionNode.id,
      attemptId,
      passed: failureReason === undefined,
      ...(failureReason ? { reason: failureReason } : {}),
      commandId: recoveryCommandId(state, definitionNode.id, attemptId, "complete-recovery-verification", {
        result,
        missingFacts,
      }),
      correlationId,
      at: input.at,
    });

    const committed = await applyCommandsAndCommit(input.store, state, commands);
    if (!committed.ok) {
      const message = committed.diagnostics.map((item) => item.message).join(" ");
      throw new Error(`Hypagraph could not recover attempt '${attemptId}': ${message}`);
    }
    state = committed.value.state;
    events.push(...committed.value.events);
    recoveredAttemptIds.push(attemptId);
    try {
      input.onCommit?.(structuredClone(state), structuredClone(committed.value.events));
    } catch {
      // A view observer cannot change recovery or canonical state.
    }
  }

  return { state, events, recoveredAttemptIds };
}

export async function recoverOrphanedLoopAttempts(input: CheckRecoveryInput): Promise<CheckRecoveryResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const recoveredAttemptIds: string[] = [];
  const loopByNode = new Map(state.definition.loops.flatMap((loop) => loop.nodes.map((nodeId) => [nodeId, loop.id] as const)));

  for (const definitionNode of [...state.definition.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if ((definitionNode.kind ?? "task") === "check" || !loopByNode.has(definitionNode.id)) continue;
    const runtime = state.runtime.nodes[definitionNode.id];
    const attemptId = runtime?.currentAttemptId;
    if (!runtime || !attemptId || !["starting", "running", "awaiting_evidence", "verifying"].includes(runtime.status)) continue;
    const command: HypagraphCommand = {
      type: "cancel-attempt",
      nodeId: definitionNode.id,
      attemptId,
      reason: "The host stopped while this loop attempt was active. Revise the loop before it runs again.",
      commandId: recoveryCommandId(state, definitionNode.id, attemptId, "cancel-orphaned-loop-attempt"),
      correlationId: recoveryCommandId(state, definitionNode.id, attemptId, "recover-loop-attempt"),
      at: input.at,
    };
    const committed = await applyCommandsAndCommit(input.store, state, [command]);
    if (!committed.ok) {
      const message = committed.diagnostics.map((item) => item.message).join(" ");
      throw new Error(`Hypagraph could not recover loop attempt '${attemptId}': ${message}`);
    }
    state = committed.value.state;
    events.push(...committed.value.events);
    recoveredAttemptIds.push(attemptId);
    try {
      input.onCommit?.(structuredClone(state), structuredClone(committed.value.events));
    } catch {
      // A view observer cannot change recovery or canonical state.
    }
  }

  return { state, events, recoveredAttemptIds };
}
