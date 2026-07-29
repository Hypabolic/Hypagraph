/**
 * Pure concurrent family selection for independent loops and child workflows (M8-s9).
 *
 * Sequential family selection admits at most one pending dispatch. Concurrent
 * selection can choose more than one compatible action when policy permits.
 * Default batch capacity matches DEFAULT_GLOBAL_CONCURRENCY (two attempts).
 *
 * Composition:
 * - family runnable and preferred candidates supplied by the family scheduler;
 * - global and per-executor limits (m8-s7);
 * - concurrency groups and fair selection (m8-s8);
 * - optional workspace lease compatibility (m8-s1).
 *
 * An existing sequential pendingDispatch counts as occupancy. It does not block
 * concurrent selection of other compatible members. Child creation does not
 * clear or freeze independent loop candidates on other members.
 *
 * Persistence of multi-pending family dispatch is deferred. This module selects
 * a batch. Commit of more than one concurrent selection still uses sequential
 * single-pending APIs until a later slice adds multi-pending family state.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * Untrusted property reads use own data-property descriptors only.
 */

import {
  CONCURRENCY_STATE_SCHEMA_VERSION,
  DEFAULT_GLOBAL_CONCURRENCY,
  admitAttempt,
  createEmptyConcurrencyState,
  listConcurrencyActiveAttempts,
  resolveConcurrencyLimits,
  type ConcurrencyState,
} from "./concurrency-limits.js";
import {
  CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
  admitGroupAttempt,
  createEmptyConcurrencyGroupState,
  listConcurrencyGroupActiveAttempts,
  selectFairCandidate,
  type ConcurrencyGroupState,
  type FairnessCandidate,
} from "./concurrency-groups.js";
import type { ExecutorKind } from "./executor-contract.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  type FamilyDispatchPendingStatus,
  type FamilyPendingDispatch,
  type FamilySelectedAction,
  type GoalFamilyRuntime,
  type ScheduledActionIdentity,
} from "./goal-family.js";
import type {
  Diagnostic,
  GoalBlockerIdentity,
  GoalBlockerKind,
  GoalContinuationAction,
  GoalWorkContinuationActionKind,
} from "./model.js";
import {
  DEFAULT_MAX_LEASE_PATHS,
  WORKSPACE_LEASE_SET_SCHEMA_VERSION,
  acquireWorkspaceLease,
  canonicalLeasePath,
  createEmptyWorkspaceLeaseSet,
  type WorkspaceLease,
  type WorkspaceLeaseMode,
  type WorkspaceLeaseSet,
} from "./workspace-lease.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version for pure concurrent selection occupancy snapshots.
 * Not persisted on the goal family in this slice. Reject unsupported versions
 * when callers supply an occupancy snapshot with schemaVersion.
 */
export const FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION = 1 as const;

/** Default executor kind for concurrent family candidates. */
export const DEFAULT_FAMILY_CONCURRENT_EXECUTOR_KIND: ExecutorKind = "isolated-pi";

const EXECUTOR_KINDS = new Set<string>([
  "current-session",
  "isolated-pi",
  "acp",
  "cli",
  "deterministic",
]);

/** Soft capacity / occupancy conflicts. Soft skips remove a candidate and continue. */
const SOFT_CONCURRENCY_CODES = new Set([
  "concurrency_global_limit",
  "concurrency_executor_limit",
  "concurrency_duplicate_attempt",
]);

const SOFT_GROUP_CODES = new Set([
  "concurrency_group_limit",
  "concurrency_group_duplicate_attempt",
]);

const SOFT_LEASE_CODES = new Set([
  "workspace_lease_incompatible",
  "workspace_lease_active_limit",
  "workspace_lease_duplicate_id",
  "workspace_lease_duplicate_attempt",
]);

const GOAL_WORK_ACTION_KINDS = new Set<string>([
  "continue-active-task",
  "start-ready-task",
  "run-ready-check",
  "run-ready-code",
  "run-ready-effect",
  "reconcile-indeterminate-effect",
  "evaluate-ready-gate",
  "request-ready-interaction",
]);

const GOAL_BLOCKER_KINDS = new Set<string>([
  "blocked-node",
  "blocked-loop",
  "loop-dependants",
  "legacy-definition",
  "definition-no-path",
  "external-dependency",
  "terminal-policy",
]);

const WORKSPACE_LEASE_MODE_SET = new Set<string>(["exclusive", "shared"]);

const FAMILY_PENDING_STATUS_SET = new Set<string>(["selected", "dispatched"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Family scheduler candidate shape required for concurrent lift and selection.
 * Matches FamilyRunnableCandidate fields without importing family-scheduler
 * (avoids a circular module dependency).
 */
export interface FamilyConcurrentSourceCandidate extends ScheduledActionIdentity {
  action: GoalContinuationAction;
  selectedSequence: number;
  selectedSnapshotHash: string;
  memberContinuationOrdinal: number;
  memberDepth: number;
}

/**
 * Optional concurrent attributes for one family candidate.
 * Keys are stable concurrent attempt identities from buildFamilyConcurrentAttemptId.
 */
export interface FamilyConcurrentCandidateAttributes {
  executorKind?: ExecutorKind;
  groupIds?: string[];
  /**
   * Optional proposed workspace lease for this candidate.
   * When present, the lease must be compatible with the active lease set and
   * with leases virtually acquired by earlier batch members.
   * The lease holder must match the candidate identity.
   */
  lease?: WorkspaceLease;
}

/**
 * One concurrent family selection candidate with stable attempt identity.
 */
export interface FamilyConcurrentCandidate extends FamilyConcurrentSourceCandidate {
  attemptId: string;
  executorKind: ExecutorKind;
  groupIds: string[];
  lease?: WorkspaceLease;
}

/**
 * Inputs for pure concurrent family batch selection when candidates are already
 * enumerated by the family scheduler surface.
 */
export interface FamilyConcurrentBatchInput {
  family: GoalFamilyRuntime;
  /**
   * Candidates already enumerated (preferred or runnable).
   * The family scheduler builds this list. Concurrent selection does not
   * re-enumerate member states.
   */
  candidates: readonly FamilyConcurrentSourceCandidate[];
  /**
   * Optional attributes keyed by concurrent attempt id.
   * Absent keys use isolated-pi, empty groups, and no lease.
   */
  attributesByAttemptId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  /**
   * Optional attributes keyed by goal id.
   * Applied when attributesByAttemptId has no entry for the candidate.
   */
  attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  /** Optional concurrency limits. Default global concurrency is two. */
  concurrencyLimits?: unknown;
  /** Optional concurrency group registry. */
  groupRegistry?: unknown;
  /** Active global concurrency occupancy. Defaults to empty. */
  concurrencyState?: ConcurrencyState;
  /** Active group occupancy. Defaults to empty. */
  groupState?: ConcurrencyGroupState;
  /** Active workspace lease set. Defaults to empty. */
  leaseSet?: WorkspaceLeaseSet;
  /**
   * Event-backed fairness ordinal for round-robin across fairness keys.
   * Default is 0. Must be a non-negative safe integer when present.
   */
  fairnessOrdinal?: number;
  /**
   * Maximum selections in this batch.
   * Default is the resolved global concurrency limit.
   * Must be a non-negative safe integer when present.
   */
  maxBatchSize?: number;
  /**
   * When true (default), family.pendingDispatch occupies capacity and its
   * selection identity is excluded from re-selection.
   */
  treatPendingAsOccupancy?: boolean;
}

export type FamilyConcurrentDecision =
  | {
    kind: "select-batch";
    candidates: FamilyConcurrentCandidate[];
    reason: string;
    /**
     * Fairness ordinal after one advance per selected candidate.
     * Callers may record this for event-backed fairness.
     */
    fairnessOrdinal: number;
    /**
     * Virtual occupancy after the selected batch.
     * Not written to the goal family in this slice.
     */
    occupancy: FamilyConcurrentOccupancy;
  }
  | {
    kind: "idle";
    reason: string;
    fairnessOrdinal: number;
    occupancy: FamilyConcurrentOccupancy;
  }
  | {
    kind: "rejected";
    reason: string;
    diagnostics: Diagnostic[];
  };

/**
 * Pure occupancy snapshot used during concurrent selection.
 * schemaVersion is required so restore paths can reject unsupported shapes later.
 */
export interface FamilyConcurrentOccupancy {
  schemaVersion: typeof FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION;
  concurrencyState: ConcurrencyState;
  groupState: ConcurrencyGroupState;
  leaseSet: WorkspaceLeaseSet;
  /**
   * Attempt ids treated as family-level occupancy (pending sequential dispatch
   * and selected concurrent batch members).
   */
  occupiedAttemptIds: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
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

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

/**
 * Locale-insensitive identity order for strings.
 */
const compareIdentity = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

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
        "family_concurrent_invalid_accessor",
        `Unable to inspect property '${key}'.`,
        location,
      ),
    };
  }
  if (descriptor === undefined) {
    return { ok: true, present: false };
  }
  if ("get" in descriptor || "set" in descriptor || !("value" in descriptor)) {
    return {
      ok: false,
      diagnostic: reject(
        "family_concurrent_invalid_accessor",
        `Property '${key}' must be a data property. Accessor properties are not allowed.`,
        location,
      ),
    };
  }
  return { ok: true, present: true, value: descriptor.value };
}

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
        "family_concurrent_invalid_accessor",
        "Unable to enumerate own properties.",
        location,
      ),
    };
  }
}

function readArrayElement(
  array: unknown[],
  index: number,
  location: string,
): OwnDataPropertyRead {
  return readOwnDataProperty(array, String(index), location);
}

/**
 * Read family.schemaVersion through an own data property only.
 * Rejects accessors and unsupported schema versions.
 */
function assertFamilySchemaFromObject(
  familyObject: object,
  location = "family.schemaVersion",
): Diagnostic[] | undefined {
  const schemaRead = readOwnDataProperty(familyObject, "schemaVersion", location);
  if (!schemaRead.ok) {
    return [schemaRead.diagnostic];
  }
  if (!schemaRead.present || schemaRead.value !== GOAL_FAMILY_SCHEMA_VERSION) {
    const reported = schemaRead.present
      ? formatUntrustedDiagnosticValue(schemaRead.value)
      : "undefined";
    return [{
      code: "unsupported_goal_family_schema",
      message:
        `Unsupported goal-family schema version '${reported}'. `
        + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
      location,
    }];
  }
  return undefined;
}

function assertFamilySchema(family: GoalFamilyRuntime): Diagnostic[] | undefined {
  return assertFamilySchemaFromObject(family as object, "family.schemaVersion");
}

/**
 * Parse a goal continuation action with own data-property reads only.
 * Returns clean action values. Does not mutate input.
 */
