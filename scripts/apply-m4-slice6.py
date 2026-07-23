from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists() or file.read_text() != content:
        file.write_text(content)


replace_once(
    "src/domain/model.ts",
    '''export interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}

export interface LoopDefinition {
''',
    '''export interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}

export type LoopFailurePolicy = "fail-workflow" | "block-dependants" | "record-and-continue";

export interface LoopDefinition {
''',
)
replace_once(
    "src/domain/model.ts",
    '''  maxIterations: number;
  progress?: LoopProgressDefinition;
  patience?: number;
}
''',
    '''  maxIterations: number;
  progress?: LoopProgressDefinition;
  patience?: number;
  failurePolicy?: LoopFailurePolicy;
}
''',
)
replace_once(
    "src/domain/model.ts",
    '''  completedAt?: string;
  exitReason?: LoopExitReason;
  legacyPredicate?: string;
}
''',
    '''  completedAt?: string;
  exitReason?: LoopExitReason;
  failurePolicy?: LoopFailurePolicy;
  legacyPredicate?: string;
}
''',
)

write("src/domain/workflow-outcome.ts", r'''import type { HypagraphDefinition, HypagraphState, LoopDefinition, LoopFailurePolicy } from "./model.js";
import { buildOutgoing } from "./scc.js";

export const loopFailurePolicy = (loop: LoopDefinition): LoopFailurePolicy => loop.failurePolicy ?? "fail-workflow";

export const loopIsTerminal = (state: HypagraphState, loopId: string): boolean => {
  const status = state.runtime.loops[loopId]?.status;
  return status === "succeeded" || status === "failed";
};

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId));

export const affectedDependants = (definition: HypagraphDefinition, loopId: string): string[] => {
  const loop = definition.loops.find((candidate) => candidate.id === loopId);
  if (!loop) return [];
  const loopNodes = new Set(loop.nodes);
  const outgoing = buildOutgoing(definition.nodes);
  const queue = (outgoing.get(loop.evaluateAfter) ?? []).filter((nodeId) => !loopNodes.has(nodeId)).sort();
  const affected = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    if (loopNodes.has(nodeId) || affected.has(nodeId)) continue;
    affected.add(nodeId);
    for (const dependent of outgoing.get(nodeId) ?? []) {
      if (!loopNodes.has(dependent) && !affected.has(dependent)) queue.push(dependent);
    }
  }
  return [...affected].sort();
};

export const nodeIsSettledForWorkflow = (state: HypagraphState, nodeId: string): boolean => {
  const status = state.runtime.nodes[nodeId]?.status;
  if (status === "succeeded" || status === "skipped") return true;
  const loop = loopForNode(state, nodeId);
  if (!loop || state.runtime.loops[loop.id]?.status !== "failed") return false;
  return loopFailurePolicy(loop) !== "fail-workflow";
};

export const workflowCanComplete = (state: HypagraphState): boolean =>
  state.definition.loops.every((loop) => loopIsTerminal(state, loop.id))
  && state.definition.nodes.every((node) => nodeIsSettledForWorkflow(state, node.id));

export const workflowBlockedByFailedLoop = (state: HypagraphState): boolean =>
  state.definition.loops.some((loop) => {
    if (state.runtime.loops[loop.id]?.status !== "failed" || loopFailurePolicy(loop) === "fail-workflow") return false;
    return affectedDependants(state.definition, loop.id).some((nodeId) => !nodeIsSettledForWorkflow(state, nodeId));
  });
''')

