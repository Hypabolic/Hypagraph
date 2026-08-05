import type { Condition } from "./conditions.js";
import type { FactContract, FactRecord, FactType, FactValue } from "./facts.js";

export const HYPAGRAPH_SCHEMA_VERSION = 5 as const;
export const HYPAGRAPH_EVENT_VERSION = 1 as const;

export type WorkflowPhase = "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled";

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "completed" | "failed" | "cancelled";

export type GoalPauseCause = "explicit" | "workflow" | "session_reload" | "branch_change" | "usage_invalid";
export type GoalBudgetStopReason = "turn_limit" | "token_limit";
export type GoalTurnUsageSource = "pi-assistant-usage-v1";

export interface GoalBudgetDefinition {
  maximumTurns?: number;
  maximumTokens?: number;
}

export interface GoalTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface GoalBudgetStop {
  reason: GoalBudgetStopReason;
  limit: number;
  consumed: number;
  at: string;
}

export interface GoalTurnIdentity {
  turnId: string;
  continuationOperationId: string;
  continuationOrdinal: number;
  requestSequence: number;
  selectedSequence: number;
  selectedSnapshotHash: string;
  sessionGeneration: number;
  branchGeneration: number;
}

export interface GoalAccountedTurn extends GoalTurnIdentity {
  source: GoalTurnUsageSource;
  usage: GoalTokenUsage;
  accountedAt: string;
}

export interface GoalBudgetRuntime {
  limits: GoalBudgetDefinition;
  consumedTurns: number;
  consumedTokens: GoalTokenUsage;
  lastAccountedTurn?: GoalAccountedTurn;
  stop?: GoalBudgetStop;
}

export type GoalWorkContinuationActionKind =
  | "continue-active-task"
  | "start-ready-task"
  | "run-ready-check"
  | "run-ready-code"
  | "run-ready-effect"
  | "reconcile-indeterminate-effect"
  | "evaluate-ready-gate"
  | "request-ready-interaction";

export type GoalBlockerKind =
  | "blocked-node"
  | "blocked-loop"
  | "loop-dependants"
  | "legacy-definition"
  | "definition-no-path"
  | "external-dependency"
  | "terminal-policy";

export interface GoalBlockerIdentity {
  kind: GoalBlockerKind;
  id: string;
  reason: string;
  sourceRevision: number;
  sourceSequence: number;
  sourceSnapshotHash: string;
}

export interface GoalWorkContinuationAction {
  kind: GoalWorkContinuationActionKind;
  nodeId: string;
  loopId?: string;
}

export interface GoalRevisionContinuationAction {
  kind: "request-revision";
  blocker: GoalBlockerIdentity;
}

export type GoalContinuationAction = GoalWorkContinuationAction | GoalRevisionContinuationAction;

export interface GoalContinuationRequestRuntime {
  operationId: string;
  ordinal: number;
  action: GoalContinuationAction;
  selectedRevision: number;
  selectedSequence: number;
  selectedSnapshotHash: string;
  requestSequence: number;
  sessionGeneration: number;
  branchGeneration: number;
  requestedAt: string;
}

export type GoalAutomaticRevisionOutcome = "pending" | "applied" | "rejected" | "abandoned";

export interface GoalAutomaticRevisionAttempt {
  operationId: string;
  blocker: GoalBlockerIdentity;
  sourceRevision: number;
  sourceSequence: number;
  sourceSnapshotHash: string;
  requestSequence: number;
  sessionGeneration: number;
  branchGeneration: number;
  requestedAt: string;
  outcome: GoalAutomaticRevisionOutcome;
  outcomeCode?: string;
  reason?: string;
  completedAt?: string;
  appliedRevision?: number;
}

export interface GoalAutomaticRevisionRuntime {
  maximumAttempts: 1;
  consumedAttempts: number;
  lastAttempt?: GoalAutomaticRevisionAttempt;
}

export interface GoalRuntime {
  goalId: string;
  workflowId: string;
  status: GoalStatus;
  continuationOrdinal: number;
  budget: GoalBudgetRuntime;
  automaticRevision: GoalAutomaticRevisionRuntime;
  pendingContinuation?: GoalContinuationRequestRuntime;
  pauseCause?: GoalPauseCause;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  stopReason?: string;
}
export type NodeStatus =
  | "pending"
  | "ready"
  | "starting"
  | "running"
  | "awaiting_evidence"
  | "awaiting_response"
  | "waiting_for_child"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "stale";
export type AttemptStatus = "running" | "submitted" | "verifying" | "succeeded" | "failed" | "cancelled";
export type EnforcementMode = "guided" | "strict";
export type NodeKind = "task" | "gate" | "check" | "interaction" | "code" | "effect";
export type InteractionPresentationClass = "deterministic" | "semantic";
export type InteractionPresentationKind = "none" | "report" | "command";
export type InteractionPresentationStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "error";

