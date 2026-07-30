/**
 * Pure derived fan-out region contracts (M8.1-s1).
 *
 * A derived fan-out region expands one string-list collection fact into one
 * branch per item. Expansion is a pure function of the region definition and
 * the collection values. Replay of the same inputs must produce the same
 * ordered branch set.
 *
 * Branch identity rule for string-list items:
 * - branchId = `{regionId}/item/{index}` where index is the zero-based position
 *   in the collection array.
 * - Branch order matches collection order.
 * - The item string is stored on the branch record as itemValue.
 * - Index is part of identity, so two equal strings at different positions
 *   produce two distinct branch ids.
 *
 * Empty collection rule:
 * - A collection of length zero expands to zero branches.
 * - Fan-in over zero branches is immediately evaluable and yields succeeded
 *   under every fan-in policy (vacuous success: no live branch failed).
 *
 * Invalid branchId argument contract:
 * - Lifecycle helpers and getDerivedBranch reject a non-string or empty
 *   branchId with derived_fan_out_invalid_branch_id_argument.
 * - A well-formed id that is absent from the expansion yields
 *   derived_fan_out_branch_not_found for mutators, and
 *   { ok: true, branch: undefined } for getDerivedBranch.
 *
 * Attempt id uniqueness:
 * - Every attempt id used in an expansion is recorded in usedAttemptIds.
 * - An attempt id must not be reused on any branch in the same expansion.
 * - usedAttemptIds length must equal the sum of branch attemptNumber values.
 * - Completing a running branch requires the current attempt id.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * The expansion record is an in-memory value. Persistence and schema restore
 * belong to later slices; the expansion type carries schemaVersion for that work.
 *
 * This module is graph/domain machinery. It does not run Promise.all inside
 * code nodes and does not dispatch executors.
 */

import type { Diagnostic, EvidenceReference } from "./model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a derived fan-out expansion record. Always 1 in this slice. */
export const DERIVED_FAN_OUT_SCHEMA_VERSION = 1 as const;

/**
 * Fan-in policy after every branch is terminal.
 * - fail-all: any failed branch makes fan-in failed.
 * - continue-with-successes: fan-in succeeds when at least one branch succeeded.
 *   Failed branches are recorded and do not alone force failure when a success exists.
 * - require-all-success: every branch must be succeeded.
 */
export const DERIVED_FAN_IN_POLICIES = [
  "fail-all",
  "continue-with-successes",
  "require-all-success",
] as const;

export type DerivedFanInPolicy = (typeof DERIVED_FAN_IN_POLICIES)[number];

/**
 * Branch status values.
 * Terminal statuses are succeeded, failed, and cancelled.
 * Non-terminal statuses are pending and running.
 */
export const DERIVED_BRANCH_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type DerivedBranchStatus = (typeof DERIVED_BRANCH_STATUSES)[number];

const TERMINAL_BRANCH_STATUSES = new Set<DerivedBranchStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

const DERIVED_FAN_IN_POLICY_SET = new Set<string>(DERIVED_FAN_IN_POLICIES);
const DERIVED_BRANCH_STATUS_SET = new Set<string>(DERIVED_BRANCH_STATUSES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Authoring definition for a derived fan-out region.
 * The collection fact must be a string-list fact at expansion time.
 */
export interface DerivedFanOutRegionDefinition {
  id: string;
  /** Name of the string-list fact that supplies the collection. */
  collectionFact: string;
  /**
   * Maximum branch count.
   * Expansion rejects a collection longer than this bound.
   * Must be a positive safe integer.
   */
  maxBranches: number;
  /** Policy applied when fan-in evaluates terminal branch states. */
  fanInPolicy: DerivedFanInPolicy;
}

/**
 * One expanded branch with independent attempt, evidence, and status.
 * Branch records are first-class graph identities for this region.
 */
export interface DerivedBranchRuntime {
  branchId: string;
  regionId: string;
  /** Zero-based index in the collection fact array. */
  index: number;
  /** Collection item string that produced this branch. */
  itemValue: string;
  status: DerivedBranchStatus;
  /**
   * Current attempt identity for this branch.
   * Absent until the first attempt starts.
   */
  attemptId?: string;
  /**
   * Attempt number for this branch.
   * Zero means no attempt has started. First attempt is one.
   */
  attemptNumber: number;
  evidence: EvidenceReference[];
  failureReason?: string;
}

/**
 * Result of fan-in evaluation over terminal branch states.
 */
export interface DerivedFanInResult {
  status: "succeeded" | "failed" | "pending";
  policy: DerivedFanInPolicy;
  /** Branch ids that ended in succeeded. */
  succeededBranchIds: string[];
  /** Branch ids that ended in failed. */
  failedBranchIds: string[];
  /** Branch ids that ended in cancelled. */
  cancelledBranchIds: string[];
  /** Branch ids that are not yet terminal when status is pending. */
  pendingBranchIds: string[];
  reason: string;
}

/**
 * Expanded derived fan-out region state after pure expansion.
 * schemaVersion is reserved for later persistence restore.
 */
export interface DerivedFanOutExpansion {
  schemaVersion: typeof DERIVED_FAN_OUT_SCHEMA_VERSION;
  regionId: string;
  collectionFact: string;
  /** Collection values used for expansion (replay inputs). */
  collectionValues: string[];
  fanInPolicy: DerivedFanInPolicy;
  maxBranches: number;
  /** Ordered branch set. Order matches collection index order. */
  branches: DerivedBranchRuntime[];
  /**
   * Every attempt id ever assigned in this expansion, in first-use order.
   * An attempt id must not appear twice. Restore and start both enforce this.
   */
  usedAttemptIds: string[];
}

export type DerivedFanOutExpandResult =
  | { ok: true; expansion: DerivedFanOutExpansion }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanOutParseDefinitionResult =
  | { ok: true; value: DerivedFanOutRegionDefinition }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanOutParseExpansionResult =
  | { ok: true; value: DerivedFanOutExpansion }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanOutBranchUpdateResult =
  | { ok: true; expansion: DerivedFanOutExpansion }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanOutListResult =
  | { ok: true; branches: DerivedBranchRuntime[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanInEvaluateResult =
  | { ok: true; result: DerivedFanInResult }
  | { ok: false; diagnostics: Diagnostic[] };

export type DerivedFanOutGetBranchResult =
  | { ok: true; branch: DerivedBranchRuntime | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

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

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

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
 * Accessor properties and failed reflective access yield a diagnostic.
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
        "derived_fan_out_invalid_accessor",
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
        "derived_fan_out_invalid_accessor",
        `Property '${key}' must be a data property. Accessor properties are not allowed.`,
        location,
      ),
    };
  }
  return { ok: true, present: true, value: descriptor.value };
}

/** Known top-level expansion fields read for restore and schema guards. */
const EXPANSION_SNAPSHOT_KEYS = [
  "schemaVersion",
  "regionId",
  "collectionFact",
  "collectionValues",
  "fanInPolicy",
  "maxBranches",
  "branches",
  "usedAttemptIds",
] as const;

