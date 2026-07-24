import type {
  CheckResultStatus,
  EvaluationIntegrityObservation,
  EvaluationKind,
  EvaluatorTrustLevel,
  HypagraphState,
  LoopStatus,
  NodeKind,
  NodeStatus,
  WorkflowPhase,
} from "../domain/model.js";
import { evaluationBudgetStatus } from "../domain/evaluation-policy.js";
import { classifyGoalBlockage } from "../domain/goal-blockage.js";

export type GraphEdgeKind = "dependency" | "route" | "feedback";
export type GraphRouteOutcome = "true" | "false";

export interface GraphViewCheckSummary {
  status: CheckResultStatus;
  exitCode?: number;
  error?: string;
  evaluator?: GraphViewEvaluatorSummary;
}

export interface GraphViewEvaluatorSummary {
  purpose: EvaluationKind;
  trustLevel?: EvaluatorTrustLevel;
  evaluatorVersion?: string;
  evaluatorFingerprint?: string;
  integrityStatus?: "pending" | "valid" | "invalid";
  integrityDiagnosticCode?: string;
  protectedEvidence: {
    verified: number;
    invalid: number;
    total: number;
  };
}

export interface GraphViewNode {
  id: string;
  title: string;
  kind: NodeKind;
  status: NodeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  active: boolean;
  ready: boolean;
  factCount: number;
  evidenceCount: number;
  componentId?: string;
  loopId?: string;
  iteration?: number;
  check?: GraphViewCheckSummary;
  evaluator?: GraphViewEvaluatorSummary;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  selected: boolean;
  skipped: boolean;
  outcome?: GraphRouteOutcome;
}

export interface GraphViewFeedbackEdge {
  source: string;
  target: string;
}

export interface GraphViewLoop {
  id: string;
  nodeIds: string[];
  entryNodeId: string;
  evaluationNodeId: string;
  feedbackEdges: GraphViewFeedbackEdge[];
  maxIterations: number;
  status: LoopStatus;
  currentIteration: number;
  lastValid?: boolean;
  lastSuccess?: boolean;
  exitReason?: string;
  currentMetric?: number;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount?: number;
  patience?: number;
  remainingPatience?: number;
  invalidEvaluationCount?: number;
  maximumInvalidEvaluations?: number;
  remainingInvalidEvaluations?: number;
  evaluator?: GraphViewEvaluatorSummary;
  componentId?: string;
  failurePolicy?: "fail-workflow" | "block-dependants" | "record-and-continue";
}

export interface GraphViewComponent {
  id: string;
  nodeIds: string[];
  loopIds: string[];
}


export interface GraphViewEvaluationBudget {
  counts: { total: number; development: number; probe: number; holdout: number };
  limits: {
    maximumEvaluations?: number;
    maximumDevelopmentEvaluations?: number;
    maximumProbeEvaluations?: number;
    maximumHoldoutEvaluations?: number;
  };
  remaining: { total?: number; development?: number; probe?: number; holdout?: number };
}

export interface GraphViewGoalSummary {
  objective: string;
  goalId: string;
  status: NonNullable<HypagraphState["goal"]>["status"];
  pauseCause?: NonNullable<HypagraphState["goal"]>["pauseCause"];
  stopReason?: string;
  budget: {
    turns: { consumed: number; limit?: number; remaining?: number };
    tokens: { consumed: number; limit?: number; remaining?: number };
  };
  automaticRevision: {
    consumed: number;
    maximum: number;
    remaining: number;
    pending: boolean;
    lastOutcome?: string;
    lastOutcomeCode?: string;
  };
  blockage: {
    kind: ReturnType<typeof classifyGoalBlockage>["kind"];
    blockerKind?: string;
    blockerId?: string;
    reason?: string;
  };
}

export interface GraphViewModel {
  workflowId: string;
  revision: number;
  sequence: number;
  phase: WorkflowPhase;
  title: string;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  components?: GraphViewComponent[];
  readyNodeIds: string[];
  activeNodeId?: string;
  evaluationBudget?: GraphViewEvaluationBudget;
  goal?: GraphViewGoalSummary;
}

const ACTIVE_STATUSES = new Set<NodeStatus>(["starting", "running", "awaiting_evidence", "verifying"]);

