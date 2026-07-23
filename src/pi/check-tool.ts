import type {
  CheckExecutor,
  CheckResult,
  CommandCheckDefinition,
  HypagraphState,
} from "../domain/model.js";
import { runDurableCheckLifecycle } from "../checks/durable-lifecycle.js";
import type {
  AutomaticCheckLifecycleResult,
  CheckLifecycleTransition,
} from "../checks/lifecycle.js";
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

export interface RunnableCommandCheck {
  definition: CommandCheckDefinition;
  state: HypagraphState;
  retry: boolean;
}

const requireCommandCheckDefinition = (state: HypagraphState, nodeId: string): CommandCheckDefinition => {
  const definitionNode = state.definition.nodes.find((node) => node.id === nodeId);
  if (!definitionNode) throw new Error(`Unknown node '${nodeId}'.`);
  if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) {
    throw new Error(`Node '${nodeId}' is not a check.`);
  }
  if (definitionNode.check.kind !== "command") {
    throw new Error(`Check '${nodeId}' does not use the command check kind.`);
  }
  return definitionNode.check;
};

const requireLoopNotExhausted = (state: HypagraphState, nodeId: string): void => {
  const loop = state.definition.loops.find((item) => {
    const runtime = state.runtime.loops[item.id];
    return item.nodes.includes(nodeId) && runtime?.status === "failed" && runtime.exitReason === "max_iterations";
  });
  if (loop) throw new Error(`loop_exhausted: Loop '${loop.id}' reached its limit of ${loop.maxIterations} iterations. It cannot start another iteration.`);
};

export function requireReadyCommandCheck(state: HypagraphState, nodeId: string): RunnableCommandCheck {
  const definition = requireCommandCheckDefinition(state, nodeId);
  requireLoopNotExhausted(state, nodeId);
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime || runtime.status !== "ready") throw new Error(`Check '${nodeId}' is not ready.`);
  return { definition: structuredClone(definition), state: structuredClone(state), retry: false };
}

export function requireRunnableCommandCheck(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  at: string,
): RunnableCommandCheck {
  const definition = requireCommandCheckDefinition(state, nodeId);
  requireLoopNotExhausted(state, nodeId);
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime) throw new Error(`Check '${nodeId}' has no runtime state.`);
  const eligibility = evaluateCheckStart(runtime, definition, attemptId, at);
  if (!eligibility.ok) throw new Error(eligibility.diagnostic.message);
  return { definition: structuredClone(definition), state: structuredClone(state), retry: eligibility.retry };
}

export async function runPiCommandCheck(input: PiCheckRunInput): Promise<AutomaticCheckLifecycleResult> {
  requireRunnableCommandCheck(input.state, input.nodeId, input.attemptId, input.requestedAt);
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

const formatValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
};

export function formatPiCheckResult(
  state: HypagraphState,
  nodeId: string,
  result: CheckResult,
): string {
  const definitionNode = state.definition.nodes.find((node) => node.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  const command = definitionNode?.check?.kind === "command"
    ? [definitionNode.check.command, ...(definitionNode.check.arguments ?? [])].join(" ")
    : "unknown";
  const elapsedMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  const facts = Object.values(state.runtime.facts)
    .filter((fact) => fact.producerNodeId === nodeId && fact.attemptId === result.attemptId)
    .sort((left, right) => left.name.localeCompare(right.name));
  const attemptNumber = runtime?.attempts[result.attemptId]?.number;
  const lines = [
    `Check: ${nodeId}`,
    `Command: ${command}`,
    `Attempt: ${attemptNumber ?? "unknown"}`,
    `Node state: ${runtime?.status ?? "unknown"}`,
    `Final status: ${result.status}`,
    `Elapsed: ${Number.isFinite(elapsedMs) ? `${elapsedMs} ms` : "unknown"}`,
    `Exit code: ${result.exitCode ?? "none"}`,
    "Facts:",
  ];
  if (facts.length === 0) lines.push("- none");
  else for (const fact of facts) lines.push(`- ${fact.name} = ${formatValue(fact.value)}`);
  lines.push(`Stdout: ${result.stdoutRef ?? "none"}`);
  lines.push(`Stderr: ${result.stderrRef ?? "none"}`);
  if (result.error) lines.push(`Error: ${result.error}`);
  const failureReason = runtime?.attempts[result.attemptId]?.failureReason;
  if (failureReason && failureReason !== result.error) lines.push(`Failure reason: ${failureReason}`);
  return lines.join("\n");
}
