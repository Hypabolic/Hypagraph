/**
 * Product-path helpers for family-aware controller selection (Wave F2 / Gate 1.1 / Gate 1.2).
 *
 * Pure selection uses sequential or concurrent family schedulers.
 * Host I/O stays in extension.ts and family-controller-host.ts.
 * Concurrent multi-pending is the default when policy allows (maxBatchSize > 1).
 * Sequential remains when concurrent mode is off or maxBatchSize is 1.
 *
 * Gate 1.2 wires product concurrency policy into domain selection:
 * global limit, per-executor limits, concurrency groups, and partial-failure mode.
 * Occupancy for limits and groups is derived from family pendingDispatches when
 * treatPendingAsOccupancy is true (product default). See docs/concurrency-policy-surface.md.
 */

import {
  DEFAULT_GLOBAL_CONCURRENCY,
  resolveConcurrencyLimits,
  type ResolvedConcurrencyLimits,
} from "../domain/concurrency-limits.js";
import {
  resolveConcurrencyGroupRegistry,
} from "../domain/concurrency-groups.js";
import type { ExecutorKind } from "../domain/executor-contract.js";
import type { FamilyConcurrentCandidateAttributes } from "../domain/family-concurrent-dispatch.js";
import {
  commitFamilyConcurrentBatch,
  commitFamilySelection,
  selectFamilyConcurrentActions,
  selectFamilySchedulerAction,
  type FamilyConcurrentCommitResult,
  type FamilyRunnableCandidate,
  type FamilySchedulerCommitResult,
  type FamilySchedulerDecision,
} from "../domain/family-scheduler.js";
import {
  hasAnyPendingDispatch,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import {
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  type GoalDispatchableContinuation,
} from "../domain/goal-continuation.js";
import {
  isModelWorkerActionKind,
  resolveModelNodeExecutorProfile,
} from "../domain/model-executor-profile.js";
import type { Diagnostic, DomainEvent, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";
import { memberStatesForFamilyProjection } from "../ui/family-product.js";

/**
 * Product partial-failure mode for multi-pending family work.
 * independent-settle: settle only the named dispatch; siblings stay pending.
 * The product path must not auto-fail siblings solely because one member failed.
 */
export type FamilyProductPartialFailureMode = "independent-settle";

/** Default partial-failure mode for the product multi-pending path. */
export const FAMILY_PRODUCT_PARTIAL_FAILURE_MODE: FamilyProductPartialFailureMode =
  "independent-settle";

/**
 * One concurrency group definition on the product policy surface.
 * maxConcurrent 1 means exclusive (mutex) within the group.
 */
export interface FamilyProductConcurrencyGroupDefinition {
  groupId: string;
  maxConcurrent: number;
}

/**
 * Product concurrency policy for multi-member family selection.
 * Limits and groups are enforced on the product selection and commit path.
 */
export interface FamilyProductConcurrencyPolicy {
  /**
   * When true, use concurrent batch selection for multi-member families.
   * Default is true.
   */
  concurrent?: boolean;
  /**
   * Maximum members to select and commit in one batch.
   * Default is 2. When 1, sequential selection is used.
   */
  maxBatchSize?: number;
  /**
   * Maximum concurrent attempts across all executors.
   * Default is DEFAULT_GLOBAL_CONCURRENCY (2).
   */
  globalConcurrency?: number;
  /**
   * Maximum concurrent attempts for each executor kind.
   * When a kind is absent, that kind inherits the resolved global concurrency limit.
   */
  perExecutorKind?: Partial<Record<ExecutorKind, number>>;
  /**
   * Concurrency group definitions for exclusive vs concurrent groups.
   * maxConcurrent 1 means exclusive within the group.
   */
  groups?: FamilyProductConcurrencyGroupDefinition[];
  /**
   * Optional concurrent attributes keyed by member goal id.
   * Supplies executor kind, group membership, and optional lease per member.
   * When executorKind is omitted for a member, the product path derives a
   * best-effort kind from the member continuation and node.executorProfile
   * (same resolveModelNodeExecutorProfile rules as product model routing).
   * Explicit executorKind always wins.
   */
  attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  /**
   * Partial-failure behaviour for multi-pending settle.
   * Only independent-settle is supported. Default is independent-settle.
   */
  partialFailureMode?: FamilyProductPartialFailureMode;
}

/** Continuation kinds that run on the deterministic host path. */
const DETERMINISTIC_CONTINUATION_KINDS = new Set<string>([
  "run-ready-check",
  "run-ready-code",
  "run-ready-effect",
  "evaluate-ready-gate",
  "request-ready-interaction",
  "reconcile-indeterminate-effect",
]);

/**
 * Resolved product concurrency policy with defaults applied.
 * Safe to pass into concurrent selection and commit helpers.
 */
export interface ResolvedFamilyProductConcurrencyPolicy {
  concurrent: boolean;
  maxBatchSize: number;
  globalConcurrency: number;
  perExecutorKind: Partial<Record<ExecutorKind, number>>;
  groups: FamilyProductConcurrencyGroupDefinition[];
  attributesByGoalId: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  partialFailureMode: FamilyProductPartialFailureMode;
  /** Domain-shaped limits object for concurrent selection. */
  concurrencyLimits: ResolvedConcurrencyLimits;
  /** Domain-shaped group registry for concurrent selection. */
  groupRegistry: { groups: FamilyProductConcurrencyGroupDefinition[] };
  /** Empty when policy fields are valid. Non-empty rejects concurrent product selection. */
  policyDiagnostics: Diagnostic[];
}

/**
 * One dispatchable member selection inside a concurrent product batch.
 */
export interface FamilyProductDispatchItem {
  memberGoalId: string;
  memberWorkflowId: string;
  memberState: HypagraphState;
  isLiveRoot: boolean;
  decision: GoalDispatchableContinuation;
  /** Family dispatch id when the host already committed multi-pending. */
  dispatchId?: string;
  selectionReason: string;
}

/**
 * Controller selection for one family or root pass.
 */
export type FamilyProductControllerDecision =
  | {
    kind: "dispatch";
    /** Live root goal id when the selected member is the session root. */
    memberGoalId: string;
    memberWorkflowId: string;
    memberState: HypagraphState;
    /** True when memberState is the live session root workflow. */
    isLiveRoot: boolean;
    decision: GoalDispatchableContinuation;
    family: PersistedGoalFamily;
    selectionReason: string;
    /** Resolved product concurrency policy used for this selection. */
    concurrencyPolicy: ResolvedFamilyProductConcurrencyPolicy;
  }
  | {
    kind: "dispatch-batch";
    items: FamilyProductDispatchItem[];
    family: PersistedGoalFamily;
    selectionReason: string;
    maxBatchSize: number;
    /**
     * Resolved product concurrency policy used for this selection.
     * Host commit must use this same resolved object.
     */
    concurrencyPolicy: ResolvedFamilyProductConcurrencyPolicy;
  }
  | {
    kind: "root-only";
    decision: ReturnType<typeof selectGoalContinuation>;
  }
  | {
    kind: "family-idle";
    reason: string;
    family: PersistedGoalFamily;
  }
  | {
    kind: "family-blocked";
    reason: string;
    family: PersistedGoalFamily;
    dispatchId?: string;
  }
  | {
    kind: "family-incomplete";
    reason: string;
    missingGoalIds: string[];
    mismatchedGoalIds: string[];
    family: PersistedGoalFamily;
  }
  | {
    kind: "family-rejected";
    reason: string;
    family: PersistedGoalFamily;
    diagnostics: { code: string; message: string; location?: string }[];
  };

/**
 * Resolve product concurrency policy with defaults.
 * Concurrent is on when concurrent is not false and maxBatchSize is greater than 1.
 * Global default is DEFAULT_GLOBAL_CONCURRENCY (2). Per-executor kinds inherit global.
 * Invalid limit, batch size, or group fields populate policyDiagnostics (selection rejects them).
 * maxBatchSize less than 1 is invalid (diagnostic), not a silent clamp.
 */
export function resolveFamilyProductConcurrencyPolicy(
  policy?: FamilyProductConcurrencyPolicy,
): ResolvedFamilyProductConcurrencyPolicy {
  const policyDiagnostics: Diagnostic[] = [];

  let maxBatchSize: number;
  if (policy?.maxBatchSize === undefined) {
    maxBatchSize = 2;
  } else if (
    typeof policy.maxBatchSize !== "number"
    || !Number.isSafeInteger(policy.maxBatchSize)
    || policy.maxBatchSize < 1
  ) {
    policyDiagnostics.push({
      code: "family_product_invalid_max_batch_size",
      message: "maxBatchSize must be a positive safe integer when present.",
      location: "concurrencyPolicy.maxBatchSize",
    });
    // Safe shape only. Selection rejects when policyDiagnostics is non-empty.
    maxBatchSize = 1;
  } else {
    maxBatchSize = policy.maxBatchSize;
  }
  const concurrent = policy?.concurrent !== false && maxBatchSize > 1;

  const hasLimitFields = policy !== undefined
    && (policy.globalConcurrency !== undefined || policy.perExecutorKind !== undefined);
  const limitsInput = hasLimitFields
    ? {
      ...(policy!.globalConcurrency !== undefined
        ? { globalConcurrency: policy!.globalConcurrency }
        : {}),
      ...(policy!.perExecutorKind !== undefined
        ? { perExecutorKind: { ...policy!.perExecutorKind } }
        : {}),
    }
    : undefined;
  const limitsResolved = resolveConcurrencyLimits(limitsInput);
  let concurrencyLimits: ResolvedConcurrencyLimits;
  if (limitsResolved.ok) {
    concurrencyLimits = limitsResolved.value;
  } else {
    policyDiagnostics.push(...limitsResolved.diagnostics);
    concurrencyLimits = {
      globalConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
      perExecutorKind: {},
    };
  }

  const groupsInput = policy?.groups !== undefined
    ? { groups: policy.groups.map((group) => ({
      groupId: group.groupId,
      maxConcurrent: group.maxConcurrent,
    })) }
    : undefined;
  const groupsResolved = resolveConcurrencyGroupRegistry(groupsInput);
  let groups: FamilyProductConcurrencyGroupDefinition[];
  let groupRegistry: { groups: FamilyProductConcurrencyGroupDefinition[] };
  if (groupsResolved.ok) {
    groups = groupsResolved.value.definitions.map((definition) => ({
      groupId: definition.groupId,
      maxConcurrent: definition.maxConcurrent,
    }));
    groupRegistry = { groups: groups.map((group) => ({ ...group })) };
  } else {
    policyDiagnostics.push(...groupsResolved.diagnostics);
    groups = [];
    groupRegistry = { groups: [] };
  }

  let partialFailureMode: FamilyProductPartialFailureMode =
    FAMILY_PRODUCT_PARTIAL_FAILURE_MODE;
  if (policy?.partialFailureMode !== undefined) {
    if (policy.partialFailureMode === "independent-settle") {
      partialFailureMode = policy.partialFailureMode;
    } else {
      policyDiagnostics.push({
        code: "family_product_partial_failure_unsupported",
        message:
          "Product partialFailureMode must be 'independent-settle'. "
          + "Other modes are not supported on the product path.",
        location: "concurrencyPolicy.partialFailureMode",
      });
    }
  }

  const attributesByGoalId = policy?.attributesByGoalId !== undefined
    ? policy.attributesByGoalId
    : {};

  return {
    concurrent,
    maxBatchSize,
    globalConcurrency: concurrencyLimits.globalConcurrency,
    perExecutorKind: { ...concurrencyLimits.perExecutorKind },
    groups,
    attributesByGoalId,
    partialFailureMode,
    concurrencyLimits,
    groupRegistry,
    policyDiagnostics,
  };
}

/**
 * Derive a best-effort executor kind from a selected continuation and member state.
 *
 * Priority when attributes omit executorKind:
 * 1. node.executorProfile.kind via resolveModelNodeExecutorProfile for model task kinds;
 * 2. deterministic continuation kinds → deterministic;
 * 3. request-revision (orchestrator follow-up) → current-session;
 * 4. default isolated-pi.
 *
 * Explicit attributesByGoalId.executorKind is applied by
 * enrichProductAttributesWithDerivedExecutorKinds before this helper runs.
 *
 * Residual gaps: host-only route overrides that never appear on the node or
 * attributes still require explicit policy attributes. Invalid node profiles are
 * ignored by domain profile resolution (same as product model routing).
 */
export function deriveExecutorKindFromContinuation(
  decision: { kind: string; nodeId?: string },
  memberState?: HypagraphState,
): ExecutorKind {
  if (DETERMINISTIC_CONTINUATION_KINDS.has(decision.kind)) {
    return "deterministic";
  }
  if (decision.kind === "request-revision") {
    // Revision follow-up runs in the orchestrator session on the product path.
    return "current-session";
  }
  if (isModelWorkerActionKind(decision.kind)) {
    const nodeId = typeof decision.nodeId === "string" && decision.nodeId.trim().length > 0
      ? decision.nodeId.trim()
      : undefined;
    const node = memberState !== undefined && nodeId !== undefined
      ? memberState.definition.nodes.find((entry) => entry.id === nodeId)
      : undefined;
    const resolved = resolveModelNodeExecutorProfile({
      node: node ?? null,
    });
    return resolved.profile.kind;
  }
  return "isolated-pi";
}

/**
 * Merge policy attributes with derived executor kinds from member continuations.
 * Explicit attributesByGoalId.executorKind always wins.
 * Otherwise derives from continuation kind and node.executorProfile on the member.
 */
export function enrichProductAttributesWithDerivedExecutorKinds(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
  policyAttributes: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>,
): Record<string, FamilyConcurrentCandidateAttributes> {
  const goalIds = Object.keys(family.members).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const result: Record<string, FamilyConcurrentCandidateAttributes> = {};
  for (const goalId of goalIds) {
    const explicit = policyAttributes[goalId];
    if (explicit?.executorKind !== undefined) {
      result[goalId] = {
        executorKind: explicit.executorKind,
        ...(explicit.groupIds !== undefined ? { groupIds: [...explicit.groupIds] } : {}),
        ...(explicit.lease !== undefined ? { lease: explicit.lease } : {}),
      };
      continue;
    }
    const memberState = memberStates[goalId];
    const continuation = memberState
      ? selectGoalContinuation(memberState)
      : { kind: "idle" as const };
    const executorKind = deriveExecutorKindFromContinuation(
      continuation,
      memberState,
    );
    result[goalId] = {
      ...(explicit !== undefined
        ? {
          ...(explicit.groupIds !== undefined ? { groupIds: [...explicit.groupIds] } : {}),
          ...(explicit.lease !== undefined ? { lease: explicit.lease } : {}),
        }
        : {}),
      executorKind,
    };
  }
  // Keep explicit attributes for goal ids that are not family members (tests / advance config).
  for (const goalId of Object.keys(policyAttributes).sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  })) {
    if (result[goalId] !== undefined) continue;
    const explicit = policyAttributes[goalId]!;
    result[goalId] = {
      ...(explicit.executorKind !== undefined ? { executorKind: explicit.executorKind } : {}),
      ...(explicit.groupIds !== undefined ? { groupIds: [...explicit.groupIds] } : {}),
      ...(explicit.lease !== undefined ? { lease: explicit.lease } : {}),
    };
  }
  return result;
}

