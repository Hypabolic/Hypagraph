/**
 * Isolated Pi RPC node executor adapter.
 *
 * Starts an owned child process for one attempt. The worker returns a structured
 * untrusted result. The adapter never mutates graph or family state.
 *
 * Canonical attempt identity comes from ExecutorContextEnvelope only.
 * A child Pi session path is optional process-side continuity. It is not domain
 * reducer state. Loss of the child process returns a structured result with
 * identity filled from the context envelope.
 *
 * Raw assistant text is not a valid canonical result.
 *
 * Cancel-versus-result race:
 * When runAttempt resolves with a value before abort wins Promise.race, the
 * completed result is accepted. Cancellation applies only when abort wins
 * without a completed result. The process tree is still terminated after accept.
 *
 * Process lifecycle ideas (bootstrap, ownership, cancellation, process-tree
 * termination, orphan reconciliation) are adapted from the MIT-licensed
 * pi-codex-subagents package:
 * https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents
 * Hypagraph owns the executor contract, result validation, and settlement path.
 * This module does not adopt model-owned spawn as a scheduler, raw final text as
 * the result, or concurrent same-checkout mutation.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  buildExecutorResultPayload,
  materializeExecutorContext,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorDiagnostic,
  type ExecutorOutcome,
  type ExecutorProfileRef,
  type ExecutorResult,
  type ExecutorUsage,
  type MaterializeExecutorContextResult,
  type NodeExecutor,
} from "../domain/executor-contract.js";
import {
  settleExecutorResult,
  type SettleExecutorResultMeta,
  type SettleExecutorResultResult,
} from "../domain/executor-settlement.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import type {
  Diagnostic,
  EvidenceReference,
  FactInput,
  HypagraphState,
} from "../domain/model.js";
import {
  CurrentSessionExecutorAbortError,
  CurrentSessionExecutorValidationError,
  executeAndSettleCurrentSession,
} from "./current-session-executor.js";

// ---------------------------------------------------------------------------
// Profile and identity constants
// ---------------------------------------------------------------------------

/** Stable profile for isolated Pi RPC execution. */
export const ISOLATED_PI_PROFILE: ExecutorProfileRef = {
  profileId: "isolated-pi-default",
  kind: "isolated-pi",
};

export const ISOLATED_PI_EXECUTOR_ID = "isolated-pi";
export const ISOLATED_PI_EXECUTOR_VERSION = 1;

/** Environment variable for the Pi binary path. */
export const ISOLATED_PI_BIN_ENV = "PI_BIN";

/** Default Pi binary name when PI_BIN is unset. */
export const ISOLATED_PI_DEFAULT_BIN = "pi";

/**
 * Default maximum bytes buffered for one worker reply on the stdout stream.
 * Enforcement counts raw stream bytes, not UTF-16 code units.
 */
export const DEFAULT_MAX_REPLY_BYTES = 1_048_576;

/** @deprecated Use DEFAULT_MAX_REPLY_BYTES. Alias retained for call-site compatibility. */
export const DEFAULT_MAX_REPLY_CHARS = DEFAULT_MAX_REPLY_BYTES;

// ---------------------------------------------------------------------------
// Process transport (testable)
// ---------------------------------------------------------------------------

/** Options for starting one owned isolated Pi process. */
export interface IsolatedPiStartOptions {
  /** Durable attempt identity from the context envelope. */
  identity: ExecutorAttemptIdentity;
  /** Opaque ownership token the host assigns to this process. */
  ownershipToken: string;
  /** Working directory for the child process. Same-checkout concurrency is blocked. */
  cwd?: string;
  /** Optional child session path for process-side continuity only. */
  sessionPath?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Pi binary path. Defaults to process.env.PI_BIN or "pi". */
  piBin?: string;
}

/**
 * Handle for one owned child process.
 * Process-side session metadata is not canonical domain state.
 */
export interface IsolatedPiProcessHandle {
  readonly pid?: number;
  /** Optional child session id for process continuity only. */
  readonly sessionId?: string;
  readonly ownershipToken: string;
  readonly identity: ExecutorAttemptIdentity;
  /**
   * Send one attempt request with the context envelope.
   * Awaits a structured worker reply (plain object) or transport failure.
   */
  runAttempt(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<unknown>;
  /** Terminate the process tree. Idempotent. */
  terminate(reason: string): Promise<void>;
}

/** Injectable process transport for production and tests. */
export interface IsolatedPiProcessTransport {
  start(options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle>;
}

// ---------------------------------------------------------------------------
// Host-side ownership registry (not domain schema)
// ---------------------------------------------------------------------------

/** One host-owned process record. Not persisted in the domain reducer. */
export interface OwnedIsolatedPiProcessRecord {
  ownershipToken: string;
  identity: ExecutorAttemptIdentity;
  pid?: number;
  /** Process-side session id for continuity metadata. Distinct from sessionPath. */
  sessionId?: string;
  /** Checkout key used to block concurrent same-checkout mutation. */
  checkoutKey: string;
  /** Optional process-side session file path. Continuity only; not an id. */
  sessionPath?: string;
  startedAt: string;
  live: boolean;
}

/**
 * Why the host terminated an owned process.
 * Classification of cancelled vs interrupted uses this kind, not free-text reason.
 */
export type HostTeardownKind = "restore" | "branch" | "user" | "other";

/** Tombstone left after host-initiated teardown so in-flight execute can map outcome. */
export interface HostTeardownTombstone {
  ownershipToken: string;
  kind: HostTeardownKind;
  /** Human-readable reason for diagnostics and UI. Not used for outcome classification. */
  reason: string;
}

/** Failure shape returned by registry operations. */
export type IsolatedPiRegistryFailure = {
  ok: false;
  code: string;
  message: string;
  hostTeardown?: HostTeardownTombstone;
};

export type ProcessLivenessProbe = (record: OwnedIsolatedPiProcessRecord) => boolean | Promise<boolean>;
export type ProcessTerminator = (record: OwnedIsolatedPiProcessRecord, reason: string) => Promise<void>;

/**
 * Host-side registry of owned isolated Pi processes.
 * Supports orphan reconciliation after host restart when records are restored.
 * Does not store canonical attempt context; that remains in ExecutorContextEnvelope.
 */
export class IsolatedPiProcessRegistry {
  private readonly records = new Map<string, OwnedIsolatedPiProcessRecord>();
  private readonly checkoutOwners = new Map<string, string>();
  private readonly terminators = new Map<string, (reason: string) => Promise<void>>();
  /** Host teardown tombstones so in-flight execute maps to cancelled/interrupted. */
  private readonly hostTeardowns = new Map<string, HostTeardownTombstone>();
  /**
   * Ownership tokens with an in-flight execute() that will clear the tombstone.
   * Terminate without an active execute clears the tombstone immediately.
   */
  private readonly activeExecuteTokens = new Set<string>();

  register(
    record: OwnedIsolatedPiProcessRecord,
  ): { ok: true } | IsolatedPiRegistryFailure {
    if (this.records.has(record.ownershipToken)) {
      return {
        ok: false,
        code: "isolated_pi_ownership_duplicate",
        message: `Ownership token '${record.ownershipToken}' is already registered.`,
      };
    }
    // Do not resurrect a token the host just tore down.
    const existingTeardown = this.hostTeardowns.get(record.ownershipToken);
    if (existingTeardown) {
      return {
        ok: false,
        code: "isolated_pi_host_teardown",
        message: existingTeardown.reason,
        hostTeardown: structuredClone(existingTeardown),
      };
    }
    const existingOwner = this.checkoutOwners.get(record.checkoutKey);
    if (existingOwner !== undefined && existingOwner !== record.ownershipToken) {
      return {
        ok: false,
        code: "isolated_pi_concurrent_checkout_blocked",
        message:
          "Concurrent isolated Pi mutation of the same checkout is not allowed. "
          + "Worktree isolation is planned for M8.",
      };
    }
    this.records.set(record.ownershipToken, {
      ...record,
      identity: structuredClone(record.identity),
    });
    this.checkoutOwners.set(record.checkoutKey, record.ownershipToken);
    return { ok: true };
  }

  /**
   * Update process metadata in place without unregister/re-register.
   * Avoids a silent spawn-window race with host teardown.
   * On host teardown, returns the real tombstone reason and kind.
   */
  update(
    ownershipToken: string,
    patch: Partial<Pick<OwnedIsolatedPiProcessRecord, "pid" | "sessionId" | "sessionPath" | "live" | "startedAt">>,
  ): { ok: true; record: OwnedIsolatedPiProcessRecord } | IsolatedPiRegistryFailure {
    const record = this.records.get(ownershipToken);
    if (!record) {
      const teardown = this.hostTeardowns.get(ownershipToken);
      if (teardown) {
        return {
          ok: false,
          code: "isolated_pi_host_teardown",
          message: teardown.reason,
          hostTeardown: structuredClone(teardown),
        };
      }
      return {
        ok: false,
        code: "isolated_pi_ownership_unknown",
        message: `Ownership token '${ownershipToken}' is not registered.`,
      };
    }
    if (patch.pid !== undefined) record.pid = patch.pid;
    if (patch.sessionId !== undefined) record.sessionId = patch.sessionId;
    if (patch.sessionPath !== undefined) record.sessionPath = patch.sessionPath;
    if (patch.live !== undefined) record.live = patch.live;
    if (patch.startedAt !== undefined) record.startedAt = patch.startedAt;
    return { ok: true, record: structuredClone(record) };
  }