const edgeId = (
  kind: GraphEdgeKind,
  source: string,
  target: string,
  outcome?: GraphRouteOutcome,
): string => `${kind}:${source}:${target}${outcome === undefined ? "" : `:${outcome}`}`;

const edgeSort = (left: GraphViewEdge, right: GraphViewEdge): number =>
  left.source.localeCompare(right.source)
  || left.target.localeCompare(right.target)
  || left.kind.localeCompare(right.kind)
  || (left.outcome ?? "").localeCompare(right.outcome ?? "");

const evaluatorSummary = (
  state: HypagraphState,
  nodeId: string,
  observation?: EvaluationIntegrityObservation,
): GraphViewEvaluatorSummary | undefined => {
  const check = state.definition.nodes.find((node) => node.id === nodeId)?.check;
  if (check?.kind !== "metric-report" || !check.evaluation) return undefined;
  const integrity = check.evaluation.integrity;
  const evidence = observation?.protectedEvidence ?? [];
  return {
    purpose: check.evaluation.kind,
    ...(integrity === undefined ? {} : {
      trustLevel: integrity.trustLevel,
      integrityStatus: observation?.status ?? "pending",
    }),
    ...(observation?.evaluatorVersion === undefined && integrity?.evaluatorVersion?.value === undefined
      ? {}
      : { evaluatorVersion: observation?.evaluatorVersion ?? integrity!.evaluatorVersion!.value }),
    ...(observation?.evaluatorFingerprint === undefined ? {} : { evaluatorFingerprint: observation.evaluatorFingerprint }),
    ...(observation?.diagnosticCodes[0] === undefined ? {} : { integrityDiagnosticCode: observation.diagnosticCodes[0] }),
    protectedEvidence: {
      verified: evidence.filter((item) => item.status === "verified").length,
      invalid: evidence.filter((item) => item.status !== "verified").length,
      total: evidence.length,
    },
  };
};

const graphComponents = (state: HypagraphState): { componentByNode: Map<string, string>; components: GraphViewComponent[] } => {
  const adjacency = new Map(state.definition.nodes.map((node) => [node.id, new Set<string>()]));
  for (const node of state.definition.nodes) {
    for (const required of node.requires) {
      adjacency.get(node.id)?.add(required);
      adjacency.get(required)?.add(node.id);
    }
  }
  const componentByNode = new Map<string, string>();
  const components: GraphViewComponent[] = [];
  for (const start of state.definition.nodes.map((node) => node.id).sort()) {
    if (componentByNode.has(start)) continue;
    const members: string[] = [];
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      members.push(nodeId);
      for (const neighbour of [...(adjacency.get(nodeId) ?? [])].sort()) if (!seen.has(neighbour)) queue.push(neighbour);
    }
    members.sort();
    const id = `component:${members[0]}`;
    for (const nodeId of members) componentByNode.set(nodeId, id);
    components.push({
      id,
      nodeIds: members,
      loopIds: state.definition.loops.filter((loop) => loop.nodes.some((nodeId) => members.includes(nodeId))).map((loop) => loop.id).sort(),
    });
  }
  return { componentByNode, components: components.sort((left, right) => left.id.localeCompare(right.id)) };
};

