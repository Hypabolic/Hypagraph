/**
 * ACP (Agent Client Protocol) node executor adapter.
 *
 * Hypagraph is the ACP client. ACP is an execution transport only.
 * It is not the graph, goal-family, scheduler, or memory model.
 *
 * Each attempt creates its own ACP session (session/new). Sessions are not
 * reused across attempts in this slice.
 *
 * Lifecycle:
 * 1. initialize (capability negotiation) and optional authenticate;
 * 2. session/new for this attempt only;
 * 3. session/prompt with the context envelope;
 * 4. session/update notifications as progress (no domain mutation);
 * 5. AbortSignal sends session/cancel and tears down the session;
 * 6. parse agent output into an untrusted plain object;
 * 7. validate with validateExecutorResult; controllers still settle before commit.
 *
 * Cancel-versus-result race:
 * When runAttempt resolves with a value before abort wins Promise.race, the
 * completed result is accepted. Cancellation applies only when abort wins
 * without a completed result.
 *
 * Raw assistant text is evidence or commentary only. It is not a direct node
 * completion. The adapter never mutates graph or family state.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

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
  JsonlUtf8LineReader,
  terminateChildProcessTree,
} from "./child-process-jsonrpc.js";

/** Re-export shared stdio helpers for existing call sites. */
export { JsonlUtf8LineReader, terminateChildProcessTree };

/**
 * Module-private Symbol key for transport signals.
 * Symbols cannot appear in JSON from the agent, so agents cannot forge signals.
 * The string form below is stripped from agent payloads when present.
 */
const ACP_TRANSPORT_SIGNAL = Symbol("hypagraph.acp.transport_signal");

/**
 * Module-private flag: stream agent text was truncated for this attempt reply.
 * Carried on the untrusted return value until parse unwraps the envelope, then
 * applied to the adapter-owned result after validation.
 */
const ACP_STREAM_TEXT_TRUNCATED = Symbol("hypagraph.acp.stream_text_truncated");

/**
 * String key agents may attempt to forge. Always stripped from agent payloads.
 * Not used as a real transport marker.
 */
const ACP_FORGEABLE_SIGNAL_KEY = "__hypagraphAcp";

/** Default JSON-RPC request timeout during session open (initialize / session/new). */
export const DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS = 120_000;

/**
 * @deprecated Use DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS.
 * Kept for call-site compatibility. Does not bound session/prompt turns.
 */
export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS;

/**
 * Default bound for session/prompt turns (30 minutes).
 * A finite default keeps hung turns cancellable and bounded when host teardown
 * is available. Hosts can raise this value or pass promptTimeoutMs per attempt.
 */
export const DEFAULT_ACP_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Profile and identity constants
// ---------------------------------------------------------------------------

/** Stable profile for ACP agent execution. */
export const ACP_PROFILE: ExecutorProfileRef = {
  profileId: "acp-default",
  kind: "acp",
};

export const ACP_EXECUTOR_ID = "acp";
export const ACP_EXECUTOR_VERSION = 1;

/** Protocol major version requested during initialize. */
export const ACP_PROTOCOL_VERSION = 1;

/** Default maximum agent message text buffered for structured result extraction. */
export const DEFAULT_ACP_MAX_AGENT_TEXT_CHARS = 1_048_576;

/** Environment variable for the ACP agent binary path. */
export const ACP_AGENT_BIN_ENV = "ACP_AGENT_BIN";

// ---------------------------------------------------------------------------
// Progress, capabilities, permissions
// ---------------------------------------------------------------------------

/** Negotiated agent capabilities from initialize (subset used by this adapter). */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  /** Opaque remaining capability fields from the agent. Not domain state. */
  raw?: Record<string, unknown>;
}

/** One progress event from session/update. Does not mutate domain state. */
export interface AcpProgressEvent {
  sessionId: string;
  /** Discriminator from the ACP sessionUpdate field when present. */
  kind: string;
  update: Record<string, unknown>;
  atSequence: number;
}

/** Permission request from session/request_permission. */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
  rawParams: Record<string, unknown>;
}

/**
 * Client response to a permission request.
 * Product Pi brokerage can connect interactive UI later. This slice must not hang.
 */
export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type AcpPermissionHandler = (
  request: AcpPermissionRequest,
) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome;

/**
 * Default permission policy for tests and non-interactive hosts.
 * - deny: select a reject_* option when present, else cancel
 * - allow: select an allow_* option when present, else first option
 */
export type AcpPermissionPolicy = "deny" | "allow";

export interface AcpClientHooks {
  /** Optional authenticate after initialize when the agent requires it. */
  authenticate?: (params: {
    agentCapabilities: AcpAgentCapabilities;
    authMethods: unknown[];
  }) => Promise<void> | void;
  /**
   * Permission brokerage for session/request_permission.
   * When omitted, permissionPolicy is used (default deny).
   */
  onPermissionRequest?: AcpPermissionHandler;
  /**
   * Default policy when onPermissionRequest is omitted.
   * Default is deny so tests and headless runs never hang.
   */
  permissionPolicy?: AcpPermissionPolicy;
  /**
   * Optional file-system read_text_file stub. Default rejects with a clear error.
   * Product surfaces can connect a real file-system handler later.
   */
  readTextFile?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * Optional file-system write_text_file stub. Default rejects with a clear error.
   */
  writeTextFile?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  /**
   * Optional elicitation/create stub. Default cancels.
   */
  createElicitation?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// Transport (testable)
// ---------------------------------------------------------------------------

/** Options for opening one per-attempt ACP session. */
export interface AcpOpenSessionOptions {
  identity: ExecutorAttemptIdentity;
  /** Working directory for session/new. Absolute path preferred. */
  cwd?: string;
  /** Extra environment when the transport spawns an agent process. */
  env?: Record<string, string>;
  /** Agent binary path for process transports. */
  agentBin?: string;
  /** Extra spawn arguments. */
  agentArgs?: string[];
  /** Client hooks for permission and optional file system / elicitation. */
  hooks?: AcpClientHooks;
  /**
   * AbortSignal for session open (initialize / session/new).
   * When aborted, openSession must reject without hanging.
   */
  signal?: AbortSignal;
  /**
   * Bound for handshake JSON-RPC requests (initialize / session/new).
   * Must be a positive safe integer when present.
   * Default is DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS.
   */
  openRequestTimeoutMs?: number;
  /**
   * Bound for session/prompt turns.
   * When omitted, the transport uses DEFAULT_ACP_PROMPT_TIMEOUT_MS (30 minutes).
   * Hosts that need a longer turn must pass a larger positive safe integer.
   * There is no unbounded opt-out.
   */
  promptTimeoutMs?: number;
  /**
   * @deprecated Use openRequestTimeoutMs. Accepted as an alias for open only.
   */
  requestTimeoutMs?: number;
}

/** Hooks attached to one runAttempt call. */
export interface AcpRunAttemptHooks {
  onProgress?: (event: AcpProgressEvent) => void;
}

/**
 * Handle for one ACP session (one attempt).
 * Process-side session metadata is not canonical domain state.
 */
export interface AcpSessionHandle {
  readonly sessionId: string;
  readonly agentCapabilities: AcpAgentCapabilities;
  /**
   * Send session/prompt for the context envelope.
   * Returns an untrusted plain object (or structured agent reply) for validation.
   */
  runAttempt(
    context: ExecutorContextEnvelope,
    signal: AbortSignal,
    hooks?: AcpRunAttemptHooks,
  ): Promise<unknown>;
  /** Send session/cancel. Idempotent. */
  cancel(): Promise<void>;
  /** Tear down the session and underlying connection. Idempotent. */
  close(reason: string): Promise<void>;
}

/** Injectable ACP transport for production and tests. */
export interface AcpTransport {
  /**
   * Connect, initialize, optional authenticate, and session/new.
   * Each call creates a new attempt-local session.
   */
  openSession(options: AcpOpenSessionOptions): Promise<AcpSessionHandle>;
}

// ---------------------------------------------------------------------------
// Process-side session registry (not domain schema)
// ---------------------------------------------------------------------------

/** One host-owned ACP session record. Not persisted in the domain reducer. */
export interface OwnedAcpSessionRecord {
  sessionToken: string;
  sessionId?: string;
  identity: ExecutorAttemptIdentity;
  startedAt: string;
  live: boolean;
}

/**
 * Why the host terminated an owned ACP session.
 * Classification of cancelled vs interrupted uses this kind, not free-text reason.
 */
export type AcpHostTeardownKind = "restore" | "branch" | "user" | "other";

/** Tombstone left after host-initiated teardown so in-flight execute can map outcome. */
export interface AcpHostTeardownTombstone {
  sessionToken: string;
  kind: AcpHostTeardownKind;
  /** Human-readable reason for diagnostics. Not used for outcome classification. */
  reason: string;
}

/** Failure shape returned by ACP registry operations. */
export type AcpRegistryFailure = {
  ok: false;
  code: string;
  message: string;
  hostTeardown?: AcpHostTeardownTombstone;
};

/**
 * Host-side registry of in-flight ACP sessions.
 * Supports host teardown tombstones so in-flight execute maps restore/branch to
 * interrupted and user/other to cancelled. Does not store canonical attempt context.
 */
export class AcpSessionRegistry {
  private readonly records = new Map<string, OwnedAcpSessionRecord>();
  private readonly closers = new Map<string, (reason: string) => Promise<void>>();
  private readonly hostTeardowns = new Map<string, AcpHostTeardownTombstone>();
  private readonly activeExecuteTokens = new Set<string>();

