/**
 * Pure concurrency groups and deterministic fairness for isolated attempts (M8-s8).
 *
 * Concurrency groups constrain which attempts may run together. An attempt may
 * join active work only when every group it belongs to still has capacity under
 * that group's maxConcurrent limit.
 *
 * Fair selection among admissible candidates prefers older ready work, then uses
 * an event-backed fairness ordinal for round-robin across fairness keys, then
 * uses stable lexicographic identity order. Selection does not use a clock or
 * random values.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * Untrusted property reads use own data-property descriptors only. Accessor
 * properties are rejected with diagnostics. Returned records contain only
 * validated group and fairness fields.
 *
 * Family concurrent selection (m8-s9) composes this module through
 * selectFamilyConcurrentActions on the family scheduler surface.
 */

import type { Diagnostic } from "./model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for concurrency group occupancy state. Always 1 in this slice. */
export const CONCURRENCY_GROUP_STATE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One named concurrency group definition.
 * maxConcurrent 1 means exclusive (mutex) within the group.
 * maxConcurrent 0 admits no members of the group.
 */
export interface ConcurrencyGroupDefinition {
  groupId: string;
  maxConcurrent: number;
}

/**
 * Resolved group registry: groupId to maxConcurrent.
 * Unknown group ids are not present. Membership that references an unknown
 * group id is invalid.
 */
export interface ResolvedConcurrencyGroupRegistry {
  definitions: ConcurrencyGroupDefinition[];
}

/**
 * One active attempt tracked for group occupancy.
 * attemptId is the unique identity for admit and release.
 * groupIds is the membership set. Empty membership does not constrain other
 * attempts through groups.
 */
export interface ConcurrencyGroupActiveAttempt {
  attemptId: string;
  groupIds: string[];
}

/**
 * In-memory group occupancy state: the set of active attempts and memberships.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be CONCURRENCY_GROUP_STATE_SCHEMA_VERSION when present.
 */
export interface ConcurrencyGroupState {
  schemaVersion: typeof CONCURRENCY_GROUP_STATE_SCHEMA_VERSION;
  attempts: ConcurrencyGroupActiveAttempt[];
}

/**
 * One fairness selection candidate.
 * readySequence is lower for older ready work.
 * fairnessKey groups candidates for event-backed round-robin.
 * groupIds is membership used for group compatibility checks.
 */
export interface FairnessCandidate {
  attemptId: string;
  readySequence: number;
  fairnessKey: string;
  groupIds: string[];
}