export function projectGraphView(state: HypagraphState): GraphViewModel {
  const { componentByNode, components } = graphComponents(state);
  const loopByNode = new Map<string, string>();
  const feedbackKeys = new Set<string>();
  const loops: GraphViewLoop[] = state.definition.loops
    .map((loop) => {
      for (const nodeId of loop.nodes) loopByNode.set(nodeId, loop.id);
      const feedbackEdges = loop.feedbackEdges
        .map((edge) => ({ source: edge.from, target: edge.to }))
        .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
      for (const edge of feedbackEdges) feedbackKeys.add(`${edge.source}\u0000${edge.target}`);
      const runtime = state.runtime.loops[loop.id];
      const invalidEvaluationCount = runtime?.invalidEvaluationCount ?? 0;
      const evaluator = evaluatorSummary(state, loop.evaluateAfter, runtime?.evaluatorIntegrity);
      return {
        id: loop.id,
        nodeIds: [...loop.nodes].sort(),
        entryNodeId: loop.entry,
        evaluationNodeId: loop.evaluateAfter,
        feedbackEdges,
        maxIterations: loop.maxIterations,
        status: runtime?.status ?? "pending",
        currentIteration: runtime?.currentIteration ?? 0,
        failurePolicy: loop.failurePolicy ?? "fail-workflow",
        ...(componentByNode.get(loop.entry) === undefined ? {} : { componentId: componentByNode.get(loop.entry)! }),
        noProgressCount: runtime?.noProgressCount ?? 0,
        ...(loop.patience === undefined ? {} : { patience: loop.patience, remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)) }),
        ...(runtime?.lastValid === undefined ? {} : { lastValid: runtime.lastValid }),
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
        ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
        ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
        ...(loop.evaluation === undefined ? {} : {
          invalidEvaluationCount,
          maximumInvalidEvaluations: loop.evaluation.maximumInvalidEvaluations,
          remainingInvalidEvaluations: Math.max(0, loop.evaluation.maximumInvalidEvaluations - invalidEvaluationCount),
        }),
        ...(evaluator === undefined ? {} : { evaluator }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const factCountByNode = new Map<string, number>();
  for (const fact of Object.values(state.runtime.facts)) {
    factCountByNode.set(fact.producerNodeId, (factCountByNode.get(fact.producerNodeId) ?? 0) + 1);
  }

  const nodes: GraphViewNode[] = state.definition.nodes
    .map((definition) => {
      const runtime = state.runtime.nodes[definition.id];
      if (!runtime) throw new Error(`Graph projection cannot find runtime state for node '${definition.id}'.`);
      const attempt = runtime.currentAttemptId === undefined
        ? Object.values(runtime.attempts).sort((left, right) => right.number - left.number)[0]
        : runtime.attempts[runtime.currentAttemptId];
      const checkResult = attempt?.checkResult;
      const evaluator = evaluatorSummary(state, definition.id, checkResult?.evaluation?.integrity);
      const protectsEvaluatorOutput = definition.check?.kind === "metric-report"
        && definition.check.evaluation !== undefined
        && definition.check.evaluation.feedback.exposeRawReport !== true;
      return {
        id: definition.id,
        title: definition.title,
        kind: definition.kind ?? "task",
        status: runtime.status,
        attemptCount: runtime.attemptCount,
        ...(runtime.currentAttemptId === undefined ? {} : { currentAttemptId: runtime.currentAttemptId }),
        active: ACTIVE_STATUSES.has(runtime.status),
        ready: runtime.status === "ready",
        factCount: factCountByNode.get(definition.id) ?? 0,
        evidenceCount: runtime.evidence.length,
        ...(componentByNode.get(definition.id) === undefined ? {} : { componentId: componentByNode.get(definition.id)! }),
        ...(loopByNode.get(definition.id) === undefined ? {} : { loopId: loopByNode.get(definition.id)! }),
        ...(attempt?.iteration === undefined ? {} : { iteration: attempt.iteration }),
        ...(evaluator === undefined ? {} : { evaluator }),
        ...(checkResult === undefined
          ? {}
          : {
              check: {
                status: checkResult.status,
                ...(checkResult.exitCode === undefined ? {} : { exitCode: checkResult.exitCode }),
                ...(checkResult.error === undefined ? {} : { error: protectsEvaluatorOutput ? "The protected evaluator failed." : checkResult.error }),
                ...(evaluator === undefined ? {} : { evaluator }),
              },
            }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const routeTargetKeys = new Set<string>();
  const edges: GraphViewEdge[] = [];

  for (const gateNode of state.definition.nodes.filter((node) => node.kind === "gate" && node.gate)) {
    const selection = state.runtime.routes[gateNode.id];
    const routes: Array<{ outcome: GraphRouteOutcome; targets: string[] }> = [
      { outcome: "true", targets: gateNode.gate!.onTrue },
      { outcome: "false", targets: gateNode.gate!.onFalse },
    ];
    for (const route of routes) {
      for (const target of [...route.targets].sort()) {
        routeTargetKeys.add(`${gateNode.id}\u0000${target}`);
        const selected = selection?.outcomeId === route.outcome && selection.targetNodeIds.includes(target);
        edges.push({
          id: edgeId("route", gateNode.id, target, route.outcome),
          source: gateNode.id,
          target,
          kind: "route",
          selected,
          skipped: selection !== undefined && !selected,
          outcome: route.outcome,
        });
      }
    }
  }

  for (const targetNode of state.definition.nodes) {
    for (const source of [...targetNode.requires].sort()) {
      const key = `${source}\u0000${targetNode.id}`;
      if (feedbackKeys.has(key)) {
        edges.push({
          id: edgeId("feedback", source, targetNode.id),
          source,
          target: targetNode.id,
          kind: "feedback",
          selected: false,
          skipped: false,
        });
      } else if (!routeTargetKeys.has(key)) {
        edges.push({
          id: edgeId("dependency", source, targetNode.id),
          source,
          target: targetNode.id,
          kind: "dependency",
          selected: false,
          skipped: state.runtime.nodes[targetNode.id]?.status === "skipped",
        });
      }
    }
  }

  const readyNodeIds = nodes.filter((node) => node.ready).map((node) => node.id);
  const activeNodeId = nodes.find((node) => node.active)?.id;
  const evaluationBudget = evaluationBudgetStatus(state);
  const blockage = state.goal ? classifyGoalBlockage(state) : undefined;
  const goal = state.goal === undefined
    ? undefined
    : {
        objective: state.definition.goal,
        goalId: state.goal.goalId,
        status: state.goal.status,
        ...(state.goal.pauseCause === undefined ? {} : { pauseCause: state.goal.pauseCause }),
        ...(state.goal.stopReason === undefined ? {} : { stopReason: state.goal.stopReason }),
        budget: {
          turns: {
            consumed: state.goal.budget.consumedTurns,
            ...(state.goal.budget.limits.maximumTurns === undefined
              ? {}
              : {
                  limit: state.goal.budget.limits.maximumTurns,
                  remaining: Math.max(0, state.goal.budget.limits.maximumTurns - state.goal.budget.consumedTurns),
                }),
          },
          tokens: {
            consumed: state.goal.budget.consumedTokens.totalTokens,
            ...(state.goal.budget.limits.maximumTokens === undefined
              ? {}
              : {
                  limit: state.goal.budget.limits.maximumTokens,
                  remaining: Math.max(0, state.goal.budget.limits.maximumTokens - state.goal.budget.consumedTokens.totalTokens),
                }),
          },
        },
        automaticRevision: {
          consumed: state.goal.automaticRevision.consumedAttempts,
          maximum: state.goal.automaticRevision.maximumAttempts,
          remaining: Math.max(0, state.goal.automaticRevision.maximumAttempts - state.goal.automaticRevision.consumedAttempts),
          pending: state.goal.pendingContinuation?.action.kind === "request-revision"
            || state.goal.automaticRevision.lastAttempt?.outcome === "pending",
          ...(state.goal.automaticRevision.lastAttempt?.outcome === undefined
            ? {}
            : { lastOutcome: state.goal.automaticRevision.lastAttempt.outcome }),
          ...(state.goal.automaticRevision.lastAttempt?.outcomeCode === undefined
            ? {}
            : { lastOutcomeCode: state.goal.automaticRevision.lastAttempt.outcomeCode }),
        },
        blockage: blockage === undefined || blockage.kind === "not-blocked"
          ? { kind: "not-blocked" as const }
          : {
              kind: blockage.kind,
              blockerKind: blockage.blocker.kind,
              blockerId: blockage.blocker.id,
              reason: "reason" in blockage ? blockage.reason : blockage.blocker.reason,
            },
      };

  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    phase: state.phase,
    title: state.definition.title,
    nodes,
    edges: edges.sort(edgeSort),
    loops,
    components,
    readyNodeIds,
    ...(activeNodeId === undefined ? {} : { activeNodeId }),
    ...(evaluationBudget === undefined ? {} : { evaluationBudget }),
    ...(goal === undefined ? {} : { goal }),
  };
}

export function graphLayoutKey(view: GraphViewModel): string {
  return JSON.stringify({
    revision: view.revision,
    nodes: view.nodes.map((node) => [node.id, node.title, node.kind, node.componentId ?? null, node.loopId ?? null]),
    edges: view.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.outcome ?? null]),
    loops: view.loops.map((loop) => [loop.id, loop.componentId ?? null, loop.nodeIds, loop.entryNodeId, loop.evaluationNodeId, loop.maxIterations, loop.failurePolicy]),
  });
}