/**
 * Build domain concurrent-selection fields from a resolved product policy.
 * Occupancy is not pre-built: concurrent selection seeds occupancy from
 * family.pendingDispatches when treatPendingAsOccupancy is true.
 * When family and memberStates are supplied, executor kinds are derived for
 * members that omit attributesByGoalId.executorKind.
 */
export function concurrentSelectionFieldsFromProductPolicy(
  policy: ResolvedFamilyProductConcurrencyPolicy,
  options?: {
    family?: GoalFamilyRuntime;
    memberStates?: Readonly<Record<string, HypagraphState>>;
  },
): {
  maxBatchSize: number;
  concurrencyLimits: ResolvedConcurrencyLimits;
  groupRegistry: { groups: FamilyProductConcurrencyGroupDefinition[] };
  attributesByGoalId: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  treatPendingAsOccupancy: true;
} {
  const attributesByGoalId = options?.family !== undefined && options.memberStates !== undefined
    ? enrichProductAttributesWithDerivedExecutorKinds(
      options.family,
      options.memberStates,
      policy.attributesByGoalId,
    )
    : policy.attributesByGoalId;
  return {
    maxBatchSize: policy.maxBatchSize,
    concurrencyLimits: policy.concurrencyLimits,
    groupRegistry: policy.groupRegistry,
    attributesByGoalId,
    treatPendingAsOccupancy: true,
  };
}

