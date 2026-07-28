import { awaitingInteractions, interactionOptions } from "../domain/interaction-presentation.js";
import type { HypagraphState } from "../domain/model.js";

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
    if (item.interaction.freeText) lines.push(`    free text: ${item.interaction.freeText.prompt}`);
  }
  lines.push("Hypagraph presents this question in a dialog. Use /hypagraph ask to show it again.");
  return lines;
}