  /**
   * Attach a same-session terminate callback for an owned process.
   * Used by restore and cancel-all so live handles can be stopped.
   * Safe to call before the process handle exists (terminator may no-op until set again).
   */
  setTerminator(ownershipToken: string, terminate: (reason: string) => Promise<void>): void {
    if (!this.records.has(ownershipToken) && !this.hostTeardowns.has(ownershipToken)) return;
    this.terminators.set(ownershipToken, terminate);
  }

  get(ownershipToken: string): OwnedIsolatedPiProcessRecord | undefined {
    const record = this.records.get(ownershipToken);
    return record ? structuredClone(record) : undefined;
  }

  getHostTeardown(ownershipToken: string): HostTeardownTombstone | undefined {
    const tombstone = this.hostTeardowns.get(ownershipToken);
    return tombstone ? structuredClone(tombstone) : undefined;
  }

  /** Clear a host-teardown tombstone after in-flight execute has observed it. */
  clearHostTeardown(ownershipToken: string): void {
    this.hostTeardowns.delete(ownershipToken);
    this.terminators.delete(ownershipToken);
  }

  list(): OwnedIsolatedPiProcessRecord[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.ownershipToken.localeCompare(right.ownershipToken));
  }

  hasActive(): boolean {
    return [...this.records.values()].some((record) => record.live);
  }

  activeCount(): number {
    return [...this.records.values()].filter((record) => record.live).length;
  }

  markNotLive(ownershipToken: string): void {
    const record = this.records.get(ownershipToken);
    if (!record) return;
    record.live = false;
  }

  unregister(ownershipToken: string): void {
    const record = this.records.get(ownershipToken);
    if (!record) return;
    this.records.delete(ownershipToken);
    this.terminators.delete(ownershipToken);
    if (this.checkoutOwners.get(record.checkoutKey) === ownershipToken) {
      this.checkoutOwners.delete(record.checkoutKey);
    }
  }

  /**
   * Confirm the ownership token is still registered and live.
   * Identity matching of worker results is validateExecutorResult's job.
   * Handle token and optional worker-echoed token are checked by the executor.
   * Host teardown is reported as isolated_pi_host_teardown (not generic unknown).
   */
  verifyRegistered(
    ownershipToken: string,
  ): { ok: true; record: OwnedIsolatedPiProcessRecord } | IsolatedPiRegistryFailure {
    const teardown = this.hostTeardowns.get(ownershipToken);
    if (teardown) {
      return {
        ok: false,
        code: "isolated_pi_host_teardown",
        message: teardown.reason,
        hostTeardown: structuredClone(teardown),
      };
    }
    const record = this.records.get(ownershipToken);
    if (!record) {
      return {
        ok: false,
        code: "isolated_pi_ownership_unknown",
        message: `Ownership token '${ownershipToken}' is not registered.`,
      };
    }
    if (!record.live) {
      return {
        ok: false,
        code: "isolated_pi_ownership_not_live",
        message: `Ownership token '${ownershipToken}' is registered but not live.`,
      };
    }
    return { ok: true, record: structuredClone(record) };
  }

  /** Mark that execute() is in flight for this ownership token. */
  noteExecuteStarted(ownershipToken: string): void {
    this.activeExecuteTokens.add(ownershipToken);
  }

  /**
   * Mark that execute() finished for this token and clear any host-teardown tombstone.
   * Called from execute finally so the map does not grow without bound.
   */
  noteExecuteFinished(ownershipToken: string): void {
    this.activeExecuteTokens.delete(ownershipToken);
    this.clearHostTeardown(ownershipToken);
  }

  /**
   * Terminate one owned process via its same-session terminator or PID kill.
   * Records a host-teardown tombstone so in-flight execute maps to cancelled/interrupted.
   * When no execute is in flight for the token, the tombstone is cleared immediately.
   * Idempotent for missing tokens.
   */
  async terminateOwned(
    ownershipToken: string,
    input: { reason: string; kind: HostTeardownKind },
  ): Promise<boolean> {
    const record = this.records.get(ownershipToken);
    const existingTeardown = this.hostTeardowns.get(ownershipToken);
    if (!record && !existingTeardown) return false;

    this.hostTeardowns.set(ownershipToken, {
      ownershipToken,
      kind: input.kind,
      reason: input.reason,
    });
    const terminator = this.terminators.get(ownershipToken);
    if (terminator) {
      await terminator(input.reason);
    } else if (record?.pid !== undefined) {
      await killPidBestEffort(record.pid);
    }
    if (record) {
      this.markNotLive(ownershipToken);
      this.unregister(ownershipToken);
    }
    // No in-flight execute will observe this tombstone; do not retain it forever.
    if (!this.activeExecuteTokens.has(ownershipToken)) {
      this.clearHostTeardown(ownershipToken);
    }
    return true;
  }

