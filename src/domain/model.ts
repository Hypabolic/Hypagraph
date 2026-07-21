export const HYPAGRAPH_SCHEMA_VERSION = 1 as const;

export type WorkflowPhase = "running" | "blocked" | "completed" | "cancelled";
export type NodeStatus = "pending" | "active" | "blocked" | "completed" | "stale";
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
  scope?: {
    paths: string[];
  };
}

export interface FeedbackEdge {
  from: string;
  to: string;
}

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

export interface NodeRuntime {
  status: NodeStatus;
  attempt: number;
  evidence: EvidenceReference[];
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
}

export interface HypagraphState {
  schemaVersion: typeof HYPAGRAPH_SCHEMA_VERSION;
  workflowId: string;
  revision: number;
  phase: WorkflowPhase;
  definition: HypagraphDefinition;
  runtime: {
    nodes: Record<string, NodeRuntime>;
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

export interface DomainEvent {
  type:
    | "hypagraph.workflow.defined"
    | "hypagraph.workflow.revised"
    | "hypagraph.node.started"
    | "hypagraph.node.completed"
    | "hypagraph.node.blocked"
    | "hypagraph.node.unblocked"
    | "hypagraph.node.stale"
    | "hypagraph.workflow.completed";
  nodeId?: string;
  data?: Record<string, unknown>;
}

export interface TransitionCommand {
  type: "transition";
  nodeId: string;
  action: "start" | "complete" | "block" | "unblock";
  evidence?: EvidenceReference[];
  reason?: string;
  at: string;
}

export interface ReviseCommand {
  type: "revise";
  definition: HypagraphDefinition;
  at: string;
}

export type HypagraphCommand = TransitionCommand | ReviseCommand;

export type ReducerResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };
