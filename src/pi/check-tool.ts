import type {
  CheckExecutor,
  CheckResult,
  CommandCheckDefinition,
  HypagraphState,
} from "../domain/model.js";
import {
  runAutomaticCheckLifecycle,
  type AutomaticCheckLifecycleResult,
} from "../checks/lifecycle.js";

export interface PiCheckRunInput {
  state: HypagraphState;
  executor: CheckExecutor;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  signal?: AbortSignal;
}

export interface ReadyCommandCheck {
  definition: CommandCheckDefinition;
  state: HypagraphState;
}

export function requireReadyCommandCheck(state: HypagraphState, nodeId: string): ReadyCommandCheck {
  const definitionNode = state.definition.nodes.find((node) => node.id === nodeId);
  if (!definitionNode) throw new Error(`Unknown node '${nodeId}'.`);
  if ((definitionNode.kind ?? "task") !== "check" || !definitionNode.check) {
    throw new Error(`Node '${nodeId}' is not a check.`);
  }
  if (definitionNode.check.kind !== "command") {
    throw new Error(`Check '${nodeId}' does not use the command check kind.`);
  }
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime || runtime.status !== "ready") {
    throw new Error(`Check '${nodeId}' is not ready.`);
  }
  return { definition: structuredClone(definitionNode.check), state: structuredClone(state) };
}

export async function runPiCommandCheck(input: PiCheckRunInput): Promise<AutomaticCheckLifecycleResult> {
  requireReadyCommandCheck(input.state, input.nodeId);
  return runAutomaticCheckLifecycle({
    state: input.state,
    executor: input.executor,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    requestedAt: input.requestedAt,
    signal: input.signal ?? new AbortController().signal,
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
  const lines = [
    `Check: ${nodeId}`,
    `Command: ${command}`,
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
