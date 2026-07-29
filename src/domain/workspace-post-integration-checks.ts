/**
 * Pure post-integration base-workspace check contracts (M8-s6).
 *
 * After a successful integrate, the controller must run configured
 * post-integration checks in the base workspace before node completion.
 * This module validates check command specs and exposes completion-eligibility
 * helpers. Status transitions are defined on the integration record in
 * workspace-integration.ts.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 */

import type { Diagnostic } from "./model.js";
import {
  getIntegration,
  isIntegrationEligibleForNodeCompletion,
  markIntegrationChecking,
  markIntegrationChecksFailed,
  markIntegrationChecksPassed,
  parseWorkspaceIntegration,
  type MarkIntegrationCheckingOptions,
  type WorkspaceIntegration,
  type WorkspaceIntegrationExpectedIdentity,
  type WorkspaceIntegrationSet,
  type WorkspaceIntegrationTransitionResult,
  validateIntegrationIdentity,
  validateWorkspaceIntegrationSet,
} from "./workspace-integration.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a post-integration check command list payload. */
export const POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION = 1 as const;

/** Default maximum check commands in one run. */
export const DEFAULT_MAX_POST_INTEGRATION_CHECKS = 32;

/** Default maximum argument strings per check command. */
export const DEFAULT_MAX_CHECK_ARGS = 64;

/** Default per-command timeout in milliseconds. */
export const DEFAULT_POST_CHECK_TIMEOUT_MS = 120_000;

/** Maximum allowed per-command timeout in milliseconds. */
export const MAX_POST_CHECK_TIMEOUT_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One shell check command to run in the base workspace after integrate.
 * The host sets cwd to the base repository path.
 */
export interface PostIntegrationCheckCommand {
  /** Stable check id for diagnostics. */
  id: string;
  /** Executable name or path. Must not be empty. */
  command: string;
  /** Argument list. Optional. */
  args?: string[];
  /**
   * Timeout in milliseconds. Optional.
   * When omitted the host uses DEFAULT_POST_CHECK_TIMEOUT_MS.
   */
  timeoutMs?: number;
}

/**
 * Versioned list of post-integration check commands.
 * Carries schemaVersion for future persistence of configured checks.
 */
export interface PostIntegrationCheckList {
  schemaVersion: typeof POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION;
  checks: PostIntegrationCheckCommand[];
}

export interface PostIntegrationCheckListBounds {
  /**
   * Maximum check commands. Default DEFAULT_MAX_POST_INTEGRATION_CHECKS.
   * When present must be a non-negative safe integer.
   */
  maxChecks?: number;
  /**
   * Maximum args per command. Default DEFAULT_MAX_CHECK_ARGS.
   * When present must be a non-negative safe integer.
   */
  maxArgsPerCheck?: number;
}

export type ParsePostIntegrationCheckListResult =
  | { ok: true; value: PostIntegrationCheckList }
  | { ok: false; diagnostics: Diagnostic[] };

export type NodeCompletionEligibilityResult =
  | {
    ok: true;
    eligible: true;
    integration: WorkspaceIntegration;
  }
  | {
    ok: true;
    eligible: false;
    integration: WorkspaceIntegration;
    reason: string;
    diagnostics: Diagnostic[];
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

/**
 * Mandatory gate result for node completion after integrate and
 * post-integration checks.
 * Controllers must call requireChecksPassedForNodeCompletion before completing
 * a mutating node that used workspace integration.
 */
export type RequireChecksPassedForNodeCompletionResult =
  | {
    ok: true;
    integration: WorkspaceIntegration;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    integration?: WorkspaceIntegration;
  };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isStrictPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function resolveNonNegativeSafeIntegerBound(
  value: number | undefined,
  fallback: number,
  location: string,
): { ok: true; value: number } | { ok: false; diagnostic: Diagnostic } {
  if (value === undefined) return { ok: true, value: fallback };
  if (!isNonNegativeSafeInteger(value)) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_post_check_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Validation and parse
// ---------------------------------------------------------------------------

/**
 * Validate a single post-integration check command.
 * Rejects class instances. Does not mutate input.
 */
export function validatePostIntegrationCheckCommand(
  value: unknown,
  location = "check",
  maxArgs = DEFAULT_MAX_CHECK_ARGS,
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_post_check_not_plain_object",
      "Post-integration check command must be a plain object.",
      location,
    )];
  }

  const diagnostics: Diagnostic[] = [];
  const record = value;

  if (!isNonEmptyString(record.id)) {
    diagnostics.push(reject(
      "workspace_post_check_invalid_id",
      "check.id must be a non-empty string.",
      `${location}.id`,
    ));
  }

  if (!isNonEmptyString(record.command)) {
    diagnostics.push(reject(
      "workspace_post_check_invalid_command",
      "check.command must be a non-empty string.",
      `${location}.command`,
    ));
  }

  if (record.args !== undefined) {
    if (!Array.isArray(record.args)) {
      diagnostics.push(reject(
        "workspace_post_check_invalid_args",
        "check.args must be a string array when present.",
        `${location}.args`,
      ));
    } else {
      if (record.args.length > maxArgs) {
        diagnostics.push(reject(
          "workspace_post_check_args_limit",
          `check.args length ${record.args.length} exceeds maxArgsPerCheck ${maxArgs}.`,
          `${location}.args`,
        ));
      }
      for (let index = 0; index < record.args.length; index += 1) {
        if (typeof record.args[index] !== "string") {
          diagnostics.push(reject(
            "workspace_post_check_invalid_args",
            `check.args at index ${index} must be a string.`,
            `${location}.args[${index}]`,
          ));
        }
      }
    }
  }

  if (record.timeoutMs !== undefined) {
    if (!isPositiveSafeInteger(record.timeoutMs)) {
      diagnostics.push(reject(
        "workspace_post_check_invalid_timeout",
        "check.timeoutMs must be a positive safe integer when present.",
        `${location}.timeoutMs`,
      ));
    } else if (record.timeoutMs > MAX_POST_CHECK_TIMEOUT_MS) {
      diagnostics.push(reject(
        "workspace_post_check_timeout_limit",
        `check.timeoutMs exceeds the maximum of ${MAX_POST_CHECK_TIMEOUT_MS}.`,
        `${location}.timeoutMs`,
      ));
    }
  }

  return diagnostics;
}