  register(
    record: OwnedAcpSessionRecord,
  ): { ok: true } | AcpRegistryFailure {
    if (this.records.has(record.sessionToken)) {
      return {
        ok: false,
        code: "acp_session_token_duplicate",
        message: `Session token '${record.sessionToken}' is already registered.`,
      };
    }
    const existingTeardown = this.hostTeardowns.get(record.sessionToken);
    if (existingTeardown) {
      return {
        ok: false,
        code: "acp_host_teardown",
        message: existingTeardown.reason,
        hostTeardown: structuredClone(existingTeardown),
      };
    }
    this.records.set(record.sessionToken, {
      ...record,
      identity: structuredClone(record.identity),
    });
    return { ok: true };
  }

  update(
    sessionToken: string,
    patch: Partial<Pick<OwnedAcpSessionRecord, "sessionId" | "live" | "startedAt">>,
  ): { ok: true; record: OwnedAcpSessionRecord } | AcpRegistryFailure {
    const record = this.records.get(sessionToken);
    if (!record) {
      const teardown = this.hostTeardowns.get(sessionToken);
      if (teardown) {
        return {
          ok: false,
          code: "acp_host_teardown",
          message: teardown.reason,
          hostTeardown: structuredClone(teardown),
        };
      }
      return {
        ok: false,
        code: "acp_session_token_unknown",
        message: `Session token '${sessionToken}' is not registered.`,
      };
    }
    if (patch.sessionId !== undefined) record.sessionId = patch.sessionId;
    if (patch.live !== undefined) record.live = patch.live;
    if (patch.startedAt !== undefined) record.startedAt = patch.startedAt;
    return { ok: true, record: structuredClone(record) };
  }

  setCloser(sessionToken: string, close: (reason: string) => Promise<void>): void {
    if (!this.records.has(sessionToken) && !this.hostTeardowns.has(sessionToken)) return;
    this.closers.set(sessionToken, close);
  }

  get(sessionToken: string): OwnedAcpSessionRecord | undefined {
    const record = this.records.get(sessionToken);
    return record ? structuredClone(record) : undefined;
  }

  getHostTeardown(sessionToken: string): AcpHostTeardownTombstone | undefined {
    const tombstone = this.hostTeardowns.get(sessionToken);
    return tombstone ? structuredClone(tombstone) : undefined;
  }

  clearHostTeardown(sessionToken: string): void {
    this.hostTeardowns.delete(sessionToken);
    this.closers.delete(sessionToken);
  }

  noteExecuteStarted(sessionToken: string): void {
    this.activeExecuteTokens.add(sessionToken);
  }

  noteExecuteFinished(sessionToken: string): void {
    this.activeExecuteTokens.delete(sessionToken);
    this.clearHostTeardown(sessionToken);
  }

  list(): OwnedAcpSessionRecord[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.sessionToken.localeCompare(right.sessionToken));
  }

  hasActive(): boolean {
    return [...this.records.values()].some((record) => record.live);
  }

  activeCount(): number {
    return [...this.records.values()].filter((record) => record.live).length;
  }

  markNotLive(sessionToken: string): void {
    const record = this.records.get(sessionToken);
    if (!record) return;
    record.live = false;
  }

  unregister(sessionToken: string): void {
    this.records.delete(sessionToken);
    this.closers.delete(sessionToken);
  }

  /**
   * Close one owned session and leave a host-teardown tombstone for in-flight execute.
   */
  async closeOwned(
    sessionToken: string,
    input: { reason: string; kind: AcpHostTeardownKind },
  ): Promise<boolean> {
    const record = this.records.get(sessionToken);
    const existingTeardown = this.hostTeardowns.get(sessionToken);
    if (!record && !existingTeardown) return false;

    this.hostTeardowns.set(sessionToken, {
      sessionToken,
      kind: input.kind,
      reason: input.reason,
    });
    const closer = this.closers.get(sessionToken);
    if (closer) {
      try {
        await closer(input.reason);
      } catch {
        // best effort
      }
    }
    if (record) {
      this.markNotLive(sessionToken);
      this.unregister(sessionToken);
    }
    if (!this.activeExecuteTokens.has(sessionToken)) {
      this.clearHostTeardown(sessionToken);
    }
    return true;
  }

