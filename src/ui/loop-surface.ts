import type { HypagraphState, LoopDefinition, LoopFailurePolicy, LoopRuntime } from "../domain/model.js";
import { loopFailurePolicy } from "../domain/workflow-outcome.js";
import { projectGraphView } from "../graph/projection.js";

export interface LoopSurfaceSummary {
  id: string;
  status: string;
  iteration: { current: number; limit: number };
  evaluationNodeId: string;
  feedbackEdges: Array<{ source: string; target: string; selected: boolean }>;
  lastSuccess?: boolean;
  progress?: {
    fact: string;
    direction: "minimize" | "maximize";
    minDelta: number;
    currentMetric?: number;
    bestMetric?: number;
    bestIteration?: number;
    noProgressCount: number;
    patience?: number;
    remainingPatience?: number;
  };
  failurePolicy: LoopFailurePolicy;
  componentId?: string;
  localOutcome: string;
  workflowEffect: string;
  exitReason?: string;
  blockedReason?: string;
  warning?: { code: string; message: string };
}

const workflowEffect = (runtime: LoopRuntime | undefined, policy: LoopFailurePolicy): string => {
  if (!runtime || runtime.status === "pending" || runtime.status === "running" || runtime.status === "requires_revision") return "pending";
  if (runtime.status === "succeeded") return "releases-dependants";
  if (runtime.status === "blocked") return "blocks-region";
  if (policy === "fail-workflow") return "fails-workflow";
  if (policy === "block-dependants") return "blocks-dependants";
  return "records-failure-and-continues";
};

const loopWarning = (loop: LoopDefinition, runtime: LoopRuntime | undefined): LoopSurfaceSummary["warning"] => {
  if (runtime?.status === "requires_revision" || runtime?.legacyPredicate !== undefined || typeof loop.successWhen === "string" || (typeof loop.successWhen === "object" && loop.successWhen !== null && "kind" in loop.successWhen && loop.successWhen.kind === "legacy-text")) {
    return { code: "loop_predicate_revision_required", message: "Replace the legacy text predicate with a typed success condition before this loop can run." };
  }
  if (runtime?.exitReason === "max_iterations") return { code: "loop_max_iterations_exhausted", message: "The loop reached its hard iteration limit without satisfying its success condition." };
  if (runtime?.exitReason === "evaluation_error") return { code: "loop_evaluation_error", message: "The evaluation boundary could not produce a valid deterministic loop decision." };
  return undefined;
};

export function loopSurfaceSummaries(state: HypagraphState): LoopSurfaceSummary[] {
  const view = projectGraphView(state);
  const componentByLoop = new Map(view.loops.map((loop) => [loop.id, loop.componentId]));
  return state.definition.loops.map((loop) => {
    const runtime = state.runtime.loops[loop.id];
    const policy = loopFailurePolicy(loop);
    const selectedFeedback = runtime?.status === "running" && runtime.currentIteration > 1;
    const warning = loopWarning(loop, runtime);
    return {
      id: loop.id,
      status: runtime?.status ?? "pending",
      iteration: { current: runtime?.currentIteration ?? 0, limit: loop.maxIterations },
      evaluationNodeId: loop.evaluateAfter,
      feedbackEdges: loop.feedbackEdges.map((edge) => ({ source: edge.from, target: edge.to, selected: selectedFeedback })),
      ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
      ...(loop.progress === undefined ? {} : {
        progress: {
          fact: loop.progress.fact,
          direction: loop.progress.direction,
          minDelta: loop.progress.minDelta ?? 0,
          ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
          ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
          ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
          noProgressCount: runtime?.noProgressCount ?? 0,
          ...(loop.patience === undefined ? {} : {
            patience: loop.patience,
            remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)),
          }),
        },
      }),
      failurePolicy: policy,
      ...(componentByLoop.get(loop.id) === undefined ? {} : { componentId: componentByLoop.get(loop.id)! }),
      localOutcome: runtime?.status ?? "pending",
      workflowEffect: workflowEffect(runtime, policy),
      ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
      ...(runtime?.blockedReason === undefined ? {} : { blockedReason: runtime.blockedReason }),
      ...(warning === undefined ? {} : { warning }),
    };
  });
}

export function renderLoopStatus(state: HypagraphState): string {
  const loops = loopSurfaceSummaries(state);
  if (loops.length === 0) return "This Hypagraph has no bounded iteration regions.";
  return loops.map((loop) => {
    const feedback = loop.feedbackEdges.map((edge) => `${edge.source}->${edge.target}${edge.selected ? " (selected)" : ""}`).join(", ") || "none";
    const metric = loop.progress === undefined
      ? ""
      : ` | metric ${loop.progress.currentMetric ?? "none"}, best ${loop.progress.bestMetric ?? "none"}${loop.progress.bestIteration === undefined ? "" : ` at ${loop.progress.bestIteration}`}, no-progress ${loop.progress.noProgressCount}${loop.progress.patience === undefined ? "" : `/${loop.progress.patience}`}`;
    const warning = loop.warning ? `\n  warning ${loop.warning.code}: ${loop.warning.message}` : "";
    return `${loop.id}: ${loop.status} | iteration ${loop.iteration.current}/${loop.iteration.limit} | evaluate ${loop.evaluationNodeId} | feedback ${feedback} | policy ${loop.failurePolicy} | component ${loop.componentId ?? "none"} | outcome ${loop.localOutcome} | workflow ${loop.workflowEffect}${loop.exitReason ? ` | exit ${loop.exitReason}` : ""}${metric}${warning}`;
  }).join("\n");
}
