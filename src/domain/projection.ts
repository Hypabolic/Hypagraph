import {
  applyGoalEventToActionDispatch,
  createActionDispatchRuntime,
} from "./action-dispatch.js";
import { sha256 } from "./hash.js";
import {
  HYPAGRAPH_SCHEMA_VERSION,
  type DomainEvent,
  type HypagraphState,
} from "./model.js";
import { applyEvent as applyBaseEvent } from "./projection-base.js";

const isCanonicalActionEvent = (event: DomainEvent): boolean => event.type.startsWith("hypagraph.action.");

const withCanonicalSnapshotHash = (state: HypagraphState): HypagraphState => {
  const { snapshotHash: _snapshotHash, ...withoutHash } = state;
  return { ...state, snapshotHash: sha256(withoutHash) };
};

export function applyEvent(state: HypagraphState | undefined, event: DomainEvent): HypagraphState {
  if (state && state.schemaVersion !== HYPAGRAPH_SCHEMA_VERSION) {
    throw new Error(`Unsupported Hypagraph schema version '${state.schemaVersion}'. Expected schema version ${HYPAGRAPH_SCHEMA_VERSION}.`);
  }
  if (isCanonicalActionEvent(event) && !state?.goal) {
    throw new Error("An action-dispatch event requires existing goal-control state.");
  }

  const previousDispatch = state?.goal?.actionDispatch ?? createActionDispatchRuntime();
  const next = applyBaseEvent(state, event);
  next.schemaVersion = HYPAGRAPH_SCHEMA_VERSION;

  if (!next.goal) return next;

  const actionDispatch = event.type === "hypagraph.goal.started"
    ? createActionDispatchRuntime()
    : applyGoalEventToActionDispatch(previousDispatch, event);
  next.goal.actionDispatch = actionDispatch;
  next.goal.schedulerOrdinal = actionDispatch.schedulerOrdinal;
  return withCanonicalSnapshotHash(next);
}

export function replayEvents(events: readonly DomainEvent[]): HypagraphState {
  if (events.length === 0) throw new Error("The event stream is empty.");
  let state: HypagraphState | undefined;
  for (const event of events) state = applyEvent(state, event);
  return state!;
}