function parseContinuationActionOwnData(
  value: unknown,
  location: string,
):
  | { ok: true; action: GoalContinuationAction }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidate_action",
        "The continuation action must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const kindRead = readOwnDataProperty(record, "kind", `${location}.kind`);
  if (!kindRead.ok) {
    return { ok: false, diagnostics: [kindRead.diagnostic] };
  }
  if (!kindRead.present || !isNonEmptyString(kindRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidate_action",
        "The continuation action must include a non-empty kind.",
        `${location}.kind`,
      )],
    };
  }
  const kind = kindRead.value.trim();

  if (kind === "request-revision") {
    const blockerRead = readOwnDataProperty(record, "blocker", `${location}.blocker`);
    if (!blockerRead.ok) {
      return { ok: false, diagnostics: [blockerRead.diagnostic] };
    }
    if (!blockerRead.present || !isStrictPlainObject(blockerRead.value)) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_invalid_candidate_action",
          "A request-revision action requires a blocker plain object.",
          `${location}.blocker`,
        )],
      };
    }
    const blockerObject = blockerRead.value as object;
    const diagnostics: Diagnostic[] = [];

    const blockerKindRead = readOwnDataProperty(
      blockerObject,
      "kind",
      `${location}.blocker.kind`,
    );
    if (!blockerKindRead.ok) {
      return { ok: false, diagnostics: [blockerKindRead.diagnostic] };
    }
    let blockerKind: GoalBlockerKind | undefined;
    if (
      !blockerKindRead.present
      || typeof blockerKindRead.value !== "string"
      || !GOAL_BLOCKER_KINDS.has(blockerKindRead.value)
    ) {
      diagnostics.push(reject(
        "family_concurrent_invalid_candidate_action",
        "A request-revision action requires a known blocker kind.",
        `${location}.blocker.kind`,
      ));
    } else {
      blockerKind = blockerKindRead.value as GoalBlockerKind;
    }

    const requireBlockerString = (key: string): string | undefined => {
      const read = readOwnDataProperty(blockerObject, key, `${location}.blocker.${key}`);
      if (!read.ok) {
        diagnostics.push(read.diagnostic);
        return undefined;
      }
      if (!read.present || !isNonEmptyString(read.value)) {
        diagnostics.push(reject(
          "family_concurrent_invalid_candidate_action",
          `A request-revision action requires a non-empty blocker ${key}.`,
          `${location}.blocker.${key}`,
        ));
        return undefined;
      }
      return read.value.trim();
    };
    const requireBlockerNonNeg = (key: string): number | undefined => {
      const read = readOwnDataProperty(blockerObject, key, `${location}.blocker.${key}`);
      if (!read.ok) {
        diagnostics.push(read.diagnostic);
        return undefined;
      }
      if (!read.present || !isNonNegativeSafeInteger(read.value)) {
        diagnostics.push(reject(
          "family_concurrent_invalid_candidate_action",
          `A request-revision action requires a non-negative safe integer blocker ${key}.`,
          `${location}.blocker.${key}`,
        ));
        return undefined;
      }
      return read.value;
    };

    const blockerId = requireBlockerString("id");
    const blockerReason = requireBlockerString("reason");
    const sourceRevision = requireBlockerNonNeg("sourceRevision");
    const sourceSequence = requireBlockerNonNeg("sourceSequence");
    const sourceSnapshotHash = requireBlockerString("sourceSnapshotHash");

    if (
      diagnostics.length > 0
      || blockerKind === undefined
      || blockerId === undefined
      || blockerReason === undefined
      || sourceRevision === undefined
      || sourceSequence === undefined
      || sourceSnapshotHash === undefined
    ) {
      return { ok: false, diagnostics };
    }

    const blocker: GoalBlockerIdentity = {
      kind: blockerKind,
      id: blockerId,
      reason: blockerReason,
      sourceRevision,
      sourceSequence,
      sourceSnapshotHash,
    };
    return { ok: true, action: { kind: "request-revision", blocker } };
  }

  if (!GOAL_WORK_ACTION_KINDS.has(kind)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidate_action",
        `Unsupported continuation action kind '${kind}'.`,
        `${location}.kind`,
      )],
    };
  }

  const nodeRead = readOwnDataProperty(record, "nodeId", `${location}.nodeId`);
  if (!nodeRead.ok) {
    return { ok: false, diagnostics: [nodeRead.diagnostic] };
  }
  if (!nodeRead.present || !isNonEmptyString(nodeRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidate_action",
        `Continuation action kind '${kind}' requires a non-empty nodeId.`,
        `${location}.nodeId`,
      )],
    };
  }

  const action: GoalContinuationAction = {
    kind: kind as GoalWorkContinuationActionKind,
    nodeId: nodeRead.value.trim(),
  };

  const loopRead = readOwnDataProperty(record, "loopId", `${location}.loopId`);
  if (!loopRead.ok) {
    return { ok: false, diagnostics: [loopRead.diagnostic] };
  }
  if (loopRead.present) {
    if (!isNonEmptyString(loopRead.value)) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_invalid_candidate_action",
          "A continuation action loopId must be a non-empty string when present.",
          `${location}.loopId`,
        )],
      };
    }
    action.loopId = loopRead.value.trim();
  }

  return { ok: true, action };
}

/**
 * Parse a path list with own data-property element reads.
 */
function parseLeasePathListOwnData(
  value: unknown,
  location: string,
  maxPaths: number,
): { ok: true; value: string[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_invalid_path_list",
        "Lease path lists must be string arrays.",
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
        "workspace_lease_invalid_path_list",
        "Lease path list length must be a non-negative safe integer data property.",
        `${location}.length`,
      )],
    };
  }
  if (lengthRead.value > maxPaths) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_path_limit",
        `A lease path list must not exceed ${maxPaths} entries.`,
        location,
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const canonicals: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lengthRead.value; index += 1) {
    const itemLocation = `${location}[${index}]`;
    const elementRead = readArrayElement(raw, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present || typeof elementRead.value !== "string") {
      diagnostics.push(reject(
        "workspace_lease_invalid_path",
        `Path at index ${index} must be a string.`,
        itemLocation,
      ));
      continue;
    }
    const canonical = canonicalLeasePath(elementRead.value);
    if (canonical === undefined) {
      diagnostics.push(reject(
        "workspace_lease_invalid_path",
        `Path '${elementRead.value}' must be a non-empty workspace-relative path.`,
        itemLocation,
      ));
      continue;
    }
    if (seen.has(canonical)) {
      diagnostics.push(reject(
        "workspace_lease_duplicate_path",
        `Path '${elementRead.value}' duplicates a canonical path on this lease.`,
        itemLocation,
      ));
      continue;
    }
    seen.add(canonical);
    canonicals.push(canonical);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  canonicals.sort(compareIdentity);
  return { ok: true, value: canonicals };
}

/**
 * Parse a workspace lease with own data-property reads only.
 * Returns a clean lease. Does not mutate input.
 */
function parseWorkspaceLeaseOwnData(
  value: unknown,
  location: string,
): { ok: true; value: WorkspaceLease } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_not_plain_object",
        "Workspace lease must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];

  const leaseIdRead = readOwnDataProperty(record, "leaseId", `${location}.leaseId`);
  if (!leaseIdRead.ok) {
    return { ok: false, diagnostics: [leaseIdRead.diagnostic] };
  }
  let leaseId: string | undefined;
  if (!leaseIdRead.present || !isNonEmptyString(leaseIdRead.value)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_id",
      "leaseId must be a non-empty string.",
      `${location}.leaseId`,
    ));
  } else {
    leaseId = leaseIdRead.value.trim();
  }

  const modeRead = readOwnDataProperty(record, "mode", `${location}.mode`);
  if (!modeRead.ok) {
    return { ok: false, diagnostics: [modeRead.diagnostic] };
  }
  let mode: WorkspaceLeaseMode | undefined;
  if (
    !modeRead.present
    || typeof modeRead.value !== "string"
    || !WORKSPACE_LEASE_MODE_SET.has(modeRead.value)
  ) {
    diagnostics.push(reject(
      "workspace_lease_invalid_mode",
      "mode must be 'exclusive' or 'shared'.",
      `${location}.mode`,
    ));
  } else {
    mode = modeRead.value as WorkspaceLeaseMode;
  }

  let baseRevision: string | undefined;
  const baseRevisionRead = readOwnDataProperty(
    record,
    "baseRevision",
    `${location}.baseRevision`,
  );
  if (!baseRevisionRead.ok) {
    return { ok: false, diagnostics: [baseRevisionRead.diagnostic] };
  }
  if (baseRevisionRead.present) {
    if (!isNonEmptyString(baseRevisionRead.value)) {
      diagnostics.push(reject(
        "workspace_lease_invalid_base_revision",
        "baseRevision must be a non-empty string when present.",
        `${location}.baseRevision`,
      ));
    } else {
      baseRevision = baseRevisionRead.value.trim();
    }
  }

  const holderRead = readOwnDataProperty(record, "holder", `${location}.holder`);
  if (!holderRead.ok) {
    return { ok: false, diagnostics: [holderRead.diagnostic] };
  }
  let holder: WorkspaceLease["holder"] | undefined;
  if (!holderRead.present || !isStrictPlainObject(holderRead.value)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_holder",
      "Lease holder must be a plain object.",
      `${location}.holder`,
    ));
  } else {
    const holderObject = holderRead.value as object;
    const requireHolderString = (key: string): string | undefined => {
      const read = readOwnDataProperty(holderObject, key, `${location}.holder.${key}`);
      if (!read.ok) {
        diagnostics.push(read.diagnostic);
        return undefined;
      }
      if (!read.present || !isNonEmptyString(read.value)) {
        diagnostics.push(reject(
          "workspace_lease_invalid_holder",
          `holder.${key} must be a non-empty string.`,
          `${location}.holder.${key}`,
        ));
        return undefined;
      }
      return read.value.trim();
    };
    const revisionRead = readOwnDataProperty(
      holderObject,
      "revision",
      `${location}.holder.revision`,
    );
    if (!revisionRead.ok) {
      diagnostics.push(revisionRead.diagnostic);
    }
    let revision: number | undefined;
    if (
      !revisionRead.ok
      || !revisionRead.present
      || !isNonNegativeSafeInteger(revisionRead.value)
    ) {
      if (revisionRead.ok) {
        diagnostics.push(reject(
          "workspace_lease_invalid_holder",
          "holder.revision must be a non-negative safe integer.",
          `${location}.holder.revision`,
        ));
      }
    } else {
      revision = revisionRead.value;
    }

    const familyId = requireHolderString("familyId");
    const goalId = requireHolderString("goalId");
    const workflowId = requireHolderString("workflowId");
    const nodeId = requireHolderString("nodeId");
    const attemptId = requireHolderString("attemptId");
    if (
      familyId !== undefined
      && goalId !== undefined
      && workflowId !== undefined
      && revision !== undefined
      && nodeId !== undefined
      && attemptId !== undefined
    ) {
      holder = {
        familyId,
        goalId,
        workflowId,
        revision,
        nodeId,
        attemptId,
      };
    }
  }

  const pathsRead = readOwnDataProperty(record, "paths", `${location}.paths`);
  if (!pathsRead.ok) {
    return { ok: false, diagnostics: [pathsRead.diagnostic] };
  }
  let readPaths: string[] | undefined;
  let writePaths: string[] | undefined;
  if (!pathsRead.present || !isStrictPlainObject(pathsRead.value)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_paths_object",
      "paths must be a plain object with readPaths and writePaths.",
      `${location}.paths`,
    ));
  } else {
    const pathsObject = pathsRead.value as object;
    const readPathsRead = readOwnDataProperty(
      pathsObject,
      "readPaths",
      `${location}.paths.readPaths`,
    );
    if (!readPathsRead.ok) {
      diagnostics.push(readPathsRead.diagnostic);
    } else {
      const parsed = parseLeasePathListOwnData(
        readPathsRead.present ? readPathsRead.value : undefined,
        `${location}.paths.readPaths`,
        DEFAULT_MAX_LEASE_PATHS,
      );
      if (!parsed.ok) {
        diagnostics.push(...parsed.diagnostics);
      } else {
        readPaths = parsed.value;
      }
    }
    const writePathsRead = readOwnDataProperty(
      pathsObject,
      "writePaths",
      `${location}.paths.writePaths`,
    );
    if (!writePathsRead.ok) {
      diagnostics.push(writePathsRead.diagnostic);
    } else {
      const parsed = parseLeasePathListOwnData(
        writePathsRead.present ? writePathsRead.value : undefined,
        `${location}.paths.writePaths`,
        DEFAULT_MAX_LEASE_PATHS,
      );
      if (!parsed.ok) {
        diagnostics.push(...parsed.diagnostics);
      } else {
        writePaths = parsed.value;
      }
    }
  }

  if (
    mode === "exclusive"
    && writePaths !== undefined
    && writePaths.length === 0
  ) {
    diagnostics.push(reject(
      "workspace_lease_empty_write_scope",
      "An exclusive lease must declare at least one write path.",
      `${location}.paths.writePaths`,
    ));
  }
  if (mode === "shared" && writePaths !== undefined && writePaths.length > 0) {
    diagnostics.push(reject(
      "workspace_lease_shared_with_writes",
      "A shared lease must not declare write paths.",
      `${location}.paths.writePaths`,
    ));
  }
  if (mode === "shared" && readPaths !== undefined && readPaths.length === 0) {
    diagnostics.push(reject(
      "workspace_lease_empty_read_scope",
      "A shared lease must declare at least one read path.",
      `${location}.paths.readPaths`,
    ));
  }

  if (
    diagnostics.length > 0
    || leaseId === undefined
    || mode === undefined
    || holder === undefined
    || readPaths === undefined
    || writePaths === undefined
  ) {
    return { ok: false, diagnostics };
  }

  const lease: WorkspaceLease = {
    leaseId,
    mode,
    holder,
    paths: {
      readPaths,
      writePaths,
    },
  };
  if (baseRevision !== undefined) {
    lease.baseRevision = baseRevision;
  }
  return { ok: true, value: lease };
}

