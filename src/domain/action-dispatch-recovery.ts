import type { Diagnostic, DomainEvent, HypagraphState } from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import { sha256 } from "./hash.js";
import { applyEvent } from "./projection.js";

export interface PendingDispatchRecoveryRequest {
  commandId: string;
  reason: string;
  at: string;
}

export type PendingDispatchRecoveryResult =
  | { ok: true; interrupted: false; state: HypagraphState; events: DomainEvent[] }
  | { ok: true; interrupted: true; state: HypagraphState; events: DomainEvent[]; dispatchId: string }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Close a pending non-model action dispatch after a session reload or a branch change.
 *
 * A deterministic or executor dispatch has no delivered model turn to close it. The
 * pending dispatch would block every later selection, so restore must record one
 * interrupted event. The model lane uses `abandon-goal-continuation` instead.
 */
export function interruptPendingActionDispatch(
  state: HypagraphState,
  request: PendingDispatchRecoveryRequest,
): PendingDispatchRecoveryResult {
  const pending = state.goal?.actionDispatch?.pending;
  if (!pending || pending.lane === "model") {
    return { ok: true, interrupted: false, state, events: [] };
  }
  if (!Number.isFinite(Date.parse(request.at))) {
    return {
      ok: false,
      diagnostics: [{
        code: "action_dispatch_timestamp_invalid",
        message: "An interrupted action dispatch requires a valid timestamp.",
        location: "at",
      }],
    };
  }

  const sequence = state.sequence + 1;
  const nodeId = "nodeId" in pending.action ? pending.action.nodeId : undefined;
  const loopId = "loopId" in pending.action ? pending.action.loopId : undefined;
  const event: DomainEvent = {
    eventId: sha256({
      workflowId: state.workflowId,
      revision: state.revision,
      sequence,
      commandId: request.commandId,
      type: "hypagraph.action.interrupted",
      nodeId: nodeId ?? null,
      attemptId: null,
      loopId: loopId ?? null,
    }),
    workflowId: state.workflowId,
    revision: state.revision,
    sequence,
    type: "hypagraph.action.interrupted",
    version: HYPAGRAPH_EVENT_VERSION,
    timestamp: request.at,
    causationId: request.commandId,
    correlationId: pending.dispatchId,
    ...(nodeId ? { nodeId } : {}),
    ...(loopId ? { loopId } : {}),
    data: { dispatchId: pending.dispatchId, reason: request.reason },
  };

  return {
    ok: true,
    interrupted: true,
    state: applyEvent(state, event),
    events: [event],
    dispatchId: pending.dispatchId,
  };
}
