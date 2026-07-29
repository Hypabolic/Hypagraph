/**
 * Executor context envelope and untrusted result contracts.
 *
 * An executor performs one selected node attempt. It does not define a child
 * goal and it does not mutate graph or family state.
 *
 * The controller materializes a bounded, inspectable, hashable context envelope
 * from pure canonical inputs. The executor returns a structured result envelope.
 * The controller validates that result before it commits state changes.
 *
 * Raw assistant text is not a valid canonical result.
 * A persisted executor session is optional continuity. It is not this contract.
 *
 * Domain helpers in this module are pure: no clock, random, files, network, or
 * input mutation. Timestamps appear only when callers pass them as pure inputs.
 */

import { isFactValueOfType, type FactContract, type FactType, type FactValue } from "./facts.js";
import type { GoalFamilyMember, GoalFamilyRuntime } from "./goal-family.js";
import { sha256 } from "./hash.js";
import type {
  Diagnostic,
  EvidenceReference,
  FactInput,
  HypagraphState,
  NodeStatus,
} from "./model.js";
import { projectTaskContext } from "./task-context.js";

// ---------------------------------------------------------------------------
// Identity and profile
// ---------------------------------------------------------------------------

/** Immutable attempt identity carried by context and result envelopes. */
export interface ExecutorAttemptIdentity {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
}

/**
 * Supported executor kinds.
 * Task nodes reference profiles rather than embedding transport details.
 */
export type ExecutorKind =
  | "current-session"
  | "isolated-pi"
  | "acp"
  | "cli"
  | "deterministic";

/** Profile and optional instance identity for one dispatch. */
export interface ExecutorProfileRef {
  profileId: string;
  kind: ExecutorKind;
  /** Instance identity when known (process, session, or adapter instance). */
  instanceId?: string;
}

// ---------------------------------------------------------------------------
// Context envelope contents
// ---------------------------------------------------------------------------

/** One step on the goal ancestry path from root to the executing goal. */
export interface GoalAncestryBreadcrumb {
  goalId: string;
  workflowId: string;
  depth: number;
  /** Parent node which created this member. Absent on the root. */
  parentNodeId?: string;
}

/** Read and write repository path scopes for the attempt. */
export interface ExecutorScope {
  readPaths: string[];
  writePaths: string[];
}

/** One selected upstream fact projected into the context envelope. */
export interface SelectedUpstreamFact {
  name: string;
  type: FactType;
  value: FactValue;
  producerNodeId: string;
  attemptId: string;
  revision: number;
}

/** One selected artifact or feedback reference from predecessor work. */
export interface SelectedArtifactRef {
  fromNodeId: string;
  attemptId: string;
  ref: string;
  kind: "feedback";
}

/** Bounded predecessor status summary for the context envelope. */
export interface PredecessorSummary {
  nodeId: string;
  status: NodeStatus;
  summary: string;
}

/**
 * Workspace lease and base revision for a mutating attempt.
 * Optional in M7. Required for concurrent worktree isolation in M8.
 */
export interface ExecutorWorkspaceLeaseRef {
  leaseId: string;
  baseRevision?: string;
}

/** Attempt-local budget limits passed to the executor. */
export interface AttemptBudget {
  maximumTurns?: number;
  maximumTokens?: number;
}