export type ConcurrencyGroupAdmitResult =
  | { ok: true; state: ConcurrencyGroupState }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyGroupCanAdmitResult =
  | { ok: true }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyGroupReleaseResult =
  | {
    ok: true;
    state: ConcurrencyGroupState;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type ConcurrencyGroupCountResult =
  | { ok: true; count: number }
  | { ok: false; diagnostics: Diagnostic[] };

export type ConcurrencyGroupListResult =
  | { ok: true; attempts: ConcurrencyGroupActiveAttempt[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type ConcurrencyGroupGetResult =
  | { ok: true; attempt: ConcurrencyGroupActiveAttempt | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

export type FilterAdmissibleResult =
  | { ok: true; candidates: FairnessCandidate[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type FairSelectionResult =
  | {
    ok: true;
    kind: "select";
    candidate: FairnessCandidate;
    reason: string;
  }
  | {
    ok: true;
    kind: "idle";
    reason: string;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type FairBatchResult =
  | {
    ok: true;
    selected: FairnessCandidate[];
    /** Occupancy after virtual admits of selected candidates. */
    state: ConcurrencyGroupState;
    /** Fairness ordinal after one advance per selected candidate. */
    fairnessOrdinal: number;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type SelectAndAdmitResult =
  | {
    ok: true;
    kind: "select";
    candidate: FairnessCandidate;
    state: ConcurrencyGroupState;
    reason: string;
  }
  | {
    ok: true;
    kind: "idle";
    reason: string;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 * Failed reflective prototype access is treated as not plain.
 */
const isStrictPlainObject = (value: unknown): value is Record<string, unknown> => {
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

/**
 * Locale-insensitive identity order for strings.
 * Does not use localeCompare.
 */
const compareIdentity = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

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
        "concurrency_group_invalid_accessor",
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
        "concurrency_group_invalid_accessor",
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
        "concurrency_group_invalid_accessor",
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
 * Build a clean active attempt from validated fields only.
 */
function copyActiveAttempt(
  attempt: ConcurrencyGroupActiveAttempt,
): ConcurrencyGroupActiveAttempt {
  return {
    attemptId: attempt.attemptId,
    groupIds: [...attempt.groupIds],
  };
}

/**
 * Build a clean occupancy state from validated fields only.
 */
function copyGroupState(state: ConcurrencyGroupState): ConcurrencyGroupState {
  return {
    schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
    attempts: state.attempts.map(copyActiveAttempt),
  };
}

/**
 * Build a clean fairness candidate from validated fields only.
 */
function copyFairnessCandidate(candidate: FairnessCandidate): FairnessCandidate {
  return {
    attemptId: candidate.attemptId,
    readySequence: candidate.readySequence,
    fairnessKey: candidate.fairnessKey,
    groupIds: [...candidate.groupIds],
  };
}

/**
 * Sort group ids with locale-insensitive identity order.
 */
function sortGroupIds(groupIds: readonly string[]): string[] {
  return [...groupIds].sort(compareIdentity);
}

/**
 * Count active attempts that include the given group id.
 */
function countActiveInGroup(
  attempts: readonly ConcurrencyGroupActiveAttempt[],
  groupId: string,
): number {
  let count = 0;
  for (const attempt of attempts) {
    if (attempt.groupIds.includes(groupId)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Build a limit lookup from a resolved registry.
 */
function limitMapFromRegistry(
  registry: ResolvedConcurrencyGroupRegistry,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const definition of registry.definitions) {
    map.set(definition.groupId, definition.maxConcurrent);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Extract one group definition from untrusted input.
 * Reads only own data properties. Rejects accessors. Does not mutate input.
 */
function extractGroupDefinition(
  value: unknown,
  location: string,
): { ok: true; value: ConcurrencyGroupDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_definition_not_plain_object",
        "Concurrency group definition must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];

  const groupIdRead = readOwnDataProperty(record, "groupId", `${location}.groupId`);
  if (!groupIdRead.ok) {
    return { ok: false, diagnostics: [groupIdRead.diagnostic] };
  }
  let groupId: string | undefined;
  if (!groupIdRead.present || !isNonEmptyString(groupIdRead.value)) {
    diagnostics.push(reject(
      "concurrency_group_invalid_group_id",
      "groupId must be a non-empty string.",
      `${location}.groupId`,
    ));
  } else {
    groupId = groupIdRead.value.trim();
  }

  const maxRead = readOwnDataProperty(record, "maxConcurrent", `${location}.maxConcurrent`);
  if (!maxRead.ok) {
    return { ok: false, diagnostics: [maxRead.diagnostic] };
  }
  let maxConcurrent: number | undefined;
  if (!maxRead.present || !isNonNegativeSafeInteger(maxRead.value)) {
    diagnostics.push(reject(
      "concurrency_group_invalid_max_concurrent",
      "maxConcurrent must be a non-negative safe integer.",
      `${location}.maxConcurrent`,
    ));
  } else {
    maxConcurrent = maxRead.value;
  }

  if (diagnostics.length > 0 || groupId === undefined || maxConcurrent === undefined) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      groupId,
      maxConcurrent,
    },
  };
}

/**
 * Resolve a group registry from untrusted input.
 *
 * Rules:
 * - undefined or omitted registry yields an empty registry (no known groups).
 * - When present, the registry must be a strict plain object with a `groups` array.
 * - Each definition must have a non-empty groupId and a non-negative safe integer
 *   maxConcurrent.
 * - Duplicate group ids in the registry are rejected.
 * - Membership that later references a group id not present in the registry is
 *   rejected as unknown. Empty membership does not require registry entries.
 *
 * Does not mutate the input. Returns clean validated definitions only.
 */
export function resolveConcurrencyGroupRegistry(
  registry?: unknown,
):
  | { ok: true; value: ResolvedConcurrencyGroupRegistry }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (registry === undefined) {
    return { ok: true, value: { definitions: [] } };
  }

  if (!isStrictPlainObject(registry)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_registry",
        "Concurrency group registry must be a plain object when present.",
        "registry",
      )],
    };
  }

  const registryObject = registry as object;
  const groupsRead = readOwnDataProperty(registryObject, "groups", "registry.groups");
  if (!groupsRead.ok) {
    return { ok: false, diagnostics: [groupsRead.diagnostic] };
  }
  if (!groupsRead.present || !Array.isArray(groupsRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_registry",
        "Concurrency group registry groups must be an array.",
        "registry.groups",
      )],
    };
  }

  const rawGroups = groupsRead.value as unknown[];
  const lengthRead = readOwnDataProperty(
    rawGroups as object,
    "length",
    "registry.groups.length",
  );
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_registry",
        "Concurrency group registry groups length must be a non-negative safe integer data property.",
        "registry.groups.length",
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const seenIds = new Set<string>();
  const definitions: ConcurrencyGroupDefinition[] = [];
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `registry.groups[${index}]`;
    const elementRead = readArrayElement(rawGroups, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present) {
      diagnostics.push(reject(
        "concurrency_group_definition_not_plain_object",
        "Concurrency group definition must be a plain object.",
        itemLocation,
      ));
      continue;
    }
    const extracted = extractGroupDefinition(elementRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    if (seenIds.has(extracted.value.groupId)) {
      diagnostics.push(reject(
        "concurrency_group_duplicate_group_id",
        `Group id '${extracted.value.groupId}' appears more than once in the registry.`,
        `${itemLocation}.groupId`,
      ));
      continue;
    }
    seenIds.add(extracted.value.groupId);
    definitions.push(extracted.value);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  definitions.sort((left, right) => compareIdentity(left.groupId, right.groupId));
  return {
    ok: true,
    value: {
      definitions: definitions.map((definition) => ({
        groupId: definition.groupId,
        maxConcurrent: definition.maxConcurrent,
      })),
    },
  };
}

/**
 * Look up maxConcurrent for a group id in a resolved registry.
 * Returns undefined when the group is unknown.
 */
export function resolveGroupMaxConcurrent(
  registry: ResolvedConcurrencyGroupRegistry,
  groupId: string,
): number | undefined {
  for (const definition of registry.definitions) {
    if (definition.groupId === groupId) {
      return definition.maxConcurrent;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Membership and active attempt parse
// ---------------------------------------------------------------------------

/**
 * Parse a group membership list from untrusted input into unique sorted ids.
 * Rejects non-arrays, empty ids, accessors on elements, and duplicate ids.
 */
function extractGroupIds(
  value: unknown,
  location: string,
): { ok: true; value: string[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_membership",
        "groupIds must be an array when present.",
        location,
      )],
    };
  }

  const raw = value as unknown[];
  const lengthRead = readOwnDataProperty(raw as object, "length", `${location}.length`);
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_membership",
        "groupIds length must be a non-negative safe integer data property.",
        `${location}.length`,
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const groupIds: string[] = [];
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `${location}[${index}]`;
    const elementRead = readArrayElement(raw, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present || !isNonEmptyString(elementRead.value)) {
      diagnostics.push(reject(
        "concurrency_group_invalid_group_id",
        "Each group id must be a non-empty string.",
        itemLocation,
      ));
      continue;
    }
    const groupId = elementRead.value.trim();
    if (seen.has(groupId)) {
      diagnostics.push(reject(
        "concurrency_group_duplicate_membership",
        `Group id '${groupId}' appears more than once in membership.`,
        itemLocation,
      ));
      continue;
    }
    seen.add(groupId);
    groupIds.push(groupId);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return { ok: true, value: sortGroupIds(groupIds) };
}

/**
 * Extract a clean active attempt from untrusted input.
 * Reads only own data properties. Rejects accessors. Does not mutate input.
 */
function extractGroupActiveAttempt(
  value: unknown,
  location = "attempt",
):
  | { ok: true; value: ConcurrencyGroupActiveAttempt }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_attempt_not_plain_object",
        "Concurrency group active attempt must be a plain object.",
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
      "concurrency_group_invalid_attempt_id",
      "attemptId must be a non-empty string.",
      `${location}.attemptId`,
    ));
  } else {
    attemptId = attemptIdRead.value.trim();
  }

  const groupIdsRead = readOwnDataProperty(record, "groupIds", `${location}.groupIds`);
  if (!groupIdsRead.ok) {
    return { ok: false, diagnostics: [groupIdsRead.diagnostic] };
  }
  const membership = extractGroupIds(
    groupIdsRead.present ? groupIdsRead.value : undefined,
    `${location}.groupIds`,
  );
  if (!membership.ok) {
    diagnostics.push(...membership.diagnostics);
  }

  if (diagnostics.length > 0 || attemptId === undefined || !membership.ok) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      attemptId,
      groupIds: membership.value,
    },
  };
}

/**
 * Validate one active attempt record.
 * Accepts untrusted input. Rejects class instances and accessors. Does not mutate input.
 */
export function validateConcurrencyGroupActiveAttempt(
  value: unknown,
  location = "attempt",
): Diagnostic[] {
  const extracted = extractGroupActiveAttempt(value, location);
  return extracted.ok ? [] : extracted.diagnostics;
}

/**
 * Parse a valid active attempt into a clean record with only group fields.
 * Trims string fields. Does not mutate input. Does not copy extra properties.
 */
export function parseConcurrencyGroupActiveAttempt(
  value: unknown,
  location = "attempt",
):
  | { ok: true; value: ConcurrencyGroupActiveAttempt }
  | { ok: false; diagnostics: Diagnostic[] } {
  return extractGroupActiveAttempt(value, location);
}

/**
 * Parse concurrency group state into a clean value with only validated fields.
 * Validates structure, every stored attempt, and unique canonical attempt ids.
 * Returns diagnostics only on failure. Does not throw. Does not mutate input.
 */
function parseConcurrencyGroupState(
  value: unknown,
  location = "concurrencyGroupState",
):
  | { ok: true; value: ConcurrencyGroupState }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_state_not_plain_object",
        "Concurrency group state must be a plain object.",
        location,
      )],
    };
  }

  const stateObject = value as object;
  const schemaRead = readOwnDataProperty(
    stateObject,
    "schemaVersion",
    `${location}.schemaVersion`,
  );
  if (!schemaRead.ok) {
    return { ok: false, diagnostics: [schemaRead.diagnostic] };
  }
  if (!schemaRead.present || schemaRead.value !== CONCURRENCY_GROUP_STATE_SCHEMA_VERSION) {
    const reportedVersion = schemaRead.present
      ? formatUntrustedDiagnosticValue(schemaRead.value)
      : "undefined";
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_state_unsupported_schema",
        `Unsupported concurrency group state schema version '${reportedVersion}'. Expected ${CONCURRENCY_GROUP_STATE_SCHEMA_VERSION}.`,
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
        "concurrency_group_state_invalid_attempts",
        "Concurrency group state attempts must be an array.",
        `${location}.attempts`,
      )],
    };
  }

  const rawAttempts = attemptsRead.value as unknown[];
  const diagnostics: Diagnostic[] = [];
  const seenAttemptIds = new Set<string>();
  const cleanAttempts: ConcurrencyGroupActiveAttempt[] = [];

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
        "concurrency_group_state_invalid_attempts",
        "Concurrency group state attempts length must be a non-negative safe integer data property.",
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
        "concurrency_group_attempt_not_plain_object",
        "Concurrency group active attempt must be a plain object.",
        itemLocation,
      ));
      continue;
    }
    const extracted = extractGroupActiveAttempt(elementRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    if (seenAttemptIds.has(extracted.value.attemptId)) {
      diagnostics.push(reject(
        "concurrency_group_state_duplicate_attempt_id",
        `Attempt id '${extracted.value.attemptId}' appears more than once in the concurrency group state.`,
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
      schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
      attempts: cleanAttempts,
    },
  };
}

/**
 * Validate concurrency group state structure, every stored attempt, and unique
 * canonical attempt ids.
 * Used on every state-touching path and when a future restore path supplies state.
 * Returns diagnostics only. Does not throw. Does not mutate input.
 */
export function validateConcurrencyGroupStateSchema(
  value: unknown,
  location = "concurrencyGroupState",
): Diagnostic[] {
  const parsed = parseConcurrencyGroupState(value, location);
  return parsed.ok ? [] : parsed.diagnostics;
}

// ---------------------------------------------------------------------------
// Fairness candidate parse
// ---------------------------------------------------------------------------

/**
 * Extract a clean fairness candidate from untrusted input.
 */
function extractFairnessCandidate(
  value: unknown,
  location: string,
): { ok: true; value: FairnessCandidate } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "fairness_candidate_not_plain_object",
        "Fairness candidate must be a plain object.",
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
      "fairness_invalid_attempt_id",
      "attemptId must be a non-empty string.",
      `${location}.attemptId`,
    ));
  } else {
    attemptId = attemptIdRead.value.trim();
  }

  const readyRead = readOwnDataProperty(record, "readySequence", `${location}.readySequence`);
  if (!readyRead.ok) {
    return { ok: false, diagnostics: [readyRead.diagnostic] };
  }
  let readySequence: number | undefined;
  if (!readyRead.present || !isNonNegativeSafeInteger(readyRead.value)) {
    diagnostics.push(reject(
      "fairness_invalid_ready_sequence",
      "readySequence must be a non-negative safe integer.",
      `${location}.readySequence`,
    ));
  } else {
    readySequence = readyRead.value;
  }

  const keyRead = readOwnDataProperty(record, "fairnessKey", `${location}.fairnessKey`);
  if (!keyRead.ok) {
    return { ok: false, diagnostics: [keyRead.diagnostic] };
  }
  let fairnessKey: string | undefined;
  if (!keyRead.present || !isNonEmptyString(keyRead.value)) {
    diagnostics.push(reject(
      "fairness_invalid_fairness_key",
      "fairnessKey must be a non-empty string.",
      `${location}.fairnessKey`,
    ));
  } else {
    fairnessKey = keyRead.value.trim();
  }

  const groupIdsRead = readOwnDataProperty(record, "groupIds", `${location}.groupIds`);
  if (!groupIdsRead.ok) {
    return { ok: false, diagnostics: [groupIdsRead.diagnostic] };
  }
  const membership = extractGroupIds(
    groupIdsRead.present ? groupIdsRead.value : undefined,
    `${location}.groupIds`,
  );
  if (!membership.ok) {
    diagnostics.push(...membership.diagnostics);
  }

  if (
    diagnostics.length > 0
    || attemptId === undefined
    || readySequence === undefined
    || fairnessKey === undefined
    || !membership.ok
  ) {
    return { ok: false, diagnostics };
  }

  return {
    ok: true,
    value: {
      attemptId,
      readySequence,
      fairnessKey,
      groupIds: membership.value,
    },
  };
}

