import type {
  DomainEvent,
  EffectObservation,
  HypagraphCommand,
  HypagraphState,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { applyCommandsAndCommit } from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";

export interface EffectRecoveryInput {
  state: HypagraphState;
  store: WorkflowEventStore;
  at: string;
  onCommit?: (state: HypagraphState, events: DomainEvent[]) => void;
}

export interface EffectRecoveryResult {
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
  recovery: "effect",
});

/**
 * Promote durable requested effects that never received an observation to indeterminate.
 * Call this on restore before the controller selects new work.
 * Do not cancel these attempts with cancel-attempt. That would drop external knowledge.
 */
export async function recoverInterruptedEffects(input: EffectRecoveryInput): Promise<EffectRecoveryResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const recoveredAttemptIds: string[] = [];

  for (const definitionNode of [...state.definition.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if ((definitionNode.kind ?? "task") !== "effect" || !definitionNode.effect) continue;
    const runtime = state.runtime.nodes[definitionNode.id];
    if (!runtime) continue;

    // Prefer the current attempt when it is still open with requested knowledge.
    const candidates: Array<{ attemptId: string; observation: EffectObservation }> = [];
    if (runtime.currentAttemptId) {
      const attempt = runtime.attempts[runtime.currentAttemptId];
      const observation = attempt?.effectObservation;
      if (
        attempt
        && observation
        && observation.durableState === "requested"
        && ["starting", "running"].includes(runtime.status)
      ) {
        candidates.push({ attemptId: attempt.attemptId, observation });
      }
    }
    // Also scan all attempts for requested knowledge left without a terminal record.
    for (const attempt of Object.values(runtime.attempts)) {
      const observation = attempt.effectObservation;
      if (!observation || observation.durableState !== "requested") continue;
      if (candidates.some((item) => item.attemptId === attempt.attemptId)) continue;
      if (attempt.status === "running" || attempt.status === "submitted") {
        candidates.push({ attemptId: attempt.attemptId, observation });
      }
    }

    for (const candidate of candidates.sort((left, right) => left.attemptId.localeCompare(right.attemptId))) {
      // Recovery requires a running attempt so record-effect-indeterminate can apply.
      const runtimeNow = state.runtime.nodes[definitionNode.id];
      if (!runtimeNow) continue;
      if (runtimeNow.status !== "running" || runtimeNow.currentAttemptId !== candidate.attemptId) {
        // If the node is not running, requested knowledge on a closed attempt cannot be
        // recovered through the normal command. Leave it for manual investigation.
        continue;
      }

      const observation: EffectObservation = {
        ...structuredClone(candidate.observation),
        durableState: "indeterminate",
        executionStatus: "interrupted",
        error: candidate.observation.error?.trim()
          || "The host stopped before it stored an effect observation. The effect is indeterminate.",
      };
      const correlationId = recoveryCommandId(state, definitionNode.id, candidate.attemptId, "recover-effect");
      const command: HypagraphCommand = {
        type: "record-effect-indeterminate",
        nodeId: definitionNode.id,
        attemptId: candidate.attemptId,
        observation,
        commandId: recoveryCommandId(state, definitionNode.id, candidate.attemptId, "record-interrupted-effect", observation),
        correlationId,
        at: input.at,
      };
      const committed = await applyCommandsAndCommit(input.store, state, [command]);
      if (!committed.ok) {
        const message = committed.diagnostics.map((item) => item.message).join(" ");
        throw new Error(`Hypagraph could not recover effect attempt '${candidate.attemptId}': ${message}`);
      }
      state = committed.value.state;
      events.push(...committed.value.events);
      recoveredAttemptIds.push(candidate.attemptId);
      try {
        input.onCommit?.(structuredClone(state), structuredClone(committed.value.events));
      } catch {
        // A view observer cannot change recovery or canonical state.
      }
    }
  }

  return { state, events, recoveredAttemptIds };
}