/**
 * Validate a versioned post-integration check list.
 * Enforces unique check ids and list size bounds.
 */
export function validatePostIntegrationCheckList(
  value: unknown,
  location = "checkList",
  bounds?: PostIntegrationCheckListBounds,
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_post_check_list_not_plain_object",
      "Post-integration check list must be a plain object.",
      location,
    )];
  }

  const record = value;
  const diagnostics: Diagnostic[] = [];

  if (record.schemaVersion !== POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION) {
    diagnostics.push(reject(
      "workspace_post_check_list_unsupported_schema",
      `Unsupported post-integration check list schema version '${String(record.schemaVersion)}'. Expected ${POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    ));
    return diagnostics;
  }

  const maxChecksBound = resolveNonNegativeSafeIntegerBound(
    bounds?.maxChecks,
    DEFAULT_MAX_POST_INTEGRATION_CHECKS,
    "bounds.maxChecks",
  );
  if (!maxChecksBound.ok) {
    return [maxChecksBound.diagnostic];
  }
  const maxArgsBound = resolveNonNegativeSafeIntegerBound(
    bounds?.maxArgsPerCheck,
    DEFAULT_MAX_CHECK_ARGS,
    "bounds.maxArgsPerCheck",
  );
  if (!maxArgsBound.ok) {
    return [maxArgsBound.diagnostic];
  }

  if (!Array.isArray(record.checks)) {
    return [reject(
      "workspace_post_check_list_invalid_checks",
      "checkList.checks must be an array.",
      `${location}.checks`,
    )];
  }

  if (record.checks.length === 0) {
    return [reject(
      "workspace_post_check_list_empty",
      "checkList.checks must include at least one check command.",
      `${location}.checks`,
    )];
  }

  if (record.checks.length > maxChecksBound.value) {
    return [reject(
      "workspace_post_check_list_limit",
      `checkList.checks length ${record.checks.length} exceeds maxChecks ${maxChecksBound.value}.`,
      `${location}.checks`,
    )];
  }

  const seenIds = new Set<string>();
  for (let index = 0; index < record.checks.length; index += 1) {
    const itemLocation = `${location}.checks[${index}]`;
    const itemDiagnostics = validatePostIntegrationCheckCommand(
      record.checks[index],
      itemLocation,
      maxArgsBound.value,
    );
    diagnostics.push(...itemDiagnostics);
    if (itemDiagnostics.length > 0) continue;
    const id = ((record.checks[index] as Record<string, unknown>).id as string).trim();
    if (seenIds.has(id)) {
      diagnostics.push(reject(
        "workspace_post_check_duplicate_id",
        `Check id '${id}' appears more than once in the list.`,
        `${itemLocation}.id`,
      ));
    }
    seenIds.add(id);
  }

  return diagnostics;
}

/**
 * Parse and clone a valid post-integration check list.
 * Does not mutate input.
 */
export function parsePostIntegrationCheckList(
  value: unknown,
  location = "checkList",
  bounds?: PostIntegrationCheckListBounds,
): ParsePostIntegrationCheckListResult {
  const diagnostics = validatePostIntegrationCheckList(value, location, bounds);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const record = value as Record<string, unknown>;
  const rawChecks = record.checks as unknown[];
  const checks: PostIntegrationCheckCommand[] = rawChecks.map((item) => {
    const entry = item as Record<string, unknown>;
    const command: PostIntegrationCheckCommand = {
      id: (entry.id as string).trim(),
      command: (entry.command as string).trim(),
    };
    if (Array.isArray(entry.args)) {
      command.args = entry.args.map((arg) => String(arg));
    }
    if (typeof entry.timeoutMs === "number") {
      command.timeoutMs = entry.timeoutMs;
    }
    return command;
  });

  return {
    ok: true,
    value: {
      schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
      checks,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure lifecycle helpers (compose integration transitions)
// ---------------------------------------------------------------------------

/**
 * Report whether post-integration checks can start for this integration.
 * Default: only status integrated.
 * When allowResume is true: also status checking (crash recovery only).
 * Does not mutate input.
 */
export function canStartPostIntegrationChecks(
  integration: WorkspaceIntegration,
  options?: MarkIntegrationCheckingOptions,
): boolean {
  if (integration.status === "integrated") return true;
  if (options?.allowResume === true && integration.status === "checking") {
    return true;
  }
  return false;
}

/**
 * Start the post-integration check phase on an integration record.
 * Marks checking when status is integrated.
 * When already checking, rejects unless options.allowResume is true.
 * The caller must assert that no host runner is active.
 * Rejects pending, integrating, conflicted, failed, aborted, released,
 * checks_passed, and checks_failed.
 * Does not mutate the input set.
 */
export function startPostIntegrationChecks(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
  options?: MarkIntegrationCheckingOptions,
): WorkspaceIntegrationTransitionResult {
  return markIntegrationChecking(set, integrationId, expected, options);
}

/**
 * Record successful post-integration checks.
 * Does not mutate the input set.
 */
export function completePostIntegrationChecksPassed(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  return markIntegrationChecksPassed(set, integrationId, expected);
}

/**
 * Record failed post-integration checks with diagnostics.
 * Does not mutate the input set.
 */
export function completePostIntegrationChecksFailed(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  failureDiagnostics: readonly Diagnostic[],
  message?: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  return markIntegrationChecksFailed(
    set,
    integrationId,
    failureDiagnostics,
    message,
    expected,
  );
}

/**
 * Evaluate node-completion eligibility for one integration in a set.
 * Eligible only when status is checks_passed and identity matches when given.
 * Does not mutate inputs.
 */
export function evaluateNodeCompletionEligibility(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity | unknown,
): NodeCompletionEligibilityResult {
  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_invalid_integration_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  const got = getIntegration(set, integrationId);
  if (!got.ok) {
    return { ok: false, diagnostics: got.diagnostics };
  }
  if (got.integration === undefined) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const integration = got.integration;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(integration, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (isIntegrationEligibleForNodeCompletion(integration)) {
    return {
      ok: true,
      eligible: true,
      integration,
    };
  }

  const reason = integration.status === "integrated"
    ? "Post-integration checks have not run. Status is integrated."
    : integration.status === "checking"
      ? "Post-integration checks are still in progress."
      : integration.status === "checks_failed"
        ? "Post-integration checks failed. Node must not complete."
        : `Integration status '${integration.status}' is not eligible for node completion.`;

  return {
    ok: true,
    eligible: false,
    integration,
    reason,
    diagnostics: [reject(
      "workspace_post_check_not_eligible",
      reason,
      "integration.status",
    )],
  };
}

/**
 * Mandatory pure gate for node completion after workspace integration.
 *
 * Controllers that complete a mutating node after integrate must call this
 * function and reject completion when ok is false. Eligibility requires
 * status checks_passed only.
 *
 * This is the product gate API for m8-s6. Controller wiring is added when the
 * integrate path connects to node completion. This matches the m8-s5 pattern
 * of pure domain and host APIs before controller integration.
 * Does not mutate inputs.
 */
export function requireChecksPassedForNodeCompletion(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity | unknown,
): RequireChecksPassedForNodeCompletionResult {
  const evaluated = evaluateNodeCompletionEligibility(
    set,
    integrationId,
    expected,
  );
  if (!evaluated.ok) {
    return { ok: false, diagnostics: evaluated.diagnostics };
  }
  if (!evaluated.eligible) {
    return {
      ok: false,
      diagnostics: evaluated.diagnostics,
      integration: evaluated.integration,
    };
  }
  return {
    ok: true,
    integration: evaluated.integration,
  };
}

/**
 * Parse an untrusted integration value and report completion eligibility.
 * Rejects non-plain objects and unsupported schema versions through parse.
 */
export function evaluateParsedIntegrationCompletionEligibility(
  value: unknown,
  location = "integration",
): NodeCompletionEligibilityResult {
  const parsed = parseWorkspaceIntegration(value, location);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  if (isIntegrationEligibleForNodeCompletion(parsed.value)) {
    return {
      ok: true,
      eligible: true,
      integration: parsed.value,
    };
  }
  const reason = parsed.value.status === "integrated"
    ? "Post-integration checks have not run. Status is integrated."
    : parsed.value.status === "checking"
      ? "Post-integration checks are still in progress."
      : parsed.value.status === "checks_failed"
        ? "Post-integration checks failed. Node must not complete."
        : `Integration status '${parsed.value.status}' is not eligible for node completion.`;
  return {
    ok: true,
    eligible: false,
    integration: parsed.value,
    reason,
    diagnostics: [reject(
      "workspace_post_check_not_eligible",
      reason,
      `${location}.status`,
    )],
  };
}