/**
 * Parse one fairness candidate into a clean record.
 */
export function parseFairnessCandidate(
  value: unknown,
  location = "candidate",
): { ok: true; value: FairnessCandidate } | { ok: false; diagnostics: Diagnostic[] } {
  return extractFairnessCandidate(value, location);
}

/**
 * Parse a list of fairness candidates. Rejects duplicate attempt ids.
 */
function parseFairnessCandidates(
  candidates: unknown,
  location = "candidates",
): { ok: true; value: FairnessCandidate[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      diagnostics: [reject(
        "fairness_invalid_candidates",
        "Fairness candidates must be an array.",
        location,
      )],
    };
  }

  const raw = candidates as unknown[];
  const lengthRead = readOwnDataProperty(raw as object, "length", `${location}.length`);
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "fairness_invalid_candidates",
        "Fairness candidates length must be a non-negative safe integer data property.",
        `${location}.length`,
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const clean: FairnessCandidate[] = [];
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `${location}[${index}]`;
    const elementRead = readArrayElement(raw, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present) {
      diagnostics.push(reject(
        "fairness_candidate_not_plain_object",
        "Fairness candidate must be a plain object.",
        itemLocation,
      ));
      continue;
    }
    const extracted = extractFairnessCandidate(elementRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    if (seen.has(extracted.value.attemptId)) {
      diagnostics.push(reject(
        "fairness_duplicate_attempt_id",
        `Attempt id '${extracted.value.attemptId}' appears more than once in the candidate list.`,
        `${itemLocation}.attemptId`,
      ));
      continue;
    }
    seen.add(extracted.value.attemptId);
    clean.push(extracted.value);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: clean };
}