  /**
   * Close every owned session. Used on session restore and branch change.
   * Ages out tombstones that have no active execute after the pass.
   * Callers must pass kind so restore/branch are not misclassified as cancel.
   */
  async closeAll(input: { reason: string; kind: AcpHostTeardownKind }): Promise<number> {
    const tokens = this.list().map((record) => record.sessionToken);
    let count = 0;
    for (const token of tokens) {
      const done = await this.closeOwned(token, input);
      if (done) count += 1;
    }
    for (const token of [...this.hostTeardowns.keys()]) {
      if (!this.activeExecuteTokens.has(token)) {
        this.clearHostTeardown(token);
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

export interface BuildAcpResultPayloadInput {
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
 */
export function buildAcpResultPayload(
  input: BuildAcpResultPayloadInput,
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
export function clampAcpDiagnostics(
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
    code: "acp_diagnostics_truncated",
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
export function normalizeAcpUsage(usage: unknown): ExecutorUsage {
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
 * Preserves canonical identity when the ACP session is lost.
 */
export function resultFromAcpContext(
  context: ExecutorContextEnvelope,
  outcome: ExecutorOutcome,
  diagnostics: ExecutorDiagnostic[],
  summary?: string,
  usage?: ExecutorUsage,
): ExecutorResult {
  const maxDiagnostics = context.resultProtocol?.maxDiagnostics ?? 64;
  const maxSummaryChars = context.resultProtocol?.maxSummaryChars ?? 4096;
  const clamped = clampAcpDiagnostics(diagnostics, maxDiagnostics);
  const safeUsage = normalizeAcpUsage(usage ?? {});
  const rawSummary = isNonEmptyString(summary)
    ? summary
    : defaultSummaryForOutcome(outcome);
  // Clamp before first validation so oversized summaries do not force fallback.
  const safeSummary = rawSummary.slice(0, maxSummaryChars);

  const payload = buildAcpResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: clamped,
    usage: safeUsage,
  });

  const validated = validateExecutorResult(context, payload);
  if (validated.ok) return validated.value;

  const minimalDiagnostics = clampAcpDiagnostics(
    [{
      code: "acp_result_construction_failed",
      message:
        "The ACP executor could not build a fully validated failure result. "
        + "Identity is preserved from the context envelope.",
    }],
    maxDiagnostics,
  );
  const minimalPayload = buildAcpResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: minimalDiagnostics,
    usage: {},
  });
  const minimalValidated = validateExecutorResult(context, minimalPayload);
  if (minimalValidated.ok) return minimalValidated.value;

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
    summary: safeSummary,
    // When maxDiagnostics is 0, emit an empty list (never invent a diagnostic).
    diagnostics: maxDiagnostics === 0 ? [] : (
      minimalDiagnostics.length > 0
        ? minimalDiagnostics
        : [{
          code: "acp_result_construction_failed",
          message: "The ACP executor could not build a validated failure result.",
        }]
    ),
    usage: {},
  };
}

// ---------------------------------------------------------------------------
// Context materialization
// ---------------------------------------------------------------------------

export interface MaterializeAcpContextInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  /** Defaults to ACP_PROFILE. */
  profile?: ExecutorProfileRef;
  rootObjective?: string;
}

/**
 * Materialize an ACP context envelope for one running attempt.
 * Returns diagnostics when the family, state, or identity is incomplete.
 */
export function materializeAcpContext(
  input: MaterializeAcpContextInput,
): MaterializeExecutorContextResult {
  if (!isNonEmptyString(input.nodeId)) {
    return reject(
      "acp_invalid_node",
      "ACP context requires a non-empty nodeId.",
      "nodeId",
    );
  }
  if (!isNonEmptyString(input.attemptId)) {
    return reject(
      "acp_invalid_attempt",
      "ACP context requires a non-empty attemptId.",
      "attemptId",
    );
  }

  const goalId = input.state.goal?.goalId;
  if (!isNonEmptyString(goalId)) {
    return reject(
      "acp_goal_missing",
      "ACP context requires a started goal runtime on the workflow state.",
      "state.goal",
    );
  }

  const familyId = input.family.familyId;
  if (!isNonEmptyString(familyId)) {
    return reject(
      "acp_family_missing",
      "ACP context requires a non-empty familyId.",
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

  const profile = input.profile ?? ACP_PROFILE;
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

export interface CreateAcpExecutorOptions {
  transport: AcpTransport;
  /** Host-side session registry. Defaults to a new registry. */
  registry?: AcpSessionRegistry;
  /**
   * Produce a session token for each attempt registration.
   * Defaults to a collision-proof random token. Injectable for tests.
   */
  createSessionToken?: (context: ExecutorContextEnvelope) => string;
  /**
   * Pure started-at timestamp supplier for registry records.
   * Defaults to a fixed placeholder; hosts must inject wall-clock when needed.
   */
  startedAt?: () => string;
  /** Working directory for session/new. */
  resolveCwd?: (context: ExecutorContextEnvelope) => string | undefined;
  /** Optional extra environment for process transports. */
  resolveEnv?: (context: ExecutorContextEnvelope) => Record<string, string> | undefined;
  /** Optional agent binary override. */
  resolveAgentBin?: (context: ExecutorContextEnvelope) => string | undefined;
  /** Optional agent args override. */
  resolveAgentArgs?: (context: ExecutorContextEnvelope) => string[] | undefined;
  /** Client hooks shared by all attempts from this executor. */
  hooks?: AcpClientHooks;
  /**
   * Progress callback for session/update events.
   * Does not mutate domain state. Useful for tests and host projection.
   */
  onProgress?: (event: AcpProgressEvent) => void;
  /**
   * Bound for handshake JSON-RPC requests (initialize / session/new).
   * Default is DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS.
   */
  openRequestTimeoutMs?: number;
  /**
   * Bound for session/prompt turns.
   * Default is DEFAULT_ACP_PROMPT_TIMEOUT_MS (30 minutes).
   * Hosts that need a longer turn must pass a larger positive safe integer.
   * When the bound is reached, the outcome is timed_out.
   * There is no unbounded opt-out.
   */
  promptTimeoutMs?: number;
  /**
   * @deprecated Use openRequestTimeoutMs. Alias for open handshake only.
   */
  requestTimeoutMs?: number;
}

/**
 * Create an ACP NodeExecutor.
 *
 * Lifecycle:
 * 1. Durable attempt identity comes from the context envelope.
 * 2. Open a per-attempt ACP session (initialize + session/new).
 * 3. AbortSignal cancels the session when abort wins without a completed result.
 * 4. Parse agent output into a plain object for validateExecutorResult.
 * 5. Close the session after the attempt.
 * 6. Session loss maps to interrupted with identity from the envelope.
 *
 * execute always returns ExecutorResult for normal failure modes.
 * Controllers must still call settleExecutorResult before commit.
 */
export function createAcpExecutor(
  options: CreateAcpExecutorOptions,
): NodeExecutor {
  const registry = options.registry ?? new AcpSessionRegistry();
  const createSessionToken = options.createSessionToken
    ?? ((context: ExecutorContextEnvelope) =>
      `acp-${context.identity.attemptId}-${randomUUID()}`);
  const startedAt = options.startedAt ?? (() => "1970-01-01T00:00:00.000Z");
  const resolveCwd = options.resolveCwd;
  const resolveEnv = options.resolveEnv;
  const resolveAgentBin = options.resolveAgentBin;
  const resolveAgentArgs = options.resolveAgentArgs;
  const sharedHooks = options.hooks;
  const onProgress = options.onProgress;
  const openRequestTimeoutMs = options.openRequestTimeoutMs
    ?? options.requestTimeoutMs;
  // Finite default so hung turns cannot run without a wall-clock bound.
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_ACP_PROMPT_TIMEOUT_MS;

  return {
    id: ACP_EXECUTOR_ID,
    version: ACP_EXECUTOR_VERSION,
    async execute(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<ExecutorResult> {
      if (context.profile.kind !== "acp") {
        return resultFromAcpContext(context, "failed", [{
          code: "acp_profile_mismatch",
          message:
            `ACP executor requires profile kind 'acp', got '${context.profile.kind}'.`,
          location: "context.profile.kind",
        }]);
      }

      if (signal.aborted) {
        return resultFromAcpContext(context, "cancelled", [{
          code: "acp_aborted_before_start",
          message: "The ACP executor was aborted before session open.",
        }]);
      }

      let sessionToken: string;
      let cwd: string | undefined;
      let env: Record<string, string> | undefined;
      let agentBin: string | undefined;
      let agentArgs: string[] | undefined;
      let startedAtValue: string;
      try {
        sessionToken = createSessionToken(context);
        if (!isNonEmptyString(sessionToken)) {
          return resultFromAcpContext(context, "failed", [{
            code: "acp_invalid_session_token",
            message: "createSessionToken must return a non-empty string.",
          }]);
        }
        cwd = resolveCwd?.(context);
        env = resolveEnv?.(context);
        agentBin = resolveAgentBin?.(context);
        agentArgs = resolveAgentArgs?.(context);
        startedAtValue = startedAt();
        if (!isNonEmptyString(startedAtValue)) {
          return resultFromAcpContext(context, "failed", [{
            code: "acp_host_setup_failed",
            message: "startedAt must return a non-empty string.",
          }]);
        }
      } catch (error) {
        return resultFromAcpContext(context, "failed", [{
          code: "acp_host_setup_failed",
          message: errorMessage(
            error,
            "ACP host setup failed before session open.",
          ),
        }]);
      }

      const registration = registry.register({
        sessionToken,
        identity: structuredClone(context.identity),
        live: true,
        startedAt: startedAtValue,
      });
      if (!registration.ok) {
        if (registration.code === "acp_host_teardown" && registration.hostTeardown) {
          return resultFromAcpHostTeardown(context, registration.hostTeardown);
        }
        return resultFromAcpContext(context, "failed", [{
          code: registration.code,
          message: registration.message,
        }]);
      }

      registry.noteExecuteStarted(sessionToken);

      let handle: AcpSessionHandle | undefined;
      registry.setCloser(sessionToken, async (reason) => {
        if (handle) await safeClose(handle, reason);
      });

      let abortListener: (() => void) | undefined;
      let closedForAbort = false;
      let alreadyClosed = false;

      try {
        try {
          handle = await options.transport.openSession({
            identity: structuredClone(context.identity),
            signal,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(agentBin !== undefined ? { agentBin } : {}),
            ...(agentArgs !== undefined ? { agentArgs } : {}),
            ...(sharedHooks !== undefined ? { hooks: sharedHooks } : {}),
            ...(openRequestTimeoutMs !== undefined
              ? { openRequestTimeoutMs }
              : {}),
            promptTimeoutMs,
          });
        } catch (error) {
          const teardown = registry.getHostTeardown(sessionToken);
          registry.unregister(sessionToken);
          if (teardown) {
            return resultFromAcpHostTeardown(context, teardown);
          }
          if (signal.aborted || isAbortError(error)) {
            return resultFromAcpContext(context, "cancelled", [{
              code: "acp_cancelled",
              message: errorMessage(error, "The ACP session open was aborted."),
            }]);
          }
          if (isSessionLossError(error)) {
            return resultFromAcpContext(context, "interrupted", [{
              code: "acp_session_lost",
              message: errorMessage(error, "The ACP session was lost during open."),
            }]);
          }
          if (isAcpOpenError(error)) {
            return resultFromAcpContext(context, "failed", [{
              code: error.code,
              message: error.message,
            }]);
          }
          if (isRequestTimeoutError(error)) {
            return resultFromAcpContext(context, "failed", [{
              code: "acp_open_request_timeout",
              message: errorMessage(error, "ACP request timed out during session open."),
            }]);
          }
          return resultFromAcpContext(context, "failed", [{
            code: "acp_open_session_failed",
            message: errorMessage(error, "ACP session open failed."),
          }]);
        }

        const updated = registry.update(sessionToken, {
          sessionId: handle.sessionId,
          live: true,
        });
        if (!updated.ok) {
          await safeClose(handle, updated.code);
          if (updated.code === "acp_host_teardown" && updated.hostTeardown) {
            return resultFromAcpHostTeardown(context, updated.hostTeardown);
          }
          registry.unregister(sessionToken);
          return resultFromAcpContext(context, "failed", [{
            code: updated.code,
            message: updated.message,
          }]);
        }

        registry.setCloser(sessionToken, (reason) => safeClose(handle!, reason));

        if (signal.aborted) {
          const teardownOnAbort = registry.getHostTeardown(sessionToken);
          if (teardownOnAbort) {
            alreadyClosed = true;
            await safeCancelAndClose(handle, "host_teardown");
            return resultFromAcpHostTeardown(context, teardownOnAbort);
          }
          closedForAbort = true;
          alreadyClosed = true;
          await safeCancelAndClose(handle, "aborted");
          return resultFromAcpContext(context, "cancelled", [{
            code: "acp_cancelled",
            message: "The ACP executor was aborted after session open.",
          }]);
        }

        const abortPromise = new Promise<"aborted">((resolveAbort) => {
          abortListener = () => resolveAbort("aborted");
          signal.addEventListener("abort", abortListener, { once: true });
        });

        const runHooks: AcpRunAttemptHooks = {
          onProgress: (event) => {
            try {
              onProgress?.(event);
            } catch {
              // Progress callbacks must not break the attempt.
            }
          },
        };

        const runPromise = handle.runAttempt(context, signal, runHooks).then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );

        const raced = await Promise.race([
          runPromise,
          abortPromise.then((kind) => ({ kind })),
        ]);

        // Completed result wins over concurrent abort.
        if (raced.kind === "result") {
          const untrusted = parseAcpAgentReply(raced.value);
          if (untrusted.kind === "transport_error") {
            alreadyClosed = true;
            await safeClose(handle, "transport_error");
            // True transport signals keep adapter-owned diagnostic codes.
            return resultFromAcpContext(context, "failed", [{
              code: untrusted.code,
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "cancelled_stop") {
            alreadyClosed = true;
            await safeClose(handle, "cancelled_stop");
            return resultFromAcpContext(context, "cancelled", [{
              code: "acp_stop_reason_cancelled",
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "invalid") {
            alreadyClosed = true;
            await safeClose(handle, "invalid_reply");
            return resultFromAcpContext(context, "failed", [{
              code: "acp_invalid_agent_result",
              message: untrusted.message,
            }]);
          }

          const validated = validateExecutorResult(context, untrusted.value);
          if (!validated.ok) {
            alreadyClosed = true;
            await safeClose(handle, "validation_failed");
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
                code: "acp_stale_result",
                message:
                  "Agent result identity does not match the context envelope. Result rejected.",
              });
            }
            return resultFromAcpContext(
              context,
              "failed",
              diagnostics,
              "ACP agent result failed validation.",
              normalizeAcpUsage(
                isStrictPlainObject(untrusted.value)
                  ? (untrusted.value as Record<string, unknown>).usage
                  : {},
              ),
            );
          }

          alreadyClosed = true;
          await safeClose(handle, "settled");
          // Attach non-fatal truncation note on the adapter-owned result only,
          // after unwrap and successful validation. Respects maxDiagnostics.
          if (untrusted.streamTextTruncated) {
            const maxDiagnostics = context.resultProtocol?.maxDiagnostics ?? 64;
            return mergeTruncationDiagnostic(validated.value, maxDiagnostics);
          }
          return validated.value;
        }

        if (raced.kind === "aborted" || signal.aborted) {
          const hostTeardownOnAbort = registry.getHostTeardown(sessionToken);
          if (hostTeardownOnAbort) {
            closedForAbort = true;
            alreadyClosed = true;
            await safeCancelAndClose(handle, "host_teardown");
            return resultFromAcpHostTeardown(context, hostTeardownOnAbort);
          }
          closedForAbort = true;
          alreadyClosed = true;
          await safeCancelAndClose(handle, "cancelled");
          return resultFromAcpContext(context, "cancelled", [{
            code: "acp_cancelled",
            message: "The ACP attempt was cancelled by AbortSignal.",
          }]);
        }

        // raced.kind === "error"
        const hostTeardown = registry.getHostTeardown(sessionToken);
        if (hostTeardown) {
          alreadyClosed = true;
          await safeClose(handle, "host_teardown");
          return resultFromAcpHostTeardown(context, hostTeardown);
        }
        const message = errorMessage(raced.error, "ACP agent failed.");
        let code = "acp_transport_error";
        let outcome: ExecutorOutcome = "failed";
        if (isSessionLossError(raced.error)) {
          code = "acp_session_lost";
          outcome = "interrupted";
        } else if (isPromptTimeoutError(raced.error)) {
          code = "acp_prompt_timeout";
          outcome = "timed_out";
        } else if (isRequestTimeoutError(raced.error)) {
          code = "acp_open_request_timeout";
          outcome = "failed";
        }
        alreadyClosed = true;
        await safeClose(handle, code);
        return resultFromAcpContext(context, outcome, [{ code, message }]);
      } finally {
        if (abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
        if (!closedForAbort && !alreadyClosed && handle) {
          await safeClose(handle, "cleanup");
        }
        registry.markNotLive(sessionToken);
        registry.unregister(sessionToken);
        registry.noteExecuteFinished(sessionToken);
      }
    },
  };
}

/**
 * Host-initiated teardown (session restore / branch change / user cancel).
 * Outcome classification uses tombstone.kind only.
 * - restore | branch → interrupted
 * - user | other → cancelled
 */
function resultFromAcpHostTeardown(
  context: ExecutorContextEnvelope,
  tombstone: Pick<AcpHostTeardownTombstone, "kind" | "reason">,
): ExecutorResult {
  const interrupted = tombstone.kind === "restore" || tombstone.kind === "branch";
  let summary: string;
  if (tombstone.kind === "restore") {
    summary = "The host interrupted the ACP attempt during session restore.";
  } else if (tombstone.kind === "branch") {
    summary = "The host interrupted the ACP attempt during a branch change.";
  } else {
    summary = "The host cancelled the ACP attempt.";
  }
  return resultFromAcpContext(
    context,
    interrupted ? "interrupted" : "cancelled",
    [{
      code: "acp_host_teardown",
      message: tombstone.reason,
      location: `hostTeardown.kind:${tombstone.kind}`,
    }],
    summary,
  );
}

/**
 * Run one ACP attempt and settle the result with the shared path.
 * Maps thrown execute errors to { ok: false, diagnostics }.
 */
export async function executeAndSettleAcp(
  executor: NodeExecutor,
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
  meta: SettleExecutorResultMeta,
): Promise<SettleExecutorResultResult> {
  if (context.profile.kind !== "acp") {
    return {
      ok: false,
      diagnostics: [{
        code: "acp_profile_mismatch",
        message:
          `executeAndSettleAcp requires profile kind 'acp', got '${context.profile.kind}'.`,
        location: "context.profile.kind",
      }],
    };
  }
  let raw: unknown;
  try {
    raw = await executor.execute(context, signal);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "acp_execute_threw",
        message: errorMessage(error, "The ACP executor threw during execute."),
      }],
    };
  }
  return settleExecutorResult(context, raw, meta);
}

/**
 * Settle an untrusted payload against an already materialized ACP context.
 */
export function settleAcpResult(
  context: ExecutorContextEnvelope,
  untrustedResult: unknown,
  meta: SettleExecutorResultMeta,
): SettleExecutorResultResult {
  return settleExecutorResult(context, untrustedResult, meta);
}

// ---------------------------------------------------------------------------
// Prompt and structured-result extraction
// ---------------------------------------------------------------------------

/**
 * Build the ACP session/prompt text for one attempt.
 * The agent must return a structured ExecutorResult JSON object as final text.
 */
export function buildAcpPromptText(context: ExecutorContextEnvelope): string {
  return [
    "Hypagraph ACP executor attempt.",
    "Complete only the selected node attempt described by the context envelope.",
    "Return exactly one structured ExecutorResult JSON object as your final assistant message.",
    "Do not return free-form prose as the only final content.",
    "The JSON object must include identity fields that match the context, plus outcome,",
    "facts, evidence, artifacts, summary, diagnostics, and usage.",
    "You may wrap the JSON in a ```json fenced block.",
    "Context envelope (JSON):",
    JSON.stringify(context),
  ].join("\n");
}

/**
 * Extract a structured result object from agent assistant text.
 * Accepts a full JSON object body or a ```json fenced block.
 * Returns { ok:false } when no plain JSON object is present.
 */
export function extractStructuredResultFromAgentText(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      ok: false,
      message: "The ACP agent returned no text for the structured result.",
    };
  }
  const trimmed = text.trim();
  // Collect every fenced block. Prefer the last parseable plain object so
  // narration fences do not hide a final structured result.
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const fencedBodies = fenceMatches.map((match) => match[1]!.trim());
  // Try fences from last to first, then the whole text.
  const candidates = [...fencedBodies].reverse();
  candidates.push(trimmed);
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isStrictPlainObject(parsed)) {
        return { ok: true, value: parsed };
      }
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    message:
      "The ACP agent text did not contain a structured JSON result object. "
      + "Raw assistant text is not a valid canonical result.",
  };
}

/**
 * Resolve a default permission outcome without interactive UI.
 * Prefer matching kind prefixes. Fall back to cancel when no option matches.
 */
export function resolveDefaultPermissionOutcome(
  options: Array<{ optionId: string; name: string; kind: string }>,
  policy: AcpPermissionPolicy,
): AcpPermissionOutcome {
  if (options.length === 0) {
    return { outcome: "cancelled" };
  }
  if (policy === "allow") {
    const allowAlways = options.find((item) => item.kind === "allow_always");
    if (allowAlways) return { outcome: "selected", optionId: allowAlways.optionId };
    const allowOnce = options.find((item) => item.kind === "allow_once");
    if (allowOnce) return { outcome: "selected", optionId: allowOnce.optionId };
    return { outcome: "selected", optionId: options[0]!.optionId };
  }
  // deny
  const rejectAlways = options.find((item) => item.kind === "reject_always");
  if (rejectAlways) return { outcome: "selected", optionId: rejectAlways.optionId };
  const rejectOnce = options.find((item) => item.kind === "reject_once");
  if (rejectOnce) return { outcome: "selected", optionId: rejectOnce.optionId };
  return { outcome: "cancelled" };
}

// ---------------------------------------------------------------------------
// Fake transport (tests)
// ---------------------------------------------------------------------------

export interface FakeAcpTransportOptions {
  /**
   * Produce the untrusted agent reply for a runAttempt call.
   * May throw AcpSessionLostError to simulate transport death.
   */
  runAttempt: (
    context: ExecutorContextEnvelope,
    signal: AbortSignal,
    handle: AcpSessionHandle,
    hooks?: AcpRunAttemptHooks,
  ) => Promise<unknown>;
  /** Optional open-session hook. Defaults to a synthetic session id. */
  onOpenSession?: (options: AcpOpenSessionOptions) => void | Promise<void>;
  /** When true or a message, openSession rejects. */
  failOpen?: boolean | string;
  /** Fixed session id. Defaults to a token-derived id. */
  sessionId?: string;
  /** Negotiated capabilities returned on the handle. */
  agentCapabilities?: AcpAgentCapabilities;
  /**
   * Optional progress events to emit before runAttempt resolves.
   * Useful for testing the progress callback surface.
   */
  progressEvents?: Array<Omit<AcpProgressEvent, "sessionId" | "atSequence"> & {
    sessionId?: string;
    atSequence?: number;
  }>;
}

/**
 * In-memory ACP transport for tests. Does not spawn a real agent.
 */
export function createFakeAcpTransport(
  options: FakeAcpTransportOptions,
): AcpTransport & {
  closes: Array<{ sessionId: string; reason: string }>;
  cancels: Array<{ sessionId: string }>;
  opened: AcpOpenSessionOptions[];
} {
  const closes: Array<{ sessionId: string; reason: string }> = [];
  const cancels: Array<{ sessionId: string }> = [];
  const opened: AcpOpenSessionOptions[] = [];
  let openSequence = 0;

  return {
    closes,
    cancels,
    opened,
    async openSession(startOptions: AcpOpenSessionOptions): Promise<AcpSessionHandle> {
      if (options.failOpen) {
        const message = typeof options.failOpen === "string"
          ? options.failOpen
          : "Fake ACP transport failed to open a session.";
        throw new Error(message);
      }
      if (startOptions.signal?.aborted) {
        throw new AcpAbortError("The ACP session open was aborted before start.");
      }
      await options.onOpenSession?.(startOptions);
      // Clone non-function fields only. Hooks keep their reference.
      opened.push(cloneOpenSessionOptions(startOptions));

      openSequence += 1;
      const sessionId = options.sessionId
        ?? `acp-sess-${startOptions.identity.attemptId}-${openSequence}`;
      let cancelled = false;
      let closed = false;
      let cancelSent = false;
      const agentCapabilities = options.agentCapabilities ?? {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      };

      const handle: AcpSessionHandle = {
        sessionId,
        agentCapabilities,
        async runAttempt(context, signal, hooks) {
          if (closed) {
            throw new AcpSessionLostError(
              "The ACP session was already closed.",
            );
          }
          if (cancelled) {
            throw new AcpSessionLostError(
              "The ACP session was cancelled before run.",
            );
          }
          if (signal.aborted) {
            throw new AcpSessionLostError(
              "The ACP attempt was aborted before run.",
            );
          }

          const progressList = options.progressEvents ?? [];
          let sequence = 0;
          for (const item of progressList) {
            sequence += 1;
            const event: AcpProgressEvent = {
              sessionId: item.sessionId ?? sessionId,
              kind: item.kind,
              update: structuredClone(item.update),
              atSequence: item.atSequence ?? sequence,
            };
            hooks?.onProgress?.(event);
          }

          return options.runAttempt(context, signal, handle, hooks);
        },
        async cancel() {
          if (closed) return;
          if (cancelSent) return;
          cancelSent = true;
          cancelled = true;
          cancels.push({ sessionId });
        },
        async close(reason: string) {
          if (closed) return;
          closed = true;
          closes.push({ sessionId, reason });
        },
      };
      return handle;
    },
  };
}

/**
 * Clone open-session options without cloning function-valued hooks.
 * structuredClone throws DataCloneError on functions.
 */
function cloneOpenSessionOptions(options: AcpOpenSessionOptions): AcpOpenSessionOptions {
  const cloned: AcpOpenSessionOptions = {
    identity: structuredClone(options.identity),
  };
  if (options.cwd !== undefined) cloned.cwd = options.cwd;
  if (options.env !== undefined) cloned.env = structuredClone(options.env);
  if (options.agentBin !== undefined) cloned.agentBin = options.agentBin;
  if (options.agentArgs !== undefined) cloned.agentArgs = [...options.agentArgs];
  if (options.hooks !== undefined) cloned.hooks = options.hooks;
  if (options.signal !== undefined) cloned.signal = options.signal;
  if (options.openRequestTimeoutMs !== undefined) {
    cloned.openRequestTimeoutMs = options.openRequestTimeoutMs;
  }
  if (options.promptTimeoutMs !== undefined) cloned.promptTimeoutMs = options.promptTimeoutMs;
  if (options.requestTimeoutMs !== undefined) cloned.requestTimeoutMs = options.requestTimeoutMs;
  return cloned;
}

// ---------------------------------------------------------------------------
// Production-shaped stdio JSON-RPC transport
// ---------------------------------------------------------------------------

/**
 * Minimal process shape used by the ACP stdio transport.
 * Production uses child_process.spawn. Tests inject a scripted duplex process.
 */
export interface AcpSpawnedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "exit", listener: (...args: unknown[]) => void): this;
}