/** Known branch fields read for restore and schema guards. */
const BRANCH_SNAPSHOT_KEYS = [
  "branchId",
  "regionId",
  "index",
  "itemValue",
  "status",
  "attemptId",
  "attemptNumber",
  "evidence",
  "failureReason",
] as const;

/** Known evidence entry fields. */
const EVIDENCE_SNAPSHOT_KEYS = [
  "ref",
  "kind",
  "summary",
  "visibility",
] as const;

/** Known region definition fields. */
const DEFINITION_SNAPSHOT_KEYS = [
  "id",
  "collectionFact",
  "maxBranches",
  "fanInPolicy",
] as const;

/** Known complete/append options fields. */
const COMPLETE_OPTIONS_SNAPSHOT_KEYS = [
  "attemptId",
  "failureReason",
  "evidence",
] as const;

/**
 * Read known own data properties into a plain record.
 * Rejects accessor properties. Absent keys are omitted.
 */
function readKnownOwnDataFields(
  object: object,
  keys: readonly string[],
  location: string,
): { ok: true; record: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] } {
  const record: Record<string, unknown> = {};
  const diagnostics: Diagnostic[] = [];
  for (const key of keys) {
    const read = readOwnDataProperty(object, key, `${location}.${key}`);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      continue;
    }
    if (read.present) {
      record[key] = read.value;
    }
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, record };
}

/**
 * Read an array element as an own data property without invoking index getters.
 */
function readArrayElement(
  array: unknown[],
  index: number,
  location: string,
): OwnDataPropertyRead {
  return readOwnDataProperty(array as object, String(index), location);
}

/**
 * Read array length as an own data property without invoking a length getter.
 */
function readArrayLength(
  array: unknown[],
  location: string,
): { ok: true; length: number } | { ok: false; diagnostic: Diagnostic } {
  const lengthRead = readOwnDataProperty(array as object, "length", `${location}.length`);
  if (!lengthRead.ok) {
    return { ok: false, diagnostic: lengthRead.diagnostic };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostic: reject(
        "derived_fan_out_invalid_accessor",
        "Array length must be a non-negative safe integer data property.",
        `${location}.length`,
      ),
    };
  }
  return { ok: true, length: lengthRead.value };
}

/**
 * Snapshot array elements via own data-property index reads into a plain array.
 * Requires an array. Rejects index accessors. Does not invoke element getters.
 */
function snapshotArrayElements(
  array: unknown[],
  location: string,
): { ok: true; elements: unknown[] } | { ok: false; diagnostics: Diagnostic[] } {
  const lengthResult = readArrayLength(array, location);
  if (!lengthResult.ok) {
    return { ok: false, diagnostics: [lengthResult.diagnostic] };
  }
  const elements: unknown[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < lengthResult.length; index += 1) {
    const itemLocation = `${location}[${index}]`;
    const elementRead = readArrayElement(array, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    // Absent sparse slots become undefined data values in the plain snapshot.
    elements.push(elementRead.present ? elementRead.value : undefined);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, elements };
}

/**
 * Snapshot one evidence entry into a plain record of own data properties.
 */
function snapshotEvidenceEntry(
  value: unknown,
  location: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return { ok: true, value };
  }
  const fields = readKnownOwnDataFields(value, EVIDENCE_SNAPSHOT_KEYS, location);
  if (!fields.ok) {
    return { ok: false, diagnostics: fields.diagnostics };
  }
  return { ok: true, value: fields.record };
}

/**
 * Snapshot an evidence array element-by-element with nested field protection.
 */
function snapshotEvidenceArray(
  value: unknown,
  location: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] } {
  if (!Array.isArray(value)) {
    return { ok: true, value };
  }
  const elements = snapshotArrayElements(value, location);
  if (!elements.ok) {
    return { ok: false, diagnostics: elements.diagnostics };
  }
  const items: unknown[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < elements.elements.length; index += 1) {
    const entry = snapshotEvidenceEntry(
      elements.elements[index],
      `${location}[${index}]`,
    );
    if (!entry.ok) {
      diagnostics.push(...entry.diagnostics);
      continue;
    }
    items.push(entry.value);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: items };
}

/**
 * Snapshot one branch record, including nested evidence entries.
 */
function snapshotBranchRecord(
  value: unknown,
  location: string,
): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return { ok: true, value };
  }
  const fields = readKnownOwnDataFields(value, BRANCH_SNAPSHOT_KEYS, location);
  if (!fields.ok) {
    return { ok: false, diagnostics: fields.diagnostics };
  }
  const record = { ...fields.record };
  if ("evidence" in record) {
    const evidence = snapshotEvidenceArray(record.evidence, `${location}.evidence`);
    if (!evidence.ok) {
      return { ok: false, diagnostics: evidence.diagnostics };
    }
    record.evidence = evidence.value;
  }
  return { ok: true, value: record };
}

/**
 * Snapshot an untrusted expansion into a plain object of own data properties.
 * Rejects accessors on the expansion, array indices, branch fields, and
 * nested evidence fields. Does not invoke getters. Does not mutate input.
 */
function snapshotDerivedFanOutExpansion(
  value: unknown,
  location: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_expansion_not_plain_object",
        "Derived fan-out expansion must be a plain object.",
        location,
      )],
    };
  }

  const top = readKnownOwnDataFields(value, EXPANSION_SNAPSHOT_KEYS, location);
  if (!top.ok) {
    return { ok: false, diagnostics: top.diagnostics };
  }

  const snapshot: Record<string, unknown> = { ...top.record };

  if (Array.isArray(snapshot.collectionValues)) {
    const values = snapshotArrayElements(
      snapshot.collectionValues,
      `${location}.collectionValues`,
    );
    if (!values.ok) {
      return { ok: false, diagnostics: values.diagnostics };
    }
    snapshot.collectionValues = values.elements;
  }

  if (Array.isArray(snapshot.usedAttemptIds)) {
    const ids = snapshotArrayElements(
      snapshot.usedAttemptIds,
      `${location}.usedAttemptIds`,
    );
    if (!ids.ok) {
      return { ok: false, diagnostics: ids.diagnostics };
    }
    snapshot.usedAttemptIds = ids.elements;
  }

  if (Array.isArray(snapshot.branches)) {
    const branchElements = snapshotArrayElements(
      snapshot.branches,
      `${location}.branches`,
    );
    if (!branchElements.ok) {
      return { ok: false, diagnostics: branchElements.diagnostics };
    }
    const branchSnapshots: unknown[] = [];
    const diagnostics: Diagnostic[] = [];
    for (let index = 0; index < branchElements.elements.length; index += 1) {
      const branchLocation = `${location}.branches[${index}]`;
      const branch = snapshotBranchRecord(
        branchElements.elements[index],
        branchLocation,
      );
      if (!branch.ok) {
        diagnostics.push(...branch.diagnostics);
        continue;
      }
      branchSnapshots.push(branch.value);
    }
    if (diagnostics.length > 0) {
      return { ok: false, diagnostics };
    }
    snapshot.branches = branchSnapshots;
  }

  return { ok: true, value: snapshot };
}

/**
 * Snapshot a region definition into own data properties only.
 */
