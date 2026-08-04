/**
 * Seam C: family controller host helpers for multi-pending concurrent dispatch.
 *
 * Pure decision, commit, mark, and settle helpers for the product family path.
 * Extension keeps Pi session I/O and executor start. This module owns selection
 * policy mapping, multi-pending commit shaping, and terminal settle so concurrent
 * wiring does not grow only inside extension.ts.
 */

import { isReadyCheckDecision } from "../domain/deterministic-check-dispatch.js";
import { isReadyCodeDecision } from "../domain/deterministic-code-dispatch.js";
import { isDeterministicEffectDecision } from "../domain/deterministic-effect-dispatch.js";
import { isReadyGateDecision } from "../domain/deterministic-gate-dispatch.js";
import {
  completeFamilyAction,
  failFamilyAction,
  interruptFamilyAction,
  markFamilyActionDispatched,
} from "../domain/family-scheduler.js";
import {
  listPendingDispatches,
  type GoalFamilyEvent,
  type GoalFamilyResult,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import type { GoalDispatchableContinuation } from "../domain/goal-continuation.js";
import type { HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";
import {
  buildFamilyControllerMemberStates,
  commitFamilyProductConcurrentBatch,
  commitFamilyProductSelection,
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
  type FamilyProductConcurrencyPolicy,
  type FamilyProductControllerDecision,
  type FamilyProductDispatchItem,
} from "./family-product-dispatch.js";

export type FamilyPendingSettleOutcome = "completed" | "failed" | "interrupted";

/**
 * Map a host member dispatch outcome to a family pending settle outcome.
 * model-follow-up means the member is still in flight; the caller must not settle yet.
 */
export function familySettleOutcomeFromHostDispatch(
  hostOutcome: "continue" | "stop" | "model-follow-up",
): FamilyPendingSettleOutcome | undefined {
  if (hostOutcome === "continue") return "completed";
  if (hostOutcome === "stop") return "failed";
  return undefined;
}

/**
 * True when the decision is a deterministic host path that can start without a model worker.
 */
export function isDeterministicFamilyMemberDecision(
  decision: GoalDispatchableContinuation,
): boolean {
  return isReadyGateDecision(decision)
    || isReadyCheckDecision(decision)
    || isReadyCodeDecision(decision)
    || isDeterministicEffectDecision(decision)
    || decision.kind === "request-ready-interaction";
}

/**
 * Select the product family controller action with optional concurrency policy.
 */
export function selectFamilyControllerAction(input: {
  liveState: HypagraphState;
  familyRecord: PersistedGoalFamily | undefined;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
}): FamilyProductControllerDecision {
  return selectFamilyProductControllerAction(input);
}

/**
 * Commit concurrent batch items into multi-pending family state.
 * Generates stable dispatch IDs when the caller does not supply them.
 * Fails when commit is idle, id counts mismatch, or goal identities do not match.
 */
export function commitConcurrentFamilyBatchForHost(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  items: FamilyProductDispatchItem[];
  at: string;
  maxBatchSize?: number;
  createDispatchId?: (index: number, item: FamilyProductDispatchItem) => string;
}):
  | {
    ok: true;
    family: GoalFamilyRuntime;
    events: GoalFamilyEvent[];
    items: Array<FamilyProductDispatchItem & { dispatchId: string }>;
  }
  | { ok: false; diagnostics: { code: string; message: string; location?: string }[] } {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_concurrent_batch_empty",
        message: "Concurrent family batch commit requires at least one selected item.",
        location: "items",
      }],
    };
  }

  const createDispatchId = input.createDispatchId
    ?? ((index: number, item: FamilyProductDispatchItem) =>
      `family-concurrent:${item.memberGoalId}:${index}:${input.at}`);

  const dispatchIds = input.items.map((item, index) => createDispatchId(index, item));
  const commitInput: {
    family: GoalFamilyRuntime;
    memberStates: Readonly<Record<string, HypagraphState>>;
    at: string;
    dispatchIds: string[];
    maxBatchSize?: number;
  } = {
    family: input.family,
    memberStates: input.memberStates,
    at: input.at,
    dispatchIds,
  };
  if (input.maxBatchSize !== undefined) commitInput.maxBatchSize = input.maxBatchSize;
  const committed = commitFamilyProductConcurrentBatch(commitInput);
  if (!committed.ok) {
    return { ok: false, diagnostics: committed.diagnostics };
  }

  if (committed.decision.kind === "idle" || committed.committedDispatchIds.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_concurrent_batch_idle",
        message:
          "Concurrent family batch commit returned no selected dispatches. "
          + "The host must not start member work without durable pending identities.",
        location: "commit",
      }],
    };
  }

  if (committed.committedDispatchIds.length !== input.items.length) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_concurrent_dispatch_id_count",
        message:
          `Expected ${input.items.length} committed dispatch ID(s), `
          + `but received ${committed.committedDispatchIds.length}.`,
        location: "committedDispatchIds",
      }],
    };
  }

  // Verify each committed pending matches the requested member goal identity.
  const items: Array<FamilyProductDispatchItem & { dispatchId: string }> = [];
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    const dispatchId = committed.committedDispatchIds[index]!;
    const pending = committed.family.pendingDispatches[dispatchId];
    if (!pending) {
      return {
        ok: false,
        diagnostics: [{
          code: "goal_family_dispatch_missing",
          message:
            `Committed dispatch '${dispatchId}' is missing from family pendingDispatches.`,
          location: `committedDispatchIds[${index}]`,
        }],
      };
    }
    if (pending.selection.goalId !== item.memberGoalId) {
      return {
        ok: false,
        diagnostics: [{
          code: "goal_family_concurrent_goal_mismatch",
          message:
            `Committed dispatch '${dispatchId}' selected member '${pending.selection.goalId}', `
            + `but the host item requested '${item.memberGoalId}'.`,
          location: `items[${index}].memberGoalId`,
        }],
      };
    }
    if (pending.selection.workflowId !== item.memberWorkflowId) {
      return {
        ok: false,
        diagnostics: [{
          code: "goal_family_concurrent_workflow_mismatch",
          message:
            `Committed dispatch '${dispatchId}' selected workflow '${pending.selection.workflowId}', `
            + `but the host item requested '${item.memberWorkflowId}'.`,
          location: `items[${index}].memberWorkflowId`,
        }],
      };
    }
    items.push({ ...item, dispatchId });
  }

  return {
    ok: true,
    family: committed.family,
    events: committed.events,
    items,
  };
}

