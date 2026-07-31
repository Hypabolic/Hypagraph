/**
 * Model-node executor profile resolution (Wave 6).
 *
 * Default product routing: model task work uses isolated-pi workers.
 * current-session is allowed only as an explicit opt-in on the node.
 *
 * Pure domain policy: no clock, random, files, network, or input mutation.
 */

import type { ExecutorKind, ExecutorProfileRef } from "./executor-contract.js";
import type { Diagnostic, NodeDefinition } from "./model.js";

/** Default profile for model task nodes without an explicit profile. */
export const DEFAULT_MODEL_EXECUTOR_PROFILE: ExecutorProfileRef = {
  profileId: "isolated-pi-default",
  kind: "isolated-pi",
};

/** Explicit opt-in profile when a node must run in the orchestrator session. */
export const CURRENT_SESSION_OPT_IN_PROFILE: ExecutorProfileRef = {
  profileId: "current-session-default",
  kind: "current-session",
};

/** Action kinds that may run a model worker under default policy. */
export type ModelWorkerActionKind = "start-ready-task" | "continue-active-task";

const EXECUTOR_KINDS = new Set<ExecutorKind>([
  "current-session",
  "isolated-pi",
  "acp",
  "cli",
  "deterministic",
]);

const WORKER_KINDS = new Set<ExecutorKind>(["isolated-pi", "acp", "cli"]);

export type ModelExecutorProfileSource = "explicit" | "node" | "default";

export interface ResolveModelNodeExecutorProfileInput {
  /**
   * Highest-priority profile. Host or test harness may pass this.
   * When present and valid, it wins over the node field.
   */
  explicit?: ExecutorProfileRef | null;
  /**
   * Optional node definition. When it declares executorProfile, that profile
   * is used unless explicit is set.
   */
  node?: Pick<NodeDefinition, "id" | "kind" | "executorProfile"> | null;
  /**
   * Temporary host override that restores legacy current-session default.
   * Default false. Product default must stay isolated-pi.
   */
  legacyCurrentSessionDefault?: boolean;
}

export interface ResolvedModelNodeExecutorProfile {
  profile: ExecutorProfileRef;
  source: ModelExecutorProfileSource;
  /**
   * Authoring advisory when current-session is selected.
   * Hosts may surface this on status or validation.
   */
  advisory?: string;
}

export type ParseExecutorProfileResult =
  | { ok: true; profile: ExecutorProfileRef }
  | { ok: false; diagnostics: Diagnostic[] };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isStrictPlainObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const reject = (code: string, message: string, location?: string): ParseExecutorProfileResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const cloneProfile = (profile: ExecutorProfileRef): ExecutorProfileRef => {
  const copy: ExecutorProfileRef = {
    profileId: profile.profileId,
    kind: profile.kind,
  };
  if (profile.instanceId !== undefined) copy.instanceId = profile.instanceId;
  return copy;
};

/**
 * Parse an untrusted executor profile reference.
 * Accepts only known kinds and non-empty profileId.
 */
export function parseExecutorProfileRef(
  value: unknown,
  location = "executorProfile",
): ParseExecutorProfileResult {
  if (value === null || value === undefined) {
    return reject(
      "executor_profile_missing",
      "Executor profile is required when provided.",
      location,
    );
  }
  if (!isStrictPlainObject(value)) {
    return reject(
      "executor_profile_invalid",
      "Executor profile must be a plain object.",
      location,
    );
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.profileId)) {
    return reject(
      "executor_profile_invalid_id",
      "Executor profile requires a non-empty profileId.",
      `${location}.profileId`,
    );
  }
  if (typeof record.kind !== "string" || !EXECUTOR_KINDS.has(record.kind as ExecutorKind)) {
    return reject(
      "executor_profile_invalid_kind",
      "Executor profile requires a known kind.",
      `${location}.kind`,
    );
  }
  if (record.instanceId !== undefined && !isNonEmptyString(record.instanceId)) {
    return reject(
      "executor_profile_invalid_instance",
      "Executor profile instanceId must be a non-empty string when present.",
      `${location}.instanceId`,
    );
  }
  const profile: ExecutorProfileRef = {
    profileId: record.profileId.trim(),
    kind: record.kind as ExecutorKind,
  };
  if (record.instanceId !== undefined) {
    profile.instanceId = (record.instanceId as string).trim();
  }
  return { ok: true, profile };
}

