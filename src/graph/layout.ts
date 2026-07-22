import type { GraphViewEdge, GraphViewModel } from "./projection.js";

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphLayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
  order: number;
}

export interface GraphLayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphViewEdge["kind"];
  selected: boolean;
  skipped: boolean;
  points: GraphPoint[];
}

export interface GraphLayoutLoop {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeIds: string[];
  maxIterations: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  loops: GraphLayoutLoop[];
  partial: boolean;
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
}

export interface GraphLayoutOptions {
  density?: "compact" | "normal" | "spacious";
  previous?: GraphLayout;
  maxNodes?: number;
  maxEdges?: number;
}

interface DensityMetrics {
  nodeWidth: number;
  nodeHeight: number;
  horizontalGap: number;
  verticalGap: number;
  margin: number;
}

const METRICS: Record<NonNullable<GraphLayoutOptions["density"]>, DensityMetrics> = {
  compact: { nodeWidth: 14, nodeHeight: 3, horizontalGap: 4, verticalGap: 1, margin: 2 },
  normal: { nodeWidth: 18, nodeHeight: 4, horizontalGap: 6, verticalGap: 2, margin: 2 },
  spacious: { nodeWidth: 22, nodeHeight: 5, horizontalGap: 8, verticalGap: 3, margin: 3 },
};

const DEFAULT_MAX_NODES = 250;
const DEFAULT_MAX_EDGES = 600;