  /**
   * Terminate every owned process. Used on session restore and branch change.
   * Returns the number of terminated records.
   * Ages out tombstones that have no active execute after the pass.
   */
  async terminateAll(input: { reason: string; kind: HostTeardownKind }): Promise<number> {
    const tokens = this.list().map((record) => record.ownershipToken);
    let count = 0;
    for (const token of tokens) {
      const done = await this.terminateOwned(token, input);
      if (done) count += 1;
    }
    // Drop any remaining tombstones not claimed by an in-flight execute.
    for (const token of [...this.hostTeardowns.keys()]) {
      if (!this.activeExecuteTokens.has(token)) {
        this.clearHostTeardown(token);
      }
    }
    return count;
  }
}

export interface OrphanReconciliationResult {
  orphans: OwnedIsolatedPiProcessRecord[];
  terminatedTokens: string[];
}

/**
 * Mark and optionally terminate owned process records that are no longer live.
 * Pure with respect to domain state. Uses the host registry and an injectable liveness probe.
 */
export async function reconcileIsolatedPiOrphans(
  registry: IsolatedPiProcessRegistry,
  isLive: ProcessLivenessProbe,
  terminate?: (record: OwnedIsolatedPiProcessRecord) => Promise<void>,
): Promise<OrphanReconciliationResult> {
  const orphans: OwnedIsolatedPiProcessRecord[] = [];
  const terminatedTokens: string[] = [];

  for (const record of registry.list()) {
    const live = await isLive(record);
    if (live) continue;
    registry.markNotLive(record.ownershipToken);
    const orphan = registry.get(record.ownershipToken);
    if (orphan) orphans.push(orphan);
    if (terminate) {
      await terminate(record);
      terminatedTokens.push(record.ownershipToken);
    }
    registry.unregister(record.ownershipToken);
  }

  return { orphans, terminatedTokens };
}

/**
 * Probe whether a process id is still live.
 * Uses signal 0 (existence check). Does not kill the process.
 */
export function isPidLive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

export interface BuildIsolatedPiResultPayloadInput {
  identity: ExecutorAttemptIdentity;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  artifacts?: ExecutorResult["artifacts"];
}

/**
 * Build a plain-object untrusted result with identity from the context envelope.
 * The payload is not trusted until settleExecutorResult validates it.
 * Uses the shared buildExecutorResultPayload helper.
 */
export function buildIsolatedPiResultPayload(
  input: BuildIsolatedPiResultPayloadInput,
): Record<string, unknown> {
  return buildExecutorResultPayload({
    identity: input.identity,
    outcome: input.outcome,
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
    defaultSummary: defaultSummaryForOutcome,
  });
}

/**
 * Clamp diagnostics so the payload stays within the result protocol bound.
 * Drops overflow and appends one truncation diagnostic when needed.
 */
export function clampExecutorDiagnostics(
  diagnostics: readonly ExecutorDiagnostic[],
  maxDiagnostics: number,
): ExecutorDiagnostic[] {
  const max = Number.isSafeInteger(maxDiagnostics) && maxDiagnostics >= 0
    ? maxDiagnostics
    : 0;
  if (max === 0) return [];
  if (diagnostics.length <= max) {
    return diagnostics.map((item) => structuredClone(item));
  }
  const truncation: ExecutorDiagnostic = {
    code: "isolated_pi_diagnostics_truncated",
    message:
      `Executor diagnostics were truncated from ${diagnostics.length} to ${max} `
      + "to satisfy the result protocol bound.",
  };
  if (max === 1) return [truncation];
  const kept = diagnostics.slice(0, max - 1).map((item) => structuredClone(item));
  kept.push(truncation);
  return kept;
}

/**
 * Keep only non-negative safe integer usage fields. Drop invalid values.
 */
export function normalizeExecutorUsage(usage: unknown): ExecutorUsage {
  if (!isStrictPlainObject(usage)) return {};
  const result: ExecutorUsage = {};
  const record = usage as Record<string, unknown>;
  if (isNonNegativeSafeInteger(record.turns)) result.turns = record.turns;
  if (isNonNegativeSafeInteger(record.inputTokens)) result.inputTokens = record.inputTokens;
  if (isNonNegativeSafeInteger(record.outputTokens)) result.outputTokens = record.outputTokens;
  if (isNonNegativeSafeInteger(record.totalTokens)) result.totalTokens = record.totalTokens;
  return result;
}

/**
 * Build a structured failure/cancel/interrupt result from the context envelope.
 * Preserves canonical identity when the child session is lost.
 *
 * Diagnostics are clamped to the protocol max. Usage is normalized.
 * The fallback path is guaranteed settleable (empty usage, clamped diagnostics).
 */
export function resultFromContext(
  context: ExecutorContextEnvelope,
  outcome: ExecutorOutcome,
  diagnostics: ExecutorDiagnostic[],
  summary?: string,
  usage?: ExecutorUsage,
): ExecutorResult {
  const maxDiagnostics = context.resultProtocol?.maxDiagnostics ?? 64;
  const clamped = clampExecutorDiagnostics(diagnostics, maxDiagnostics);
  const safeUsage = normalizeExecutorUsage(usage ?? {});
  const safeSummary = isNonEmptyString(summary)
    ? summary
    : defaultSummaryForOutcome(outcome);

  const payload = buildIsolatedPiResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: clamped,
    usage: safeUsage,
  });

  const validated = validateExecutorResult(context, payload);
  if (validated.ok) return validated.value;

  // Last line of defence: construct a minimal settleable result by construction.
  const minimalDiagnostics = clampExecutorDiagnostics(
    [{
      code: "isolated_pi_result_construction_failed",
      message:
        "Isolated Pi could not build a fully validated failure result. "
        + "Identity is preserved from the context envelope.",
    }],
    maxDiagnostics,
  );
  const minimalPayload = buildIsolatedPiResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: minimalDiagnostics,
    usage: {},
  });
  const minimalValidated = validateExecutorResult(context, minimalPayload);
  if (minimalValidated.ok) return minimalValidated.value;

  // Absolute fallback: never return unvalidated worker-controlled diagnostics/usage.
  return {
    familyId: context.identity.familyId,
    goalId: context.identity.goalId,
    workflowId: context.identity.workflowId,
    revision: context.identity.revision,
    nodeId: context.identity.nodeId,
    attemptId: context.identity.attemptId,
    outcome,
    facts: [],
    evidence: [],
    artifacts: [],
    summary: safeSummary.slice(0, context.resultProtocol?.maxSummaryChars ?? 4096),
    diagnostics: minimalDiagnostics.length > 0
      ? minimalDiagnostics
      : [{
        code: "isolated_pi_result_construction_failed",
        message: "Isolated Pi could not build a validated failure result.",
      }],
    usage: {},
  };
}

// ---------------------------------------------------------------------------
// Context materialization
// ---------------------------------------------------------------------------

export interface MaterializeIsolatedPiContextInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  /** Defaults to ISOLATED_PI_PROFILE. */
  profile?: ExecutorProfileRef;
  rootObjective?: string;
}

/**
 * Materialize an isolated-pi context envelope for one running attempt.
 * Returns diagnostics when the family, state, or identity is incomplete.
 */