export interface ChildProcessAcpTransportOptions {
  /** Agent binary path. Defaults to process.env.ACP_AGENT_BIN. */
  agentBin?: string;
  /** Extra spawn arguments after the binary. */
  args?: string[];
  /** Maximum agent message text buffered for result extraction. */
  maxAgentTextChars?: number;
  /** When true, open fails if the binary path is empty. Default true. */
  requireBinary?: boolean;
  /** Client hooks for permission and optional file system / elicitation. */
  hooks?: AcpClientHooks;
  /** Client info advertised during initialize. */
  clientInfo?: { name: string; title?: string; version?: string };
  /** SIGTERM wait before SIGKILL, in milliseconds. Default 2000. */
  terminateGraceMs?: number;
  /** Final bound after SIGKILL before resolve, in milliseconds. Default 1000. */
  terminateForceMs?: number;
  /**
   * Injectable process factory for tests. When set, spawn is not used.
   * The factory receives resolved binary and args.
   */
  createProcess?: (input: {
    agentBin: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => AcpSpawnedProcess;
  /** Default open-handshake timeout when openSession does not pass one. */
  openRequestTimeoutMs?: number;
  /**
   * Default prompt timeout when openSession does not pass one.
   * Defaults to DEFAULT_ACP_PROMPT_TIMEOUT_MS (30 minutes).
   */
  promptTimeoutMs?: number;
  /** @deprecated Use openRequestTimeoutMs. */
  requestTimeoutMs?: number;
}

/**
 * Child-process transport that speaks ACP JSON-RPC over stdio.
 *
 * Flow:
 * 1. spawn agent
 * 2. initialize
 * 3. optional authenticate hook
 * 4. session/new
 * 5. session/prompt with context envelope text
 * 6. stream session/update progress and agent_message_chunk text
 * 7. extract structured ExecutorResult from agent text
 * 8. session/cancel on abort; close process on tear-down
 *
 * Agent-originated client methods (session/request_permission, fs/*) are
 * answered via injectable hooks. Default permission policy is deny.
 */
export function createChildProcessAcpTransport(
  options: ChildProcessAcpTransportOptions = {},
): AcpTransport {
  const maxAgentTextChars = options.maxAgentTextChars ?? DEFAULT_ACP_MAX_AGENT_TEXT_CHARS;
  if (!Number.isSafeInteger(maxAgentTextChars) || maxAgentTextChars < 1) {
    throw new Error("maxAgentTextChars must be a positive safe integer.");
  }
  const requireBinary = options.requireBinary ?? true;
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  const terminateForceMs = options.terminateForceMs ?? 1_000;
  const defaultHooks = options.hooks;
  const defaultOpenRequestTimeoutMs = options.openRequestTimeoutMs
    ?? options.requestTimeoutMs
    ?? DEFAULT_ACP_OPEN_REQUEST_TIMEOUT_MS;
  const defaultPromptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_ACP_PROMPT_TIMEOUT_MS;

  return {
    async openSession(startOptions: AcpOpenSessionOptions): Promise<AcpSessionHandle> {
      if (startOptions.signal?.aborted) {
        throw new AcpAbortError("The ACP session open was aborted before start.");
      }

      const agentBin = startOptions.agentBin
        ?? options.agentBin
        ?? process.env[ACP_AGENT_BIN_ENV]
        ?? "acp-agent";

      if (requireBinary && !options.createProcess && !isNonEmptyString(
        startOptions.agentBin ?? options.agentBin ?? process.env[ACP_AGENT_BIN_ENV],
      )) {
        throw new AcpOpenError(
          "acp_open_session_failed",
          `ACP agent binary is not configured. Set ${ACP_AGENT_BIN_ENV} or pass agentBin.`,
        );
      }

      const args = startOptions.agentArgs ?? options.args ?? [];
      const env = {
        ...process.env,
        ...startOptions.env,
        HYPAGRAPH_ACP_ATTEMPT: startOptions.identity.attemptId,
      };
      const hooks: AcpClientHooks = {
        ...defaultHooks,
        ...startOptions.hooks,
      };
      const permissionPolicy = hooks.permissionPolicy ?? "deny";
      const openRequestTimeoutMs = startOptions.openRequestTimeoutMs
        ?? startOptions.requestTimeoutMs
        ?? defaultOpenRequestTimeoutMs;
      if (!Number.isSafeInteger(openRequestTimeoutMs) || openRequestTimeoutMs < 1) {
        throw new AcpOpenError(
          "acp_open_session_failed",
          "openRequestTimeoutMs must be a positive safe integer.",
        );
      }
      const promptTimeoutMs = startOptions.promptTimeoutMs ?? defaultPromptTimeoutMs;
      if (
        promptTimeoutMs !== undefined
        && (!Number.isSafeInteger(promptTimeoutMs) || promptTimeoutMs < 1)
      ) {
        throw new AcpOpenError(
          "acp_open_session_failed",
          "promptTimeoutMs must be a positive safe integer when present.",
        );
      }

      let child: AcpSpawnedProcess;
      try {
        if (options.createProcess) {
          child = options.createProcess({
            agentBin,
            args,
            ...(startOptions.cwd !== undefined ? { cwd: startOptions.cwd } : {}),
            env,
          });
        } else {
          const spawned = spawn(agentBin, args, {
            cwd: startOptions.cwd,
            env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }) as ChildProcessWithoutNullStreams;
          // Adapt ChildProcess to AcpSpawnedProcess under exactOptionalPropertyTypes.
          child = spawned as unknown as AcpSpawnedProcess;
        }
      } catch (error) {
        throw new AcpOpenError(
          "acp_open_session_failed",
          errorMessage(error, `Failed to spawn ACP agent binary '${agentBin}'.`),
        );
      }

      let terminated = false;
      let sessionLost = false;
      let lastChildError: Error | undefined;
      let nextRequestId = 1;
      let progressSequence = 0;
      let stdoutEnded = false;
      let handleCancelSent = false;
      let unparseableLineCount = 0;
      const maxUnparseableLines = 32;

      const pending = new Map<number | string, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }>();

      const failPending = (error: Error): void => {
        for (const waiter of pending.values()) {
          waiter.reject(error);
        }
        pending.clear();
      };

      child.on("error", (error: Error) => {
        lastChildError = error;
        sessionLost = true;
        failPending(new AcpSessionLostError(
          errorMessage(error, "The ACP agent process reported an error."),
        ));
      });

      if (child.pid === undefined && !options.createProcess) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        throw new AcpOpenError(
          "acp_open_session_failed",
          errorMessage(
            lastChildError,
            `Failed to spawn ACP agent binary '${agentBin}'.`,
          ),
        );
      }

      const piped = child;
      if (!piped.stdout || !piped.stderr || !piped.stdin) {
        throw new AcpOpenError(
          "acp_open_session_failed",
          `Failed to spawn ACP agent binary '${agentBin}' (stdio not available).`,
        );
      }

      // Bounded stderr drain.
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
        // ignore
      });
      piped.stdout.resume();
      piped.stdin.on("error", () => {
        sessionLost = true;
      });

