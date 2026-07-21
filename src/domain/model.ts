import type { FactContract, FactRecord, FactType, FactValue } from "./facts.js";

export const HYPAGRAPH_SCHEMA_VERSION = 2 as const;
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
  | "stale";
export type AttemptStatus = "running" | "submitted" | "verifying" | "succeeded" | "failed" | "cancelled";
export type EnforcementMode = "guided" | "strict";

export interface EvidenceReference {
  ref: string;
  kind?: "tool" | "command" | "file" | "approval" | "note";
  summary?: string;
}

export interface NodeDefinition {
  id: string;
  title: string;
  description?: string;
  requires: string[];
  acceptance: string[];
  produces?: FactContract[];
  scope?: { paths: string[] };
}

export interface FeedbackEdge { from: string; to: string }

export interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: string;
  maxIterations: number;
  patience?: number;
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
}

export interface NodeRuntime {
  status: NodeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  attempts: Record<string, AttemptRuntime>;
  evidence: EvidenceReference[];
  blockedReason?: string;
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
  | "hypagraph.node.invalidated"
  | "hypagraph.node.blocked"
  | "hypagraph.node.unblocked"
  | "hypagraph.attempt.started"
  | "hypagraph.attempt.result-submitted"
  | "hypagraph.fact.published"
  | "hypagraph.verification.started"
  | "hypagraph.verification.passed"
  | "hypagraph.verification.failed"
  | "hypagraph.attempt.cancelled";

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
