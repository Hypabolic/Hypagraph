/**
 * Current-session node executor adapter.
 *
 * Represents execution in the live Pi session. It does not start a subprocess.
 * Completions go through the shared settleExecutorResult path used by future
 * isolated executors.
 *
 * The model turn remains in the host session. Tool handlers supply completion
 * params (the untrusted result). Product and NodeExecutor both build that
 * payload through produceCurrentSessionCompletion, then settle it.
 */

import {
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
  HypagraphCommand,
  HypagraphState,
} from "../domain/model.js";

/** Stable profile for live Pi session execution. */
export const CURRENT_SESSION_PROFILE: ExecutorProfileRef = {
  profileId: "current-session-default",
  kind: "current-session",
};

export const CURRENT_SESSION_EXECUTOR_ID = "current-session";
export const CURRENT_SESSION_EXECUTOR_VERSION = 1;

/** Source that produces an untrusted structured result for one context. */
export type CurrentSessionResultSource = (
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
) => Promise<unknown>;

/** Completion fields supplied by the live tool path or an executor source. */
export interface CurrentSessionCompletionInput {
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  /** Optional reason used when summary is empty (cancel and failure paths). */
  reason?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  artifacts?: ExecutorResult["artifacts"];
}

export interface BuildCurrentSessionResultPayloadInput {
  identity: ExecutorAttemptIdentity;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  artifacts?: ExecutorResult["artifacts"];
}

export interface MaterializeCurrentSessionContextInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  /** Defaults to CURRENT_SESSION_PROFILE. */
  profile?: ExecutorProfileRef;
  rootObjective?: string;
}

export interface ProduceCurrentSessionCompletionInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  completion: CurrentSessionCompletionInput;
  rootObjective?: string;
  profile?: ExecutorProfileRef;
}

export type ProduceCurrentSessionCompletionResult =
  | {
    ok: true;
    context: ExecutorContextEnvelope;
    /** Untrusted plain-object payload. Must pass settleExecutorResult before commit. */
    untrusted: Record<string, unknown>;
  }
  | { ok: false; diagnostics: Diagnostic[] };

export interface SettleCurrentSessionTaskResultInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  /** Optional reason used when summary is empty (cancel and failure paths). */
  reason?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  rootObjective?: string;
  meta: SettleExecutorResultMeta;
}

export type SettleCurrentSessionTaskResultResult = SettleExecutorResultResult;

/**
 * Host routing for live submit/cancel without requiring a full Pi session.
 * Extension maps family restore into this pure-ish helper.
 */
export interface RouteLiveTaskCompletionInput {
  /** Family runtime when a goal family is available. Absent → legacy path. */
  family: GoalFamilyRuntime | undefined;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  reason?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  rootObjective?: string;
  meta: SettleExecutorResultMeta;
}

export type RouteLiveTaskCompletionResult =
  | {
    /** Settlement produced commands for the controller to commit. */
    kind: "settled";
    settlement: Extract<SettleExecutorResultResult, { ok: true }>;
  }
  | {
    /** Settlement rejected the untrusted payload. Do not commit. */
    kind: "rejected";
    diagnostics: Diagnostic[];
  }
  | {
    /** No goal family path. Caller uses direct publish/submit/cancel commands. */
    kind: "legacy";
  };

const reject = (code: string, message: string, location?: string): { ok: false; diagnostics: Diagnostic[] } => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Build a plain-object untrusted result payload for current-session completion.
 * The payload is not trusted until settleExecutorResult validates it.
 * Product tool handlers and NodeExecutor sources share this builder.
 * Does not mutate inputs.
 */
export function buildCurrentSessionResultPayload(
  input: BuildCurrentSessionResultPayloadInput,
): Record<string, unknown> {
  const identity = input.identity;
  const summary = isNonEmptyString(input.summary)
    ? input.summary
    : defaultSummaryForOutcome(input.outcome);

  return {
    familyId: identity.familyId,
    goalId: identity.goalId,
    workflowId: identity.workflowId,
    revision: identity.revision,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    outcome: input.outcome,
    facts: structuredClone(input.facts ?? []),
    evidence: structuredClone(input.evidence ?? []),
    artifacts: structuredClone(input.artifacts ?? []),
    summary,
    diagnostics: structuredClone(input.diagnostics ?? []),
    usage: structuredClone(input.usage ?? {}),
  };
}

/**
 * Build an untrusted payload from an already materialized context and completion params.
 * Shared by NodeExecutor.execute sources and product produce/settle.
 */