export type ExecutorOutcome =
  | "submitted"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export const EXECUTOR_OUTCOMES: readonly ExecutorOutcome[] = [
  "submitted",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

const EXECUTOR_OUTCOME_SET = new Set<string>(EXECUTOR_OUTCOMES);

const EXECUTOR_KIND_SET = new Set<ExecutorKind>([
  "current-session",
  "isolated-pi",
  "acp",
  "cli",
  "deterministic",
]);

const FACT_TYPES = new Set<FactType>([
  "boolean",
  "integer",
  "number",
  "string",
  "duration",
  "timestamp",
  "string-list",
]);

const EVIDENCE_KINDS = new Set(["tool", "command", "file", "approval", "note"]);
const EVIDENCE_VISIBILITIES = new Set(["public", "protected"]);

/** Default bound for selected facts in a materialized envelope. */
export const DEFAULT_MAX_SELECTED_FACTS = 32;
/** Default bound for selected artifacts in a materialized envelope. */
export const DEFAULT_MAX_SELECTED_ARTIFACTS = 16;
/** Default bound for predecessor summaries. */
export const DEFAULT_MAX_PREDECESSOR_SUMMARIES = 16;
/** Default maximum characters for one predecessor summary string. */
export const DEFAULT_MAX_PREDECESSOR_SUMMARY_CHARS = 256;
/** Default maximum characters for a result summary. */
export const DEFAULT_MAX_RESULT_SUMMARY_CHARS = 4096;
/** Default maximum diagnostics on a result. */
export const DEFAULT_MAX_RESULT_DIAGNOSTICS = 64;
/** Default maximum artifacts on a result. */
export const DEFAULT_MAX_RESULT_ARTIFACTS = 32;
/** Default maximum facts on a result. */
export const DEFAULT_MAX_RESULT_FACTS = 64;
/** Default maximum evidence references on a result (top-level or nested). */
export const DEFAULT_MAX_RESULT_EVIDENCE = 64;

/**
 * Descriptor of the structured result protocol the worker must return.
 * Raw assistant text is not a valid canonical result under this protocol.
 */
export interface StructuredResultProtocolDescriptor {
  version: 1;
  outcomes: readonly ExecutorOutcome[];
  factContracts: FactContract[];
  requiredEvidence: string[];
  maxSummaryChars: number;
  maxDiagnostics: number;
  maxArtifacts: number;
  maxFacts: number;
  maxEvidence: number;
}

/**
 * Explicit reproducible context envelope for one executor attempt.
 *
 * The envelope is bounded, inspectable, hashable, and reproducible from
 * canonical family and workflow state plus pure attempt identity inputs.
 */
export interface ExecutorContextEnvelope {
  identity: ExecutorAttemptIdentity;
  profile: ExecutorProfileRef;
  rootObjective: string;
  localObjective: string;
  ancestry: GoalAncestryBreadcrumb[];
  nodeIntent: string;
  acceptanceCriteria: string[];
  scope: ExecutorScope;
  requiredEvidence: string[];
  selectedFacts: SelectedUpstreamFact[];
  selectedArtifacts: SelectedArtifactRef[];
  predecessorSummaries: PredecessorSummary[];
  /** Absent until M8 worktree leases land. */
  workspace?: ExecutorWorkspaceLeaseRef;
  attemptBudget: AttemptBudget;
  resultProtocol: StructuredResultProtocolDescriptor;
}

// ---------------------------------------------------------------------------
// Result envelope (untrusted)
// ---------------------------------------------------------------------------

/** One diagnostic returned by an executor. Not a domain Diagnostic. */
export interface ExecutorDiagnostic {
  code: string;
  message: string;
  location?: string;
}

/** Token and turn usage reported by an executor. */
export interface ExecutorUsage {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Artifact reference returned by an executor. */
export interface ArtifactReference {
  ref: string;
  kind?: string;
  mediaType?: string;
  byteLength?: number;
  summary?: string;
}

/**
 * Workspace outcome for a mutating attempt.
 * Execution success and integration success remain separate concerns.
 */
export interface ExecutorWorkspaceResult {
  leaseId?: string;
  commitHash?: string;
  changedPaths?: string[];
  status?: "clean" | "dirty" | "conflicted" | "unknown";
}

/**
 * Structured untrusted result from one executor attempt.
 *
 * The worker submits this envelope only. The worker does not mutate graph or
 * family state. The controller validates identity and shape before commit.
 * Raw assistant text is not a valid value of this type.
 */
export interface ExecutorResult {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  outcome: ExecutorOutcome;
  facts: FactInput[];
  evidence: EvidenceReference[];
  artifacts: ArtifactReference[];
  summary: string;
  diagnostics: ExecutorDiagnostic[];
  usage: ExecutorUsage;
  workspace?: ExecutorWorkspaceResult;
}

/**
 * Transport-independent node executor.
 * Adapters for current-session, isolated Pi, ACP, CLI, and deterministic
 * executors implement this interface in later slices.
 */
export interface NodeExecutor {
  readonly id: string;
  readonly version: number;
  execute(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<ExecutorResult>;
}

/**
 * Shared inputs for building an untrusted ExecutorResult plain-object payload.
 * Current-session and isolated-pi adapters use this helper so envelopes stay
 * aligned by construction.
 */
export interface BuildExecutorResultPayloadInput {
  identity: ExecutorAttemptIdentity;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  artifacts?: ArtifactReference[];
  workspace?: ExecutorWorkspaceResult;
  /**
   * Default summary when summary is empty.
   * Each adapter supplies its own wording.
   */
  defaultSummary?: (outcome: ExecutorOutcome) => string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type MaterializeExecutorContextResult =
  | { ok: true; value: ExecutorContextEnvelope }
  | { ok: false; diagnostics: Diagnostic[] };

export type ValidateExecutorResultResult =
  | { ok: true; value: ExecutorResult }
  | { ok: false; diagnostics: Diagnostic[] };

/** Inputs for pure context materialization. Timestamps are not required. */
export interface MaterializeExecutorContextInput {
  family: GoalFamilyRuntime;
  /** Workflow state that owns identity.goalId / identity.workflowId. */
  state: HypagraphState;
  identity: ExecutorAttemptIdentity;
  profile: ExecutorProfileRef;
  /**
   * Root family objective.
   * When omitted, uses state.definition.goal as a local fallback.
   * For child goals, pass the root objective when it is known.
   */
  rootObjective?: string;
  /** Attempt budget limits. Defaults to an empty object. */
  attemptBudget?: AttemptBudget;
  /** Optional workspace lease for later M8. */
  workspace?: ExecutorWorkspaceLeaseRef;
  /**
   * Maximum selected facts. When present must be a non-negative safe integer.
   * Default is DEFAULT_MAX_SELECTED_FACTS. The bound is always enforced.
   */
  maxSelectedFacts?: number;
  /**
   * Maximum selected artifacts. When present must be a non-negative safe integer.
   * Default is DEFAULT_MAX_SELECTED_ARTIFACTS. The bound is always enforced.
   */
  maxSelectedArtifacts?: number;
  /**
   * Maximum predecessor summaries. When present must be a non-negative safe integer.
   * Default is DEFAULT_MAX_PREDECESSOR_SUMMARIES. The bound is always enforced.
   */
  maxPredecessorSummaries?: number;
  /**
   * Maximum characters for each predecessor summary.
   * Default is DEFAULT_MAX_PREDECESSOR_SUMMARY_CHARS. The bound is always enforced.
   */
  maxPredecessorSummaryChars?: number;
  /**
   * Optional filter of fact names to include.
   * When omitted, include published facts sorted by name up to the max bound.
   */
  selectedFactNames?: string[];
  /**
   * Required evidence descriptors for the result protocol.
   * Defaults to an empty list.
   */
  requiredEvidence?: string[];
  /**
   * Fact contracts for the result protocol.
   * Defaults to the node produces contracts when present.
   */
  resultFactContracts?: FactContract[];
  /**
   * Maximum result summary characters for the protocol descriptor.
   * Default is DEFAULT_MAX_RESULT_SUMMARY_CHARS.
   */
  maxResultSummaryChars?: number;
  /**
   * Maximum result diagnostics for the protocol descriptor.
   * Default is DEFAULT_MAX_RESULT_DIAGNOSTICS.
   */
  maxResultDiagnostics?: number;
  /**
   * Maximum result artifacts for the protocol descriptor.
   * Default is DEFAULT_MAX_RESULT_ARTIFACTS.
   */
  maxResultArtifacts?: number;
  /**
   * Maximum result facts for the protocol descriptor.
   * Default is DEFAULT_MAX_RESULT_FACTS. The bound is always enforced.
   */
  maxResultFacts?: number;
  /**
   * Maximum result evidence references for the protocol descriptor.
   * Default is DEFAULT_MAX_RESULT_EVIDENCE. The bound is always enforced.
   * Applies to the top-level evidence list and to nested fact evidence lists.
   */
  maxResultEvidence?: number;
}

const reject = (code: string, message: string, location?: string): { ok: false; diagnostics: Diagnostic[] } => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const rejectMany = (diagnostics: Diagnostic[]): { ok: false; diagnostics: Diagnostic[] } => ({
  ok: false,
  diagnostics,
});

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 * Matches the strict plain-object rule in family-store restore validation.
 */
const isStrictPlainObject = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isStrictPlainObject(value);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Build a plain-object untrusted result payload from attempt identity and fields.
 * The payload is not trusted until validateExecutorResult / settleExecutorResult.
 * Current-session and isolated-pi adapters share this builder.
 * Does not mutate inputs.
 */
export function buildExecutorResultPayload(
  input: BuildExecutorResultPayloadInput,
): Record<string, unknown> {
  const identity = input.identity;
  const summary = isNonEmptyString(input.summary)
    ? input.summary
    : (input.defaultSummary?.(input.outcome) ?? "The executor completed.");

  const payload: Record<string, unknown> = {
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
  if (input.workspace !== undefined) {
    payload.workspace = structuredClone(input.workspace);
  }
  return payload;
}

/**
 * Build goal ancestry breadcrumbs from the family root to the executing goal.
 * Returns root first. Pure: does not mutate family input.
 */
export function buildGoalAncestry(
  family: GoalFamilyRuntime,
  goalId: string,
): GoalAncestryBreadcrumb[] {
  const chain: GoalFamilyMember[] = [];
  let currentId: string | undefined = goalId;
  const seen = new Set<string>();
  while (currentId) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const member: GoalFamilyMember | undefined = family.members[currentId];
    if (!member) break;
    chain.push(member);
    currentId = member.parent?.parentGoalId;
  }
  chain.reverse();
  return chain.map((member) => {
    const crumb: GoalAncestryBreadcrumb = {
      goalId: member.goalId,
      workflowId: member.workflowId,
      depth: member.depth,
    };
    if (member.parent) crumb.parentNodeId = member.parent.parentNodeId;
    return crumb;
  });
}

/**
 * Compute a stable SHA-256 hash of a context envelope.
 * Hashing uses stableStringify so key order does not change the digest.
 */
export function hashExecutorContext(envelope: ExecutorContextEnvelope): string {
  return sha256(envelope);
}

/**
 * Require a plain family runtime with the nested fields materialize reads.
 * Returns diagnostics instead of throwing on incomplete structure.
 */
function validateFamilyStructure(
  family: unknown,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(family)) {
    return reject(
      "executor_context_invalid_family",
      "Family runtime must be a plain object.",
      "family",
    );
  }
  const record = family as Record<string, unknown>;
  if (!isNonEmptyString(record.familyId)) {
    return reject(
      "executor_context_invalid_family",
      "Family runtime requires a non-empty familyId.",
      "family.familyId",
    );
  }
  if (!isNonEmptyString(record.rootGoalId)) {
    return reject(
      "executor_context_invalid_family",
      "Family runtime requires a non-empty rootGoalId.",
      "family.rootGoalId",
    );
  }
  if (!isStrictPlainObject(record.members)) {
    return reject(
      "executor_context_invalid_family",
      "Family runtime requires a plain members object map.",
      "family.members",
    );
  }
  return { ok: true };
}

/**
 * Require a plain workflow state with the nested fields materialize reads.
 * Returns diagnostics instead of throwing on incomplete structure.
 */
function validateStateStructure(
  state: unknown,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(state)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state must be a plain object.",
      "state",
    );
  }
  const record = state as Record<string, unknown>;
  if (!isNonEmptyString(record.workflowId)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state requires a non-empty workflowId.",
      "state.workflowId",
    );
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state requires a non-negative safe integer revision.",
      "state.revision",
    );
  }
  if (!isStrictPlainObject(record.definition)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state requires a plain definition object.",
      "state.definition",
    );
  }
  const definition = record.definition as Record<string, unknown>;
  if (typeof definition.goal !== "string") {
    return reject(
      "executor_context_invalid_state",
      "Workflow state definition requires a string goal.",
      "state.definition.goal",
    );
  }
  if (!Array.isArray(definition.nodes)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state definition requires a nodes array.",
      "state.definition.nodes",
    );
  }
  if (!isStrictPlainObject(record.runtime)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state requires a plain runtime object.",
      "state.runtime",
    );
  }
  const runtime = record.runtime as Record<string, unknown>;
  if (!isStrictPlainObject(runtime.nodes)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state runtime requires a plain nodes object map.",
      "state.runtime.nodes",
    );
  }
  if (!isStrictPlainObject(runtime.facts)) {
    return reject(
      "executor_context_invalid_state",
      "Workflow state runtime requires a plain facts object map.",
      "state.runtime.facts",
    );
  }
  if (record.goal !== undefined) {
    if (!isStrictPlainObject(record.goal)) {
      return reject(
        "executor_context_invalid_state",
        "Workflow state goal must be a plain object when present.",
        "state.goal",
      );
    }
    const goal = record.goal as Record<string, unknown>;
    if (!isNonEmptyString(goal.goalId)) {
      return reject(
        "executor_context_invalid_state",
        "Workflow state goal requires a non-empty goalId when present.",
        "state.goal.goalId",
      );
    }
  }
  return { ok: true };
}

