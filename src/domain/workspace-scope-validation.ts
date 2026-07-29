/**
 * Pure pre-integration validation of worker commit scope and evidence (M8-s4).
 *
 * Call this after a worker commit result (and optional executor result) is
 * available and before any git integrate into the base workspace.
 *
 * Integration eligibility policy for this slice:
 * - Only status "clean" is eligible for integration.
 * - Status values "dirty", "conflicted", and "unknown" must fail with explicit
 *   diagnostics. Do not integrate dirty trees silently.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * This module does not perform git integrate (M8-s5).
 */

import {
  DEFAULT_MAX_RESULT_ARTIFACTS,
  DEFAULT_MAX_RESULT_DIAGNOSTICS,
  DEFAULT_MAX_RESULT_EVIDENCE,
  DEFAULT_MAX_RESULT_FACTS,
  DEFAULT_MAX_RESULT_SUMMARY_CHARS,
  EXECUTOR_OUTCOMES,
  validateExecutorResult,
  type ExecutorContextEnvelope,
  type ExecutorResult,
  type StructuredResultProtocolDescriptor,
  type ValidateExecutorResultOptions,
} from "./executor-contract.js";
import type { Diagnostic } from "./model.js";
import {
  canonicalGitRelativePath,
  compareGitPathOrdinal,
  parseWorkerCommitResult,
  toExecutorWorkspaceResult,
  validateWorkerCommitIdentity,
  type WorkerCommitBounds,
  type WorkerCommitExpectedIdentity,
  type WorkerCommitResult,
} from "./workspace-commit.js";
import {
  parseWorkspaceLease,
  pathWithinLeaseScope,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
} from "./workspace-lease.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Bounds for pre-integration validation.
 * maxChangedPaths is always enforced through worker commit parse (default or set).
 */
export interface WorkspaceScopeValidationBounds extends WorkerCommitBounds {}

/**
 * Input for pre-integration validation of a worker result.
 * commit and lease may be untrusted; the function parses and clones them.
 */
export interface ValidateWorkerResultForIntegrationInput {
  /** Worker commit result shape. Validated and cloned on success. */
  commit: unknown;
  /** Exclusive lease that owns the attempt. Validated and cloned on success. */
  lease: unknown;
  /**
   * Optional extra identity checks.
   * The lease id and holder are always checked against the commit.
   * Present expected fields must also match.
   */
  expected?: WorkerCommitExpectedIdentity;
  /** Optional untrusted executor result for evidence and workspace checks. */
  executorResult?: unknown;
  /**
   * Structured result protocol when executorResult is present.
   * When omitted and executorResult is present, a default permissive protocol
   * validates shape and bounds only (no required evidence or fact contracts).
   */
  protocol?: StructuredResultProtocolDescriptor;
  /** Optional changed-path and other commit bounds. Always enforced when set. */
  bounds?: WorkspaceScopeValidationBounds;
  /**
   * When true, file-kind evidence refs that look like workspace-relative paths
   * must fall within lease read or write scope. Default is false.
   */
  checkFileEvidencePaths?: boolean;
  /** Optional published attempt facts for required-fact protocol checks. */
  publishedAttemptFacts?: ValidateExecutorResultOptions["publishedAttemptFacts"];
}

/**
 * Accepted pre-integration value.
 * Later slices (m8-s5) use these clones for integrate.
 */
export interface ValidatedWorkerResultForIntegration {
  commit: WorkerCommitResult;
  lease: WorkspaceLease;
  executorResult?: ExecutorResult;
}

