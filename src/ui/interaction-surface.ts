import { awaitingInteractions, interactionOptions } from "../domain/interaction-presentation.js";
import { readyNodeIds } from "../domain/readiness.js";
import type { HypagraphState } from "../domain/model.js";

const ACTIVE_WORK_STATUSES = new Set([
  "starting",
  "running",
  "awaiting_evidence",
  "verifying",
]);

/** Report whether any interaction waits for an answer. */
export function hasWaitingInteraction(state: HypagraphState): boolean {
  return awaitingInteractions(state).length > 0;
}

/**
 * Report whether independent work remains runnable or active beside a wait.
 *
 * A human gate is node-local. Ready nodes and active non-waiting nodes keep
 * their lifecycle while a question waits.
 */
export function hasIndependentWorkBesideWait(state: HypagraphState): boolean {
  if (readyNodeIds(state).length > 0) return true;
  return state.definition.nodes.some((node) => {
    const status = state.runtime.nodes[node.id]?.status;
    return status !== undefined && ACTIVE_WORK_STATUSES.has(status);
  });
}

/**
 * Render every open question with its declared response options.
 *
 * A person cannot answer a question which they cannot read. Hypagraph presents
 * the question in a dialog, but the reader can also see the open question in
 * every status surface.
 */
export function waitingQuestionLines(state: HypagraphState): string[] {
  const awaiting = awaitingInteractions(state);
  if (awaiting.length === 0) return [];
  const lines = ["Waiting for an answer:"];
  for (const item of awaiting) {
    lines.push(`- ${item.nodeId}: ${item.interaction.question}`);
    for (const option of interactionOptions(item.interaction)) lines.push(`    ${option}`);
    if (item.interaction.openAnswer) lines.push(`    ${item.interaction.openAnswer.prompt} (typed answer)`);
  }
  if (awaiting.length === 1) {
    lines.push("Hypagraph presents this question in a dialog. Use /hypagraph ask to present it again.");
  } else {
    lines.push(
      "Hypagraph presents these questions in dialogs. "
      + "Use /hypagraph ask, or /hypagraph ask <nodeId> for a specific question.",
    );
  }
  return lines;
}

/**
 * One short status-bar label for outstanding questions.
 *
 * The bar must stay short. Detail stays in the widget and the status surfaces.
 */
export function waitingStatusLabel(state: HypagraphState): string | undefined {
  const awaiting = awaitingInteractions(state);
  if (awaiting.length === 0) return undefined;
  if (awaiting.length === 1) return `wait ${awaiting[0]!.nodeId}`;
  const ids = awaiting.map((item) => item.nodeId).join(", ");
  // Prefer node IDs when they fit. Fall back to a count when the bar would grow too long.
  if (ids.length <= 40) return `wait ${ids}`;
  return `wait ${awaiting.length} questions`;
}

/**
 * Compact widget lines for outstanding questions.
 *
 * The first line names the wait. Later lines tell the person how to present the
 * dialog again. The independent-work line appears only when other work exists.
 */
export function waitingWidgetLines(state: HypagraphState): string[] {
  const awaiting = awaitingInteractions(state);
  if (awaiting.length === 0) return [];
  const first = awaiting[0]!;
  const question = first.interaction.question.length > 72
    ? `${first.interaction.question.slice(0, 71)}…`
    : first.interaction.question;
  const more = awaiting.length > 1 ? ` (+${awaiting.length - 1} more)` : "";
  const lines = [
    `Waiting: ${first.nodeId} - ${question}${more}`,
    awaiting.length === 1
      ? "Present the dialog again with /hypagraph ask."
      : "Present the dialog again with /hypagraph ask, or /hypagraph ask <nodeId> for a specific question.",
  ];
  if (hasIndependentWorkBesideWait(state)) {
    lines.push("Independent ready work continues while the question waits.");
  }
  return lines;
}

/**
 * Lifecycle and dismiss message when the person can present the dialog again.
 *
 * Use this only when the host has dialog capability. A host without dialog
 * capability must use `waitingUnavailableNote` instead.
 */
export function waitingLifecycleNote(state: HypagraphState): string | undefined {
  const awaiting = awaitingInteractions(state);
  if (awaiting.length === 0) return undefined;
  if (awaiting.length === 1) {
    return `Waiting for a user response on node '${awaiting[0]!.nodeId}'. `
      + `Use /hypagraph ask to present the dialog again.`;
  }
  const ids = awaiting.map((item) => item.nodeId).join(", ");
  return `Waiting for user responses on nodes: ${ids}. `
    + `Use /hypagraph ask, or /hypagraph ask <nodeId> for a specific question.`;
}

/**
 * Message when the host has no dialog capability.
 *
 * The wait stays durable. Do not recommend `/hypagraph ask` or controller
 * re-presentation as a working answer path on this host.
 */
export function waitingUnavailableNote(state: HypagraphState): string | undefined {
  const awaiting = awaitingInteractions(state);
  if (awaiting.length === 0) return undefined;
  if (awaiting.length === 1) {
    return `This host has no dialog capability. Interaction '${awaiting[0]!.nodeId}' still waits for an answer.`;
  }
  const ids = awaiting.map((item) => item.nodeId).join(", ");
  return `This host has no dialog capability. Interactions still wait for an answer: ${ids}.`;
}