/**
 * Materialize a bounded executor context envelope from pure inputs.
 *
 * The envelope is reproducible: identical pure inputs produce identical envelopes
 * and therefore identical hashes. This function does not read the clock, generate
 * random values, access files or the network, or mutate its inputs.
 */
export function materializeExecutorContext(
  input: MaterializeExecutorContextInput,
): MaterializeExecutorContextResult {
  if (input === null || input === undefined) {
    return reject(
      "executor_context_invalid_input",
      "Materialize input must be a plain object.",
      "input",
    );
  }
  if (!isStrictPlainObject(input as unknown)) {
    return reject(
      "executor_context_invalid_input",
      "Materialize input must be a plain object.",
      "input",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const identity = input.identity;
  const profile = input.profile;
  const family = input.family;
  const state = input.state;

  if (!identity || !isStrictPlainObject(identity as unknown)) {
    return reject("executor_context_invalid_identity", "Executor identity must be a plain object.", "identity");
  }
  if (!isNonEmptyString(identity.familyId)) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-empty familyId.",
      location: "identity.familyId",
    });
  }
  if (!isNonEmptyString(identity.goalId)) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-empty goalId.",
      location: "identity.goalId",
    });
  }
  if (!isNonEmptyString(identity.workflowId)) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-empty workflowId.",
      location: "identity.workflowId",
    });
  }
  if (!Number.isSafeInteger(identity.revision) || identity.revision < 0) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-negative safe integer revision.",
      location: "identity.revision",
    });
  }
  if (!isNonEmptyString(identity.nodeId)) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-empty nodeId.",
      location: "identity.nodeId",
    });
  }
  if (!isNonEmptyString(identity.attemptId)) {
    diagnostics.push({
      code: "executor_context_invalid_identity",
      message: "Executor identity requires a non-empty attemptId.",
      location: "identity.attemptId",
    });
  }
  if (!profile || !isStrictPlainObject(profile as unknown)) {
    diagnostics.push({
      code: "executor_context_invalid_profile",
      message: "Executor profile must be a plain object.",
      location: "profile",
    });
  } else {
    if (!isNonEmptyString(profile.profileId)) {
      diagnostics.push({
        code: "executor_context_invalid_profile",
        message: "Executor profile requires a non-empty profileId.",
        location: "profile.profileId",
      });
    }
    if (typeof profile.kind !== "string" || !EXECUTOR_KIND_SET.has(profile.kind)) {
      diagnostics.push({
        code: "executor_context_invalid_profile",
        message: "Executor profile requires a known kind.",
        location: "profile.kind",
      });
    }
    if (profile.instanceId !== undefined && !isNonEmptyString(profile.instanceId)) {
      diagnostics.push({
        code: "executor_context_invalid_profile",
        message: "Executor profile instanceId must be a non-empty string when present.",
        location: "profile.instanceId",
      });
    }
  }

  const familyShape = validateFamilyStructure(family);
  if (!familyShape.ok) return familyShape;
  const stateShape = validateStateStructure(state);
  if (!stateShape.ok) return stateShape;

  if (diagnostics.length > 0) return rejectMany(diagnostics);

  if (family.familyId !== identity.familyId) {
    return reject(
      "executor_context_family_mismatch",
      `Family id '${family.familyId}' does not match identity familyId '${identity.familyId}'.`,
      "identity.familyId",
    );
  }

  const member = family.members[identity.goalId];
  if (!member) {
    return reject(
      "executor_context_goal_not_in_family",
      `Goal '${identity.goalId}' is not a member of family '${identity.familyId}'.`,
      "identity.goalId",
    );
  }
  if (member.workflowId !== identity.workflowId) {
    return reject(
      "executor_context_workflow_mismatch",
      `Member workflow '${member.workflowId}' does not match identity workflowId '${identity.workflowId}'.`,
      "identity.workflowId",
    );
  }
  if (state.workflowId !== identity.workflowId) {
    return reject(
      "executor_context_state_workflow_mismatch",
      `State workflow '${state.workflowId}' does not match identity workflowId '${identity.workflowId}'.`,
      "state.workflowId",
    );
  }
  if (state.revision !== identity.revision) {
    return reject(
      "executor_context_revision_mismatch",
      `State revision ${state.revision} does not match identity revision ${identity.revision}.`,
      "identity.revision",
    );
  }
  if (state.goal && state.goal.goalId !== identity.goalId) {
    return reject(
      "executor_context_state_goal_mismatch",
      `State goal '${state.goal.goalId}' does not match identity goalId '${identity.goalId}'.`,
      "identity.goalId",
    );
  }

  const node = state.definition.nodes.find((item) => item.id === identity.nodeId);
  if (!node) {
    return reject(
      "executor_context_node_missing",
      `Node '${identity.nodeId}' is not present in the workflow definition.`,
      "identity.nodeId",
    );
  }

  const maxSelectedFacts = input.maxSelectedFacts ?? DEFAULT_MAX_SELECTED_FACTS;
  if (!isNonNegativeSafeInteger(maxSelectedFacts)) {
    return reject(
      "executor_context_invalid_bound",
      "maxSelectedFacts must be a non-negative safe integer when present.",
      "maxSelectedFacts",
    );
  }
  const maxSelectedArtifacts = input.maxSelectedArtifacts ?? DEFAULT_MAX_SELECTED_ARTIFACTS;
  if (!isNonNegativeSafeInteger(maxSelectedArtifacts)) {
    return reject(
      "executor_context_invalid_bound",
      "maxSelectedArtifacts must be a non-negative safe integer when present.",
      "maxSelectedArtifacts",
    );
  }
  const maxPredecessorSummaries = input.maxPredecessorSummaries ?? DEFAULT_MAX_PREDECESSOR_SUMMARIES;
  if (!isNonNegativeSafeInteger(maxPredecessorSummaries)) {
    return reject(
      "executor_context_invalid_bound",
      "maxPredecessorSummaries must be a non-negative safe integer when present.",
      "maxPredecessorSummaries",
    );
  }
  const maxPredecessorSummaryChars =
    input.maxPredecessorSummaryChars ?? DEFAULT_MAX_PREDECESSOR_SUMMARY_CHARS;
  if (!isNonNegativeSafeInteger(maxPredecessorSummaryChars) || maxPredecessorSummaryChars < 1) {
    return reject(
      "executor_context_invalid_bound",
      "maxPredecessorSummaryChars must be a positive safe integer when present.",
      "maxPredecessorSummaryChars",
    );
  }
  const maxResultSummaryChars = input.maxResultSummaryChars ?? DEFAULT_MAX_RESULT_SUMMARY_CHARS;
  if (!isNonNegativeSafeInteger(maxResultSummaryChars) || maxResultSummaryChars < 1) {
    return reject(
      "executor_context_invalid_bound",
      "maxResultSummaryChars must be a positive safe integer when present.",
      "maxResultSummaryChars",
    );
  }
  const maxResultDiagnostics = input.maxResultDiagnostics ?? DEFAULT_MAX_RESULT_DIAGNOSTICS;
  if (!isNonNegativeSafeInteger(maxResultDiagnostics)) {
    return reject(
      "executor_context_invalid_bound",
      "maxResultDiagnostics must be a non-negative safe integer when present.",
      "maxResultDiagnostics",
    );
  }
  const maxResultArtifacts = input.maxResultArtifacts ?? DEFAULT_MAX_RESULT_ARTIFACTS;
  if (!isNonNegativeSafeInteger(maxResultArtifacts)) {
    return reject(
      "executor_context_invalid_bound",
      "maxResultArtifacts must be a non-negative safe integer when present.",
      "maxResultArtifacts",
    );
  }
  const maxResultFacts = input.maxResultFacts ?? DEFAULT_MAX_RESULT_FACTS;
  if (!isNonNegativeSafeInteger(maxResultFacts)) {
    return reject(
      "executor_context_invalid_bound",
      "maxResultFacts must be a non-negative safe integer when present.",
      "maxResultFacts",
    );
  }
  const maxResultEvidence = input.maxResultEvidence ?? DEFAULT_MAX_RESULT_EVIDENCE;
  if (!isNonNegativeSafeInteger(maxResultEvidence)) {
    return reject(
      "executor_context_invalid_bound",
      "maxResultEvidence must be a non-negative safe integer when present.",
      "maxResultEvidence",
    );
  }

  if (input.selectedFactNames !== undefined) {
    if (!Array.isArray(input.selectedFactNames)) {
      return reject(
        "executor_context_invalid_selected_fact_names",
        "selectedFactNames must be an array when present.",
        "selectedFactNames",
      );
    }
    for (let index = 0; index < input.selectedFactNames.length; index += 1) {
      if (!isNonEmptyString(input.selectedFactNames[index])) {
        return reject(
          "executor_context_invalid_selected_fact_names",
          `selectedFactNames at index ${index} must be a non-empty string.`,
          `selectedFactNames[${index}]`,
        );
      }
    }
  }

  if (input.requiredEvidence !== undefined) {
    if (!Array.isArray(input.requiredEvidence)) {
      return reject(
        "executor_context_invalid_required_evidence",
        "requiredEvidence must be an array when present.",
        "requiredEvidence",
      );
    }
    for (let index = 0; index < input.requiredEvidence.length; index += 1) {
      if (!isNonEmptyString(input.requiredEvidence[index])) {
        return reject(
          "executor_context_invalid_required_evidence",
          `requiredEvidence at index ${index} must be a non-empty string.`,
          `requiredEvidence[${index}]`,
        );
      }
    }
  }

  if (input.workspace !== undefined) {
    // Use isStrictPlainObject (boolean) so AttemptBudget/workspace types are not erased.
    if (!isStrictPlainObject(input.workspace as unknown)) {
      return reject(
        "executor_context_invalid_workspace",
        "workspace must be a plain object when present.",
        "workspace",
      );
    }
    if (!isNonEmptyString(input.workspace.leaseId)) {
      return reject(
        "executor_context_invalid_workspace",
        "workspace.leaseId must be a non-empty string.",
        "workspace.leaseId",
      );
    }
    if (
      input.workspace.baseRevision !== undefined
      && !isNonEmptyString(input.workspace.baseRevision)
    ) {
      return reject(
        "executor_context_invalid_workspace",
        "workspace.baseRevision must be a non-empty string when present.",
        "workspace.baseRevision",
      );
    }
  }

  if (input.attemptBudget !== undefined) {
    // Use isStrictPlainObject (boolean) so AttemptBudget types are not erased.
    if (!isStrictPlainObject(input.attemptBudget as unknown)) {
      return reject(
        "executor_context_invalid_attempt_budget",
        "attemptBudget must be a plain object when present.",
        "attemptBudget",
      );
    }
    if (
      input.attemptBudget.maximumTurns !== undefined
      && (!isNonNegativeSafeInteger(input.attemptBudget.maximumTurns) || input.attemptBudget.maximumTurns < 1)
    ) {
      return reject(
        "executor_context_invalid_attempt_budget",
        "attemptBudget.maximumTurns must be a positive safe integer when present.",
        "attemptBudget.maximumTurns",
      );
    }
    if (
      input.attemptBudget.maximumTokens !== undefined
      && (!isNonNegativeSafeInteger(input.attemptBudget.maximumTokens) || input.attemptBudget.maximumTokens < 1)
    ) {
      return reject(
        "executor_context_invalid_attempt_budget",
        "attemptBudget.maximumTokens must be a positive safe integer when present.",
        "attemptBudget.maximumTokens",
      );
    }
  }

  const ancestry = buildGoalAncestry(family, identity.goalId);
  if (ancestry.length === 0 || ancestry[ancestry.length - 1]?.goalId !== identity.goalId) {
    return reject(
      "executor_context_ancestry_incomplete",
      `Could not build complete ancestry for goal '${identity.goalId}'.`,
      "identity.goalId",
    );
  }

  const localObjective = state.definition.goal;
  const rootObjective = input.rootObjective ?? localObjective;

  const scopePaths = node.scope?.paths ? structuredClone(node.scope.paths) : [];
  const scope: ExecutorScope = {
    readPaths: structuredClone(scopePaths),
    writePaths: structuredClone(scopePaths),
  };

  const requiredEvidence = structuredClone(input.requiredEvidence ?? []);
  const factContracts = structuredClone(
    input.resultFactContracts ?? node.produces ?? [],
  ) as FactContract[];

  const selectedFacts = selectUpstreamFacts(state, {
    maxSelectedFacts,
    ...(input.selectedFactNames !== undefined
      ? { selectedFactNames: input.selectedFactNames }
      : {}),
  });

  // Project parent input facts captured on the child binding into the envelope.
  // Parent values are stored on the binding at child creation; they are not
  // re-read from parent runtime at materialize time.
  mergeCapturedChildInputFacts(family, identity.goalId, selectedFacts, maxSelectedFacts);

  const taskContext = projectTaskContext(state, identity.nodeId);
  const selectedArtifacts: SelectedArtifactRef[] = taskContext.feedbackArtifacts
    .slice(0, maxSelectedArtifacts)
    .map((item) => ({
      fromNodeId: item.fromNodeId,
      attemptId: item.attemptId,
      ref: item.ref,
      kind: "feedback" as const,
    }));

  const predecessorSummaries = buildPredecessorSummaries(state, node.requires, {
    maxSummaries: maxPredecessorSummaries,
    maxSummaryChars: maxPredecessorSummaryChars,
  });

  const attemptBudget: AttemptBudget = {};
  const budgetInput = input.attemptBudget;
  if (budgetInput) {
    if (budgetInput.maximumTurns !== undefined) {
      attemptBudget.maximumTurns = budgetInput.maximumTurns;
    }
    if (budgetInput.maximumTokens !== undefined) {
      attemptBudget.maximumTokens = budgetInput.maximumTokens;
    }
  }

  const profileRef: ExecutorProfileRef = {
    profileId: profile.profileId,
    kind: profile.kind,
  };
  if (profile.instanceId !== undefined) profileRef.instanceId = profile.instanceId;

  const envelope: ExecutorContextEnvelope = {
    identity: {
      familyId: identity.familyId,
      goalId: identity.goalId,
      workflowId: identity.workflowId,
      revision: identity.revision,
      nodeId: identity.nodeId,
      attemptId: identity.attemptId,
    },
    profile: profileRef,
    rootObjective,
    localObjective,
    ancestry,
    nodeIntent: node.description ?? node.title,
    acceptanceCriteria: structuredClone(node.acceptance),
    scope,
    requiredEvidence,
    selectedFacts,
    selectedArtifacts,
    predecessorSummaries,
    attemptBudget,
    resultProtocol: {
      version: 1,
      outcomes: [...EXECUTOR_OUTCOMES],
      factContracts,
      requiredEvidence: structuredClone(requiredEvidence),
      maxSummaryChars: maxResultSummaryChars,
      maxDiagnostics: maxResultDiagnostics,
      maxArtifacts: maxResultArtifacts,
      maxFacts: maxResultFacts,
      maxEvidence: maxResultEvidence,
    },
  };

  if (input.workspace) {
    envelope.workspace = {
      leaseId: input.workspace.leaseId,
      ...(input.workspace.baseRevision !== undefined
        ? { baseRevision: input.workspace.baseRevision }
        : {}),
    };
  }

  return { ok: true, value: envelope };
}

