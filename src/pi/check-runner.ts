import type { CheckDefinition, CheckExecutor, CheckResult, HypagraphState } from "../domain/model.js";
import { runDurableCheckLifecycle } from "../checks/durable-lifecycle.js";
import type { AutomaticCheckLifecycleResult, CheckLifecycleTransition } from "../checks/lifecycle.js";
import { evaluateCheckStart } from "../domain/check-policy.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";

export interface PiCheckRunInput {
  state: HypagraphState;
  executor: CheckExecutor;
  store: WorkflowEventStore;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal: AbortSignal | undefined;
  onTransition?: (transition: CheckLifecycleTransition) => void;
}

export interface RunnableCheck {
  definition: CheckDefinition;
  state: HypagraphState;
  retry: boolean;
}

const requireCheckDefinition = (state: HypagraphState, nodeId: string): CheckDefinition => {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Unknown node '${nodeId}'.`);
  if ((node.kind ?? "task") !== "check" || !node.check) throw new Error(`Node '${nodeId}' is not a check.`);
  return node.check;
};

const requireLoopNotExhausted = (state: HypagraphState, nodeId: string): void => {
  const loop = state.definition.loops.find((item) => {
    const runtime = state.runtime.loops[item.id];
    return item.nodes.includes(nodeId) && runtime?.status === "failed" && runtime.exitReason === "max_iterations";
  });
  if (loop) throw new Error(`loop_exhausted: Loop '${loop.id}' reached its limit of ${loop.maxIterations} iterations. It cannot start another iteration.`);
};

export function requireRunnableCheck(state: HypagraphState, nodeId: string, attemptId: string, at: string): RunnableCheck {
  const definition = requireCheckDefinition(state, nodeId);
  requireLoopNotExhausted(state, nodeId);
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime) throw new Error(`Check '${nodeId}' has no runtime state.`);
  const eligibility = evaluateCheckStart(runtime, definition, attemptId, at);
  if (!eligibility.ok) throw new Error(eligibility.diagnostic.message);
  return { definition: structuredClone(definition), state: structuredClone(state), retry: eligibility.retry };
}

export async function runPiCheck(input: PiCheckRunInput): Promise<AutomaticCheckLifecycleResult> {
  requireRunnableCheck(input.state, input.nodeId, input.attemptId, input.requestedAt);
  return runDurableCheckLifecycle({
    state: input.state,
    executor: input.executor,
    store: input.store,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    requestedAt: input.requestedAt,
    signal: input.signal ?? new AbortController().signal,
    ...(input.onTransition === undefined ? {} : { onCommit: input.onTransition }),
  });
}

const formatValue = (value: unknown): string => Array.isArray(value) ? value.join(", ") : String(value);
const protectsEvaluatorOutput = (definition: CheckDefinition | undefined): boolean => definition?.kind === "metric-report"
  && definition.evaluation !== undefined
  && definition.evaluation.feedback.exposeRawReport !== true;

const definitionLines = (definition: CheckDefinition | undefined): string[] => {
  if (!definition) return ["Kind: unknown"];
  const lines = [`Kind: ${definition.kind}`];
  if (definition.kind === "command") {
    lines.push(`Command: ${[definition.command, ...(definition.arguments ?? [])].join(" ")}`);
  } else if (definition.kind === "file-assertion" || definition.kind === "git-assertion") {
    lines.push(`Assertion version: ${definition.version}`);
    lines.push(`Assertion: ${definition.assertion.kind}`);
    lines.push(`Namespace: ${definition.namespace}`);
  } else if (definition.kind === "metric-report") {
    const protectedEvaluator = protectsEvaluatorOutput(definition);
    lines.push(protectedEvaluator
      ? "Command: protected evaluator command"
      : `Command: ${[definition.command, ...(definition.arguments ?? [])].join(" ")}`);
    lines.push(protectedEvaluator ? "Report: protected evaluator report" : `Report: ${definition.reportPath}`);
    lines.push(`Parser: ${definition.parser.name} v${definition.parser.version}`);
    lines.push(`Metric mappings: ${definition.mappings.length}`);
    if (definition.evaluation) {
      lines.push(`Evaluation purpose: ${definition.evaluation.kind}`);
      lines.push(`Feedback: ${definition.evaluation.feedback.mode}`);
      if (definition.evaluation.feedback.maximumDiagnosticItems !== undefined) lines.push(`Diagnostic limit: ${definition.evaluation.feedback.maximumDiagnosticItems}`);
      lines.push(`Raw report: ${definition.evaluation.feedback.exposeRawReport === true ? "public" : "protected"}`);
      const integrity = definition.evaluation.integrity;
      if (integrity) {
        lines.push(`Evaluator trust: ${integrity.trustLevel}`);
        lines.push(`Evaluator version: ${integrity.evaluatorVersion?.value ?? "derived fingerprint"}`);
        lines.push(`Protected paths: ${integrity.protectedPaths?.length ?? 0}`);
        const gitConstraintCount = integrity.git === undefined
          ? 0
          : Number(integrity.git.expectedRevision !== undefined)
            + Number(integrity.git.requireCleanWorktree === true)
            + Number(integrity.git.protectedPathsUnchangedFrom !== undefined);
        lines.push(`Git integrity constraints: ${gitConstraintCount}`);
      }
    }
  } else {
    lines.push(`Command: ${[definition.command, ...(definition.arguments ?? [])].join(" ")}`);
    lines.push(`Report: ${definition.reportPath}`);
    lines.push(`Parser: ${definition.parser.name} v${definition.parser.version}`);
    lines.push(`Namespace: ${definition.namespace}`);
  }
  return lines;
};

export function formatPiCheckResult(state: HypagraphState, nodeId: string, result: CheckResult): string {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  const definition = node?.check;
  const elapsedMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  const facts = Object.values(state.runtime.facts)
    .filter((fact) => fact.producerNodeId === nodeId && fact.attemptId === result.attemptId)
    .sort((left, right) => left.name.localeCompare(right.name));
  const attemptNumber = runtime?.attempts[result.attemptId]?.number;
  const lines = [`Check: ${nodeId}`, ...definitionLines(definition)];
  lines.push(
    `Attempt: ${attemptNumber ?? "unknown"}`,
    `Node state: ${runtime?.status ?? "unknown"}`,
    `Final status: ${result.status}`,
    `Elapsed: ${Number.isFinite(elapsedMs) ? `${elapsedMs} ms` : "unknown"}`,
    `Exit code: ${result.exitCode ?? "none"}`,
    "Facts:",
  );
  if (facts.length === 0) lines.push("- none");
  else for (const fact of facts) lines.push(`- ${fact.name} = ${formatValue(fact.value)}`);
  if (result.evaluation) {
    lines.push(`Evaluation purpose: ${result.evaluation.kind}`);
    lines.push(`Feedback mode: ${result.evaluation.feedbackMode}`);
    lines.push("Diagnostics:");
    if (result.evaluation.diagnostics.length === 0) lines.push("- none");
    else for (const diagnostic of result.evaluation.diagnostics) lines.push(`- ${diagnostic.code}: ${diagnostic.message}`);
    if (result.evaluation.diagnosticsTruncated) lines.push("- More diagnostics were not shown.");
    const integrity = result.evaluation.integrity;
    if (integrity) {
      const verified = integrity.protectedEvidence.filter((item) => item.status === "verified").length;
      lines.push(`Evaluator trust: ${integrity.trustLevel}`);
      lines.push(`Evaluator version: ${integrity.evaluatorVersion ?? "none"}`);
      lines.push(`Evaluator fingerprint: ${integrity.evaluatorFingerprint}`);
      lines.push(`Evaluator integrity: ${integrity.status}`);
      lines.push(`Integrity diagnostic: ${integrity.diagnosticCodes[0] ?? "none"}`);
      lines.push(`Protected evidence: ${verified}/${integrity.protectedEvidence.length} verified`);
    }
  }
  lines.push(`Stdout: ${result.stdoutRef ?? "none"}`);
  lines.push(`Stderr: ${result.stderrRef ?? "none"}`);
  const protectedEvaluator = protectsEvaluatorOutput(definition);
  if (result.error) lines.push(protectedEvaluator
    ? "Error: The protected evaluator did not produce an accepted result."
    : `${result.status === "failed" ? "Assertion/check failure" : "Error"}: ${result.error}`);
  const failureReason = runtime?.attempts[result.attemptId]?.failureReason;
  if (failureReason && failureReason !== result.error) lines.push(protectedEvaluator
    ? "Failure reason: The protected evaluator did not produce an accepted result."
    : `Failure reason: ${failureReason}`);
  return lines.join("\n");
}
