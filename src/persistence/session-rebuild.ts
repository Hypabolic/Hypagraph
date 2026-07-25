import { validateActionDispatchRuntime } from "../domain/action-dispatch.js";
import {
  HYPAGRAPH_SCHEMA_VERSION,
  type HypagraphState,
  type PersistedHypagraph,
} from "../domain/model.js";
import * as base from "./session-rebuild-base.js";

export const isHypagraphState = base.isHypagraphState;
export const isPersistedEventBatch = base.isPersistedEventBatch;
export const validateRestoredLoopState = base.validateRestoredLoopState;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? value as Record<string, unknown> : undefined;

const storedSchemaVersion = (entry: unknown): number | undefined => {
  const candidate = record(entry);
  if (!candidate) return undefined;

  if (candidate.type === "custom") {
    const data = record(candidate.data);
    const snapshot = record(data?.snapshot);
    return typeof snapshot?.schemaVersion === "number" ? snapshot.schemaVersion : undefined;
  }

  if (candidate.type !== "message") return undefined;
  const message = record(candidate.message);
  if (message?.role !== "toolResult" || typeof message.toolName !== "string" || !message.toolName.startsWith("hypagraph_")) {
    return undefined;
  }
  const details = record(message.details);
  const stored = record(details?.hypagraph);
  const snapshot = record(stored?.snapshot);
  if (typeof snapshot?.schemaVersion === "number") return snapshot.schemaVersion;
  return typeof stored?.schemaVersion === "number" ? stored.schemaVersion : undefined;
};

const SUPPORTED_STORED_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, HYPAGRAPH_SCHEMA_VERSION]);

const rejectUnsupportedSchemas = (entries: readonly unknown[]): void => {
  for (const entry of entries) {
    const version = storedSchemaVersion(entry);
    if (version !== undefined && !SUPPORTED_STORED_SCHEMA_VERSIONS.has(version)) {
      throw new Error(
        `Unsupported Hypagraph schema version '${version}'. Expected schema version ${HYPAGRAPH_SCHEMA_VERSION}. `
        + "Discard development snapshots from unsupported schemas and start a new session.",
      );
    }
  }
};

export function validateRestoredGoalState(state: HypagraphState): void {
  base.validateRestoredGoalState(state);
  const goal = state.goal;
  if (!goal) return;
  if (!goal.actionDispatch) throw new Error(`Restored goal '${goal.goalId}' has no action-dispatch runtime.`);
  validateActionDispatchRuntime(goal.actionDispatch);
  if (goal.schedulerOrdinal !== goal.actionDispatch.schedulerOrdinal) {
    throw new Error(`Restored goal '${goal.goalId}' has a scheduler ordinal which does not match its action-dispatch runtime.`);
  }
  const pendingContinuation = goal.pendingContinuation;
  const pendingDispatch = goal.actionDispatch.pending;
  if (pendingContinuation) {
    if (!pendingDispatch || pendingDispatch.lane !== "model" || pendingDispatch.status !== "dispatched") {
      throw new Error(`Restored goal '${goal.goalId}' has a continuation without a dispatched model action.`);
    }
    if (pendingContinuation.operationId !== pendingDispatch.dispatchId || pendingContinuation.ordinal !== pendingDispatch.schedulerOrdinal) {
      throw new Error(`Restored goal '${goal.goalId}' has mismatched continuation and action-dispatch identity.`);
    }
  }
}

export function restoreLatestSession(entries: readonly unknown[]): PersistedHypagraph | undefined {
  rejectUnsupportedSchemas(entries);
  const restored = base.restoreLatestSession(entries);
  if (!restored) return undefined;
  validateRestoredLoopState(restored.snapshot);
  validateRestoredGoalState(restored.snapshot);
  return restored;
}

export function restoreLatestSnapshot(entries: readonly unknown[]): HypagraphState | undefined {
  return restoreLatestSession(entries)?.snapshot;
}