/**
 * Lift a family preferred candidate into a GoalDispatchableContinuation for host dispatch.
 * Sequence and snapshot hash come from the member state at selection time.
 */
export function dispatchableFromFamilyCandidate(
  candidate: FamilyRunnableCandidate,
  memberState: HypagraphState,
): GoalDispatchableContinuation | undefined {
  if (memberState.workflowId !== candidate.workflowId) return undefined;
  if (memberState.goal?.goalId !== candidate.goalId) return undefined;
  if (memberState.revision !== candidate.revision) return undefined;
  if (memberState.sequence !== candidate.selectedSequence) return undefined;
  if (memberState.snapshotHash !== candidate.selectedSnapshotHash) return undefined;

  const identity = {
    goalId: candidate.goalId,
    workflowId: candidate.workflowId,
    revision: candidate.revision,
    sequence: candidate.selectedSequence,
    snapshotHash: candidate.selectedSnapshotHash,
    continuationOrdinal: candidate.memberContinuationOrdinal,
  };

  if (candidate.action.kind === "request-revision") {
    // Family preferred enumeration only lifts dispatchable member selections.
    // request-revision is dispatchable; action payload is on the member decision path.
    return undefined;
  }

  return {
    ...identity,
    kind: candidate.action.kind,
    nodeId: candidate.action.nodeId,
    ...(candidate.action.loopId !== undefined ? { loopId: candidate.action.loopId } : {}),
  } as GoalDispatchableContinuation;
}