replace_once(
    "src/domain/projection.ts",
    'import { HYPAGRAPH_SCHEMA_VERSION } from "./model.js";\n',
    'import { HYPAGRAPH_SCHEMA_VERSION } from "./model.js";\nimport { workflowBlockedByFailedLoop, workflowCanComplete } from "./workflow-outcome.js";\n',
)
replace_once(
    "src/domain/projection.ts",
    '''const allLoopsCompleted = (state: Omit<HypagraphState, "snapshotHash">): boolean =>
  Object.values(state.runtime.loops).every((loop) => loop.status === "succeeded");

const finalise = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => {
  const nodes = Object.values(state.runtime.nodes);
  let phase = state.phase;
  if (nodes.length > 0 && nodes.every((node) => node.status === "succeeded" || node.status === "skipped") && allLoopsCompleted(state)) phase = "completed";
  else if (nodes.some((node) => node.status === "blocked") && !nodes.some((node) => ["ready", "running", "verifying", "awaiting_evidence"].includes(node.status))) phase = "blocked";
  else if (phase !== "paused" && phase !== "failed" && phase !== "cancelled") phase = "running";
  return hashState({ ...state, phase });
};
''',
    '''const finalise = (state: Omit<HypagraphState, "snapshotHash">): HypagraphState => {
  const nodes = Object.values(state.runtime.nodes);
  const completeState = state as HypagraphState;
  const runnable = nodes.some((node) => ["ready", "starting", "running", "verifying", "awaiting_evidence"].includes(node.status));
  let phase = state.phase;
  if (phase !== "paused" && phase !== "failed" && phase !== "cancelled") {
    if (workflowCanComplete(completeState)) phase = "completed";
    else if (!runnable && (nodes.some((node) => node.status === "blocked") || workflowBlockedByFailedLoop(completeState))) phase = "blocked";
    else phase = "running";
  }
  return hashState({ ...state, phase });
};
''',
)
replace_once(
    "src/domain/projection.ts",
    '''        const reason = event.data.exitReason;
        runtime.exitReason = reason === "no_progress" || reason === "evaluation_error" ? reason : "max_iterations";
''',
    '''        const reason = event.data.exitReason;
        runtime.exitReason = reason === "no_progress" || reason === "evaluation_error" ? reason : "max_iterations";
        const policy = event.data.failurePolicy;
        if (policy === "fail-workflow" || policy === "block-dependants" || policy === "record-and-continue") runtime.failurePolicy = policy;
''',
)

replace_once(
    "src/domain/reducer.ts",
    'import { validateDefinition } from "./validate.js";\n',
    'import { validateDefinition } from "./validate.js";\nimport { affectedDependants, loopFailurePolicy, workflowCanComplete } from "./workflow-outcome.js";\n',
)
replace_once(
    "src/domain/reducer.ts",
    '''const allLoopsCompleted = (state: HypagraphState): boolean => Object.values(state.runtime.loops).every((loop) => loop.status === "succeeded");
const appendCompletionIfNeeded = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => Object.values(state.runtime.nodes).every((item) => item.status === "succeeded" || item.status === "skipped") && allLoopsCompleted(state) ? append(state, events, command, { type: "hypagraph.workflow.completed" }) : state;
''',
    '''const appendCompletionIfNeeded = (state: HypagraphState, events: DomainEvent[], command: { commandId: string; correlationId?: string; at: string }): HypagraphState => workflowCanComplete(state) && state.phase !== "completed" ? append(state, events, command, { type: "hypagraph.workflow.completed" }) : state;
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''        } else if (exitReason) {
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime?.maxIterations ?? loopDefinition.maxIterations,
              exitReason,
              ...(evaluation.evaluationError === undefined ? {} : { error: evaluation.evaluationError }),
            },
          });
          next = append(next, events, command, {
            type: "hypagraph.workflow.failed",
            data: {
              reason: "loop_failed",
              loopId: evaluation.loopId,
              exitReason,
            },
          });
        }
      }
      if (command.passed && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
''',
    '''        } else if (exitReason) {
          const failurePolicy = loopFailurePolicy(loopDefinition);
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime?.maxIterations ?? loopDefinition.maxIterations,
              exitReason,
              failurePolicy,
              ...(evaluation.evaluationError === undefined ? {} : { error: evaluation.evaluationError }),
            },
          });
          if (failurePolicy === "fail-workflow") {
            next = append(next, events, command, {
              type: "hypagraph.workflow.failed",
              data: {
                reason: "loop_failed",
                loopId: evaluation.loopId,
                exitReason,
                failurePolicy,
              },
            });
          } else if (failurePolicy === "block-dependants") {
            for (const nodeId of affectedDependants(next.definition, evaluation.loopId)) {
              const dependent = next.runtime.nodes[nodeId];
              if (dependent && ["pending", "ready", "stale"].includes(dependent.status)) {
                next = append(next, events, command, {
                  type: "hypagraph.node.blocked",
                  nodeId,
                  loopId: evaluation.loopId,
                  data: {
                    reason: `Loop '${evaluation.loopId}' failed with '${exitReason}'.`,
                    loopId: evaluation.loopId,
                    failurePolicy,
                  },
                });
              }
            }
          }
        }
      }
      if ((command.passed || evaluation !== undefined) && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
''',
)