/** No external presentation effect. The question alone is the surface. */
export interface InteractionPresentationNone {
  class: InteractionPresentationClass;
  kind: "none";
}

/**
 * Render a Markdown or plain-text report from a canonical projection of workflow state.
 * The report content is a pure function of the state and the interaction node.
 */
export interface InteractionPresentationReport {
  class: InteractionPresentationClass;
  kind: "report";
  /** Default is text/markdown. */
  mediaType?: "text/markdown; charset=utf-8" | "text/plain; charset=utf-8";
  /** Maximum artifact size in bytes. Default is 1_048_576. */
  maxBytes?: number;
}

/**
 * Run a bounded command which produces a presentation artifact.
 * The command uses the same bounds as a command check: no shell, timeout, workspace root.
 */
export interface InteractionPresentationCommand {
  class: InteractionPresentationClass;
  kind: "command";
  command: string;
  arguments?: string[];
  workingDirectory?: string;
  timeoutMs: number;
  expectedExitCodes?: number[];
  environmentVariables?: string[];
  /** Maximum captured stdout and stderr size in bytes. Default is 1_048_576. */
  maxOutputBytes?: number;
}

export type InteractionPresentation =
  | InteractionPresentationNone
  | InteractionPresentationReport
  | InteractionPresentationCommand;

/** Observation which the present-interaction command stores on an attempt. */
export interface InteractionPresentationObservation {
  status: InteractionPresentationStatus;
  kind: InteractionPresentationKind;
  presentedAt: string;
  artifactRef?: string;
  error?: string;
  evidence?: EvidenceReference[];
}

export interface InteractionResponseOption {
  id: string;
  label: string;
  /** One short sentence which explains the effect of this response. */
  description?: string;
  /** The author recommends this response. At most one response can set it. */
  recommended?: boolean;
  publish: FactInput[];
}

/**
 * An open question. The person types the answer.
 *
 * Use an open question when a model-backed task needs a clarification which has
 * no fixed set of answers. The typed answer reaches one declared string fact.
 * A gate must never route on that fact.
 */
export interface InteractionOpenAnswer {
  prompt: string;
  maxBytes: number;
  /** The declared string fact which receives the typed answer. */
  fact: string;
}

/**
 * Optional free-text notes on a closed question.
 *
 * Notes are evidence only. They never publish a routing fact. Do not set freeText
 * with openAnswer. An open question already captures free text as the answer.
 */
export interface InteractionFreeText {
  prompt: string;
  maxBytes: number;
}

/**
 * Optional structured feedback which the presentation surface returns.
 *
 * The artifact is stored by identity. The next task receives it through an
 * explicit context projection. A gate must never route on feedback content.
 */
export interface InteractionFeedbackDefinition {
  maxBytes: number;
  /** Default is application/json; charset=utf-8. */
  mediaType?: string;
}

/**
 * Absolute deadline which the request event stores.
 *
 * Prefer a supplied evaluation time on wake, resume, and reload so tests and
 * replay stay stable. Absolute domain purity is not required; see AGENTS.md.
 */
export interface InteractionDeadline {
  absolute: string;
  source: "requested-at-plus-duration" | "declared-absolute";
}

/**
 * Level-triggered timeout for an unanswered interaction.
 *
 * Supply durationMs or absolute, not both. On request the runtime stores one
 * absolute deadline. On the next controller wake it evaluates that deadline.
 */
export interface InteractionTimeoutDefinition {
  durationMs?: number;
  absolute?: string;
  onTimeout: "block" | "select";
  /** Required when onTimeout is select. Must match a declared response id. */
  selectResponseId?: string;
}

export interface InteractionDefinition {
  kind: "interaction";
  version: 1;
  presentation: InteractionPresentation;
  question: string;
  /** A closed question. The person selects exactly one declared response. */
  responses?: InteractionResponseOption[];
  /** An open question. The person types the answer. */
  openAnswer?: InteractionOpenAnswer;
  /** Optional free-text notes on a closed question. Evidence only. */
  freeText?: InteractionFreeText;
  /** Optional structured feedback artifact from the presentation surface. */
  feedback?: InteractionFeedbackDefinition;
  /** Optional absolute or relative deadline for an unanswered interaction. */
  timeout?: InteractionTimeoutDefinition;
}

/**
 * Explicit context bindings for a task node.
 *
 * feedbackFrom lists interaction node ids. The task context projection includes
 * feedback artifact refs from those interactions after they succeed.
 */
export interface TaskContextDefinition {
  feedbackFrom: string[];
}

/**
 * Feedback artifact reference which an answer stores on the attempt.
 * The extension stores content by identity first, then passes the ref.
 */
export interface InteractionFeedbackArtifactInput {
  ref: string;
  mediaType?: string;
  byteLength?: number;
}

