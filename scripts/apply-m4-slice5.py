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
    file.write_text(content)


replace_once(
    "src/domain/model.ts",
    '''export interface LoopDefinition {
  id: string;
  nodes: string[];
  entry: string;
  evaluateAfter: string;
  feedbackEdges: FeedbackEdge[];
  successWhen: LoopSuccessPredicate;
  maxIterations: number;
  patience?: number;
}
''',
    '''export interface LoopProgressDefinition {
  fact: string;
  direction: "minimize" | "maximize";
  minDelta?: number;
}

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
}
''',
)
replace_once(
    "src/domain/model.ts",
    'export type LoopExitReason = "success" | "max_iterations";',
    'export type LoopExitReason = "success" | "max_iterations" | "no_progress" | "evaluation_error";',
)
replace_once(
    "src/domain/model.ts",
    '''  semanticsVersion?: number;
  decision?: LoopDecision;
}
''',
    '''  semanticsVersion?: number;
  decision?: LoopDecision;
  metric?: number;
  improved?: boolean;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount?: number;
}
''',
)
replace_once(
    "src/domain/model.ts",
    '''  factsUsed: string[];
  semanticsVersion?: number;
  startedAt?: string;
''',
    '''  factsUsed: string[];
  semanticsVersion?: number;
  currentMetric?: number;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount: number;
  startedAt?: string;
''',
)

replace_once(
    "src/domain/projection.ts",
    '''    iterations: [],
    factsUsed: [],
    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),
''',
    '''    iterations: [],
    factsUsed: [],
    noProgressCount: 0,
    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),
''',
)
replace_once(
    "src/domain/projection.ts",
    '''          record.semanticsVersion = semanticsVersion;
          record.decision = decision;
        }
        runtime.lastSuccess = success;
        runtime.factsUsed = structuredClone(factsUsed);
        runtime.semanticsVersion = semanticsVersion;
''',
    '''          record.semanticsVersion = semanticsVersion;
          record.decision = decision;
          if (typeof event.data.metric === "number") record.metric = event.data.metric;
          if (typeof event.data.improved === "boolean") record.improved = event.data.improved;
          if (typeof event.data.bestMetric === "number") record.bestMetric = event.data.bestMetric;
          if (typeof event.data.bestIteration === "number") record.bestIteration = event.data.bestIteration;
          if (typeof event.data.noProgressCount === "number") record.noProgressCount = event.data.noProgressCount;
        }
        runtime.lastSuccess = success;
        runtime.factsUsed = structuredClone(factsUsed);
        runtime.semanticsVersion = semanticsVersion;
        if (typeof event.data.metric === "number") runtime.currentMetric = event.data.metric;
        if (typeof event.data.bestMetric === "number") runtime.bestMetric = event.data.bestMetric;
        if (typeof event.data.bestIteration === "number") runtime.bestIteration = event.data.bestIteration;
        if (typeof event.data.noProgressCount === "number") runtime.noProgressCount = event.data.noProgressCount;
''',
)
replace_once(
    "src/domain/projection.ts",
    '''        runtime.status = "failed";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "max_iterations";
''',
    '''        runtime.status = "failed";
        runtime.completedAt = event.timestamp;
        const reason = event.data.exitReason;
        runtime.exitReason = reason === "no_progress" || reason === "evaluation_error" ? reason : "max_iterations";
''',
)

