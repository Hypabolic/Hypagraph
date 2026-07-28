import type {
  HypagraphState,
  InteractionDefinition,
  InteractionPresentationObservation,
  InteractionResponseOption,
} from "./model.js";
import { enumerateRootWorkActions } from "./goal-runnable.js";

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
 * The check uses graph-level root work actions, not goal-gated candidates. A
 * paused goal after reload must not open a dialog when independent work is
 * still ready. The interaction which the dialog presents is itself a runnable
 * action when status is ready; the caller passes its node ID, and this
 * function does not count it.
 */
export const interactionPresentationIsAllowed = (
  state: HypagraphState,
  exceptNodeId?: string,
): boolean =>
  enumerateRootWorkActions(state).every((action) => action.nodeId === exceptNodeId);

/**
 * Report the derived goal-level waiting state.
 *
 * Rule 3.2: derive "waiting for a user response" when the runnable action list
 * is empty and at least one interaction is outstanding. Do not store this
 * value. It matches the controller stop-waiting-response decision for an
 * active running goal.
 *
 * Node-local `awaiting_response` status can still appear when other work is
 * runnable. That case is not derived goal waiting.
 */
export function isDerivedWaitingForUser(state: HypagraphState): boolean {
  if (state.goal?.status !== "active" || state.phase !== "running") return false;
  if (awaitingInteractions(state).length === 0) return false;
  return enumerateRootWorkActions(state).length === 0;
}

/**
 * Node IDs which currently wait for a user response, in definition order.
 *
 * This list is node-local. It is not the derived goal waiting state.
 */
export function awaitingInteractionNodeIds(state: HypagraphState): string[] {
  return awaitingInteractions(state).map((item) => item.nodeId);
}