export function materializeIsolatedPiContext(
  input: MaterializeIsolatedPiContextInput,
): MaterializeExecutorContextResult {
  if (!isNonEmptyString(input.nodeId)) {
    return reject(
      "isolated_pi_invalid_node",
      "Isolated Pi context requires a non-empty nodeId.",
      "nodeId",
    );
  }
  if (!isNonEmptyString(input.attemptId)) {
    return reject(
      "isolated_pi_invalid_attempt",
      "Isolated Pi context requires a non-empty attemptId.",
      "attemptId",
    );
  }

  const goalId = input.state.goal?.goalId;
  if (!isNonEmptyString(goalId)) {
    return reject(
      "isolated_pi_goal_missing",
      "Isolated Pi context requires a started goal runtime on the workflow state.",
      "state.goal",
    );
  }

  const familyId = input.family.familyId;
  if (!isNonEmptyString(familyId)) {
    return reject(
      "isolated_pi_family_missing",
      "Isolated Pi context requires a non-empty familyId.",
      "family.familyId",
    );
  }

  const identity: ExecutorAttemptIdentity = {
    familyId,
    goalId,
    workflowId: input.state.workflowId,
    revision: input.state.revision,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
  };

  const profile = input.profile ?? ISOLATED_PI_PROFILE;
  return materializeExecutorContext({
    family: input.family,
    state: input.state,
    identity,
    profile,
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
}

// ---------------------------------------------------------------------------
// Executor factory and lifecycle
// ---------------------------------------------------------------------------

export interface CreateIsolatedPiExecutorOptions {
  transport: IsolatedPiProcessTransport;
  /** Host-side process registry. Defaults to a new registry. */
  registry?: IsolatedPiProcessRegistry;
  /**
   * Produce an ownership token for each start.
   * Defaults to randomUUID. Injectable for tests.
   */
  createOwnershipToken?: () => string;
  /**
   * Checkout key for concurrent-mutation guard.
   * Defaults to resolved cwd (same isolation boundary as resolveCwd).
   * Hosts must align this with resolveCwd so the guard matches isolation.
   * Until M8 worktrees, do not key on leaseId while cwd stays process.cwd().
   */
  resolveCheckoutKey?: (context: ExecutorContextEnvelope) => string;
  /**
   * Working directory for the child process.
   */
  resolveCwd?: (context: ExecutorContextEnvelope) => string | undefined;
  /**
   * Pure started-at timestamp supplier for registry records.
   * Defaults to a fixed placeholder; hosts should inject wall-clock when needed.
   * The domain reducer does not read this value.
   */
  startedAt?: () => string;
  /**
   * Optional process-side session file path for continuity only.
   * Distinct from sessionId on the process handle.
   */
  resolveSessionPath?: (context: ExecutorContextEnvelope) => string | undefined;
  /** Optional extra environment for the child process. */
  resolveEnv?: (context: ExecutorContextEnvelope) => Record<string, string> | undefined;
  /** Optional Pi binary path override for this attempt. */
  resolvePiBin?: (context: ExecutorContextEnvelope) => string | undefined;
}

/**
 * Create an isolated Pi NodeExecutor.
 *
 * Lifecycle:
 * 1. Durable attempt identity comes from the context envelope.
 * 2. Start an owned child process with an ownership token.
 * 3. Verify handle ownership token and optional worker-echoed token.
 * 4. AbortSignal cancels and terminates the process tree when abort wins
 *    without a completed result. A completed result wins over a concurrent abort.
 * 5. Parse worker JSON into a plain object for validateExecutorResult.
 * 6. Terminate the process after the attempt.
 * 7. Session loss maps to interrupted with identity from the envelope.
 * 8. Stale identity mismatches are rewritten to failed with diagnostics.
 *
 * execute always returns ExecutorResult for normal failure modes.
 * Controllers must still call settleExecutorResult before commit.
 */
export function createIsolatedPiExecutor(
  options: CreateIsolatedPiExecutorOptions,
): NodeExecutor {
  const registry = options.registry ?? new IsolatedPiProcessRegistry();
  const createToken = options.createOwnershipToken ?? (() => randomUUID());
  const resolveCheckoutKey = options.resolveCheckoutKey
    ?? ((context: ExecutorContextEnvelope) => {
      try {
        const cwd = options.resolveCwd?.(context);
        if (isNonEmptyString(cwd)) return cwd;
      } catch {
        // resolveCwd failure is handled in execute.
      }
      return "default";
    });
  const resolveCwd = options.resolveCwd;
  const startedAt = options.startedAt ?? (() => "1970-01-01T00:00:00.000Z");
  const resolveSessionPath = options.resolveSessionPath;
  const resolveEnv = options.resolveEnv;
  const resolvePiBin = options.resolvePiBin;

  return {
    id: ISOLATED_PI_EXECUTOR_ID,
    version: ISOLATED_PI_EXECUTOR_VERSION,
    async execute(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<ExecutorResult> {
      if (signal.aborted) {
        return resultFromContext(context, "cancelled", [{
          code: "isolated_pi_aborted_before_start",
          message: "The isolated Pi executor was aborted before process start.",
        }]);
      }

      let ownershipToken: string;
      let checkoutKey: string;
      let cwd: string | undefined;
      let sessionPath: string | undefined;
      let env: Record<string, string> | undefined;
      let piBin: string | undefined;
      try {
        ownershipToken = createToken();
        if (!isNonEmptyString(ownershipToken)) {
          return resultFromContext(context, "failed", [{
            code: "isolated_pi_invalid_ownership_token",
            message: "createOwnershipToken must return a non-empty string.",
          }]);
        }
        checkoutKey = resolveCheckoutKey(context);
        if (!isNonEmptyString(checkoutKey)) {
          return resultFromContext(context, "failed", [{
            code: "isolated_pi_invalid_checkout_key",
            message: "resolveCheckoutKey must return a non-empty string.",
          }]);
        }
        cwd = resolveCwd?.(context);
        sessionPath = resolveSessionPath?.(context);
        env = resolveEnv?.(context);
        piBin = resolvePiBin?.(context);
      } catch (error) {
        return resultFromContext(context, "failed", [{
          code: "isolated_pi_host_setup_failed",
          message: errorMessage(
            error,
            "Isolated Pi host setup failed before process start.",
          ),
        }]);
      }

      const registration = registry.register({
        ownershipToken,
        identity: structuredClone(context.identity),
        checkoutKey,
        live: true,
        startedAt: startedAt(),
        ...(sessionPath !== undefined ? { sessionPath } : {}),
      });
      if (!registration.ok) {
        return resultFromHostOrRegistrationFailure(context, registration);
      }

      // In-flight execute will clear any host-teardown tombstone in finally.
      registry.noteExecuteStarted(ownershipToken);

      // Attach terminator early so host teardown during spawn can reclaim the process.
      let handle: IsolatedPiProcessHandle | undefined;
      registry.setTerminator(ownershipToken, async (reason) => {
        if (handle) await safeTerminate(handle, reason);
      });

      let abortListener: (() => void) | undefined;
      let terminatedForAbort = false;

      try {
        try {
          handle = await options.transport.start({
            identity: structuredClone(context.identity),
            ownershipToken,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(sessionPath !== undefined ? { sessionPath } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(piBin !== undefined ? { piBin } : {}),
          });
        } catch (error) {
          const teardown = registry.getHostTeardown(ownershipToken);
          registry.unregister(ownershipToken);
          if (teardown) {
            return resultFromHostTeardown(context, teardown);
          }
          return resultFromContext(context, "failed", [{
            code: "isolated_pi_start_failed",
            message: errorMessage(error, "Isolated Pi process start failed."),
          }]);
        }

        // Update metadata in place (no unregister/re-register race with host teardown).
        const updated = registry.update(ownershipToken, {
          ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
          ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
          ...(sessionPath !== undefined ? { sessionPath } : {}),
          live: true,
        });
        if (!updated.ok) {
          await safeTerminate(handle, updated.code);
          return resultFromHostOrRegistrationFailure(context, updated);
        }

        // Meaningful ownership: handle token must match the registered token.
        if (handle.ownershipToken !== ownershipToken) {
          await safeTerminate(handle, "ownership_token_mismatch");
          registry.unregister(ownershipToken);
          return resultFromContext(context, "failed", [{
            code: "isolated_pi_handle_ownership_mismatch",
            message:
              "Process handle ownership token does not match the registered token.",
          }]);
        }

        const registered = registry.verifyRegistered(ownershipToken);
        if (!registered.ok) {
          await safeTerminate(handle, "ownership_failed");
          registry.unregister(ownershipToken);
          return resultFromHostOrRegistrationFailure(context, registered);
        }

        // Refresh terminator now that the handle is definitely set.
        registry.setTerminator(ownershipToken, (reason) => safeTerminate(handle!, reason));

        if (signal.aborted) {
          terminatedForAbort = true;
          await safeTerminate(handle, "aborted");
          return resultFromContext(context, "cancelled", [{
            code: "isolated_pi_cancelled",
            message: "The isolated Pi executor was aborted after process start.",
          }]);
        }

        const abortPromise = new Promise<"aborted">((resolveAbort) => {
          abortListener = () => resolveAbort("aborted");
          signal.addEventListener("abort", abortListener, { once: true });
        });

        const runPromise = handle.runAttempt(context, signal).then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );

        const raced = await Promise.race([
          runPromise,
          abortPromise.then((kind) => ({ kind })),
        ]);

        // Completed result wins: if runAttempt produced a value, accept it even
        // when abort is also set. Cancellation applies only without a completed result.
        if (raced.kind === "result") {
          const stillOwned = registry.verifyRegistered(ownershipToken);
          if (!stillOwned.ok) {
            await safeTerminate(handle, "stale_ownership");
            return resultFromHostOrRegistrationFailure(context, stillOwned);
          }

          if (handle.ownershipToken !== ownershipToken) {
            await safeTerminate(handle, "ownership_token_mismatch");
            return resultFromContext(context, "failed", [{
              code: "isolated_pi_handle_ownership_mismatch",
              message:
                "Process handle ownership token does not match the registered token.",
            }]);
          }

          const parsed = parseWorkerReply(raced.value, ownershipToken);
          if (parsed.kind === "worker_error") {
            await safeTerminate(handle, "worker_error");
            return resultFromContext(context, "failed", [{
              code: "isolated_pi_worker_error",
              message: parsed.message,
              location: parsed.code,
            }, {
              code: parsed.code,
              message: parsed.message,
            }]);
          }
          if (parsed.kind === "ownership_echo_mismatch") {
            await safeTerminate(handle, "ownership_echo_mismatch");
            return resultFromContext(context, "failed", [{
              code: "isolated_pi_ownership_echo_mismatch",
              message:
                "Worker reply ownership token does not match the request ownership token.",
            }]);
          }
          if (parsed.kind === "invalid") {
            await safeTerminate(handle, "invalid_reply");
            return resultFromContext(context, "failed", [{
              code: "isolated_pi_invalid_worker_reply",
              message: parsed.message,
            }]);
          }

          const untrusted = parsed.value;
          const validated = validateExecutorResult(context, untrusted);
          if (!validated.ok) {
            await safeTerminate(handle, "validation_failed");
            const diagnostics: ExecutorDiagnostic[] = validated.diagnostics.map((item) => ({
              code: item.code,
              message: item.message,
              ...(item.location ? { location: item.location } : {}),
            }));
            const hasIdentityMismatch = validated.diagnostics.some(
              (item) => item.code === "executor_result_identity_mismatch",
            );
            if (hasIdentityMismatch) {
              diagnostics.unshift({
                code: "isolated_pi_stale_result",
                message:
                  "Worker result identity does not match the context envelope. Result rejected.",
              });
            }
            return resultFromContext(
              context,
              "failed",
              diagnostics,
              "Isolated Pi worker result failed validation.",
              normalizeExecutorUsage(untrusted.usage),
            );
          }

          await safeTerminate(handle, "settled");
          return validated.value;
        }

        // Prefer host tombstone classification when present (restore → interrupted)
        // before plain abort cancelled. Mirrors the error-branch host-teardown path.
        if (raced.kind === "aborted" || signal.aborted) {
          const hostTeardownOnAbort = registry.getHostTeardown(ownershipToken);
          if (hostTeardownOnAbort) {
            terminatedForAbort = true;
            await safeTerminate(handle, "host_teardown");
            return resultFromHostTeardown(context, hostTeardownOnAbort);
          }
          terminatedForAbort = true;
          await safeTerminate(handle, "cancelled");
          return resultFromContext(context, "cancelled", [{
            code: "isolated_pi_cancelled",
            message: "The isolated Pi attempt was cancelled by AbortSignal.",
          }]);
        }

        // raced.kind === "error" — prefer host-teardown mapping when restore reclaimed us.
        const hostTeardown = registry.getHostTeardown(ownershipToken);
        if (hostTeardown) {
          await safeTerminate(handle, "host_teardown");
          return resultFromHostTeardown(context, hostTeardown);
        }
        const message = errorMessage(raced.error, "Isolated Pi worker failed.");
        const code = isSessionLossError(raced.error)
          ? "isolated_pi_session_lost"
          : "isolated_pi_transport_error";
        const outcome: ExecutorOutcome = code === "isolated_pi_session_lost"
          ? "interrupted"
          : "failed";
        await safeTerminate(handle, code);
        return resultFromContext(context, outcome, [{ code, message }]);
      } finally {
        if (abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
        if (!terminatedForAbort && handle) {
          await safeTerminate(handle, "cleanup");
        }
        registry.markNotLive(ownershipToken);
        registry.unregister(ownershipToken);
        // Clears tombstone and active-execute tracking.
        registry.noteExecuteFinished(ownershipToken);
      }
    },
  };
}

/** Map host teardown / registration failures to cancelled or interrupted outcomes. */
function resultFromHostOrRegistrationFailure(
  context: ExecutorContextEnvelope,
  failure: IsolatedPiRegistryFailure,
): ExecutorResult {
  if (failure.code === "isolated_pi_host_teardown") {
    return resultFromHostTeardown(
      context,
      failure.hostTeardown ?? {
        ownershipToken: "",
        kind: "other",
        reason: failure.message,
      },
    );
  }
  return resultFromContext(context, "failed", [{
    code: failure.code,
    message: failure.message,
  }]);
}

/**
 * Host-initiated teardown (session restore / branch change / user cancel).
 * Outcome classification uses tombstone.kind only. The reason string is display-only.
 * - restore | branch → interrupted
 * - user | other → cancelled
 */
function resultFromHostTeardown(
  context: ExecutorContextEnvelope,
  tombstone: Pick<HostTeardownTombstone, "kind" | "reason">,
): ExecutorResult {
  const interrupted = tombstone.kind === "restore" || tombstone.kind === "branch";
  return resultFromContext(
    context,
    interrupted ? "interrupted" : "cancelled",
    [{
      code: "isolated_pi_host_teardown",
      message: tombstone.reason,
      location: `hostTeardown.kind:${tombstone.kind}`,
    }],
    interrupted
      ? "The host interrupted the isolated Pi attempt during session restore."
      : "The host cancelled the isolated Pi attempt.",
  );
}

/**
 * Run one isolated Pi attempt and settle the result with the shared path.
 * Proves the adapter and settlement share one public settle API.
 * Maps thrown execute errors to { ok: false, diagnostics } so callers never
 * see a rejected promise for normal failure modes.
 *
 * Typed current-session errors are unwrapped when that adapter is routed here:
 * - CurrentSessionExecutorValidationError → its diagnostics
 * - CurrentSessionExecutorAbortError → cancelled settlement
 * Unknown throws fall back to isolated_pi_execute_threw.
 */
export async function executeAndSettleIsolatedPi(
  executor: NodeExecutor,
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
  meta: SettleExecutorResultMeta,
): Promise<SettleExecutorResultResult> {
  let raw: unknown;
  try {
    raw = await executor.execute(context, signal);
  } catch (error) {
    const mapped = mapExecutorExecuteError(context, error, meta);
    if (mapped) return mapped;
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_pi_execute_threw",
        message: errorMessage(error, "The isolated Pi executor threw during execute."),
      }],
    };
  }
  return settleExecutorResult(context, raw, meta);
}

/**
 * Map known executor throws to a settle result.
 * Returns undefined for unknown errors (caller applies generic fallback).
 */
function mapExecutorExecuteError(
  context: ExecutorContextEnvelope,
  error: unknown,
  meta: SettleExecutorResultMeta,
): SettleExecutorResultResult | undefined {
  if (error instanceof CurrentSessionExecutorValidationError) {
    return { ok: false, diagnostics: error.diagnostics };
  }
  // Name check keeps fidelity if the error crosses package boundaries.
  if (error instanceof Error && error.name === "CurrentSessionExecutorValidationError") {
    const diagnostics = (error as unknown as { diagnostics?: Diagnostic[] }).diagnostics;
    if (Array.isArray(diagnostics)) {
      return { ok: false, diagnostics };
    }
  }
  if (
    error instanceof CurrentSessionExecutorAbortError
    || (error instanceof Error && error.name === "CurrentSessionExecutorAbortError")
  ) {
    const cancelled = resultFromContext(context, "cancelled", [{
      code: "isolated_pi_executor_aborted",
      message: errorMessage(error, "The executor aborted the attempt."),
    }]);
    return settleExecutorResult(context, cancelled, meta);
  }
  return undefined;
}

/**
 * Settle an untrusted payload against an already materialized isolated-pi context.
 */
export function settleIsolatedPiResult(
  context: ExecutorContextEnvelope,
  untrustedResult: unknown,
  meta: SettleExecutorResultMeta,
): SettleExecutorResultResult {
  return settleExecutorResult(context, untrustedResult, meta);
}

// ---------------------------------------------------------------------------
// Host controller (product surface)
// ---------------------------------------------------------------------------

export interface CreateIsolatedPiHostOptions {
  transport: IsolatedPiProcessTransport;
  registry?: IsolatedPiProcessRegistry;
  /**
   * Checkout key for concurrent-mutation guard.
   * Must match the isolation boundary of resolveCwd.
   * Until M8, hosts should use the same cwd string for both.
   */
  resolveCheckoutKey?: (context: ExecutorContextEnvelope) => string;
  resolveCwd?: (context: ExecutorContextEnvelope) => string | undefined;
  startedAt?: () => string;
  createOwnershipToken?: () => string;
  /**
   * Optional factory for current-session executors when profile routing needs it.
   */
  createCurrentSession?: () => NodeExecutor;
  /**
   * Liveness probe for orphan reconciliation. Defaults to isPidLive(record.pid).
   */
  isLive?: ProcessLivenessProbe;
}

/**
 * Host-side controller for isolated Pi ownership, dispatch, and teardown.
 * Extension restore, ensureNoActiveExecution, and product dispatch use this surface.
 */
export interface IsolatedPiHost {
  readonly registry: IsolatedPiProcessRegistry;
  readonly executor: NodeExecutor;
  resolveNodeExecutor(profile: ExecutorProfileRef): NodeExecutor;
  /**
   * Controller seam: run one attempt and settle through the shared path.
   * Nested UI selection of profiles is m7-s9. Product hosts call this when the
   * selected profile kind is isolated-pi.
   */
  dispatchAttempt(
    context: ExecutorContextEnvelope,
    signal: AbortSignal,
    meta: SettleExecutorResultMeta,
  ): Promise<SettleExecutorResultResult>;
  hasActiveProcesses(): boolean;
  activeProcessCount(): number;
  /**
   * Terminate all owned processes and reconcile non-live PIDs.
   * Call from session restore and branch change.
   * In-flight execute maps host teardown to cancelled/interrupted by kind.
   */
  teardownOnRestore(input: {
    reason: string;
    kind: HostTeardownKind;
  }): Promise<{
    terminatedCount: number;
    orphans: OwnedIsolatedPiProcessRecord[];
  }>;
}

/** Session-scoped product host for isolated Pi dispatch (one active extension session). */
let activeIsolatedPiHost: IsolatedPiHost | undefined;

/**
 * Bind the product isolated Pi host for this extension session.
 * Extension restore, ensureNoActiveExecution, and dispatchIsolatedPiAttempt share it.
 */
export function bindActiveIsolatedPiHost(host: IsolatedPiHost | undefined): void {
  activeIsolatedPiHost = host;
}

/** Return the bound product isolated Pi host, if any. */
export function getActiveIsolatedPiHost(): IsolatedPiHost | undefined {
  return activeIsolatedPiHost;
}

/**
 * Product controller seam: dispatch one isolated Pi attempt through the bound host.
 * Nested graph UI (m7-s9) selects the profile. Controllers call this when
 * profile.kind is isolated-pi.
 */
export async function dispatchIsolatedPiAttempt(
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
  meta: SettleExecutorResultMeta,
): Promise<SettleExecutorResultResult> {
  const host = activeIsolatedPiHost;
  if (!host) {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_pi_host_unbound",
        message:
          "No active isolated Pi host is bound. The Hypagraph extension must be loaded.",
      }],
    };
  }
  if (context.profile.kind !== "isolated-pi") {
    return {
      ok: false,
      diagnostics: [{
        code: "isolated_pi_profile_mismatch",
        message:
          `dispatchIsolatedPiAttempt requires profile kind 'isolated-pi', got '${context.profile.kind}'.`,
        location: "context.profile.kind",
      }],
    };
  }
  return host.dispatchAttempt(context, signal, meta);
}

