/**
 * Root-goal isolated model attempt dispatch (Wave 6).
 *
 * Default start-ready-task and continue-active-task actions run through the
 * isolated executor path. They must not send an implement follow-up in the
 * orchestrator session.
 *
 * Domain helpers used here stay pure. Host I/O lives in the caller.
 */

import type {
  ExecutorContextEnvelope,
  ExecutorProfileRef,
  ExecutorResult,
} from "../domain/executor-contract.js";
import {
  isModelWorkerActionKind,
  modelLaneUsesIsolatedWorker,
  resolveModelNodeExecutorProfile,
  shouldSendModelLaneFollowUp,
  type ResolvedModelNodeExecutorProfile,
} from "../domain/model-executor-profile.js";
import type {
  Diagnostic,
  DomainEvent,
  HypagraphCommand,
  HypagraphState,
  NodeDefinition,
} from "../domain/model.js";
import type { GoalDispatchableContinuation } from "../domain/goal-continuation.js";
import type {
  SettleExecutorResultMeta,
  SettleExecutorResultResult,
} from "../domain/executor-settlement.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import { materializeIsolatedPiContext } from "./isolated-pi-executor.js";

// ---------------------------------------------------------------------------
// In-flight root worker bookkeeping (host memory; not domain state)
// ---------------------------------------------------------------------------

export interface ActiveIsolatedRootAttempt {
  operationId: string;
  nodeId: string;
  attemptId: string;
  /**
   * Member goal that owns this worker (root or child).
   * Cancel and restore settle this member stream, not only the live root.
   */
  goalId: string;
  /**
   * Member workflow that owns this worker (root or child).
   * When different from the live root workflow, persist cancel into the family record.
   */
  workflowId: string;
  /**
   * Family pending dispatch id when this attempt belongs to a family pending.
   * Orphan cancel and restore use this id to clear the matching family pending.
   */
  familyDispatchId?: string;
  profile: ExecutorProfileRef;
  actionKind: "start-ready-task" | "continue-active-task";
  sessionGeneration: number;
  branchGeneration: number;
  /** Settlement applied once. Prevents double-settle of the same attempt. */
  settled: boolean;
  /** Host abort controller for cancel, restore, shutdown, and timeout. */
  abortController: AbortController;
  /** Wall-clock start for status elapsed reporting (ISO string). */
  startedAt: string;
  /** Optional hard timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Last committed member state for mid-flight cancel when the family record lags.
   * Host updates this after start-node and each settlement commit during the attempt.
   */
  cancelSnapshot?: HypagraphState;
  /**
   * Full member event stream matching cancelSnapshot.
   * Used with cancelSnapshot to persist a cancelled member into the family record.
   */
  cancelEvents?: DomainEvent[];
}

/** Default hard timeout for a root isolated model attempt (15 minutes). */
export const DEFAULT_ISOLATED_ROOT_TIMEOUT_MS = 15 * 60 * 1000;

export type IsolatedRootRoutingDecision =
  | {
    kind: "isolated-worker";
    action: GoalDispatchableContinuation & {
      kind: "start-ready-task" | "continue-active-task";
    };
    resolved: ResolvedModelNodeExecutorProfile;
  }
  | {
    kind: "current-session-follow-up";
    action: GoalDispatchableContinuation;
    resolved?: ResolvedModelNodeExecutorProfile;
  }
  | {
    kind: "orchestrator-follow-up";
    action: GoalDispatchableContinuation;
  };

/**
 * Decide whether a selected model-lane action uses an isolated worker or an
 * orchestrator follow-up. Pure with respect to host side effects.
 */
export function routeRootModelLaneAction(
  action: GoalDispatchableContinuation,
  state: HypagraphState,
  options: { legacyCurrentSessionDefault?: boolean } = {},
): IsolatedRootRoutingDecision {
  if (!isModelWorkerActionKind(action.kind)) {
    return { kind: "orchestrator-follow-up", action };
  }

  const taskAction = action as GoalDispatchableContinuation & {
    kind: "start-ready-task" | "continue-active-task";
    nodeId: string;
  };
  const node = state.definition.nodes.find((item) => item.id === taskAction.nodeId);
  const resolved = resolveModelNodeExecutorProfile({
    node: node ?? null,
    ...(options.legacyCurrentSessionDefault === undefined
      ? {}
      : { legacyCurrentSessionDefault: options.legacyCurrentSessionDefault }),
  });

  if (shouldSendModelLaneFollowUp({ actionKind: taskAction.kind, profile: resolved.profile })) {
    return {
      kind: "current-session-follow-up",
      action: taskAction,
      resolved,
    };
  }

  if (!modelLaneUsesIsolatedWorker(resolved.profile)) {
    return {
      kind: "current-session-follow-up",
      action: taskAction,
      resolved,
    };
  }

  return {
    kind: "isolated-worker",
    action: taskAction,
    resolved,
  };
}