export type EvidenceVisibility = "public" | "protected";

export interface EvidenceReference {
  ref: string;
  kind?: "tool" | "command" | "file" | "approval" | "note";
  summary?: string;
  visibility?: EvidenceVisibility;
}

export interface GateDefinition {
  condition: Condition;
  onTrue: string[];
  onFalse: string[];
}

export type CheckKind = "command" | "test-report" | "lint-report" | "coverage-report" | "metric-report" | "file-assertion" | "git-assertion";
export type CheckResultStatus = "passed" | "failed" | "timed_out" | "cancelled" | "interrupted" | "error";
export type CheckFactSource = "passed" | "status" | "exitCode" | "durationMs" | "timedOut" | "cancelled";
export type CheckRetryStatus = "failed" | "timed_out" | "error";

export interface FactMapping {
  source: CheckFactSource;
  fact: string;
}

export interface CheckRetryPolicy {
  maxAttempts: number;
  retryOn: CheckRetryStatus[];
  backoffMs?: number;
}

export interface CommandExecutionDefinition {
  command: string;
  arguments?: string[];
  workingDirectory?: string;
  timeoutMs: number;
  expectedExitCodes?: number[];
  environmentVariables?: string[];
  retry?: CheckRetryPolicy;
}

export interface CommandCheckDefinition extends CommandExecutionDefinition {
  kind: "command";
  publish: FactMapping[];
}

export type ReportParserName = "vitest-json" | "eslint-json" | "istanbul-coverage-summary" | "metric-json";

export interface ReportParserDefinition {
  name: ReportParserName;
  version: 1;
}

export interface ReportCheckDefinition extends CommandExecutionDefinition {
  kind: "test-report" | "lint-report" | "coverage-report";
  reportPath: string;
  parser: ReportParserDefinition;
  namespace: string;
  maxReportBytes?: number;
}

export type MetricScalarType = "boolean" | "integer" | "number" | "string";
export type EvaluationKind = "development" | "probe" | "holdout";
export type EvaluationFeedbackMode = "aggregate" | "bounded-diagnostics";
export type EvaluatorTrustLevel = "transparent" | "protected" | "isolated";

export interface EvaluationFeedbackPolicy {
  mode: EvaluationFeedbackMode;
  maximumDiagnosticItems?: number;
  exposeRawReport?: boolean;
}

export interface ProtectedPathDefinition {
  path: string;
  sha256: string;
  maxBytes?: number;
}

export interface EvaluationGitIntegrityDefinition {
  expectedRevision?: string;
  requireCleanWorktree?: true;
  protectedPathsUnchangedFrom?: string;
}

export interface EvaluatorVersionDefinition {
  value: string;
  fact?: string;
}

export interface EvaluationIntegrityDefinition {
  trustLevel: EvaluatorTrustLevel;
  protectedPaths?: ProtectedPathDefinition[];
  git?: EvaluationGitIntegrityDefinition;
  evaluatorVersion?: EvaluatorVersionDefinition;
}

export interface MetricEvaluationDefinition {
  kind: EvaluationKind;
  feedback: EvaluationFeedbackPolicy;
  integrity?: EvaluationIntegrityDefinition;
}

export interface EvaluationDiagnostic {
  code: string;
  message: string;
}

export type EvaluationIntegrityEvidenceKind =
  | "protected-file-sha256"
  | "git-exact-revision"
  | "git-clean-worktree"
  | "git-protected-paths-unchanged";

export interface EvaluationIntegrityEvidence {
  kind: EvaluationIntegrityEvidenceKind;
  status: "verified" | "mismatch" | "error";
}

export interface EvaluationIntegrityObservation {
  version: 1;
  trustLevel: "transparent" | "protected";
  status: "valid" | "invalid";
  evaluatorVersion?: string;
  evaluatorFingerprint: string;
  diagnosticCodes: string[];
  protectedEvidence: EvaluationIntegrityEvidence[];
}

export interface MetricReportMapping {
  source: string;
  fact: string;
  type: MetricScalarType;
  required?: boolean;
}

export interface MetricReportCheckDefinition extends CommandExecutionDefinition {
  kind: "metric-report";
  reportPath: string;
  parser: { name: "metric-json"; version: 1 };
  mappings: MetricReportMapping[];
  maxReportBytes?: number;
  evaluation?: MetricEvaluationDefinition;
}

export type FileAssertionDefinition =
  | { kind: "exists"; path: string }
  | { kind: "absent"; path: string }
  | { kind: "size"; path: string; bytes: number }
  | { kind: "sha256"; path: string; hash: string; maxBytes?: number }
  | { kind: "text-contains"; path: string; text: string; maxBytes?: number };