/**
 * Create the host controller used by the extension product surface.
 */
export function createIsolatedPiHost(options: CreateIsolatedPiHostOptions): IsolatedPiHost {
  const registry = options.registry ?? new IsolatedPiProcessRegistry();
  const resolveCwd = options.resolveCwd;
  // Default checkout key matches resolveCwd (not leaseId alone). M8 worktrees
  // may key on a lease-backed checkout path when resolveCwd returns that path.
  const resolveCheckoutKey = options.resolveCheckoutKey
    ?? ((context: ExecutorContextEnvelope) => {
      try {
        const cwd = resolveCwd?.(context);
        if (isNonEmptyString(cwd)) return cwd;
      } catch {
        // fall through
      }
      return "default";
    });

  const isolatedOptions: CreateIsolatedPiExecutorOptions = {
    transport: options.transport,
    registry,
    resolveCheckoutKey,
    ...(resolveCwd !== undefined ? { resolveCwd } : {}),
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
    ...(options.createOwnershipToken !== undefined
      ? { createOwnershipToken: options.createOwnershipToken }
      : {}),
  };

  const resolveNodeExecutor = (profile: ExecutorProfileRef): NodeExecutor =>
    createNodeExecutorForProfile(profile, {
      isolatedPi: isolatedOptions,
      ...(options.createCurrentSession !== undefined
        ? { createCurrentSession: options.createCurrentSession }
        : {}),
    });

  const executor = resolveNodeExecutor(ISOLATED_PI_PROFILE);
  const isLive = options.isLive
    ?? ((record: OwnedIsolatedPiProcessRecord) => isPidLive(record.pid));

  const host: IsolatedPiHost = {
    registry,
    executor,
    resolveNodeExecutor,
    async dispatchAttempt(context, signal, meta) {
      let selected: NodeExecutor;
      try {
        selected = context.profile.kind === "isolated-pi"
          ? executor
          : resolveNodeExecutor(context.profile);
      } catch (error) {
        // Map synchronous profile routing failures to diagnostics (never reject).
        return {
          ok: false,
          diagnostics: [{
            code: "isolated_pi_profile_route_failed",
            message: errorMessage(
              error,
              `No NodeExecutor adapter is available for profile kind '${context.profile.kind}'.`,
            ),
            location: "context.profile.kind",
          }],
        };
      }
      // Prefer the settle helper that matches the adapter so typed errors keep fidelity.
      if (context.profile.kind === "current-session") {
        try {
          return await executeAndSettleCurrentSession(selected, context, signal, meta);
        } catch (error) {
          const mapped = mapExecutorExecuteError(context, error, meta);
          if (mapped) return mapped;
          return {
            ok: false,
            diagnostics: [{
              code: "isolated_pi_execute_threw",
              message: errorMessage(
                error,
                "The current-session executor threw during host dispatch.",
              ),
            }],
          };
        }
      }
      return executeAndSettleIsolatedPi(selected, context, signal, meta);
    },
    hasActiveProcesses() {
      return registry.hasActive();
    },
    activeProcessCount() {
      return registry.activeCount();
    },
    async teardownOnRestore(input) {
      const terminatedCount = await registry.terminateAll(input);
      // After terminateAll live records are empty. Reconcile remains for
      // re-seeded records after host restart when PIDs are known but dead.
      const orphans = await reconcileIsolatedPiOrphans(
        registry,
        isLive,
        async (record) => {
          if (record.pid !== undefined) await killPidBestEffort(record.pid);
        },
      );
      return {
        terminatedCount: terminatedCount + orphans.terminatedTokens.length,
        orphans: orphans.orphans,
      };
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Node executor profile routing (product surface)
// ---------------------------------------------------------------------------

export interface CreateNodeExecutorForProfileOptions {
  /** Required when profile.kind is isolated-pi. */
  isolatedPi?: CreateIsolatedPiExecutorOptions;
  /**
   * Optional factory for current-session executors.
   * When omitted, current-session profiles fail at create time with a clear error.
   */
  createCurrentSession?: () => NodeExecutor;
}

/**
 * Create a NodeExecutor for a profile kind.
 * Routes isolated-pi to createIsolatedPiExecutor.
 * Controllers use this to select the adapter without embedding transport details.
 */
export function createNodeExecutorForProfile(
  profile: ExecutorProfileRef,
  options: CreateNodeExecutorForProfileOptions = {},
): NodeExecutor {
  if (profile.kind === "isolated-pi") {
    if (!options.isolatedPi) {
      throw new Error(
        "Isolated Pi profile requires createNodeExecutorForProfile options.isolatedPi.",
      );
    }
    return createIsolatedPiExecutor(options.isolatedPi);
  }
  if (profile.kind === "current-session") {
    if (!options.createCurrentSession) {
      throw new Error(
        "Current-session profile requires createNodeExecutorForProfile options.createCurrentSession.",
      );
    }
    return options.createCurrentSession();
  }
  throw new Error(
    `No NodeExecutor adapter is registered for profile kind '${profile.kind}'.`,
  );
}

// ---------------------------------------------------------------------------
// Fake transport (tests)
// ---------------------------------------------------------------------------

export interface FakeIsolatedPiProcessTransportOptions {
  /**
   * Produce the untrusted worker reply for a runAttempt call.
   * May throw IsolatedPiSessionLostError to simulate process death.
   */
  runAttempt: (
    context: ExecutorContextEnvelope,
    signal: AbortSignal,
    handle: IsolatedPiProcessHandle,
  ) => Promise<unknown>;
  /** Optional start hook. Defaults to a synthetic pid. */
  onStart?: (options: IsolatedPiStartOptions) => void | Promise<void>;
  /** Optional fail-start. When true or a message, start rejects. */
  failStart?: boolean | string;
  /** Optional fixed pid. Defaults to 4242. */
  pid?: number;
  /** Optional fixed session id for process continuity metadata. */
  sessionId?: string;
  /**
   * When set, the handle reports this ownership token instead of the start token.
   * Used to test handle ownership mismatch.
   */
  overrideOwnershipToken?: string;
}

/**
 * In-memory transport for tests. Does not spawn a real process.
 */
export function createFakeIsolatedPiTransport(
  options: FakeIsolatedPiProcessTransportOptions,
): IsolatedPiProcessTransport & {
  terminations: Array<{ ownershipToken: string; reason: string }>;
  started: IsolatedPiStartOptions[];
} {
  const terminations: Array<{ ownershipToken: string; reason: string }> = [];
  const started: IsolatedPiStartOptions[] = [];

  return {
    terminations,
    started,
    async start(startOptions: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> {
      if (options.failStart) {
        const message = typeof options.failStart === "string"
          ? options.failStart
          : "Fake isolated Pi transport failed to start.";
        throw new Error(message);
      }
      await options.onStart?.(startOptions);
      started.push(structuredClone(startOptions));

      let terminated = false;
      const reportedToken = options.overrideOwnershipToken ?? startOptions.ownershipToken;
      const handle: IsolatedPiProcessHandle = {
        pid: options.pid ?? 4242,
        sessionId: options.sessionId ?? `session-${startOptions.ownershipToken.slice(0, 8)}`,
        ownershipToken: reportedToken,
        identity: structuredClone(startOptions.identity),
        async runAttempt(context, signal) {
          if (terminated) {
            throw new IsolatedPiSessionLostError(
              "The isolated Pi process was already terminated.",
            );
          }
          return options.runAttempt(context, signal, handle);
        },
        async terminate(reason: string) {
          if (terminated) return;
          terminated = true;
          terminations.push({
            ownershipToken: startOptions.ownershipToken,
            reason,
          });
        },
      };
      return handle;
    },
  };
}

// ---------------------------------------------------------------------------
// Production-shaped child_process transport
// ---------------------------------------------------------------------------

export interface ChildProcessIsolatedPiTransportOptions {
  /** Pi binary path. Defaults to process.env.PI_BIN or "pi". */
  piBin?: string;
  /** Extra spawn arguments after the binary. Defaults to RPC-oriented flags. */
  args?: string[];
  /**
   * Maximum raw stdout bytes to buffer for one worker reply.
   * Must be a positive safe integer. Default is DEFAULT_MAX_REPLY_BYTES.
   * Enforcement counts stream bytes, not decoded characters.
   */
  maxReplyBytes?: number;
  /**
   * @deprecated Use maxReplyBytes. Accepted as an alias for call-site compatibility.
   */
  maxReplyChars?: number;
  /**
   * When true, start fails immediately if the binary path is empty.
   * Missing binary at spawn time also maps to start failure.
   */
  requireBinary?: boolean;
  /**
   * SIGTERM wait before SIGKILL, in milliseconds. Default 2000.
   * Injectable for tests.
   */
  terminateGraceMs?: number;
  /**
   * Final bound after SIGKILL before resolve, in milliseconds. Default 1000.
   */
  terminateForceMs?: number;
}

/**
 * Build the Pi RPC prompt message for one isolated attempt.
 * The agent must return a structured ExecutorResult JSON object as final text.
 */
export function buildIsolatedPiRpcPrompt(
  context: ExecutorContextEnvelope,
  ownershipToken: string,
): string {
  return [
    "Hypagraph isolated executor attempt.",
    "Complete only the selected node attempt described by the context envelope.",
    "Return exactly one structured ExecutorResult JSON object as your final assistant message.",
    "Do not return free-form prose as the only final content.",
    "The JSON object must include identity fields that match the context, plus outcome,",
    "facts, evidence, artifacts, summary, diagnostics, and usage.",
    "You may wrap the JSON in a ```json fenced block.",
    `Ownership token: ${ownershipToken}`,
    "Context envelope (JSON):",
    JSON.stringify(context),
  ].join("\n");
}

/**
 * Extract a structured result object from Pi assistant text.
 * Accepts a full JSON object body or a ```json fenced block.
 * Returns { ok:false } when no plain JSON object is present.
 */
export function extractStructuredResultFromAssistantText(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: false,
      message: "The isolated Pi assistant returned no text for the structured result.",
    };
  }
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1]!.trim(), trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    message:
      "The isolated Pi assistant text did not contain a structured JSON result object. "
      + "Raw assistant text is not a valid canonical result.",
  };
}

