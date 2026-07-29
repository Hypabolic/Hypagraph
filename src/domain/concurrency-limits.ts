/**
 * Pure global and per-executor concurrency limits for isolated attempts (M8-s7).
 *
 * Dispatch may admit an attempt only when the global active count and the
 * active count for that executor kind both stay within configured limits.
 * Initial default global concurrency is two isolated attempts.
 *
 * Per-executor default: when a kind has no explicit limit, that kind inherits
 * the resolved global concurrency limit. Both limits apply on every admit.
 * An executor at capacity does not block a different executor when global
 * capacity remains. When the global limit is exhausted, no executor admits.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * Untrusted property reads use own data-property descriptors only. Accessor
 * properties are rejected with diagnostics. Returned records contain only
 * validated concurrency fields.
 * The concurrency state is an in-memory value. Persistence and schema restore
 * belong to later M8 slices; the state type carries schemaVersion for that work.
 * Family concurrent selection (m8-s9) composes these limits through
 * selectFamilyConcurrentActions on the family scheduler surface.
 */

import type { ExecutorKind } from "./executor-contract.js";
import type { Diagnostic } from "./model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a future persisted concurrency state. Always 1 in this slice. */
export const CONCURRENCY_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Default maximum concurrent isolated attempts across all executors.
 * Roadmap M8: initial default concurrency is two isolated attempts.
 */
export const DEFAULT_GLOBAL_CONCURRENCY = 2;

const EXECUTOR_KINDS = [
  "current-session",
  "isolated-pi",
  "acp",
  "cli",
  "deterministic",
] as const satisfies readonly ExecutorKind[];

const EXECUTOR_KIND_SET = new Set<string>(EXECUTOR_KINDS);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One active attempt tracked for concurrency admission.
 * attemptId is the unique identity for admit and release.
 * executorKind selects the per-executor limit bucket.
 * profileId is optional metadata for later profile-scoped limits.
 */
export interface ConcurrencyActiveAttempt {
  attemptId: string;
  executorKind: ExecutorKind;
  /** Optional profile identity when known. Not used for default limit buckets. */
  profileId?: string;
}

/**
 * In-memory concurrency state: the set of active attempts.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be CONCURRENCY_STATE_SCHEMA_VERSION when present.
 */
export interface ConcurrencyState {
  schemaVersion: typeof CONCURRENCY_STATE_SCHEMA_VERSION;
  attempts: ConcurrencyActiveAttempt[];
}

/**
 * Optional concurrency bounds for tests and configuration.
 * Omitted fields use defaults. Present values must be non-negative safe integers.
 * When a limit is 0, no new attempts can be admitted under that limit.
 */
export interface ConcurrencyLimits {
  /**
   * Maximum concurrent attempts across all executors.
   * Default DEFAULT_GLOBAL_CONCURRENCY (2).
   */
  globalConcurrency?: number;
  /**
   * Maximum concurrent attempts for each executor kind.
   * When a kind is absent, that kind inherits the resolved global concurrency limit.
   */
  perExecutorKind?: Partial<Record<ExecutorKind, number>>;
}