export function buildCurrentSessionCompletionUntrusted(
  context: ExecutorContextEnvelope,
  completion: CurrentSessionCompletionInput,
): Record<string, unknown> {
  const summary = resolveCompletionSummary(completion);
  return buildCurrentSessionResultPayload({
    identity: context.identity,
    outcome: completion.outcome,
    ...(completion.facts !== undefined ? { facts: completion.facts } : {}),
    ...(completion.evidence !== undefined ? { evidence: completion.evidence } : {}),
    summary,
    ...(completion.diagnostics !== undefined ? { diagnostics: completion.diagnostics } : {}),
    ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
    ...(completion.artifacts !== undefined ? { artifacts: completion.artifacts } : {}),
  });
}

/**
 * Materialize a current-session context envelope for one running attempt.
 * Returns diagnostics when the family, state, or identity is incomplete.
 */
export function materializeCurrentSessionContext(
  input: MaterializeCurrentSessionContextInput,
): MaterializeExecutorContextResult {
  if (!isNonEmptyString(input.nodeId)) {
    return reject(
      "current_session_invalid_node",
      "Current-session context requires a non-empty nodeId.",
      "nodeId",
    );
  }
  if (!isNonEmptyString(input.attemptId)) {
    return reject(
      "current_session_invalid_attempt",
      "Current-session context requires a non-empty attemptId.",
      "attemptId",
    );
  }

  const goalId = input.state.goal?.goalId;
  if (!isNonEmptyString(goalId)) {
    return reject(
      "current_session_goal_missing",
      "Current-session context requires a started goal runtime on the workflow state.",
      "state.goal",
    );
  }

  const familyId = input.family.familyId;
  if (!isNonEmptyString(familyId)) {
    return reject(
      "current_session_family_missing",
      "Current-session context requires a non-empty familyId.",
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

  const profile = input.profile ?? CURRENT_SESSION_PROFILE;
  return materializeExecutorContext({
    family: input.family,
    state: input.state,
    identity,
    profile,
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
}

/**
 * Produce a current-session context and untrusted result payload.
 *
 * This is the shared produce step for:
 * - product tool handlers (then settle);
 * - NodeExecutor sources that mirror live completion params.
 *
 * Does not settle or commit. Does not read the clock or create IDs.
 */
export function produceCurrentSessionCompletion(
  input: ProduceCurrentSessionCompletionInput,
): ProduceCurrentSessionCompletionResult {
  const materialized = materializeCurrentSessionContext({
    family: input.family,
    state: input.state,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
  if (!materialized.ok) {
    return { ok: false, diagnostics: materialized.diagnostics };
  }

  const untrusted = buildCurrentSessionCompletionUntrusted(
    materialized.value,
    input.completion,
  );
  return {
    ok: true,
    context: materialized.value,
    untrusted,
  };
}

/**
 * Produce an untrusted current-session result and settle it through the shared path.
 *
 * Product submit/cancel and tests use this single entry. NodeExecutor.execute
 * produces the same untrusted shape via buildCurrentSessionCompletionUntrusted,
 * then controllers call settleExecutorResult (or executeAndSettleCurrentSession).
 *
 * On failure, returns diagnostics only. Does not commit state.
 */
export function produceAndSettleCurrentSessionResult(
  input: SettleCurrentSessionTaskResultInput,
): SettleCurrentSessionTaskResultResult {
  const produced = produceCurrentSessionCompletion({
    family: input.family,
    state: input.state,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    completion: {
      outcome: input.outcome,
      ...(input.facts !== undefined ? { facts: input.facts } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    },
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
  if (!produced.ok) {
    return { ok: false, diagnostics: produced.diagnostics };
  }
  return settleExecutorResult(produced.context, produced.untrusted, input.meta);
}

/**
 * Settle a current-session task result through the shared result-contract path.
 * Alias of produceAndSettleCurrentSessionResult for call sites that use the
 * earlier name.
 */
export function settleCurrentSessionTaskResult(
  input: SettleCurrentSessionTaskResultInput,
): SettleCurrentSessionTaskResultResult {
  return produceAndSettleCurrentSessionResult(input);
}

/**
 * Route live task completion for the product host.
 *
 * - No goal or no family → legacy direct commands.
 * - Otherwise produce+settle through the shared executor result path.
 * - Settlement failure returns rejected diagnostics (caller must not commit).
 */
export function routeLiveTaskCompletion(
  input: RouteLiveTaskCompletionInput,
): RouteLiveTaskCompletionResult {
  if (!input.state.goal || !input.family) {
    return { kind: "legacy" };
  }

  const settlement = produceAndSettleCurrentSessionResult({
    family: input.family,
    state: input.state,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    outcome: input.outcome,
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
    meta: input.meta,
  });

  if (!settlement.ok) {
    return { kind: "rejected", diagnostics: settlement.diagnostics };
  }
  return { kind: "settled", settlement };
}

/**
 * Extract commit commands from a live routing result.
 * Returns null for legacy. Throws nothing; rejected returns diagnostics on the result.
 */
export function commandsFromLiveTaskRouting(
  routing: RouteLiveTaskCompletionResult,
): { ok: true; commands: HypagraphCommand[] | null } | { ok: false; diagnostics: Diagnostic[] } {
  if (routing.kind === "legacy") {
    return { ok: true, commands: null };
  }
  if (routing.kind === "rejected") {
    return { ok: false, diagnostics: routing.diagnostics };
  }
  return { ok: true, commands: routing.settlement.commands };
}

/**
 * Settle an untrusted payload against an already materialized context.
 * Shared alias used by the current-session adapter and isolated stubs.
 */
export function settleCurrentSessionResult(
  context: ExecutorContextEnvelope,
  untrustedResult: unknown,
  meta: SettleExecutorResultMeta,
): SettleExecutorResultResult {
  return settleExecutorResult(context, untrustedResult, meta);
}

/**
 * Create a current-session NodeExecutor.
 *
 * The source supplies the untrusted structured result for the live session.
 * Prefer createCurrentSessionExecutorFromCompletion so sources use the same
 * payload builder as product tool handlers.
 * execute validates the payload and returns the accepted ExecutorResult.
 * Controllers must still call settleExecutorResult before commit.
 */
export function createCurrentSessionExecutor(
  source: CurrentSessionResultSource,
): NodeExecutor {
  return {
    id: CURRENT_SESSION_EXECUTOR_ID,
    version: CURRENT_SESSION_EXECUTOR_VERSION,
    async execute(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<ExecutorResult> {
      if (signal.aborted) {
        throw createExecutorAbortError("The current-session executor was aborted before execution.");
      }
      const untrusted = await source(context, signal);
      if (signal.aborted) {
        throw createExecutorAbortError("The current-session executor was aborted during execution.");
      }
      const validated = validateExecutorResult(context, untrusted);
      if (!validated.ok) {
        throw createExecutorValidationError(validated.diagnostics);
      }
      return validated.value;
    },
  };
}

/**
 * Create a current-session NodeExecutor whose source builds payloads with the
 * same builder product handlers use (buildCurrentSessionCompletionUntrusted).
 */
export function createCurrentSessionExecutorFromCompletion(
  getCompletion: (
    context: ExecutorContextEnvelope,
    signal: AbortSignal,
  ) => Promise<CurrentSessionCompletionInput>,
): NodeExecutor {
  return createCurrentSessionExecutor(async (context, signal) => {
    const completion = await getCompletion(context, signal);
    return buildCurrentSessionCompletionUntrusted(context, completion);
  });
}

/**
 * Run one current-session attempt and settle the result with the shared path.
 * Proves the adapter and settlement share one public settle API.
 */
export async function executeAndSettleCurrentSession(
  executor: NodeExecutor,
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
  meta: SettleExecutorResultMeta,
): Promise<SettleExecutorResultResult> {
  let raw: unknown;
  try {
    raw = await executor.execute(context, signal);
  } catch (error) {
    const diagnostics = readExecutorDiagnostics(error);
    if (diagnostics) {
      return { ok: false, diagnostics };
    }
    throw error;
  }
  return settleExecutorResult(context, raw, meta);
}

export class CurrentSessionExecutorValidationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(
      diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n")
        || "Current-session executor result validation failed.",
    );
    this.name = "CurrentSessionExecutorValidationError";
    this.diagnostics = diagnostics;
  }
}

export class CurrentSessionExecutorAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrentSessionExecutorAbortError";
  }
}

function createExecutorValidationError(diagnostics: Diagnostic[]): CurrentSessionExecutorValidationError {
  return new CurrentSessionExecutorValidationError(diagnostics);
}

function createExecutorAbortError(message: string): CurrentSessionExecutorAbortError {
  return new CurrentSessionExecutorAbortError(message);
}

function readExecutorDiagnostics(error: unknown): Diagnostic[] | undefined {
  if (error instanceof CurrentSessionExecutorValidationError) {
    return error.diagnostics;
  }
  return undefined;
}

function resolveCompletionSummary(completion: CurrentSessionCompletionInput): string {
  if (isNonEmptyString(completion.summary)) return completion.summary;
  if (isNonEmptyString(completion.reason)) return completion.reason;
  return defaultSummaryForOutcome(completion.outcome);
}

function defaultSummaryForOutcome(outcome: ExecutorOutcome): string {
  switch (outcome) {
    case "submitted":
      return "The current-session executor submitted a structured result.";
    case "failed":
      return "The current-session executor reported failure.";
    case "cancelled":
      return "The current-session executor cancelled the attempt.";
    case "timed_out":
      return "The current-session executor timed out.";
    case "interrupted":
      return "The current-session executor was interrupted.";
    default:
      return "The current-session executor completed.";
  }
}