/**
 * Child-process transport that bootstraps Pi in RPC/JSONL mode.
 *
 * Uses the supported Pi RPC protocol:
 * 1. Host writes { id, type: "prompt", message }
 * 2. Host reads the matching { type: "response", command: "prompt", ... }
 * 3. Host streams events until { type: "agent_settled" }
 * 4. Host writes { id, type: "get_last_assistant_text" }
 * 5. Host extracts a structured ExecutorResult JSON object from assistant text
 *
 * Abort sends { type: "abort" } when the signal fires during the attempt.
 *
 * When the Pi binary is missing, start fails with a clear error. The adapter
 * maps that to outcome "failed" with diagnostic isolated_pi_start_failed.
 *
 * Reply size is enforced incrementally on the stdout stream, not only after
 * a full line is buffered.
 */
export function createChildProcessIsolatedPiTransport(
  options: ChildProcessIsolatedPiTransportOptions = {},
): IsolatedPiProcessTransport {
  const maxReplyBytes = options.maxReplyBytes
    ?? options.maxReplyChars
    ?? DEFAULT_MAX_REPLY_BYTES;
  if (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes < 1) {
    throw new Error(
      "maxReplyBytes must be a positive safe integer.",
    );
  }
  const requireBinary = options.requireBinary ?? true;
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  const terminateForceMs = options.terminateForceMs ?? 1_000;

  return {
    async start(startOptions: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> {
      const piBin = startOptions.piBin
        ?? options.piBin
        ?? process.env[ISOLATED_PI_BIN_ENV]
        ?? ISOLATED_PI_DEFAULT_BIN;

      if (requireBinary && !isNonEmptyString(piBin)) {
        throw new Error(
          `Isolated Pi binary is not configured. Set ${ISOLATED_PI_BIN_ENV} or pass piBin.`,
        );
      }

      const args = options.args ?? ["--mode", "rpc"];
      const env = {
        ...process.env,
        ...startOptions.env,
        HYPAGRAPH_ISOLATED_PI_OWNERSHIP: startOptions.ownershipToken,
        HYPAGRAPH_ISOLATED_PI_ATTEMPT: startOptions.identity.attemptId,
      };

      let child: ChildProcess;
      try {
        child = spawn(piBin, args, {
          cwd: startOptions.cwd,
          env,
          shell: false,
          // stderr is drained below so the child cannot block on a full pipe.
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        throw new Error(errorMessage(error, `Failed to spawn isolated Pi binary '${piBin}'.`));
      }

      let terminated = false;
      let sessionLost = false;
      let lastChildError: Error | undefined;
      let nextRequestId = 1;

      // Attach error listener immediately so missing-binary ENOENT is not uncaught.
      // spawn() with a missing binary does not throw; it emits 'error' asynchronously
      // with pid === undefined.
      child.on("error", (error: Error) => {
        lastChildError = error;
        sessionLost = true;
      });
      child.once("exit", () => {
        sessionLost = true;
      });

      if (child.pid === undefined) {
        // Allow the async ENOENT 'error' event to fire under the listener above.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        throw new Error(
          errorMessage(
            lastChildError,
            `Failed to spawn isolated Pi binary '${piBin}'.`,
          ),
        );
      }

      const piped = child as ChildProcessWithoutNullStreams;
      if (!piped.stdout || !piped.stderr || !piped.stdin) {
        throw new Error(`Failed to spawn isolated Pi binary '${piBin}' (stdio not available).`);
      }

      // sessionId is an id; sessionPath is an optional file path for continuity.
      const sessionId = `pi-rpc-${startOptions.ownershipToken.slice(0, 8)}`;

      // Bounded stderr drain so logs cannot fill the OS pipe and hang the child.
      const stderrChunks: Buffer[] = [];
      const maxStderrBytes = 16_384;
      let stderrBytes = 0;
      piped.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= maxStderrBytes) return;
        const remaining = maxStderrBytes - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      });
      piped.stderr.on("error", () => {
        // Ignore stderr stream errors; they must not throw outside the promise.
      });

      // Keep stdout flowing between spawn and runAttempt so the pipe cannot fill.
      piped.stdout.resume();

      // EPIPE and other stdin errors must not throw as unhandled stream errors.
      piped.stdin.on("error", () => {
        sessionLost = true;
      });

      const writeJsonLine = (payload: unknown): void => {
        const line = `${JSON.stringify(payload)}\n`;
        piped.stdin.write(line);
      };

      const handle: IsolatedPiProcessHandle = {
        pid: child.pid,
        sessionId,
        ownershipToken: startOptions.ownershipToken,
        identity: structuredClone(startOptions.identity),
        async runAttempt(context, signal) {
          if (terminated || sessionLost) {
            const stderrNote = stderrBytes > 0
              ? ` stderr: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`
              : "";
            throw new IsolatedPiSessionLostError(
              `The isolated Pi process is not reachable.${stderrNote}`,
            );
          }
          if (signal.aborted) {
            throw new IsolatedPiSessionLostError(
              "The isolated Pi attempt was aborted before run.",
            );
          }

          const promptId = `hypagraph-prompt-${nextRequestId++}`;
          const textId = `hypagraph-text-${nextRequestId++}`;
          const promptMessage = buildIsolatedPiRpcPrompt(
            context,
            startOptions.ownershipToken,
          );

          return await new Promise<unknown>((resolve, reject) => {
            let settled = false;
            let byteCount = 0;
            let lineBuffer = "";
            let promptAccepted = false;
            let agentSettled = false;
            let awaitingAssistantText = false;
            let abortSent = false;

            const cleanup = (): void => {
              piped.stdout.removeListener("data", onData);
              signal.removeEventListener("abort", onAbort);
              child.removeListener("exit", onExit);
              // Resume draining stdout after the attempt so the pipe stays open.
              piped.stdout.resume();
            };

            const finish = (fn: () => void): void => {
              if (settled) return;
              settled = true;
              cleanup();
              fn();
            };

            const onAbort = (): void => {
              if (!abortSent && !sessionLost && !terminated) {
                abortSent = true;
                try {
                  writeJsonLine({ id: `hypagraph-abort-${nextRequestId++}`, type: "abort" });
                } catch {
                  // best effort
                }
              }
              finish(() => {
                reject(new IsolatedPiSessionLostError(
                  "The isolated Pi attempt was aborted during run.",
                ));
              });
            };

            const onExit = (code: number | null): void => {
              sessionLost = true;
              const stderrNote = stderrBytes > 0
                ? ` stderr: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`
                : "";
              finish(() => {
                reject(new IsolatedPiSessionLostError(
                  `The isolated Pi process exited during the attempt (code ${code ?? "null"}).${stderrNote}`,
                ));
              });
            };

            const requestAssistantText = (): void => {
              if (awaitingAssistantText || settled) return;
              awaitingAssistantText = true;
              try {
                writeJsonLine({ id: textId, type: "get_last_assistant_text" });
              } catch (error) {
                sessionLost = true;
                finish(() => {
                  reject(new IsolatedPiSessionLostError(
                    errorMessage(error, "Failed to request assistant text from isolated Pi."),
                  ));
                });
              }
            };

            const handleParsedLine = (parsed: unknown): void => {
              if (!isStrictPlainObject(parsed)) {
                // Non-object stdout lines are ignored (protocol events must be objects).
                return;
              }
              const record = parsed as Record<string, unknown>;

              if (record.type === "response") {
                if (record.id === promptId) {
                  if (record.success === false) {
                    const errorText = isNonEmptyString(record.error)
                      ? record.error
                      : "The Pi RPC prompt command failed.";
                    finish(() => {
                      resolve({
                        type: "error",
                        code: "isolated_pi_rpc_prompt_failed",
                        message: errorText,
                      });
                    });
                    return;
                  }
                  promptAccepted = true;
                  if (agentSettled) requestAssistantText();
                  return;
                }
                if (record.id === textId) {
                  if (record.success === false) {
                    const errorText = isNonEmptyString(record.error)
                      ? record.error
                      : "The Pi RPC get_last_assistant_text command failed.";
                    finish(() => {
                      resolve({
                        type: "error",
                        code: "isolated_pi_rpc_assistant_text_failed",
                        message: errorText,
                      });
                    });
                    return;
                  }
                  const data = isStrictPlainObject(record.data)
                    ? record.data as Record<string, unknown>
                    : undefined;
                  const text = data && typeof data.text === "string" ? data.text : null;
                  if (text === null) {
                    finish(() => {
                      resolve({
                        type: "error",
                        code: "isolated_pi_rpc_assistant_text_missing",
                        message:
                          "The isolated Pi session returned no assistant text after agent_settled.",
                      });
                    });
                    return;
                  }
                  const extracted = extractStructuredResultFromAssistantText(text);
                  if (!extracted.ok) {
                    finish(() => {
                      resolve({
                        type: "error",
                        code: "isolated_pi_rpc_result_not_structured",
                        message: extracted.message,
                      });
                    });
                    return;
                  }
                  // Echo ownership so parseWorkerReply can verify the host token.
                  if (isStrictPlainObject(extracted.value)) {
                    const value = {
                      ...(extracted.value as Record<string, unknown>),
                    };
                    if (value.ownershipToken === undefined) {
                      value.ownershipToken = startOptions.ownershipToken;
                    }
                    finish(() => resolve(value));
                    return;
                  }
                  finish(() => resolve(extracted.value));
                  return;
                }
                // Unrelated response ids (e.g. abort) are ignored during the attempt.
                return;
              }

              // Events do not carry request ids.
              if (record.type === "agent_settled") {
                agentSettled = true;
                if (promptAccepted) requestAssistantText();
              }
            };

            const onData = (chunk: Buffer): void => {
              byteCount += chunk.length;
              if (byteCount > maxReplyBytes) {
                finish(() => {
                  reject(new Error(
                    `Isolated Pi worker reply exceeded ${maxReplyBytes} bytes.`,
                  ));
                });
                return;
              }
              lineBuffer += chunk.toString("utf8");
              // Pi RPC framing uses LF only; strip optional CR before parse.
              while (true) {
                const newline = lineBuffer.indexOf("\n");
                if (newline < 0) break;
                const rawLine = lineBuffer.slice(0, newline).replace(/\r$/, "");
                lineBuffer = lineBuffer.slice(newline + 1);
                if (rawLine.trim().length === 0) continue;
                let parsed: unknown;
                try {
                  parsed = JSON.parse(rawLine) as unknown;
                } catch {
                  finish(() => {
                    reject(new Error("Isolated Pi worker reply is not valid JSON."));
                  });
                  return;
                }
                handleParsedLine(parsed);
                if (settled) return;
              }
            };

            // on("data") switches from flowing-empty to capture for this attempt.
            piped.stdout.on("data", onData);
            signal.addEventListener("abort", onAbort, { once: true });
            child.once("exit", onExit);

            // If the process already failed, reject without writing.
            if (sessionLost) {
              finish(() => {
                reject(new IsolatedPiSessionLostError(
                  errorMessage(
                    lastChildError,
                    "The isolated Pi process is not reachable.",
                  ),
                ));
              });
              return;
            }

            try {
              writeJsonLine({
                id: promptId,
                type: "prompt",
                message: promptMessage,
              });
            } catch (error) {
              sessionLost = true;
              finish(() => {
                reject(new IsolatedPiSessionLostError(
                  errorMessage(error, "Failed to write Pi RPC prompt to isolated Pi."),
                ));
              });
            }
          });
        },
        async terminate(reason: string) {
          if (terminated) return;
          terminated = true;
          await terminateChildProcessTree(child, {
            graceMs: terminateGraceMs,
            forceMs: terminateForceMs,
            reason,
          });
        },
      };

      return handle;
    },
  };
}