replace_once(
    "src/domain/validate.ts",
    '''    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) diagnostics.push({ code: "invalid_loop_limit", message: `Loop '${loop.id}' must have a positive iteration limit.`, location: `${location}.maxIterations` });
    if (loop.patience !== undefined) diagnostics.push({ code: "loop_patience_not_available", message: `Loop '${loop.id}' cannot use patience before the M4 progress slice.`, location: `${location}.patience` });
''',
    '''    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) diagnostics.push({ code: "invalid_loop_limit", message: `Loop '${loop.id}' must have a positive iteration limit.`, location: `${location}.maxIterations` });
    if (loop.progress) {
      const type = factTypes.get(loop.progress.fact);
      const owner = factOwners.get(loop.progress.fact);
      if (!type) diagnostics.push({ code: "unknown_progress_fact", message: `Loop '${loop.id}' uses undeclared progress fact '${loop.progress.fact}'.`, location: `${location}.progress.fact` });
      else if (!numericType(type)) diagnostics.push({ code: "progress_fact_not_numeric", message: `Loop progress fact '${loop.progress.fact}' must be numeric.`, location: `${location}.progress.fact` });
      if (owner && !loopNodes.has(owner)) diagnostics.push({ code: "progress_fact_not_in_loop", message: `Loop progress fact '${loop.progress.fact}' must be produced inside loop '${loop.id}'.`, location: `${location}.progress.fact` });
      if (loop.progress.direction !== "minimize" && loop.progress.direction !== "maximize") diagnostics.push({ code: "invalid_progress_direction", message: `Loop '${loop.id}' progress direction must be 'minimize' or 'maximize'.`, location: `${location}.progress.direction` });
      if (loop.progress.minDelta !== undefined && (!Number.isFinite(loop.progress.minDelta) || loop.progress.minDelta < 0)) diagnostics.push({ code: "invalid_progress_delta", message: `Loop '${loop.id}' minimum progress delta must be a finite non-negative number.`, location: `${location}.progress.minDelta` });
    }
    if (loop.patience !== undefined) {
      if (!loop.progress) diagnostics.push({ code: "patience_requires_progress", message: `Loop '${loop.id}' can use patience only with a progress definition.`, location: `${location}.patience` });
      if (!Number.isInteger(loop.patience) || loop.patience < 1) diagnostics.push({ code: "invalid_loop_patience", message: `Loop '${loop.id}' patience must be a positive integer.`, location: `${location}.patience` });
    }
''',
)

replace_once(
    "src/pi/definition.ts",
    '''const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopSchema = Type.Object({
''',
    '''const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopProgressSchema = Type.Object({
  fact: Type.String(),
  direction: StringEnum(["minimize", "maximize"] as const),
  minDelta: Type.Optional(Type.Number({ minimum: 0 })),
});
const loopSchema = Type.Object({
''',
)
replace_once(
    "src/pi/definition.ts",
    '''  successWhen: conditionSchema,
  maxIterations: Type.Integer({ minimum: 1 }),
});
''',
    '''  successWhen: conditionSchema,
  maxIterations: Type.Integer({ minimum: 1 }),
  progress: Type.Optional(loopProgressSchema),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
});
''',
)
replace_once(
    "src/pi/definition.ts",
    '''      successWhen: structuredClone(loop.successWhen),
      maxIterations: loop.maxIterations,
    })),
''',
    '''      successWhen: structuredClone(loop.successWhen),
      maxIterations: loop.maxIterations,
      ...(loop.progress === undefined ? {} : { progress: { ...loop.progress } }),
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
    })),
''',
)