replace_once(
    "src/domain/validate.ts",
    '''    if (loop.patience !== undefined) {
      if (!loop.progress) diagnostics.push({ code: "patience_requires_progress", message: `Loop '${loop.id}' can use patience only with a progress definition.`, location: `${location}.patience` });
      if (!Number.isInteger(loop.patience) || loop.patience < 1) diagnostics.push({ code: "invalid_loop_patience", message: `Loop '${loop.id}' patience must be a positive integer.`, location: `${location}.patience` });
    }
''',
    '''    if (loop.patience !== undefined) {
      if (!loop.progress) diagnostics.push({ code: "patience_requires_progress", message: `Loop '${loop.id}' can use patience only with a progress definition.`, location: `${location}.patience` });
      if (!Number.isInteger(loop.patience) || loop.patience < 1) diagnostics.push({ code: "invalid_loop_patience", message: `Loop '${loop.id}' patience must be a positive integer.`, location: `${location}.patience` });
    }
    if (loop.failurePolicy !== undefined && !["fail-workflow", "block-dependants", "record-and-continue"].includes(loop.failurePolicy)) diagnostics.push({ code: "invalid_loop_failure_policy", message: `Loop '${loop.id}' has an invalid failure policy.`, location: `${location}.failurePolicy` });
''',
)

replace_once(
    "src/pi/definition.ts",
    '''  progress: Type.Optional(loopProgressSchema),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
});
''',
    '''  progress: Type.Optional(loopProgressSchema),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
  failurePolicy: Type.Optional(StringEnum(["fail-workflow", "block-dependants", "record-and-continue"] as const)),
});
''',
)
replace_once(
    "src/pi/definition.ts",
    '''      ...(loop.progress === undefined ? {} : { progress: { ...loop.progress } }),
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
    })),
''',
    '''      ...(loop.progress === undefined ? {} : { progress: { ...loop.progress } }),
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
      ...(loop.failurePolicy === undefined ? {} : { failurePolicy: loop.failurePolicy }),
    })),
''',
)

replace_once(
    "src/graph/projection.ts",
    '''  evidenceCount: number;
  loopId?: string;
''',
    '''  evidenceCount: number;
  componentId?: string;
  loopId?: string;
''',
)
replace_once(
    "src/graph/projection.ts",
    '''  remainingPatience?: number;
}

export interface GraphViewModel {
''',
    '''  remainingPatience?: number;
  componentId?: string;
  failurePolicy: "fail-workflow" | "block-dependants" | "record-and-continue";
}

export interface GraphViewComponent {
  id: string;
  nodeIds: string[];
  loopIds: string[];
}

export interface GraphViewModel {
''',
)
replace_once(
    "src/graph/projection.ts",
    '''  loops: GraphViewLoop[];
  readyNodeIds: string[];
''',
    '''  loops: GraphViewLoop[];
  components?: GraphViewComponent[];
  readyNodeIds: string[];
''',
)
replace_once(
    "src/graph/projection.ts",
    '''const edgeSort = (left: GraphViewEdge, right: GraphViewEdge): number =>
  left.source.localeCompare(right.source)
  || left.target.localeCompare(right.target)
  || left.kind.localeCompare(right.kind)
  || (left.outcome ?? "").localeCompare(right.outcome ?? "");

export function projectGraphView(state: HypagraphState): GraphViewModel {
''',
    '''const edgeSort = (left: GraphViewEdge, right: GraphViewEdge): number =>
  left.source.localeCompare(right.source)
  || left.target.localeCompare(right.target)
  || left.kind.localeCompare(right.kind)
  || (left.outcome ?? "").localeCompare(right.outcome ?? "");

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
''',
)
replace_once(
    "src/graph/projection.ts",
    '''  const loopByNode = new Map<string, string>();
  const feedbackKeys = new Set<string>();
''',
    '''  const { componentByNode, components } = graphComponents(state);
  const loopByNode = new Map<string, string>();
  const feedbackKeys = new Set<string>();
''',
)
replace_once(
    "src/graph/projection.ts",
    '''        currentIteration: runtime?.currentIteration ?? 0,
        noProgressCount: runtime?.noProgressCount ?? 0,
''',
    '''        currentIteration: runtime?.currentIteration ?? 0,
        failurePolicy: loop.failurePolicy ?? "fail-workflow",
        ...(componentByNode.get(loop.entry) === undefined ? {} : { componentId: componentByNode.get(loop.entry)! }),
        noProgressCount: runtime?.noProgressCount ?? 0,
''',
)
replace_once(
    "src/graph/projection.ts",
    '''        evidenceCount: runtime.evidence.length,
        ...(loopByNode.get(definition.id) === undefined ? {} : { loopId: loopByNode.get(definition.id)! }),
''',
    '''        evidenceCount: runtime.evidence.length,
        ...(componentByNode.get(definition.id) === undefined ? {} : { componentId: componentByNode.get(definition.id)! }),
        ...(loopByNode.get(definition.id) === undefined ? {} : { loopId: loopByNode.get(definition.id)! }),
''',
)
replace_once(
    "src/graph/projection.ts",
    '''    edges: edges.sort(edgeSort),
    loops,
    readyNodeIds,
''',
    '''    edges: edges.sort(edgeSort),
    loops,
    components,
    readyNodeIds,
''',
)
replace_once(
    "src/graph/projection.ts",
    '''    nodes: view.nodes.map((node) => [node.id, node.title, node.kind, node.loopId ?? null]),
''',
    '''    nodes: view.nodes.map((node) => [node.id, node.title, node.kind, node.componentId ?? null, node.loopId ?? null]),
''',
)
replace_once(
    "src/graph/projection.ts",
    '''    loops: view.loops.map((loop) => [loop.id, loop.nodeIds, loop.entryNodeId, loop.evaluationNodeId, loop.maxIterations]),
''',
    '''    loops: view.loops.map((loop) => [loop.id, loop.componentId ?? null, loop.nodeIds, loop.entryNodeId, loop.evaluationNodeId, loop.maxIterations, loop.failurePolicy]),
''',
)