function selectUpstreamFacts(
  state: HypagraphState,
  options: { maxSelectedFacts: number; selectedFactNames?: string[] },
): SelectedUpstreamFact[] {
  const names = options.selectedFactNames
    ? [...options.selectedFactNames]
    : Object.keys(state.runtime.facts).sort((left, right) => left.localeCompare(right));

  const selected: SelectedUpstreamFact[] = [];
  for (const name of names) {
    if (selected.length >= options.maxSelectedFacts) break;
    const record = state.runtime.facts[name];
    if (!record) continue;
    selected.push({
      name: record.name,
      type: record.type,
      value: structuredClone(record.value),
      producerNodeId: record.producerNodeId,
      attemptId: record.attemptId,
      revision: record.revision,
    });
  }
  return selected;
}

/**
 * Merge parent facts captured on the child-goal binding into selectedFacts.
 * Parent inputs are prepended so they remain available under the selection bound.
 * Child runtime facts with the same name keep the child value.
 */
function mergeCapturedChildInputFacts(
  family: GoalFamilyRuntime,
  goalId: string,
  selectedFacts: SelectedUpstreamFact[],
  maxSelectedFacts: number,
): void {
  const binding = Object.values(family.bindings).find((item) => item.childGoalId === goalId);
  if (!binding || !Array.isArray(binding.capturedInputFacts) || binding.capturedInputFacts.length === 0) {
    return;
  }
  const childNames = new Set(selectedFacts.map((item) => item.name));
  const parentFacts: SelectedUpstreamFact[] = [];
  for (const captured of binding.capturedInputFacts) {
    if (childNames.has(captured.name)) continue;
    parentFacts.push({
      name: captured.name,
      type: captured.type,
      value: structuredClone(captured.value),
      producerNodeId: captured.producerNodeId,
      attemptId: captured.attemptId,
      revision: captured.revision,
    });
  }
  if (parentFacts.length === 0) return;
  const merged = [...parentFacts, ...selectedFacts].slice(0, maxSelectedFacts);
  selectedFacts.length = 0;
  selectedFacts.push(...merged);
}

