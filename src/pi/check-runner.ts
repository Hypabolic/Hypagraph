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

export function formatPiCheckResult(state: HypagraphState, nodeId: string, result: CheckResult): string {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  const definition = node?.check;
  const command = definition ? [definition.command, ...(definition.arguments ?? [])].join(" ") : "unknown";
  const elapsedMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  const facts = Object.values(state.runtime.facts)
    .filter((fact) => fact.producerNodeId === nodeId && fact.attemptId === result.attemptId)
    .sort((left, right) => left.name.localeCompare(right.name));
  const attemptNumber = runtime?.attempts[result.attemptId]?.number;
  const lines = [`Check: ${nodeId}`, `Kind: ${definition?.kind ?? result.checkKind}`, `Command: ${command}`];
  if (definition && definition.kind !== "command") {
    lines.push(`Report: ${definition.reportPath}`);
    lines.push(`Parser: ${definition.parser.name} v${definition.parser.version}`);
    lines.push(`Namespace: ${definition.namespace}`);
  }
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
  lines.push(`Stdout: ${result.stdoutRef ?? "none"}`);
  lines.push(`Stderr: ${result.stderrRef ?? "none"}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  const failureReason = runtime?.attempts[result.attemptId]?.failureReason;
  if (failureReason && failureReason !== result.error) lines.push(`Failure reason: ${failureReason}`);
  return lines.join("\n");
}