replace_once(
    "src/domain/reducer.ts",
    '''interface LoopEvaluation {
  loopId: string;
  iteration: number;
  success: boolean;
  factsUsed: string[];
  semanticsVersion: number;
}
''',
    '''interface LoopEvaluation {
  loopId: string;
  iteration: number;
  success: boolean;
  factsUsed: string[];
  semanticsVersion: number;
  metric?: number;
  improved?: boolean;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount: number;
  evaluationError?: string;
}
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: result.factsUsed,
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
  };
};
''',
    '''  if (!definition.progress) {
    return {
      loopId: definition.id,
      iteration: runtime.currentIteration,
      success: result.value,
      factsUsed: result.factsUsed,
      semanticsVersion: CONDITION_SEMANTICS_VERSION,
      noProgressCount: runtime.noProgressCount,
    };
  }
  const progressFact = state.runtime.facts[definition.progress.fact];
  const validMetric = progressFact
    && typeof progressFact.value === "number"
    && Number.isFinite(progressFact.value)
    && progressFact.loopId === definition.id
    && progressFact.iteration === runtime.currentIteration;
  if (!validMetric) {
    return {
      loopId: definition.id,
      iteration: runtime.currentIteration,
      success: result.value,
      factsUsed: [...new Set([...result.factsUsed, definition.progress.fact])],
      semanticsVersion: CONDITION_SEMANTICS_VERSION,
      noProgressCount: runtime.noProgressCount,
      evaluationError: `Loop '${definition.id}' requires numeric progress fact '${definition.progress.fact}' from iteration ${runtime.currentIteration}.`,
    };
  }
  const metric = progressFact.value as number;
  const first = runtime.bestMetric === undefined;
  const delta = first ? undefined : definition.progress.direction === "maximize" ? metric - runtime.bestMetric! : runtime.bestMetric! - metric;
  const improved = first || (delta! > (definition.progress.minDelta ?? 0));
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: [...new Set([...result.factsUsed, definition.progress.fact])],
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
    metric,
    improved,
    bestMetric: improved ? metric : runtime.bestMetric,
    bestIteration: improved ? runtime.currentIteration : runtime.bestIteration,
    noProgressCount: improved ? 0 : runtime.noProgressCount + 1,
  };
};
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const completes = command.passed && evaluation.success;
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const exhausted = !completes && !canContinue && !!loopRuntime && evaluation.iteration >= loopRuntime.maxIterations;
        const decision = completes ? "complete" : canContinue ? "continue" : exhausted ? "fail" : "pending";
''',
    '''        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const loopDefinition = next.definition.loops.find((loop) => loop.id === evaluation.loopId)!;
        const evaluationFailed = evaluation.evaluationError !== undefined;
        const completes = !evaluationFailed && command.passed && evaluation.success;
        const exhausted = !evaluationFailed && !completes && !!loopRuntime && evaluation.iteration >= loopRuntime.maxIterations;
        const patienceExhausted = !evaluationFailed && !completes && !exhausted && loopDefinition.patience !== undefined && evaluation.noProgressCount >= loopDefinition.patience;
        const canContinue = !evaluationFailed && !completes && !exhausted && !patienceExhausted && !evaluation.success && !!loopRuntime;
        const exitReason = evaluationFailed ? "evaluation_error" : exhausted ? "max_iterations" : patienceExhausted ? "no_progress" : undefined;
        const decision = completes ? "complete" : canContinue ? "continue" : exitReason ? "fail" : "pending";
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''            verificationPassed: command.passed,
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
            ...(exhausted ? { exitReason: "max_iterations" } : {}),
''',
    '''            verificationPassed: command.passed,
            noProgressCount: evaluation.noProgressCount,
            ...(evaluation.metric === undefined ? {} : { metric: evaluation.metric }),
            ...(evaluation.improved === undefined ? {} : { improved: evaluation.improved }),
            ...(evaluation.bestMetric === undefined ? {} : { bestMetric: evaluation.bestMetric }),
            ...(evaluation.bestIteration === undefined ? {} : { bestIteration: evaluation.bestIteration }),
            ...(evaluation.evaluationError === undefined ? {} : { evaluationError: evaluation.evaluationError }),
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
            ...(exitReason === undefined ? {} : { exitReason }),
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''        } else if (exhausted) {
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime.maxIterations,
              exitReason: "max_iterations",
            },
          });
          next = append(next, events, command, {
            type: "hypagraph.workflow.failed",
            data: {
              reason: "loop_failed",
              loopId: evaluation.loopId,
              exitReason: "max_iterations",
            },
          });
''',
    '''        } else if (exitReason) {
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime.maxIterations,
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
''',
)