/**
 * Read a node-declared executor profile when present and valid.
 * Invalid shapes are ignored for resolution defaults (validation can flag them separately).
 */
export function readNodeExecutorProfile(
  node: Pick<NodeDefinition, "executorProfile"> | null | undefined,
): ExecutorProfileRef | undefined {
  if (!node || node.executorProfile === undefined) return undefined;
  const parsed = parseExecutorProfileRef(node.executorProfile, "node.executorProfile");
  if (!parsed.ok) return undefined;
  return parsed.profile;
}

/**
 * Resolve the executor profile for one model task node attempt.
 *
 * Priority:
 * 1. explicit input;
 * 2. node.executorProfile when valid;
 * 3. default isolated-pi (or temporary legacy current-session when enabled).
 *
 * current-session is never the product default without explicit opt-in or legacy flag.
 */
export function resolveModelNodeExecutorProfile(
  input: ResolveModelNodeExecutorProfileInput = {},
): ResolvedModelNodeExecutorProfile {
  if (input.explicit !== undefined && input.explicit !== null) {
    const parsed = parseExecutorProfileRef(input.explicit, "explicit");
    if (parsed.ok) {
      return withAdvisory(cloneProfile(parsed.profile), "explicit");
    }
  }

  const fromNode = readNodeExecutorProfile(input.node ?? undefined);
  if (fromNode) {
    return withAdvisory(cloneProfile(fromNode), "node");
  }

  if (input.legacyCurrentSessionDefault === true) {
    return withAdvisory(cloneProfile(CURRENT_SESSION_OPT_IN_PROFILE), "default");
  }

  return withAdvisory(cloneProfile(DEFAULT_MODEL_EXECUTOR_PROFILE), "default");
}

function withAdvisory(
  profile: ExecutorProfileRef,
  source: ModelExecutorProfileSource,
): ResolvedModelNodeExecutorProfile {
  if (profile.kind === "current-session") {
    return {
      profile,
      source,
      advisory:
        "Node uses current-session. The orchestrator session will perform this model attempt. "
        + "Prefer isolated-pi unless same-session work is required.",
    };
  }
  return { profile, source };
}

/** True when the selected action is a default model worker task action. */
export function isModelWorkerActionKind(kind: string): kind is ModelWorkerActionKind {
  return kind === "start-ready-task" || kind === "continue-active-task";
}

/**
 * True when the profile must run off the orchestrator session.
 * isolated-pi, acp, and cli use host-routed workers.
 */
export function modelLaneUsesIsolatedWorker(profile: ExecutorProfileRef): boolean {
  return WORKER_KINDS.has(profile.kind);
}

/** True when the profile runs implement work in the orchestrator session. */
export function modelLaneUsesCurrentSession(profile: ExecutorProfileRef): boolean {
  return profile.kind === "current-session";
}

/**
 * Whether queueGoalContinuation must send a same-session implement follow-up.
 * Default task actions with isolated profiles must not.
 */
export function shouldSendModelLaneFollowUp(input: {
  actionKind: string;
  profile: ExecutorProfileRef;
}): boolean {
  if (!isModelWorkerActionKind(input.actionKind)) {
    // Revision and interaction keep orchestrator follow-up for this wave.
    return true;
  }
  return modelLaneUsesCurrentSession(input.profile);
}

/**
 * Authoring advisory text when a definition opts into current-session.
 * Pure helper for validation and status surfaces.
 */
export function currentSessionAuthoringAdvisory(nodeId: string): string {
  return (
    `Task node '${nodeId}' sets executorProfile kind current-session. `
    + "The orchestrator session will implement that node. "
    + "Default product routing uses isolated-pi workers."
  );
}