replace_once(
    "src/graph/layout.ts",
    '''    ids.sort((left, right) => {
      const previousLeft = previousById.get(left);
''',
    '''    ids.sort((left, right) => {
      const leftComponent = view.nodes.find((node) => node.id === left)?.componentId ?? "";
      const rightComponent = view.nodes.find((node) => node.id === right)?.componentId ?? "";
      const componentOrder = leftComponent.localeCompare(rightComponent);
      if (componentOrder !== 0) return componentOrder;
      const previousLeft = previousById.get(left);
''',
)

replace_once(
    "src/graph/renderer.ts",
    '''  const iteration = viewLoop?.currentIteration ?? 0;
  const suffix = viewLoop?.status === "succeeded" ? " complete" : viewLoop?.status === "requires_revision" ? " revise" : "";
  canvas.text(loop.x + 2, loop.y, `loop ${loop.id} [${iteration}/${loop.maxIterations}]${suffix}`, Math.max(0, loop.width - 4));
''',
    '''  const iteration = viewLoop?.currentIteration ?? 0;
  const suffix = viewLoop?.status === "succeeded" ? " complete" : viewLoop?.status === "failed" ? ` failed:${viewLoop.exitReason ?? "unknown"}` : viewLoop?.status === "requires_revision" ? " revise" : "";
  const policy = viewLoop?.failurePolicy ?? "fail-workflow";
  canvas.text(loop.x + 2, loop.y, `loop ${loop.id} [${iteration}/${loop.maxIterations}] ${policy}${suffix}`, Math.max(0, loop.width - 4));
''',
)

replace_once(
    "src/ui/format.ts",
    'import { readyNodeIds } from "../domain/readiness.js";\n',
    'import { readyNodeIds } from "../domain/readiness.js";\nimport { loopFailurePolicy } from "../domain/workflow-outcome.js";\n',
)
replace_once(
    "src/ui/format.ts",
    '''        currentIteration: runtime?.currentIteration ?? 0,
        noProgressCount: runtime?.noProgressCount ?? 0,
''',
    '''        currentIteration: runtime?.currentIteration ?? 0,
        failurePolicy: loopFailurePolicy(loop),
        localOutcome: runtime?.status ?? "pending",
        noProgressCount: runtime?.noProgressCount ?? 0,
''',
)
replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);
''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations} - policy ${loopFailurePolicy(loop)}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);
''',
)
replace_once(
    "src/ui/format.ts",
    '''  const progress = shownLoop?.bestMetric === undefined ? "" : ` best ${shownLoop.bestMetric} at ${shownLoop.bestIteration}${definition?.patience === undefined ? "" : ` patience ${Math.max(0, definition.patience - (shownLoop.noProgressCount ?? 0))}/${definition.patience}`}`;