export type GitAssertionDefinition =
  | { kind: "clean" }
  | { kind: "branch"; name: string }
  | { kind: "revision"; sha: string }
  | { kind: "exact-revision"; sha: string }
  | { kind: "unchanged-paths"; paths: string[]; baseRevision: string }
  | { kind: "changed-paths"; paths: string[]; mode?: "exact" | "contains" };

export interface FileAssertionCheckDefinition {
  kind: "file-assertion";
  version: 1;
  assertion: FileAssertionDefinition;
  namespace: string;
  retry?: CheckRetryPolicy;
}

export interface GitAssertionCheckDefinition {
  kind: "git-assertion";
  version: 1;
  assertion: GitAssertionDefinition;
  namespace: string;
  retry?: CheckRetryPolicy;
}

export type CheckDefinition =
  | CommandCheckDefinition
  | ReportCheckDefinition
  | MetricReportCheckDefinition
  | FileAssertionCheckDefinition
  | GitAssertionCheckDefinition;

export interface CheckResult {
  checkKind: CheckKind;
  attemptId: string;
  startedAt: string;
  completedAt: string;
  status: CheckResultStatus;
  exitCode?: number;
  facts: FactInput[];
  evidence: EvidenceReference[];
  stdoutRef?: string;
  stderrRef?: string;
  evaluation?: {
    kind: EvaluationKind;
    feedbackMode: EvaluationFeedbackMode;
    diagnostics: EvaluationDiagnostic[];
    diagnosticsTruncated: boolean;
    integrity?: EvaluationIntegrityObservation;
  };
  error?: string;
}

export interface CheckExecutionRequest {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  definition: CheckDefinition;
}

