import { enumerateGoalContinuationCandidates } from "./goal-continuation.js";
import type {
  HypagraphState,
  InteractionDefinition,
  InteractionPresentationObservation,
  InteractionResponseOption,
} from "./model.js";

/** One interaction node which waits for an answer. */
export interface AwaitingInteraction {
  nodeId: string;
  attemptId: string;
  title: string;
  interaction: InteractionDefinition;
}

/** Report whether this attempt already stores a presentation observation. */
export function interactionPresentationObservation(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): InteractionPresentationObservation | undefined {
  return state.runtime.nodes[nodeId]?.attempts[attemptId]?.presentation;
}

/**
 * Report whether the external presentation effect still needs to run.
 *
 * A successful observation means the effect must not run again.
 * A failed observation is an explicit terminal presentation state.
 */
export function interactionPresentationNeedsEffect(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): boolean {
  return interactionPresentationObservation(state, nodeId, attemptId) === undefined;
}

/** Report whether a successful presentation observation exists for this attempt. */
export function interactionPresentationSucceeded(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): boolean {
  return interactionPresentationObservation(state, nodeId, attemptId)?.status === "succeeded";
}

/**
 * Build the dialog option text for one response.
 *
 * The text starts with the response ID. Response labels are not unique, but
 * response IDs are unique. The option text therefore identifies exactly one
 * response for a plain host selector. The rich dialog returns a response ID
 * directly and does not need this text.
 */
export const interactionOptionText = (response: InteractionResponseOption): string =>
  `${response.id} - ${response.label}`;

/** Build the option text for every response, in declaration order. */
export const interactionOptions = (interaction: InteractionDefinition): string[] =>
  (interaction.responses ?? []).map(interactionOptionText);

/**
 * Find the response which produced one option text.
 *
 * The runtime matches the exact text which it built. It does not parse the text.
 */
export function responseForOptionText(
  interaction: InteractionDefinition,
  optionText: string,
): InteractionResponseOption | undefined {
  const index = interactionOptions(interaction).indexOf(optionText);
  return index === -1 ? undefined : (interaction.responses ?? [])[index];
}

/** List every interaction which waits for an answer, in definition order. */
export function awaitingInteractions(state: HypagraphState): AwaitingInteraction[] {
  return state.definition.nodes.flatMap((node) => {
    const runtime = state.runtime.nodes[node.id];
    if (!node.interaction || runtime?.status !== "awaiting_response" || !runtime.currentAttemptId) return [];
    return [{
      nodeId: node.id,
      attemptId: runtime.currentAttemptId,
      title: node.title,
      interaction: node.interaction,
    }];
  });
}

/**
 * Report whether a dialog can open now.
 *
 * A dialog stops the host turn, and a host turn which stops also stops the
 * scheduler. Rule 1.1.1 therefore allows a dialog only when the graph has no
 * other runnable action.
 *
 * The interaction which the dialog presents is itself a runnable action. The
 * caller passes its node ID, and this function does not count it.
 */
export const interactionPresentationIsAllowed = (
  state: HypagraphState,
  exceptNodeId?: string,
): boolean =>
  enumerateGoalContinuationCandidates(state).every((candidate) => candidate.nodeId === exceptNodeId);
