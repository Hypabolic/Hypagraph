from pathlib import Path


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


write("src/domain/model.ts", r'''import type { Condition } from "./conditions.js";
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
''')

write("src/domain/facts.ts", r'''import type { EvidenceReference } from "./model.js";

export type FactType = "boolean" | "integer" | "number" | "string" | "duration" | "timestamp" | "string-list";
export type FactValue = boolean | number | string | string[];

export interface FactContract {
  name: string;
  type: FactType;
  required?: boolean;
}

export interface PublishedFact {
  name: string;
  type: FactType;
  value: FactValue;
  producerNodeId: string;
  attemptId: string;
  revision: number;
  evidence: EvidenceReference[];
  loopId?: string;
  iteration?: number;
}

export interface FactRecord extends PublishedFact {
  eventId: string;
  sequence: number;
}

export interface FactValidationContext {
  contracts: FactContract[];
  currentRevision: number;
  currentAttemptId: string;
}

export type FactValidationResult =
  | { ok: true; fact: PublishedFact }
  | { ok: false; code: string; message: string };

const isInteger = (value: FactValue): value is number => typeof value === "number" && Number.isInteger(value);
const isNumber = (value: FactValue): value is number => typeof value === "number" && Number.isFinite(value);
const isTimestamp = (value: FactValue): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isDuration = (value: FactValue): value is string => typeof value === "string" && /^P(?!$)/.test(value);

export const isFactValueOfType = (type: FactType, value: FactValue): boolean => {
  switch (type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return isInteger(value);
    case "number": return isNumber(value);
    case "string": return typeof value === "string";
    case "duration": return isDuration(value);
    case "timestamp": return isTimestamp(value);
    case "string-list": return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
};

export const validatePublishedFact = (
  fact: PublishedFact,
  context: FactValidationContext,
): FactValidationResult => {
  const contract = context.contracts.find((item) => item.name === fact.name);
  if (!contract) {
    return { ok: false, code: "fact_not_declared", message: `Fact '${fact.name}' is not declared by the node.` };
  }
  if (fact.revision !== context.currentRevision) {
    return { ok: false, code: "stale_fact_revision", message: `Fact '${fact.name}' belongs to an old workflow revision.` };
  }
  if (fact.attemptId !== context.currentAttemptId) {
    return { ok: false, code: "stale_fact_attempt", message: `Fact '${fact.name}' belongs to an old attempt.` };
  }
  if (fact.type !== contract.type) {
    return { ok: false, code: "fact_type_mismatch", message: `Fact '${fact.name}' must have type '${contract.type}'.` };
  }
  if (!isFactValueOfType(fact.type, fact.value)) {
    return { ok: false, code: "fact_value_invalid", message: `Fact '${fact.name}' has an invalid value for type '${fact.type}'.` };
  }
  return { ok: true, fact };
};

export const indexFacts = (facts: FactRecord[]): Readonly<Record<string, FactRecord>> => {
  const result: Record<string, FactRecord> = {};
  for (const fact of facts) result[fact.name] = fact;
  return result;
};
''')

write("src/domain/readiness.ts", r'''import type { HypagraphState, LoopDefinition } from "./model.js";

export function feedbackEdgeKeys(state: HypagraphState): Set<string> {
  return new Set(
    state.definition.loops.flatMap((loop) => loop.feedbackEdges.map((edge) => `${edge.from}\u0000${edge.to}`)),
  );
}

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId));

export function dependencyStatuses(state: HypagraphState, nodeId: string): string[] | undefined {
  const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;
  const feedback = feedbackEdgeKeys(state);
  return node.requires
    .filter((required) => !feedback.has(`${required}\u0000${node.id}`))
    .map((required) => state.runtime.nodes[required]?.status ?? "missing");
}

const loopBarriersAreSatisfied = (state: HypagraphState, nodeId: string): boolean => {
  const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return false;
  const targetLoop = loopForNode(state, nodeId);
  for (const required of node.requires) {
    const sourceLoop = loopForNode(state, required);
    if (!sourceLoop || sourceLoop.id === targetLoop?.id) continue;
    if (state.runtime.loops[sourceLoop.id]?.status !== "completed") return false;
  }
  return true;
};

export function dependenciesAreSatisfied(state: HypagraphState, nodeId: string): boolean {
  const statuses = dependencyStatuses(state, nodeId);
  return statuses !== undefined
    && statuses.every((status) => status === "succeeded" || status === "skipped")
    && loopBarriersAreSatisfied(state, nodeId);
}

export function dependenciesSelectSkip(state: HypagraphState, nodeId: string): boolean {
  const statuses = dependencyStatuses(state, nodeId);
  return !!statuses && statuses.length > 0 && statuses.every((status) => status === "skipped");
}

export function isNodeReady(state: HypagraphState, nodeId: string): boolean {
  return state.runtime.nodes[nodeId]?.status === "ready";
}

export function readyNodeIds(state: HypagraphState): string[] {
  return state.definition.nodes
    .filter((node) => state.runtime.nodes[node.id]?.status === "ready")
    .map((node) => node.id);
}
''')