export type ConcurrencyAdmitResult =
  | { ok: true; state: ConcurrencyState }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyCanAdmitResult =
  | { ok: true }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyReleaseResult =
  | {
    ok: true;
    state: ConcurrencyState;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyCountResult =
  | { ok: true; count: number }
  | { ok: false; diagnostics: Diagnostic[] };

export type ConcurrencyListResult =
  | { ok: true; attempts: ConcurrencyActiveAttempt[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type ConcurrencyGetResult =
  | { ok: true; attempt: ConcurrencyActiveAttempt | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

export interface ResolvedConcurrencyLimits {
  globalConcurrency: number;
  /**
   * Explicit per-kind limits only. Callers resolve a kind with
   * resolveExecutorKindLimit when the kind is absent.
   */
  perExecutorKind: Partial<Record<ExecutorKind, number>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 * Failed reflective prototype access is treated as not plain.
 */
const isStrictPlainObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

/**
 * Render an untrusted value for a diagnostic message without calling methods
 * on objects. Safe primitives use String. Objects and functions use a fixed label.
 */
function formatUntrustedDiagnosticValue(value: unknown): string {
  if (value === null) return "null";
  const valueType = typeof value;
  if (
    valueType === "string"
    || valueType === "number"
    || valueType === "boolean"
    || valueType === "bigint"
    || valueType === "symbol"
    || valueType === "undefined"
  ) {
    return String(value);
  }
  return "[object]";
}

type OwnDataPropertyRead =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false; diagnostic: Diagnostic };

/**
 * Read an own data property without invoking getters or setters.
 * Absent own property yields present: false.
 * Accessor properties (including empty get/set) and failed reflective access
 * yield a diagnostic. Only descriptors with a data `value` key are accepted.
 */
function readOwnDataProperty(
  object: object,
  key: string,
  location: string,
): OwnDataPropertyRead {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "concurrency_invalid_accessor",
        `Unable to inspect property '${key}'.`,
        location,
      ),
    };
  }
  if (descriptor === undefined) {
    return { ok: true, present: false };
  }
  // Accessor descriptors have get/set keys even when both functions are undefined.
  // Data descriptors have a value key. Reject anything that is not a data property.
  if ("get" in descriptor || "set" in descriptor || !("value" in descriptor)) {
    return {
      ok: false,
      diagnostic: reject(
        "concurrency_invalid_accessor",
        `Property '${key}' must be a data property. Accessor properties are not allowed.`,
        location,
      ),
    };
  }
  return { ok: true, present: true, value: descriptor.value };
}

/**
 * List own enumerable string keys without throwing on hostile proxies.
 */
function readOwnEnumerableKeys(
  object: object,
  location: string,
): { ok: true; keys: string[] } | { ok: false; diagnostic: Diagnostic } {
  try {
    return { ok: true, keys: Object.keys(object) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "concurrency_invalid_accessor",
        "Unable to enumerate own properties.",
        location,
      ),
    };
  }
}

/**
 * Read an array element as an own data property without invoking index getters.
 */
function readArrayElement(
  array: unknown[],
  index: number,
  location: string,
): OwnDataPropertyRead {
  return readOwnDataProperty(array, String(index), location);
}

/**
 * Resolve an optional bound. Omitted values use the fallback.
 * Present values must be non-negative safe integers; invalid values produce a diagnostic.
 */
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
        "concurrency_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

/**
 * Build a clean attempt record from validated fields only.
 * Does not copy unknown extra properties.
 */
function copyActiveAttempt(attempt: ConcurrencyActiveAttempt): ConcurrencyActiveAttempt {
  const copy: ConcurrencyActiveAttempt = {
    attemptId: attempt.attemptId,
    executorKind: attempt.executorKind,
  };
  if (attempt.profileId !== undefined) {
    copy.profileId = attempt.profileId;
  }
  return copy;
}

/**
 * Build a clean concurrency state from validated fields only.
 */