/**
 * Commit one sequential family selection for host start.
 */
export function commitSequentialFamilySelectionForHost(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchId: string;
}): ReturnType<typeof commitFamilyProductSelection> {
  return commitFamilyProductSelection(input);
}

/**
 * Mark one family pending as dispatched by dispatchId.
 */
export function markFamilyPendingDispatchedForHost(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  memberState?: HypagraphState;
}): GoalFamilyResult {
  return markFamilyActionDispatched(input);
}

/**
 * Settle one family pending by dispatchId.
 * Clears only that pending. Unrelated pendings remain.
 */
export function settleFamilyPendingForHost(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  outcome: FamilyPendingSettleOutcome;
  reason?: string;
}): GoalFamilyResult {
  if (input.outcome === "completed") {
    return completeFamilyAction({
      family: input.family,
      dispatchId: input.dispatchId,
      at: input.at,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }
  if (input.outcome === "failed") {
    return failFamilyAction({
      family: input.family,
      dispatchId: input.dispatchId,
      at: input.at,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }
  return interruptFamilyAction({
    family: input.family,
    dispatchId: input.dispatchId,
    at: input.at,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/**
 * Build member states and resolve concurrency policy for host controller passes.
 */
export function prepareFamilyControllerPass(input: {
  familyRecord: PersistedGoalFamily;
  liveState: HypagraphState;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
}): {
  memberStates: Record<string, HypagraphState>;
  policy: { concurrent: boolean; maxBatchSize: number };
  pendingCount: number;
} {
  const memberStates = buildFamilyControllerMemberStates(input.familyRecord, input.liveState);
  const policy = resolveFamilyProductConcurrencyPolicy(input.concurrencyPolicy);
  return {
    memberStates,
    policy,
    pendingCount: listPendingDispatches(input.familyRecord.familySnapshot).length,
  };
}

export type {
  FamilyProductConcurrencyPolicy,
  FamilyProductControllerDecision,
  FamilyProductDispatchItem,
};