function buildPredecessorSummaries(
  state: HypagraphState,
  requires: readonly string[],
  options: { maxSummaries: number; maxSummaryChars: number },
): PredecessorSummary[] {
  const summaries: PredecessorSummary[] = [];
  for (const nodeId of requires) {
    if (summaries.length >= options.maxSummaries) break;
    const runtime = state.runtime.nodes[nodeId];
    const status: NodeStatus = runtime?.status ?? "pending";
    const node = state.definition.nodes.find((item) => item.id === nodeId);
    const title = node?.title ?? nodeId;
    let summary = `${title}: ${status}`;
    if (runtime?.blockedReason) {
      summary = `${summary}; blocked: ${runtime.blockedReason}`;
    }
    if (summary.length > options.maxSummaryChars) {
      summary = summary.slice(0, options.maxSummaryChars);
    }
    summaries.push({ nodeId, status, summary });
  }
  return summaries;
}

/**
 * Validate an untrusted executor result against the dispatch context.
 *
 * Rejects identity mismatch, unknown or missing outcomes, and malformed
 * payloads. Does not mutate the input result or the context envelope.
 * Returns a deep-cloned accepted value so callers cannot observe shared mutation.
 *
 * Raw assistant text and non-object payloads are rejected with clear diagnostics.
 */
