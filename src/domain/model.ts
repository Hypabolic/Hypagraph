import type { Condition } from "./conditions.js";
import type { FactContract, FactRecord, FactType, FactValue } from "./facts.js";

export const HYPAGRAPH_SCHEMA_VERSION = 3 as const;
export const HYPAGRAPH_EVENT_VERSION = 1 as const;

export type WorkflowPhase = "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled";
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

export interface EvidenceReference {
  ref: string;
  kind?: "tool" | "command" | "file" | "approval" | "note";
  summary?: string;
}

export interface GateDefinition {
  condition: Condition;
  onTrue: string[];
  onFalse: string[];
}

export type CheckKind = "command" | "test-report" | "lint-report" | "coverage-report" | "file-assertion" | "git-assertion";
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

export interface CommandCheckDefinition {
  kind: "command";
  command: string;
  arguments?: string[];
  workingDirectory?: string;
  timeoutMs: number;
  expectedExitCodes?: number[];
  environmentVariables?: string[];
  retry?: CheckRetryPolicy;
  publish: FactMapping[];
}

export type CheckDefinition = CommandCheckDefinition;

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

export interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: LoopSuccessPredicate;
  maxIterations: number;
  patience?: number;
}

export type LoopStatus = "inactive" | "running" | "completed" | "requires_revision";
export type LoopDecision = "complete" | "pending";

export interface LoopIterationRuntime {
  iteration: number;
  startedAt: string;
  evaluatedAt?: string;
  success?: boolean;
  factsUsed: string[];
  semanticsVersion?: number;
  decision?: LoopDecision;
}

export interface LoopRuntime {
  loopId: string;
  status: LoopStatus;
  currentIteration: number;
  maxIterations: number;
  iterations: LoopIterationRuntime[];
  lastSuccess?: boolean;
  factsUsed: string[];
  semanticsVersion?: number;
  startedAt?: string;
  completedAt?: string;
  exitReason?: "success";
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
  };
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
  | "hypagraph.node.ready"
  | "hypagraph.node.skipped"
  | "hypagraph.node.invalidated"
  | "hypagraph.node.blocked"
  | "hypagraph.node.unblocked"
  | "hypagraph.attempt.started"
  | "hypagraph.attempt.result-submitted"
  | "hypagraph.check.started"
  | "hypagraph.check.result-recorded"
  | "hypagraph.fact.published"
  | "hypagraph.route.selected"
  | "hypagraph.verification.started"
  | "hypagraph.verification.passed"
  | "hypagraph.verification.failed"
  | "hypagraph.attempt.cancelled"
  | "hypagraph.loop.iteration-started"
  | "hypagraph.loop.evaluated"
  | "hypagraph.loop.completed";

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
  | (CommandBase & { type: "resume-workflow" });

export type ReducerResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface PersistedHypagraph {
  events: DomainEvent[];
  snapshot: HypagraphState;
}