write("src/domain/projection.ts", r'''import { CONDITION_SEMANTICS_VERSION } from "./conditions.js";
import { sha256 } from "./hash.js";
import type { FactRecord } from "./facts.js";
import type {
  AttemptRuntime,
  CheckResult,
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
  LegacyLoopPredicate,
  LoopDefinition,
  LoopRuntime,
  NodeRuntime,
  RouteSelection,
} from "./model.js";
import { HYPAGRAPH_SCHEMA_VERSION } from "./model.js";

const hashState = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => ({
  ...state,
  snapshotHash: sha256(state),
});

const emptyNode = (): NodeRuntime => ({ status: "pending", attemptCount: 0, attempts: {}, evidence: [] });

const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate =>
  typeof value === "string" || value.kind === "legacy-text";

const normaliseDefinition = (definition: HypagraphDefinition): HypagraphDefinition => ({
  ...structuredClone(definition),
  loops: definition.loops.map((loop) => ({
    ...structuredClone(loop),
    successWhen: typeof loop.successWhen === "string"
      ? { kind: "legacy-text", text: loop.successWhen }
      : structuredClone(loop.successWhen),
  })),
});

const emptyLoop = (loop: LoopDefinition): LoopRuntime => {
  const legacy = isLegacyPredicate(loop.successWhen);
  const legacyText = typeof loop.successWhen === "string" ? loop.successWhen : loop.successWhen.kind === "legacy-text" ? loop.successWhen.text : undefined;
  return {
    loopId: loop.id,
    status: legacy ? "requires_revision" : "inactive",
    currentIteration: 0,
    maxIterations: loop.maxIterations,
    iterations: [],
    factsUsed: [],
    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),
  };
};

const allLoopsCompleted = (state: Omit<HypagraphState, "snapshotHash">): boolean =>
  Object.values(state.runtime.loops).every((loop) => loop.status === "completed");

const finalise = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => {
  const nodes = Object.values(state.runtime.nodes);
  let phase = state.phase;
  if (nodes.length > 0 && nodes.every((node) => node.status === "succeeded" || node.status === "skipped") && allLoopsCompleted(state)) phase = "completed";
  else if (nodes.some((node) => node.status === "blocked") && !nodes.some((node) => ["ready", "running", "verifying", "awaiting_evidence"].includes(node.status))) phase = "blocked";
  else if (phase !== "paused" && phase !== "failed" && phase !== "cancelled") phase = "running";
  return hashState({ ...state, phase });
};

const withoutHash = (state: HypagraphState): Omit<HypagraphState, "snapshotHash"> => {
  const { snapshotHash: _snapshotHash, ...rest } = state;
  return rest;
};

const startAttempt = (node: NodeRuntime, attemptId: string, timestamp: string, data: Record<string, unknown>): void => {
  const loopId = typeof data.loopId === "string" ? data.loopId : undefined;
  const iteration = typeof data.iteration === "number" ? data.iteration : undefined;
  const value: AttemptRuntime = {
    attemptId,
    number: node.attemptCount + 1,
    status: "running",
    startedAt: timestamp,
    evidence: [],
    ...(loopId === undefined ? {} : { loopId }),
    ...(iteration === undefined ? {} : { iteration }),
  };
  node.attemptCount += 1;
  node.currentAttemptId = attemptId;
  node.attempts[attemptId] = value;
  node.status = "running";
};

export function applyEvent(state: HypagraphState | undefined, event: DomainEvent): HypagraphState {
  if (event.type === "hypagraph.workflow.defined") {
    const definition = normaliseDefinition(event.data.definition as HypagraphDefinition);
    const nodes = Object.fromEntries(definition.nodes.map((node) => [node.id, emptyNode()]));
    const loops = Object.fromEntries(definition.loops.map((loop) => [loop.id, emptyLoop(loop)]));
    return finalise({
      schemaVersion: HYPAGRAPH_SCHEMA_VERSION,
      workflowId: event.workflowId,
      revision: event.revision,
      sequence: event.sequence,
      phase: "running",
      definition,
      runtime: { nodes, facts: {}, routes: {}, loops },
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
  }
  if (!state) throw new Error("The first event must define the workflow.");
  if (event.workflowId !== state.workflowId) throw new Error("The event belongs to a different workflow.");
  if (event.sequence !== state.sequence + 1) throw new Error("The event sequence is not contiguous.");

  const next = structuredClone(state);
  next.runtime.routes ??= {};
  next.runtime.loops ??= {};
  next.sequence = event.sequence;
  next.revision = event.revision;
  next.updatedAt = event.timestamp;
  const node = event.nodeId ? next.runtime.nodes[event.nodeId] : undefined;
  const attempt = node && event.attemptId ? node.attempts[event.attemptId] : undefined;

  switch (event.type) {
    case "hypagraph.workflow.revised": {
      next.definition = normaliseDefinition(event.data.definition as HypagraphDefinition);
      const retainedNodes = next.runtime.nodes;
      const retainedLoops = next.runtime.loops;
      next.runtime.nodes = {};
      for (const definitionNode of next.definition.nodes) next.runtime.nodes[definitionNode.id] = retainedNodes[definitionNode.id] ?? emptyNode();
      next.runtime.loops = {};
      for (const definitionLoop of next.definition.loops) {
        const retained = retainedLoops[definitionLoop.id];
        next.runtime.loops[definitionLoop.id] = isLegacyPredicate(definitionLoop.successWhen)
          ? emptyLoop(definitionLoop)
          : retained?.status === "requires_revision" || retained === undefined
            ? emptyLoop(definitionLoop)
            : retained;
      }
      for (const gateNodeId of Object.keys(next.runtime.routes)) {
        if (!next.runtime.nodes[gateNodeId]) delete next.runtime.routes[gateNodeId];
      }
      break;
    }
    case "hypagraph.workflow.paused": next.phase = "paused"; break;
    case "hypagraph.workflow.resumed": next.phase = "running"; break;
    case "hypagraph.workflow.completed": next.phase = "completed"; break;
    case "hypagraph.workflow.failed": next.phase = "failed"; break;
    case "hypagraph.node.ready": if (node) node.status = "ready"; break;
    case "hypagraph.node.skipped": if (node) node.status = "skipped"; break;
    case "hypagraph.node.invalidated":
      if (node) {
        node.status = "stale";
        delete node.currentAttemptId;
        node.evidence = [];
        delete next.runtime.routes[event.nodeId!];
        for (const [name, fact] of Object.entries(next.runtime.facts)) {
          if (fact.producerNodeId === event.nodeId) delete next.runtime.facts[name];
        }
      }
      break;
    case "hypagraph.node.blocked":
      if (node) {
        node.status = "blocked";
        node.blockedReason = String(event.data.reason ?? "");
      }
      break;
    case "hypagraph.node.unblocked":
      if (node) {
        node.status = "pending";
        delete node.blockedReason;
      }
      break;
    case "hypagraph.attempt.started":
      if (node && event.attemptId) startAttempt(node, event.attemptId, event.timestamp, event.data);
      break;
    case "hypagraph.check.started":
      if (node && event.attemptId) {
        if (event.data.retry === true && event.nodeId) {
          for (const [name, fact] of Object.entries(next.runtime.facts)) {
            if (fact.producerNodeId === event.nodeId) delete next.runtime.facts[name];
          }
        }
        startAttempt(node, event.attemptId, event.timestamp, event.data);
      }
      break;
    case "hypagraph.check.result-recorded":
      if (node && attempt) {
        const result = structuredClone(event.data.result as CheckResult);
        attempt.status = "submitted";
        attempt.submittedAt = event.timestamp;
        attempt.checkResult = result;
        attempt.evidence = structuredClone(result.evidence);
        node.evidence = structuredClone(result.evidence);
        node.status = "awaiting_evidence";
      }
      break;
    case "hypagraph.fact.published":
      if (event.nodeId && event.attemptId) {
        const fact = event.data.fact as Omit<FactRecord, "eventId" | "sequence">;
        next.runtime.facts[fact.name] = {
          ...structuredClone(fact),
          eventId: event.eventId,
          sequence: event.sequence,
        };
      }
      break;
    case "hypagraph.route.selected":
      if (node && event.nodeId) {
        const route = event.data as Pick<RouteSelection, "outcomeId" | "targetNodeIds" | "factsUsed"> & { semanticsVersion?: number };
        next.runtime.routes[event.nodeId] = {
          gateNodeId: event.nodeId,
          outcomeId: route.outcomeId,
          targetNodeIds: structuredClone(route.targetNodeIds),
          factsUsed: structuredClone(route.factsUsed),
          semanticsVersion: route.semanticsVersion ?? CONDITION_SEMANTICS_VERSION,
          eventId: event.eventId,
          sequence: event.sequence,
        };
        node.status = "succeeded";
      }
      break;
    case "hypagraph.attempt.result-submitted":
      if (node && attempt) {
        const evidence = event.data.evidence as AttemptRuntime["evidence"];
        attempt.status = "submitted";
        attempt.submittedAt = event.timestamp;
        attempt.evidence = structuredClone(evidence);
        node.evidence = structuredClone(evidence);
        node.status = "awaiting_evidence";
      }
      break;
    case "hypagraph.verification.started":
      if (node && attempt) {
        attempt.status = "verifying";
        node.status = "verifying";
      }
      break;
    case "hypagraph.verification.passed":
      if (node && attempt) {
        attempt.status = "succeeded";
        attempt.completedAt = event.timestamp;
        node.status = "succeeded";
      }
      break;
    case "hypagraph.verification.failed":
      if (node && attempt) {
        attempt.status = "failed";
        attempt.completedAt = event.timestamp;
        attempt.failureReason = String(event.data.reason ?? "Verification failed.");
        node.status = "failed";
      }
      break;
    case "hypagraph.attempt.cancelled":
      if (node && attempt) {
        attempt.status = "cancelled";
        attempt.completedAt = event.timestamp;
        if (typeof event.data.reason === "string") attempt.failureReason = event.data.reason;
        node.status = "cancelled";
      }
      break;
    case "hypagraph.loop.iteration-started": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        const iteration = Number(event.data.iteration);
        runtime.status = "running";
        runtime.currentIteration = iteration;
        runtime.startedAt ??= event.timestamp;
        runtime.iterations.push({ iteration, startedAt: event.timestamp, factsUsed: [] });
      }
      break;
    }
    case "hypagraph.loop.evaluated": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        const iteration = Number(event.data.iteration);
        const record = runtime.iterations.find((item) => item.iteration === iteration);
        const success = event.data.success === true;
        const factsUsed = Array.isArray(event.data.factsUsed) ? event.data.factsUsed.filter((item): item is string => typeof item === "string") : [];
        const semanticsVersion = Number(event.data.semanticsVersion ?? CONDITION_SEMANTICS_VERSION);
        const decision = event.data.decision === "complete" ? "complete" : "pending";
        if (record) {
          record.evaluatedAt = event.timestamp;
          record.success = success;
          record.factsUsed = structuredClone(factsUsed);
          record.semanticsVersion = semanticsVersion;
          record.decision = decision;
        }
        runtime.lastSuccess = success;
        runtime.factsUsed = structuredClone(factsUsed);
        runtime.semanticsVersion = semanticsVersion;
      }
      break;
    }
    case "hypagraph.loop.completed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "completed";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "success";
      }
      break;
    }
  }
  return finalise(withoutHash(next));
}

export function replayEvents(events: readonly DomainEvent[]): HypagraphState {
  if (events.length === 0) throw new Error("The event stream is empty.");
  let state: HypagraphState | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state!;
}
''')