function snapshotRegionDefinition(
  value: unknown,
  location: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_not_plain_object",
        "Derived fan-out region definition must be a plain object.",
        location,
      )],
    };
  }
  const fields = readKnownOwnDataFields(value, DEFINITION_SNAPSHOT_KEYS, location);
  if (!fields.ok) {
    return { ok: false, diagnostics: fields.diagnostics };
  }
  return { ok: true, value: fields.record };
}

/**
 * Snapshot complete/append options into own data properties only.
 * Absent options yield an empty record.
 */
function snapshotCompleteOptions(
  options: unknown,
  location = "options",
): { ok: true; value: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] } {
  if (options === undefined || options === null) {
    return { ok: true, value: {} };
  }
  if (!isStrictPlainObject(options)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_options",
        "Complete options must be a plain object when present.",
        location,
      )],
    };
  }
  const fields = readKnownOwnDataFields(options, COMPLETE_OPTIONS_SNAPSHOT_KEYS, location);
  if (!fields.ok) {
    return { ok: false, diagnostics: fields.diagnostics };
  }
  const record = { ...fields.record };
  if ("evidence" in record) {
    const evidence = snapshotEvidenceArray(record.evidence, `${location}.evidence`);
    if (!evidence.ok) {
      return { ok: false, diagnostics: evidence.diagnostics };
    }
    record.evidence = evidence.value;
  }
  return { ok: true, value: record };
}

/**
 * Build a stable branch id from region id and collection index.
 * See module header for the full identity rule.
 */
export function derivedBranchId(regionId: string, index: number): string {
  return `${regionId}/item/${index}`;
}

function isTerminalStatus(status: DerivedBranchStatus): boolean {
  return TERMINAL_BRANCH_STATUSES.has(status);
}

/**
 * Clone an evidence list.
 * Returns an empty list when evidence is not an array so callers never throw.
 * Schema validation rejects non-array evidence before copy on public helpers.
 */
function copyEvidence(evidence: unknown): EvidenceReference[] {
  if (!Array.isArray(evidence)) return [];
  const items: EvidenceReference[] = [];
  for (const entry of evidence) {
    if (!isStrictPlainObject(entry) || !isNonEmptyString(entry.ref)) continue;
    const copy: EvidenceReference = { ref: entry.ref.trim() };
    if (
      entry.kind === "tool"
      || entry.kind === "command"
      || entry.kind === "file"
      || entry.kind === "approval"
      || entry.kind === "note"
    ) {
      copy.kind = entry.kind;
    }
    if (typeof entry.summary === "string") copy.summary = entry.summary;
    if (entry.visibility === "public" || entry.visibility === "protected") {
      copy.visibility = entry.visibility;
    }
    items.push(copy);
  }
  return items;
}

/**
 * Clone one branch record for pure updates.
 * Defensive against missing evidence so a bypass of the schema guard cannot throw.
 */
function copyBranch(branch: DerivedBranchRuntime): DerivedBranchRuntime {
  const copy: DerivedBranchRuntime = {
    branchId: branch.branchId,
    regionId: branch.regionId,
    index: branch.index,
    itemValue: branch.itemValue,
    status: branch.status,
    attemptNumber: branch.attemptNumber,
    evidence: copyEvidence(branch.evidence),
  };
  if (branch.attemptId !== undefined) copy.attemptId = branch.attemptId;
  if (branch.failureReason !== undefined) copy.failureReason = branch.failureReason;
  return copy;
}

function copyExpansion(expansion: DerivedFanOutExpansion): DerivedFanOutExpansion {
  const branches = Array.isArray(expansion.branches)
    ? expansion.branches.map(copyBranch)
    : [];
  const usedAttemptIds = Array.isArray(expansion.usedAttemptIds)
    ? [...expansion.usedAttemptIds]
    : [];
  const collectionValues = Array.isArray(expansion.collectionValues)
    ? [...expansion.collectionValues]
    : [];
  return {
    schemaVersion: DERIVED_FAN_OUT_SCHEMA_VERSION,
    regionId: expansion.regionId,
    collectionFact: expansion.collectionFact,
    collectionValues,
    fanInPolicy: expansion.fanInPolicy,
    maxBranches: expansion.maxBranches,
    branches,
    usedAttemptIds,
  };
}

function validateEvidenceList(
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): EvidenceReference[] | undefined {
  // Snapshot first so index and nested field accessors yield diagnostics.
  const snapshot = snapshotEvidenceArray(value, location);
  if (!snapshot.ok) {
    diagnostics.push(...snapshot.diagnostics);
    return undefined;
  }
  if (!Array.isArray(snapshot.value)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_evidence",
      "Branch evidence must be an array.",
      location,
    ));
    return undefined;
  }
  const items: EvidenceReference[] = [];
  let failed = false;
  for (let index = 0; index < snapshot.value.length; index += 1) {
    const entry = snapshot.value[index];
    const entryLocation = `${location}[${index}]`;
    if (!isStrictPlainObject(entry)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_evidence",
        "Each evidence entry must be a plain object.",
        entryLocation,
      ));
      failed = true;
      continue;
    }
    if (!isNonEmptyString(entry.ref)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_evidence",
        "Evidence ref must be a non-empty string.",
        `${entryLocation}.ref`,
      ));
      failed = true;
      continue;
    }
    const item: EvidenceReference = { ref: entry.ref.trim() };
    if (entry.kind !== undefined) {
      if (
        entry.kind !== "tool"
        && entry.kind !== "command"
        && entry.kind !== "file"
        && entry.kind !== "approval"
        && entry.kind !== "note"
      ) {
        diagnostics.push(reject(
          "derived_fan_out_invalid_evidence",
          "Evidence kind must be a known evidence kind when present.",
          `${entryLocation}.kind`,
        ));
        failed = true;
        continue;
      }
      item.kind = entry.kind;
    }
    if (entry.summary !== undefined) {
      if (typeof entry.summary !== "string") {
        diagnostics.push(reject(
          "derived_fan_out_invalid_evidence",
          "Evidence summary must be a string when present.",
          `${entryLocation}.summary`,
        ));
        failed = true;
        continue;
      }
      item.summary = entry.summary;
    }
    if (entry.visibility !== undefined) {
      if (entry.visibility !== "public" && entry.visibility !== "protected") {
        diagnostics.push(reject(
          "derived_fan_out_invalid_evidence",
          "Evidence visibility must be 'public' or 'protected' when present.",
          `${entryLocation}.visibility`,
        ));
        failed = true;
        continue;
      }
      item.visibility = entry.visibility;
    }
    items.push(item);
  }
  return failed ? undefined : items;
}

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

/**
 * Validate a derived fan-out region definition.
 * Accepts untrusted input. Rejects class instances and accessors.
 * Does not mutate input. Returns diagnostics. Does not throw on invalid input.
 */