function copyConcurrencyState(state: ConcurrencyState): ConcurrencyState {
  return {
    schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
    attempts: state.attempts.map(copyActiveAttempt),
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Resolve optional concurrency limits.
 * Global default is DEFAULT_GLOBAL_CONCURRENCY.
 * Per-executor kinds that are absent inherit the resolved global limit at admit time.
 * Accepts untrusted input. When limits is present it must be a strict plain object.
 * Only own data properties are read. Accessor properties are rejected.
 * Does not mutate the input limits object.
 */
export function resolveConcurrencyLimits(
  limits?: unknown,
): { ok: true; value: ResolvedConcurrencyLimits } | { ok: false; diagnostics: Diagnostic[] } {
  if (limits === undefined) {
    return {
      ok: true,
      value: {
        globalConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
        perExecutorKind: {},
      },
    };
  }

  if (!isStrictPlainObject(limits)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_invalid_limits",
        "Concurrency limits must be a plain object when present.",
        "limits",
      )],
    };
  }

  const limitsObject = limits as object;
  const globalRead = readOwnDataProperty(limitsObject, "globalConcurrency", "limits.globalConcurrency");
  if (!globalRead.ok) {
    return { ok: false, diagnostics: [globalRead.diagnostic] };
  }
  const globalResolution = resolveNonNegativeSafeIntegerBound(
    globalRead.present ? (globalRead.value as number | undefined) : undefined,
    DEFAULT_GLOBAL_CONCURRENCY,
    "limits.globalConcurrency",
  );
  if (!globalResolution.ok) {
    return { ok: false, diagnostics: [globalResolution.diagnostic] };
  }

  const perExecutorKind: Partial<Record<ExecutorKind, number>> = {};
  const perKindRead = readOwnDataProperty(limitsObject, "perExecutorKind", "limits.perExecutorKind");
  if (!perKindRead.ok) {
    return { ok: false, diagnostics: [perKindRead.diagnostic] };
  }
  if (perKindRead.present && perKindRead.value !== undefined) {
    if (!isStrictPlainObject(perKindRead.value)) {
      return {
        ok: false,
        diagnostics: [reject(
          "concurrency_invalid_per_executor_map",
          "perExecutorKind must be a plain object when present.",
          "limits.perExecutorKind",
        )],
      };
    }
    const kindRecord = perKindRead.value as object;
    const keysResult = readOwnEnumerableKeys(kindRecord, "limits.perExecutorKind");
    if (!keysResult.ok) {
      return { ok: false, diagnostics: [keysResult.diagnostic] };
    }
    for (const key of keysResult.keys) {
      if (!EXECUTOR_KIND_SET.has(key)) {
        return {
          ok: false,
          diagnostics: [reject(
            "concurrency_invalid_executor_kind",
            `Unknown executor kind '${key}' in perExecutorKind.`,
            `limits.perExecutorKind.${key}`,
          )],
        };
      }
      const boundRead = readOwnDataProperty(
        kindRecord,
        key,
        `limits.perExecutorKind.${key}`,
      );
      if (!boundRead.ok) {
        return { ok: false, diagnostics: [boundRead.diagnostic] };
      }
      if (!boundRead.present || !isNonNegativeSafeInteger(boundRead.value)) {
        return {
          ok: false,
          diagnostics: [reject(
            "concurrency_invalid_bound",
            `Bound at limits.perExecutorKind.${key} must be a non-negative safe integer when present.`,
            `limits.perExecutorKind.${key}`,
          )],
        };
      }
      perExecutorKind[key as ExecutorKind] = boundRead.value;
    }
  }

  return {
    ok: true,
    value: {
      globalConcurrency: globalResolution.value,
      perExecutorKind,
    },
  };
}

/**
 * Resolve the limit for one executor kind.
 * When the kind has no explicit entry, the kind inherits globalConcurrency.
 */
export function resolveExecutorKindLimit(
  resolved: ResolvedConcurrencyLimits,
  executorKind: ExecutorKind,
): number {
  const explicit = resolved.perExecutorKind[executorKind];
  if (explicit !== undefined) return explicit;
  return resolved.globalConcurrency;
}

// ---------------------------------------------------------------------------
// Validation and parse
// ---------------------------------------------------------------------------

/**
 * Extract a clean active attempt from untrusted input.
 * Reads only own data properties. Rejects accessors. Does not mutate input.
 */
function extractConcurrencyActiveAttempt(
  value: unknown,
  location = "attempt",
): { ok: true; value: ConcurrencyActiveAttempt } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_attempt_not_plain_object",
        "Concurrency active attempt must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];

  const attemptIdRead = readOwnDataProperty(record, "attemptId", `${location}.attemptId`);
  if (!attemptIdRead.ok) {
    return { ok: false, diagnostics: [attemptIdRead.diagnostic] };
  }
  let attemptId: string | undefined;
  if (!attemptIdRead.present || !isNonEmptyString(attemptIdRead.value)) {
    diagnostics.push(reject(
      "concurrency_invalid_attempt_id",
      "attemptId must be a non-empty string.",
      `${location}.attemptId`,
    ));
  } else {
    attemptId = attemptIdRead.value.trim();
  }

  const kindRead = readOwnDataProperty(record, "executorKind", `${location}.executorKind`);
  if (!kindRead.ok) {
    return { ok: false, diagnostics: [kindRead.diagnostic] };
  }
  let executorKind: ExecutorKind | undefined;
  if (
    !kindRead.present
    || typeof kindRead.value !== "string"
    || !EXECUTOR_KIND_SET.has(kindRead.value)
  ) {
    diagnostics.push(reject(
      "concurrency_invalid_executor_kind",
      "executorKind must be a known executor kind.",
      `${location}.executorKind`,
    ));
  } else {
    executorKind = kindRead.value as ExecutorKind;
  }

  const profileRead = readOwnDataProperty(record, "profileId", `${location}.profileId`);
  if (!profileRead.ok) {
    return { ok: false, diagnostics: [profileRead.diagnostic] };
  }
  let profileId: string | undefined;
  if (profileRead.present) {
    if (!isNonEmptyString(profileRead.value)) {
      diagnostics.push(reject(
        "concurrency_invalid_profile_id",
        "profileId must be a non-empty string when present.",
        `${location}.profileId`,
      ));
    } else {
      profileId = profileRead.value.trim();
    }
  }

  if (diagnostics.length > 0 || attemptId === undefined || executorKind === undefined) {
    return { ok: false, diagnostics };
  }

  const attempt: ConcurrencyActiveAttempt = {
    attemptId,
    executorKind,
  };
  if (profileId !== undefined) {
    attempt.profileId = profileId;
  }
  return { ok: true, value: attempt };
}