export interface CheckExecutor {
  execute(request: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult>;
}

/**
 * Effect class for a bridge capability.
 * A code node may use pure, observation, and declared workspace-mutation only.
 */
export type CapabilityEffectClass =
  | "pure"
  | "observation"
  | "workspace-mutation"
  | "external-effect";

/**
 * One declared host surface for a sandbox program.
 * The bridge denies every action which is not on this allowlist.
 */
export type CodeCapability =
  | {
    kind: "pure";
    effectClass: "pure";
  }
  | {
    kind: "pi-tool";
    name: string;
    effectClass: CapabilityEffectClass;
  }
  | {
    kind: "mcp";
    server: string;
    methods: string[];
    effectClass: CapabilityEffectClass;
  }
  | {
    kind: "workspace-read";
    paths: string[];
    effectClass: "observation";
  }
  | {
    kind: "workspace-write";
    paths: string[];
    effectClass: "workspace-mutation";
  };

/** Pinned compiler and sandbox identity. Include this in the snapshot hash. */
export interface SandboxRuntimeIdentity {
  typescriptVersion: string;
  compilerOptions: Record<string, unknown>;
  languageTarget: string;
  ambientTypesFingerprint: string;
  quickjsVersion: string;
  bridgeSchemaFingerprint: string;
}

/**
 * Reusable executable body for a code node.
 * M6.3 reuses this shape for effect and reconciliation programs.
 */
export interface SandboxProgramDefinition {
  version: 1;
  program: string;
  /** Deterministic compiled JavaScript. Persist this so replay does not need the TypeScript compiler. */
  compiledJavaScript?: string;
  compiledHash?: string;
  inputs: string[];
  capabilities: CodeCapability[];
  timeoutMs: number;
  maxMemoryBytes: number;
  maxBridgeCalls: number;
  maxResultBytes: number;
  runtimeIdentity: SandboxRuntimeIdentity;
}

export interface CodeNodeDefinition {
  kind: "code";
  execution: SandboxProgramDefinition;
  retry?: CheckRetryPolicy;
}

/**
 * External effect node.
 * Stores requested before the external call, observes the outcome, and reconciles when the result is lost.
 */
export interface EffectNodeDefinition {
  kind: "effect";
  version: 1;
  effect: SandboxProgramDefinition;
  reconcile: SandboxProgramDefinition;
  idempotency: { from: "canonical-identity" };
  /** External identity facts which observation or reconciliation may publish. */
  externalIdentity: FactContract[];
  onIndeterminate: "block-dependants" | "fail-workflow";
}

/** Durable effect knowledge. Separate from local sandbox execution success. */
export type EffectDurableState = "requested" | "observed" | "indeterminate";

/** Confirmed external outcome. Present only when durableState is observed. */
export type EffectObservedOutcome = "success" | "failure";

export type EffectReconciliationDecision = "observed-success" | "observed-failure" | "undecidable";

export type CodeResultStatus = CheckResultStatus;

export interface CodeBridgeCallAudit {
  action: string;
  argsHash: string;
  resultHash?: string;
  status: "ok" | "denied" | "error";
  error?: string;
}

export interface CodeScopeVerification {
  passed: boolean;
  /** Paths the program changed after baseline filtering. */
  changedPaths?: string[];
  /**
   * Paths dirty before the program ran.
   * Further modifications of these paths are detected by content hash.
   */
  baselinePaths?: string[];
  error?: string;
}

export interface CodeResult {
  attemptId: string;
  startedAt: string;
  completedAt: string;
  status: CodeResultStatus;
  /** Untrusted program return value before fact validation. */
  value?: unknown;
  facts: FactInput[];
  evidence: EvidenceReference[];
  bridgeCalls?: CodeBridgeCallAudit[];
  scopeVerification?: CodeScopeVerification;
  runtimeIdentity?: SandboxRuntimeIdentity;
  error?: string;
}

/**
 * Durable effect observation on an attempt.
 * Execution success (sandbox) and external success remain separate fields.
 */
export interface EffectObservation {
  durableState: EffectDurableState;
  idempotencyKey: string;
  requestedAt: string;
  observedAt?: string;
  observedOutcome?: EffectObservedOutcome;
  /** Local sandbox status for the effect program. Not proof of external success. */
  executionStatus?: CheckResultStatus;
  externalIdentityFacts?: FactInput[];
  reconciliationAttempts: number;
  lastReconciliationAt?: string;
  lastReconciliationDecision?: EffectReconciliationDecision;
  value?: unknown;
  bridgeCalls?: CodeBridgeCallAudit[];
  evidence: EvidenceReference[];
  error?: string;
  effectProgramResult?: CodeResult;
  reconcileProgramResult?: CodeResult;
}

export interface CodeExecutionRequest {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  definition: CodeNodeDefinition;
  bindings: Record<string, FactValue>;
  /** Declared repository scope paths for mutation verification. */
  scopePaths?: string[];
  produces: FactContract[];
}

export interface CodeExecutor {
  readonly id: string;
  readonly version: number;
  execute(request: CodeExecutionRequest, signal: AbortSignal): Promise<CodeResult>;
}

export type EffectProgramPhase = "effect" | "reconcile";

export interface EffectExecutionRequest {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  phase: EffectProgramPhase;
  definition: EffectNodeDefinition;
  program: SandboxProgramDefinition;
  bindings: Record<string, FactValue>;
  idempotencyKey: string;
  produces: FactContract[];
  externalIdentity: FactContract[];
  scopePaths?: string[];
}

export interface EffectExecutor {
  readonly id: string;
  readonly version: number;
  execute(request: EffectExecutionRequest, signal: AbortSignal): Promise<CodeResult>;
}

/**
 * Optional model executor profile on a task node.
 * Omit for the product default (isolated-pi). Set kind current-session only
 * as an explicit opt-in so the orchestrator session performs that attempt.
 */
export interface NodeExecutorProfileDefinition {
  profileId: string;
  kind: "current-session" | "isolated-pi" | "acp" | "cli" | "deterministic";
  instanceId?: string;
}

export interface NodeDefinition {
  id: string;
  title: string;
  description?: string;
  kind?: NodeKind;
  requires: string[];
  acceptance: string[];
  produces?: FactContract[];
  gate?: GateDefinition;
  check?: CheckDefinition;
  interaction?: InteractionDefinition;
  code?: CodeNodeDefinition;
  effect?: EffectNodeDefinition;
  /** Explicit context bindings for a semantic task. Prefer feedbackFrom. */
  context?: TaskContextDefinition;
  scope?: { paths: string[] };
  /**
   * Optional model executor profile for task nodes.
   * Default product routing is isolated-pi when this field is absent.
   */
  executorProfile?: NodeExecutorProfileDefinition;
}

export interface FeedbackEdge { from: string; to: string }

export interface LegacyLoopPredicate {
  kind: "legacy-text";
  text: string;
}

export type LoopSuccessPredicate = Condition | LegacyLoopPredicate | string;

export interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}

export interface LoopEvaluationDefinition {
  validWhen: Condition;
  maximumInvalidEvaluations: number;
}

export interface EvaluationBudgetDefinition {
  maximumEvaluations?: number;
  maximumDevelopmentEvaluations?: number;
  maximumProbeEvaluations?: number;
  maximumHoldoutEvaluations?: number;
}

export interface WorkflowEvaluationDefinition {
  budget: EvaluationBudgetDefinition;
}

export interface EvaluationRuntime {
  total: number;
  development: number;
  probe: number;
  holdout: number;
  lastKind?: EvaluationKind;
  lastNodeId?: string;
  lastAttemptId?: string;
}

export type LoopFailurePolicy = "fail-workflow" | "block-dependants" | "record-and-continue";

export interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: LoopSuccessPredicate;
  maxIterations: number;
  progress?: LoopProgressDefinition;
  patience?: number;
  evaluation?: LoopEvaluationDefinition;
  failurePolicy?: LoopFailurePolicy;
}