// ---------------------------------------------------------------------------
// Active set operations
// ---------------------------------------------------------------------------

/**
 * Create an empty concurrency group occupancy state.
 * schemaVersion is fixed for this contract version.
 */
export function createEmptyConcurrencyGroupState(): ConcurrencyGroupState {
  return {
    schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
    attempts: [],
  };
}

/**
 * List active attempts as clean field copies so callers cannot mutate the state.
 * Rejects invalid concurrency group state with diagnostics.
 * Order is locale-insensitive identity order on attemptId.
 */
export function listConcurrencyGroupActiveAttempts(
  state: ConcurrencyGroupState,
): ConcurrencyGroupListResult {
  const parsed = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return {
    ok: true,
    attempts: parsed.value.attempts
      .map(copyActiveAttempt)
      .sort((left, right) => compareIdentity(left.attemptId, right.attemptId)),
  };
}

/**
 * Return a clean copy of one active attempt, or undefined when absent.
 * Trims the lookup id to match stored identity. Rejects invalid state.
 */
export function getConcurrencyGroupActiveAttempt(
  state: ConcurrencyGroupState,
  attemptId: string,
): ConcurrencyGroupGetResult {
  const parsed = parseConcurrencyGroupState(state, "concurrencyGroupState");
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
 * Return the active attempt count for one group id.
 * Rejects invalid state. Rejects an empty group id with a diagnostic.
 */
export function getGroupActiveCount(
  state: ConcurrencyGroupState,
  groupId: string,
): ConcurrencyGroupCountResult {
  const parsed = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  if (typeof groupId !== "string" || groupId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_invalid_group_id",
        "groupId must be a non-empty string.",
        "groupId",
      )],
    };
  }
  const id = groupId.trim();
  return { ok: true, count: countActiveInGroup(parsed.value.attempts, id) };
}