/**
 * Validate one active attempt record.
 * Accepts untrusted input. Rejects class instances and accessors. Does not mutate input.
 */
export function validateConcurrencyActiveAttempt(
  value: unknown,
  location = "attempt",
): Diagnostic[] {
  const extracted = extractConcurrencyActiveAttempt(value, location);
  return extracted.ok ? [] : extracted.diagnostics;
}

/**
 * Parse a valid active attempt into a clean record with only concurrency fields.
 * Trims string fields. Does not mutate input. Does not copy extra properties.
 */
export function parseConcurrencyActiveAttempt(
  value: unknown,
  location = "attempt",
): { ok: true; value: ConcurrencyActiveAttempt } | { ok: false; diagnostics: Diagnostic[] } {
  return extractConcurrencyActiveAttempt(value, location);
}

/**
 * Parse concurrency state into a clean value with only validated fields.
 * Validates structure, every stored attempt, and unique canonical attempt ids.
 * Returns diagnostics only on failure. Does not throw. Does not mutate input.
 */
function parseConcurrencyState(
  value: unknown,
  location = "concurrencyState",
): { ok: true; value: ConcurrencyState } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_state_not_plain_object",
        "Concurrency state must be a plain object.",
        location,
      )],
    };
  }

  const stateObject = value as object;
  const schemaRead = readOwnDataProperty(stateObject, "schemaVersion", `${location}.schemaVersion`);
  if (!schemaRead.ok) {
    return { ok: false, diagnostics: [schemaRead.diagnostic] };
  }
  if (!schemaRead.present || schemaRead.value !== CONCURRENCY_STATE_SCHEMA_VERSION) {
    const reportedVersion = schemaRead.present
      ? formatUntrustedDiagnosticValue(schemaRead.value)
      : "undefined";
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_state_unsupported_schema",
        `Unsupported concurrency state schema version '${reportedVersion}'. Expected ${CONCURRENCY_STATE_SCHEMA_VERSION}.`,
        `${location}.schemaVersion`,
      )],
    };
  }

  const attemptsRead = readOwnDataProperty(stateObject, "attempts", `${location}.attempts`);
  if (!attemptsRead.ok) {
    return { ok: false, diagnostics: [attemptsRead.diagnostic] };
  }
  if (!attemptsRead.present || !Array.isArray(attemptsRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_state_invalid_attempts",
        "Concurrency state attempts must be an array.",
        `${location}.attempts`,
      )],
    };
  }

  const rawAttempts = attemptsRead.value as unknown[];
  const diagnostics: Diagnostic[] = [];
  const seenAttemptIds = new Set<string>();
  const cleanAttempts: ConcurrencyActiveAttempt[] = [];

  // Read length as an own data property. Do not use the length getter trap.
  const lengthRead = readOwnDataProperty(
    rawAttempts as object,
    "length",
    `${location}.attempts.length`,
  );
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_state_invalid_attempts",
        "Concurrency state attempts length must be a non-negative safe integer data property.",
        `${location}.attempts.length`,
      )],
    };
  }
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `${location}.attempts[${index}]`;
    const elementRead = readArrayElement(rawAttempts, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present) {
      diagnostics.push(reject(
        "concurrency_attempt_not_plain_object",
        "Concurrency active attempt must be a plain object.",
        itemLocation,
      ));
      continue;
    }
    const extracted = extractConcurrencyActiveAttempt(elementRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    if (seenAttemptIds.has(extracted.value.attemptId)) {
      diagnostics.push(reject(
        "concurrency_state_duplicate_attempt_id",
        `Attempt id '${extracted.value.attemptId}' appears more than once in the concurrency state.`,
        `${itemLocation}.attemptId`,
      ));
      continue;
    }
    seenAttemptIds.add(extracted.value.attemptId);
    cleanAttempts.push(extracted.value);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
      attempts: cleanAttempts,
    },
  };
}