export function validateExecutorResult(
  context: ExecutorContextEnvelope,
  result: unknown,
): ValidateExecutorResultResult {
  if (context === null || context === undefined || !isStrictPlainObject(context as unknown)) {
    return reject(
      "executor_result_invalid_context",
      "Executor context must be a plain object envelope.",
      "context",
    );
  }
  if (!isStrictPlainObject((context as ExecutorContextEnvelope).identity as unknown)) {
    return reject(
      "executor_result_invalid_context",
      "Executor context requires a plain identity object.",
      "context.identity",
    );
  }
  if (!isStrictPlainObject((context as ExecutorContextEnvelope).resultProtocol as unknown)) {
    return reject(
      "executor_result_invalid_context",
      "Executor context requires a plain resultProtocol object.",
      "context.resultProtocol",
    );
  }

  if (result === null || result === undefined) {
    return reject(
      "executor_result_missing",
      "Executor result is missing. Raw assistant text is not a valid canonical result.",
      "result",
    );
  }
  if (typeof result === "string") {
    return reject(
      "executor_result_raw_text",
      "Raw assistant text is not a valid canonical executor result.",
      "result",
    );
  }
  if (!isPlainObject(result)) {
    return reject(
      "executor_result_not_object",
      "Executor result must be a plain object envelope.",
      "result",
    );
  }

  const raw: Record<string, unknown> = result;
  const diagnostics: Diagnostic[] = [];
  const identity = context.identity;
  const protocol = context.resultProtocol;

  const checkIdentityString = (field: keyof ExecutorAttemptIdentity, expected: string): void => {
    const value = raw[field];
    if (typeof value !== "string" || !value.trim()) {
      diagnostics.push({
        code: "executor_result_identity_missing",
        message: `Executor result requires a non-empty ${field}.`,
        location: field,
      });
      return;
    }
    if (value !== expected) {
      diagnostics.push({
        code: "executor_result_identity_mismatch",
        message: `Executor result ${field} '${value}' does not match context '${expected}'.`,
        location: field,
      });
    }
  };

  checkIdentityString("familyId", identity.familyId);
  checkIdentityString("goalId", identity.goalId);
  checkIdentityString("workflowId", identity.workflowId);
  checkIdentityString("nodeId", identity.nodeId);
  checkIdentityString("attemptId", identity.attemptId);

  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
    diagnostics.push({
      code: "executor_result_identity_missing",
      message: "Executor result requires a non-negative safe integer revision.",
      location: "revision",
    });
  } else if (raw.revision !== identity.revision) {
    diagnostics.push({
      code: "executor_result_identity_mismatch",
      message: `Executor result revision ${String(raw.revision)} does not match context revision ${identity.revision}.`,
      location: "revision",
    });
  }

  if (typeof raw.outcome !== "string" || !raw.outcome.trim()) {
    diagnostics.push({
      code: "executor_result_outcome_missing",
      message: "Executor result requires a non-empty outcome.",
      location: "outcome",
    });
  } else if (!EXECUTOR_OUTCOME_SET.has(raw.outcome)) {
    diagnostics.push({
      code: "executor_result_outcome_unknown",
      message: `Executor result outcome '${raw.outcome}' is not a known outcome.`,
      location: "outcome",
    });
  } else if (
    !Array.isArray(protocol.outcomes)
    || !protocol.outcomes.includes(raw.outcome as ExecutorOutcome)
  ) {
    diagnostics.push({
      code: "executor_result_outcome_not_allowed",
      message: `Executor result outcome '${raw.outcome}' is not allowed by the result protocol.`,
      location: "outcome",
    });
  }

  const maxSummaryChars = isNonNegativeSafeInteger(protocol.maxSummaryChars)
    ? protocol.maxSummaryChars
    : DEFAULT_MAX_RESULT_SUMMARY_CHARS;
  const maxDiagnostics = isNonNegativeSafeInteger(protocol.maxDiagnostics)
    ? protocol.maxDiagnostics
    : DEFAULT_MAX_RESULT_DIAGNOSTICS;
  const maxArtifacts = isNonNegativeSafeInteger(protocol.maxArtifacts)
    ? protocol.maxArtifacts
    : DEFAULT_MAX_RESULT_ARTIFACTS;
  const maxFacts = isNonNegativeSafeInteger(protocol.maxFacts)
    ? protocol.maxFacts
    : DEFAULT_MAX_RESULT_FACTS;
  const maxEvidence = isNonNegativeSafeInteger(protocol.maxEvidence)
    ? protocol.maxEvidence
    : DEFAULT_MAX_RESULT_EVIDENCE;

  if (typeof raw.summary !== "string") {
    diagnostics.push({
      code: "executor_result_invalid_summary",
      message: "Executor result summary must be a string.",
      location: "summary",
    });
  } else if (raw.summary.length > maxSummaryChars) {
    diagnostics.push({
      code: "executor_result_summary_too_long",
      message: `Executor result summary exceeds maxSummaryChars (${maxSummaryChars}).`,
      location: "summary",
    });
  }

  const factsValidation = validateExecutorFactInputs(raw.facts, maxFacts, maxEvidence, "facts");
  if (!factsValidation.ok) diagnostics.push(...factsValidation.diagnostics);

  const evidenceValidation = validateExecutorEvidenceReferences(
    raw.evidence,
    maxEvidence,
    "evidence",
  );
  if (!evidenceValidation.ok) diagnostics.push(...evidenceValidation.diagnostics);

  const artifactsValidation = validateExecutorArtifacts(
    raw.artifacts,
    maxArtifacts,
    "artifacts",
  );
  if (!artifactsValidation.ok) diagnostics.push(...artifactsValidation.diagnostics);

  const diagnosticsValidation = validateExecutorDiagnosticsList(
    raw.diagnostics,
    maxDiagnostics,
    "diagnostics",
  );
  if (!diagnosticsValidation.ok) diagnostics.push(...diagnosticsValidation.diagnostics);

  const usageValidation = validateExecutorUsage(raw.usage, "usage");
  if (!usageValidation.ok) diagnostics.push(...usageValidation.diagnostics);

  let workspace: ExecutorWorkspaceResult | undefined;
  if (raw.workspace !== undefined) {
    const workspaceValidation = validateExecutorWorkspaceResult(raw.workspace, "workspace");
    if (!workspaceValidation.ok) diagnostics.push(...workspaceValidation.diagnostics);
    else workspace = workspaceValidation.value;
  }

  // Protocol contract checks run only after shape validation so diagnostics stay clear.
  if (
    factsValidation.ok
    && evidenceValidation.ok
    && typeof raw.outcome === "string"
    && EXECUTOR_OUTCOME_SET.has(raw.outcome)
  ) {
    const protocolChecks = validateExecutorResultProtocolContracts(
      protocol,
      raw.outcome as ExecutorOutcome,
      factsValidation.facts,
      evidenceValidation.evidence,
    );
    if (!protocolChecks.ok) diagnostics.push(...protocolChecks.diagnostics);
  }

  if (diagnostics.length > 0) return rejectMany(diagnostics);
  if (
    !factsValidation.ok
    || !evidenceValidation.ok
    || !artifactsValidation.ok
    || !diagnosticsValidation.ok
    || !usageValidation.ok
  ) {
    return rejectMany(diagnostics);
  }

  const accepted: ExecutorResult = {
    familyId: identity.familyId,
    goalId: identity.goalId,
    workflowId: identity.workflowId,
    revision: identity.revision,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    outcome: raw.outcome as ExecutorOutcome,
    facts: factsValidation.facts,
    evidence: evidenceValidation.evidence,
    artifacts: artifactsValidation.artifacts,
    summary: raw.summary as string,
    diagnostics: diagnosticsValidation.diagnosticsList,
    usage: usageValidation.usage,
    ...(workspace ? { workspace } : {}),
  };

  return { ok: true, value: accepted };
}

