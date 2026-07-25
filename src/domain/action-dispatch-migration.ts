import type { DomainEvent } from "./model.js";
import {
  applyLegacyGoalEvent,
  createActionDispatchRuntime,
  type ActionDispatchRuntime,
} from "./action-dispatch.js";

export interface MigratedActionDispatchState {
  version: 1;
  runtime: ActionDispatchRuntime;
}

/**
 * Project a v0.6 event stream into the M6A action-dispatch runtime.
 *
 * This function does not change the source events. It gives schema migration
 * and compatibility tests one deterministic projection for the model lane.
 */
export function migrateV5ActionDispatchRuntime(
  events: readonly DomainEvent[],
): MigratedActionDispatchState {
  let runtime = createActionDispatchRuntime();

  for (const event of events) {
    runtime = applyLegacyGoalEvent(runtime, event);
  }

  return {
    version: 1,
    runtime,
  };
}