/**
 * Validate that every group id is present in the registry.
 * Unknown groups are input errors, not temporary capacity blocks.
 * Does not check occupancy capacity.
 */
function validateMembershipAgainstRegistry(
  groupIds: readonly string[],
  registry: ResolvedConcurrencyGroupRegistry,
  location = "attempt.groupIds",
): ConcurrencyGroupCanAdmitResult {
  const limits = limitMapFromRegistry(registry);
  for (const groupId of groupIds) {
    if (!limits.has(groupId)) {
      return {
        ok: false,
        diagnostics: [reject(
          "concurrency_group_unknown_group",
          `Group id '${groupId}' is not present in the concurrency group registry.`,
          location,
        )],
      };
    }
  }
  return { ok: true };
}

/**
 * Check membership against a resolved registry and current occupancy.
 * Unknown groups yield concurrency_group_unknown_group.
 * Full capacity yields concurrency_group_limit.
 * Does not check attempt identity uniqueness.
 * Does not mutate inputs.
 */
function evaluateGroupCompatibilityFromSnapshots(
  cleanState: ConcurrencyGroupState,
  groupIds: readonly string[],
  registry: ResolvedConcurrencyGroupRegistry,
): ConcurrencyGroupCanAdmitResult {
  const membership = validateMembershipAgainstRegistry(groupIds, registry);
  if (!membership.ok) {
    return membership;
  }

  const limits = limitMapFromRegistry(registry);
  for (const groupId of groupIds) {
    const maxConcurrent = limits.get(groupId)!;
    const activeCount = countActiveInGroup(cleanState.attempts, groupId);
    if (activeCount >= maxConcurrent) {
      return {
        ok: false,
        diagnostics: [reject(
          "concurrency_group_limit",
          `The concurrent attempt count for group '${groupId}' must not exceed ${maxConcurrent}.`,
          "attempt.groupIds",
        )],
      };
    }
  }

  return { ok: true };
}

/**
 * Check capacity only for membership that is already known to the registry.
 * Callers must run validateMembershipAgainstRegistry first when unknown
 * groups must surface as diagnostics rather than silent exclusion.
 */
function evaluateKnownGroupCapacityFromSnapshots(
  cleanState: ConcurrencyGroupState,
  groupIds: readonly string[],
  registry: ResolvedConcurrencyGroupRegistry,
): boolean {
  const limits = limitMapFromRegistry(registry);
  for (const groupId of groupIds) {
    const maxConcurrent = limits.get(groupId);
    if (maxConcurrent === undefined) {
      return false;
    }
    if (countActiveInGroup(cleanState.attempts, groupId) >= maxConcurrent) {
      return false;
    }
  }
  return true;
}

/**
 * Advance a fairness ordinal by one after a successful selection.
 * When the current value is Number.MAX_SAFE_INTEGER, wrap to 0 so the
 * returned ordinal remains a non-negative safe integer.
 */
function advanceFairnessOrdinal(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return current + 1;
}

/**
 * Admission checks on already-parsed clean snapshots only.
 * Does not read untrusted input. Does not mutate inputs.
 */
function evaluateGroupAdmissionFromSnapshots(
  cleanState: ConcurrencyGroupState,
  cleanAttempt: ConcurrencyGroupActiveAttempt,
  registry: ResolvedConcurrencyGroupRegistry,
): ConcurrencyGroupCanAdmitResult {
  if (cleanState.attempts.some((entry) => entry.attemptId === cleanAttempt.attemptId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "concurrency_group_duplicate_attempt",
        `Attempt id '${cleanAttempt.attemptId}' is already active in the concurrency group state.`,
        "attempt.attemptId",
      )],
    };
  }
  return evaluateGroupCompatibilityFromSnapshots(
    cleanState,
    cleanAttempt.groupIds,
    registry,
  );
}

