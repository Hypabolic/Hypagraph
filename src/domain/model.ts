import type { Condition } from "./conditions.js";
import type { FactContract, FactRecord, FactType, FactValue } from "./facts.js";

export const HYPAGRAPH_SCHEMA_VERSION = 3 as const;
export const HYPAGRAPH_EVENT_VERSION = 1 as const;

export type WorkflowPhase = "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "failed" | "cancelled";

export interface GoalRuntime {
  goalId: string;
  workflowId: string;
  status: GoalStatus;
  continuationOrdinal: number;
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
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "stale";
export type AttemptStatus = "running" | "submitted" | "verifying" | "succeeded" | "failed" | "cancelled";
export type EnforcementMode = "guided" | "strict";
export type NodeKind = "task" | "gate" | "check";

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
  scope?: { paths: string[] };
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
  loopId?: string;
  iteration?: number;
}

export interface NodeRuntime {
  status: NodeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  attempts: Record<string, AttemptRuntime>;
  evidence: EvidenceReference[];
  blockedReason?: string;
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
  | (CommandBase & { type: "evaluate-gate"; nodeId: string })
  | (CommandBase & { type: "publish-facts"; nodeId: string; attemptId: string; facts: FactInput[] })
  | (CommandBase & { type: "submit-result"; nodeId: string; attemptId: string; evidence: EvidenceReference[] })
  | (CommandBase & { type: "begin-verification"; nodeId: string; attemptId: string })
  | (CommandBase & { type: "complete-verification"; nodeId: string; attemptId: string; passed: boolean; reason?: string })
  | (CommandBase & { type: "block-node"; nodeId: string; reason: string })
  | (CommandBase & { type: "unblock-node"; nodeId: string })
  | (CommandBase & { type: "cancel-attempt"; nodeId: string; attemptId: string; reason?: string })
  | (CommandBase & { type: "pause-workflow" })
  | (CommandBase & { type: "resume-workflow" })
  | (CommandBase & { type: "start-goal"; goalId: string })
  | (CommandBase & { type: "pause-goal"; reason?: string })
  | (CommandBase & { type: "resume-goal" })
  | (CommandBase & { type: "cancel-goal"; reason?: string });

export type ReducerResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface PersistedHypagraph {
  events: DomainEvent[];
  snapshot: HypagraphState;
}
