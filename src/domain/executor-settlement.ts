/**
 * Shared executor result settlement.
 *
 * The controller validates an untrusted executor result against a context
 * envelope, then maps the accepted result to domain commands.
 * Current-session and isolated executors use this same path.
 *
 * Raw assistant text and invalid envelopes do not produce commit commands.
 *
 * Domain helpers in this module are pure: no clock, random, files, network, or
 * input mutation. Timestamps and command IDs appear only as pure caller inputs.
 */

import {
  publishedAttemptFactsFromState,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorDiagnostic,
  type ExecutorOutcome,
  type ExecutorResult,
  type ValidateExecutorResultOptions,
} from "./executor-contract.js";
import type {
  Diagnostic,
  EvidenceReference,
  FactInput,
  HypagraphCommand,
  HypagraphState,
} from "./model.js";

// ---------------------------------------------------------------------------
// Settlement plan
// ---------------------------------------------------------------------------

/** One pure domain step produced from a validated executor result. */
export type ExecutorSettlementStep =
  | {
    kind: "publish-facts";
    nodeId: string;
    attemptId: string;
    facts: FactInput[];
  }
  | {
    kind: "submit-result";
    nodeId: string;
    attemptId: string;
    evidence: EvidenceReference[];
  }
  | {
    kind: "cancel-attempt";
    nodeId: string;
    attemptId: string;
    reason: string;
  };

/**
 * Deterministic settlement plan for one accepted executor result.
 * Command IDs and timestamps are not part of the plan.
 */
export interface ExecutorSettlementPlan {
  outcome: ExecutorOutcome;
  identity: ExecutorAttemptIdentity;
  steps: ExecutorSettlementStep[];
  summary: string;
  resultDiagnostics: ExecutorDiagnostic[];
}

/** Pure caller-supplied meta for materializing Hypagraph commands. */
export interface SettleExecutorResultMeta {
  /** ISO-8601 timestamp. Pure input. The domain does not read the clock. */
  at: string;
  /** Correlation ID shared by all commands in this settlement. */
  correlationId: string;
  /**
   * Produce one command ID per plan step, in order.
   * Called once per step. The supplier must return a non-empty string.
   */
  commandIdForStep: (stepIndex: number, step: ExecutorSettlementStep) => string;
}

/**
 * Optional settlement inputs for protocol checks that need canonical state.
 * Isolated executors may omit this. Current-session submit may pass state so
 * required facts already published on the attempt satisfy the protocol.
 */
export interface SettleExecutorResultOptions {
  /** Workflow state used to load facts already published by this node attempt. */
  state?: HypagraphState;
  /**
   * Explicit published attempt facts. When set, takes precedence over state extraction.
   */
  publishedAttemptFacts?: ValidateExecutorResultOptions["publishedAttemptFacts"];
}

export type SettleExecutorResultResult =
  | {
    ok: true;
    result: ExecutorResult;
    plan: ExecutorSettlementPlan;
    commands: HypagraphCommand[];
    /**
     * Executor diagnostics from the accepted result envelope.
     * Host surfaces may report these. Settlement does not commit them as domain events.
     */
    resultDiagnostics: ExecutorDiagnostic[];
    /** Accepted result summary. Available to the host without reading plan fields. */
    summary: string;
  }
  | { ok: false; diagnostics: Diagnostic[] };

export type MapExecutorResultToSettlementPlanResult =
  | { ok: true; plan: ExecutorSettlementPlan }
  | { ok: false; diagnostics: Diagnostic[] };

export type BuildSettlementCommandsResult =
  | { ok: true; commands: HypagraphCommand[] }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = (code: string, message: string, location?: string): { ok: false; diagnostics: Diagnostic[] } => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays and class instances.
 */
const isStrictPlainObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Map a validated executor result to a pure settlement plan.
 *
 * Outcome mapping for m7-s7:
 * - submitted: publish facts when present, then submit-result.
 * - failed, cancelled, timed_out, interrupted: one cancel-attempt step.
 *
 * Domain status note:
 * There is no fail-attempt command for a running task in m7-s7.
 * cancel-attempt projects attempt and node status to `cancelled`.
 * Reason strings keep the executor outcome intent (Failed / Timed out / Interrupted).
 * A later slice may add a fail-attempt path without changing this contract shape.
 *
 * Facts and evidence note:
 * Only the submitted outcome commits facts and evidence as domain commands.
 * Non-submitted outcomes keep facts and evidence on the accepted ExecutorResult
 * for host reporting. Settlement does not publish them on cancel.
 *
 * Does not mutate the result. Does not read the clock or create IDs.
 */
