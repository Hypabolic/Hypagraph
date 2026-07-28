import type {
  Diagnostic,
  DomainEvent,
  HypagraphCommand,
  HypagraphState,
  ReducerResult,
} from "../domain/model.js";
import { handleCommand } from "../domain/reducer.js";
import {
  beginReadyCheckDispatch,
  finishReadyCheckDispatch,
  type DeterministicCheckDispatchRequest,
  type DeterministicCheckDispatchResult,
} from "../domain/deterministic-check-dispatch.js";
import {
  beginReadyCodeDispatch,
  finishReadyCodeDispatch,
  type DeterministicCodeDispatchRequest,
  type DeterministicCodeDispatchResult,
} from "../domain/deterministic-code-dispatch.js";
import {
  dispatchReadyGate,
  type DeterministicGateDispatchRequest,
  type DeterministicGateDispatchResult,
} from "../domain/deterministic-gate-dispatch.js";
import {
  interruptPendingActionDispatch,
  type PendingDispatchRecoveryRequest,
  type PendingDispatchRecoveryResult,
} from "../domain/action-dispatch-recovery.js";
import { WorkflowBranchChangedError, WorkflowSequenceConflictError, type WorkflowEventStore } from "./event-store.js";

export interface CommittedCommandBatch {
  state: HypagraphState;
  events: DomainEvent[];
  commands: HypagraphCommand[];
}

export type DurableCommandResult =
  | { ok: true; value: CommittedCommandBatch }
  | { ok: false; diagnostics: Diagnostic[] };

const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : error instanceof WorkflowBranchChangedError
    ? { code: "event_store_branch_changed", message: error.message }
    : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };

const appendDispatch = async <T extends { ok: true; state: HypagraphState; events: DomainEvent[] } | { ok: false; diagnostics: Diagnostic[] }>(
  store: WorkflowEventStore,
  previous: HypagraphState,
  reduced: T,
): Promise<T | { ok: false; diagnostics: Diagnostic[] }> => {
  if (!reduced.ok) return reduced;
  try {
    await store.append({
      workflowId: previous.workflowId,
      expectedSequence: previous.sequence,
      events: reduced.events,
      snapshot: reduced.state,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return reduced;
};

export async function commitCreatedWorkflow(
  store: WorkflowEventStore,
  result: ReducerResult,
): Promise<ReducerResult> {
  if (!result.ok) return result;
  try {
    await store.append({
      workflowId: result.state.workflowId,
      expectedSequence: 0,
      events: result.events,
      snapshot: result.state,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
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

  try {
    await store.append({
      workflowId: state.workflowId,
      expectedSequence: state.sequence,
      events,
      snapshot: next,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return { ok: true, value: { state: next, events, commands: accepted } };
}

export async function applyCommandAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  command: HypagraphCommand,
): Promise<DurableCommandResult> {
  return applyCommandsAndCommit(store, state, [command]);
}

export async function beginReadyCheckDispatchAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
): Promise<DeterministicCheckDispatchResult> {
  return appendDispatch(store, state, beginReadyCheckDispatch(state, request));
}

export async function finishReadyCheckDispatchAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
  outcome: "completed" | "failed" | "interrupted",
  reason?: string,
): Promise<DeterministicCheckDispatchResult> {
  return appendDispatch(store, state, finishReadyCheckDispatch(state, request, outcome, reason));
}

export async function beginReadyCodeDispatchAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: DeterministicCodeDispatchRequest,
): Promise<DeterministicCodeDispatchResult> {
  return appendDispatch(store, state, beginReadyCodeDispatch(state, request));
}

export async function finishReadyCodeDispatchAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: DeterministicCodeDispatchRequest,
  outcome: "completed" | "failed" | "interrupted",
  reason?: string,
): Promise<DeterministicCodeDispatchResult> {
  return appendDispatch(store, state, finishReadyCodeDispatch(state, request, outcome, reason));
}

export async function interruptPendingActionDispatchAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: PendingDispatchRecoveryRequest,
): Promise<PendingDispatchRecoveryResult> {
  const reduced = interruptPendingActionDispatch(state, request);
  if (!reduced.ok || !reduced.interrupted) return reduced;
  try {
    await store.append({
      workflowId: state.workflowId,
      expectedSequence: state.sequence,
      events: reduced.events,
      snapshot: reduced.state,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return reduced;
}

export async function dispatchReadyGateAndCommit(
  store: WorkflowEventStore,
  state: HypagraphState,
  request: DeterministicGateDispatchRequest,
): Promise<DeterministicGateDispatchResult> {
  const reduced = dispatchReadyGate(state, request);
  if (!reduced.ok) return reduced;
  try {
    await store.append({
      workflowId: state.workflowId,
      expectedSequence: state.sequence,
      events: reduced.events,
      snapshot: reduced.state,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return reduced;
}