export type ValidateWorkerResultForIntegrationResult =
  | { ok: true; value: ValidatedWorkerResultForIntegration }
  | { ok: false; diagnostics: Diagnostic[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 */
const isStrictPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function holdersEqual(left: WorkspaceLeaseHolder, right: WorkspaceLeaseHolder): boolean {
  return (
    left.familyId === right.familyId
    && left.goalId === right.goalId
    && left.workflowId === right.workflowId
    && left.revision === right.revision
    && left.nodeId === right.nodeId
    && left.attemptId === right.attemptId
  );
}

/**
 * Default protocol when executorResult is present without a caller protocol.
 * Empty fact contracts and required evidence. Default size bounds apply.
 */
export function defaultIntegrationResultProtocol(): StructuredResultProtocolDescriptor {
  return {
    version: 1,
    outcomes: [...EXECUTOR_OUTCOMES],
    factContracts: [],
    requiredEvidence: [],
    maxSummaryChars: DEFAULT_MAX_RESULT_SUMMARY_CHARS,
    maxDiagnostics: DEFAULT_MAX_RESULT_DIAGNOSTICS,
    maxArtifacts: DEFAULT_MAX_RESULT_ARTIFACTS,
    maxFacts: DEFAULT_MAX_RESULT_FACTS,
    maxEvidence: DEFAULT_MAX_RESULT_EVIDENCE,
  };
}

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Validate and clone an untrusted result protocol for integration precheck.
 * Rejects class instances and incomplete shapes so syntheticExecutorContext
 * and validateExecutorResult never throw on malformed protocol input.
 * Does not mutate input.
 */
export function parseIntegrationResultProtocol(
  value: unknown,
  location = "protocol",
): { ok: true; value: StructuredResultProtocolDescriptor } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_scope_protocol_not_plain_object",
        "Result protocol must be a plain object when present.",
        location,
      )],
    };
  }

  const record = value;
  const diagnostics: Diagnostic[] = [];

  if (record.version !== 1) {
    diagnostics.push(reject(
      "workspace_scope_protocol_invalid",
      "Result protocol version must be 1.",
      `${location}.version`,
    ));
  }

  if (!Array.isArray(record.outcomes)) {
    diagnostics.push(reject(
      "workspace_scope_protocol_invalid",
      "Result protocol outcomes must be an array.",
      `${location}.outcomes`,
    ));
  }

  if (!Array.isArray(record.factContracts)) {
    diagnostics.push(reject(
      "workspace_scope_protocol_invalid",
      "Result protocol factContracts must be an array.",
      `${location}.factContracts`,
    ));
  }

  if (!Array.isArray(record.requiredEvidence)) {
    diagnostics.push(reject(
      "workspace_scope_protocol_invalid",
      "Result protocol requiredEvidence must be an array.",
      `${location}.requiredEvidence`,
    ));
  } else {
    for (let index = 0; index < record.requiredEvidence.length; index += 1) {
      const item = record.requiredEvidence[index];
      if (typeof item !== "string" || item.trim().length === 0) {
        diagnostics.push(reject(
          "workspace_scope_protocol_invalid",
          `Result protocol requiredEvidence at index ${index} must be a non-empty string.`,
          `${location}.requiredEvidence[${index}]`,
        ));
      }
    }
  }

  const boundFields = [
    "maxSummaryChars",
    "maxDiagnostics",
    "maxArtifacts",
    "maxFacts",
    "maxEvidence",
  ] as const;
  for (const field of boundFields) {
    if (!isNonNegativeSafeInteger(record[field])) {
      diagnostics.push(reject(
        "workspace_scope_protocol_invalid",
        `Result protocol ${field} must be a non-negative safe integer.`,
        `${location}.${field}`,
      ));
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Clone only after shape checks so class instances never enter this path.
  const protocol: StructuredResultProtocolDescriptor = {
    version: 1,
    outcomes: [...(record.outcomes as StructuredResultProtocolDescriptor["outcomes"])],
    factContracts: structuredClone(record.factContracts) as StructuredResultProtocolDescriptor["factContracts"],
    requiredEvidence: (record.requiredEvidence as string[]).map((item) => item.trim()),
    maxSummaryChars: record.maxSummaryChars as number,
    maxDiagnostics: record.maxDiagnostics as number,
    maxArtifacts: record.maxArtifacts as number,
    maxFacts: record.maxFacts as number,
    maxEvidence: record.maxEvidence as number,
  };
  return { ok: true, value: protocol };
}

/**
 * Build a minimal context envelope so validateExecutorResult can run.
 * Only identity and resultProtocol are read by the result validator.
 * Caller must pass a validated protocol from parseIntegrationResultProtocol
 * or defaultIntegrationResultProtocol so requiredEvidence is always an array.
 */
function syntheticExecutorContext(
  holder: WorkspaceLeaseHolder,
  protocol: StructuredResultProtocolDescriptor,
): ExecutorContextEnvelope {
  return {
    identity: {
      familyId: holder.familyId,
      goalId: holder.goalId,
      workflowId: holder.workflowId,
      revision: holder.revision,
      nodeId: holder.nodeId,
      attemptId: holder.attemptId,
    },
    profile: {
      profileId: "integration-precheck",
      kind: "deterministic",
    },
    rootObjective: "",
    localObjective: "",
    ancestry: [],
    nodeIntent: "",
    acceptanceCriteria: [],
    scope: { readPaths: [], writePaths: [] },
    requiredEvidence: [...protocol.requiredEvidence],
    selectedFacts: [],
    selectedArtifacts: [],
    predecessorSummaries: [],
    attemptBudget: {},
    resultProtocol: structuredClone(protocol),
  };
}

/**
 * Canonicalise a list of git-relative paths for set comparison.
 * Drops paths that fail canonicalGitRelativePath. Sorts with compareGitPathOrdinal.
 * Does not mutate the input list.
 */
function canonicalChangedPathSet(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const canonical = canonicalGitRelativePath(path);
    if (canonical === undefined) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  result.sort(compareGitPathOrdinal);
  return result;
}

/**
 * Report whether a file evidence ref looks like a workspace-relative path.
 * URI-style refs (scheme://) are not treated as workspace paths.
 */
export function looksLikeWorkspaceRelativeEvidencePath(ref: string): boolean {
  if (typeof ref !== "string" || ref.trim().length === 0) return false;
  const trimmed = ref.trim();
  // Scheme-based refs are not workspace-relative paths for this check.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false;
  return true;
}

/**
 * Validate that every changed path falls within the exclusive write scope.
 * Empty changedPaths is valid. Does not mutate inputs.
 */
export function validateChangedPathsWithinWriteScope(
  changedPaths: readonly string[],
  writePaths: readonly string[],
  location = "commit.changedPaths",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < changedPaths.length; index += 1) {
    const path = changedPaths[index]!;
    if (!pathWithinLeaseScope(path, writePaths)) {
      diagnostics.push(reject(
        "workspace_scope_path_outside_write_scope",
        `Changed path '${path}' is outside the exclusive lease write scope.`,
        `${location}[${index}]`,
      ));
    }
  }
  return diagnostics;
}