export interface PrepareIsolatedRootAttemptInput {
  state: HypagraphState;
  family: GoalFamilyRuntime;
  action: GoalDispatchableContinuation & {
    kind: "start-ready-task" | "continue-active-task";
  };
  profile: ExecutorProfileRef;
  /** Fresh attempt id for start-ready-task. Ignored for continue when current exists. */
  attemptId: string;
  operationId: string;
  sessionGeneration: number;
  branchGeneration: number;
  rootObjective?: string;
  /** Host wall-clock start for status and timeout bookkeeping. */
  startedAt: string;
  /** Optional hard timeout. Defaults to DEFAULT_ISOLATED_ROOT_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
  /** Optional host abort controller. Created when omitted. */
  abortController?: AbortController;
  /**
   * Family pending dispatch id when this attempt belongs to a family pending.
   * Copied onto the active attempt for orphan settle and restore reclaim.
   */
  familyDispatchId?: string;
}

export type PrepareIsolatedRootAttemptResult =
  | {
    ok: true;
    context: ExecutorContextEnvelope;
    startCommands: HypagraphCommand[];
    active: ActiveIsolatedRootAttempt;
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Build start-node commands (when needed) and materialize the worker context.
 * Does not dispatch or settle. Pure except for using the supplied attempt id.
 */
export function prepareIsolatedRootAttempt(
  input: PrepareIsolatedRootAttemptInput,
): PrepareIsolatedRootAttemptResult {
  const { state, action, profile } = input;
  const node = state.definition.nodes.find((item) => item.id === action.nodeId);
  if (!node) {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_root_unknown_node",
        message: `Unknown node '${action.nodeId}' for isolated model dispatch.`,
        location: "action.nodeId",
      }],
    };
  }
  if ((node.kind ?? "task") !== "task") {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_root_not_task",
        message: `Node '${action.nodeId}' is not a task node.`,
        location: "action.nodeId",
      }],
    };
  }

  const runtime = state.runtime.nodes[action.nodeId];
  if (!runtime) {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_root_runtime_missing",
        message: `Node '${action.nodeId}' has no runtime state.`,
        location: "action.nodeId",
      }],
    };
  }

  const startCommands: HypagraphCommand[] = [];
  let attemptId = input.attemptId;

  if (action.kind === "start-ready-task") {
    if (runtime.status !== "ready") {
      return {
        ok: false,
        diagnostics: [{
          code: "isolated_root_node_not_ready",
          message: `Node '${action.nodeId}' is not ready for start-ready-task.`,
          location: "action.nodeId",
        }],
      };
    }
    startCommands.push({
      type: "start-node",
      nodeId: action.nodeId,
      attemptId,
      commandId: `${input.operationId}:start`,
      correlationId: input.operationId,
      at: "1970-01-01T00:00:00.000Z", // caller must rewrite at before commit
    });
  } else {
    const current = runtime.currentAttemptId;
    if (!current || !["starting", "running", "awaiting_evidence", "verifying"].includes(runtime.status)) {
      return {
        ok: false,
        diagnostics: [{
          code: "isolated_root_no_active_attempt",
          message: `Node '${action.nodeId}' has no active attempt to continue.`,
          location: "action.nodeId",
        }],
      };
    }
    attemptId = current;
  }

  // Materialize against post-start identity. For start, revision/workflow match
  // pre-start; attempt id is known. Caller commits start before dispatch so
  // settlement sees a running attempt.
  const materialized = materializeIsolatedPiContext({
    family: input.family,
    state,
    nodeId: action.nodeId,
    attemptId,
    profile,
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
  if (!materialized.ok) {
    return { ok: false, diagnostics: materialized.diagnostics };
  }

  const goalId = state.goal?.goalId;
  if (!goalId) {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_root_no_goal",
        message: "Isolated model dispatch requires an active Hypagoal on the member workflow.",
        location: "state.goal",
      }],
    };
  }

  return {
    ok: true,
    context: materialized.value,
    startCommands,
    active: {
      operationId: input.operationId,
      nodeId: action.nodeId,
      attemptId,
      goalId,
      workflowId: state.workflowId,
      profile,
      actionKind: action.kind,
      sessionGeneration: input.sessionGeneration,
      branchGeneration: input.branchGeneration,
      settled: false,
      abortController: input.abortController ?? new AbortController(),
      startedAt: input.startedAt,
      timeoutMs: input.timeoutMs ?? DEFAULT_ISOLATED_ROOT_TIMEOUT_MS,
      ...(input.familyDispatchId !== undefined
        ? { familyDispatchId: input.familyDispatchId }
        : {}),
    },
  };
}