export type LoopStatus = "pending" | "running" | "blocked" | "succeeded" | "failed" | "requires_revision";
export type LoopDecision = "complete" | "continue" | "fail" | "pending";
export type LoopExitReason = "success" | "max_iterations" | "no_progress" | "invalid_evaluations" | "evaluation_budget" | "evaluation_error";

export interface LoopIterationRuntime {
  iteration: number;
  startedAt: string;
  evaluatedAt?: string;
  evaluationEventId?: string;
  evaluationSequence?: number;
  valid?: boolean;
  success?: boolean;
  factsUsed: string[];
  validityFactsUsed?: string[];
  semanticsVersion?: number;
  decision?: LoopDecision;
  metric?: number;
  improved?: boolean;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount?: number;
  invalidEvaluationCount?: number;
  evaluatorIntegrity?: EvaluationIntegrityObservation;
}

export interface LoopRuntime {
  loopId: string;
  status: LoopStatus;
  currentIteration: number;
  maxIterations: number;
  iterations: LoopIterationRuntime[];
  lastValid?: boolean;
  lastSuccess?: boolean;
  factsUsed: string[];
  validityFactsUsed?: string[];
  semanticsVersion?: number;
  currentMetric?: number;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount?: number;
  invalidEvaluationCount?: number;
  evaluatorIntegrity?: EvaluationIntegrityObservation;
  startedAt?: string;
  completedAt?: string;
  exitReason?: LoopExitReason;
  failurePolicy?: LoopFailurePolicy;
  blockedAt?: string;
  blockedReason?: string;
  blockedAttemptId?: string;
  legacyPredicate?: string;
}

export interface WorkflowPolicy {
  mode: EnforcementMode;
  requireEvidence: boolean;
}

export interface HypagraphDefinition {
  title: string;
  goal: string;
  nodes: NodeDefinition[];
  loops: LoopDefinition[];
  evaluation?: WorkflowEvaluationDefinition;
  policy: WorkflowPolicy;
}

export interface AttemptRuntime {
  attemptId: string;
  number: number;
  status: AttemptStatus;
  startedAt: string;
  submittedAt?: string;
  completedAt?: string;
  evidence: EvidenceReference[];
  failureReason?: string;
  checkResult?: CheckResult;
  codeResult?: CodeResult;
  /** Durable external-effect observation for an effect attempt. */
  effectObservation?: EffectObservation;
  /** Presentation observation for an interaction attempt. */
  presentation?: InteractionPresentationObservation;
  /** Absolute deadline stored when the interaction was requested. */
  deadline?: InteractionDeadline;
  /** Timeout policy stored when the interaction was requested. */
  timeoutPolicy?: Pick<InteractionTimeoutDefinition, "onTimeout" | "selectResponseId">;
  /** Selected closed-response identifier after an answer or select timeout. */
  responseId?: string;
  /** Structured feedback artifact reference from the answer. */
  feedbackArtifactRef?: string;
  /** Free-text notes artifact reference when the host stored notes by identity. */
  freeTextArtifactRef?: string;
  /** Full free-text notes body when recorded on the attempt (bounded by maxBytes). */
  freeText?: string;
  loopId?: string;
  iteration?: number;
}

export type NodeBlockerKind = "repository-work" | "external-dependency" | "safeguard" | "unknown";

export interface NodeRuntime {
  status: NodeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  attempts: Record<string, AttemptRuntime>;
  evidence: EvidenceReference[];
  blockedReason?: string;
  blockerKind?: NodeBlockerKind;
}

export interface RouteSelection {
  gateNodeId: string;
  outcomeId: "true" | "false";
  targetNodeIds: string[];
  factsUsed: string[];
  semanticsVersion: number;
  eventId: string;
  sequence: number;
}

export interface HypagraphState {
  schemaVersion: typeof HYPAGRAPH_SCHEMA_VERSION;
  workflowId: string;
  revision: number;
  sequence: number;
  phase: WorkflowPhase;
  definition: HypagraphDefinition;
  runtime: {
    nodes: Record<string, NodeRuntime>;
    facts: Record<string, FactRecord>;
    routes: Record<string, RouteSelection>;
    loops: Record<string, LoopRuntime>;
    evaluations?: EvaluationRuntime;
  };
  goal?: GoalRuntime;
  createdAt: string;
  updatedAt: string;
  snapshotHash: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  location?: string;
  suggestion?: string;
}