write("src/domain/reducer.ts", r'''import { randomUUID } from "node:crypto";
import { evaluateCheckStart } from "./check-policy.js";
import type {
  CheckResult,
  Diagnostic,
  DomainEvent,
  EventType,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
  LegacyLoopPredicate,
  LoopDefinition,
  ReducerResult,
} from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import type { PublishedFact } from "./facts.js";
import { validatePublishedFact } from "./facts.js";
import { CONDITION_SEMANTICS_VERSION, evaluateCondition } from "./conditions.js";
import { applyEvent, replayEvents } from "./projection.js";
import { dependenciesAreSatisfied, dependenciesSelectSkip } from "./readiness.js";
import { buildOutgoing } from "./scc.js";
import { sha256 } from "./hash.js";
import { validateDefinition } from "./validate.js";

type Rejection = Extract<ReducerResult, { ok: false }>;
const reject = (code: string, message: string, location?: string): Rejection => ({ ok: false, diagnostics: [{ code, message, ...(location ? { location } : {}) }] });
interface EventInput { type: EventType; nodeId?: string; attemptId?: string; loopId?: string; data?: Record<string, unknown> }

const makeEvent = (state: HypagraphState | undefined, command: { commandId: string; correlationId?: string; at: string }, workflowId: string, revision: number, input: EventInput): DomainEvent => {
  const sequence = (state?.sequence ?? 0) + 1;
  const eventId = sha256({ workflowId, revision, sequence, commandId: command.commandId, type: input.type, nodeId: input.nodeId ?? null, attemptId: input.attemptId ?? null, loopId: input.loopId ?? null });
  return { eventId, workflowId, revision, sequence, type: input.type, version: HYPAGRAPH_EVENT_VERSION, timestamp: command.at, causationId: command.commandId, correlationId: command.correlationId ?? command.commandId, ...(input.nodeId ? { nodeId: input.nodeId } : {}), ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...(input.loopId ? { loopId: input.loopId } : {}), data: input.data ?? {} };
};

const append = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }, input: EventInput): HypagraphState => {
  const event = makeEvent(state, command, state.workflowId, state.revision, input);
  events.push(event);
  return applyEvent(state, event);
};

const appendReadyEvents = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => {
  let next = state;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of next.definition.nodes) {
      const runtime = next.runtime.nodes[node.id];
      if (!runtime || (runtime.status !== "pending" && runtime.status !== "stale")) continue;
      if (!dependenciesAreSatisfied(next, node.id)) continue;
      next = append(next, events, command, { type: dependenciesSelectSkip(next, node.id) ? "hypagraph.node.skipped" : "hypagraph.node.ready", nodeId: node.id });
      changed = true;
    }
  }
  return next;
};

const allLoopsCompleted = (state: HypagraphState): boolean => Object.values(state.runtime.loops).every((loop) => loop.status === "completed");
const appendCompletionIfNeeded = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => Object.values(state.runtime.nodes).every((item) => item.status === "succeeded" || item.status === "skipped") && allLoopsCompleted(state) ? append(state, events, command, { type: "hypagraph.workflow.completed" }) : state;

export function createWorkflow(definition: HypagraphDefinition, at: string, workflowId: string = randomUUID()): ReducerResult {
  const diagnostics = validateDefinition(definition);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const command = { commandId: `define:${workflowId}`, at };
  const defined = makeEvent(undefined, command, workflowId, 1, { type: "hypagraph.workflow.defined", data: { definition: structuredClone(definition) } });
  const events = [defined];
  let state = applyEvent(undefined, defined);
  state = appendReadyEvents(state, events, command);
  return { ok: true, state, events };
}

const invalidatedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of next.nodes) { const oldNode = previousById.get(node.id); if (!oldNode || sha256(oldNode) !== sha256(node)) changed.add(node.id); }
  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) for (const dependent of outgoing.get(queue[index]!) ?? []) if (!changed.has(dependent)) { changed.add(dependent); queue.push(dependent); }
  return changed;
};

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined => state.definition.loops.find((loop) => loop.nodes.includes(nodeId));
const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || value.kind === "legacy-text";

interface PreparedLoopStart { state: HypagraphState; loopId?: string; iteration?: number }
const prepareLoopStart = (
  state: HypagraphState,
  events: DomainEvent[],
  command: { commandId: string; correlationId?: string; at: string },
  nodeId: string,
): PreparedLoopStart | Rejection => {
  const definition = loopForNode(state, nodeId);
  if (!definition) return { state };
  const runtime = state.runtime.loops[definition.id];
  if (!runtime) return reject("loop_runtime_missing", `Loop '${definition.id}' has no runtime state.`);
  if (runtime.status === "requires_revision") return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  if (runtime.status === "completed") return reject("loop_already_completed", `Loop '${definition.id}' is complete.`);
  if (runtime.status === "inactive") {
    if (nodeId !== definition.entry) return reject("loop_entry_required", `Start loop '${definition.id}' at entry node '${definition.entry}'.`);
    const next = append(state, events, command, {
      type: "hypagraph.loop.iteration-started",
      loopId: definition.id,
      data: { loopId: definition.id, iteration: 1, maxIterations: definition.maxIterations },
    });
    return { state: next, loopId: definition.id, iteration: 1 };
  }
  return { state, loopId: definition.id, iteration: runtime.currentIteration };
};

const requiredFactsArePresent = (state: HypagraphState, nodeId: string, attemptId: string): string[] => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (!definition || !attempt) return [];
  return (definition.produces ?? []).filter((contract) => contract.required).filter((contract) => {
    const fact = state.runtime.facts[contract.name];
    return !fact
      || fact.producerNodeId !== nodeId
      || fact.attemptId !== attemptId
      || fact.revision !== state.revision
      || fact.loopId !== attempt.loopId
      || fact.iteration !== attempt.iteration;
  }).map((contract) => contract.name);
};

const activeAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => ["starting", "running", "awaiting_evidence", "verifying"].includes(item.status));

const validateCheckResult = (result: CheckResult, attemptId: string, checkKind: string): Rejection | undefined => {
  if (result.attemptId !== attemptId) return reject("stale_check_result", "The check result does not match the current attempt.");
  if (result.checkKind !== checkKind) return reject("check_kind_mismatch", `The result kind '${result.checkKind}' does not match check kind '${checkKind}'.`);
  if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))) return reject("invalid_check_timestamps", "The check result must contain valid start and completion timestamps.");
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) return reject("invalid_check_duration", "The check completion time must not be before its start time.");
  return undefined;
};

interface LoopEvaluation {
  loopId: string;
  iteration: number;
  success: boolean;
  factsUsed: string[];
  semanticsVersion: number;
}

const prepareLoopEvaluation = (state: HypagraphState, nodeId: string): LoopEvaluation | Rejection | undefined => {
  const definition = state.definition.loops.find((loop) => loop.evaluateAfter === nodeId);
  if (!definition) return undefined;
  const runtime = state.runtime.loops[definition.id];
  if (!runtime || runtime.status !== "running") return reject("loop_not_running", `Loop '${definition.id}' is not running.`);
  if (isLegacyPredicate(definition.successWhen)) return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  const result = evaluateCondition(definition.successWhen, state.runtime.facts);
  if (!result.ok) return reject(result.code, result.message, `loops.${definition.id}.successWhen`);
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: result.factsUsed,
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
  };
};

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (["completed", "failed", "cancelled"].includes(state.phase)) return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  const events: DomainEvent[] = [];
  let next = state;
  if (command.type === "pause-workflow") { if (state.phase === "paused") return reject("workflow_already_paused", "The workflow is already paused."); next = append(next, events, command, { type: "hypagraph.workflow.paused" }); return { ok: true, state: next, events }; }
  if (command.type === "resume-workflow") { if (state.phase !== "paused") return reject("workflow_not_paused", "The workflow is not paused."); next = append(next, events, command, { type: "hypagraph.workflow.resumed" }); next = appendReadyEvents(next, events, command); return { ok: true, state: next, events }; }
  if (state.phase === "paused") return reject("workflow_paused", "Resume the workflow before you change a node.");
  if (command.type === "revise") {
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const invalidated = invalidatedNodes(state.definition, command.definition); const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const nodeId of invalidated) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    next = appendReadyEvents(next, events, command); return { ok: true, state: next, events };
  }

  const node = state.runtime.nodes[command.nodeId];
  if (!node) return reject("unknown_node", `Unknown node '${command.nodeId}'.`, "nodeId");
  const definitionNode = state.definition.nodes.find((item) => item.id === command.nodeId)!;

  switch (command.type) {
    case "start-node": {
      const kind = definitionNode.kind ?? "task";
      if (kind === "gate") return reject("gate_start_not_allowed", "Evaluate a gate instead of starting it.");
      if (kind === "check") return reject("check_start_required", "Start a check with the check execution command.");
      if (node.status !== "ready") return reject("node_not_ready", `Node '${command.nodeId}' is not ready.`);
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, { type: "hypagraph.attempt.started", nodeId: command.nodeId, attemptId: command.attemptId, data: { ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }), ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }) } });
      break;
    }
    case "start-check": {
      if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) return reject("node_not_check", `Node '${command.nodeId}' is not a check.`);
      const eligibility = evaluateCheckStart(node, definitionNode.check, command.attemptId, command.at);
      if (!eligibility.ok) return { ok: false, diagnostics: [eligibility.diagnostic] };
      if (activeAttemptExists(state)) return reject("node_already_active", "Another node has an active attempt.");
      const prepared = prepareLoopStart(next, events, command, command.nodeId);
      if ("ok" in prepared) return prepared;
      next = prepared.state;
      next = append(next, events, command, {
        type: "hypagraph.check.started",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        data: {
          checkKind: definitionNode.check.kind,
          retry: eligibility.retry,
          ...(eligibility.previousAttemptId ? { previousAttemptId: eligibility.previousAttemptId } : {}),
          ...(prepared.loopId === undefined ? {} : { loopId: prepared.loopId }),
          ...(prepared.iteration === undefined ? {} : { iteration: prepared.iteration }),
        },
      });
      break;
    }
    case "record-check-result": {
      if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) return reject("node_not_check", `Node '${command.nodeId}' is not a check.`);
      if (node.status !== "running" || node.currentAttemptId !== command.attemptId) return reject("stale_check_attempt", "The check result does not match the current running attempt.");
      const invalid = validateCheckResult(command.result, command.attemptId, definitionNode.check.kind); if (invalid) return invalid;
      next = append(next, events, command, { type: "hypagraph.check.result-recorded", nodeId: command.nodeId, attemptId: command.attemptId, data: { result: structuredClone(command.result) } }); break;
    }
    case "evaluate-gate": {
      if ((definitionNode.kind ?? "task") !== "gate" || !definitionNode.gate) return reject("node_not_gate", `Node '${command.nodeId}' is not a gate.`);
      if (node.status !== "ready") return reject("gate_not_ready", `Gate '${command.nodeId}' is not ready.`);
      if (state.runtime.routes[command.nodeId]) return reject("gate_already_evaluated", `Gate '${command.nodeId}' already selected a route.`);
      const result = evaluateCondition(definitionNode.gate.condition, state.runtime.facts); if (!result.ok) return reject(result.code, result.message, `nodes.${command.nodeId}.gate.condition`);
      const selected = result.value ? definitionNode.gate.onTrue : definitionNode.gate.onFalse; const unselected = result.value ? definitionNode.gate.onFalse : definitionNode.gate.onTrue;
      next = append(next, events, command, { type: "hypagraph.route.selected", nodeId: command.nodeId, data: { outcomeId: result.value ? "true" : "false", targetNodeIds: structuredClone(selected), factsUsed: result.factsUsed, semanticsVersion: CONDITION_SEMANTICS_VERSION } });
      for (const nodeId of unselected) { const runtime = next.runtime.nodes[nodeId]; if (runtime && ["pending", "ready", "stale"].includes(runtime.status)) next = append(next, events, command, { type: "hypagraph.node.skipped", nodeId }); }
      next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); break;
    }
    case "publish-facts": {
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_fact_attempt", "The facts do not match the current attempt.");
      if (node.status !== "running") return reject("fact_publication_not_allowed", `Node '${command.nodeId}' cannot publish facts from '${node.status}'.`);
      if (command.facts.length === 0) return reject("facts_required", "Publish at least one fact.");
      if (new Set(command.facts.map((fact) => fact.name)).size !== command.facts.length) return reject("duplicate_fact_input", "A publication command must not contain the same fact more than one time.");
      const attempt = node.attempts[command.attemptId]!;
      const validated: PublishedFact[] = [];
      for (const input of command.facts) {
        const fact: PublishedFact = {
          name: input.name,
          type: input.type,
          value: structuredClone(input.value),
          producerNodeId: command.nodeId,
          attemptId: command.attemptId,
          revision: state.revision,
          evidence: structuredClone(input.evidence ?? []),
          ...(attempt.loopId === undefined ? {} : { loopId: attempt.loopId }),
          ...(attempt.iteration === undefined ? {} : { iteration: attempt.iteration }),
        };
        const result = validatePublishedFact(fact, { contracts: definitionNode.produces ?? [], currentRevision: state.revision, currentAttemptId: command.attemptId }); if (!result.ok) return reject(result.code, result.message, `facts.${input.name}`); validated.push(result.fact);
      }
      for (const fact of validated) next = append(next, events, command, { type: "hypagraph.fact.published", nodeId: command.nodeId, attemptId: command.attemptId, data: { fact: structuredClone(fact) } }); break;
    }
    case "submit-result": { if (node.status !== "running" || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The result does not match the current running attempt."); if (state.definition.policy.requireEvidence && command.evidence.length === 0) return reject("evidence_required", `Node '${command.nodeId}' requires evidence.`); next = append(next, events, command, { type: "hypagraph.attempt.result-submitted", nodeId: command.nodeId, attemptId: command.attemptId, data: { evidence: structuredClone(command.evidence) } }); break; }
    case "begin-verification": { if (node.status !== "awaiting_evidence" || node.currentAttemptId !== command.attemptId) return reject("attempt_not_submitted", "Submit the current attempt result before verification."); next = append(next, events, command, { type: "hypagraph.verification.started", nodeId: command.nodeId, attemptId: command.attemptId }); break; }
    case "complete-verification": {
      if (node.status !== "verifying" || node.currentAttemptId !== command.attemptId) return reject("attempt_not_verifying", "The current attempt is not in verification.");
      if (command.passed) {
        const missing = requiredFactsArePresent(state, command.nodeId, command.attemptId);
        if (missing.length > 0) return reject("required_facts_missing", `Node '${command.nodeId}' did not publish required facts: ${missing.join(", ")}.`);
      }
      const evaluation = command.passed ? prepareLoopEvaluation(state, command.nodeId) : undefined;
      if (evaluation && "ok" in evaluation) return evaluation;
      next = append(next, events, command, { type: command.passed ? "hypagraph.verification.passed" : "hypagraph.verification.failed", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} });
      if (evaluation) {
        next = append(next, events, command, {
          type: "hypagraph.loop.evaluated",
          loopId: evaluation.loopId,
          data: {
            loopId: evaluation.loopId,
            iteration: evaluation.iteration,
            success: evaluation.success,
            factsUsed: structuredClone(evaluation.factsUsed),
            semanticsVersion: evaluation.semanticsVersion,
            decision: evaluation.success ? "complete" : "pending",
          },
        });
        if (evaluation.success) next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
      }
      if (command.passed) { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
      break;
    }
    case "block-node": { if (!["pending", "ready", "running", "stale", "failed"].includes(node.status)) return reject("node_not_blockable", `Node '${command.nodeId}' cannot be blocked from '${node.status}'.`); if (!command.reason.trim()) return reject("block_reason_required", "A blocked node requires a reason."); next = append(next, events, command, { type: "hypagraph.node.blocked", nodeId: command.nodeId, data: { reason: command.reason.trim() } }); break; }
    case "unblock-node": { if (node.status !== "blocked") return reject("node_not_blocked", `Node '${command.nodeId}' is not blocked.`); next = append(next, events, command, { type: "hypagraph.node.unblocked", nodeId: command.nodeId }); next = appendReadyEvents(next, events, command); break; }
    case "cancel-attempt": { if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The cancellation does not match the current attempt."); next = append(next, events, command, { type: "hypagraph.attempt.cancelled", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} }); break; }
  }
  return { ok: true, state: next, events };
}

export const reduceHypagraph = handleCommand;
export { replayEvents };
export function assertValid(result: ReducerResult): HypagraphState { if (result.ok) return result.state; throw new Error(result.diagnostics.map((item: Diagnostic) => `${item.code}: ${item.message}`).join("\n")); }
''')