export function validateDerivedFanOutRegionDefinition(
  value: unknown,
  location = "region",
): Diagnostic[] {
  const snapshot = snapshotRegionDefinition(value, location);
  if (!snapshot.ok) {
    return snapshot.diagnostics;
  }

  const diagnostics: Diagnostic[] = [];
  const record = snapshot.value;

  if (!isNonEmptyString(record.id)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_id",
      "Region id must be a non-empty string.",
      `${location}.id`,
    ));
  }

  if (!isNonEmptyString(record.collectionFact)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_collection_fact",
      "collectionFact must be a non-empty string fact name.",
      `${location}.collectionFact`,
    ));
  }

  if (!isPositiveSafeInteger(record.maxBranches)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_max_branches",
      "maxBranches must be a positive safe integer.",
      `${location}.maxBranches`,
    ));
  }

  if (
    typeof record.fanInPolicy !== "string"
    || !DERIVED_FAN_IN_POLICY_SET.has(record.fanInPolicy)
  ) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_fan_in_policy",
      `fanInPolicy must be one of: ${DERIVED_FAN_IN_POLICIES.join(", ")}.`,
      `${location}.fanInPolicy`,
    ));
  }

  return diagnostics;
}

/**
 * Parse and clone a valid derived fan-out region definition.
 * Reads only own data properties. Does not mutate input.
 */
export function parseDerivedFanOutRegionDefinition(
  value: unknown,
  location = "region",
): DerivedFanOutParseDefinitionResult {
  const snapshot = snapshotRegionDefinition(value, location);
  if (!snapshot.ok) {
    return { ok: false, diagnostics: snapshot.diagnostics };
  }
  const diagnostics = validateDerivedFanOutRegionDefinition(value, location);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  const record = snapshot.value;
  return {
    ok: true,
    value: {
      id: (record.id as string).trim(),
      collectionFact: (record.collectionFact as string).trim(),
      maxBranches: record.maxBranches as number,
      fanInPolicy: record.fanInPolicy as DerivedFanInPolicy,
    },
  };
}

// ---------------------------------------------------------------------------
// Expansion schema and restore
// ---------------------------------------------------------------------------

/**
 * Reject an unsupported expansion schema version or a missing structural shape.
 * Checks arrays and the minimum branch shape that lifecycle helpers and copy
 * paths require, so untrusted records return diagnostics and do not throw.
 *
 * Reads only own data properties. Accessor properties yield diagnostics.
 *
 * Each branch entry must be a plain object with:
 * - status: a known branch status string;
 * - evidence: an array.
 * Full identity and uniqueness checks belong to validateDerivedFanOutExpansion.
 */
export function validateDerivedFanOutExpansionSchema(
  value: unknown,
  location = "expansion",
): Diagnostic[] {
  const snapshot = snapshotDerivedFanOutExpansion(value, location);
  if (!snapshot.ok) {
    return snapshot.diagnostics;
  }
  return validateDerivedFanOutExpansionSchemaSnapshot(snapshot.value, location);
}

/**
 * Schema checks against a plain snapshot of own data properties.
 * Assumes accessors were already rejected during snapshot construction.
 */