      const lineReader = new JsonlUtf8LineReader();
      let agentMessageText = "";
      let agentTextTruncated = false;
      let activeRunHooks: AcpRunAttemptHooks | undefined;
      let activeSessionId: string | undefined;

      const writeMessage = (payload: unknown): void => {
        const line = `${JSON.stringify(payload)}\n`;
        piped.stdin.write(line);
      };

      const sendRequest = (
        method: string,
        params: unknown,
        requestSignal?: AbortSignal,
        timeoutMs?: number,
        timeoutKind: "open" | "prompt" = "open",
      ): Promise<unknown> => {
        const id = nextRequestId++;
        return new Promise<unknown>((resolve, reject) => {
          if (sessionLost || terminated) {
            reject(new AcpSessionLostError("The ACP process is not reachable."));
            return;
          }
          if (requestSignal?.aborted || startOptions.signal?.aborted) {
            reject(new AcpAbortError(`ACP request '${method}' was aborted.`));
            return;
          }

          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          if (timeoutMs !== undefined) {
            timeout = setTimeout(() => {
              if (settled) return;
              settled = true;
              pending.delete(id);
              cleanupAbort();
              if (timeoutKind === "prompt") {
                reject(new AcpPromptTimeoutError(
                  `ACP session/prompt timed out after ${timeoutMs}ms.`,
                ));
              } else {
                reject(new AcpRequestTimeoutError(
                  `ACP request '${method}' timed out after ${timeoutMs}ms.`,
                ));
              }
            }, timeoutMs);
          }

          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            pending.delete(id);
            if (timeout !== undefined) clearTimeout(timeout);
            cleanupAbort();
            reject(new AcpAbortError(`ACP request '${method}' was aborted.`));
          };

          const cleanupAbort = (): void => {
            requestSignal?.removeEventListener("abort", onAbort);
            startOptions.signal?.removeEventListener("abort", onAbort);
          };

          requestSignal?.addEventListener("abort", onAbort, { once: true });
          startOptions.signal?.addEventListener("abort", onAbort, { once: true });

          pending.set(id, {
            resolve: (value) => {
              if (settled) return;
              settled = true;
              if (timeout !== undefined) clearTimeout(timeout);
              cleanupAbort();
              resolve(value);
            },
            reject: (error) => {
              if (settled) return;
              settled = true;
              if (timeout !== undefined) clearTimeout(timeout);
              cleanupAbort();
              reject(error);
            },
          });
          try {
            writeMessage({
              jsonrpc: "2.0",
              id,
              method,
              params,
            });
          } catch (error) {
            pending.delete(id);
            if (timeout !== undefined) clearTimeout(timeout);
            cleanupAbort();
            settled = true;
            reject(new AcpSessionLostError(
              errorMessage(error, "Failed to write ACP request."),
            ));
          }
        });
      };

      const sendNotification = (method: string, params: unknown): void => {
        try {
          writeMessage({
            jsonrpc: "2.0",
            method,
            params,
          });
        } catch {
          sessionLost = true;
        }
      };

      const sendResponse = (id: number | string, result: unknown): void => {
        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            result,
          });
        } catch {
          sessionLost = true;
        }
      };

      const sendError = (id: number | string, code: number, message: string): void => {
        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            error: { code, message },
          });
        } catch {
          sessionLost = true;
        }
      };

      const handleClientRequest = async (
        id: number | string,
        method: string,
        params: unknown,
      ): Promise<void> => {
        try {
          if (method === "session/request_permission") {
            const record = isStrictPlainObject(params)
              ? params as Record<string, unknown>
              : {};
            const sessionId = isNonEmptyString(record.sessionId)
              ? record.sessionId
              : (activeSessionId ?? "");
            const toolCall = isStrictPlainObject(record.toolCall)
              ? record.toolCall as Record<string, unknown>
              : {};
            const rawOptions = Array.isArray(record.options) ? record.options : [];
            const optionsList: AcpPermissionRequest["options"] = [];
            for (const item of rawOptions) {
              if (!isStrictPlainObject(item)) continue;
              const option = item as Record<string, unknown>;
              if (
                isNonEmptyString(option.optionId)
                && isNonEmptyString(option.name)
                && isNonEmptyString(option.kind)
              ) {
                optionsList.push({
                  optionId: option.optionId,
                  name: option.name,
                  kind: option.kind,
                });
              }
            }
            const request: AcpPermissionRequest = {
              sessionId,
              toolCall,
              options: optionsList,
              rawParams: record,
            };
            let outcome: AcpPermissionOutcome;
            if (hooks.onPermissionRequest) {
              outcome = await hooks.onPermissionRequest(request);
            } else {
              outcome = resolveDefaultPermissionOutcome(optionsList, permissionPolicy);
            }
            sendResponse(id, {
              outcome: outcome.outcome === "selected"
                ? { outcome: "selected", optionId: outcome.optionId }
                : { outcome: "cancelled" },
            });
            return;
          }

          if (method === "fs/read_text_file") {
            if (!hooks.readTextFile) {
              sendError(id, -32601, "fs/read_text_file is not available in this Hypagraph ACP client.");
              return;
            }
            const result = await hooks.readTextFile(
              isStrictPlainObject(params) ? params as Record<string, unknown> : {},
            );
            sendResponse(id, result);
            return;
          }

          if (method === "fs/write_text_file") {
            if (!hooks.writeTextFile) {
              sendError(id, -32601, "fs/write_text_file is not available in this Hypagraph ACP client.");
              return;
            }
            const result = await hooks.writeTextFile(
              isStrictPlainObject(params) ? params as Record<string, unknown> : {},
            );
            sendResponse(id, result);
            return;
          }

          if (method === "elicitation/create") {
            if (!hooks.createElicitation) {
              sendResponse(id, { action: "cancel" });
              return;
            }
            const result = await hooks.createElicitation(
              isStrictPlainObject(params) ? params as Record<string, unknown> : {},
            );
            sendResponse(id, result);
            return;
          }

          sendError(id, -32601, `Method not found: ${method}`);
        } catch (error) {
          sendError(
            id,
            -32000,
            errorMessage(error, `ACP client method '${method}' failed.`),
          );
        }
      };

      const handleIncoming = (parsed: unknown): void => {
        if (!isStrictPlainObject(parsed)) return;
        const record = parsed as Record<string, unknown>;

        // Response to our request
        if (record.id !== undefined && (record.result !== undefined || record.error !== undefined)) {
          const waiter = pending.get(record.id as number | string);
          if (!waiter) return;
          pending.delete(record.id as number | string);
          if (record.error !== undefined) {
            const errObj = isStrictPlainObject(record.error)
              ? record.error as Record<string, unknown>
              : {};
            const message = isNonEmptyString(errObj.message)
              ? errObj.message
              : "ACP agent returned a JSON-RPC error.";
            waiter.reject(new Error(message));
            return;
          }
          waiter.resolve(record.result);
          return;
        }

        // Notification or request from agent
        if (typeof record.method === "string") {
          const method = record.method;
          const params = record.params;

          if (record.id !== undefined) {
            void handleClientRequest(record.id as number | string, method, params);
            return;
          }

          if (method === "session/update") {
            const p = isStrictPlainObject(params) ? params as Record<string, unknown> : {};
            const sessionId = isNonEmptyString(p.sessionId)
              ? p.sessionId
              : (activeSessionId ?? "");
            const update = isStrictPlainObject(p.update)
              ? p.update as Record<string, unknown>
              : {};
            const kind = isNonEmptyString(update.sessionUpdate)
              ? update.sessionUpdate
              : "unknown";
            progressSequence += 1;
            const event: AcpProgressEvent = {
              sessionId,
              kind,
              update: structuredClone(update),
              atSequence: progressSequence,
            };
            try {
              activeRunHooks?.onProgress?.(event);
            } catch {
              // ignore progress callback errors
            }

            if (kind === "agent_message_chunk") {
              const content = isStrictPlainObject(update.content)
                ? update.content as Record<string, unknown>
                : undefined;
              if (content && content.type === "text" && typeof content.text === "string") {
                if (agentMessageText.length < maxAgentTextChars) {
                  const remaining = maxAgentTextChars - agentMessageText.length;
                  if (content.text.length > remaining) {
                    agentTextTruncated = true;
                  }
                  agentMessageText += content.text.slice(0, remaining);
                } else {
                  agentTextTruncated = true;
                }
              }
            }
          }
        }
      };

      const processStdoutLines = (lines: string[]): void => {
        for (const rawLine of lines) {
          if (rawLine.trim().length === 0) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawLine) as unknown;
          } catch {
            // Skip unparseable banner lines. Fail only after a bound is exceeded.
            unparseableLineCount += 1;
            if (unparseableLineCount > maxUnparseableLines) {
              sessionLost = true;
              // Use AcpSessionLostError so in-flight and subsequent requests both
              // map to interrupted / acp_session_lost.
              failPending(new AcpSessionLostError(
                "ACP agent stdout exceeded the unparseable line bound.",
              ));
              return;
            }
            continue;
          }
          handleIncoming(parsed);
        }
      };

      const onStdoutData = (chunk: Buffer): void => {
        processStdoutLines(lineReader.push(chunk));
      };

      const flushStdout = (): void => {
        if (stdoutEnded) return;
        stdoutEnded = true;
        // Flush decoder and any final line without trailing newline.
        processStdoutLines(lineReader.flushIncludingPending());
      };

      piped.stdout.on("data", onStdoutData);
      piped.stdout.on("end", () => {
        flushStdout();
      });

      // Single exit path: flush stdout first so a final response without LF is accepted.
      child.once("exit", () => {
        sessionLost = true;
        flushStdout();
        failPending(new AcpSessionLostError(
          `The ACP agent process exited.${stderrBytes > 0
            ? ` stderr: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`
            : ""}`,
        ));
      });

      const teardownProcess = async (): Promise<void> => {
        // ChildProcess and AcpSpawnedProcess both support kill; terminateChildProcessTree
        // expects a ChildProcess. For scripted test processes, kill is enough.
        if (isChildProcess(child)) {
          await terminateChildProcessTree(child, {
            graceMs: terminateGraceMs,
            forceMs: terminateForceMs,
          });
        } else {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
      };

      // initialize
      const clientInfo = options.clientInfo ?? {
        name: "hypagraph",
        title: "Hypagraph",
        version: ACP_EXECUTOR_VERSION.toString(),
      };
      let initializeResult: unknown;
      try {
        initializeResult = await sendRequest("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            // Permission brokerage is always available (policy/hook).
            // File system and terminal are not advertised unless hooks provide them.
            ...(hooks.readTextFile || hooks.writeTextFile
              ? {
                fs: {
                  readTextFile: Boolean(hooks.readTextFile),
                  writeTextFile: Boolean(hooks.writeTextFile),
                },
              }
              : {}),
          },
          clientInfo,
        }, startOptions.signal, openRequestTimeoutMs, "open");
      } catch (error) {
        await teardownProcess();
        if (isAbortError(error) || startOptions.signal?.aborted) {
          throw new AcpAbortError(errorMessage(error, "ACP initialize was aborted."));
        }
        if (isSessionLossError(error)) throw error;
        if (isRequestTimeoutError(error)) throw error;
        throw new AcpOpenError(
          "acp_open_session_failed",
          errorMessage(error, "ACP initialize failed."),
        );
      }

      const initRecord = isStrictPlainObject(initializeResult)
        ? initializeResult as Record<string, unknown>
        : {};
      const protocolVersion = initRecord.protocolVersion;
      if (protocolVersion !== undefined && protocolVersion !== ACP_PROTOCOL_VERSION) {
        await teardownProcess();
        throw new AcpOpenError(
          "acp_open_session_failed",
          `ACP protocol version negotiation failed. Client supports ${ACP_PROTOCOL_VERSION}, agent returned ${String(protocolVersion)}.`,
        );
      }

      const agentCapabilities = parseAgentCapabilities(initRecord.agentCapabilities);
      const authMethods = Array.isArray(initRecord.authMethods) ? initRecord.authMethods : [];

      if (authMethods.length > 0 && !hooks.authenticate) {
        await teardownProcess();
        throw new AcpOpenError(
          "acp_authentication_required",
          "The ACP agent requires authentication and no authenticate hook is configured.",
        );
      }

      if (hooks.authenticate && authMethods.length > 0) {
        try {
          await hooks.authenticate({ agentCapabilities, authMethods });
        } catch (error) {
          await teardownProcess();
          throw new AcpOpenError(
            "acp_authentication_required",
            errorMessage(error, "ACP authenticate hook failed."),
          );
        }
      }

      // session/new — per-attempt session
      const cwd = startOptions.cwd ?? process.cwd();
      let sessionNewResult: unknown;
      try {
        sessionNewResult = await sendRequest("session/new", {
          cwd,
          mcpServers: [],
        }, startOptions.signal, openRequestTimeoutMs, "open");
      } catch (error) {
        await teardownProcess();
        if (isAbortError(error) || startOptions.signal?.aborted) {
          throw new AcpAbortError(errorMessage(error, "ACP session/new was aborted."));
        }
        if (isSessionLossError(error)) throw error;
        if (isRequestTimeoutError(error)) throw error;
        throw new AcpOpenError(
          "acp_open_session_failed",
          errorMessage(error, "ACP session/new failed."),
        );
      }

      const sessionRecord = isStrictPlainObject(sessionNewResult)
        ? sessionNewResult as Record<string, unknown>
        : {};
      if (!isNonEmptyString(sessionRecord.sessionId)) {
        await teardownProcess();
        throw new AcpOpenError(
          "acp_open_session_failed",
          "ACP session/new did not return a sessionId.",
        );
      }
      const sessionId = sessionRecord.sessionId;
      activeSessionId = sessionId;

      const handle: AcpSessionHandle = {
        sessionId,
        agentCapabilities,
        async runAttempt(context, signal, runHooks) {
          if (terminated || sessionLost) {
            throw new AcpSessionLostError(
              `The ACP process is not reachable.${stderrBytes > 0
                ? ` stderr: ${Buffer.concat(stderrChunks).toString("utf8").trim()}`
                : ""}`,
            );
          }
          if (signal.aborted) {
            throw new AcpAbortError(
              "The ACP attempt was aborted before run.",
            );
          }

          activeRunHooks = runHooks;
          agentMessageText = "";
          agentTextTruncated = false;

          const onAbort = (): void => {
            if (!handleCancelSent && !sessionLost && !terminated) {
              handleCancelSent = true;
              sendNotification("session/cancel", { sessionId });
            }
          };
          signal.addEventListener("abort", onAbort, { once: true });

          try {
            const promptText = buildAcpPromptText(context);
            const promptResult = await sendRequest(
              "session/prompt",
              {
                sessionId,
                prompt: [{ type: "text", text: promptText }],
              },
              signal,
              promptTimeoutMs,
              "prompt",
            );

            if (signal.aborted) {
              throw new AcpAbortError(
                "The ACP attempt was aborted during run.",
              );
            }

            const promptRecord = isStrictPlainObject(promptResult)
              ? promptResult as Record<string, unknown>
              : {};
            const stopReason = isNonEmptyString(promptRecord.stopReason)
              ? promptRecord.stopReason
              : "end_turn";

            if (stopReason === "cancelled") {
              return makeTransportSignal("cancelled_stop", {
                message: "The ACP agent reported stopReason cancelled.",
              });
            }
            if (
              stopReason === "max_tokens"
              || stopReason === "max_turn_requests"
              || stopReason === "refusal"
            ) {
              return makeTransportSignal("error", {
                code: `acp_stop_reason_${stopReason}`,
                message: `The ACP agent stopped with reason '${stopReason}'.`,
              });
            }

            // Prefer a structured object already present on the JSON-RPC response.
            // That object does not come from the agentMessageText buffer, so
            // truncation of stream text is non-fatal on this path.
            // Do not attach diagnostics here: the payload may be a wrapper
            // ({ type: "result", result }) and parseAcpAgentReply unwraps it.
            // Truncation is flagged with ACP_STREAM_TEXT_TRUNCATED and applied
            // after unwrap on the adapter-owned validated result.
            if (isStrictPlainObject(promptRecord.result)) {
              const stripped = stripForgeableTransportMarkers(promptRecord.result);
              if (!isStrictPlainObject(stripped)) {
                return stripped;
              }
              if (agentTextTruncated) {
                return markStreamTextTruncated(stripped as Record<string, unknown>);
              }
              return stripped;
            }

            // When the stream was truncated, refuse text extraction so an earlier
            // complete fence cannot be accepted as the final result.
            if (agentTextTruncated) {
              return makeTransportSignal("error", {
                code: "acp_agent_text_truncated",
                message:
                  "The ACP agent message text was truncated before a complete structured result could be extracted.",
              });
            }

            const extracted = extractStructuredResultFromAgentText(agentMessageText);
            if (!extracted.ok) {
              return makeTransportSignal("error", {
                code: "acp_result_not_structured",
                message: extracted.message,
              });
            }
            return stripForgeableTransportMarkers(extracted.value);
          } finally {
            signal.removeEventListener("abort", onAbort);
            activeRunHooks = undefined;
          }
        },
        async cancel() {
          if (terminated || sessionLost) return;
          if (handleCancelSent) return;
          handleCancelSent = true;
          sendNotification("session/cancel", { sessionId });
        },
        async close(reason: string) {
          if (terminated) return;
          terminated = true;
          // Reject any in-flight requests.
          failPending(new AcpSessionLostError(
            `The ACP session was closed (${reason}).`,
          ));
          await teardownProcess();
        },
      };

      return handle;
    },
  };
}