/**
 * Parse untrusted state, candidate, and registry once into clean snapshots.
 */
function parseGroupAdmissionInputs(
  state: unknown,
  candidate: unknown,
  registry?: unknown,
):
  | {
    ok: true;
    cleanState: ConcurrencyGroupState;
    cleanAttempt: ConcurrencyGroupActiveAttempt;
    resolvedRegistry: ResolvedConcurrencyGroupRegistry;
  }
  | { ok: false; diagnostics: Diagnostic[] } {
  const resolvedRegistry = resolveConcurrencyGroupRegistry(registry);
  if (!resolvedRegistry.ok) {
    return { ok: false, diagnostics: resolvedRegistry.diagnostics };
  }

  const parsedState = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  const parsedAttempt = parseConcurrencyGroupActiveAttempt(candidate, "attempt");
  if (!parsedAttempt.ok) {
    return { ok: false, diagnostics: parsedAttempt.diagnostics };
  }

  return {
    ok: true,
    cleanState: parsedState.value,
    cleanAttempt: parsedAttempt.value,
    resolvedRegistry: resolvedRegistry.value,
  };
}

/**
 * Check whether a candidate attempt may join under group compatibility.
 * Validates state, candidate, uniqueness, registry membership, and capacity.
 * Parses each untrusted input once. Does not mutate inputs.
 * Returns structured diagnostics on rejection.
 */
export function canAdmitGroupAttempt(
  state: ConcurrencyGroupState,
  candidate: unknown,
  registry?: unknown,
): ConcurrencyGroupCanAdmitResult {
  const parsed = parseGroupAdmissionInputs(state, candidate, registry);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  return evaluateGroupAdmissionFromSnapshots(
    parsed.cleanState,
    parsed.cleanAttempt,
    parsed.resolvedRegistry,
  );
}

/**
 * Validate, check group capacity, and add an attempt to a new occupancy state.
 * Parses each untrusted input once. Returns a clean state with only validated
 * fields. Does not mutate the input state or candidate.
 */
export function admitGroupAttempt(
  state: ConcurrencyGroupState,
  candidate: unknown,
  registry?: unknown,
): ConcurrencyGroupAdmitResult {
  const parsed = parseGroupAdmissionInputs(state, candidate, registry);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }

  const check = evaluateGroupAdmissionFromSnapshots(
    parsed.cleanState,
    parsed.cleanAttempt,
    parsed.resolvedRegistry,
  );
  if (!check.ok) {
    return { ok: false, diagnostics: check.diagnostics };
  }

  const next = copyGroupState(parsed.cleanState);
  next.attempts.push(copyActiveAttempt(parsed.cleanAttempt));
  next.attempts.sort((left, right) => compareIdentity(left.attemptId, right.attemptId));
  return { ok: true, state: next };
}

/**
 * Release an attempt by id when it completes or fails. Returns a new clean state.
 * When the id is absent, released is false and the state is still copied.
 * Trims the release id to match stored identity.
 * Rejects invalid concurrency group state without rewriting it.
 * Does not mutate the input state.
 */
export function releaseGroupAttempt(
  state: ConcurrencyGroupState,
  attemptId: string,
): ConcurrencyGroupReleaseResult {
  const parsedState = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  if (typeof attemptId !== "string" || attemptId.trim().length === 0) {
    return {
      ok: true,
      state: copyGroupState(parsedState.value),
      released: false,
    };
  }

  const id = attemptId.trim();
  const remaining = parsedState.value.attempts.filter(
    (attempt) => attempt.attemptId !== id,
  );
  const released = remaining.length !== parsedState.value.attempts.length;
  return {
    ok: true,
    state: {
      schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
      attempts: remaining.map(copyActiveAttempt),
    },
    released,
  };
}

/**
 * Propose an active attempt record from identity fields without admission.
 * Accepts untrusted input and passes it only through parseConcurrencyGroupActiveAttempt.
 */
export function proposeConcurrencyGroupActiveAttempt(
  input: unknown,
):
  | { ok: true; value: ConcurrencyGroupActiveAttempt }
  | { ok: false; diagnostics: Diagnostic[] } {
  return parseConcurrencyGroupActiveAttempt(input, "attempt");
}

// ---------------------------------------------------------------------------
// Fairness selection
// ---------------------------------------------------------------------------

/**
 * Compare two fairness candidates for final identity order.
 * Order: attemptId, then fairnessKey, then joined group ids.
 */
function compareFairnessIdentity(
  left: FairnessCandidate,
  right: FairnessCandidate,
): number {
  const byAttempt = compareIdentity(left.attemptId, right.attemptId);
  if (byAttempt !== 0) return byAttempt;
  const byKey = compareIdentity(left.fairnessKey, right.fairnessKey);
  if (byKey !== 0) return byKey;
  return compareIdentity(left.groupIds.join("\0"), right.groupIds.join("\0"));
}