/**
 * Validate concurrency state structure, every stored attempt, and unique
 * canonical attempt ids.
 * Used on every state-touching path and when a future restore path supplies state.
 * Returns diagnostics only. Does not throw. Does not mutate input.
 */
export function validateConcurrencyStateSchema(
  value: unknown,
  location = "concurrencyState",
): Diagnostic[] {
  const parsed = parseConcurrencyState(value, location);
  return parsed.ok ? [] : parsed.diagnostics;
}

// ---------------------------------------------------------------------------
// Active set operations
// ---------------------------------------------------------------------------

/**
 * Create an empty concurrency state.
 * schemaVersion is fixed for this contract version.
 */
export function createEmptyConcurrencyState(): ConcurrencyState {
  return {
    schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
    attempts: [],
  };
}

/**
 * List active attempts as clean field copies so callers cannot mutate the state.
 * Rejects invalid concurrency state with diagnostics.
 */
export function listConcurrencyActiveAttempts(state: ConcurrencyState): ConcurrencyListResult {
  const parsed = parseConcurrencyState(state, "concurrencyState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return {
    ok: true,
    attempts: parsed.value.attempts
      .map(copyActiveAttempt)
      .sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
  };
}

/**
 * Return a clean copy of one active attempt, or undefined when absent.
 * Trims the lookup id to match stored identity. Rejects invalid state.
 */
export function getConcurrencyActiveAttempt(
  state: ConcurrencyState,
  attemptId: string,
): ConcurrencyGetResult {
  const parsed = parseConcurrencyState(state, "concurrencyState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  if (typeof attemptId !== "string") {
    return { ok: true, attempt: undefined };
  }
  const id = attemptId.trim();
  if (id.length === 0) return { ok: true, attempt: undefined };
  const found = parsed.value.attempts.find((attempt) => attempt.attemptId === id);
  return { ok: true, attempt: found ? copyActiveAttempt(found) : undefined };
}

/**
 * Return the global active attempt count.
 * Rejects invalid concurrency state with diagnostics.
 */
export function getGlobalActiveCount(state: ConcurrencyState): ConcurrencyCountResult {
  const parsed = parseConcurrencyState(state, "concurrencyState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return { ok: true, count: parsed.value.attempts.length };
}

/**
 * Return the active attempt count for one executor kind.
 * Rejects invalid concurrency state with diagnostics.
 * Rejects an unknown executor kind with a diagnostic.
 */
export function getExecutorActiveCount(
  state: ConcurrencyState,
  executorKind: ExecutorKind,
): ConcurrencyCountResult {
  const parsed = parseConcurrencyState(state, "concurrencyState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  if (typeof executorKind !== "string" || !EXECUTOR_KIND_SET.has(executorKind)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_invalid_executor_kind",
        "executorKind must be a known executor kind.",
        "executorKind",
      )],
    };
  }
  const count = parsed.value.attempts.filter(
    (attempt) => attempt.executorKind === executorKind,
  ).length;
  return { ok: true, count };
}

/**
 * Admission checks on already-parsed clean snapshots only.
 * Does not read untrusted input. Does not mutate inputs.
 */
function evaluateAdmissionFromSnapshots(
  cleanState: ConcurrencyState,
  cleanAttempt: ConcurrencyActiveAttempt,
  resolvedLimits: ResolvedConcurrencyLimits,
): ConcurrencyCanAdmitResult {
  const active = cleanState.attempts;
  const { globalConcurrency } = resolvedLimits;

  if (active.some((entry) => entry.attemptId === cleanAttempt.attemptId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_duplicate_attempt",
        `Attempt id '${cleanAttempt.attemptId}' is already active.`,
        "attempt.attemptId",
      )],
    };
  }

  if (active.length >= globalConcurrency) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_global_limit",
        `The global concurrent attempt count must not exceed ${globalConcurrency}.`,
        "concurrencyState.attempts",
      )],
    };
  }

  const kindLimit = resolveExecutorKindLimit(resolvedLimits, cleanAttempt.executorKind);
  const kindCount = active.filter(
    (entry) => entry.executorKind === cleanAttempt.executorKind,
  ).length;
  if (kindCount >= kindLimit) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_executor_limit",
        `The concurrent attempt count for executor kind '${cleanAttempt.executorKind}' must not exceed ${kindLimit}.`,
        "attempt.executorKind",
      )],
    };
  }

  return { ok: true };
}