/**
 * Build member states for controller selection.
 * Prefer live root state when it matches a family member.
 */
export function buildFamilyControllerMemberStates(
  familyRecord: PersistedGoalFamily,
  liveState: HypagraphState | undefined,
): Record<string, HypagraphState> {
  return memberStatesForFamilyProjection(familyRecord, liveState);
}

/**
 * Refresh one selected member's state from the current family record at mark/start.
 *
 * Selection freezes memberState at select time. Mark and start must re-read the
 * family bag so intermediate mutations within a pass cannot pass a stale
 * selection-time hash into markFamilyActionDispatched or host start.
 *
 * isLiveRoot is stable family session-root identity (family.rootGoalId and that
 * member's workflowId). It is not free-slot occupancy. Free slots may briefly
 * hold a non-root member during concurrent isolated start; that must not flip
 * routing for the desk root or for a child.
 *
 * memberState content:
 * - Non-root members always use the family bag snapshot.
 * - The session desk root uses liveState only when free slots currently hold
 *   that same root identity. When free slots are mid-bind for another member,
 *   the root still reports isLiveRoot true and attaches the bag snapshot.
 *
 * Fails with goal_family_dispatch_stale_selection when the member is missing
 * or identity does not match the selection.
 */
export function refreshFamilyProductMemberState(input: {
  familyRecord: PersistedGoalFamily;
  memberGoalId: string;
  memberWorkflowId: string;
  /**
   * Optional free-slot / desk stream. Used only as root content when this
   * member is the family session root and free slots currently hold that root.
   * Free-slot occupancy does not set isLiveRoot.
   */
  liveState?: HypagraphState | undefined;
}):
  | {
    ok: true;
    memberState: HypagraphState;
    /**
     * True when this member is the family session desk root (stable).
     * Not free-slot occupancy. Host start must use this for routing, not a
     * re-derived free-slot identity mid-batch.
     */
    isLiveRoot: boolean;
  }
  | { ok: false; diagnostics: Diagnostic[] } {
  const family = input.familyRecord.familySnapshot;
  const member = family.members[input.memberGoalId];
  if (!member || member.workflowId !== input.memberWorkflowId) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_dispatch_stale_selection",
        message:
          `Member '${input.memberGoalId}' is not present in the family record with `
          + `workflow '${input.memberWorkflowId}' at mark/start time.`,
        location: "memberState",
      }],
    };
  }

  // Always read bag content first. Do not overlay free-slot occupancy onto
  // non-root members (concurrent bind can pollute free slots mid-batch).
  const stored = input.familyRecord.workflows[input.memberWorkflowId]?.snapshot;
  if (!stored) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_dispatch_stale_selection",
        message:
          `Member '${input.memberGoalId}' has no workflow state in the family record `
          + "at mark/start time.",
        location: "memberState",
      }],
    };
  }
  if (
    stored.workflowId !== input.memberWorkflowId
    || stored.goal?.goalId !== input.memberGoalId
  ) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_dispatch_stale_selection",
        message:
          `Refreshed member state for '${input.memberGoalId}' does not match the selected `
          + "goal or workflow.",
        location: "memberState",
      }],
    };
  }

  const rootMember = family.members[family.rootGoalId];
  const isLiveRoot = !!rootMember
    && input.memberGoalId === family.rootGoalId
    && input.memberWorkflowId === rootMember.workflowId;

  const live = input.liveState;
  const liveHoldsThisRoot = isLiveRoot
    && !!live
    && live.goal?.goalId === input.memberGoalId
    && live.workflowId === input.memberWorkflowId;
  // Prefer live desk root only when free slots currently hold that root stream.
  const memberState = liveHoldsThisRoot && live ? live : stored;
  return { ok: true, memberState, isLiveRoot };
}