/**
 * True when two clean leases are fully equal on canonical fields.
 */
export function workspaceLeasesCanonicallyEqual(
  left: WorkspaceLease,
  right: WorkspaceLease,
): boolean {
  if (left.leaseId !== right.leaseId) return false;
  if (left.mode !== right.mode) return false;
  if ((left.baseRevision ?? "") !== (right.baseRevision ?? "")) return false;
  if (left.holder.familyId !== right.holder.familyId) return false;
  if (left.holder.goalId !== right.holder.goalId) return false;
  if (left.holder.workflowId !== right.holder.workflowId) return false;
  if (left.holder.revision !== right.holder.revision) return false;
  if (left.holder.nodeId !== right.holder.nodeId) return false;
  if (left.holder.attemptId !== right.holder.attemptId) return false;
  if (left.paths.readPaths.length !== right.paths.readPaths.length) return false;
  if (left.paths.writePaths.length !== right.paths.writePaths.length) return false;
  for (let index = 0; index < left.paths.readPaths.length; index += 1) {
    if (left.paths.readPaths[index] !== right.paths.readPaths[index]) return false;
  }
  for (let index = 0; index < left.paths.writePaths.length; index += 1) {
    if (left.paths.writePaths[index] !== right.paths.writePaths[index]) return false;
  }
  return true;
}

/**
 * Parse a complete lease set: schema, every lease, unique lease IDs, unique
 * holder attempt IDs. Uses own data-property reads. Returns a clean set only.
 */
export function parseFamilyConcurrentLeaseSet(
  value: unknown,
  location = "leaseSet",
): { ok: true; value: WorkspaceLeaseSet } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_set_not_plain_object",
        "Workspace lease set must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const schemaRead = readOwnDataProperty(record, "schemaVersion", `${location}.schemaVersion`);
  if (!schemaRead.ok) {
    return { ok: false, diagnostics: [schemaRead.diagnostic] };
  }
  if (!schemaRead.present || schemaRead.value !== WORKSPACE_LEASE_SET_SCHEMA_VERSION) {
    const reported = schemaRead.present
      ? formatUntrustedDiagnosticValue(schemaRead.value)
      : "undefined";
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_set_unsupported_schema",
        `Unsupported workspace lease set schema version '${reported}'. `
        + `Expected ${WORKSPACE_LEASE_SET_SCHEMA_VERSION}.`,
        `${location}.schemaVersion`,
      )],
    };
  }

  const leasesRead = readOwnDataProperty(record, "leases", `${location}.leases`);
  if (!leasesRead.ok) {
    return { ok: false, diagnostics: [leasesRead.diagnostic] };
  }
  if (!leasesRead.present || !Array.isArray(leasesRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_set_invalid_leases",
        "Workspace lease set leases must be an array.",
        `${location}.leases`,
      )],
    };
  }

  const rawLeases = leasesRead.value as unknown[];
  const lengthRead = readOwnDataProperty(
    rawLeases as object,
    "length",
    `${location}.leases.length`,
  );
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_set_invalid_leases",
        "Workspace lease set leases length must be a non-negative safe integer data property.",
        `${location}.leases.length`,
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const leases: WorkspaceLease[] = [];
  const seenLeaseIds = new Set<string>();
  const seenAttemptIds = new Set<string>();
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `${location}.leases[${index}]`;
    const elementRead = readArrayElement(rawLeases, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present) {
      diagnostics.push(reject(
        "workspace_lease_not_plain_object",
        "Workspace lease must be a plain object.",
        itemLocation,
      ));
      continue;
    }
    const parsed = parseWorkspaceLeaseOwnData(elementRead.value, itemLocation);
    if (!parsed.ok) {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (seenLeaseIds.has(parsed.value.leaseId)) {
      diagnostics.push(reject(
        "family_concurrent_lease_set_duplicate_lease_id",
        `Lease id '${parsed.value.leaseId}' appears more than once in the lease set.`,
        `${itemLocation}.leaseId`,
      ));
      continue;
    }
    if (seenAttemptIds.has(parsed.value.holder.attemptId)) {
      diagnostics.push(reject(
        "family_concurrent_lease_set_duplicate_attempt_id",
        `Holder attempt id '${parsed.value.holder.attemptId}' appears more than once in the lease set.`,
        `${itemLocation}.holder.attemptId`,
      ));
      continue;
    }
    seenLeaseIds.add(parsed.value.leaseId);
    seenAttemptIds.add(parsed.value.holder.attemptId);
    leases.push(parsed.value);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  leases.sort((left, right) => compareIdentity(left.leaseId, right.leaseId));
  return {
    ok: true,
    value: {
      schemaVersion: WORKSPACE_LEASE_SET_SCHEMA_VERSION,
      leases,
    },
  };
}

/**
 * Length-prefix one identity field so colons and separators cannot collide.
 * Format: decimal length, colon, field bytes as a JavaScript string.
 */
export function encodeFamilyConcurrentIdField(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * Build a stable concurrent attempt identity from selection fields.
 * Encoding is length-prefixed and includes the selected snapshot hash.
 * Same inputs always produce the same id. No clock or random values.
 */
export function buildFamilyConcurrentAttemptId(
  candidate: Pick<
    FamilyConcurrentSourceCandidate,
    | "familyId"
    | "goalId"
    | "workflowId"
    | "revision"
    | "selectedSequence"
    | "selectedSnapshotHash"
    | "memberContinuationOrdinal"
    | "action"
    | "nodeId"
    | "loopId"
  >,
): string {
  const actionKind = candidate.action.kind;
  const nodeId =
    candidate.nodeId
    ?? ("nodeId" in candidate.action ? candidate.action.nodeId : "");
  const loopId =
    candidate.loopId
    ?? ("loopId" in candidate.action && candidate.action.loopId !== undefined
      ? candidate.action.loopId
      : "");
  const parts = [
    candidate.familyId,
    candidate.goalId,
    candidate.workflowId,
    String(candidate.revision),
    String(candidate.selectedSequence),
    candidate.selectedSnapshotHash,
    String(candidate.memberContinuationOrdinal),
    actionKind,
    nodeId,
    loopId,
  ];
  return parts.map(encodeFamilyConcurrentIdField).join("|");
}

/**
 * Build the concurrent attempt id for a recorded family selection or pending dispatch.
 */
export function buildFamilyConcurrentAttemptIdFromSelection(
  selection: FamilySelectedAction,
): string {
  const fields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
    familyId: selection.familyId,
    goalId: selection.goalId,
    workflowId: selection.workflowId,
    revision: selection.revision,
    selectedSequence: selection.selectedSequence,
    selectedSnapshotHash: selection.selectedSnapshotHash,
    memberContinuationOrdinal: selection.memberContinuationOrdinal,
    action: selection.action,
  };
  if (selection.nodeId !== undefined) fields.nodeId = selection.nodeId;
  if (selection.loopId !== undefined) fields.loopId = selection.loopId;
  return buildFamilyConcurrentAttemptId(fields);
}

function copySourceCandidate(
  candidate: FamilyConcurrentSourceCandidate,
): FamilyConcurrentSourceCandidate {
  const copy: FamilyConcurrentSourceCandidate = {
    familyId: candidate.familyId,
    goalId: candidate.goalId,
    workflowId: candidate.workflowId,
    revision: candidate.revision,
    action: structuredClone(candidate.action),
    selectedSequence: candidate.selectedSequence,
    selectedSnapshotHash: candidate.selectedSnapshotHash,
    memberContinuationOrdinal: candidate.memberContinuationOrdinal,
    memberDepth: candidate.memberDepth,
  };
  if (candidate.nodeId !== undefined) copy.nodeId = candidate.nodeId;
  if (candidate.loopId !== undefined) copy.loopId = candidate.loopId;
  return copy;
}

function copyConcurrentCandidate(
  candidate: FamilyConcurrentCandidate,
): FamilyConcurrentCandidate {
  const base = copySourceCandidate(candidate);
  const copy: FamilyConcurrentCandidate = {
    ...base,
    attemptId: candidate.attemptId,
    executorKind: candidate.executorKind,
    groupIds: [...candidate.groupIds],
  };
  if (candidate.lease !== undefined) {
    copy.lease = structuredClone(candidate.lease);
  }
  return copy;
}

function copyOccupancy(occupancy: FamilyConcurrentOccupancy): FamilyConcurrentOccupancy {
  return {
    schemaVersion: FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
    concurrencyState: structuredClone(occupancy.concurrencyState),
    groupState: structuredClone(occupancy.groupState),
    leaseSet: structuredClone(occupancy.leaseSet),
    occupiedAttemptIds: [...occupancy.occupiedAttemptIds].sort(compareIdentity),
  };
}

/**
 * Validate an optional occupancy snapshot schema when callers restore later state.
 * Returns diagnostics only. Does not throw. Does not mutate input.
 */