export function mapExecutorResultToSettlementPlan(
  result: ExecutorResult,
): MapExecutorResultToSettlementPlanResult {
  if (result === null || result === undefined || !isStrictPlainObject(result as unknown)) {
    return reject(
      "executor_settlement_invalid_result",
      "Settlement requires a plain accepted executor result.",
      "result",
    );
  }

  const identity: ExecutorAttemptIdentity = {
    familyId: result.familyId,
    goalId: result.goalId,
    workflowId: result.workflowId,
    revision: result.revision,
    nodeId: result.nodeId,
    attemptId: result.attemptId,
  };

  if (!isNonEmptyString(identity.familyId)
    || !isNonEmptyString(identity.goalId)
    || !isNonEmptyString(identity.workflowId)
    || !isNonEmptyString(identity.nodeId)
    || !isNonEmptyString(identity.attemptId)
    || !Number.isSafeInteger(identity.revision)
    || identity.revision < 0
  ) {
    return reject(
      "executor_settlement_invalid_identity",
      "Settlement requires complete attempt identity on the accepted result.",
      "result",
    );
  }

  if (typeof result.summary !== "string") {
    return reject(
      "executor_settlement_invalid_summary",
      "Settlement requires a string summary on the accepted result.",
      "result.summary",
    );
  }

  if (!Array.isArray(result.facts) || !Array.isArray(result.evidence) || !Array.isArray(result.diagnostics)) {
    return reject(
      "executor_settlement_invalid_result",
      "Settlement requires facts, evidence, and diagnostics arrays on the accepted result.",
      "result",
    );
  }

  const steps: ExecutorSettlementStep[] = [];
  const reason = settlementReason(result);

  switch (result.outcome) {
    case "submitted": {
      if (result.facts.length > 0) {
        steps.push({
          kind: "publish-facts",
          nodeId: identity.nodeId,
          attemptId: identity.attemptId,
          facts: structuredClone(result.facts),
        });
      }
      steps.push({
        kind: "submit-result",
        nodeId: identity.nodeId,
        attemptId: identity.attemptId,
        evidence: structuredClone(result.evidence),
      });
      break;
    }
    case "failed":
    case "cancelled":
    case "timed_out":
    case "interrupted": {
      // Intentional m7-s7 mapping: cancel-attempt until a fail-attempt command exists.
      // Facts and evidence on non-submitted results are not committed (see function docs).
      steps.push({
        kind: "cancel-attempt",
        nodeId: identity.nodeId,
        attemptId: identity.attemptId,
        reason,
      });
      break;
    }
    default: {
      return reject(
        "executor_settlement_outcome_unknown",
        `Settlement does not support outcome '${String((result as ExecutorResult).outcome)}'.`,
        "result.outcome",
      );
    }
  }

  return {
    ok: true,
    plan: {
      outcome: result.outcome,
      identity,
      steps,
      summary: result.summary,
      resultDiagnostics: structuredClone(result.diagnostics),
    },
  };
}

/**
 * Build Hypagraph commands from a settlement plan and pure meta inputs.
 * Returns diagnostics when meta is invalid. Does not mutate the plan.
 */