/**
 * Rewrite start-node timestamps to the host-supplied wall clock string.
 * Domain reducers require valid timestamps; prepare uses a placeholder.
 */
export function withHostTimestamp(
  commands: readonly HypagraphCommand[],
  at: string,
): HypagraphCommand[] {
  return commands.map((command) => ({ ...command, at }));
}

/**
 * After a successful submitted settlement, build verification commands so the
 * worker result can complete the attempt without an orchestrator turn.
 */
export function buildPostSubmitVerificationCommands(input: {
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  operationId: string;
  at: string;
}): HypagraphCommand[] | undefined {
  const runtime = input.state.runtime.nodes[input.nodeId];
  if (!runtime || runtime.status !== "awaiting_evidence") return undefined;
  if (runtime.currentAttemptId !== input.attemptId) return undefined;
  return [
    {
      type: "begin-verification",
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      commandId: `${input.operationId}:begin-verify`,
      correlationId: input.operationId,
      at: input.at,
    },
    {
      type: "complete-verification",
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      passed: true,
      commandId: `${input.operationId}:complete-verify`,
      correlationId: input.operationId,
      at: input.at,
    },
  ];
}

/**
 * Mark an active attempt settled once. Returns false when already settled
 * (stale double-settle guard).
 */
export function markIsolatedRootAttemptSettled(
  active: ActiveIsolatedRootAttempt | undefined,
  attemptId: string,
): active is ActiveIsolatedRootAttempt {
  if (!active) return false;
  if (active.attemptId !== attemptId) return false;
  if (active.settled) return false;
  active.settled = true;
  return true;
}

/**
 * True when the host generation still matches the in-flight attempt.
 * Restore or branch change invalidates the attempt for apply.
 */
export function isolatedRootAttemptGenerationMatches(
  active: ActiveIsolatedRootAttempt,
  sessionGeneration: number,
  branchGeneration: number,
): boolean {
  return active.sessionGeneration === sessionGeneration
    && active.branchGeneration === branchGeneration;
}

export interface SettleIsolatedRootResultInput {
  active: ActiveIsolatedRootAttempt;
  settlement: SettleExecutorResultResult;
  sessionGeneration: number;
  branchGeneration: number;
}

export type AcceptIsolatedRootSettlementResult =
  | { ok: true; commands: HypagraphCommand[]; result: ExecutorResult; summary: string }
  | { ok: false; reason: string; diagnostics?: Diagnostic[] };

/**
 * Accept settlement commands only when identity and generation still match
 * and the attempt was not already settled.
 */
export function acceptIsolatedRootSettlement(
  input: SettleIsolatedRootResultInput,
): AcceptIsolatedRootSettlementResult {
  if (!isolatedRootAttemptGenerationMatches(
    input.active,
    input.sessionGeneration,
    input.branchGeneration,
  )) {
    return {
      ok: false,
      reason: "The isolated root attempt generation is stale after restore or branch change.",
    };
  }
  if (input.active.settled) {
    return {
      ok: false,
      reason: "The isolated root attempt was already settled.",
      diagnostics: [{
        code: "isolated_root_double_settle",
        message: "A second settlement for the same isolated root attempt was rejected.",
        location: "active.attemptId",
      }],
    };
  }
  if (!input.settlement.ok) {
    return {
      ok: false,
      reason: "Isolated executor settlement was rejected.",
      diagnostics: input.settlement.diagnostics,
    };
  }
  if (input.settlement.result.attemptId !== input.active.attemptId
    || input.settlement.result.nodeId !== input.active.nodeId) {
    return {
      ok: false,
      reason: "Settlement identity does not match the active isolated root attempt.",
      diagnostics: [{
        code: "isolated_root_stale_identity",
        message: "The worker result identity does not match the in-flight root attempt.",
        location: "settlement.result",
      }],
    };
  }
  if (!markIsolatedRootAttemptSettled(input.active, input.active.attemptId)) {
    return {
      ok: false,
      reason: "The isolated root attempt was already settled.",
      diagnostics: [{
        code: "isolated_root_double_settle",
        message: "A second settlement for the same isolated root attempt was rejected.",
        location: "active.attemptId",
      }],
    };
  }
  return {
    ok: true,
    commands: input.settlement.commands,
    result: input.settlement.result,
    summary: input.settlement.summary,
  };
}