/**
 * Select among clean admissible candidates with the fairness policy:
 * 1. Prefer older ready work (smaller readySequence).
 * 2. When ages tie, round-robin over distinct fairness keys via the ordinal.
 * 3. Final tie-break: locale-insensitive identity order on attemptId,
 *    fairnessKey, and group ids.
 *
 * Validates fairnessOrdinal before the empty-list idle path so an invalid
 * ordinal is never accepted when no candidate is admissible.
 * Does not mutate candidates. Does not use a clock or random values.
 */
function selectAmongAdmissible(
  admissible: readonly FairnessCandidate[],
  fairnessOrdinal: number,
): FairSelectionResult {
  if (!isNonNegativeSafeInteger(fairnessOrdinal)) {
    return {
      ok: false,
      diagnostics: [reject(
        "fairness_invalid_ordinal",
        "fairnessOrdinal must be a non-negative safe integer.",
        "fairnessOrdinal",
      )],
    };
  }

  if (admissible.length === 0) {
    return {
      ok: true,
      kind: "idle",
      reason: "No admissible candidates remain under concurrency group capacity.",
    };
  }

  let minReady = admissible[0]!.readySequence;
  for (const candidate of admissible) {
    if (candidate.readySequence < minReady) {
      minReady = candidate.readySequence;
    }
  }

  const oldest = admissible.filter((candidate) => candidate.readySequence === minReady);

  const keySet = new Set<string>();
  for (const candidate of oldest) {
    keySet.add(candidate.fairnessKey);
  }
  const keys = [...keySet].sort(compareIdentity);
  const selectedKey = keys[fairnessOrdinal % keys.length]!;

  const keyed = oldest.filter((candidate) => candidate.fairnessKey === selectedKey);
  keyed.sort(compareFairnessIdentity);
  const selected = keyed[0]!;

  return {
    ok: true,
    kind: "select",
    candidate: copyFairnessCandidate(selected),
    reason: `Selected attempt '${selected.attemptId}' by readySequence ${selected.readySequence}, fairness key '${selected.fairnessKey}', and ordinal ${fairnessOrdinal}.`,
  };
}

/**
 * Filter candidates that pass group capacity against current occupancy.
 * Candidates that are already active are not admissible.
 * Candidates blocked only by full known groups are excluded without error.
 * Unknown group membership is an input error and returns diagnostics.
 * Does not mutate inputs. Returns clean candidate copies.
 */
export function filterAdmissibleCandidates(
  state: ConcurrencyGroupState,
  registry: unknown,
  candidates: unknown,
): FilterAdmissibleResult {
  const parsedState = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  const resolvedRegistry = resolveConcurrencyGroupRegistry(registry);
  if (!resolvedRegistry.ok) {
    return { ok: false, diagnostics: resolvedRegistry.diagnostics };
  }

  const parsedCandidates = parseFairnessCandidates(candidates, "candidates");
  if (!parsedCandidates.ok) {
    return { ok: false, diagnostics: parsedCandidates.diagnostics };
  }

  // Unknown groups are invalid input. Surface them before capacity filtering.
  for (let index = 0; index < parsedCandidates.value.length; index += 1) {
    const candidate = parsedCandidates.value[index]!;
    const membership = validateMembershipAgainstRegistry(
      candidate.groupIds,
      resolvedRegistry.value,
      `candidates[${index}].groupIds`,
    );
    if (!membership.ok) {
      return { ok: false, diagnostics: membership.diagnostics };
    }
  }

  const activeIds = new Set(
    parsedState.value.attempts.map((attempt) => attempt.attemptId),
  );
  const admissible: FairnessCandidate[] = [];

  for (const candidate of parsedCandidates.value) {
    if (activeIds.has(candidate.attemptId)) {
      continue;
    }
    if (
      evaluateKnownGroupCapacityFromSnapshots(
        parsedState.value,
        candidate.groupIds,
        resolvedRegistry.value,
      )
    ) {
      admissible.push(copyFairnessCandidate(candidate));
    }
  }

  return { ok: true, candidates: admissible };
}

/**
 * Select one fair candidate among those that pass group compatibility.
 *
 * Policy among currently admissible candidates:
 * 1. Prefer smaller readySequence (older ready work).
 * 2. When readySequence ties, round-robin over distinct fairness keys with
 *    fairnessOrdinal (same role as GoalRuntime.continuationOrdinal).
 * 3. Final tie-break: locale-insensitive lexicographic order on attemptId,
 *    fairnessKey, and group ids.
 *
 * Same inputs always produce the same choice. No clock, random, or filesystem.
 * Does not mutate inputs. Does not admit into occupancy state.
 */
export function selectFairCandidate(
  state: ConcurrencyGroupState,
  registry: unknown,
  candidates: unknown,
  fairnessOrdinal: number,
): FairSelectionResult {
  const filtered = filterAdmissibleCandidates(state, registry, candidates);
  if (!filtered.ok) {
    return { ok: false, diagnostics: filtered.diagnostics };
  }
  return selectAmongAdmissible(filtered.candidates, fairnessOrdinal);
}

/**
 * Select up to maxCount fair candidates with virtual admit between picks.
 * After each selection, the candidate is virtually admitted so later picks
 * re-check group capacity. fairnessOrdinal advances by one per selection.
 * When the ordinal is Number.MAX_SAFE_INTEGER, the next value wraps to 0 so
 * the returned ordinal remains a non-negative safe integer.
 * When maxCount is omitted, selection continues until idle.
 * Unknown group membership returns diagnostics (same rule as filter).
 * Does not mutate inputs. Returns clean selected copies and the virtual state.
 */