/**
 * Select the next product controller action.
 *
 * One-member families and missing family records keep the root-only path.
 * Multi-member families use concurrent batch selection when policy allows.
 * Sequential selection remains when concurrent mode is off or maxBatchSize is 1.
 * Concurrent selection enforces product global limits, per-executor limits, and groups.
 */
export function selectFamilyProductControllerAction(input: {
  liveState: HypagraphState;
  familyRecord: PersistedGoalFamily | undefined;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
}): FamilyProductControllerDecision {
  const { liveState, familyRecord } = input;
  if (!familyRecord) {
    return { kind: "root-only", decision: selectGoalContinuation(liveState) };
  }

  const memberCount = Object.keys(familyRecord.familySnapshot.members).length;
  if (memberCount <= 1) {
    return { kind: "root-only", decision: selectGoalContinuation(liveState) };
  }

  // Keep live parent stream authoritative inside the family map.
  const memberStates = buildFamilyControllerMemberStates(familyRecord, liveState);
  const policy = resolveFamilyProductConcurrencyPolicy(input.concurrencyPolicy);

  if (policy.policyDiagnostics.length > 0) {
    return {
      kind: "family-rejected",
      reason:
        "Product concurrency policy is invalid. "
        + policy.policyDiagnostics.map((item) => item.message).join(" "),
      family: familyRecord,
      diagnostics: policy.policyDiagnostics,
    };
  }

  if (!policy.concurrent || policy.maxBatchSize <= 1) {
    const familyDecision = selectFamilySchedulerAction(
      familyRecord.familySnapshot,
      memberStates,
    );
    return mapFamilySchedulerDecision(
      familyDecision,
      familyRecord,
      memberStates,
      liveState,
      policy,
    );
  }

  return mapConcurrentProductDecision(
    familyRecord,
    memberStates,
    liveState,
    policy,
  );
}

