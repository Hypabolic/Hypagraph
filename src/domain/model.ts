import type { ActionDispatchRuntime } from "./action-dispatch.js";
import type {
  Diagnostic,
  DomainEvent as BaseDomainEvent,
  EventType as BaseEventType,
  GoalRuntime as BaseGoalRuntime,
  HypagraphState as BaseHypagraphState,
} from "./model-base.js";

export * from "./model-base.js";

export const HYPAGRAPH_SCHEMA_VERSION = 6 as const;

export type ActionDispatchEventType =
  | "hypagraph.action.selected"
  | "hypagraph.action.dispatched"
  | "hypagraph.action.completed"
  | "hypagraph.action.failed"
  | "hypagraph.action.interrupted";

export type EventType = BaseEventType | ActionDispatchEventType;

export interface GoalRuntime extends BaseGoalRuntime {
  /** Canonical scheduler state. The continuation fields remain as a Slice 1 compatibility projection. */
  actionDispatch?: ActionDispatchRuntime;
  /** Canonical scheduler ordinal. It advances for every selected action, independent of model usage. */
  schedulerOrdinal?: number;
}

export interface HypagraphState extends Omit<BaseHypagraphState, "schemaVersion" | "goal"> {
  schemaVersion: typeof HYPAGRAPH_SCHEMA_VERSION;
  goal?: GoalRuntime;
}

export interface DomainEvent<T = Record<string, unknown>> extends Omit<BaseDomainEvent<T>, "type"> {
  type: EventType;
}

export type ReducerResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface PersistedHypagraph {
  events: DomainEvent[];
  snapshot: HypagraphState;
}