const uniqueForwardEdges = (edges: readonly GraphViewEdge[], visible: ReadonlySet<string>): Array<[string, string]> => {
  const keys = new Set<string>();
  const result: Array<[string, string]> = [];
  for (const edge of edges) {
    if (edge.kind === "feedback" || !visible.has(edge.source) || !visible.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}`;
    if (keys.has(key)) continue;
    keys.add(key);
    result.push([edge.source, edge.target]);
  }
  return result.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
};

const assignRanks = (nodeIds: readonly string[], forwardEdges: readonly [string, string][]): Map<string, number> => {
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  for (const [source, target] of forwardEdges) {
    outgoing.get(source)?.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort();

  const ready = nodeIds.filter((id) => indegree.get(id) === 0).sort();
  const rank = new Map(nodeIds.map((id) => [id, 0]));
  const processed = new Set<string>();
  while (ready.length > 0) {
    const source = ready.shift()!;
    processed.add(source);
    for (const target of outgoing.get(source) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(source) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }

  for (const id of nodeIds.filter((nodeId) => !processed.has(nodeId)).sort()) {
    const incomingRanks = forwardEdges
      .filter(([, target]) => target === id)
      .map(([source]) => rank.get(source) ?? 0);
    rank.set(id, incomingRanks.length === 0 ? 0 : Math.max(...incomingRanks) + 1);
  }
  return rank;
};

const nodeCenterY = (node: GraphLayoutNode): number => node.y + Math.floor(node.height / 2);
const nodeCenterX = (node: GraphLayoutNode): number => node.x + Math.floor(node.width / 2);

const routeForwardEdge = (source: GraphLayoutNode, target: GraphLayoutNode): GraphPoint[] => {
  const start = { x: source.x + source.width - 1, y: nodeCenterY(source) };
  const end = { x: target.x, y: nodeCenterY(target) };
  if (end.x > start.x) {
    const middleX = start.x + Math.max(2, Math.floor((end.x - start.x) / 2));
    return [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end];
  }
  const laneX = Math.max(start.x, end.x) + 2;
  return [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
};

export function layoutGraph(view: GraphViewModel, options: GraphLayoutOptions = {}): GraphLayout {
  const metrics = METRICS[options.density ?? "normal"];
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  const visibleNodes = view.nodes.slice(0, maxNodes);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = view.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .slice(0, maxEdges);
  const forwardEdges = uniqueForwardEdges(visibleEdges, visibleNodeIds);
  const ranks = assignRanks(visibleNodes.map((node) => node.id), forwardEdges);
  const previousById = new Map((options.previous?.nodes ?? []).map((node) => [node.id, node]));
  const nodesByRank = new Map<number, string[]>();
  for (const node of visibleNodes) {
    const nodeRank = ranks.get(node.id) ?? 0;
    const current = nodesByRank.get(nodeRank) ?? [];
    current.push(node.id);
    nodesByRank.set(nodeRank, current);
  }

  const layoutNodes: GraphLayoutNode[] = [];
  for (const [nodeRank, ids] of [...nodesByRank.entries()].sort((left, right) => left[0] - right[0])) {
    ids.sort((left, right) => {
      const previousLeft = previousById.get(left);
      const previousRight = previousById.get(right);
      if (previousLeft && previousRight && previousLeft.rank === previousRight.rank) {
        return previousLeft.order - previousRight.order || left.localeCompare(right);
      }
      if (previousLeft && !previousRight) return -1;
      if (!previousLeft && previousRight) return 1;
      return left.localeCompare(right);
    });
    ids.forEach((id, order) => {
      layoutNodes.push({
        id,
        x: metrics.margin + nodeRank * (metrics.nodeWidth + metrics.horizontalGap),
        y: metrics.margin + order * (metrics.nodeHeight + metrics.verticalGap),
        width: metrics.nodeWidth,
        height: metrics.nodeHeight,
        rank: nodeRank,
        order,
      });
    });
  }
  layoutNodes.sort((left, right) => left.id.localeCompare(right.id));
  const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));

  const loops: GraphLayoutLoop[] = [];
  for (const loop of view.loops) {
    const members = loop.nodeIds.map((id) => nodeById.get(id)).filter((node): node is GraphLayoutNode => node !== undefined);
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((node) => node.x));
    const minY = Math.min(...members.map((node) => node.y));
    const maxX = Math.max(...members.map((node) => node.x + node.width - 1));
    const maxY = Math.max(...members.map((node) => node.y + node.height - 1));
    loops.push({
      id: loop.id,
      x: Math.max(0, minX - 2),
      y: Math.max(0, minY - 1),
      width: maxX - minX + 5,
      height: maxY - minY + 4,
      nodeIds: members.map((node) => node.id).sort(),
      maxIterations: loop.maxIterations,
    });
  }
  loops.sort((left, right) => left.id.localeCompare(right.id));

  const layoutEdges: GraphLayoutEdge[] = [];
  for (const edge of visibleEdges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    let points: GraphPoint[];
    if (edge.kind === "feedback") {
      const loop = loops.find((candidate) => candidate.nodeIds.includes(source.id) && candidate.nodeIds.includes(target.id));
      const laneY = loop ? loop.y + loop.height - 1 : Math.max(source.y + source.height, target.y + target.height) + 1;
      points = [
        { x: nodeCenterX(source), y: source.y + source.height - 1 },
        { x: nodeCenterX(source), y: laneY },
        { x: nodeCenterX(target), y: laneY },
        { x: nodeCenterX(target), y: target.y + target.height - 1 },
      ];
    } else {
      points = routeForwardEdge(source, target);
    }
    layoutEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      selected: edge.selected,
      skipped: edge.skipped,
      points,
    });
  }
  layoutEdges.sort((left, right) => left.id.localeCompare(right.id));

  const right = Math.max(
    1,
    ...layoutNodes.map((node) => node.x + node.width),
    ...loops.map((loop) => loop.x + loop.width),
  );
  const bottom = Math.max(
    1,
    ...layoutNodes.map((node) => node.y + node.height),
    ...loops.map((loop) => loop.y + loop.height),
    ...layoutEdges.flatMap((edge) => edge.points.map((point) => point.y + 1)),
  );

  return {
    width: right + metrics.margin,
    height: bottom + metrics.margin,
    nodes: layoutNodes,
    edges: layoutEdges,
    loops,
    partial: visibleNodes.length < view.nodes.length || visibleEdges.length < view.edges.length,
    hiddenNodeCount: view.nodes.length - visibleNodes.length,
    hiddenEdgeCount: view.edges.length - visibleEdges.length,
  };
}