/**
 * Error that signals the ACP session or process is no longer reachable.
 * The adapter maps this to outcome "interrupted" and diagnostic acp_session_lost.
 */
export class AcpSessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpSessionLostError";
  }
}

/**
 * Structured open-session failure with a stable diagnostic code.
 */
export class AcpOpenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AcpOpenError";
    this.code = code;
  }
}

/**
 * Abort during ACP open or request. Maps to cancelled when observed on open.
 */
export class AcpAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpAbortError";
  }
}

/**
 * JSON-RPC open-handshake request timeout. Maps to acp_open_request_timeout.
 */
export class AcpRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpRequestTimeoutError";
  }
}

/**
 * session/prompt wall-clock timeout. Maps to outcome timed_out.
 */
export class AcpPromptTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpPromptTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
      return "The ACP executor submitted a structured result.";
    case "failed":
      return "The ACP executor reported failure.";
    case "cancelled":
      return "The ACP executor cancelled the attempt.";
    case "timed_out":
      return "The ACP executor timed out.";
    case "interrupted":
      return "The ACP executor was interrupted.";
    default:
      return "The ACP executor completed.";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && isNonEmptyString(error.message)) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

function isSessionLossError(error: unknown): boolean {
  return error instanceof AcpSessionLostError
    || (error instanceof Error && error.name === "AcpSessionLostError");
}

