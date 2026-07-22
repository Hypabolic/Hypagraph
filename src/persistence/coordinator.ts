import type {
  Diagnostic,
  DomainEvent,
  HypagraphCommand,
  HypagraphState,
  ReducerResult,
} from "../domain/model.js";
import { handleCommand } from "../domain/reducer.js";
import type { WorkflowEventStore } from "./event-store.js";

export interface CommittedCommandBatch {
  state: HypagraphState;
  events: DomainEvent[];
  commands: HypagraphCommand[];
}

export type DurableCommandResult =
  | { ok: true; value: CommittedCommandBatch }
  | { ok: false; diagnostics: Diagnostic[] };

export async function commitCreatedWorkflow(
  store: WorkflowEventStore,
  result: ReducerResult,
): Promise<ReducerResult> {
  if (!result.ok) return result;
  await store.append({
    workflowId: result.state.workflowId,
    expectedSequence: 0,
    events: result.events,
    snapshot: result.state,
  });
  return result;
}

export async function applyCommandsAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  commands: readonly HypagraphCommand[],
): Promise<DurableCommandResult> {
  if (commands.length === 0) return { ok: true, value: { state, events: [], commands: [] } };

  let next = state;
  const events: DomainEvent[] = [];
  const accepted: HypagraphCommand[] = [];
  for (const command of commands) {
    const reduced = handleCommand(next, command);
    if (!reduced.ok) return reduced;
    next = reduced.state;
    events.push(...reduced.events);
    accepted.push(structuredClone(command));
  }

  await store.append({
    workflowId: state.workflowId,
    expectedSequence: state.sequence,
    events,
    snapshot: next,
  });
  return { ok: true, value: { state: next, events, commands: accepted } };
}

export async function applyCommandAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  command: HypagraphCommand,
): Promise<DurableCommandResult> {
  return applyCommandsAndCommit(store, state, [command]);
}