function validateDerivedFanOutExpansionSchemaSnapshot(
  record: Record<string, unknown>,
  location: string,
): Diagnostic[] {
  if (record.schemaVersion !== DERIVED_FAN_OUT_SCHEMA_VERSION) {
    return [reject(
      "derived_fan_out_unsupported_schema",
      `Unsupported derived fan-out expansion schema version '${formatUntrustedDiagnosticValue(record.schemaVersion)}'. Expected ${DERIVED_FAN_OUT_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    )];
  }
  const diagnostics: Diagnostic[] = [];
  if (!Array.isArray(record.collectionValues)) {
    diagnostics.push(reject(
      "derived_fan_out_collection_not_array",
      "Expansion collectionValues must be a string array.",
      `${location}.collectionValues`,
    ));
  }
  if (!Array.isArray(record.usedAttemptIds)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_used_attempt_ids",
      "Expansion usedAttemptIds must be a string array.",
      `${location}.usedAttemptIds`,
    ));
  }
  if (!Array.isArray(record.branches)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_branches",
      "Expansion branches must be an array.",
      `${location}.branches`,
    ));
    return diagnostics;
  }

  for (let index = 0; index < record.branches.length; index += 1) {
    const branchLocation = `${location}.branches[${index}]`;
    const branch = record.branches[index];
    if (!isStrictPlainObject(branch)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_branches",
        "Each branch must be a plain object.",
        branchLocation,
      ));
      continue;
    }
    if (
      typeof branch.status !== "string"
      || !DERIVED_BRANCH_STATUS_SET.has(branch.status)
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_status",
        `Branch status must be one of: ${DERIVED_BRANCH_STATUSES.join(", ")}.`,
        `${branchLocation}.status`,
      ));
    }
    if (!Array.isArray(branch.evidence)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_evidence",
        "Branch evidence must be an array.",
        `${branchLocation}.evidence`,
      ));
    }
  }
  return diagnostics;
}

/**
 * Validate a full expansion record for restore and apply paths.
 * Applies the same identity, bound, and uniqueness checks as expand and start.
 * Reads only own data properties. Accessor properties yield diagnostics.
 * Does not mutate input. Does not throw on invalid input.
 */
export function validateDerivedFanOutExpansion(
  value: unknown,
  location = "expansion",
): Diagnostic[] {
  const snapshot = snapshotDerivedFanOutExpansion(value, location);
  if (!snapshot.ok) {
    return snapshot.diagnostics;
  }
  const schemaDiagnostics = validateDerivedFanOutExpansionSchemaSnapshot(
    snapshot.value,
    location,
  );
  if (schemaDiagnostics.length > 0) return schemaDiagnostics;

  const record = snapshot.value;
  const diagnostics: Diagnostic[] = [];

  if (!isNonEmptyString(record.regionId)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_id",
      "Expansion regionId must be a non-empty string.",
      `${location}.regionId`,
    ));
  }
  if (!isNonEmptyString(record.collectionFact)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_collection_fact",
      "Expansion collectionFact must be a non-empty string.",
      `${location}.collectionFact`,
    ));
  }
  if (!isPositiveSafeInteger(record.maxBranches)) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_max_branches",
      "Expansion maxBranches must be a positive safe integer.",
      `${location}.maxBranches`,
    ));
  }
  if (
    typeof record.fanInPolicy !== "string"
    || !DERIVED_FAN_IN_POLICY_SET.has(record.fanInPolicy)
  ) {
    diagnostics.push(reject(
      "derived_fan_out_invalid_fan_in_policy",
      `Expansion fanInPolicy must be one of: ${DERIVED_FAN_IN_POLICIES.join(", ")}.`,
      `${location}.fanInPolicy`,
    ));
  }

  const collectionValues = record.collectionValues as unknown[];
  for (let index = 0; index < collectionValues.length; index += 1) {
    if (typeof collectionValues[index] !== "string") {
      diagnostics.push(reject(
        "derived_fan_out_collection_item_invalid",
        `Collection item at index ${index} must be a string.`,
        `${location}.collectionValues[${index}]`,
      ));
    }
  }

  if (
    isPositiveSafeInteger(record.maxBranches)
    && collectionValues.length > (record.maxBranches as number)
  ) {
    diagnostics.push(reject(
      "derived_fan_out_collection_exceeds_max",
      `Collection length ${collectionValues.length} exceeds maxBranches ${record.maxBranches as number}.`,
      `${location}.collectionValues`,
    ));
  }

  const branches = record.branches as unknown[];
  if (branches.length !== collectionValues.length) {
    diagnostics.push(reject(
      "derived_fan_out_branch_count_mismatch",
      "Expansion branch count must equal collectionValues length.",
      `${location}.branches`,
    ));
  }

  const usedAttemptIds = record.usedAttemptIds as unknown[];
  const seenUsedAttemptIds = new Set<string>();
  let usedAttemptIdsValid = true;
  for (let index = 0; index < usedAttemptIds.length; index += 1) {
    const attemptId = usedAttemptIds[index];
    if (!isNonEmptyString(attemptId)) {
      usedAttemptIdsValid = false;
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_id",
        `usedAttemptIds entry at index ${index} must be a non-empty string.`,
        `${location}.usedAttemptIds[${index}]`,
      ));
      continue;
    }
    const trimmed = attemptId.trim();
    if (seenUsedAttemptIds.has(trimmed)) {
      usedAttemptIdsValid = false;
      diagnostics.push(reject(
        "derived_fan_out_duplicate_attempt_id",
        `Attempt id '${trimmed}' is not unique in usedAttemptIds.`,
        `${location}.usedAttemptIds[${index}]`,
      ));
    }
    seenUsedAttemptIds.add(trimmed);
  }

  const seenBranchIds = new Set<string>();
  const seenCurrentAttemptIds = new Set<string>();
  let attemptCountSum = 0;
  let attemptNumbersComplete = true;
  const regionId = isNonEmptyString(record.regionId)
    ? (record.regionId as string).trim()
    : undefined;

  for (let index = 0; index < branches.length; index += 1) {
    const branchLocation = `${location}.branches[${index}]`;
    const branch = branches[index];
    if (!isStrictPlainObject(branch)) {
      attemptNumbersComplete = false;
      diagnostics.push(reject(
        "derived_fan_out_invalid_branches",
        "Each branch must be a plain object.",
        branchLocation,
      ));
      continue;
    }

    if (!isNonEmptyString(branch.branchId)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_branch_id",
        "branchId must be a non-empty string.",
        `${branchLocation}.branchId`,
      ));
    } else {
      const id = (branch.branchId as string).trim();
      if (seenBranchIds.has(id)) {
        diagnostics.push(reject(
          "derived_fan_out_duplicate_branch_id",
          `Branch id '${id}' is not unique in the expansion.`,
          `${branchLocation}.branchId`,
        ));
      }
      seenBranchIds.add(id);
      if (regionId !== undefined && isNonNegativeSafeInteger(branch.index)) {
        const expectedId = derivedBranchId(regionId, branch.index as number);
        if (id !== expectedId) {
          diagnostics.push(reject(
            "derived_fan_out_branch_identity_mismatch",
            `Branch id '${id}' does not match the stable identity rule (expected '${expectedId}').`,
            `${branchLocation}.branchId`,
          ));
        }
      }
    }

    // regionId is required on every branch and must match the expansion.
    if (!isNonEmptyString(branch.regionId)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_branch_region_id",
        "Branch regionId must be a non-empty string.",
        `${branchLocation}.regionId`,
      ));
    } else if (regionId !== undefined && (branch.regionId as string).trim() !== regionId) {
      diagnostics.push(reject(
        "derived_fan_out_branch_region_mismatch",
        "Branch regionId must match the expansion regionId.",
        `${branchLocation}.regionId`,
      ));
    }

    if (!isNonNegativeSafeInteger(branch.index)) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_branch_index",
        "Branch index must be a non-negative safe integer.",
        `${branchLocation}.index`,
      ));
    } else if (branch.index !== index) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_branch_index",
        `Branch index ${String(branch.index)} must equal array position ${index}.`,
        `${branchLocation}.index`,
      ));
    }

    if (typeof branch.itemValue !== "string") {
      diagnostics.push(reject(
        "derived_fan_out_collection_item_invalid",
        "Branch itemValue must be a string.",
        `${branchLocation}.itemValue`,
      ));
    } else if (
      typeof collectionValues[index] === "string"
      && branch.itemValue !== collectionValues[index]
    ) {
      diagnostics.push(reject(
        "derived_fan_out_item_value_mismatch",
        "Branch itemValue must match collectionValues at the same index.",
        `${branchLocation}.itemValue`,
      ));
    }

    if (
      typeof branch.status !== "string"
      || !DERIVED_BRANCH_STATUS_SET.has(branch.status)
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_status",
        `Branch status must be one of: ${DERIVED_BRANCH_STATUSES.join(", ")}.`,
        `${branchLocation}.status`,
      ));
    }

    if (!isNonNegativeSafeInteger(branch.attemptNumber)) {
      attemptNumbersComplete = false;
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_number",
        "Branch attemptNumber must be a non-negative safe integer.",
        `${branchLocation}.attemptNumber`,
      ));
    } else {
      attemptCountSum += branch.attemptNumber as number;
    }

    if (branch.attemptId !== undefined) {
      if (!isNonEmptyString(branch.attemptId)) {
        diagnostics.push(reject(
          "derived_fan_out_invalid_attempt_id",
          "Branch attemptId must be a non-empty string when present.",
          `${branchLocation}.attemptId`,
        ));
      } else {
        const attemptId = (branch.attemptId as string).trim();
        if (seenCurrentAttemptIds.has(attemptId)) {
          diagnostics.push(reject(
            "derived_fan_out_duplicate_attempt_id",
            `Attempt id '${attemptId}' is not unique among current branch attempts.`,
            `${branchLocation}.attemptId`,
          ));
        }
        seenCurrentAttemptIds.add(attemptId);
        if (!seenUsedAttemptIds.has(attemptId)) {
          diagnostics.push(reject(
            "derived_fan_out_attempt_id_not_recorded",
            `Branch attemptId '${attemptId}' is not present in usedAttemptIds.`,
            `${branchLocation}.attemptId`,
          ));
        }
      }
    }

    if (
      isNonNegativeSafeInteger(branch.attemptNumber)
      && (branch.attemptNumber as number) === 0
      && branch.attemptId !== undefined
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_number",
        "Branch attemptNumber zero means no attempt started, so attemptId must be absent.",
        `${branchLocation}.attemptNumber`,
      ));
    }

    if (
      isNonNegativeSafeInteger(branch.attemptNumber)
      && (branch.attemptNumber as number) === 0
      && typeof branch.status === "string"
      && (
        branch.status === "running"
        || branch.status === "succeeded"
        || branch.status === "failed"
      )
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_number",
        `Branch status '${branch.status}' requires attemptNumber at least one.`,
        `${branchLocation}.attemptNumber`,
      ));
    }

    if (
      isNonNegativeSafeInteger(branch.attemptNumber)
      && (branch.attemptNumber as number) >= 1
      && branch.attemptId === undefined
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_id",
        "Branch attemptId must be present when attemptNumber is at least one.",
        `${branchLocation}.attemptId`,
      ));
    }

    if (
      typeof branch.status === "string"
      && (branch.status === "running" || branch.status === "succeeded" || branch.status === "failed")
      && !isNonEmptyString(branch.attemptId)
    ) {
      diagnostics.push(reject(
        "derived_fan_out_invalid_attempt_id",
        `Branch status '${branch.status}' requires a non-empty attemptId.`,
        `${branchLocation}.attemptId`,
      ));
    }

    if (branch.failureReason !== undefined && typeof branch.failureReason !== "string") {
      diagnostics.push(reject(
        "derived_fan_out_invalid_failure_reason",
        "Branch failureReason must be a string when present.",
        `${branchLocation}.failureReason`,
      ));
    }
    validateEvidenceList(branch.evidence, `${branchLocation}.evidence`, diagnostics);
  }

  // Every start increments one branch attemptNumber and appends one usedAttemptIds
  // entry. History length must equal the sum of branch attempt counts so prior
  // attempt ids cannot be dropped and later reused after restore.
  if (
    attemptNumbersComplete
    && usedAttemptIdsValid
    && usedAttemptIds.length !== attemptCountSum
  ) {
    diagnostics.push(reject(
      "derived_fan_out_attempt_history_mismatch",
      `usedAttemptIds length ${usedAttemptIds.length} must equal the sum of branch attemptNumber values (${attemptCountSum}).`,
      `${location}.usedAttemptIds`,
    ));
  }

  return diagnostics;
}

/**
 * Parse and clone a valid expansion for restore.
 * Applies full validation. Builds the result from an own-data-property snapshot.
 * Does not mutate input. Does not throw on invalid input.
 */
export function parseDerivedFanOutExpansion(
  value: unknown,
  location = "expansion",
): DerivedFanOutParseExpansionResult {
  const snapshot = snapshotDerivedFanOutExpansion(value, location);
  if (!snapshot.ok) {
    return { ok: false, diagnostics: snapshot.diagnostics };
  }
  const diagnostics = validateDerivedFanOutExpansion(value, location);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  const record = snapshot.value;
  const branchesRaw = record.branches as Array<Record<string, unknown>>;
  const branches: DerivedBranchRuntime[] = branchesRaw.map((branch) => {
    const evidence = validateEvidenceList(branch.evidence, "evidence", []) ?? [];
    const copy: DerivedBranchRuntime = {
      branchId: (branch.branchId as string).trim(),
      regionId: (branch.regionId as string).trim(),
      index: branch.index as number,
      itemValue: branch.itemValue as string,
      status: branch.status as DerivedBranchStatus,
      attemptNumber: branch.attemptNumber as number,
      evidence: copyEvidence(evidence),
    };
    if (branch.attemptId !== undefined) {
      copy.attemptId = (branch.attemptId as string).trim();
    }
    if (branch.failureReason !== undefined) {
      copy.failureReason = branch.failureReason as string;
    }
    return copy;
  });

  const usedAttemptIds = (record.usedAttemptIds as string[]).map((id) =>
    (id as string).trim()
  );

  return {
    ok: true,
    value: {
      schemaVersion: DERIVED_FAN_OUT_SCHEMA_VERSION,
      regionId: (record.regionId as string).trim(),
      collectionFact: (record.collectionFact as string).trim(),
      collectionValues: [...(record.collectionValues as string[])],
      fanInPolicy: record.fanInPolicy as DerivedFanInPolicy,
      maxBranches: record.maxBranches as number,
      branches,
      usedAttemptIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure expansion
// ---------------------------------------------------------------------------

/**
 * Validate collection values for expansion.
 * Collection must be a string array whose length does not exceed maxBranches.
 * Empty collections are allowed and produce zero branches.
 * Reads array elements as own data properties. Rejects index accessors.
 */
function validateCollectionValues(
  collectionValues: unknown,
  maxBranches: number,
  location: string,
): { ok: true; values: string[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (!Array.isArray(collectionValues)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_collection_not_array",
        "Collection fact value must be a string array (string-list).",
        location,
      )],
    };
  }
  const elements = snapshotArrayElements(collectionValues, location);
  if (!elements.ok) {
    return { ok: false, diagnostics: elements.diagnostics };
  }
  if (elements.elements.length > maxBranches) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_collection_exceeds_max",
        `Collection length ${elements.elements.length} exceeds maxBranches ${maxBranches}. The runtime rejects the collection. It does not truncate.`,
        location,
      )],
    };
  }
  const values: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < elements.elements.length; index += 1) {
    const item = elements.elements[index];
    if (typeof item !== "string") {
      diagnostics.push(reject(
        "derived_fan_out_collection_item_invalid",
        `Collection item at index ${index} must be a string.`,
        `${location}[${index}]`,
      ));
      continue;
    }
    values.push(item);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, values };
}

/**
 * Expand a derived fan-out region from a string-list collection.
 *
 * Pure function of definition + collection values + stable branch identity rules.
 * Does not read the clock, create random values, or mutate inputs.
 *
 * Returns one branch per collection item, ordered by collection index.
 * Rejects collections longer than maxBranches with a clear diagnostic.
 */
export function expandDerivedFanOutRegion(
  definition: unknown,
  collectionValues: unknown,
): DerivedFanOutExpandResult {
  const parsed = parseDerivedFanOutRegionDefinition(definition, "region");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  const def = parsed.value;

  const collection = validateCollectionValues(
    collectionValues,
    def.maxBranches,
    "collectionValues",
  );
  if (!collection.ok) {
    return { ok: false, diagnostics: collection.diagnostics };
  }

  const branches: DerivedBranchRuntime[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < collection.values.length; index += 1) {
    const itemValue = collection.values[index]!;
    const branchId = derivedBranchId(def.id, index);
    if (seenIds.has(branchId)) {
      // Defensive: index-based ids are unique for a finite collection.
      return {
        ok: false,
        diagnostics: [reject(
          "derived_fan_out_duplicate_branch_id",
          `Branch id '${branchId}' is not unique.`,
          `branches[${index}].branchId`,
        )],
      };
    }
    seenIds.add(branchId);
    branches.push({
      branchId,
      regionId: def.id,
      index,
      itemValue,
      status: "pending",
      attemptNumber: 0,
      evidence: [],
    });
  }

  return {
    ok: true,
    expansion: {
      schemaVersion: DERIVED_FAN_OUT_SCHEMA_VERSION,
      regionId: def.id,
      collectionFact: def.collectionFact,
      collectionValues: [...collection.values],
      fanInPolicy: def.fanInPolicy,
      maxBranches: def.maxBranches,
      branches,
      usedAttemptIds: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Branch lifecycle (pure updates)
// ---------------------------------------------------------------------------

function findBranchIndex(
  expansion: DerivedFanOutExpansion,
  branchId: string,
): number {
  const id = branchId.trim();
  return expansion.branches.findIndex((branch) => branch.branchId === id);
}

function rejectInvalidBranchIdArgument(): DerivedFanOutBranchUpdateResult {
  return {
    ok: false,
    diagnostics: [reject(
      "derived_fan_out_invalid_branch_id_argument",
      "branchId must be a non-empty string.",
      "branchId",
    )],
  };
}

/**
 * Start a new attempt on a branch.
 * Assigns attemptId, increments attemptNumber, and sets status to running.
 * Start is allowed only from pending or failed.
 * A start from running, succeeded, or cancelled is rejected.
 * Rejects an attempt id that appears in usedAttemptIds.
 * Does not mutate the input expansion.
 */
export function startDerivedBranchAttempt(
  expansion: DerivedFanOutExpansion,
  branchId: string,
  attemptId: string,
): DerivedFanOutBranchUpdateResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (!isNonEmptyString(branchId)) {
    return rejectInvalidBranchIdArgument();
  }
  if (!isNonEmptyString(attemptId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_attempt_id",
        "attemptId must be a non-empty string.",
        "attemptId",
      )],
    };
  }

  const next = copyExpansion(expansion);
  const index = findBranchIndex(next, branchId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_branch_not_found",
        `Branch '${branchId.trim()}' is not in the expansion.`,
        "branchId",
      )],
    };
  }
  const branch = next.branches[index]!;
  // Start only from pending (first attempt) or failed (retry).
  // Reject running so an in-flight attempt identity is not replaced.
  if (branch.status !== "pending" && branch.status !== "failed") {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_status",
        `Cannot start an attempt on branch '${branch.branchId}' in status '${branch.status}'. Start is allowed only from pending or failed.`,
        "branchId",
      )],
    };
  }

  const trimmedAttemptId = attemptId.trim();
  if (next.usedAttemptIds.includes(trimmedAttemptId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_duplicate_attempt_id",
        `Attempt id '${trimmedAttemptId}' was already used in this expansion.`,
        "attemptId",
      )],
    };
  }

  branch.attemptId = trimmedAttemptId;
  branch.attemptNumber = branch.attemptNumber + 1;
  branch.status = "running";
  delete branch.failureReason;
  next.usedAttemptIds.push(trimmedAttemptId);
  return { ok: true, expansion: next };
}

/**
 * Mark a branch as terminal with succeeded, failed, or cancelled.
 *
 * Preconditions:
 * - succeeded and failed require status running (an active attempt).
 * - cancelled requires a non-terminal status (pending or running).
 * - An already terminal branch cannot be completed again.
 * - Completing a running attempt requires options.attemptId equal to the
 *   branch current attemptId. A stale attempt id is rejected.
 * - Cancel from pending does not require an attempt id.
 *
 * Does not mutate the input expansion.
 */
export function completeDerivedBranch(
  expansion: DerivedFanOutExpansion,
  branchId: string,
  status: "succeeded" | "failed" | "cancelled",
  options?: {
    /**
     * Current attempt id for the branch.
     * Required when the branch is running (succeeded, failed, or cancel).
     */
    attemptId?: string;
    failureReason?: string;
    evidence?: readonly EvidenceReference[];
  },
): DerivedFanOutBranchUpdateResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (!isNonEmptyString(branchId)) {
    return rejectInvalidBranchIdArgument();
  }
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_status",
        "Terminal status must be 'succeeded', 'failed', or 'cancelled'.",
        "status",
      )],
    };
  }

  // Read options through own data properties before any field use.
  const optionsSnapshot = snapshotCompleteOptions(options, "options");
  if (!optionsSnapshot.ok) {
    return { ok: false, diagnostics: optionsSnapshot.diagnostics };
  }
  const cleanOptions = optionsSnapshot.value;

  const next = copyExpansion(expansion);
  const index = findBranchIndex(next, branchId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_branch_not_found",
        `Branch '${branchId.trim()}' is not in the expansion.`,
        "branchId",
      )],
    };
  }
  const branch = next.branches[index]!;

  if (isTerminalStatus(branch.status)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_status",
        `Cannot complete branch '${branch.branchId}' because its status is already '${branch.status}'.`,
        "branchId",
      )],
    };
  }

  if (status === "succeeded" || status === "failed") {
    if (branch.status !== "running") {
      return {
        ok: false,
        diagnostics: [reject(
          "derived_fan_out_invalid_status",
          `Cannot mark branch '${branch.branchId}' as '${status}' from status '${branch.status}'. A running attempt is required.`,
          "branchId",
        )],
      };
    }
  }
  // cancelled: allowed from pending or running (already confirmed non-terminal).

  // Running attempts require the caller attempt id so a late result from a
  // prior attempt cannot complete the current attempt.
  if (branch.status === "running") {
    if (!isNonEmptyString(cleanOptions.attemptId)) {
      return {
        ok: false,
        diagnostics: [reject(
          "derived_fan_out_invalid_attempt_id",
          "attemptId is required when completing a running branch attempt.",
          "attemptId",
        )],
      };
    }
    const trimmedAttemptId = (cleanOptions.attemptId as string).trim();
    if (trimmedAttemptId !== branch.attemptId) {
      return {
        ok: false,
        diagnostics: [reject(
          "derived_fan_out_stale_attempt",
          `Attempt id '${trimmedAttemptId}' does not match the current attempt '${branch.attemptId ?? ""}' on branch '${branch.branchId}'.`,
          "attemptId",
        )],
      };
    }
  }

  branch.status = status;
  if (status === "failed") {
    if (cleanOptions.failureReason !== undefined) {
      if (typeof cleanOptions.failureReason !== "string") {
        return {
          ok: false,
          diagnostics: [reject(
            "derived_fan_out_invalid_failure_reason",
            "failureReason must be a string when present.",
            "failureReason",
          )],
        };
      }
      branch.failureReason = cleanOptions.failureReason;
    } else {
      branch.failureReason = branch.failureReason ?? "branch failed";
    }
  } else {
    delete branch.failureReason;
  }
  if (cleanOptions.evidence !== undefined) {
    const evidenceDiagnostics: Diagnostic[] = [];
    const evidence = validateEvidenceList(
      cleanOptions.evidence,
      "evidence",
      evidenceDiagnostics,
    );
    if (evidenceDiagnostics.length > 0 || evidence === undefined) {
      return {
        ok: false,
        diagnostics: evidenceDiagnostics.length > 0
          ? evidenceDiagnostics
          : [reject(
            "derived_fan_out_invalid_evidence",
            "Evidence list is invalid.",
            "evidence",
          )],
      };
    }
    branch.evidence = [...branch.evidence, ...copyEvidence(evidence)];
  }
  return { ok: true, expansion: next };
}

/**
 * Append evidence to a branch without changing status.
 * Does not mutate the input expansion.
 */
export function appendDerivedBranchEvidence(
  expansion: DerivedFanOutExpansion,
  branchId: string,
  evidence: readonly EvidenceReference[],
): DerivedFanOutBranchUpdateResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (!isNonEmptyString(branchId)) {
    return rejectInvalidBranchIdArgument();
  }
  const evidenceDiagnostics: Diagnostic[] = [];
  const parsedEvidence = validateEvidenceList(evidence, "evidence", evidenceDiagnostics);
  if (evidenceDiagnostics.length > 0 || parsedEvidence === undefined) {
    return {
      ok: false,
      diagnostics: evidenceDiagnostics.length > 0
        ? evidenceDiagnostics
        : [reject(
          "derived_fan_out_invalid_evidence",
          "Evidence list is invalid.",
          "evidence",
        )],
    };
  }

  const next = copyExpansion(expansion);
  const index = findBranchIndex(next, branchId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_branch_not_found",
        `Branch '${branchId.trim()}' is not in the expansion.`,
        "branchId",
      )],
    };
  }
  next.branches[index]!.evidence = [
    ...next.branches[index]!.evidence,
    ...copyEvidence(parsedEvidence),
  ];
  return { ok: true, expansion: next };
}

/**
 * List branches as deep clones in collection index order.
 * Rejects unsupported schema versions and missing structural arrays.
 */
export function listDerivedBranches(
  expansion: DerivedFanOutExpansion,
): DerivedFanOutListResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  // Preserve index order. Do not use locale-sensitive sort on branch ids.
  const ordered = expansion.branches
    .map(copyBranch)
    .sort((left, right) => left.index - right.index);
  return { ok: true, branches: ordered };
}

/**
 * Return a deep clone of one branch, or undefined when the id is absent.
 * Rejects a non-string or empty branchId with a diagnostic (same argument
 * contract as the lifecycle helpers).
 */
export function getDerivedBranch(
  expansion: DerivedFanOutExpansion,
  branchId: string,
): DerivedFanOutGetBranchResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (!isNonEmptyString(branchId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "derived_fan_out_invalid_branch_id_argument",
        "branchId must be a non-empty string.",
        "branchId",
      )],
    };
  }
  const id = branchId.trim();
  const found = expansion.branches.find((branch) => branch.branchId === id);
  return { ok: true, branch: found ? copyBranch(found) : undefined };
}

// ---------------------------------------------------------------------------
// Fan-in
// ---------------------------------------------------------------------------

/**
 * Report whether every branch is terminal (succeeded, failed, or cancelled).
 */
export function areAllDerivedBranchesTerminal(
  expansion: DerivedFanOutExpansion,
): { ok: true; terminal: boolean } | { ok: false; diagnostics: Diagnostic[] } {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  const terminal = expansion.branches.every((branch) => isTerminalStatus(branch.status));
  return { ok: true, terminal };
}

/**
 * Evaluate fan-in over branch terminal states and the declared policy.
 *
 * Fan-in waits for every branch to be terminal. When any branch is still
 * pending or running, the result status is pending and the caller must wait.
 *
 * Policies:
 * - fail-all: failed if any branch failed. Otherwise succeeded.
 *   Cancelled alone does not fail.
 * - continue-with-successes: succeeded when at least one branch succeeded.
 *   Failed when no branch succeeded and at least one failed.
 *   Succeeded when all branches are cancelled or the set is empty.
 * - require-all-success: succeeded only when every branch is succeeded,
 *   or when the set is empty.
 *
 * Does not mutate the input expansion.
 */
export function evaluateDerivedFanIn(
  expansion: DerivedFanOutExpansion,
): DerivedFanInEvaluateResult {
  const schemaDiagnostics = validateDerivedFanOutExpansionSchema(expansion);
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }

  const succeededBranchIds: string[] = [];
  const failedBranchIds: string[] = [];
  const cancelledBranchIds: string[] = [];
  const pendingBranchIds: string[] = [];

  // Walk in index order for deterministic result arrays.
  const ordered = [...expansion.branches].sort((left, right) => left.index - right.index);
  for (const branch of ordered) {
    if (branch.status === "succeeded") {
      succeededBranchIds.push(branch.branchId);
    } else if (branch.status === "failed") {
      failedBranchIds.push(branch.branchId);
    } else if (branch.status === "cancelled") {
      cancelledBranchIds.push(branch.branchId);
    } else {
      pendingBranchIds.push(branch.branchId);
    }
  }

  const policy = expansion.fanInPolicy;

  if (pendingBranchIds.length > 0) {
    const count = pendingBranchIds.length;
    const branchWord = count === 1 ? "branch" : "branches";
    const beVerb = count === 1 ? "is" : "are";
    return {
      ok: true,
      result: {
        status: "pending",
        policy,
        succeededBranchIds,
        failedBranchIds,
        cancelledBranchIds,
        pendingBranchIds,
        reason: `Fan-in waits for ${count} ${branchWord} that ${beVerb} not terminal.`,
      },
    };
  }

  // Empty branch set: vacuous success under every policy.
  if (ordered.length === 0) {
    return {
      ok: true,
      result: {
        status: "succeeded",
        policy,
        succeededBranchIds,
        failedBranchIds,
        cancelledBranchIds,
        pendingBranchIds,
        reason: "Empty branch set. Fan-in succeeds with no live branches.",
      },
    };
  }

  let status: "succeeded" | "failed";
  let reason: string;

  switch (policy) {
    case "fail-all": {
      if (failedBranchIds.length > 0) {
        const count = failedBranchIds.length;
        const branchWord = count === 1 ? "branch" : "branches";
        status = "failed";
        reason = `Policy fail-all: ${count} ${branchWord} failed.`;
      } else {
        status = "succeeded";
        reason = "Policy fail-all: no branch failed.";
      }
      break;
    }
    case "continue-with-successes": {
      if (succeededBranchIds.length > 0) {
        status = "succeeded";
        const successCount = succeededBranchIds.length;
        const successWord = successCount === 1 ? "branch" : "branches";
        if (failedBranchIds.length > 0) {
          const failCount = failedBranchIds.length;
          const failWord = failCount === 1 ? "branch" : "branches";
          reason = `Policy continue-with-successes: ${successCount} ${successWord} succeeded with ${failCount} ${failWord} failed.`;
        } else {
          reason = `Policy continue-with-successes: ${successCount} ${successWord} succeeded.`;
        }
      } else if (failedBranchIds.length > 0) {
        status = "failed";
        reason = "Policy continue-with-successes: no branch succeeded and at least one failed.";
      } else {
        // All cancelled.
        status = "succeeded";
        reason = "Policy continue-with-successes: all branches cancelled. No failure remains.";
      }
      break;
    }
    case "require-all-success": {
      if (succeededBranchIds.length === ordered.length) {
        status = "succeeded";
        reason = "Policy require-all-success: every branch succeeded.";
      } else {
        status = "failed";
        const successCount = succeededBranchIds.length;
        const total = ordered.length;
        const successWord = successCount === 1 ? "branch" : "branches";
        reason = `Policy require-all-success: ${successCount} of ${total} ${successWord} succeeded.`;
      }
      break;
    }
    default: {
      // Exhaustiveness guard for untrusted policy on a validated expansion.
      return {
        ok: false,
        diagnostics: [reject(
          "derived_fan_out_invalid_fan_in_policy",
          `Unsupported fan-in policy '${formatUntrustedDiagnosticValue(policy)}'.`,
          "expansion.fanInPolicy",
        )],
      };
    }
  }

  return {
    ok: true,
    result: {
      status,
      policy,
      succeededBranchIds,
      failedBranchIds,
      cancelledBranchIds,
      pendingBranchIds,
      reason,
    },
  };
}
