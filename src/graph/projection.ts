import type {
  CheckResultStatus,
  HypagraphState,
  NodeKind,
  NodeStatus,
  WorkflowPhase,
} from "../domain/model.js";

export type GraphEdgeKind = "dependency" | "route" | "feedback";
export type GraphRouteOutcome = "true" | "false";

export interface GraphViewCheckSummary {
  status: CheckResultStatus;
  exitCode?: number;
  error?: string;
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
  loopId?: string;
  check?: GraphViewCheckSummary;
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
  readyNodeIds: string[];
  activeNodeId?: string;
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

export function projectGraphView(state: HypagraphState): GraphViewModel {
  const loopByNode = new Map<string, string>();
  const feedbackKeys = new Set<string>();
  const loops: GraphViewLoop[] = state.definition.loops
    .map((loop) => {
      for (const nodeId of loop.nodes) loopByNode.set(nodeId, loop.id);
      const feedbackEdges = loop.feedbackEdges
        .map((edge) => ({ source: edge.from, target: edge.to }))
        .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
      for (const edge of feedbackEdges) feedbackKeys.add(`${edge.source}\u0000${edge.target}`);
      return {
        id: loop.id,
        nodeIds: [...loop.nodes].sort(),
        entryNodeId: loop.entry,
        evaluationNodeId: loop.evaluateAfter,
        feedbackEdges,
        maxIterations: loop.maxIterations,
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
        ? undefined
        : runtime.attempts[runtime.currentAttemptId];
      const checkResult = attempt?.checkResult;
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
        ...(loopByNode.get(definition.id) === undefined ? {} : { loopId: loopByNode.get(definition.id)! }),
        ...(checkResult === undefined
          ? {}
          : {
              check: {
                status: checkResult.status,
                ...(checkResult.exitCode === undefined ? {} : { exitCode: checkResult.exitCode }),
                ...(checkResult.error === undefined ? {} : { error: checkResult.error }),
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

  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    phase: state.phase,
    title: state.definition.title,
    nodes,
    edges: edges.sort(edgeSort),
    loops,
    readyNodeIds,
    ...(activeNodeId === undefined ? {} : { activeNodeId }),
  };
}

export function graphLayoutKey(view: GraphViewModel): string {
  return JSON.stringify({
    revision: view.revision,
    nodes: view.nodes.map((node) => [node.id, node.title, node.kind, node.loopId ?? null]),
    edges: view.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.outcome ?? null]),
    loops: view.loops.map((loop) => [loop.id, loop.nodeIds, loop.entryNodeId, loop.evaluationNodeId, loop.maxIterations]),
  });
}
