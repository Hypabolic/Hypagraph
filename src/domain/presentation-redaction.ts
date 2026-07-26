import { protectsEvaluatorOutput } from "./evaluation-presentation.js";
import { classifyGoalBlockage } from "./goal-blockage.js";
import type { HypagraphDefinition, HypagraphState } from "./model.js";

/** The stable public replacement for any text which can hold protected evaluator detail. */
export const PROTECTED_DETAIL = "The evaluator is protected. Hypagraph withheld the detail.";

export interface ProtectedTextPolicy {
  readonly protectedNodeIds: ReadonlySet<string>;
  readonly protectedLoopIds: ReadonlySet<string>;
  /** Every canonical free-text value which belongs to a protected evaluator. */
  readonly secrets: ReadonlySet<string>;
  readonly active: boolean;
  isProtectedNode(nodeId?: string): boolean;
  isProtectedLoop(loopId?: string): boolean;
  /** Replace one free-text value when its owner is protected or when it repeats a secret. */
  text(value: string, owner?: { nodeId?: string; loopId?: string }): string;
  /** Replace every secret inside a cloned value. */
  redact<T>(value: T): T;
}

const protectedNodes = (definition: HypagraphDefinition): Set<string> => {
  const values = new Set<string>();
  for (const node of definition.nodes) {
    if (protectsEvaluatorOutput(node.check)) values.add(node.id);
  }
  return values;
};

const protectedLoops = (definition: HypagraphDefinition, nodes: ReadonlySet<string>): Set<string> => {
  const values = new Set<string>();
  for (const loop of definition.loops) {
    if (loop.nodes.some((nodeId) => nodes.has(nodeId))) values.add(loop.id);
  }
  return values;
};

const addSecret = (secrets: Set<string>, value: unknown): void => {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) secrets.add(value);
};

/**
 * Collect every canonical free-text value which a protected evaluator produced.
 *
 * Canonical state keeps the exact text, because `blockerIdentityMatches` binds the
 * bounded automatic revision to it. A presentation surface must replace it. Exact-value
 * replacement covers a canonical object which a surface copies whole, such as the goal
 * control block of the model-visible summary.
 */
const collectSecrets = (
  state: HypagraphState,
  nodes: ReadonlySet<string>,
  loops: ReadonlySet<string>,
): Set<string> => {
  const secrets = new Set<string>();
  if (nodes.size === 0) return secrets;

  for (const nodeId of nodes) {
    const runtime = state.runtime.nodes[nodeId];
    if (!runtime) continue;
    addSecret(secrets, runtime.blockedReason);
    for (const attempt of Object.values(runtime.attempts)) {
      addSecret(secrets, attempt.failureReason);
      addSecret(secrets, attempt.checkResult?.error);
      addSecret(secrets, attempt.checkResult?.stdoutRef);
      addSecret(secrets, attempt.checkResult?.stderrRef);
    }
  }
  for (const loopId of loops) addSecret(secrets, state.runtime.loops[loopId]?.blockedReason);

  const goal = state.goal;
  if (goal) {
    const pending = goal.pendingContinuation?.action;
    if (pending?.kind === "request-revision" && nodes.has(pending.blocker.id)) {
      addSecret(secrets, pending.blocker.reason);
    }
    const lastAttempt = goal.automaticRevision.lastAttempt;
    if (lastAttempt?.blocker && nodes.has(lastAttempt.blocker.id)) {
      addSecret(secrets, lastAttempt.blocker.reason);
      addSecret(secrets, lastAttempt.reason);
    }
    const blockage = classifyGoalBlockage(state);
    if (blockage.kind !== "not-blocked" && nodes.has(blockage.blocker.id)) {
      addSecret(secrets, blockage.blocker.reason);
    }
  }
  return secrets;
};

const deepRedact = (value: unknown, secrets: ReadonlySet<string>): unknown => {
  if (typeof value === "string") return secrets.has(value) ? PROTECTED_DETAIL : value;
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deepRedact(item, secrets)]),
    );
  }
  return value;
};

/**
 * Build the protection policy of one canonical state.
 *
 * Every user-visible and model-visible projection uses this policy. The live view, the
 * replay view, the status surface, the graph model, and the model-visible summary each
 * apply the same rule, so a replayed state cannot leak what a live state hides.
 */
export function protectedTextPolicy(state: HypagraphState): ProtectedTextPolicy {
  const nodeIds = protectedNodes(state.definition);
  const loopIds = protectedLoops(state.definition, nodeIds);
  const secrets = collectSecrets(state, nodeIds, loopIds);
  const active = nodeIds.size > 0;
  return {
    protectedNodeIds: nodeIds,
    protectedLoopIds: loopIds,
    secrets,
    active,
    isProtectedNode: (nodeId?: string) => nodeId !== undefined && nodeIds.has(nodeId),
    isProtectedLoop: (loopId?: string) => loopId !== undefined && loopIds.has(loopId),
    text: (value: string, owner?: { nodeId?: string; loopId?: string }): string => {
      if (owner?.nodeId !== undefined && nodeIds.has(owner.nodeId)) return PROTECTED_DETAIL;
      if (owner?.loopId !== undefined && loopIds.has(owner.loopId)) return PROTECTED_DETAIL;
      return secrets.has(value) ? PROTECTED_DETAIL : value;
    },
    redact: <T,>(value: T): T => secrets.size === 0 ? value : deepRedact(value, secrets) as T,
  };
}