/**
 * Validate result facts and evidence against the structured result protocol.
 *
 * - Facts that are present must be declared in protocol.factContracts with matching types.
 * - When outcome is "submitted" and protocol.requiredEvidence is non-empty, each
 *   required evidence ref must appear on the result.
 * - Required fact contracts are not forced onto the executor result when empty:
 *   callers may publish required facts through a separate publish-facts step.
 *   The reducer still enforces required produces contracts on publish.
 */
function validateExecutorResultProtocolContracts(
  protocol: StructuredResultProtocolDescriptor,
  outcome: ExecutorOutcome,
  facts: readonly FactInput[],
  evidence: readonly EvidenceReference[],
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const contracts = Array.isArray(protocol.factContracts) ? protocol.factContracts : [];
  const contractByName = new Map(contracts.map((contract) => [contract.name, contract]));

  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index]!;
    const contract = contractByName.get(fact.name);
    if (!contract) {
      diagnostics.push({
        code: "executor_result_fact_not_declared",
        message: `Executor result fact '${fact.name}' is not declared by the result protocol fact contracts.`,
        location: `facts[${index}].name`,
      });
      continue;
    }
    if (fact.type !== contract.type) {
      diagnostics.push({
        code: "executor_result_fact_type_mismatch",
        message: `Executor result fact '${fact.name}' has type '${fact.type}' but the protocol `
          + `requires type '${contract.type}'.`,
        location: `facts[${index}].type`,
      });
    }
  }

  if (outcome === "submitted") {
    const requiredEvidence = Array.isArray(protocol.requiredEvidence)
      ? protocol.requiredEvidence
      : [];
    if (requiredEvidence.length > 0) {
      const evidenceRefs = new Set(evidence.map((item) => item.ref));
      for (let index = 0; index < requiredEvidence.length; index += 1) {
        const required = requiredEvidence[index]!;
        if (!evidenceRefs.has(required)) {
          diagnostics.push({
            code: "executor_result_required_evidence_missing",
            message: `Executor result is missing required evidence '${required}'.`,
            location: `resultProtocol.requiredEvidence[${index}]`,
          });
        }
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true };
}

function validateExecutorFactInputs(
  value: unknown,
  maxFacts: number,
  maxEvidence: number,
  location: string,
): { ok: true; facts: FactInput[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_facts_missing",
        message: "Executor result facts must be an array.",
        location,
      }],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_facts",
        message: "Executor result facts must be an array.",
        location,
      }],
    };
  }
  if (value.length > maxFacts) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_facts_too_many",
        message: `Executor result facts exceed maxFacts (${maxFacts}).`,
        location,
      }],
    };
  }

  const facts: FactInput[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) {
      diagnostics.push({
        code: "executor_result_invalid_facts",
        message: `Fact at index ${index} must be a plain object.`,
        location: `${location}[${index}]`,
      });
      continue;
    }
    if (!isNonEmptyString(item.name)) {
      diagnostics.push({
        code: "executor_result_invalid_facts",
        message: `Fact at index ${index} requires a non-empty name.`,
        location: `${location}[${index}].name`,
      });
      continue;
    }
    if (seen.has(item.name)) {
      diagnostics.push({
        code: "executor_result_duplicate_fact",
        message: `Fact '${item.name}' is supplied more than once.`,
        location: `${location}[${index}].name`,
      });
      continue;
    }
    if (typeof item.type !== "string" || !FACT_TYPES.has(item.type as FactType)) {
      diagnostics.push({
        code: "executor_result_invalid_facts",
        message: `Fact '${item.name}' requires a known fact type.`,
        location: `${location}[${index}].type`,
      });
      continue;
    }
    const factType = item.type as FactType;
    if (!isFactValueOfType(factType, item.value as FactValue)) {
      diagnostics.push({
        code: "executor_result_invalid_fact_value",
        message: `Fact '${item.name}' has an invalid value for type '${factType}'.`,
        location: `${location}[${index}].value`,
      });
      continue;
    }

    const fact: FactInput = {
      name: item.name,
      type: factType,
      value: structuredClone(item.value) as FactValue,
    };

    if (item.evidence !== undefined) {
      const evidenceValidation = validateExecutorEvidenceReferences(
        item.evidence,
        maxEvidence,
        `${location}[${index}].evidence`,
      );
      if (!evidenceValidation.ok) {
        diagnostics.push(...evidenceValidation.diagnostics);
        continue;
      }
      fact.evidence = evidenceValidation.evidence;
    }

    seen.add(item.name);
    facts.push(fact);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, facts };
}

function validateExecutorEvidenceReferences(
  value: unknown,
  maxEvidence: number,
  location: string,
): { ok: true; evidence: EvidenceReference[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_evidence_missing",
        message: "Executor result evidence must be an array.",
        location,
      }],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_evidence",
        message: "Executor result evidence must be an array.",
        location,
      }],
    };
  }
  if (value.length > maxEvidence) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_evidence_too_many",
        message: `Executor result evidence exceeds maxEvidence (${maxEvidence}).`,
        location,
      }],
    };
  }

  const evidence: EvidenceReference[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) {
      diagnostics.push({
        code: "executor_result_invalid_evidence",
        message: `Evidence at index ${index} must be a plain object.`,
        location: `${location}[${index}]`,
      });
      continue;
    }
    if (!isNonEmptyString(item.ref)) {
      diagnostics.push({
        code: "executor_result_invalid_evidence",
        message: `Evidence at index ${index} requires a non-empty ref.`,
        location: `${location}[${index}].ref`,
      });
      continue;
    }
    if (item.kind !== undefined && (typeof item.kind !== "string" || !EVIDENCE_KINDS.has(item.kind))) {
      diagnostics.push({
        code: "executor_result_invalid_evidence",
        message: `Evidence at index ${index} has an unsupported kind.`,
        location: `${location}[${index}].kind`,
      });
      continue;
    }
    if (
      item.visibility !== undefined
      && (typeof item.visibility !== "string" || !EVIDENCE_VISIBILITIES.has(item.visibility))
    ) {
      diagnostics.push({
        code: "executor_result_invalid_evidence",
        message: `Evidence at index ${index} has an unsupported visibility.`,
        location: `${location}[${index}].visibility`,
      });
      continue;
    }
    if (item.summary !== undefined && typeof item.summary !== "string") {
      diagnostics.push({
        code: "executor_result_invalid_evidence",
        message: `Evidence at index ${index} summary must be a string when present.`,
        location: `${location}[${index}].summary`,
      });
      continue;
    }

    const reference: EvidenceReference = { ref: item.ref };
    if (typeof item.kind === "string") {
      reference.kind = item.kind as NonNullable<EvidenceReference["kind"]>;
    }
    if (typeof item.summary === "string") reference.summary = item.summary;
    if (typeof item.visibility === "string") {
      reference.visibility = item.visibility as NonNullable<EvidenceReference["visibility"]>;
    }
    evidence.push(reference);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, evidence };
}