/**
 * Build cancel-attempt commands for orphaned running task nodes after host
 * teardown (restore, branch change, or user cancel of root workers).
 */
export function buildOrphanedTaskCancelCommands(input: {
  state: HypagraphState;
  at: string;
  reason: string;
  /** When set, only cancel this attempt. When absent, cancel all active tasks. */
  only?: { nodeId: string; attemptId: string };
  correlationId: string;
}): HypagraphCommand[] {
  const commands: HypagraphCommand[] = [];
  for (const node of input.state.definition.nodes) {
    if ((node.kind ?? "task") !== "task") continue;
    const runtime = input.state.runtime.nodes[node.id];
    const attemptId = runtime?.currentAttemptId;
    if (!runtime || !attemptId) continue;
    if (!["starting", "running", "awaiting_evidence", "verifying"].includes(runtime.status)) {
      continue;
    }
    if (input.only && (input.only.nodeId !== node.id || input.only.attemptId !== attemptId)) {
      continue;
    }
    commands.push({
      type: "cancel-attempt",
      nodeId: node.id,
      attemptId,
      reason: input.reason,
      commandId: `${input.correlationId}:cancel:${node.id}:${attemptId}`,
      correlationId: input.correlationId,
      at: input.at,
    });
  }
  return commands;
}

/** Settlement meta factory for one root isolated operation. */
export function isolatedRootSettleMeta(
  operationId: string,
  at: string,
): SettleExecutorResultMeta {
  return {
    at,
    correlationId: operationId,
    commandIdForStep: (stepIndex) => `${operationId}:settle:${stepIndex}`,
  };
}

/** Resolve profile for a node id from state. Convenience for host status. */
export function resolveProfileForNode(
  state: HypagraphState,
  nodeId: string,
): ResolvedModelNodeExecutorProfile {
  const node: NodeDefinition | undefined = state.definition.nodes.find((item) => item.id === nodeId);
  return resolveModelNodeExecutorProfile({ node: node ?? null });
}

// ---------------------------------------------------------------------------
// Multi-worker pool (S4). Host memory only. Learn structure from pi-subagents
// active run registry; do not import that package.
// ---------------------------------------------------------------------------

/**
 * Keyed registry of in-flight isolated model attempts.
 * Key is familyDispatchId when present, else attemptId.
 */
export type IsolatedWorkerPool = Map<string, ActiveIsolatedRootAttempt>;

/** Create an empty multi-worker pool. */
export function createIsolatedWorkerPool(): IsolatedWorkerPool {
  return new Map();
}

/**
 * Stable host key for one active attempt.
 * Prefer familyDispatchId when the attempt belongs to a family pending.
 */
export function isolatedWorkerPoolKey(active: ActiveIsolatedRootAttempt): string {
  return active.familyDispatchId ?? active.attemptId;
}

/** Register an unsettled attempt. Overwrites an existing entry with the same key. */
export function registerIsolatedWorker(
  pool: IsolatedWorkerPool,
  active: ActiveIsolatedRootAttempt,
): string {
  const key = isolatedWorkerPoolKey(active);
  pool.set(key, active);
  return key;
}

/** Read one pool entry by key. */
export function getIsolatedWorker(
  pool: IsolatedWorkerPool,
  key: string,
): ActiveIsolatedRootAttempt | undefined {
  return pool.get(key);
}

/** Remove one pool entry by key. Returns true when an entry was removed. */
export function deleteIsolatedWorker(
  pool: IsolatedWorkerPool,
  key: string,
): boolean {
  return pool.delete(key);
}

/** Remove the pool entry for an attempt (by familyDispatchId or attemptId). */
export function deleteIsolatedWorkerForAttempt(
  pool: IsolatedWorkerPool,
  active: ActiveIsolatedRootAttempt,
): boolean {
  return deleteIsolatedWorker(pool, isolatedWorkerPoolKey(active));
}

/** Count pool entries that are not yet settled. */
export function countUnsettledIsolatedWorkers(pool: IsolatedWorkerPool): number {
  let count = 0;
  for (const entry of pool.values()) {
    if (!entry.settled) count += 1;
  }
  return count;
}

/**
 * True when a new model worker may start under the resolved global limit.
 * Capacity is product globalConcurrency (default 2), not a hard-coded one.
 */