/**
 * Parse untrusted state, candidate, and limits once into clean snapshots.
 * Shared by canAdmitAttempt and admitAttempt so admission never re-reads
 * untrusted descriptors after the first parse.
 */
function parseAdmissionInputs(
  state: unknown,
  candidate: unknown,
  limits?: unknown,
):
  | {
    ok: true;
    cleanState: ConcurrencyState;
    cleanAttempt: ConcurrencyActiveAttempt;
    resolvedLimits: ResolvedConcurrencyLimits;
  }
  | { ok: false; diagnostics: Diagnostic[] } {
  const resolvedLimits = resolveConcurrencyLimits(limits);
  if (!resolvedLimits.ok) {
    return { ok: false, diagnostics: resolvedLimits.diagnostics };
  }

  const parsedState = parseConcurrencyState(state, "concurrencyState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  const parsedAttempt = parseConcurrencyActiveAttempt(candidate, "attempt");
  if (!parsedAttempt.ok) {
    return { ok: false, diagnostics: parsedAttempt.diagnostics };
  }

  return {
    ok: true,
    cleanState: parsedState.value,
    cleanAttempt: parsedAttempt.value,
    resolvedLimits: resolvedLimits.value,
  };
}

/**
 * Check whether a candidate attempt can join the active set under the limits.
 * Validates the state (including every stored attempt), the candidate,
 * uniqueness, global capacity, and per-executor capacity.
 * Parses each untrusted input once. Does not mutate inputs.
 * Returns structured diagnostics on rejection.
 */
export function canAdmitAttempt(
  state: ConcurrencyState,
  candidate: unknown,
  limits?: unknown,
): ConcurrencyCanAdmitResult {
  const parsed = parseAdmissionInputs(state, candidate, limits);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return evaluateAdmissionFromSnapshots(
    parsed.cleanState,
    parsed.cleanAttempt,
    parsed.resolvedLimits,
  );
}

/**
 * Validate, check limits, and add an attempt to a new concurrency state.
 * Parses each untrusted input once. Admission checks and the returned state
 * use only those clean snapshots (no second untrusted read).
 * Returns a clean state with only validated concurrency fields.
 * Does not mutate the input state or candidate.
 */
export function admitAttempt(
  state: ConcurrencyState,
  candidate: unknown,
  limits?: unknown,
): ConcurrencyAdmitResult {
  const parsed = parseAdmissionInputs(state, candidate, limits);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }

  const check = evaluateAdmissionFromSnapshots(
    parsed.cleanState,
    parsed.cleanAttempt,
    parsed.resolvedLimits,
  );
  if (!check.ok) {
    return { ok: false, diagnostics: check.diagnostics };
  }

  const next = copyConcurrencyState(parsed.cleanState);
  next.attempts.push(copyActiveAttempt(parsed.cleanAttempt));
  next.attempts.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  return { ok: true, state: next };
}

/**
 * Release an attempt by id when it completes or fails. Returns a new clean state.
 * When the id is absent, released is false and the state is still copied.
 * Trims the release id to match stored identity.
 * Rejects invalid concurrency state without rewriting it.
 * Does not mutate the input state.
 */
export function releaseAttempt(
  state: ConcurrencyState,
  attemptId: string,
): ConcurrencyReleaseResult {
  const parsedState = parseConcurrencyState(state, "concurrencyState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  if (typeof attemptId !== "string" || attemptId.trim().length === 0) {
    return {
      ok: true,
      state: copyConcurrencyState(parsedState.value),
      released: false,
    };
  }

  const id = attemptId.trim();
  const remaining = parsedState.value.attempts.filter((attempt) => attempt.attemptId !== id);
  const released = remaining.length !== parsedState.value.attempts.length;
  return {
    ok: true,
    state: {
      schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
      attempts: remaining.map(copyActiveAttempt),
    },
    released,
  };
}

/**
 * Propose an active attempt record from identity fields without admission.
 * Accepts untrusted input and passes it only through parseConcurrencyActiveAttempt.
 * Does not read input properties directly. Does not mutate inputs.
 */
export function proposeConcurrencyActiveAttempt(
  input: unknown,
):
  | { ok: true; value: ConcurrencyActiveAttempt }
  | { ok: false; diagnostics: Diagnostic[] } {
  return parseConcurrencyActiveAttempt(input, "attempt");
}