/**
 * Error that signals the child Pi session or process is no longer reachable.
 * The adapter maps this to outcome "interrupted" and diagnostic isolated_pi_session_lost.
 */
export class IsolatedPiSessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolatedPiSessionLostError";
  }
}

/**
 * Terminate a child process tree with bounded wait.
 * Idempotent for already-exited children (exit code or signal code set).
 * forceTimer and a final deadline always resolve so callers cannot hang.
 */
export async function terminateChildProcessTree(
  child: ChildProcess,
  options: { graceMs?: number; forceMs?: number; reason?: string } = {},
): Promise<void> {
  if (childHasExited(child)) return;

  const graceMs = options.graceMs ?? 2_000;
  const forceMs = options.forceMs ?? 1_000;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      child.removeListener("exit", onExit);
      resolve();
    };

    const onExit = (): void => {
      done();
    };

    const forceTimer = setTimeout(() => {
      if (childHasExited(child)) {
        done();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, graceMs);

    // Final bound: resolve even if the process never emits exit after SIGKILL.
    const deadlineTimer = setTimeout(() => {
      done();
    }, graceMs + forceMs);

    child.once("exit", onExit);

    if (childHasExited(child)) {
      done();
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      done();
      return;
    }

    // Race: process may have exited between checks.
    if (childHasExited(child)) {
      done();
    }
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function childHasExited(child: ChildProcess): boolean {
  // exitCode is set for normal exit. signalCode is set when killed by signal.
  // child.killed only records whether this process called kill(); external kill
  // leaves killed false with signalCode set.
  return child.exitCode !== null
    || child.signalCode !== null
    || child.killed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStrictPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function reject(code: string, message: string, location?: string): { ok: false; diagnostics: Diagnostic[] } {
  return {
    ok: false,
    diagnostics: [{ code, message, ...(location ? { location } : {}) }],
  };
}

function defaultSummaryForOutcome(outcome: ExecutorOutcome): string {
  switch (outcome) {
    case "submitted":
      return "The isolated Pi executor submitted a structured result.";
    case "failed":
      return "The isolated Pi executor reported failure.";
    case "cancelled":
      return "The isolated Pi executor cancelled the attempt.";
    case "timed_out":
      return "The isolated Pi executor timed out.";
    case "interrupted":
      return "The isolated Pi executor was interrupted.";
    default:
      return "The isolated Pi executor completed.";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && isNonEmptyString(error.message)) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

function isSessionLossError(error: unknown): boolean {
  return error instanceof IsolatedPiSessionLostError
    || (error instanceof Error && error.name === "IsolatedPiSessionLostError");
}

type ParsedWorkerReply =
  | { kind: "result"; value: Record<string, unknown> }
  | { kind: "worker_error"; code: string; message: string }
  | { kind: "ownership_echo_mismatch" }
  | { kind: "invalid"; message: string };

/**
 * Parse a worker reply.
 * - { type: "error", code, message } → worker_error (distinct from invalid)
 * - { type: "result", result, ownershipToken? } → unwrap result
 * - plain object result → result
 * - optional ownershipToken echo must match the request token when present
 * - raw text / non-objects → invalid
 */
export function parseWorkerReply(value: unknown, ownershipToken: string): ParsedWorkerReply {
  if (typeof value === "string") {
    return {
      kind: "invalid",
      message:
        "The isolated Pi worker returned raw text. "
        + "Raw assistant text is not a valid canonical result.",
    };
  }
  if (!isStrictPlainObject(value)) {
    return {
      kind: "invalid",
      message:
        "The isolated Pi worker did not return a plain object result. "
        + "Raw assistant text is not a valid canonical result.",
    };
  }
  const record = value as Record<string, unknown>;

  if (record.type === "error") {
    const code = isNonEmptyString(record.code) ? record.code : "worker_error";
    const message = isNonEmptyString(record.message)
      ? record.message
      : "The isolated Pi worker reported an error without a message.";
    return { kind: "worker_error", code, message };
  }

  if (record.ownershipToken !== undefined) {
    if (!isNonEmptyString(record.ownershipToken) || record.ownershipToken !== ownershipToken) {
      return { kind: "ownership_echo_mismatch" };
    }
  }

  if (record.type === "result") {
    if (!isStrictPlainObject(record.result)) {
      return {
        kind: "invalid",
        message: "The isolated Pi worker result wrapper requires a plain result object.",
      };
    }
    const nested = record.result as Record<string, unknown>;
    if (nested.ownershipToken !== undefined) {
      if (!isNonEmptyString(nested.ownershipToken) || nested.ownershipToken !== ownershipToken) {
        return { kind: "ownership_echo_mismatch" };
      }
    }
    return { kind: "result", value: nested };
  }

  return { kind: "result", value: record };
}

async function safeTerminate(handle: IsolatedPiProcessHandle, reason: string): Promise<void> {
  try {
    await handle.terminate(reason);
  } catch {
    // Terminate is best-effort. Identity is preserved on the result envelope.
  }
}

/**
 * SIGTERM, bounded grace poll via isPidLive, then SIGKILL if still alive.
 * Matches the shape of terminateChildProcessTree for host-restart fallbacks.
 */
export async function killPidBestEffort(
  pid: number,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const graceMs = options.graceMs ?? 2_000;
  const pollMs = options.pollMs ?? 50;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidLive(pid)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  if (!isPidLive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}