function mapConcurrentProductDecision(
  familyRecord: PersistedGoalFamily,
  memberStates: Readonly<Record<string, HypagraphState>>,
  liveState: HypagraphState,
  policy: ResolvedFamilyProductConcurrencyPolicy,
): FamilyProductControllerDecision {
  const selectionFields = concurrentSelectionFieldsFromProductPolicy(policy, {
    family: familyRecord.familySnapshot,
    memberStates,
  });
  const concurrentDecision = selectFamilyConcurrentActions({
    family: familyRecord.familySnapshot,
    memberStates,
    maxBatchSize: selectionFields.maxBatchSize,
    concurrencyLimits: selectionFields.concurrencyLimits,
    groupRegistry: selectionFields.groupRegistry,
    attributesByGoalId: selectionFields.attributesByGoalId,
    treatPendingAsOccupancy: selectionFields.treatPendingAsOccupancy,
  });

  if (concurrentDecision.kind === "incomplete-input") {
    return {
      kind: "family-incomplete",
      reason: concurrentDecision.reason,
      missingGoalIds: concurrentDecision.missingGoalIds,
      mismatchedGoalIds: concurrentDecision.mismatchedGoalIds,
      family: familyRecord,
    };
  }
  if (concurrentDecision.kind === "rejected") {
    return {
      kind: "family-rejected",
      reason: concurrentDecision.reason,
      family: familyRecord,
      diagnostics: concurrentDecision.diagnostics,
    };
  }
  if (concurrentDecision.kind === "idle") {
    // When capacity is full of pendings, surface blocked so the host waits for settle.
    if (hasAnyPendingDispatch(familyRecord.familySnapshot)) {
      return {
        kind: "family-blocked",
        reason:
          concurrentDecision.reason
          + " Existing pending dispatches occupy concurrent capacity.",
        family: familyRecord,
      };
    }
    return {
      kind: "family-idle",
      reason: concurrentDecision.reason,
      family: familyRecord,
    };
  }

  // concurrentDecision.kind === "select-batch"
  const items: FamilyProductDispatchItem[] = [];
  for (const candidate of concurrentDecision.candidates) {
    const memberState = memberStates[candidate.goalId];
    if (!memberState) {
      return {
        kind: "family-incomplete",
        reason: `Selected member '${candidate.goalId}' has no member state.`,
        missingGoalIds: [candidate.goalId],
        mismatchedGoalIds: [],
        family: familyRecord,
      };
    }
    const memberDecision = selectGoalContinuation(memberState);
    if (!isDispatchableGoalContinuation(memberDecision)) {
      return {
        kind: "family-idle",
        reason:
          `Family selected member '${candidate.goalId}' but the member has no dispatchable continuation `
          + `(${memberDecision.kind}).`,
        family: familyRecord,
      };
    }
    const liveGoalId = liveState.goal?.goalId;
    const isLiveRoot = liveGoalId === candidate.goalId
      && liveState.workflowId === candidate.workflowId;
    items.push({
      memberGoalId: candidate.goalId,
      memberWorkflowId: candidate.workflowId,
      memberState: isLiveRoot ? liveState : memberState,
      isLiveRoot,
      decision: memberDecision,
      selectionReason: concurrentDecision.reason,
    });
  }

  if (items.length === 0) {
    return {
      kind: "family-idle",
      reason: concurrentDecision.reason,
      family: familyRecord,
    };
  }

  // Keep concurrent commit mode for length-1 batches. Do not collapse to sequential
  // dispatch; sequential commit blocks while any other pending exists.
  return {
    kind: "dispatch-batch",
    items,
    family: familyRecord,
    selectionReason: concurrentDecision.reason,
    maxBatchSize: policy.maxBatchSize,
    concurrencyPolicy: policy,
  };
}