replace_once(
    "src/graph/projection.ts",
    '''  lastSuccess?: boolean;
  exitReason?: string;
}
''',
    '''  lastSuccess?: boolean;
  exitReason?: string;
  currentMetric?: number;
  bestMetric?: number;
  bestIteration?: number;
  noProgressCount: number;
  patience?: number;
  remainingPatience?: number;
}
''',
)
replace_once(
    "src/graph/projection.ts",
    '''        currentIteration: runtime?.currentIteration ?? 0,
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
''',
    '''        currentIteration: runtime?.currentIteration ?? 0,
        noProgressCount: runtime?.noProgressCount ?? 0,
        ...(loop.patience === undefined ? {} : { patience: loop.patience, remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)) }),
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
        ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
        ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
''',
)

replace_once(
    "src/ui/format.ts",
    '''        currentIteration: runtime?.currentIteration ?? 0,
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
''',
    '''        currentIteration: runtime?.currentIteration ?? 0,
        noProgressCount: runtime?.noProgressCount ?? 0,
        ...(loop.patience === undefined ? {} : { patience: loop.patience, remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)) }),
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
        ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
        ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
''',
)
replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}`);
''',
    '''      const progress = runtime?.currentMetric === undefined ? "" : ` - metric ${runtime.currentMetric}${runtime.bestMetric === undefined ? "" : `, best ${runtime.bestMetric} at ${runtime.bestIteration}`}${loop.patience === undefined ? "" : `, patience ${Math.max(0, loop.patience - runtime.noProgressCount)}/${loop.patience}`}`;
      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);
''',
)
replace_once(
    "src/ui/format.ts",
    '''  const activeLoop = Object.values(state.runtime.loops).find((loop) => loop.status === "running");
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${activeLoop ? ` | Loop ${activeLoop.loopId}: ${activeLoop.currentIteration}/${activeLoop.maxIterations}` : ""}`,
  ];
''',
    '''  const shownLoop = Object.values(state.runtime.loops).find((loop) => loop.status === "running") ?? Object.values(state.runtime.loops).find((loop) => loop.status === "failed" || loop.status === "succeeded");
  const definition = shownLoop ? state.definition.loops.find((loop) => loop.id === shownLoop.loopId) : undefined;
  const progress = shownLoop?.bestMetric === undefined ? "" : ` best ${shownLoop.bestMetric} at ${shownLoop.bestIteration}${definition?.patience === undefined ? "" : ` patience ${Math.max(0, definition.patience - shownLoop.noProgressCount)}/${definition.patience}`}`;
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${shownLoop ? ` | Loop ${shownLoop.loopId}: ${shownLoop.currentIteration}/${shownLoop.maxIterations}${progress}` : ""}`,
  ];
''',
)

replace_once(
    "docs/m4-vertical-slice-plan.md",
    "### Slice 5 - Add progress, loss, best result, and patience\n",
    "### Slice 5 - Add progress, loss, best result, and patience\n\n- Status: implemented\n",
)
replace_once(
    "README.md",
    "M4 is the selected next milestone. Slices 1 to 4 add typed loop success conditions, structured iteration-region validation, schema version 3, deterministic feedback continuation, isolated multi-iteration task and check loops, failed check observations, and hard iteration limits. Later slices add progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
    "M4 is the selected next milestone. Slices 1 to 5 add typed loop success conditions, structured iteration-region validation, deterministic feedback continuation, check-driven repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
)
replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slices 1 to 4 execute task-based and command-check repair loops across isolated iterations. A failed evaluation check can continue the loop only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. The final unsuccessful allowed iteration fails the loop and workflow with `max_iterations`. Do not select a feedback route manually. Patience is not active yet.",
    "M4 Slices 1 to 5 execute bounded task-based and command-check repair loops. Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Do not select loop decisions manually.",
)
replace_once(
    "docs/event-runtime.md",
    '''M4 Slices 1 to 4 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, failed evaluation-check observations, and hard iteration limits.

It does not yet support:

- progress metrics or patience;
''',
    '''M4 Slices 1 to 5 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, failed evaluation-check observations, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure.

Progress decisions are stored in `hypagraph.loop.evaluated`. The event contains the metric, improvement result, best metric, best iteration, and no-progress count. Replay does not recalculate them. A missing or invalid current-iteration metric fails the loop with `evaluation_error`. Hard-limit failure has priority over patience failure.

It does not yet support:

''',
)

write("tests/loop-progress.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-23T06:00:00.000Z";

const definition = (overrides: Partial<HypagraphDefinition["loops"][number]> = {}): HypagraphDefinition => ({
  title: "Progress loop",
  goal: "Track quality progress",
  nodes: [
    { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["repair"],
      acceptance: [],
      produces: [
        { name: "quality.passed", type: "boolean", required: true },
        { name: "quality.score", type: "number", required: false },
      ],
    },
    { id: "document", title: "Document", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [{
    id: "quality-loop",
    nodes: ["repair", "evaluate"],
    entry: "repair",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "quality.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 6,
    progress: { fact: "quality.score", direction: "maximize", minDelta: 1 },
    patience: 2,
    ...overrides,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const iteration = (state: HypagraphState, events: DomainEvent[], number: number, score: number | undefined, passed = false): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "repair", attemptId: `repair-${number}`, commandId: `repair-${number}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "repair", attemptId: `repair-${number}`, evidence: [], commandId: `repair-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "repair", attemptId: `repair-${number}`, commandId: `repair-${number}-begin`, at });
  next = apply(next, events, { type: "complete-verification", nodeId: "repair", attemptId: `repair-${number}`, passed: true, commandId: `repair-${number}-verify`, at });
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-start`, at });
  const facts: FactInput[] = [{ name: "quality.passed", type: "boolean", value: passed }];
  if (score !== undefined) facts.push({ name: "quality.score", type: "number", value: score });
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId: `evaluate-${number}`, facts, commandId: `evaluate-${number}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId: `evaluate-${number}`, evidence: [], commandId: `evaluate-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, passed: true, commandId: `evaluate-${number}-verify`, at });
};