''',
    '''  const progress = shownLoop?.bestMetric === undefined ? "" : ` best ${shownLoop.bestMetric} at ${shownLoop.bestIteration}${definition?.patience === undefined ? "" : ` patience ${Math.max(0, definition.patience - (shownLoop.noProgressCount ?? 0))}/${definition.patience}`}`;
  const policy = definition ? ` ${loopFailurePolicy(definition)}` : "";
  const outcome = shownLoop?.exitReason ? ` ${shownLoop.exitReason}` : "";
''',
)
replace_once(
    "src/ui/format.ts",
    '''    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${shownLoop ? ` | Loop ${shownLoop.loopId}: ${shownLoop.currentIteration}/${shownLoop.maxIterations}${progress}` : ""}`,
''',
    '''    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${shownLoop ? ` | Loop ${shownLoop.loopId}: ${shownLoop.currentIteration}/${shownLoop.maxIterations}${policy}${outcome}${progress}` : ""}`,
''',
)

write("tests/loop-outcome-policy.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState, LoopFailurePolicy } from "../src/domain/model.js";
import { projectGraphView } from "../src/graph/projection.js";
import { layoutGraph } from "../src/graph/layout.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-23T07:00:00.000Z";

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string, attemptId: string, facts: FactInput[] = []): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

const policyDefinition = (alphaPolicy: LoopFailurePolicy | undefined, includeDependent: boolean): HypagraphDefinition => ({
  title: "Independent regions",
  goal: "Apply local loop outcomes without coupling unrelated work",
  nodes: [
    { id: "alpha-work", title: "Alpha work", requires: ["alpha-eval"], acceptance: [] },
    { id: "alpha-eval", title: "Alpha evaluation", requires: ["alpha-work"], acceptance: [], produces: [{ name: "alpha.passed", type: "boolean", required: true }] },
    { id: "beta-work", title: "Beta work", requires: ["beta-eval"], acceptance: [] },
    { id: "beta-eval", title: "Beta evaluation", requires: ["beta-work"], acceptance: [], produces: [{ name: "beta.passed", type: "boolean", required: true }] },
    { id: "outside", title: "Unrelated work", requires: [], acceptance: [] },
    ...(includeDependent ? [{ id: "after-alpha", title: "Alpha dependant", requires: ["alpha-eval"], acceptance: [] }] : []),
  ],
  loops: [
    {
      id: "alpha",
      nodes: ["alpha-work", "alpha-eval"],
      entry: "alpha-work",
      evaluateAfter: "alpha-eval",
      feedbackEdges: [{ from: "alpha-eval", to: "alpha-work" }],
      successWhen: { kind: "compare", left: { kind: "fact", name: "alpha.passed" }, operator: "eq", right: { kind: "literal", value: true } },
      maxIterations: 1,
      ...(alphaPolicy === undefined ? {} : { failurePolicy: alphaPolicy }),
    },
    {
      id: "beta",
      nodes: ["beta-work", "beta-eval"],
      entry: "beta-work",
      evaluateAfter: "beta-eval",
      feedbackEdges: [{ from: "beta-eval", to: "beta-work" }],
      successWhen: { kind: "compare", left: { kind: "fact", name: "beta.passed" }, operator: "eq", right: { kind: "literal", value: true } },
      maxIterations: 1,
      failurePolicy: "record-and-continue",
    },
  ],
  policy: { mode: "guided", requireEvidence: false },
});

const runRegion = (state: HypagraphState, events: DomainEvent[], prefix: "alpha" | "beta", passed: boolean): HypagraphState => {
  let next = completeTask(state, events, `${prefix}-work`, `${prefix}-work-1`);
  return completeTask(next, events, `${prefix}-eval`, `${prefix}-eval-1`, [{ name: `${prefix}.passed`, type: "boolean", value: passed }]);
};

const interleavedDefinition = (): HypagraphDefinition => ({
  title: "Interleaved regions",
  goal: "Keep region facts and routes isolated",
  nodes: [
    { id: "alpha-work", title: "Alpha work", requires: ["alpha-eval"], acceptance: [], produces: [{ name: "alpha.route", type: "boolean", required: true }] },
    { id: "alpha-gate", title: "Alpha gate", kind: "gate", requires: ["alpha-work"], acceptance: [], gate: { condition: { kind: "compare", left: { kind: "fact", name: "alpha.route" }, operator: "eq", right: { kind: "literal", value: true } }, onTrue: ["alpha-a"], onFalse: ["alpha-b"] } },
    { id: "alpha-a", title: "Alpha A", requires: ["alpha-gate"], acceptance: [] },
    { id: "alpha-b", title: "Alpha B", requires: ["alpha-gate"], acceptance: [] },
    { id: "alpha-eval", title: "Alpha evaluation", requires: ["alpha-a", "alpha-b"], acceptance: [], produces: [{ name: "alpha.passed", type: "boolean", required: true }] },
    { id: "beta-work", title: "Beta work", requires: ["beta-eval"], acceptance: [], produces: [{ name: "beta.route", type: "boolean", required: true }] },
    { id: "beta-gate", title: "Beta gate", kind: "gate", requires: ["beta-work"], acceptance: [], gate: { condition: { kind: "compare", left: { kind: "fact", name: "beta.route" }, operator: "eq", right: { kind: "literal", value: true } }, onTrue: ["beta-a"], onFalse: ["beta-b"] } },
    { id: "beta-a", title: "Beta A", requires: ["beta-gate"], acceptance: [] },
    { id: "beta-b", title: "Beta B", requires: ["beta-gate"], acceptance: [] },
    { id: "beta-eval", title: "Beta evaluation", requires: ["beta-a", "beta-b"], acceptance: [], produces: [{ name: "beta.passed", type: "boolean", required: true }] },
  ],
  loops: [
    { id: "alpha", nodes: ["alpha-work", "alpha-gate", "alpha-a", "alpha-b", "alpha-eval"], entry: "alpha-work", evaluateAfter: "alpha-eval", feedbackEdges: [{ from: "alpha-eval", to: "alpha-work" }], successWhen: { kind: "compare", left: { kind: "fact", name: "alpha.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 2, failurePolicy: "record-and-continue" },
    { id: "beta", nodes: ["beta-work", "beta-gate", "beta-a", "beta-b", "beta-eval"], entry: "beta-work", evaluateAfter: "beta-eval", feedbackEdges: [{ from: "beta-eval", to: "beta-work" }], successWhen: { kind: "compare", left: { kind: "fact", name: "beta.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 2, failurePolicy: "record-and-continue" },
  ],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M4 Slice 6 independent regions and outcome policy", () => {
  it("keeps disconnected region state isolated during an interleaved reset", () => {
    const created = createWorkflow(interleavedDefinition(), at, "workflow-independent-isolation");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    expect(created.state.phase).toBe("running");
    expect(created.state.runtime.nodes["alpha-work"]?.status).toBe("ready");
    expect(created.state.runtime.nodes["beta-work"]?.status).toBe("ready");

    let state = completeTask(created.state, events, "beta-work", "beta-work-1", [{ name: "beta.route", type: "boolean", value: true }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "beta-gate", commandId: "beta-gate-1", at });
    expect(state.runtime.routes["beta-gate"]?.outcomeId).toBe("true");
    expect(state.runtime.nodes["beta-a"]?.status).toBe("ready");

    state = completeTask(state, events, "alpha-work", "alpha-work-1", [{ name: "alpha.route", type: "boolean", value: false }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "alpha-gate", commandId: "alpha-gate-1", at });
    state = completeTask(state, events, "alpha-b", "alpha-b-1");
    state = completeTask(state, events, "alpha-eval", "alpha-eval-1", [{ name: "alpha.passed", type: "boolean", value: false }]);

    expect(state.runtime.loops.alpha).toMatchObject({ status: "running", currentIteration: 2 });
    expect(state.runtime.nodes["alpha-work"]?.status).toBe("ready");
    expect(state.runtime.facts["alpha.route"]).toBeUndefined();
    expect(state.runtime.routes["alpha-gate"]).toBeUndefined();
    expect(state.runtime.facts["beta.route"]).toMatchObject({ value: true, loopId: "beta", iteration: 1 });
    expect(state.runtime.routes["beta-gate"]?.outcomeId).toBe("true");
    expect(state.runtime.nodes["beta-a"]?.status).toBe("ready");
    expect(state.runtime.loops.beta).toMatchObject({ status: "running", currentIteration: 1 });
    expect(replayEvents(events)).toEqual(state);
  });

  it("keeps the omitted policy compatible with fail-workflow", () => {
    const created = createWorkflow(policyDefinition(undefined, false), at, "workflow-default-failure");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops.alpha).toMatchObject({ status: "failed", exitReason: "max_iterations", failurePolicy: "fail-workflow" });
    expect(events.at(-1)).toMatchObject({ type: "hypagraph.workflow.failed", data: { failurePolicy: "fail-workflow" } });
  });

  it("blocks only the affected path and keeps unrelated work executable", () => {
    const created = createWorkflow(policyDefinition("block-dependants", true), at, "workflow-block-dependants");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("running");
    expect(state.runtime.nodes["after-alpha"]).toMatchObject({ status: "blocked", blockedReason: "Loop 'alpha' failed with 'max_iterations'." });
    expect(state.runtime.nodes.outside?.status).toBe("ready");
    expect(state.runtime.nodes["beta-work"]?.status).toBe("ready");
    state = completeTask(state, events, "outside", "outside-1");
    state = runRegion(state, events, "beta", true);
    expect(state.phase).toBe("blocked");
    expect(state.runtime.loops.beta?.status).toBe("succeeded");
    expect(replayEvents(events)).toEqual(state);
  });

  it("records an independent local failure and completes the workflow", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", false), at, "workflow-record-local");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("running");
    expect(state.runtime.nodes["beta-work"]?.status).toBe("ready");
    state = runRegion(state, events, "beta", true);
    state = completeTask(state, events, "outside", "outside-record-1");
    expect(state.phase).toBe("completed");
    expect(state.runtime.loops.alpha).toMatchObject({ status: "failed", failurePolicy: "record-and-continue" });
    expect(state.runtime.loops.beta?.status).toBe("succeeded");
    expect(events.some((event) => event.type === "hypagraph.workflow.completed")).toBe(true);
    expect(replayEvents(events)).toEqual(state);
  });

  it("does not release a dependant under record-and-continue", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", true), at, "workflow-record-blocked-path");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.runtime.nodes["after-alpha"]?.status).toBe("pending");
    state = runRegion(state, events, "beta", true);
    state = completeTask(state, events, "outside", "outside-record-blocked-1");
    expect(state.phase).toBe("blocked");
    expect(state.runtime.nodes["after-alpha"]?.status).toBe("pending");
    expect(replayEvents(events)).toEqual(state);
  });

  it("projects disconnected loops as separate top-level components", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", false), at, "workflow-components");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    const alpha = view.loops.find((loop) => loop.id === "alpha")!;
    const beta = view.loops.find((loop) => loop.id === "beta")!;
    expect(alpha.componentId).not.toBe(beta.componentId);
    expect(alpha.failurePolicy).toBe("record-and-continue");
    expect(beta.failurePolicy).toBe("record-and-continue");
    expect(view.components?.map((component) => component.loopIds)).toEqual(expect.arrayContaining([["alpha"], ["beta"]]));
    const layout = layoutGraph(view);
    const alphaBox = layout.loops.find((loop) => loop.id === "alpha")!;
    const betaBox = layout.loops.find((loop) => loop.id === "beta")!;
    const overlap = alphaBox.x < betaBox.x + betaBox.width && alphaBox.x + alphaBox.width > betaBox.x && alphaBox.y < betaBox.y + betaBox.height && alphaBox.y + alphaBox.height > betaBox.y;
    expect(overlap).toBe(false);
  });
});
''')