function mapFamilySchedulerDecision(
  familyDecision: FamilySchedulerDecision,
  familyRecord: PersistedGoalFamily,
  memberStates: Readonly<Record<string, HypagraphState>>,
  liveState: HypagraphState,
  policy: ResolvedFamilyProductConcurrencyPolicy,
): FamilyProductControllerDecision {
  if (familyDecision.kind === "idle") {
    return {
      kind: "family-idle",
      reason: familyDecision.reason,
      family: familyRecord,
    };
  }
  if (familyDecision.kind === "blocked-pending") {
    return {
      kind: "family-blocked",
      reason: familyDecision.reason,
      family: familyRecord,
      dispatchId: familyDecision.dispatchId,
    };
  }
  if (familyDecision.kind === "incomplete-input") {
    return {
      kind: "family-incomplete",
      reason: familyDecision.reason,
      missingGoalIds: familyDecision.missingGoalIds,
      mismatchedGoalIds: familyDecision.mismatchedGoalIds,
      family: familyRecord,
    };
  }

  const candidate = familyDecision.candidate;
  const memberState = memberStates[candidate.goalId];
  if (!memberState) {
    return {
      kind: "family-incomplete",
      reason: `Selected member '${candidate.goalId}' has no member state.`,
      missingGoalIds: [candidate.goalId],
      mismatchedGoalIds: [],
      family: familyRecord,
    };
  }

  // Re-run member select so revision actions and full identity match host dispatch helpers.
  const memberDecision = selectGoalContinuation(memberState);
  if (!isDispatchableGoalContinuation(memberDecision)) {
    return {
      kind: "family-idle",
      reason:
        `Family selected member '${candidate.goalId}' but the member has no dispatchable continuation `
        + `(${memberDecision.kind}).`,
      family: familyRecord,
    };
  }

  const liveGoalId = liveState.goal?.goalId;
  const isLiveRoot = liveGoalId === candidate.goalId
    && liveState.workflowId === candidate.workflowId;

  return {
    kind: "dispatch",
    memberGoalId: candidate.goalId,
    memberWorkflowId: candidate.workflowId,
    memberState: isLiveRoot ? liveState : memberState,
    isLiveRoot,
    decision: memberDecision,
    family: familyRecord,
    selectionReason: familyDecision.reason,
    concurrencyPolicy: policy,
  };
}