export function selectFairBatch(
  state: ConcurrencyGroupState,
  registry: unknown,
  candidates: unknown,
  fairnessOrdinal: number,
  maxCount?: number,
): FairBatchResult {
  if (!isNonNegativeSafeInteger(fairnessOrdinal)) {
    return {
      ok: false,
      diagnostics: [reject(
        "fairness_invalid_ordinal",
        "fairnessOrdinal must be a non-negative safe integer.",
        "fairnessOrdinal",
      )],
    };
  }

  let limit = Number.MAX_SAFE_INTEGER;
  if (maxCount !== undefined) {
    if (!isNonNegativeSafeInteger(maxCount)) {
      return {
        ok: false,
        diagnostics: [reject(
          "fairness_invalid_batch_limit",
          "maxCount must be a non-negative safe integer when present.",
          "maxCount",
        )],
      };
    }
    limit = maxCount;
  }

  const parsedState = parseConcurrencyGroupState(state, "concurrencyGroupState");
  if (!parsedState.ok) {
    return { ok: false, diagnostics: parsedState.diagnostics };
  }

  const resolvedRegistry = resolveConcurrencyGroupRegistry(registry);
  if (!resolvedRegistry.ok) {
    return { ok: false, diagnostics: resolvedRegistry.diagnostics };
  }

  const parsedCandidates = parseFairnessCandidates(candidates, "candidates");
  if (!parsedCandidates.ok) {
    return { ok: false, diagnostics: parsedCandidates.diagnostics };
  }

  // Unknown groups are invalid input. Surface them before capacity filtering.
  for (let index = 0; index < parsedCandidates.value.length; index += 1) {
    const candidate = parsedCandidates.value[index]!;
    const membership = validateMembershipAgainstRegistry(
      candidate.groupIds,
      resolvedRegistry.value,
      `candidates[${index}].groupIds`,
    );
    if (!membership.ok) {
      return { ok: false, diagnostics: membership.diagnostics };
    }
  }

  let virtualState = copyGroupState(parsedState.value);
  let ordinal = fairnessOrdinal;
  const selected: FairnessCandidate[] = [];
  const remaining = parsedCandidates.value.map(copyFairnessCandidate);

  while (selected.length < limit) {
    const activeIds = new Set(virtualState.attempts.map((attempt) => attempt.attemptId));
    const admissible: FairnessCandidate[] = [];
    for (const candidate of remaining) {
      if (activeIds.has(candidate.attemptId)) {
        continue;
      }
      if (selected.some((item) => item.attemptId === candidate.attemptId)) {
        continue;
      }
      if (
        evaluateKnownGroupCapacityFromSnapshots(
          virtualState,
          candidate.groupIds,
          resolvedRegistry.value,
        )
      ) {
        admissible.push(candidate);
      }
    }

    const decision = selectAmongAdmissible(admissible, ordinal);
    if (!decision.ok) {
      return { ok: false, diagnostics: decision.diagnostics };
    }
    if (decision.kind === "idle") {
      break;
    }

    const admit = evaluateGroupAdmissionFromSnapshots(
      virtualState,
      {
        attemptId: decision.candidate.attemptId,
        groupIds: decision.candidate.groupIds,
      },
      resolvedRegistry.value,
    );
    if (!admit.ok) {
      // Candidate became inadmissible after virtual admits; stop without error.
      break;
    }

    virtualState = {
      schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
      attempts: [
        ...virtualState.attempts.map(copyActiveAttempt),
        {
          attemptId: decision.candidate.attemptId,
          groupIds: [...decision.candidate.groupIds],
        },
      ].sort((left, right) => compareIdentity(left.attemptId, right.attemptId)),
    };
    selected.push(copyFairnessCandidate(decision.candidate));
    ordinal = advanceFairnessOrdinal(ordinal);
  }

  return {
    ok: true,
    selected,
    state: virtualState,
    fairnessOrdinal: ordinal,
  };
}

/**
 * Select one fair candidate and admit it into group occupancy when selected.
 * Pure composition helper for later scheduler use. Does not wire product paths.
 * Does not mutate inputs.
 */
export function selectAndAdmitFairCandidate(
  state: ConcurrencyGroupState,
  registry: unknown,
  candidates: unknown,
  fairnessOrdinal: number,
): SelectAndAdmitResult {
  const selection = selectFairCandidate(state, registry, candidates, fairnessOrdinal);
  if (!selection.ok) {
    return { ok: false, diagnostics: selection.diagnostics };
  }
  if (selection.kind === "idle") {
    return {
      ok: true,
      kind: "idle",
      reason: selection.reason,
    };
  }

  const admitted = admitGroupAttempt(
    state,
    {
      attemptId: selection.candidate.attemptId,
      groupIds: selection.candidate.groupIds,
    },
    registry,
  );
  if (!admitted.ok) {
    return { ok: false, diagnostics: admitted.diagnostics };
  }

  return {
    ok: true,
    kind: "select",
    candidate: copyFairnessCandidate(selection.candidate),
    state: admitted.state,
    reason: selection.reason,
  };
}
