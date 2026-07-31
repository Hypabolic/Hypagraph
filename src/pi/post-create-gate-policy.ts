/**
 * Pure helpers for the interactive post-create Run gate.
 *
 * Host memory holds the gate flags. These helpers decide when a goal still
 * needs a first-user Run decision after restore or resume.
 */

import type { HypagraphState } from "../domain/model.js";

/**
 * True when no node has started an attempt yet.
 * Used to re-open the post-create review after reload instead of silent auto-run.
 */
export function goalHasNeverDispatchedNode(state: HypagraphState): boolean {
  return state.definition.nodes.every((node) => {
    const runtime = state.runtime.nodes[node.id];
    if (!runtime) return true;
    return runtime.attemptCount === 0;
  });
}

/**
 * True when restore or resume should keep or re-arm the post-create gate.
 * Requires an active or paused root goal that has never dispatched work.
 */
export function shouldReopenPostCreateGate(state: HypagraphState | undefined): boolean {
  if (!state?.goal) return false;
  if (state.goal.status !== "active" && state.goal.status !== "paused") return false;
  return goalHasNeverDispatchedNode(state);
}