function isAcpOpenError(error: unknown): error is AcpOpenError {
  return error instanceof AcpOpenError
    || (error instanceof Error && error.name === "AcpOpenError" && typeof (error as AcpOpenError).code === "string");
}

function isAbortError(error: unknown): boolean {
  return error instanceof AcpAbortError
    || (error instanceof Error && error.name === "AcpAbortError");
}

function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof AcpRequestTimeoutError
    || (error instanceof Error && error.name === "AcpRequestTimeoutError");
}

function isChildProcess(value: AcpSpawnedProcess): value is ChildProcess & AcpSpawnedProcess {
  return typeof (value as ChildProcess).pid === "number"
    || Object.prototype.hasOwnProperty.call(value, "stdio");
}

/**
 * Build a non-forgeable transport sentinel.
 * Uses a module-private Symbol that cannot appear in JSON agent output.
 */
export function makeTransportSignal(
  kind: "error" | "cancelled_stop",
  fields: { code?: string; message: string },
): Record<string | symbol, unknown> {
  return {
    [ACP_TRANSPORT_SIGNAL]: true,
    type: kind,
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    message: fields.message,
  };
}

function isTransportSignal(value: Record<string | symbol, unknown>): boolean {
  return value[ACP_TRANSPORT_SIGNAL] === true;
}