/**
 * Integration status gate. Only "clean" is eligible.
 * Returns a diagnostic for dirty, conflicted, or unknown status.
 */
export function validateIntegrationWorkspaceStatus(
  status: WorkerCommitResult["status"],
  location = "commit.status",
): Diagnostic[] {
  if (status === "clean") return [];
  if (status === "dirty") {
    return [reject(
      "workspace_scope_status_dirty",
      "Integration requires a clean worker workspace. Dirty status is not eligible.",
      location,
    )];
  }
  if (status === "conflicted") {
    return [reject(
      "workspace_scope_status_conflicted",
      "Integration requires a clean worker workspace. Conflicted status is not eligible.",
      location,
    )];
  }
  // unknown and any unexpected value fail closed.
  return [reject(
    "workspace_scope_status_unknown",
    "Integration requires a clean worker workspace. Unknown status is not eligible.",
    location,
  )];
}

/**
 * Compare executor workspace fields against a validated worker commit.
 * Present fields on the executor workspace must match. Absent fields are skipped.
 * leaseId and commitHash are compared after trim (commitHash also lowercased).
 * changedPaths comparison is set-based after canonicalGitRelativePath so
 * equivalent forms such as `./src/a.ts` and `src/a.ts` match.
 * Does not mutate inputs.
 */