function validateExecutorArtifacts(
  value: unknown,
  maxArtifacts: number,
  location: string,
): { ok: true; artifacts: ArtifactReference[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_artifacts_missing",
        message: "Executor result artifacts must be an array.",
        location,
      }],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_artifacts",
        message: "Executor result artifacts must be an array.",
        location,
      }],
    };
  }
  if (value.length > maxArtifacts) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_artifacts_too_many",
        message: `Executor result artifacts exceed maxArtifacts (${maxArtifacts}).`,
        location,
      }],
    };
  }

  const artifacts: ArtifactReference[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} must be a plain object.`,
        location: `${location}[${index}]`,
      });
      continue;
    }
    if (!isNonEmptyString(item.ref)) {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} requires a non-empty ref.`,
        location: `${location}[${index}].ref`,
      });
      continue;
    }
    if (item.kind !== undefined && typeof item.kind !== "string") {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} kind must be a string when present.`,
        location: `${location}[${index}].kind`,
      });
      continue;
    }
    if (item.mediaType !== undefined && typeof item.mediaType !== "string") {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} mediaType must be a string when present.`,
        location: `${location}[${index}].mediaType`,
      });
      continue;
    }
    if (
      item.byteLength !== undefined
      && (!isNonNegativeSafeInteger(item.byteLength))
    ) {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} byteLength must be a non-negative safe integer when present.`,
        location: `${location}[${index}].byteLength`,
      });
      continue;
    }
    if (item.summary !== undefined && typeof item.summary !== "string") {
      diagnostics.push({
        code: "executor_result_invalid_artifacts",
        message: `Artifact at index ${index} summary must be a string when present.`,
        location: `${location}[${index}].summary`,
      });
      continue;
    }

    const artifact: ArtifactReference = { ref: item.ref };
    if (typeof item.kind === "string") artifact.kind = item.kind;
    if (typeof item.mediaType === "string") artifact.mediaType = item.mediaType;
    if (typeof item.byteLength === "number") artifact.byteLength = item.byteLength;
    if (typeof item.summary === "string") artifact.summary = item.summary;
    artifacts.push(artifact);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, artifacts };
}

function validateExecutorDiagnosticsList(
  value: unknown,
  maxDiagnostics: number,
  location: string,
): { ok: true; diagnosticsList: ExecutorDiagnostic[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_diagnostics_missing",
        message: "Executor result diagnostics must be an array.",
        location,
      }],
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_diagnostics",
        message: "Executor result diagnostics must be an array.",
        location,
      }],
    };
  }
  if (value.length > maxDiagnostics) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_diagnostics_too_many",
        message: `Executor result diagnostics exceed maxDiagnostics (${maxDiagnostics}).`,
        location,
      }],
    };
  }

  const list: ExecutorDiagnostic[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) {
      diagnostics.push({
        code: "executor_result_invalid_diagnostics",
        message: `Diagnostic at index ${index} must be a plain object.`,
        location: `${location}[${index}]`,
      });
      continue;
    }
    if (!isNonEmptyString(item.code)) {
      diagnostics.push({
        code: "executor_result_invalid_diagnostics",
        message: `Diagnostic at index ${index} requires a non-empty code.`,
        location: `${location}[${index}].code`,
      });
      continue;
    }
    if (typeof item.message !== "string" || !item.message.trim()) {
      diagnostics.push({
        code: "executor_result_invalid_diagnostics",
        message: `Diagnostic at index ${index} requires a non-empty message.`,
        location: `${location}[${index}].message`,
      });
      continue;
    }
    if (item.location !== undefined && typeof item.location !== "string") {
      diagnostics.push({
        code: "executor_result_invalid_diagnostics",
        message: `Diagnostic at index ${index} location must be a string when present.`,
        location: `${location}[${index}].location`,
      });
      continue;
    }
    const entry: ExecutorDiagnostic = {
      code: item.code,
      message: item.message,
    };
    if (typeof item.location === "string") entry.location = item.location;
    list.push(entry);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, diagnosticsList: list };
}

function validateExecutorUsage(
  value: unknown,
  location: string,
): { ok: true; usage: ExecutorUsage } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_usage_missing",
        message: "Executor result usage must be a plain object.",
        location,
      }],
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_usage",
        message: "Executor result usage must be a plain object.",
        location,
      }],
    };
  }

  const usage: ExecutorUsage = {};
  const fields = ["turns", "inputTokens", "outputTokens", "totalTokens"] as const;
  for (const field of fields) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (!isNonNegativeSafeInteger(raw)) {
      return {
        ok: false,
        diagnostics: [{
          code: "executor_result_invalid_usage",
          message: `Executor result usage.${field} must be a non-negative safe integer when present.`,
          location: `${location}.${field}`,
        }],
      };
    }
    usage[field] = raw;
  }
  return { ok: true, usage };
}

const WORKSPACE_RESULT_STATUSES = new Set(["clean", "dirty", "conflicted", "unknown"]);

function validateExecutorWorkspaceResult(
  value: unknown,
  location: string,
): { ok: true; value: ExecutorWorkspaceResult } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "executor_result_invalid_workspace",
        message: "Executor result workspace must be a plain object when present.",
        location,
      }],
    };
  }

  const workspace: ExecutorWorkspaceResult = {};

  if (value.leaseId !== undefined) {
    if (!isNonEmptyString(value.leaseId)) {
      return {
        ok: false,
        diagnostics: [{
          code: "executor_result_invalid_workspace",
          message: "Executor result workspace.leaseId must be a non-empty string when present.",
          location: `${location}.leaseId`,
        }],
      };
    }
    workspace.leaseId = value.leaseId;
  }
  if (value.commitHash !== undefined) {
    if (!isNonEmptyString(value.commitHash)) {
      return {
        ok: false,
        diagnostics: [{
          code: "executor_result_invalid_workspace",
          message: "Executor result workspace.commitHash must be a non-empty string when present.",
          location: `${location}.commitHash`,
        }],
      };
    }
    workspace.commitHash = value.commitHash;
  }
  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || !value.changedPaths.every((item) => typeof item === "string")) {
      return {
        ok: false,
        diagnostics: [{
          code: "executor_result_invalid_workspace",
          message: "Executor result workspace.changedPaths must be a string array when present.",
          location: `${location}.changedPaths`,
        }],
      };
    }
    workspace.changedPaths = [...value.changedPaths];
  }
  if (value.status !== undefined) {
    if (typeof value.status !== "string" || !WORKSPACE_RESULT_STATUSES.has(value.status)) {
      return {
        ok: false,
        diagnostics: [{
          code: "executor_result_invalid_workspace",
          message: "Executor result workspace.status must be a known status when present.",
          location: `${location}.status`,
        }],
      };
    }
    workspace.status = value.status as NonNullable<ExecutorWorkspaceResult["status"]>;
  }

  return { ok: true, value: workspace };
}
