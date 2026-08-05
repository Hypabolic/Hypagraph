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
import type { Diagnostic, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";
import {
  FAMILY_PRODUCT_PARTIAL_FAILURE_MODE,
  buildFamilyControllerMemberStates,
  commitFamilyProductConcurrentBatch,
  commitFamilyProductSelection,
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
  type FamilyProductConcurrencyPolicy,
  type FamilyProductControllerDecision,
  type FamilyProductDispatchItem,
  type FamilyProductPartialFailureMode,
  type ResolvedFamilyProductConcurrencyPolicy,
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
 * Prefer resolvedConcurrencyPolicy from the selection decision so select and
 * commit share one resolved policy object.
 */
export function commitConcurrentFamilyBatchForHost(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  items: FamilyProductDispatchItem[];
  at: string;
  maxBatchSize?: number;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
  /**
   * Resolved policy from selection. When present, commit uses this object and
   * does not re-resolve raw concurrencyPolicy.
   */
  resolvedConcurrencyPolicy?: ResolvedFamilyProductConcurrencyPolicy;
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
    concurrencyPolicy?: FamilyProductConcurrencyPolicy;
    resolvedConcurrencyPolicy?: ResolvedFamilyProductConcurrencyPolicy;
  } = {
    family: input.family,
    memberStates: input.memberStates,
    at: input.at,
    dispatchIds,
  };
  if (input.maxBatchSize !== undefined) commitInput.maxBatchSize = input.maxBatchSize;
  if (input.concurrencyPolicy !== undefined) {
    commitInput.concurrencyPolicy = input.concurrencyPolicy;
  }
  if (input.resolvedConcurrencyPolicy !== undefined) {
    commitInput.resolvedConcurrencyPolicy = input.resolvedConcurrencyPolicy;
  }
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
 * Product partial-failure mode is independent-settle: one of N may fail or
 * interrupt without auto-failing sibling pendings.
 */
export function settleFamilyPendingForHost(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  outcome: FamilyPendingSettleOutcome;
  reason?: string;
  /**
   * Partial-failure mode. Only independent-settle is supported.
   * Default is independent-settle.
   */
  partialFailureMode?: FamilyProductPartialFailureMode;
}): GoalFamilyResult {
  const mode = input.partialFailureMode ?? FAMILY_PRODUCT_PARTIAL_FAILURE_MODE;
  if (mode !== "independent-settle") {
    return {
      ok: false,
      diagnostics: [{
        code: "family_product_partial_failure_unsupported",
        message:
          "Product partialFailureMode must be 'independent-settle'. "
          + "Other modes are not supported on the product path.",
        location: "partialFailureMode",
      }],
    };
  }

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

export type InterruptAllFamilyPendingsResult =
  | {
    ok: true;
    family: GoalFamilyRuntime;
    events: GoalFamilyEvent[];
    /** Dispatch ids settled as interrupted, in stable pending order. */
    interruptedDispatchIds: string[];
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Resolve the family record for restore or branch-change work **before**
 * orphan settle updates the host family.
 *
 * Prefer branch-local sources over host memory. On branch change, host memory
 * may still hold the previous branch family. Sweeping that record would write
 * the wrong family onto the current branch session and leave the real branch
 * multi-pending occupancy untouched.
 *
 * Order (first defined wins):
 * 1. familyProjection — restoreOrMigrate result for the current branch
 * 2. branchSessionFamily — restoreLatestFamilySession for the current branch
 * 3. hostLatestFamily — in-memory cache (only as last resort)
 *
 * After orphan settle, do **not** reuse this order with pre-orphan captures.
 * Use resolveFamilyRecordForPostOrphanPendingSweep instead so the host-updated
 * family (member cancel + familyDispatchId settle) is not overwritten.
 */
export function resolveFamilyRecordForPendingSweep<T>(input: {
  familyProjection?: T;
  branchSessionFamily?: T;
  hostLatestFamily?: T;
}): T | undefined {
  return input.familyProjection
    ?? input.branchSessionFamily
    ?? input.hostLatestFamily;
}

/**
 * Resolve the family record for pending sweep **after** orphan settle.
 *
 * Orphan settle may persist a cancelled member workflow and clear one family
 * pending via familyDispatchId. Those updates land on the host latest family.
 * Pre-orphan projection / branch session captures must not win here: sweeping
 * a stale snapshot would rewrite workflows and re-interrupt already-cleared
 * pendings from the wrong base.
 *
 * Order (first defined wins):
 * 1. postOrphanHostFamily — latestFamilyRecord after orphan settle
 * 2. reloadedBranchFamily — fresh restoreLatestFamilySession for the branch
 *
 * Callers must not pass pre-orphan familyProjection or branchSessionFamily
 * captures into this helper.
 */
export function resolveFamilyRecordForPostOrphanPendingSweep<T>(input: {
  postOrphanHostFamily?: T;
  reloadedBranchFamily?: T;
}): T | undefined {
  return input.postOrphanHostFamily
    ?? input.reloadedBranchFamily;
}

/**
 * Interrupt every family pending (selected or dispatched).
 *
 * Used on session restore, branch change, and operator reclaim so stranded
 * pendings do not consume occupancy forever. Settles each pending with
 * independent-settle. Order follows listPendingDispatches (stable).
 * Does not mutate the input family. Schema remains version 3.
 *
 * When dispatchIds is set, only those ids are reclaimed. Missing ids are
 * skipped. When dispatchIds is omitted, every pending is reclaimed.
 *
 * Persist behaviour is all-or-nothing for the host caller: if settle fails
 * mid-loop after one or more pure settles, this helper returns
 * `{ ok: false, diagnostics }` and does not return the partial family.
 * Restore and reclaim only persist on full success, so occupancy stays
 * blocked until a later successful sweep. Domain interrupt of a present
 * pending is reliable; a mid-loop failure is rare.
 */
export function interruptAllFamilyPendingsForHost(input: {
  family: GoalFamilyRuntime;
  at: string;
  reason: string;
  /**
   * Optional subset of dispatch ids to reclaim.
   * When omitted, reclaim every pending.
   */
  dispatchIds?: readonly string[];
}): InterruptAllFamilyPendingsResult {
  const allPendings = listPendingDispatches(input.family);
  const targetIds = input.dispatchIds === undefined
    ? undefined
    : new Set(input.dispatchIds.filter((id) => typeof id === "string" && id.length > 0));
  const pendings = targetIds === undefined
    ? allPendings
    : allPendings.filter((pending) => targetIds.has(pending.dispatchId));

  if (pendings.length === 0) {
    return {
      ok: true,
      family: input.family,
      events: [],
      interruptedDispatchIds: [],
    };
  }

  let family = input.family;
  const events: GoalFamilyEvent[] = [];
  const interruptedDispatchIds: string[] = [];

  for (const pending of pendings) {
    const settled = settleFamilyPendingForHost({
      family,
      dispatchId: pending.dispatchId,
      at: input.at,
      outcome: "interrupted",
      reason: input.reason,
    });
    if (!settled.ok) {
      // All-or-nothing: drop partial family so the host does not persist half a sweep.
      return { ok: false, diagnostics: settled.diagnostics };
    }
    family = settled.family;
    events.push(...settled.events);
    interruptedDispatchIds.push(pending.dispatchId);
  }

  return {
    ok: true,
    family,
    events,
    interruptedDispatchIds,
  };
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
  policy: ResolvedFamilyProductConcurrencyPolicy;
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
  FamilyProductPartialFailureMode,
  ResolvedFamilyProductConcurrencyPolicy,
};