export function validateExecutorWorkspaceMatchesCommit(
  workspace: NonNullable<ExecutorResult["workspace"]>,
  commit: WorkerCommitResult,
  location = "executorResult.workspace",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const expected = toExecutorWorkspaceResult(commit);

  if (workspace.leaseId !== undefined) {
    const left = workspace.leaseId.trim();
    const right = (expected.leaseId ?? "").trim();
    if (left !== right) {
      diagnostics.push(reject(
        "workspace_scope_workspace_mismatch",
        `Executor workspace leaseId '${workspace.leaseId}' does not match commit leaseId '${expected.leaseId}'.`,
        `${location}.leaseId`,
      ));
    }
  }
  if (workspace.commitHash !== undefined) {
    const left = workspace.commitHash.trim().toLowerCase();
    const right = (expected.commitHash ?? "").trim().toLowerCase();
    if (left !== right) {
      diagnostics.push(reject(
        "workspace_scope_workspace_mismatch",
        "Executor workspace commitHash does not match the worker commit hash.",
        `${location}.commitHash`,
      ));
    }
  }
  if (workspace.status !== undefined && workspace.status !== expected.status) {
    diagnostics.push(reject(
      "workspace_scope_workspace_mismatch",
      `Executor workspace status '${workspace.status}' does not match commit status '${expected.status}'.`,
      `${location}.status`,
    ));
  }
  if (workspace.changedPaths !== undefined) {
    const left = canonicalChangedPathSet(workspace.changedPaths);
    const right = canonicalChangedPathSet(expected.changedPaths ?? []);
    // Fail when any raw path cannot be canonicalised: set equality is incomplete.
    const rawHadInvalid = workspace.changedPaths.some(
      (path) => canonicalGitRelativePath(path) === undefined,
    );
    if (rawHadInvalid) {
      diagnostics.push(reject(
        "workspace_scope_workspace_mismatch",
        "Executor workspace changedPaths contains a path that is not a valid git-relative path.",
        `${location}.changedPaths`,
      ));
    } else {
      const sameLength = left.length === right.length;
      const sameSet = sameLength && left.every((path, index) => path === right[index]);
      if (!sameSet) {
        diagnostics.push(reject(
          "workspace_scope_workspace_mismatch",
          "Executor workspace changedPaths set does not match the worker commit changedPaths set.",
          `${location}.changedPaths`,
        ));
      }
    }
  }

  return diagnostics;
}

/**
 * Optional check: file-kind evidence refs that look like workspace paths must
 * fall within lease read or write scope. Does not invent new evidence schemas.
 */