export type EventType =
  | "hypagraph.workflow.defined"
  | "hypagraph.workflow.revised"
  | "hypagraph.workflow.paused"
  | "hypagraph.workflow.resumed"
  | "hypagraph.workflow.completed"
  | "hypagraph.workflow.failed"
  | "hypagraph.goal.started"
  | "hypagraph.goal.paused"
  | "hypagraph.goal.resumed"
  | "hypagraph.goal.blocked"
  | "hypagraph.goal.completed"
  | "hypagraph.goal.failed"
  | "hypagraph.goal.cancelled"
  | "hypagraph.goal.continuation-requested"
  | "hypagraph.goal.continuation-abandoned"
  | "hypagraph.goal.turn-recorded"
  | "hypagraph.goal.budget-limited"
  | "hypagraph.goal.revision-requested"
  | "hypagraph.goal.revision-rejected"
  | "hypagraph.goal.revision-abandoned"
  | "hypagraph.goal.revision-applied"
  | "hypagraph.node.ready"
  | "hypagraph.node.skipped"
  | "hypagraph.node.invalidated"
  | "hypagraph.node.blocked"
  | "hypagraph.node.unblocked"
  | "hypagraph.attempt.started"
  | "hypagraph.attempt.result-submitted"
  | "hypagraph.check.started"
  | "hypagraph.evaluation.started"
  | "hypagraph.check.result-recorded"
  | "hypagraph.code.started"
  | "hypagraph.code.result-recorded"
  | "hypagraph.effect.requested"
  | "hypagraph.effect.observed"
  | "hypagraph.effect.indeterminate"
  | "hypagraph.effect.reconciled"
  | "hypagraph.interaction.requested"
  | "hypagraph.interaction.presented"
  | "hypagraph.interaction.answered"
  | "hypagraph.interaction.expired"
  | "hypagraph.task.waiting-for-child"
  | "hypagraph.task.child-returned"
  | "hypagraph.task.child-return-failed"
  | "hypagraph.fact.published"
  | "hypagraph.route.selected"
  | "hypagraph.verification.started"
  | "hypagraph.verification.passed"
  | "hypagraph.verification.failed"
  | "hypagraph.attempt.cancelled"
  | "hypagraph.loop.iteration-started"
  | "hypagraph.loop.evaluated"
  | "hypagraph.loop.invalidated"
  | "hypagraph.loop.blocked"
  | "hypagraph.loop.completed"
  | "hypagraph.loop.failed";

export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  workflowId: string;
  revision: number;
  sequence: number;
  type: EventType;
  version: typeof HYPAGRAPH_EVENT_VERSION;
  timestamp: string;
  causationId: string;
  correlationId: string;
  nodeId?: string;
  attemptId?: string;
  loopId?: string;
  data: T;
}

interface CommandBase {
  commandId: string;
  correlationId?: string;
  at: string;
}

export interface FactInput {
  name: string;
  type: FactType;
  value: FactValue;
  evidence?: EvidenceReference[];
}