/**
 * Commit a concurrent product batch into multi-pending family state.
 * Pure domain call. Host persists the returned family snapshot and events.
 * Prefer resolvedConcurrencyPolicy from the selection decision so select and
 * commit use the same resolved object. Raw concurrencyPolicy is resolved only
 * when resolvedConcurrencyPolicy is absent.
 */
export function commitFamilyProductConcurrentBatch(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchIds: string[];
  maxBatchSize?: number;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
  resolvedConcurrencyPolicy?: ResolvedFamilyProductConcurrencyPolicy;
}): FamilyConcurrentCommitResult {
  let policy: ResolvedFamilyProductConcurrencyPolicy;
  if (input.resolvedConcurrencyPolicy !== undefined) {
    policy = input.resolvedConcurrencyPolicy;
  } else {
    policy = resolveFamilyProductConcurrencyPolicy({
      ...(input.concurrencyPolicy ?? {}),
      ...(input.maxBatchSize !== undefined ? { maxBatchSize: input.maxBatchSize } : {}),
    });
  }
  if (policy.policyDiagnostics.length > 0) {
    return { ok: false, diagnostics: policy.policyDiagnostics };
  }
  const selectionFields = concurrentSelectionFieldsFromProductPolicy(policy, {
    family: input.family,
    memberStates: input.memberStates,
  });
  const batchInput: Parameters<typeof commitFamilyConcurrentBatch>[0] = {
    family: input.family,
    memberStates: input.memberStates,
    at: input.at,
    dispatchIds: input.dispatchIds,
    maxBatchSize: selectionFields.maxBatchSize,
    concurrencyLimits: selectionFields.concurrencyLimits,
    groupRegistry: selectionFields.groupRegistry,
    attributesByGoalId: selectionFields.attributesByGoalId,
    treatPendingAsOccupancy: selectionFields.treatPendingAsOccupancy,
  };
  return commitFamilyConcurrentBatch(batchInput);
}

/**
 * Commit one sequential product selection into family pending state.
 */
export function commitFamilyProductSelection(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchId: string;
}): FamilySchedulerCommitResult {
  return commitFamilySelection(input);
}

/**
 * Replace one member workflow stream inside a persisted family record.
 * Does not mutate the input family. Caller appends the result to the session.
 */
export function replaceFamilyMemberWorkflow(
  family: PersistedGoalFamily,
  workflowId: string,
  next: { events: DomainEvent[]; snapshot: HypagraphState },
): PersistedGoalFamily {
  return {
    schemaVersion: family.schemaVersion,
    familyEvents: structuredClone(family.familyEvents),
    familySnapshot: structuredClone(family.familySnapshot),
    workflows: {
      ...structuredClone(family.workflows),
      [workflowId]: {
        events: structuredClone(next.events),
        snapshot: structuredClone(next.snapshot),
      },
    },
  };
}

/**
 * Merge the current live root events and snapshot into the family record.
 * Used before child workflow replace so sibling root progress is not overwritten (R5).
 * Does not mutate the input family.
 */
export function mergeLiveRootIntoFamily(
  family: PersistedGoalFamily,
  liveRoot: { workflowId: string; events: DomainEvent[]; snapshot: HypagraphState },
): PersistedGoalFamily {
  return {
    schemaVersion: family.schemaVersion,
    familyEvents: structuredClone(family.familyEvents),
    familySnapshot: structuredClone(family.familySnapshot),
    workflows: {
      ...structuredClone(family.workflows),
      [liveRoot.workflowId]: {
        events: structuredClone(liveRoot.events),
        snapshot: structuredClone(liveRoot.snapshot),
      },
    },
  };
}

/**
 * True when the family runtime has more than one member.
 */
export function familyHasMultipleMembers(family: GoalFamilyRuntime): boolean {
  return Object.keys(family.members).length > 1;
}