describe("M4 Slice 5 progress and patience", () => {
  it("tracks best progress, applies strict minDelta, resets patience, and fails on no progress", () => {
    const created = createWorkflow(definition(), at, "workflow-progress");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 2, bestMetric: 10, bestIteration: 1, noProgressCount: 0 });
    state = iteration(state, events, 2, 11);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 3, currentMetric: 11, bestMetric: 10, bestIteration: 1, noProgressCount: 1 });
    state = iteration(state, events, 3, 12.1);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 4, bestMetric: 12.1, bestIteration: 3, noProgressCount: 0 });
    state = iteration(state, events, 4, 12.1);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 5, noProgressCount: 1 });
    state = iteration(state, events, 5, 12);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "no_progress", bestMetric: 12.1, bestIteration: 3, noProgressCount: 2 });
    expect(state.runtime.loops["quality-loop"]?.iterations.map((item) => ({ iteration: item.iteration, metric: item.metric, improved: item.improved, count: item.noProgressCount, decision: item.decision }))).toEqual([
      { iteration: 1, metric: 10, improved: true, count: 0, decision: "continue" },
      { iteration: 2, metric: 11, improved: false, count: 1, decision: "continue" },
      { iteration: 3, metric: 12.1, improved: true, count: 0, decision: "continue" },
      { iteration: 4, metric: 12.1, improved: false, count: 1, decision: "continue" },
      { iteration: 5, metric: 12, improved: false, count: 2, decision: "fail" },
    ]);
    expect(replayEvents(events)).toEqual(state);
  });

  it("lets success complete without metric improvement", () => {
    const created = createWorkflow(definition({ maxIterations: 3, patience: 1 }), at, "workflow-success-progress");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 10, true);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "succeeded", exitReason: "success", bestMetric: 10, bestIteration: 1, noProgressCount: 1 });
    expect(state.runtime.nodes.document?.status).toBe("ready");
  });

  it("uses hard-limit failure before patience when both apply", () => {
    const created = createWorkflow(definition({ maxIterations: 2, patience: 1 }), at, "workflow-progress-order");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 10);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "max_iterations", noProgressCount: 1 });
  });

  it("supports minimize direction", () => {
    const created = createWorkflow(definition({ progress: { fact: "quality.score", direction: "minimize", minDelta: 0.5 }, patience: 2 }), at, "workflow-minimize");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 9.4);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 9.4, bestIteration: 2, noProgressCount: 0 });
  });

  it("fails with evaluation_error when the current metric is missing", () => {
    const created = createWorkflow(definition(), at, "workflow-progress-missing");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = iteration(created.state, events, 1, undefined);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "evaluation_error" });
    expect(events.at(-2)).toMatchObject({ type: "hypagraph.loop.failed", data: { exitReason: "evaluation_error" } });
  });

  it("validates progress and patience definitions", () => {
    const invalid = definition({ progress: { fact: "quality.passed", direction: "maximize", minDelta: -1 }, patience: 0 });
    expect(validateDefinition(invalid).map((item) => item.code)).toEqual(expect.arrayContaining(["progress_fact_not_numeric", "invalid_progress_delta", "invalid_loop_patience"]));
    const noProgress = definition({ progress: undefined, patience: 2 });
    expect(validateDefinition(noProgress).map((item) => item.code)).toContain("patience_requires_progress");
  });
});
''')

write("tests/pi-loop-progress.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool { name: string; execute: (...args: any[]) => Promise<any> }

describe("M4 Slice 5 Pi progress surface", () => {
  it("shows the best metric and remaining patience", async () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = { on: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)), appendEntry: vi.fn() } as unknown as ExtensionAPI;
    hypagraphExtension(pi);
    const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() } };
    const signal = new AbortController().signal;
    await tools.get("hypagraph_define")!.execute("define", {
      title: "Pi progress loop", goal: "Show progress", nodes: [
        { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
        { id: "evaluate", title: "Evaluate", requires: ["repair"], acceptance: [], produces: [
          { name: "quality.passed", type: "boolean", required: true },
          { name: "quality.score", type: "number", required: true },
        ] },
      ], loops: [{ id: "quality-loop", nodes: ["repair", "evaluate"], entry: "repair", evaluateAfter: "evaluate", feedbackEdges: [{ from: "evaluate", to: "repair" }], successWhen: { kind: "compare", left: { kind: "fact", name: "quality.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 4, progress: { fact: "quality.score", direction: "maximize", minDelta: 1 }, patience: 2 }], policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);
    const transition = tools.get("hypagraph_transition")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);
    await call("repair-start", { action: "start", nodeId: "repair" });
    await call("repair-submit", { action: "submit", nodeId: "repair", evidence: [] });
    await call("repair-verify", { action: "verify", nodeId: "repair", passed: true });
    await call("evaluate-start", { action: "start", nodeId: "evaluate" });
    await call("evaluate-facts", { action: "publish", nodeId: "evaluate", facts: [{ name: "quality.passed", type: "boolean", value: false }, { name: "quality.score", type: "number", value: 10 }] });
    await call("evaluate-submit", { action: "submit", nodeId: "evaluate", evidence: [] });
    const result = await call("evaluate-verify", { action: "verify", nodeId: "evaluate", passed: true });
    const persisted = result.details.hypagraph as PersistedHypagraph;
    expect(persisted.snapshot.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 10, bestIteration: 1, noProgressCount: 0 });
    expect(result.details.graph.loops[0]).toMatchObject({ bestMetric: 10, bestIteration: 1, remainingPatience: 2 });
    expect(result.content[0].text).toContain("metric 10, best 10 at 1, patience 2/2");
  });
});
''')

for path in ["src/domain/model.ts", "src/domain/projection.ts", "src/domain/reducer.ts", "src/domain/validate.ts", "src/pi/definition.ts", "src/graph/projection.ts", "src/ui/format.ts", "tests/loop-progress.test.ts", "tests/pi-loop-progress.test.ts"]:
    if b"\x00" in Path(path).read_bytes():
        raise SystemExit(f"NUL control character found in {path}")