/**
 * Remove forgeable string marker keys from agent-controlled plain objects.
 * Does not mutate the input. Recurses one level into a nested result field.
 */
export function stripForgeableTransportMarkers(value: unknown): unknown {
  if (!isStrictPlainObject(value)) return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === ACP_FORGEABLE_SIGNAL_KEY) continue;
    next[key] = entry;
  }
  if (isStrictPlainObject(next.result)) {
    next.result = stripForgeableTransportMarkers(next.result);
  }
  return next;
}

/**
 * Mark an untrusted reply so execute can attach a truncation diagnostic after
 * parse unwrap and validation. Uses a module-private Symbol (not forgeable JSON).
 */
function markStreamTextTruncated(
  value: Record<string, unknown>,
): Record<string | symbol, unknown> {
  return {
    ...value,
    [ACP_STREAM_TEXT_TRUNCATED]: true,
  };
}

function hasStreamTextTruncatedFlag(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return (value as Record<string | symbol, unknown>)[ACP_STREAM_TEXT_TRUNCATED] === true;
}

const TRUNCATION_DIAGNOSTIC: ExecutorDiagnostic = {
  code: "acp_agent_text_truncated",
  message:
    "The ACP agent message text was truncated. "
    + "Stream text is incomplete; the structured prompt result was kept.",
};

/**
 * Merge a non-fatal truncation diagnostic onto an already validated result.
 * - When maxDiagnostics is 0, leave the result unchanged.
 * - When there is room, append the diagnostic.
 * - When already at the bound, replace the last diagnostic so the note is kept
 *   without exceeding maxDiagnostics (does not flip submitted to failed).
 */
export function mergeTruncationDiagnostic(
  result: ExecutorResult,
  maxDiagnostics: number,
): ExecutorResult {
  const max = Number.isSafeInteger(maxDiagnostics) && maxDiagnostics >= 0
    ? maxDiagnostics
    : 0;
  if (max === 0) {
    return result;
  }
  if (result.diagnostics.some((item) => item.code === "acp_agent_text_truncated")) {
    return result;
  }
  const existing = result.diagnostics.map((item) => structuredClone(item));
  if (existing.length < max) {
    existing.push(structuredClone(TRUNCATION_DIAGNOSTIC));
  } else {
    // At bound: replace the last slot so the truncation note is visible.
    existing[max - 1] = structuredClone(TRUNCATION_DIAGNOSTIC);
  }
  return {
    ...result,
    diagnostics: existing,
  };
}

function isPromptTimeoutError(error: unknown): boolean {
  return error instanceof AcpPromptTimeoutError
    || (error instanceof Error && error.name === "AcpPromptTimeoutError");
}

function parseAgentCapabilities(value: unknown): AcpAgentCapabilities {
  if (!isStrictPlainObject(value)) {
    return { raw: {} };
  }
  const record = value as Record<string, unknown>;
  const result: AcpAgentCapabilities = {
    raw: structuredClone(record),
  };
  if (typeof record.loadSession === "boolean") {
    result.loadSession = record.loadSession;
  }
  if (isStrictPlainObject(record.promptCapabilities)) {
    const pc = record.promptCapabilities as Record<string, unknown>;
    result.promptCapabilities = {
      ...(typeof pc.image === "boolean" ? { image: pc.image } : {}),
      ...(typeof pc.audio === "boolean" ? { audio: pc.audio } : {}),
      ...(typeof pc.embeddedContext === "boolean" ? { embeddedContext: pc.embeddedContext } : {}),
    };
  }
  return result;
}

type ParsedAcpReply =
  | {
    kind: "result";
    value: Record<string, unknown>;
    /** Adapter-owned flag: stream text was truncated for this attempt. */
    streamTextTruncated?: boolean;
  }
  | { kind: "transport_error"; code: string; message: string }
  | { kind: "cancelled_stop"; message: string }
  | { kind: "invalid"; message: string };

/**
 * Parse an ACP agent reply into a validation candidate.
 * Transport sentinels use a module-private Symbol and cannot be forged in JSON.
 * String marker keys are stripped from agent-controlled payloads.
 * Stream-truncation Symbol flags are preserved as streamTextTruncated.
 * - transport error → transport_error with adapter diagnostic code fidelity
 * - transport cancelled_stop → cancelled_stop
 * - { type: "result", result } → unwrap result (markers stripped)
 * - plain object result → result (markers stripped)
 * - raw text / non-objects → invalid
 */
export function parseAcpAgentReply(value: unknown): ParsedAcpReply {
  // Symbol-marked objects are not strict plain objects (prototype may be Object,
  // but we check the Symbol first before plain-object classification).
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const asRecord = value as Record<string | symbol, unknown>;
    if (isTransportSignal(asRecord)) {
      if (asRecord.type === "error") {
        const code = isNonEmptyString(asRecord.code) ? asRecord.code : "acp_transport_error";
        const message = isNonEmptyString(asRecord.message)
          ? asRecord.message
          : "The ACP transport reported an error without a message.";
        return { kind: "transport_error", code, message };
      }
      if (asRecord.type === "cancelled_stop") {
        return {
          kind: "cancelled_stop",
          message: isNonEmptyString(asRecord.message)
            ? asRecord.message
            : "The ACP agent reported stopReason cancelled.",
        };
      }
    }
  }

  if (typeof value === "string") {
    const extracted = extractStructuredResultFromAgentText(value);
    if (!extracted.ok) {
      return {
        kind: "invalid",
        message:
          "The ACP agent returned raw text. "
          + "Raw assistant text is not a valid canonical result.",
      };
    }
    if (!isStrictPlainObject(extracted.value)) {
      return {
        kind: "invalid",
        message:
          "The ACP agent text did not contain a plain object result.",
      };
    }
    const stripped = stripForgeableTransportMarkers(extracted.value);
    if (!isStrictPlainObject(stripped)) {
      return {
        kind: "invalid",
        message: "The ACP agent text did not contain a plain object result.",
      };
    }
    return { kind: "result", value: stripped as Record<string, unknown> };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "invalid",
      message:
        "The ACP agent did not return a plain object result. "
        + "Raw assistant text is not a valid canonical result.",
    };
  }

  // Capture truncation flag before strip (Object.entries drops Symbols).
  const streamTextTruncated = hasStreamTextTruncatedFlag(value)
    || (
      isStrictPlainObject((value as Record<string, unknown>).result)
      && hasStreamTextTruncatedFlag((value as Record<string, unknown>).result)
    );

  if (!isStrictPlainObject(value) && !hasStreamTextTruncatedFlag(value)) {
    // Class instances without our Symbol are invalid.
    return {
      kind: "invalid",
      message:
        "The ACP agent did not return a plain object result. "
        + "Raw assistant text is not a valid canonical result.",
    };
  }

  // Build a plain copy for strip (Symbol-marked objects still have plain fields).
  const asPlain: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const strippedRoot = stripForgeableTransportMarkers(asPlain);
  if (!isStrictPlainObject(strippedRoot)) {
    return {
      kind: "invalid",
      message: "The ACP agent did not return a plain object result.",
    };
  }
  const record = strippedRoot as Record<string, unknown>;

  if (record.type === "result") {
    if (!isStrictPlainObject(record.result)) {
      return {
        kind: "invalid",
        message: "The ACP agent result wrapper requires a plain result object.",
      };
    }
    return {
      kind: "result",
      value: record.result as Record<string, unknown>,
      ...(streamTextTruncated ? { streamTextTruncated: true } : {}),
    };
  }

  return {
    kind: "result",
    value: record,
    ...(streamTextTruncated ? { streamTextTruncated: true } : {}),
  };
}

async function safeClose(handle: AcpSessionHandle, reason: string): Promise<void> {
  try {
    await handle.close(reason);
  } catch {
    // Close is best-effort. Identity is preserved on the result envelope.
  }
}

async function safeCancelAndClose(handle: AcpSessionHandle, reason: string): Promise<void> {
  try {
    await handle.cancel();
  } catch {
    // best effort
  }
  await safeClose(handle, reason);
}