write("tests/pi-loop-outcome-policy.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";
import { projectGraphView } from "../src/graph/projection.js";

interface RegisteredTool { name: string; execute: (...args: any[]) => Promise<any> }

describe("M4 Slice 6 Pi outcome surface", () => {
  it("accepts independent region policies and reports a local failure", async () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = { on: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)), appendEntry: vi.fn() } as unknown as ExtensionAPI;
    hypagraphExtension(pi);
    const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() } };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);

    await define.execute("define", {
      title: "Independent Pi regions",
      goal: "Record one local result",
      nodes: [
        { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
        { id: "evaluate", title: "Evaluate", requires: ["work"], acceptance: [], produces: [{ name: "region.passed", type: "boolean", required: true }] },
        { id: "outside", title: "Outside", requires: [], acceptance: [] },
      ],
      loops: [{
        id: "experiment",
        nodes: ["work", "evaluate"],
        entry: "work",
        evaluateAfter: "evaluate",
        feedbackEdges: [{ from: "evaluate", to: "work" }],
        successWhen: { kind: "compare", left: { kind: "fact", name: "region.passed" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 1,
        failurePolicy: "record-and-continue",
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await call("work-start", { action: "start", nodeId: "work" });
    await call("work-submit", { action: "submit", nodeId: "work", evidence: [] });
    await call("work-verify", { action: "verify", nodeId: "work", passed: true });
    await call("evaluate-start", { action: "start", nodeId: "evaluate" });
    await call("evaluate-facts", { action: "publish", nodeId: "evaluate", facts: [{ name: "region.passed", type: "boolean", value: false }] });
    await call("evaluate-submit", { action: "submit", nodeId: "evaluate", evidence: [] });
    const result = await call("evaluate-verify", { action: "verify", nodeId: "evaluate", passed: true });
    const persisted = result.details.hypagraph as PersistedHypagraph;
    expect(persisted.snapshot.phase).toBe("running");
    expect(persisted.snapshot.runtime.loops.experiment).toMatchObject({ status: "failed", failurePolicy: "record-and-continue", exitReason: "max_iterations" });
    expect(persisted.snapshot.runtime.nodes.outside?.status).toBe("ready");
    expect(result.content[0].text).toContain("policy record-and-continue");
    expect(result.content[0].text).toContain("max_iterations");
    expect(projectGraphView(persisted.snapshot).loops[0]).toMatchObject({ failurePolicy: "record-and-continue" });
  });
});
''')

replace_once(
    "docs/m4-vertical-slice-plan.md",
    '''### Slice 6 - Add independent loop regions and outcome policy

#### User result
''',
    '''### Slice 6 - Add independent loop regions and outcome policy

- Status: implemented

#### User result
''',
)
replace_once(
    "docs/event-runtime.md",
    '''It does not yet support:

- loop cancellation and revision hardening;
''',
    '''## Independent region outcomes

A loop definition can set `failurePolicy` to `fail-workflow`, `block-dependants`, or `record-and-continue`. An omitted policy means `fail-workflow` and does not change the initial schema-3 snapshot shape.

A terminal failure stores the selected policy in `hypagraph.loop.failed`. `block-dependants` stores node-block events for the affected path. `record-and-continue` keeps unrelated work executable but does not release a dependant that requires loop success. The workflow completes only after every loop region is terminal. An independent recorded failure can coexist with a completed workflow.

Disconnected regions have separate attempts, facts, routes, progress values, resets, and graph-component IDs. M4 dispatch remains sequential, but region outcomes do not share runtime state.

It does not yet support:

- loop cancellation and revision hardening;
''',
)
replace_once(
    "README.md",
    "M4 is in progress. Slices 1 to 5 provide multi-iteration task and check repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
    "M4 is in progress. Slices 1 to 6 provide generic bounded iteration regions, independent graph components, explicit failure policies, hard iteration limits, numeric progress, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
)
replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slices 1 to 5 execute bounded task-based and command-check repair loops. Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Do not select loop decisions manually.",
    "M4 Slices 1 to 6 execute generic bounded iteration regions. A region can be disconnected from the wider graph. Optional progress uses one numeric fact with a minimize or maximize direction. Failure policy is `fail-workflow`, `block-dependants`, or `record-and-continue`; omission means `fail-workflow`. A local failure never releases a dependant that requires region success. Unrelated ready work can continue when policy permits. Do not infer repair intent from node names and do not select region decisions manually.",
)

for path in [
    "src/domain/model.ts",
    "src/domain/workflow-outcome.ts",
    "src/domain/projection.ts",
    "src/domain/reducer.ts",
    "src/domain/validate.ts",
    "src/pi/definition.ts",
    "src/graph/projection.ts",
    "src/graph/layout.ts",
    "src/graph/renderer.ts",
    "src/ui/format.ts",
    "tests/loop-outcome-policy.test.ts",
    "tests/pi-loop-outcome-policy.test.ts",
    "docs/m4-vertical-slice-plan.md",
    "docs/event-runtime.md",
    "README.md",
    "skills/hypagraph/SKILL.md",
]:
    data = Path(path).read_bytes()
    if b"\x00" in data:
        raise SystemExit(f"NUL control character found in {path}")
