import type { CheckDefinition, CheckExecutor, CheckResult, HypagraphState } from "../domain/model.js";
import type { AutomaticCheckLifecycleResult, CheckLifecycleTransition } from "../checks/lifecycle.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import {
  formatPiCheckResult as formatGenericPiCheckResult,
  requireRunnableCheck,
  runPiCheck,
} from "./check-runner.js";

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

export function requireReadyCommandCheck(state: HypagraphState, nodeId: string): RunnableCommandCheck {
  const definition = requireCheckDefinition(state, nodeId);
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
  return requireRunnableCheck(state, nodeId, attemptId, at);
}

export async function runPiCommandCheck(input: PiCheckRunInput): Promise<AutomaticCheckLifecycleResult> {
  return runPiCheck(input);
}

export function formatPiCheckResult(state: HypagraphState, nodeId: string, result: CheckResult): string {
  return formatGenericPiCheckResult(state, nodeId, result);
}