export function canAdmitIsolatedWorker(
  pool: IsolatedWorkerPool,
  globalConcurrency: number,
): boolean {
  if (!Number.isSafeInteger(globalConcurrency) || globalConcurrency < 1) {
    return false;
  }
  return countUnsettledIsolatedWorkers(pool) < globalConcurrency;
}

/** Find an unsettled (or any) pool entry by attempt id. */
export function findIsolatedWorkerByAttemptId(
  pool: IsolatedWorkerPool,
  attemptId: string,
): ActiveIsolatedRootAttempt | undefined {
  for (const entry of pool.values()) {
    if (entry.attemptId === attemptId) return entry;
  }
  return undefined;
}

/**
 * Find a pool entry by node id.
 * When workflowId is set, match that member workflow only.
 */
export function findIsolatedWorkerByNodeId(
  pool: IsolatedWorkerPool,
  nodeId: string,
  workflowId?: string,
): ActiveIsolatedRootAttempt | undefined {
  for (const entry of pool.values()) {
    if (entry.nodeId !== nodeId) continue;
    if (workflowId !== undefined && entry.workflowId !== workflowId) continue;
    return entry;
  }
  return undefined;
}

/** Find a pool entry by member workflow id. */
export function findIsolatedWorkerByWorkflowId(
  pool: IsolatedWorkerPool,
  workflowId: string,
): ActiveIsolatedRootAttempt | undefined {
  for (const entry of pool.values()) {
    if (entry.workflowId === workflowId) return entry;
  }
  return undefined;
}

/** Find a pool entry by family pending dispatch id. */
export function findIsolatedWorkerByFamilyDispatchId(
  pool: IsolatedWorkerPool,
  familyDispatchId: string,
): ActiveIsolatedRootAttempt | undefined {
  return pool.get(familyDispatchId)
    ?? [...pool.values()].find((entry) => entry.familyDispatchId === familyDispatchId);
}

/** List all unsettled pool entries (stable insertion order of the Map). */
export function listUnsettledIsolatedWorkers(
  pool: IsolatedWorkerPool,
): ActiveIsolatedRootAttempt[] {
  const list: ActiveIsolatedRootAttempt[] = [];
  for (const entry of pool.values()) {
    if (!entry.settled) list.push(entry);
  }
  return list;
}

/**
 * Abort every unsettled pool entry.
 * Returns deep-cloned teardown snapshots (cancel mirrors included) for settle.
 */
export function abortAllUnsettledIsolatedWorkers(
  pool: IsolatedWorkerPool,
  reason: string,
): ActiveIsolatedRootAttempt[] {
  const aborted: ActiveIsolatedRootAttempt[] = [];
  for (const entry of pool.values()) {
    if (entry.settled) continue;
    try {
      entry.abortController.abort(reason);
    } catch {
      // Abort must not throw into restore/shutdown paths.
    }
    aborted.push(cloneActiveIsolatedForTeardown(entry));
  }
  return aborted;
}

/**
 * Deep-clone cancel mirrors for mid-flight teardown settle.
 * Keeps abortController reference so abort still reaches the live attempt.
 */
export function cloneActiveIsolatedForTeardown(
  active: ActiveIsolatedRootAttempt,
): ActiveIsolatedRootAttempt {
  return {
    ...active,
    ...(active.cancelSnapshot === undefined
      ? {}
      : { cancelSnapshot: structuredClone(active.cancelSnapshot) }),
    ...(active.cancelEvents === undefined
      ? {}
      : { cancelEvents: structuredClone(active.cancelEvents) }),
  };
}

/**
 * Clear every pool entry (settled and unsettled).
 * Call after abort and orphan settle on restore, branch change, or shutdown.
 */
export function clearIsolatedWorkerPool(pool: IsolatedWorkerPool): void {
  pool.clear();
}

/**
 * Format one worker status line for /hypagraph status and executor status.
 */
export function formatIsolatedWorkerStatusLine(
  active: ActiveIsolatedRootAttempt,
  options?: { includeElapsed?: boolean; nowMs?: number },
): string {
  const includeElapsed = options?.includeElapsed !== false;
  let elapsedPart = "";
  if (includeElapsed) {
    const nowMs = options?.nowMs ?? Date.now();
    const elapsedMs = nowMs - Date.parse(active.startedAt);
    const elapsed = Number.isFinite(elapsedMs)
      ? `${Math.max(0, Math.round(elapsedMs / 1000))}s`
      : "unknown";
    elapsedPart = `, elapsed ${elapsed}`;
  }
  return (
    `Worker: member '${active.goalId}' node '${active.nodeId}' `
    + `attempt '${active.attemptId}' `
    + `(${active.profile.kind}${elapsedPart})`
  );
}