export function validateFamilyConcurrentOccupancySchema(
  value: unknown,
  location = "familyConcurrentOccupancy",
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "family_concurrent_occupancy_not_plain_object",
      "Family concurrent occupancy must be a plain object.",
      location,
    )];
  }
  const schemaRead = readOwnDataProperty(value, "schemaVersion", `${location}.schemaVersion`);
  if (!schemaRead.ok) {
    return [schemaRead.diagnostic];
  }
  if (!schemaRead.present || schemaRead.value !== FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION) {
    const reportedVersion = schemaRead.present
      ? formatUntrustedDiagnosticValue(schemaRead.value)
      : "undefined";
    return [reject(
      "family_concurrent_occupancy_unsupported_schema",
      `Unsupported family concurrent occupancy schema version '${reportedVersion}'. `
      + `Expected ${FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    )];
  }
  return [];
}

function candidateNodeId(candidate: {
  nodeId?: string;
  action: GoalContinuationAction;
}): string {
  if (candidate.nodeId !== undefined) return candidate.nodeId;
  if ("nodeId" in candidate.action) return candidate.action.nodeId;
  return "";
}

/**
 * Require the proposed lease holder to match the concurrent candidate identity.
 * Returns distinct diagnostics for each mismatched field.
 */
export function validateLeaseHolderMatchesCandidate(
  lease: WorkspaceLease,
  candidate: Pick<
    FamilyConcurrentCandidate,
    "attemptId" | "familyId" | "goalId" | "workflowId" | "revision" | "nodeId" | "action"
  >,
  location = "lease.holder",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const holder = lease.holder;
  const expectedNodeId = candidateNodeId(candidate);

  if (holder.attemptId !== candidate.attemptId) {
    diagnostics.push(reject(
      "family_concurrent_lease_attempt_id_mismatch",
      `Lease holder attemptId '${holder.attemptId}' must equal candidate attemptId `
      + `'${candidate.attemptId}'.`,
      `${location}.attemptId`,
    ));
  }
  if (holder.familyId !== candidate.familyId) {
    diagnostics.push(reject(
      "family_concurrent_lease_family_id_mismatch",
      `Lease holder familyId '${holder.familyId}' must equal candidate familyId `
      + `'${candidate.familyId}'.`,
      `${location}.familyId`,
    ));
  }
  if (holder.goalId !== candidate.goalId) {
    diagnostics.push(reject(
      "family_concurrent_lease_goal_id_mismatch",
      `Lease holder goalId '${holder.goalId}' must equal candidate goalId `
      + `'${candidate.goalId}'.`,
      `${location}.goalId`,
    ));
  }
  if (holder.workflowId !== candidate.workflowId) {
    diagnostics.push(reject(
      "family_concurrent_lease_workflow_id_mismatch",
      `Lease holder workflowId '${holder.workflowId}' must equal candidate workflowId `
      + `'${candidate.workflowId}'.`,
      `${location}.workflowId`,
    ));
  }
  if (holder.revision !== candidate.revision) {
    diagnostics.push(reject(
      "family_concurrent_lease_revision_mismatch",
      `Lease holder revision '${holder.revision}' must equal candidate revision `
      + `'${candidate.revision}'.`,
      `${location}.revision`,
    ));
  }
  if (holder.nodeId !== expectedNodeId) {
    diagnostics.push(reject(
      "family_concurrent_lease_node_id_mismatch",
      `Lease holder nodeId '${holder.nodeId}' must equal candidate nodeId `
      + `'${expectedNodeId}'.`,
      `${location}.nodeId`,
    ));
  }
  return diagnostics;
}

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
        "family_concurrent_invalid_group_ids",
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
        "family_concurrent_invalid_group_ids",
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
        "family_concurrent_invalid_group_id",
        "Each group id must be a non-empty string.",
        itemLocation,
      ));
      continue;
    }
    const groupId = elementRead.value.trim();
    if (seen.has(groupId)) {
      diagnostics.push(reject(
        "family_concurrent_duplicate_group_id",
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
  return { ok: true, value: groupIds.sort(compareIdentity) };
}

function extractAttributesRecord(
  value: unknown,
  location: string,
):
  | { ok: true; value: FamilyConcurrentCandidateAttributes }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_attributes_not_plain_object",
        "Concurrent candidate attributes must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];
  const attributes: FamilyConcurrentCandidateAttributes = {};

  const kindRead = readOwnDataProperty(record, "executorKind", `${location}.executorKind`);
  if (!kindRead.ok) {
    return { ok: false, diagnostics: [kindRead.diagnostic] };
  }
  if (kindRead.present) {
    if (typeof kindRead.value !== "string" || !EXECUTOR_KINDS.has(kindRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_invalid_executor_kind",
        "executorKind must be a known executor kind when present.",
        `${location}.executorKind`,
      ));
    } else {
      attributes.executorKind = kindRead.value as ExecutorKind;
    }
  }

  const groupsRead = readOwnDataProperty(record, "groupIds", `${location}.groupIds`);
  if (!groupsRead.ok) {
    return { ok: false, diagnostics: [groupsRead.diagnostic] };
  }
  if (groupsRead.present) {
    const groups = extractGroupIds(groupsRead.value, `${location}.groupIds`);
    if (!groups.ok) {
      diagnostics.push(...groups.diagnostics);
    } else {
      attributes.groupIds = groups.value;
    }
  }

  const leaseRead = readOwnDataProperty(record, "lease", `${location}.lease`);
  if (!leaseRead.ok) {
    return { ok: false, diagnostics: [leaseRead.diagnostic] };
  }
  if (leaseRead.present && leaseRead.value !== undefined) {
    const parsedLease = parseWorkspaceLeaseOwnData(leaseRead.value, `${location}.lease`);
    if (!parsedLease.ok) {
      diagnostics.push(...parsedLease.diagnostics);
    } else {
      attributes.lease = parsedLease.value;
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: attributes };
}

function parseAttributesMap(
  value: unknown,
  location: string,
):
  | { ok: true; value: Readonly<Record<string, FamilyConcurrentCandidateAttributes>> }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_attributes_map_not_plain_object",
        "Concurrent attribute maps must be plain objects when present.",
        location,
      )],
    };
  }

  const keysResult = readOwnEnumerableKeys(value, location);
  if (!keysResult.ok) {
    return { ok: false, diagnostics: [keysResult.diagnostic] };
  }

  const map: Record<string, FamilyConcurrentCandidateAttributes> = {};
  const diagnostics: Diagnostic[] = [];

  for (const key of keysResult.keys) {
    const itemLocation = `${location}[${JSON.stringify(key)}]`;
    const entryRead = readOwnDataProperty(value, key, itemLocation);
    if (!entryRead.ok) {
      diagnostics.push(entryRead.diagnostic);
      continue;
    }
    if (!entryRead.present) {
      continue;
    }
    const extracted = extractAttributesRecord(entryRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    map[key] = extracted.value;
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: map };
}

function resolveCleanAttributes(
  attemptId: string,
  goalId: string,
  attributesByAttemptId: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>,
  attributesByGoalId: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>,
): FamilyConcurrentCandidateAttributes {
  if (Object.prototype.hasOwnProperty.call(attributesByAttemptId, attemptId)) {
    return attributesByAttemptId[attemptId]!;
  }
  if (Object.prototype.hasOwnProperty.call(attributesByGoalId, goalId)) {
    return attributesByGoalId[goalId]!;
  }
  return {};
}

function extractSourceCandidate(
  value: unknown,
  location: string,
):
  | { ok: true; value: FamilyConcurrentSourceCandidate }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_candidate_not_plain_object",
        "Each family concurrent candidate must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];

  const requireString = (
    key: string,
  ): string | undefined => {
    const read = readOwnDataProperty(record, key, `${location}.${key}`);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      return undefined;
    }
    if (!read.present || !isNonEmptyString(read.value)) {
      diagnostics.push(reject(
        "family_concurrent_invalid_candidate_field",
        `${key} must be a non-empty string.`,
        `${location}.${key}`,
      ));
      return undefined;
    }
    return read.value.trim();
  };

  const requireNonNegInt = (
    key: string,
  ): number | undefined => {
    const read = readOwnDataProperty(record, key, `${location}.${key}`);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      return undefined;
    }
    if (!read.present || !isNonNegativeSafeInteger(read.value)) {
      diagnostics.push(reject(
        "family_concurrent_invalid_candidate_field",
        `${key} must be a non-negative safe integer.`,
        `${location}.${key}`,
      ));
      return undefined;
    }
    return read.value;
  };

  const familyId = requireString("familyId");
  const goalId = requireString("goalId");
  const workflowId = requireString("workflowId");
  const revision = requireNonNegInt("revision");
  const selectedSequence = requireNonNegInt("selectedSequence");
  const selectedSnapshotHash = requireString("selectedSnapshotHash");
  const memberContinuationOrdinal = requireNonNegInt("memberContinuationOrdinal");
  const memberDepth = requireNonNegInt("memberDepth");

  const actionRead = readOwnDataProperty(record, "action", `${location}.action`);
  if (!actionRead.ok) {
    diagnostics.push(actionRead.diagnostic);
  }
  let action: GoalContinuationAction | undefined;
  if (!actionRead.ok) {
    // already recorded
  } else if (!actionRead.present) {
    diagnostics.push(reject(
      "family_concurrent_invalid_candidate_action",
      "action is required.",
      `${location}.action`,
    ));
  } else {
    const parsedAction = parseContinuationActionOwnData(actionRead.value, `${location}.action`);
    if (!parsedAction.ok) {
      diagnostics.push(...parsedAction.diagnostics);
    } else {
      action = parsedAction.action;
    }
  }

  let topLevelNodeId: string | undefined;
  let topLevelNodePresent = false;
  const nodeRead = readOwnDataProperty(record, "nodeId", `${location}.nodeId`);
  if (!nodeRead.ok) {
    diagnostics.push(nodeRead.diagnostic);
  } else if (nodeRead.present) {
    topLevelNodePresent = true;
    if (!isNonEmptyString(nodeRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_invalid_candidate_field",
        "nodeId must be a non-empty string when present.",
        `${location}.nodeId`,
      ));
    } else {
      topLevelNodeId = nodeRead.value.trim();
    }
  }

  let topLevelLoopId: string | undefined;
  let topLevelLoopPresent = false;
  const loopRead = readOwnDataProperty(record, "loopId", `${location}.loopId`);
  if (!loopRead.ok) {
    diagnostics.push(loopRead.diagnostic);
  } else if (loopRead.present) {
    topLevelLoopPresent = true;
    if (!isNonEmptyString(loopRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_invalid_candidate_field",
        "loopId must be a non-empty string when present.",
        `${location}.loopId`,
      ));
    } else {
      topLevelLoopId = loopRead.value.trim();
    }
  }

  // Align top-level node/loop identities with the action payload.
  let nodeId: string | undefined;
  let loopId: string | undefined;
  if (action !== undefined) {
    if (action.kind === "request-revision") {
      if (topLevelNodePresent) {
        diagnostics.push(reject(
          "family_concurrent_node_id_not_allowed_for_revision",
          "A request-revision candidate must not declare a top-level nodeId.",
          `${location}.nodeId`,
        ));
      }
      if (topLevelLoopPresent) {
        diagnostics.push(reject(
          "family_concurrent_loop_id_not_allowed_for_revision",
          "A request-revision candidate must not declare a top-level loopId.",
          `${location}.loopId`,
        ));
      }
    } else {
      const actionNodeId = action.nodeId;
      const actionLoopId = "loopId" in action ? action.loopId : undefined;
      if (topLevelNodeId !== undefined && topLevelNodeId !== actionNodeId) {
        diagnostics.push(reject(
          "family_concurrent_node_id_mismatch",
          `Top-level nodeId '${topLevelNodeId}' must equal action nodeId '${actionNodeId}'.`,
          `${location}.nodeId`,
        ));
      }
      if (topLevelLoopPresent) {
        if (actionLoopId === undefined) {
          diagnostics.push(reject(
            "family_concurrent_loop_id_mismatch",
            "Top-level loopId is present but the action does not declare a loopId.",
            `${location}.loopId`,
          ));
        } else if (topLevelLoopId !== actionLoopId) {
          diagnostics.push(reject(
            "family_concurrent_loop_id_mismatch",
            `Top-level loopId '${topLevelLoopId}' must equal action loopId '${actionLoopId}'.`,
            `${location}.loopId`,
          ));
        }
      }
      // Derive identity fields from the action when they match or are omitted.
      if (diagnostics.every((item) =>
        item.code !== "family_concurrent_node_id_mismatch"
        && item.code !== "family_concurrent_loop_id_mismatch"
      )) {
        nodeId = actionNodeId;
        if (actionLoopId !== undefined) {
          loopId = actionLoopId;
        }
      }
    }
  }

  if (
    diagnostics.length > 0
    || familyId === undefined
    || goalId === undefined
    || workflowId === undefined
    || revision === undefined
    || selectedSequence === undefined
    || selectedSnapshotHash === undefined
    || memberContinuationOrdinal === undefined
    || memberDepth === undefined
    || action === undefined
  ) {
    return { ok: false, diagnostics };
  }

  const candidate: FamilyConcurrentSourceCandidate = {
    familyId,
    goalId,
    workflowId,
    revision,
    action,
    selectedSequence,
    selectedSnapshotHash,
    memberContinuationOrdinal,
    memberDepth,
  };
  if (nodeId !== undefined) candidate.nodeId = nodeId;
  if (loopId !== undefined) candidate.loopId = loopId;
  return { ok: true, value: candidate };
}

/**
 * Lift family source candidates into concurrent candidates with stable identities.
 * Parses untrusted candidates and attribute maps as strict plain objects with
 * own data properties only. Does not mutate inputs. Returns clean copies only.
 */
export function liftFamilyConcurrentCandidates(
  candidates: unknown,
  options?: {
    attributesByAttemptId?: unknown;
    attributesByGoalId?: unknown;
  },
):
  | { ok: true; candidates: FamilyConcurrentCandidate[] }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidates",
        "Family concurrent candidates must be an array.",
        "candidates",
      )],
    };
  }

  const rawCandidates = candidates as unknown[];
  const lengthRead = readOwnDataProperty(
    rawCandidates as object,
    "length",
    "candidates.length",
  );
  if (!lengthRead.ok) {
    return { ok: false, diagnostics: [lengthRead.diagnostic] };
  }
  if (!lengthRead.present || !isNonNegativeSafeInteger(lengthRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_invalid_candidates",
        "Family concurrent candidates length must be a non-negative safe integer data property.",
        "candidates.length",
      )],
    };
  }

  const attributesByAttemptIdResult = parseAttributesMap(
    options?.attributesByAttemptId,
    "attributesByAttemptId",
  );
  if (!attributesByAttemptIdResult.ok) {
    return attributesByAttemptIdResult;
  }
  const attributesByGoalIdResult = parseAttributesMap(
    options?.attributesByGoalId,
    "attributesByGoalId",
  );
  if (!attributesByGoalIdResult.ok) {
    return attributesByGoalIdResult;
  }

  const diagnostics: Diagnostic[] = [];
  const lifted: FamilyConcurrentCandidate[] = [];
  const seenAttemptIds = new Set<string>();
  const length = lengthRead.value;

  for (let index = 0; index < length; index += 1) {
    const itemLocation = `candidates[${index}]`;
    const elementRead = readArrayElement(rawCandidates, index, itemLocation);
    if (!elementRead.ok) {
      diagnostics.push(elementRead.diagnostic);
      continue;
    }
    if (!elementRead.present) {
      diagnostics.push(reject(
        "family_concurrent_candidate_not_plain_object",
        "Each family concurrent candidate must be a plain object.",
        itemLocation,
      ));
      continue;
    }

    const extracted = extractSourceCandidate(elementRead.value, itemLocation);
    if (!extracted.ok) {
      diagnostics.push(...extracted.diagnostics);
      continue;
    }
    const candidate = extracted.value;
    const attemptId = buildFamilyConcurrentAttemptId(candidate);
    if (seenAttemptIds.has(attemptId)) {
      diagnostics.push(reject(
        "family_concurrent_duplicate_attempt_id",
        `Concurrent attempt id appears more than once in the candidate list.`,
        itemLocation,
      ));
      continue;
    }
    seenAttemptIds.add(attemptId);

    const attributes = resolveCleanAttributes(
      attemptId,
      candidate.goalId,
      attributesByAttemptIdResult.value,
      attributesByGoalIdResult.value,
    );

    const executorKind = attributes.executorKind ?? DEFAULT_FAMILY_CONCURRENT_EXECUTOR_KIND;
    const groupIds = attributes.groupIds !== undefined
      ? [...attributes.groupIds]
      : [];

    const concurrent: FamilyConcurrentCandidate = {
      ...copySourceCandidate(candidate),
      attemptId,
      executorKind,
      groupIds,
    };
    if (attributes.lease !== undefined) {
      concurrent.lease = structuredClone(attributes.lease);
    }
    lifted.push(concurrent);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, candidates: lifted };
}

function selectionIdentityKey(selection: {
  goalId: string;
  workflowId: string;
  revision: number;
  selectedSequence: number;
  selectedSnapshotHash: string;
  memberContinuationOrdinal: number;
  action: GoalContinuationAction;
  nodeId?: string;
  loopId?: string;
}): string {
  const fields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
    familyId: "identity",
    goalId: selection.goalId,
    workflowId: selection.workflowId,
    revision: selection.revision,
    selectedSequence: selection.selectedSequence,
    selectedSnapshotHash: selection.selectedSnapshotHash,
    memberContinuationOrdinal: selection.memberContinuationOrdinal,
    action: selection.action,
  };
  if (selection.nodeId !== undefined) fields.nodeId = selection.nodeId;
  if (selection.loopId !== undefined) fields.loopId = selection.loopId;
  return buildFamilyConcurrentAttemptId(fields);
}

function pendingOccupiesCandidate(
  pending: FamilyPendingDispatch,
  candidate: FamilyConcurrentCandidate,
): boolean {
  const pendingKey = selectionIdentityKey(pending.selection);
  const candidateKey = selectionIdentityKey(candidate);
  if (pendingKey === candidateKey) return true;
  // One sequential pending dispatch occupies the whole goal for concurrent policy.
  return pending.selection.goalId === candidate.goalId;
}

/**
 * Filter concurrent candidates against sequential pending occupancy.
 * Does not mutate inputs.
 */
export function excludePendingFamilyConcurrentCandidates(
  candidates: readonly FamilyConcurrentCandidate[],
  pending: FamilyPendingDispatch | undefined,
): {
  candidates: FamilyConcurrentCandidate[];
  pendingAttemptId?: string;
} {
  if (!pending) {
    return {
      candidates: candidates.map(copyConcurrentCandidate),
    };
  }
  const pendingAttemptId = buildFamilyConcurrentAttemptIdFromSelection(pending.selection);
  return {
    candidates: candidates
      .filter((candidate) => !pendingOccupiesCandidate(pending, candidate))
      .map(copyConcurrentCandidate),
    pendingAttemptId,
  };
}

type SeedOccupancyResult =
  | {
    ok: true;
    concurrencyState: ConcurrencyState;
    groupState: ConcurrencyGroupState;
    leaseSet: WorkspaceLeaseSet;
    occupiedAttemptIds: string[];
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * True when two sorted group id lists are equal by identity order.
 */
function groupIdSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Parse concurrency occupancy into a clean state.
 * Uses listConcurrencyActiveAttempts so untrusted getters cannot survive validation.
 * Does not structuredClone the original input.
 */
function parseCleanConcurrencyState(
  value: unknown,
  location = "concurrencyState",
): { ok: true; value: ConcurrencyState } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return { ok: true, value: createEmptyConcurrencyState() };
  }
  const listed = listConcurrencyActiveAttempts(value as ConcurrencyState);
  if (!listed.ok) {
    // Rewrite locations when the helper used a fixed prefix.
    return {
      ok: false,
      diagnostics: listed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        location: diagnostic.location === "concurrencyState"
          || diagnostic.location?.startsWith("concurrencyState.")
          ? diagnostic.location.replace(/^concurrencyState/, location)
          : diagnostic.location ?? location,
      })),
    };
  }
  // Re-sort with locale-independent identity order. The list helper may use
  // locale-dependent comparison for attempt ids.
  return {
    ok: true,
    value: sortConcurrencyStateByIdentity({
      schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
      attempts: listed.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        executorKind: attempt.executorKind,
        ...(attempt.profileId !== undefined ? { profileId: attempt.profileId } : {}),
      })),
    }),
  };
}

/**
 * Sort concurrency attempts with locale-independent identity order.
 * admitAttempt sorts with localeCompare. Call this after every admit and before
 * any occupancy return so returned occupancy stays deterministic.
 */
function sortConcurrencyStateByIdentity(state: ConcurrencyState): ConcurrencyState {
  return {
    schemaVersion: state.schemaVersion,
    attempts: [...state.attempts]
      .map((attempt) => ({
        attemptId: attempt.attemptId,
        executorKind: attempt.executorKind,
        ...(attempt.profileId !== undefined ? { profileId: attempt.profileId } : {}),
      }))
      .sort((left, right) => compareIdentity(left.attemptId, right.attemptId)),
  };
}

/**
 * Parse group occupancy into a clean state.
 * Uses listConcurrencyGroupActiveAttempts so untrusted getters cannot survive validation.
 * Does not structuredClone the original input.
 */
function parseCleanGroupState(
  value: unknown,
  location = "concurrencyGroupState",
): { ok: true; value: ConcurrencyGroupState } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return { ok: true, value: createEmptyConcurrencyGroupState() };
  }
  const listed = listConcurrencyGroupActiveAttempts(value as ConcurrencyGroupState);
  if (!listed.ok) {
    return {
      ok: false,
      diagnostics: listed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        location: diagnostic.location === "concurrencyGroupState"
          || diagnostic.location?.startsWith("concurrencyGroupState.")
          ? diagnostic.location.replace(/^concurrencyGroupState/, location)
          : diagnostic.location ?? location,
      })),
    };
  }
  return {
    ok: true,
    value: {
      schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
      attempts: listed.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        groupIds: [...attempt.groupIds],
      })),
    },
  };
}

/**
 * Parse a family selected action with own data-property reads only.
 */
function parseFamilySelectedActionOwnData(
  value: unknown,
  location: string,
):
  | { ok: true; value: FamilySelectedAction }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_selection_not_plain_object",
        "Family pending selection must be a plain object.",
        location,
      )],
    };
  }

  const record = value as object;
  const diagnostics: Diagnostic[] = [];

  const requireString = (key: string): string | undefined => {
    const read = readOwnDataProperty(record, key, `${location}.${key}`);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      return undefined;
    }
    if (!read.present || !isNonEmptyString(read.value)) {
      diagnostics.push(reject(
        "family_concurrent_pending_invalid_selection_field",
        `${key} must be a non-empty string.`,
        `${location}.${key}`,
      ));
      return undefined;
    }
    return read.value.trim();
  };

  const requireNonNegInt = (key: string): number | undefined => {
    const read = readOwnDataProperty(record, key, `${location}.${key}`);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      return undefined;
    }
    if (!read.present || !isNonNegativeSafeInteger(read.value)) {
      diagnostics.push(reject(
        "family_concurrent_pending_invalid_selection_field",
        `${key} must be a non-negative safe integer.`,
        `${location}.${key}`,
      ));
      return undefined;
    }
    return read.value;
  };

  const familyId = requireString("familyId");
  const goalId = requireString("goalId");
  const workflowId = requireString("workflowId");
  const revision = requireNonNegInt("revision");
  const reason = requireString("reason");
  const selectedSequence = requireNonNegInt("selectedSequence");
  const selectedSnapshotHash = requireString("selectedSnapshotHash");
  const memberContinuationOrdinal = requireNonNegInt("memberContinuationOrdinal");

  const actionRead = readOwnDataProperty(record, "action", `${location}.action`);
  if (!actionRead.ok) {
    diagnostics.push(actionRead.diagnostic);
  }
  let action: GoalContinuationAction | undefined;
  if (!actionRead.ok) {
    // already recorded
  } else if (!actionRead.present) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_selection_field",
      "action is required.",
      `${location}.action`,
    ));
  } else {
    const parsedAction = parseContinuationActionOwnData(actionRead.value, `${location}.action`);
    if (!parsedAction.ok) {
      diagnostics.push(...parsedAction.diagnostics);
    } else {
      action = parsedAction.action;
    }
  }

  let nodeId: string | undefined;
  const nodeRead = readOwnDataProperty(record, "nodeId", `${location}.nodeId`);
  if (!nodeRead.ok) {
    diagnostics.push(nodeRead.diagnostic);
  } else if (nodeRead.present) {
    if (!isNonEmptyString(nodeRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_pending_invalid_selection_field",
        "nodeId must be a non-empty string when present.",
        `${location}.nodeId`,
      ));
    } else {
      nodeId = nodeRead.value.trim();
    }
  }

  let loopId: string | undefined;
  const loopRead = readOwnDataProperty(record, "loopId", `${location}.loopId`);
  if (!loopRead.ok) {
    diagnostics.push(loopRead.diagnostic);
  } else if (loopRead.present) {
    if (!isNonEmptyString(loopRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_pending_invalid_selection_field",
        "loopId must be a non-empty string when present.",
        `${location}.loopId`,
      ));
    } else {
      loopId = loopRead.value.trim();
    }
  }

  if (
    diagnostics.length > 0
    || familyId === undefined
    || goalId === undefined
    || workflowId === undefined
    || revision === undefined
    || reason === undefined
    || selectedSequence === undefined
    || selectedSnapshotHash === undefined
    || memberContinuationOrdinal === undefined
    || action === undefined
  ) {
    return { ok: false, diagnostics };
  }

  // Align node/loop with action the same way candidate lift does.
  if (action.kind === "request-revision") {
    if (nodeId !== undefined) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_node_id_not_allowed_for_revision",
          "A request-revision selection must not declare a top-level nodeId.",
          `${location}.nodeId`,
        )],
      };
    }
    if (loopId !== undefined) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_loop_id_not_allowed_for_revision",
          "A request-revision selection must not declare a top-level loopId.",
          `${location}.loopId`,
        )],
      };
    }
  } else {
    if (nodeId !== undefined && nodeId !== action.nodeId) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_node_id_mismatch",
          `Top-level nodeId '${nodeId}' must equal action nodeId '${action.nodeId}'.`,
          `${location}.nodeId`,
        )],
      };
    }
    nodeId = action.nodeId;
    const actionLoopId = action.loopId;
    if (loopId !== undefined) {
      if (actionLoopId === undefined || loopId !== actionLoopId) {
        return {
          ok: false,
          diagnostics: [reject(
            "family_concurrent_loop_id_mismatch",
            "Top-level loopId must equal the action loopId when present.",
            `${location}.loopId`,
          )],
        };
      }
    }
    if (actionLoopId !== undefined) {
      loopId = actionLoopId;
    } else {
      loopId = undefined;
    }
  }

  const selection: FamilySelectedAction = {
    familyId,
    goalId,
    workflowId,
    revision,
    action,
    reason,
    selectedSequence,
    selectedSnapshotHash,
    memberContinuationOrdinal,
  };
  if (nodeId !== undefined) selection.nodeId = nodeId;
  if (loopId !== undefined) selection.loopId = loopId;
  return { ok: true, value: selection };
}

/**
 * Parse family.pendingDispatch with own data-property reads only.
 * Absent pendingDispatch yields undefined. Invalid structure returns diagnostics.
 */
export function parseFamilyPendingDispatchOwnData(
  familyObject: object,
  location = "family.pendingDispatch",
):
  | { ok: true; value: FamilyPendingDispatch | undefined }
  | { ok: false; diagnostics: Diagnostic[] } {
  const pendingRead = readOwnDataProperty(familyObject, "pendingDispatch", location);
  if (!pendingRead.ok) {
    return { ok: false, diagnostics: [pendingRead.diagnostic] };
  }
  if (!pendingRead.present || pendingRead.value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isStrictPlainObject(pendingRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_not_plain_object",
        "family.pendingDispatch must be a plain object when present.",
        location,
      )],
    };
  }

  const record = pendingRead.value as object;
  const diagnostics: Diagnostic[] = [];

  const dispatchIdRead = readOwnDataProperty(record, "dispatchId", `${location}.dispatchId`);
  if (!dispatchIdRead.ok) {
    return { ok: false, diagnostics: [dispatchIdRead.diagnostic] };
  }
  let dispatchId: string | undefined;
  if (!dispatchIdRead.present || !isNonEmptyString(dispatchIdRead.value)) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_field",
      "dispatchId must be a non-empty string.",
      `${location}.dispatchId`,
    ));
  } else {
    dispatchId = dispatchIdRead.value.trim();
  }

  const statusRead = readOwnDataProperty(record, "status", `${location}.status`);
  if (!statusRead.ok) {
    return { ok: false, diagnostics: [statusRead.diagnostic] };
  }
  let status: FamilyDispatchPendingStatus | undefined;
  if (
    !statusRead.present
    || typeof statusRead.value !== "string"
    || !FAMILY_PENDING_STATUS_SET.has(statusRead.value)
  ) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_field",
      "status must be 'selected' or 'dispatched'.",
      `${location}.status`,
    ));
  } else {
    status = statusRead.value as FamilyDispatchPendingStatus;
  }

  const selectedAtRead = readOwnDataProperty(record, "selectedAt", `${location}.selectedAt`);
  if (!selectedAtRead.ok) {
    return { ok: false, diagnostics: [selectedAtRead.diagnostic] };
  }
  let selectedAt: string | undefined;
  if (!selectedAtRead.present || !isNonEmptyString(selectedAtRead.value)) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_field",
      "selectedAt must be a non-empty string.",
      `${location}.selectedAt`,
    ));
  } else {
    selectedAt = selectedAtRead.value.trim();
  }

  const ordinalRead = readOwnDataProperty(
    record,
    "schedulerOrdinal",
    `${location}.schedulerOrdinal`,
  );
  if (!ordinalRead.ok) {
    return { ok: false, diagnostics: [ordinalRead.diagnostic] };
  }
  let schedulerOrdinal: number | undefined;
  if (!ordinalRead.present || !isNonNegativeSafeInteger(ordinalRead.value)) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_field",
      "schedulerOrdinal must be a non-negative safe integer.",
      `${location}.schedulerOrdinal`,
    ));
  } else {
    schedulerOrdinal = ordinalRead.value;
  }

  let dispatchedAt: string | undefined;
  const dispatchedAtRead = readOwnDataProperty(
    record,
    "dispatchedAt",
    `${location}.dispatchedAt`,
  );
  if (!dispatchedAtRead.ok) {
    return { ok: false, diagnostics: [dispatchedAtRead.diagnostic] };
  }
  if (dispatchedAtRead.present) {
    if (!isNonEmptyString(dispatchedAtRead.value)) {
      diagnostics.push(reject(
        "family_concurrent_pending_invalid_field",
        "dispatchedAt must be a non-empty string when present.",
        `${location}.dispatchedAt`,
      ));
    } else {
      dispatchedAt = dispatchedAtRead.value.trim();
    }
  }

  const selectionRead = readOwnDataProperty(record, "selection", `${location}.selection`);
  if (!selectionRead.ok) {
    return { ok: false, diagnostics: [selectionRead.diagnostic] };
  }
  let selection: FamilySelectedAction | undefined;
  if (!selectionRead.present) {
    diagnostics.push(reject(
      "family_concurrent_pending_invalid_field",
      "selection is required.",
      `${location}.selection`,
    ));
  } else {
    const parsedSelection = parseFamilySelectedActionOwnData(
      selectionRead.value,
      `${location}.selection`,
    );
    if (!parsedSelection.ok) {
      diagnostics.push(...parsedSelection.diagnostics);
    } else {
      selection = parsedSelection.value;
    }
  }

  if (
    diagnostics.length > 0
    || dispatchId === undefined
    || status === undefined
    || selectedAt === undefined
    || schedulerOrdinal === undefined
    || selection === undefined
  ) {
    return { ok: false, diagnostics };
  }

  // Family scheduler lifecycle invariants (mirrors validateFamilySchedulerState).
  if (schedulerOrdinal < 1) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_scheduler_ordinal",
        `Pending dispatch '${dispatchId}' has an invalid scheduler ordinal.`,
        `${location}.schedulerOrdinal`,
      )],
    };
  }

  if (!Number.isFinite(Date.parse(selectedAt))) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_timestamp",
        `Pending dispatch '${dispatchId}' has an invalid selectedAt timestamp.`,
        `${location}.selectedAt`,
      )],
    };
  }

  if (status === "selected") {
    if (dispatchedAt !== undefined) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_pending_invalid_status_fields",
          `Selected pending '${dispatchId}' must not include dispatchedAt.`,
          `${location}.dispatchedAt`,
        )],
      };
    }
  } else if (status === "dispatched") {
    if (dispatchedAt === undefined || !Number.isFinite(Date.parse(dispatchedAt))) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_pending_invalid_timestamp",
          `Dispatched pending '${dispatchId}' requires a valid dispatchedAt timestamp.`,
          `${location}.dispatchedAt`,
        )],
      };
    }
    if (Date.parse(dispatchedAt) < Date.parse(selectedAt)) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_pending_timestamp_order",
          `Pending dispatch '${dispatchId}' cannot be dispatched before it was selected.`,
          `${location}.dispatchedAt`,
        )],
      };
    }
  }

  // Selection identity must match the containing family.
  const familyIdRead = readOwnDataProperty(familyObject, "familyId", "family.familyId");
  if (!familyIdRead.ok) {
    return { ok: false, diagnostics: [familyIdRead.diagnostic] };
  }
  if (!familyIdRead.present || !isNonEmptyString(familyIdRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_family_identity",
        "family.familyId must be a non-empty string when pendingDispatch is present.",
        "family.familyId",
      )],
    };
  }
  const familyId = familyIdRead.value.trim();
  if (selection.familyId !== familyId) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_selection_family_mismatch",
        `Selection family '${selection.familyId}' does not match family '${familyId}'.`,
        `${location}.selection.familyId`,
      )],
    };
  }

  const familyOrdinalRead = readOwnDataProperty(
    familyObject,
    "schedulerOrdinal",
    "family.schedulerOrdinal",
  );
  if (!familyOrdinalRead.ok) {
    return { ok: false, diagnostics: [familyOrdinalRead.diagnostic] };
  }
  if (
    !familyOrdinalRead.present
    || !isNonNegativeSafeInteger(familyOrdinalRead.value)
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_family_identity",
        "family.schedulerOrdinal must be a non-negative safe integer when pendingDispatch is present.",
        "family.schedulerOrdinal",
      )],
    };
  }
  const familySchedulerOrdinal = familyOrdinalRead.value;
  if (schedulerOrdinal > familySchedulerOrdinal) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_scheduler_ordinal",
        `Pending dispatch '${dispatchId}' scheduler ordinal ${schedulerOrdinal} `
        + `is ahead of family sequence ${familySchedulerOrdinal}.`,
        `${location}.schedulerOrdinal`,
      )],
    };
  }

  const membersRead = readOwnDataProperty(familyObject, "members", "family.members");
  if (!membersRead.ok) {
    return { ok: false, diagnostics: [membersRead.diagnostic] };
  }
  if (!membersRead.present || !isStrictPlainObject(membersRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_family_identity",
        "family.members must be a plain object when pendingDispatch is present.",
        "family.members",
      )],
    };
  }
  const membersObject = membersRead.value as object;
  const memberRead = readOwnDataProperty(
    membersObject,
    selection.goalId,
    `family.members[${JSON.stringify(selection.goalId)}]`,
  );
  if (!memberRead.ok) {
    return { ok: false, diagnostics: [memberRead.diagnostic] };
  }
  if (!memberRead.present || !isStrictPlainObject(memberRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_selection_member_missing",
        `Pending dispatch selects missing member '${selection.goalId}'.`,
        `${location}.selection.goalId`,
      )],
    };
  }
  const memberObject = memberRead.value as object;
  const memberWorkflowRead = readOwnDataProperty(
    memberObject,
    "workflowId",
    `family.members[${JSON.stringify(selection.goalId)}].workflowId`,
  );
  if (!memberWorkflowRead.ok) {
    return { ok: false, diagnostics: [memberWorkflowRead.diagnostic] };
  }
  if (!memberWorkflowRead.present || !isNonEmptyString(memberWorkflowRead.value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_invalid_family_identity",
        `Member '${selection.goalId}' requires a non-empty workflowId.`,
        `family.members[${JSON.stringify(selection.goalId)}].workflowId`,
      )],
    };
  }
  const memberWorkflowId = memberWorkflowRead.value.trim();
  if (memberWorkflowId !== selection.workflowId) {
    return {
      ok: false,
      diagnostics: [reject(
        "family_concurrent_pending_selection_workflow_mismatch",
        `Selected member '${selection.goalId}' belongs to workflow '${memberWorkflowId}', `
        + `not '${selection.workflowId}'.`,
        `${location}.selection.workflowId`,
      )],
    };
  }

  const pending: FamilyPendingDispatch = {
    dispatchId,
    selection,
    status,
    selectedAt,
    schedulerOrdinal,
  };
  if (dispatchedAt !== undefined) {
    pending.dispatchedAt = dispatchedAt;
  }
  return { ok: true, value: pending };
}

/**
 * Seed virtual occupancy from sequential pending dispatch.
 * Includes executor, group, and optional lease attributes for the pending work.
 * When occupancy already contains the pending attempt id, executor kind and group
 * membership must match exactly. Content mismatch is a hard diagnostic.
 */
function seedOccupancyFromPending(
  concurrencyState: ConcurrencyState,
  groupState: ConcurrencyGroupState,
  leaseSet: WorkspaceLeaseSet,
  pending: FamilyPendingDispatch | undefined,
  pendingAttemptId: string | undefined,
  attributes: FamilyConcurrentCandidateAttributes | undefined,
): SeedOccupancyResult {
  if (!pending || !pendingAttemptId) {
    return {
      ok: true,
      concurrencyState,
      groupState,
      leaseSet,
      occupiedAttemptIds: [],
    };
  }

  const executorKind = attributes?.executorKind ?? DEFAULT_FAMILY_CONCURRENT_EXECUTOR_KIND;
  const groupIds = attributes?.groupIds !== undefined
    ? [...attributes.groupIds].sort(compareIdentity)
    : [];

  const existingConcurrency = concurrencyState.attempts.find(
    (attempt) => attempt.attemptId === pendingAttemptId,
  );
  let nextConcurrency = concurrencyState;
  if (existingConcurrency !== undefined) {
    if (existingConcurrency.executorKind !== executorKind) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_pending_executor_kind_conflict",
          `Pending attempt '${pendingAttemptId}' is active with executor kind `
          + `'${existingConcurrency.executorKind}', but pending attributes declare `
          + `'${executorKind}'.`,
          "pendingAttributes.executorKind",
        )],
      };
    }
  } else {
    // Seed without global-limit rejection: pending is already in flight.
    nextConcurrency = {
      schemaVersion: concurrencyState.schemaVersion,
      attempts: [
        ...concurrencyState.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          executorKind: attempt.executorKind,
          ...(attempt.profileId !== undefined ? { profileId: attempt.profileId } : {}),
        })),
        { attemptId: pendingAttemptId, executorKind },
      ].sort((left, right) => compareIdentity(left.attemptId, right.attemptId)),
    };
  }

  const existingGroup = groupState.attempts.find(
    (attempt) => attempt.attemptId === pendingAttemptId,
  );
  let nextGroup = groupState;
  if (existingGroup !== undefined) {
    const existingGroupIds = [...existingGroup.groupIds].sort(compareIdentity);
    if (!groupIdSetsEqual(existingGroupIds, groupIds)) {
      return {
        ok: false,
        diagnostics: [reject(
          "family_concurrent_pending_group_ids_conflict",
          `Pending attempt '${pendingAttemptId}' is active with group membership `
          + `[${existingGroupIds.join(", ")}], but pending attributes declare `
          + `[${groupIds.join(", ")}].`,
          "pendingAttributes.groupIds",
        )],
      };
    }
  } else {
    nextGroup = {
      schemaVersion: groupState.schemaVersion,
      attempts: [
        ...groupState.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          groupIds: [...attempt.groupIds],
        })),
        { attemptId: pendingAttemptId, groupIds },
      ].sort((left, right) => compareIdentity(left.attemptId, right.attemptId)),
    };
  }

  let nextLeases = leaseSet;
  if (attributes?.lease !== undefined) {
    const pendingSelection = pending.selection;
    const holderCheck = validateLeaseHolderMatchesCandidate(
      attributes.lease,
      {
        attemptId: pendingAttemptId,
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        action: pendingSelection.action,
        ...(pendingSelection.nodeId !== undefined ? { nodeId: pendingSelection.nodeId } : {}),
      },
      "pendingAttributes.lease.holder",
    );
    if (holderCheck.length > 0) {
      return { ok: false, diagnostics: holderCheck };
    }

    const pendingLease = attributes.lease;
    let exactMatch: WorkspaceLease | undefined;
    for (const active of leaseSet.leases) {
      if (workspaceLeasesCanonicallyEqual(active, pendingLease)) {
        exactMatch = active;
        break;
      }
    }
    if (exactMatch === undefined) {
      // Partial identity match without full equality is inconsistent occupancy input.
      const sameLeaseId = leaseSet.leases.find(
        (lease) => lease.leaseId === pendingLease.leaseId,
      );
      if (sameLeaseId !== undefined) {
        return {
          ok: false,
          diagnostics: [reject(
            "family_concurrent_pending_lease_id_conflict",
            `Pending lease id '${pendingLease.leaseId}' is already active with different lease content.`,
            "pendingAttributes.lease.leaseId",
          )],
        };
      }
      const sameAttempt = leaseSet.leases.find(
        (lease) => lease.holder.attemptId === pendingAttemptId,
      );
      if (sameAttempt !== undefined) {
        return {
          ok: false,
          diagnostics: [reject(
            "family_concurrent_pending_lease_attempt_conflict",
            `Pending attempt id '${pendingAttemptId}' already holds lease `
            + `'${sameAttempt.leaseId}' with different content than the pending attribute lease.`,
            "pendingAttributes.lease.holder.attemptId",
          )],
        };
      }

      const acquired = acquireWorkspaceLease(leaseSet, pendingLease);
      if (!acquired.ok) {
        return { ok: false, diagnostics: acquired.diagnostics };
      }
      nextLeases = acquired.set;
    }
  }

  return {
    ok: true,
    concurrencyState: nextConcurrency,
    groupState: nextGroup,
    leaseSet: nextLeases,
    occupiedAttemptIds: [pendingAttemptId],
  };
}

function allDiagnosticsSoft(
  diagnostics: Diagnostic[],
  softCodes: ReadonlySet<string>,
): boolean {
  return diagnostics.length > 0 && diagnostics.every((item) => softCodes.has(item.code));
}

function advanceFairnessOrdinal(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return current + 1;
}

function toFairnessCandidate(candidate: FamilyConcurrentCandidate): FairnessCandidate {
  return {
    attemptId: candidate.attemptId,
    readySequence: candidate.selectedSequence,
    fairnessKey: candidate.goalId,
    groupIds: [...candidate.groupIds],
  };
}

/**
 * Select a concurrent batch of family actions under limits, groups, and leases.
 *
 * Policy:
 * 1. Reject unsupported family schema versions with diagnostics.
 * 2. Parse and lift supplied candidates with strict plain-object rules.
 * 3. Validate supplied occupancy states before any direct field reads.
 * 4. Exclude sequential pending identities when treatPendingAsOccupancy is true.
 * 5. Seed occupancy from concurrency, group, and lease state, and from sequential
 *    pendingDispatch (including a pending lease attribute when supplied).
 * 6. Iteratively select with fairness, limits, groups, and leases until the batch
 *    is full or no admissible candidate remains. Soft exclusions remove a candidate
 *    and continue. Hard input errors reject the selection.
 * 7. Same goal is not double-selected within one batch.
 * 8. Proposed leases must match the candidate identity before acquisition.
 *
 * Does not mutate inputs. Does not commit family events.
 * Multi-pending family persistence remains deferred.
 */
export function selectFamilyConcurrentBatch(
  input: unknown,
): FamilyConcurrentDecision {
  if (!isStrictPlainObject(input)) {
    return {
      kind: "rejected",
      reason: "Concurrent selection input must be a plain object.",
      diagnostics: [reject(
        "family_concurrent_invalid_input",
        "Concurrent selection input must be a plain object.",
        "input",
      )],
    };
  }

  const familyRead = readOwnDataProperty(input, "family", "input.family");
  if (!familyRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read family from concurrent selection input.",
      diagnostics: [familyRead.diagnostic],
    };
  }
  if (!familyRead.present || !isStrictPlainObject(familyRead.value)) {
    return {
      kind: "rejected",
      reason: "Concurrent selection input.family must be a plain object.",
      diagnostics: [reject(
        "family_concurrent_invalid_input",
        "Concurrent selection input.family must be a plain object.",
        "input.family",
      )],
    };
  }
  const familyObject = familyRead.value as object;
  const schemaError = assertFamilySchemaFromObject(familyObject, "input.family.schemaVersion");
  if (schemaError) {
    return {
      kind: "rejected",
      reason: schemaError[0]!.message,
      diagnostics: schemaError,
    };
  }

  const pendingParse = parseFamilyPendingDispatchOwnData(
    familyObject,
    "input.family.pendingDispatch",
  );
  if (!pendingParse.ok) {
    return {
      kind: "rejected",
      reason: "family.pendingDispatch is invalid or unreadable.",
      diagnostics: pendingParse.diagnostics,
    };
  }
  const cleanPendingDispatch = pendingParse.value;

  const candidatesRead = readOwnDataProperty(input, "candidates", "input.candidates");
  if (!candidatesRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read candidates from concurrent selection input.",
      diagnostics: [candidatesRead.diagnostic],
    };
  }
  if (!candidatesRead.present) {
    return {
      kind: "rejected",
      reason: "Concurrent selection input.candidates is required.",
      diagnostics: [reject(
        "family_concurrent_invalid_candidates",
        "Concurrent selection input.candidates is required.",
        "input.candidates",
      )],
    };
  }

  const fairnessOrdinalRead = readOwnDataProperty(
    input,
    "fairnessOrdinal",
    "input.fairnessOrdinal",
  );
  if (!fairnessOrdinalRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read fairnessOrdinal.",
      diagnostics: [fairnessOrdinalRead.diagnostic],
    };
  }
  let fairnessOrdinal = 0;
  if (fairnessOrdinalRead.present && fairnessOrdinalRead.value !== undefined) {
    if (!isNonNegativeSafeInteger(fairnessOrdinalRead.value)) {
      return {
        kind: "rejected",
        reason: "fairnessOrdinal must be a non-negative safe integer.",
        diagnostics: [reject(
          "family_concurrent_invalid_fairness_ordinal",
          "fairnessOrdinal must be a non-negative safe integer.",
          "fairnessOrdinal",
        )],
      };
    }
    fairnessOrdinal = fairnessOrdinalRead.value;
  }

  const limitsRead = readOwnDataProperty(input, "concurrencyLimits", "input.concurrencyLimits");
  if (!limitsRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read concurrencyLimits.",
      diagnostics: [limitsRead.diagnostic],
    };
  }
  const limitsResult = resolveConcurrencyLimits(
    limitsRead.present ? limitsRead.value : undefined,
  );
  if (!limitsResult.ok) {
    return {
      kind: "rejected",
      reason: "Concurrency limits are invalid.",
      diagnostics: limitsResult.diagnostics,
    };
  }
  const resolvedLimits = limitsResult.value;

  const maxBatchRead = readOwnDataProperty(input, "maxBatchSize", "input.maxBatchSize");
  if (!maxBatchRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read maxBatchSize.",
      diagnostics: [maxBatchRead.diagnostic],
    };
  }
  let maxBatchSize = resolvedLimits.globalConcurrency;
  if (maxBatchRead.present && maxBatchRead.value !== undefined) {
    if (!isNonNegativeSafeInteger(maxBatchRead.value)) {
      return {
        kind: "rejected",
        reason: "maxBatchSize must be a non-negative safe integer when present.",
        diagnostics: [reject(
          "family_concurrent_invalid_batch_size",
          "maxBatchSize must be a non-negative safe integer when present.",
          "maxBatchSize",
        )],
      };
    }
    maxBatchSize = maxBatchRead.value;
  }

  const attributesByAttemptIdRead = readOwnDataProperty(
    input,
    "attributesByAttemptId",
    "input.attributesByAttemptId",
  );
  if (!attributesByAttemptIdRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read attributesByAttemptId.",
      diagnostics: [attributesByAttemptIdRead.diagnostic],
    };
  }
  const attributesByGoalIdRead = readOwnDataProperty(
    input,
    "attributesByGoalId",
    "input.attributesByGoalId",
  );
  if (!attributesByGoalIdRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read attributesByGoalId.",
      diagnostics: [attributesByGoalIdRead.diagnostic],
    };
  }

  const liftOptions: {
    attributesByAttemptId?: unknown;
    attributesByGoalId?: unknown;
  } = {};
  if (attributesByAttemptIdRead.present) {
    liftOptions.attributesByAttemptId = attributesByAttemptIdRead.value;
  }
  if (attributesByGoalIdRead.present) {
    liftOptions.attributesByGoalId = attributesByGoalIdRead.value;
  }

  const lifted = liftFamilyConcurrentCandidates(candidatesRead.value, liftOptions);
  if (!lifted.ok) {
    return {
      kind: "rejected",
      reason: "Unable to lift concurrent family candidates.",
      diagnostics: lifted.diagnostics,
    };
  }

  // Hard-reject mismatched lease holders before fair selection or soft capacity skips.
  const earlyLeaseHolderDiagnostics: Diagnostic[] = [];
  for (let index = 0; index < lifted.candidates.length; index += 1) {
    const candidate = lifted.candidates[index]!;
    if (candidate.lease === undefined) continue;
    earlyLeaseHolderDiagnostics.push(
      ...validateLeaseHolderMatchesCandidate(
        candidate.lease,
        candidate,
        `candidates[${index}].lease.holder`,
      ),
    );
  }
  if (earlyLeaseHolderDiagnostics.length > 0) {
    return {
      kind: "rejected",
      reason: "Proposed lease holder does not match the candidate identity.",
      diagnostics: earlyLeaseHolderDiagnostics,
    };
  }

  const treatPendingRead = readOwnDataProperty(
    input,
    "treatPendingAsOccupancy",
    "input.treatPendingAsOccupancy",
  );
  if (!treatPendingRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read treatPendingAsOccupancy.",
      diagnostics: [treatPendingRead.diagnostic],
    };
  }
  const treatPending = !(
    treatPendingRead.present
    && treatPendingRead.value === false
  );

  const filtered = excludePendingFamilyConcurrentCandidates(
    lifted.candidates,
    treatPending ? cleanPendingDispatch : undefined,
  );

  // Parse occupancy inputs into clean records. Do not structuredClone untrusted values.
  const concurrencyStateRead = readOwnDataProperty(
    input,
    "concurrencyState",
    "input.concurrencyState",
  );
  if (!concurrencyStateRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read concurrencyState.",
      diagnostics: [concurrencyStateRead.diagnostic],
    };
  }
  const parsedConcurrency = parseCleanConcurrencyState(
    concurrencyStateRead.present ? concurrencyStateRead.value : undefined,
    "concurrencyState",
  );
  if (!parsedConcurrency.ok) {
    return {
      kind: "rejected",
      reason: "Concurrency state is invalid or unsupported.",
      diagnostics: parsedConcurrency.diagnostics,
    };
  }
  const baseConcurrency = parsedConcurrency.value;

  const groupStateRead = readOwnDataProperty(input, "groupState", "input.groupState");
  if (!groupStateRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read groupState.",
      diagnostics: [groupStateRead.diagnostic],
    };
  }
  const parsedGroup = parseCleanGroupState(
    groupStateRead.present ? groupStateRead.value : undefined,
    "concurrencyGroupState",
  );
  if (!parsedGroup.ok) {
    return {
      kind: "rejected",
      reason: "Concurrency group state is invalid or unsupported.",
      diagnostics: parsedGroup.diagnostics,
    };
  }
  const baseGroup = parsedGroup.value;

  const leaseSetRead = readOwnDataProperty(input, "leaseSet", "input.leaseSet");
  if (!leaseSetRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read leaseSet.",
      diagnostics: [leaseSetRead.diagnostic],
    };
  }
  const baseLeasesRaw = leaseSetRead.present && leaseSetRead.value !== undefined
    ? leaseSetRead.value
    : createEmptyWorkspaceLeaseSet();
  const parsedLeaseSet = parseFamilyConcurrentLeaseSet(baseLeasesRaw, "leaseSet");
  if (!parsedLeaseSet.ok) {
    return {
      kind: "rejected",
      reason: "Workspace lease set is invalid or unsupported.",
      diagnostics: parsedLeaseSet.diagnostics,
    };
  }
  const baseLeases = parsedLeaseSet.value;

  const groupRegistryRead = readOwnDataProperty(
    input,
    "groupRegistry",
    "input.groupRegistry",
  );
  if (!groupRegistryRead.ok) {
    return {
      kind: "rejected",
      reason: "Unable to read groupRegistry.",
      diagnostics: [groupRegistryRead.diagnostic],
    };
  }
  const groupRegistry = groupRegistryRead.present
    ? groupRegistryRead.value
    : undefined;

  // Re-parse clean attribute maps for pending resolution (already validated in lift).
  const attributesByAttemptIdResult = parseAttributesMap(
    liftOptions.attributesByAttemptId,
    "attributesByAttemptId",
  );
  if (!attributesByAttemptIdResult.ok) {
    return {
      kind: "rejected",
      reason: "Concurrent attribute maps are invalid.",
      diagnostics: attributesByAttemptIdResult.diagnostics,
    };
  }
  const attributesByGoalIdResult = parseAttributesMap(
    liftOptions.attributesByGoalId,
    "attributesByGoalId",
  );
  if (!attributesByGoalIdResult.ok) {
    return {
      kind: "rejected",
      reason: "Concurrent attribute maps are invalid.",
      diagnostics: attributesByGoalIdResult.diagnostics,
    };
  }

  const pendingAttributes = cleanPendingDispatch
    ? resolveCleanAttributes(
      filtered.pendingAttemptId ?? buildFamilyConcurrentAttemptIdFromSelection(
        cleanPendingDispatch.selection,
      ),
      cleanPendingDispatch.selection.goalId,
      attributesByAttemptIdResult.value,
      attributesByGoalIdResult.value,
    )
    : undefined;

  const seeded = seedOccupancyFromPending(
    baseConcurrency,
    baseGroup,
    baseLeases,
    treatPending ? cleanPendingDispatch : undefined,
    treatPending ? filtered.pendingAttemptId : undefined,
    pendingAttributes,
  );
  if (!seeded.ok) {
    return {
      kind: "rejected",
      reason: "Unable to seed concurrent occupancy from pending dispatch.",
      diagnostics: seeded.diagnostics,
    };
  }

  const activeCount = seeded.concurrencyState.attempts.length;
  const remainingGlobal = Math.max(0, resolvedLimits.globalConcurrency - activeCount);
  const batchLimit = Math.min(maxBatchSize, remainingGlobal);

  const emptyOccupancy = (): FamilyConcurrentOccupancy => copyOccupancy({
    schemaVersion: FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
    concurrencyState: sortConcurrencyStateByIdentity(seeded.concurrencyState),
    groupState: seeded.groupState,
    leaseSet: seeded.leaseSet,
    occupiedAttemptIds: seeded.occupiedAttemptIds,
  });

  if (batchLimit === 0 || filtered.candidates.length === 0) {
    return {
      kind: "idle",
      reason: filtered.candidates.length === 0
        ? "No concurrent family candidates are available under current occupancy."
        : `No concurrent capacity remains under the global limit of ${resolvedLimits.globalConcurrency}.`,
      fairnessOrdinal,
      occupancy: emptyOccupancy(),
    };
  }

  // Iterative fair selection with soft-skip replacement.
  const remaining = filtered.candidates.map(copyConcurrentCandidate);
  let virtualConcurrency = structuredClone(seeded.concurrencyState);
  let virtualGroup = structuredClone(seeded.groupState);
  let virtualLeases = structuredClone(seeded.leaseSet);
  let ordinal = fairnessOrdinal;
  const selected: FamilyConcurrentCandidate[] = [];
  const occupiedAttemptIds = new Set(seeded.occupiedAttemptIds);
  const selectedGoalIds = new Set<string>();

  while (selected.length < batchLimit && remaining.length > 0) {
    const fairnessCandidates = remaining.map(toFairnessCandidate);
    const fair = selectFairCandidate(
      virtualGroup,
      groupRegistry,
      fairnessCandidates,
      ordinal,
    );
    if (!fair.ok) {
      return {
        kind: "rejected",
        reason: "Concurrent fairness selection rejected the candidate set.",
        diagnostics: fair.diagnostics,
      };
    }
    if (fair.kind === "idle") {
      break;
    }

    const index = remaining.findIndex(
      (candidate) => candidate.attemptId === fair.candidate.attemptId,
    );
    if (index < 0) {
      break;
    }
    const candidate = remaining[index]!;

    if (
      occupiedAttemptIds.has(candidate.attemptId)
      || selectedGoalIds.has(candidate.goalId)
    ) {
      remaining.splice(index, 1);
      continue;
    }

    const admitConcurrency = admitAttempt(
      virtualConcurrency,
      {
        attemptId: candidate.attemptId,
        executorKind: candidate.executorKind,
      },
      {
        globalConcurrency: resolvedLimits.globalConcurrency,
        perExecutorKind: resolvedLimits.perExecutorKind,
      },
    );
    if (!admitConcurrency.ok) {
      if (allDiagnosticsSoft(admitConcurrency.diagnostics, SOFT_CONCURRENCY_CODES)) {
        remaining.splice(index, 1);
        continue;
      }
      return {
        kind: "rejected",
        reason: "Concurrent limit admission rejected a candidate with a hard input error.",
        diagnostics: admitConcurrency.diagnostics,
      };
    }

    const admitGroup = admitGroupAttempt(
      virtualGroup,
      {
        attemptId: candidate.attemptId,
        groupIds: candidate.groupIds,
      },
      groupRegistry,
    );
    if (!admitGroup.ok) {
      if (allDiagnosticsSoft(admitGroup.diagnostics, SOFT_GROUP_CODES)) {
        remaining.splice(index, 1);
        continue;
      }
      return {
        kind: "rejected",
        reason: "Concurrent group admission rejected a candidate with a hard input error.",
        diagnostics: admitGroup.diagnostics,
      };
    }

    let nextLeases = virtualLeases;
    if (candidate.lease !== undefined) {
      // Holder identity was validated immediately after lift.
      const leaseAcquire = acquireWorkspaceLease(virtualLeases, candidate.lease);
      if (!leaseAcquire.ok) {
        if (allDiagnosticsSoft(leaseAcquire.diagnostics, SOFT_LEASE_CODES)) {
          remaining.splice(index, 1);
          continue;
        }
        return {
          kind: "rejected",
          reason: "Concurrent lease admission rejected a candidate with a hard input error.",
          diagnostics: leaseAcquire.diagnostics,
        };
      }
      nextLeases = leaseAcquire.set;
    }

    remaining.splice(index, 1);
    // admitAttempt sorts with localeCompare. Re-sort for locale-independent order.
    virtualConcurrency = sortConcurrencyStateByIdentity(admitConcurrency.state);
    virtualGroup = admitGroup.state;
    virtualLeases = nextLeases;
    selected.push(copyConcurrentCandidate(candidate));
    occupiedAttemptIds.add(candidate.attemptId);
    selectedGoalIds.add(candidate.goalId);
    ordinal = advanceFairnessOrdinal(ordinal);
  }

  const occupancy = copyOccupancy({
    schemaVersion: FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
    concurrencyState: sortConcurrencyStateByIdentity(virtualConcurrency),
    groupState: virtualGroup,
    leaseSet: virtualLeases,
    occupiedAttemptIds: [...occupiedAttemptIds],
  });

  if (selected.length === 0) {
    return {
      kind: "idle",
      reason:
        "No concurrent family candidates passed limits, groups, and lease compatibility.",
      fairnessOrdinal: ordinal,
      occupancy,
    };
  }

  return {
    kind: "select-batch",
    candidates: selected,
    reason:
      `Selected ${selected.length} concurrent family action(s) under global limit `
      + `${resolvedLimits.globalConcurrency}, group fairness, and lease compatibility.`,
    fairnessOrdinal: ordinal,
    occupancy,
  };
}

/** Expose the default concurrent batch capacity used when maxBatchSize is omitted. */
export function defaultFamilyConcurrentBatchCapacity(): number {
  return DEFAULT_GLOBAL_CONCURRENCY;
}