export function buildSettlementCommands(
  plan: ExecutorSettlementPlan,
  meta: SettleExecutorResultMeta,
): BuildSettlementCommandsResult {
  if (plan === null || plan === undefined || !isStrictPlainObject(plan as unknown)) {
    return reject(
      "executor_settlement_invalid_plan",
      "Command build requires a plain settlement plan.",
      "plan",
    );
  }
  if (!Array.isArray(plan.steps)) {
    return reject(
      "executor_settlement_invalid_plan",
      "Settlement plan requires a steps array.",
      "plan.steps",
    );
  }
  if (meta === null || meta === undefined || !isStrictPlainObject(meta as unknown)) {
    return reject(
      "executor_settlement_invalid_meta",
      "Command build requires plain settlement meta.",
      "meta",
    );
  }
  if (!isNonEmptyString(meta.at)) {
    return reject(
      "executor_settlement_invalid_meta",
      "Settlement meta requires a non-empty at timestamp.",
      "meta.at",
    );
  }
  if (!isNonEmptyString(meta.correlationId)) {
    return reject(
      "executor_settlement_invalid_meta",
      "Settlement meta requires a non-empty correlationId.",
      "meta.correlationId",
    );
  }
  if (typeof meta.commandIdForStep !== "function") {
    return reject(
      "executor_settlement_invalid_meta",
      "Settlement meta requires a commandIdForStep function.",
      "meta.commandIdForStep",
    );
  }

  const commands: HypagraphCommand[] = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]!;
    let commandId: string;
    try {
      commandId = meta.commandIdForStep(index, step);
    } catch {
      return reject(
        "executor_settlement_command_id_failed",
        `commandIdForStep failed at step index ${index}.`,
        `meta.commandIdForStep[${index}]`,
      );
    }
    if (!isNonEmptyString(commandId)) {
      return reject(
        "executor_settlement_invalid_command_id",
        `commandIdForStep at step index ${index} must return a non-empty string.`,
        `meta.commandIdForStep[${index}]`,
      );
    }

    const base = {
      commandId,
      correlationId: meta.correlationId,
      at: meta.at,
    };

    if (step.kind === "publish-facts") {
      commands.push({
        ...base,
        type: "publish-facts",
        nodeId: step.nodeId,
        attemptId: step.attemptId,
        facts: structuredClone(step.facts),
      });
      continue;
    }
    if (step.kind === "submit-result") {
      commands.push({
        ...base,
        type: "submit-result",
        nodeId: step.nodeId,
        attemptId: step.attemptId,
        evidence: structuredClone(step.evidence),
      });
      continue;
    }
    if (step.kind === "cancel-attempt") {
      commands.push({
        ...base,
        type: "cancel-attempt",
        nodeId: step.nodeId,
        attemptId: step.attemptId,
        reason: step.reason,
      });
      continue;
    }
    return reject(
      "executor_settlement_step_unknown",
      `Settlement plan has an unknown step kind at index ${index}.`,
      `plan.steps[${index}]`,
    );
  }

  return { ok: true, commands };
}

/**
 * Validate an untrusted executor result and map it to domain commands.
 *
 * This is the shared settlement path for current-session and isolated executors.
 * On failure, returns diagnostics only. No commands are produced from raw text
 * or invalid envelopes.
 *
 * Pure with respect to clock, random, files, network, and input mutation.
 * Timestamps and command IDs come only from meta.
 */
export function settleExecutorResult(
  context: ExecutorContextEnvelope,
  untrustedResult: unknown,
  meta: SettleExecutorResultMeta,
  options: SettleExecutorResultOptions = {},
): SettleExecutorResultResult {
  const publishedAttemptFacts = options.publishedAttemptFacts
    ?? (options.state
      ? publishedAttemptFactsFromState(
        options.state,
        context.identity.nodeId,
        context.identity.attemptId,
      )
      : undefined);

  const validated = validateExecutorResult(
    context,
    untrustedResult,
    publishedAttemptFacts !== undefined ? { publishedAttemptFacts } : {},
  );
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }

  const planned = mapExecutorResultToSettlementPlan(validated.value);
  if (!planned.ok) {
    return { ok: false, diagnostics: planned.diagnostics };
  }

  const built = buildSettlementCommands(planned.plan, meta);
  if (!built.ok) {
    return { ok: false, diagnostics: built.diagnostics };
  }

  return {
    ok: true,
    result: validated.value,
    plan: planned.plan,
    commands: built.commands,
    resultDiagnostics: structuredClone(planned.plan.resultDiagnostics),
    summary: planned.plan.summary,
  };
}

/**
 * Build a stable cancel reason from the accepted result summary and diagnostics.
 * Use a non-empty summary when present. When the summary is empty, use the first
 * diagnostic message or the default outcome reason.
 */
function settlementReason(result: ExecutorResult): string {
  const summary = result.summary.trim();
  if (summary.length > 0) {
    if (result.outcome === "timed_out" && !/timeout|timed out/i.test(summary)) {
      return `Timed out: ${summary}`;
    }
    if (result.outcome === "interrupted" && !/interrupt/i.test(summary)) {
      return `Interrupted: ${summary}`;
    }
    if (result.outcome === "failed" && !/fail/i.test(summary)) {
      return `Failed: ${summary}`;
    }
    return summary;
  }

  const first = result.diagnostics[0];
  if (first && isNonEmptyString(first.message)) {
    return first.message.trim();
  }

  switch (result.outcome) {
    case "failed":
      return "The executor reported failure.";
    case "cancelled":
      return "The executor attempt was cancelled.";
    case "timed_out":
      return "The executor attempt timed out.";
    case "interrupted":
      return "The executor attempt was interrupted.";
    default:
      return "The active attempt was cancelled.";
  }
}
