import type {
  HypagraphState,
  InteractionDeadline,
} from "./model.js";

/** One feedback artifact which a task may consume from a predecessor interaction. */
export interface TaskContextFeedbackArtifact {
  fromNodeId: string;
  attemptId: string;
  ref: string;
}

/** Explicit context projection for one task node. */
export interface TaskContextProjection {
  nodeId: string;
  feedbackArtifacts: TaskContextFeedbackArtifact[];
}

/**
 * Find the latest succeeded interaction attempt that holds a feedback artifact.
 *
 * Prefer the current attempt when it holds a ref. Otherwise scan attempts by
 * attempt number. This stays correct if a later change clears currentAttemptId.
 */
const feedbackAttemptForNode = (
  runtime: HypagraphState["runtime"]["nodes"][string],
): { attemptId: string; ref: string } | undefined => {
  if (runtime.currentAttemptId) {
    const current = runtime.attempts[runtime.currentAttemptId];
    if (current?.status === "succeeded" && current.feedbackArtifactRef) {
      return { attemptId: runtime.currentAttemptId, ref: current.feedbackArtifactRef };
    }
  }
  const succeeded = Object.values(runtime.attempts)
    .filter((attempt) => attempt.status === "succeeded" && attempt.feedbackArtifactRef)
    .sort((left, right) => right.number - left.number);
  const latest = succeeded[0];
  if (!latest?.feedbackArtifactRef) return undefined;
  return { attemptId: latest.attemptId, ref: latest.feedbackArtifactRef };
};

/**
 * Project the explicit context bindings for one task node.
 *
 * The projection includes feedback artifact refs only from interaction nodes
 * listed in context.feedbackFrom, and only when those interactions succeeded
 * with a stored feedback artifact. A gate must never read this projection.
 */
export function projectTaskContext(state: HypagraphState, nodeId: string): TaskContextProjection {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  if (!node) return { nodeId, feedbackArtifacts: [] };
  const sources = node.context?.feedbackFrom ?? [];
  const feedbackArtifacts: TaskContextFeedbackArtifact[] = [];
  for (const fromNodeId of sources) {
    const runtime = state.runtime.nodes[fromNodeId];
    if (!runtime || runtime.status !== "succeeded") continue;
    const found = feedbackAttemptForNode(runtime);
    if (!found) continue;
    feedbackArtifacts.push({
      fromNodeId,
      attemptId: found.attemptId,
      ref: found.ref,
    });
  }
  return { nodeId, feedbackArtifacts };
}

/** Render task context lines for a continuation prompt or read surface. */
export function renderTaskContextLines(state: HypagraphState, nodeId: string): string[] {
  const context = projectTaskContext(state, nodeId);
  if (context.feedbackArtifacts.length === 0) {
    const node = state.definition.nodes.find((item) => item.id === nodeId);
    if (!node?.context?.feedbackFrom?.length) return [];
    return [
      `Task context for '${nodeId}': no feedback artifacts are available yet from [${node.context.feedbackFrom.join(", ")}].`,
    ];
  }
  return [
    `Task context for '${nodeId}':`,
    ...context.feedbackArtifacts.map(
      (item) => `- feedback from '${item.fromNodeId}' attempt '${item.attemptId}': ${item.ref}`,
    ),
  ];
}

/**
 * Project context for every task that declares context.feedbackFrom.
 * hypagraph_read summary and full views use this list.
 */
export function projectAllTaskContexts(state: HypagraphState): TaskContextProjection[] {
  return state.definition.nodes
    .filter((node) => (node.kind ?? "task") === "task" && (node.context?.feedbackFrom?.length ?? 0) > 0)
    .map((node) => projectTaskContext(state, node.id));
}

/** One awaiting interaction whose stored deadline has passed at evaluation time. */
export interface ExpiredInteractionCandidate {
  nodeId: string;
  attemptId: string;
  deadline: InteractionDeadline;
  onTimeout: "block" | "select";
  selectResponseId?: string;
}

/**
 * List awaiting interactions whose deadline has passed at the evaluation time.
 *
 * The extension supplies evaluationAt. The domain never reads the wall clock.
 */
export function expiredInteractionCandidates(
  state: HypagraphState,
  evaluationAt: string,
): ExpiredInteractionCandidate[] {
  const evaluationMs = Date.parse(evaluationAt);
  if (!Number.isFinite(evaluationMs)) return [];
  return state.definition.nodes.flatMap((node) => {
    const runtime = state.runtime.nodes[node.id];
    if ((node.kind ?? "task") !== "interaction" || !node.interaction) return [];
    if (runtime?.status !== "awaiting_response" || !runtime.currentAttemptId) return [];
    const attempt = runtime.attempts[runtime.currentAttemptId];
    if (!attempt?.deadline || !attempt.timeoutPolicy) return [];
    const deadlineMs = Date.parse(attempt.deadline.absolute);
    if (!Number.isFinite(deadlineMs) || evaluationMs < deadlineMs) return [];
    return [{
      nodeId: node.id,
      attemptId: runtime.currentAttemptId,
      deadline: structuredClone(attempt.deadline),
      onTimeout: attempt.timeoutPolicy.onTimeout,
      ...(attempt.timeoutPolicy.selectResponseId === undefined
        ? {}
        : { selectResponseId: attempt.timeoutPolicy.selectResponseId }),
    }];
  });
}