export function validateFileEvidencePathsWithinLeaseScope(
  evidence: readonly { ref: string; kind?: string }[],
  lease: WorkspaceLease,
  location = "executorResult.evidence",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const scopePaths = [...lease.paths.readPaths, ...lease.paths.writePaths];
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index]!;
    if (item.kind !== "file") continue;
    if (!looksLikeWorkspaceRelativeEvidencePath(item.ref)) continue;
    if (!pathWithinLeaseScope(item.ref, scopePaths)) {
      diagnostics.push(reject(
        "workspace_scope_file_evidence_outside_scope",
        `File evidence ref '${item.ref}' is outside the lease read and write scope.`,
        `${location}[${index}].ref`,
      ));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate a worker commit (and optional executor result) before integration.
 *
 * Steps:
 * 1. Parse exclusive lease (shared leases must not integrate mutations).
 * 2. Parse worker commit with bounds.
 * 3. Check result identity against the lease and optional expected fields.
 * 4. Gate on clean workspace status.
 * 5. Require every changed path inside exclusive write scope.
 * 6. When executorResult is present, validate shape, evidence, and protocol.
 * 7. When executor workspace is present, require consistency with the commit.
 *
 * Returns diagnostics on failure. Does not throw for validation failures.
 * Does not mutate inputs. Pure: no clock, random, files, or network.
 */
export function validateWorkerResultForIntegration(
  input: ValidateWorkerResultForIntegrationInput,
): ValidateWorkerResultForIntegrationResult {
  if (!isStrictPlainObject(input as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_scope_input_not_plain_object",
        "Integration validation input must be a plain object.",
        "input",
      )],
    };
  }

  const diagnostics: Diagnostic[] = [];

  // Shared leases get a dedicated exclusive diagnostic without path noise.
  // Invalid modes fall through to parseWorkspaceLease (workspace_lease_invalid_mode).
  if (
    isStrictPlainObject(input.lease)
    && input.lease.mode === "shared"
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_scope_lease_not_exclusive",
        "Integration precheck requires an exclusive (mutating) lease. Shared leases must not integrate mutations.",
        "lease.mode",
      )],
    };
  }

  const parsedLease = parseWorkspaceLease(input.lease, "lease");
  if (!parsedLease.ok) {
    return { ok: false, diagnostics: parsedLease.diagnostics };
  }
  const lease = parsedLease.value;
  if (lease.mode !== "exclusive") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_scope_lease_not_exclusive",
        "Integration precheck requires an exclusive (mutating) lease. Shared leases must not integrate mutations.",
        "lease.mode",
      )],
    };
  }

  const commitBounds: WorkerCommitBounds | undefined = input.bounds === undefined
    ? undefined
    : input.bounds.maxChangedPaths === undefined
      ? {}
      : { maxChangedPaths: input.bounds.maxChangedPaths };

  const parsedCommit = parseWorkerCommitResult(input.commit, "commit", commitBounds);
  if (!parsedCommit.ok) {
    return { ok: false, diagnostics: parsedCommit.diagnostics };
  }
  const commit = parsedCommit.value;

  // Always check lease identity. Merge optional expected fields.
  const expected: WorkerCommitExpectedIdentity = {
    leaseId: lease.leaseId,
    holder: lease.holder,
    ...(input.expected?.worktreeId !== undefined
      ? { worktreeId: input.expected.worktreeId }
      : {}),
  };
  // Optional expected fields may tighten or restate leaseId / holder.
  if (input.expected?.leaseId !== undefined) {
    expected.leaseId = input.expected.leaseId;
  }
  if (input.expected?.holder !== undefined) {
    expected.holder = input.expected.holder;
  }

  const identityDiagnostics = validateWorkerCommitIdentity(
    commit,
    expected,
    "commit",
    commitBounds,
  );
  diagnostics.push(...identityDiagnostics);

  // When expected.leaseId was restated, also ensure it matches the lease itself.
  if (
    input.expected?.leaseId !== undefined
    && input.expected.leaseId.trim() !== lease.leaseId
  ) {
    diagnostics.push(reject(
      "workspace_commit_stale_identity",
      `Expected leaseId '${input.expected.leaseId.trim()}' does not match the exclusive lease id '${lease.leaseId}'.`,
      "expected.leaseId",
    ));
  }
  if (
    input.expected?.holder !== undefined
    && !holdersEqual(input.expected.holder, lease.holder)
  ) {
    diagnostics.push(reject(
      "workspace_commit_stale_identity",
      "Expected holder does not match the exclusive lease holder.",
      "expected.holder",
    ));
  }

  // Commit must reference this lease even when expected omitted leaseId override.
  if (commit.leaseId !== lease.leaseId) {
    // validateWorkerCommitIdentity already covers this when expected.leaseId is set
    // (always set from lease above). Keep defensive clarity without duplicate codes
    // when identity diagnostics already include the mismatch.
    if (!identityDiagnostics.some((d) => d.code === "workspace_commit_stale_identity")) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        `Worker commit leaseId '${commit.leaseId}' does not match exclusive lease id '${lease.leaseId}'.`,
        "commit.leaseId",
      ));
    }
  }

  diagnostics.push(...validateIntegrationWorkspaceStatus(commit.status, "commit.status"));
  diagnostics.push(
    ...validateChangedPathsWithinWriteScope(
      commit.changedPaths,
      lease.paths.writePaths,
      "commit.changedPaths",
    ),
  );

  let acceptedExecutor: ExecutorResult | undefined;

  if (input.executorResult !== undefined) {
    // Validate protocol shape before synthetic context or structuredClone so
    // class instances and missing requiredEvidence arrays return diagnostics.
    const protocolResult = input.protocol !== undefined
      ? parseIntegrationResultProtocol(input.protocol, "protocol")
      : { ok: true as const, value: defaultIntegrationResultProtocol() };

    if (!protocolResult.ok) {
      diagnostics.push(...protocolResult.diagnostics);
    } else {
      const protocol = protocolResult.value;
      const context = syntheticExecutorContext(lease.holder, protocol);
      const validateOptions: ValidateExecutorResultOptions =
        input.publishedAttemptFacts === undefined
          ? {}
          : { publishedAttemptFacts: input.publishedAttemptFacts };
      const validated = validateExecutorResult(
        context,
        input.executorResult,
        validateOptions,
      );
      if (!validated.ok) {
        diagnostics.push(...validated.diagnostics);
      } else {
        acceptedExecutor = validated.value;
        if (acceptedExecutor.workspace !== undefined) {
          diagnostics.push(
            ...validateExecutorWorkspaceMatchesCommit(
              acceptedExecutor.workspace,
              commit,
              "executorResult.workspace",
            ),
          );
        }
        if (input.checkFileEvidencePaths === true) {
          diagnostics.push(
            ...validateFileEvidencePathsWithinLeaseScope(
              acceptedExecutor.evidence,
              lease,
              "executorResult.evidence",
            ),
          );
        }
      }
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const value: ValidatedWorkerResultForIntegration = {
    commit: structuredClone(commit),
    lease: structuredClone(lease),
    ...(acceptedExecutor !== undefined
      ? { executorResult: structuredClone(acceptedExecutor) }
      : {}),
  };
  return { ok: true, value };
}