export type HypagraphCommand =
  | (CommandBase & { type: "revise"; definition: HypagraphDefinition })
  | (CommandBase & { type: "start-node"; nodeId: string; attemptId: string })
  | (CommandBase & { type: "start-check"; nodeId: string; attemptId: string })
  | (CommandBase & { type: "record-check-result"; nodeId: string; attemptId: string; result: CheckResult })
  | (CommandBase & { type: "start-code"; nodeId: string; attemptId: string })
  | (CommandBase & { type: "record-code-result"; nodeId: string; attemptId: string; result: CodeResult })
  | (CommandBase & {
    type: "request-effect";
    nodeId: string;
    attemptId: string;
    idempotencyKey: string;
  })
  | (CommandBase & {
    type: "record-effect-observed";
    nodeId: string;
    attemptId: string;
    observation: EffectObservation;
  })
  | (CommandBase & {
    type: "record-effect-indeterminate";
    nodeId: string;
    attemptId: string;
    observation: EffectObservation;
  })
  | (CommandBase & {
    type: "record-effect-reconciled";
    nodeId: string;
    attemptId: string;
    decision: EffectReconciliationDecision;
    observation: EffectObservation;
  })
  | (CommandBase & { type: "request-interaction"; nodeId: string; attemptId: string })
  | (CommandBase & {
    type: "present-interaction";
    nodeId: string;
    attemptId: string;
    result: InteractionPresentationObservation;
  })
  | (CommandBase & {
    type: "answer-interaction";
    nodeId: string;
    attemptId: string;
    responseId?: string;
    openText?: string;
    /** Optional free-text notes on a closed question which declares freeText. */
    freeText?: string;
    /**
     * Optional free-text notes artifact. The host stores content by identity first.
     * When set, freeText must still carry the full bounded notes for the event log.
     */
    freeTextArtifact?: InteractionFeedbackArtifactInput;
    /** Optional structured feedback artifact. The extension stores content first. */
    feedbackArtifact?: InteractionFeedbackArtifactInput;
    evidence?: EvidenceReference[];
  })
  /**
   * Evaluate a stored interaction deadline with the supplied evaluation time.
   * The reducer does not read the wall clock. The extension passes at.
   */
  | (CommandBase & { type: "expire-interaction"; nodeId: string; attemptId: string })
  /**
   * Suspend only this parent task while a bounded child goal runs.
   * The attempt remains open. Unrelated nodes stay runnable.
   */
  | (CommandBase & {
    type: "wait-for-child";
    nodeId: string;
    attemptId: string;
    childGoalId: string;
    bindingId: string;
  })
  /**
   * Apply a validated child-goal return against a parent task that waits for a child.
   * Success resumes the parent attempt unless remainWaiting is true.
   * When remainWaiting is true, the parent stays waiting_for_child because sibling
   * bindings for the same parent node are still active.
   * Failure policies fail, block, or request revision.
   * Child completion does not complete the parent task automatically.
   */
  | (CommandBase & {
    type: "record-child-return";
    nodeId: string;
    attemptId: string;
    childGoalId: string;
    bindingId: string;
    outcome: "completed" | "failed" | "cancelled" | "budget_limited";
    parentEffect: "resume" | "fail-parent-node" | "block-parent-node" | "return-for-revision";
    /**
     * When true with completed + resume, keep parent status waiting_for_child.
     * Use this when other bindings for the same parent node remain active.
     * Omit or leave false when this return clears the last active wait for the node.
     */
    remainWaiting?: boolean;
    facts?: FactInput[];
    evidence?: EvidenceReference[];
    reason?: string;
  })
  | (CommandBase & { type: "evaluate-gate"; nodeId: string })
  | (CommandBase & { type: "publish-facts"; nodeId: string; attemptId: string; facts: FactInput[] })
  | (CommandBase & { type: "submit-result"; nodeId: string; attemptId: string; evidence: EvidenceReference[] })
  | (CommandBase & { type: "begin-verification"; nodeId: string; attemptId: string })
  | (CommandBase & { type: "complete-verification"; nodeId: string; attemptId: string; passed: boolean; reason?: string })
  | (CommandBase & { type: "block-node"; nodeId: string; reason: string; blockerKind?: NodeBlockerKind })
  | (CommandBase & { type: "unblock-node"; nodeId: string })
  | (CommandBase & { type: "cancel-attempt"; nodeId: string; attemptId: string; reason?: string })
  | (CommandBase & { type: "pause-workflow" })
  | (CommandBase & { type: "resume-workflow" })
  | (CommandBase & { type: "start-goal"; goalId: string; budget?: GoalBudgetDefinition })
  | (CommandBase & { type: "pause-goal"; reason?: string; cause?: GoalPauseCause })
  | (CommandBase & { type: "resume-goal" })
  | (CommandBase & { type: "cancel-goal"; reason?: string })
  | (CommandBase & {
    type: "request-goal-continuation";
    goalId: string;
    workflowId: string;
    expectedRevision: number;
    expectedSequence: number;
    expectedSnapshotHash: string;
    expectedContinuationOrdinal: number;
    sessionGeneration: number;
    branchGeneration: number;
    action: GoalContinuationAction;
  })
  | (CommandBase & {
    type: "abandon-goal-continuation";
    goalId: string;
    workflowId: string;
    expectedRevision: number;
    expectedSequence: number;
    expectedSnapshotHash: string;
    continuationOperationId: string;
    continuationOrdinal: number;
    requestSequence: number;
    sessionGeneration: number;
    branchGeneration: number;
    reason: string;
  })
  | (CommandBase & {
    type: "apply-goal-revision";
    goalId: string;
    workflowId: string;
    expectedRevision: number;
    expectedSequence: number;
    expectedSnapshotHash: string;
    revisionOperationId: string;
    continuationOperationId: string;
    continuationOrdinal: number;
    requestSequence: number;
    sessionGeneration: number;
    branchGeneration: number;
    blocker: GoalBlockerIdentity;
    definition: HypagraphDefinition;
  })
  | (CommandBase & {
    type: "abandon-goal-revision";
    goalId: string;
    workflowId: string;
    expectedRevision: number;
    expectedSequence: number;
    expectedSnapshotHash: string;
    revisionOperationId: string;
    continuationOperationId: string;
    continuationOrdinal: number;
    requestSequence: number;
    sessionGeneration: number;
    branchGeneration: number;
    reason: string;
    outcomeCode: string;
  })
  | (CommandBase & {
    type: "record-goal-turn-usage";
    goalId: string;
    workflowId: string;
    expectedRevision: number;
    expectedSequence: number;
    expectedSnapshotHash: string;
    continuationOperationId: string;
    continuationOrdinal: number;
    requestSequence: number;
    selectedSequence: number;
    selectedSnapshotHash: string;
    sessionGeneration: number;
    branchGeneration: number;
    turnId: string;
    source: GoalTurnUsageSource;
    usage: GoalTokenUsage;
  });

export type ReducerResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface PersistedHypagraph {
  events: DomainEvent[];
  snapshot: HypagraphState;
}
