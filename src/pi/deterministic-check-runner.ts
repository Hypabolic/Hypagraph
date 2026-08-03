import type {
  CheckExecutor,
  CheckResult,
  Diagnostic,
  DomainEvent,
  HypagraphState,
} from "../domain/model.js";
import type { ActiveCheckExecutionRegistry } from "../checks/active-executions.js";
import { runParallelDurableCheckLifecycle } from "../checks/durable-lifecycle.js";
import type {
  DeterministicCheckDispatchRequest,
  ReadyCheckDecision,
} from "../domain/deterministic-check-dispatch.js";
import {
  isReadyCheckDecision,
} from "../domain/deterministic-check-dispatch.js";
import {
  enumerateGoalContinuationCandidates,
  selectGoalContinuation,
} from "../domain/goal-continuation.js";
import {
  beginReadyCheckDispatchAndCommit,
  finishReadyCheckDispatchAndCommit,
} from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import { runPiCheck } from "./check-runner.js";
import { randomUUID } from "node:crypto";

export type DeterministicCheckOutcome = "completed" | "failed" | "interrupted";

export interface DeterministicCheckDispatchInput {
  state: HypagraphState;
  decision: ReadyCheckDecision;
  dispatchId: string;
  attemptId: string;
  at: string;
  finishedAt?: string;
  store: WorkflowEventStore;
  executor: CheckExecutor;
  registry: ActiveCheckExecutionRegistry;
  /** The controller marks the dispatch stale when the Pi session or branch generation changes. */
  stale?: () => boolean;
  upstreamSignal?: AbortSignal;
  onCommit?: (state: HypagraphState, events: readonly DomainEvent[]) => void;
}

export type DeterministicCheckDispatchResult =
  | {
    /** The dispatch was rejected before the runner stored any event. Nothing ran. */
    ok: false;
    dispatched: false;
    state: HypagraphState;
    events: DomainEvent[];
    diagnostics: Diagnostic[];
  }
  | {
    /**
     * The check ran through its durable lifecycle, but the runner could not store the
     * terminal action event. The dispatch stays pending until restore closes it.
     */
    ok: false;
    dispatched: true;
    state: HypagraphState;
    events: DomainEvent[];
    diagnostics: Diagnostic[];
    outcome: DeterministicCheckOutcome;
    reason?: string;
    result?: CheckResult;
  }
  | {
    ok: true;
    dispatched: true;
    stale: boolean;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: DeterministicCheckOutcome;
    reason?: string;
    result?: CheckResult;
  };

const diagnosticText = (diagnostics: readonly Diagnostic[]): string =>
  diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");

/**
 * Dispatch one ready check in the deterministic lane.
 *
 * The order is durable. The runner stores the selected and dispatched events, runs the
 * existing durable check lifecycle, and then stores one terminal action event. The runner
 * does not change check retry, backoff, artifact, cancellation, or evaluation behaviour.
 */
export async function runDeterministicCheckDispatch(
  input: DeterministicCheckDispatchInput,
): Promise<DeterministicCheckDispatchResult> {
  const request: DeterministicCheckDispatchRequest = {
    dispatchId: input.dispatchId,
    decision: input.decision,
    at: input.at,
  };
  const begun = await beginReadyCheckDispatchAndCommit(input.store, input.state, request);
  if (!begun.ok) {
    return { ok: false, dispatched: false, state: input.state, events: [], diagnostics: begun.diagnostics };
  }

  let state = begun.state;
  const events: DomainEvent[] = [...begun.events];
  input.onCommit?.(state, begun.events);

  const nodeId = input.decision.nodeId;
  let outcome: DeterministicCheckOutcome = "failed";
  let reason: string | undefined;
  let result: CheckResult | undefined;
  const handle = input.registry.register({
    workflowId: state.workflowId,
    nodeId,
    attemptId: input.attemptId,
    startedAt: input.at,
    ...(input.upstreamSignal ? { upstreamSignal: input.upstreamSignal } : {}),
  });

  try {
    const lifecycle = await runPiCheck({
      state,
      executor: input.executor,
      store: input.store,
      nodeId,
      attemptId: input.attemptId,
      requestedAt: input.at,
      signal: handle.signal,
      onTransition: (transition) => {
        // The returned events always describe what the store accepted. A stale
        // controller stops mirroring the commits, but the durable record stands.
        state = transition.state;
        events.push(...transition.events);
        if (!input.stale?.()) input.onCommit?.(state, transition.events);
      },
    });
    state = lifecycle.state;
    if (lifecycle.ok) {
      result = lifecycle.result;
      if (lifecycle.result.status === "cancelled" || lifecycle.result.status === "interrupted") {
        outcome = "interrupted";
        reason = lifecycle.result.error?.trim() || `The check attempt was ${lifecycle.result.status}.`;
      } else {
        outcome = "completed";
      }
    } else {
      outcome = "failed";
      reason = diagnosticText(lifecycle.diagnostics);
      if (lifecycle.result) result = lifecycle.result;
    }
  } catch (error) {
    outcome = "failed";
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    handle.release();
  }

  if (input.stale?.()) {
    return { ok: true, dispatched: true, stale: true, state, events, outcome: "interrupted", reason: "The Pi session changed while the check was active.", ...(result ? { result } : {}) };
  }

  const finished = await finishReadyCheckDispatchAndCommit(
    input.store,
    state,
    { ...request, at: input.finishedAt ?? new Date().toISOString() },
    outcome,
    reason,
  );
  if (!finished.ok) {
    // The check already ran and its lifecycle is durable. Only the terminal action event
    // is missing, so the caller must not report that nothing was dispatched.
    return {
      ok: false,
      dispatched: true,
      state,
      events,
      diagnostics: finished.diagnostics,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(result ? { result } : {}),
    };
  }
  state = finished.state;
  events.push(...finished.events);
  input.onCommit?.(state, finished.events);

  return {
    ok: true,
    dispatched: true,
    stale: false,
    state,
    events,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(result ? { result } : {}),
  };
}

export interface ParallelDeterministicCheckDispatchInput {
  state: HypagraphState;
  decisions: readonly ReadyCheckDecision[];
  store: WorkflowEventStore;
  executor: CheckExecutor;
  registry: ActiveCheckExecutionRegistry;
  at: string;
  finishedAt?: string;
  stale?: () => boolean;
  upstreamSignal?: AbortSignal;
  onCommit?: (state: HypagraphState, events: readonly DomainEvent[]) => void;
  /** After all checks show running; before external execute (demo hold / paint). */
  onAllStarted?: (state: HypagraphState) => void | Promise<void>;
}

/**
 * Dispatch several independent ready checks with overlapping execution.
 *
 * One action-dispatch envelope covers the batch.
 * `decisions[0]` must be the controller-selected check (matches selectGoalContinuation).
 * Remaining decisions are concurrent peers. Check starts commit first so the live
 * graph can show every path running.
 */
export async function runParallelDeterministicCheckDispatch(
  input: ParallelDeterministicCheckDispatchInput,
): Promise<DeterministicCheckDispatchResult> {
  if (input.decisions.length === 0) {
    return {
      ok: false,
      dispatched: false,
      state: input.state,
      events: [],
      diagnostics: [{
        code: "parallel_check_batch_empty",
        message: "A parallel check dispatch requires at least one ready check.",
      }],
    };
  }
  if (input.decisions.length === 1) {
    return runDeterministicCheckDispatch({
      state: input.state,
      decision: input.decisions[0]!,
      dispatchId: `hypagoal-dispatch:${randomUUID()}`,
      attemptId: randomUUID(),
      at: input.at,
      store: input.store,
      executor: input.executor,
      registry: input.registry,
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      ...(input.stale === undefined ? {} : { stale: input.stale }),
      ...(input.upstreamSignal === undefined ? {} : { upstreamSignal: input.upstreamSignal }),
      ...(input.onCommit === undefined ? {} : { onCommit: input.onCommit }),
    });
  }

  // Refresh decision identity from live state so sequence/snapshot/ordinal match.
  // Peers must still be ready; primary must match current selector.
  const liveCandidates = enumerateGoalContinuationCandidates(input.state)
    .filter((candidate): candidate is ReadyCheckDecision => isReadyCheckDecision(candidate));
  const primarySelected = selectGoalContinuation(input.state);
  if (!isReadyCheckDecision(primarySelected)) {
    return {
      ok: false,
      dispatched: false,
      state: input.state,
      events: [],
      diagnostics: [{
        code: "stale_action_dispatch",
        message: "The selected deterministic check changed before dispatch.",
        location: "decision",
      }],
    };
  }
  const peerIds = new Set(
    input.decisions
      .map((item) => item.nodeId)
      .filter((nodeId) => nodeId !== primarySelected.nodeId),
  );
  const peers = liveCandidates.filter((item) => peerIds.has(item.nodeId));
  const decisions: ReadyCheckDecision[] = [primarySelected, ...peers];
  if (decisions.length < 2) {
    return runDeterministicCheckDispatch({
      state: input.state,
      decision: primarySelected,
      dispatchId: `hypagoal-dispatch:${randomUUID()}`,
      attemptId: randomUUID(),
      at: input.at,
      store: input.store,
      executor: input.executor,
      registry: input.registry,
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      ...(input.stale === undefined ? {} : { stale: input.stale }),
      ...(input.upstreamSignal === undefined ? {} : { upstreamSignal: input.upstreamSignal }),
      ...(input.onCommit === undefined ? {} : { onCommit: input.onCommit }),
    });
  }

  const primary = decisions[0]!;
  const dispatchId = `hypagoal-parallel-dispatch:${randomUUID()}`;
  const request: DeterministicCheckDispatchRequest = {
    dispatchId,
    decision: primary,
    at: input.at,
  };
  const begun = await beginReadyCheckDispatchAndCommit(input.store, input.state, request);
  if (!begun.ok) {
    return { ok: false, dispatched: false, state: input.state, events: [], diagnostics: begun.diagnostics };
  }

  let state = begun.state;
  const events: DomainEvent[] = [...begun.events];
  input.onCommit?.(state, begun.events);

  const items = decisions.map((decision) => ({
    nodeId: decision.nodeId,
    attemptId: randomUUID(),
  }));
  const handles = items.map((item) => input.registry.register({
    workflowId: state.workflowId,
    nodeId: item.nodeId,
    attemptId: item.attemptId,
    startedAt: input.at,
    ...(input.upstreamSignal ? { upstreamSignal: input.upstreamSignal } : {}),
  }));

  let outcome: DeterministicCheckOutcome = "failed";
  let reason: string | undefined;
  let result: CheckResult | undefined;
  try {
    const lifecycle = await runParallelDurableCheckLifecycle({
      state,
      executor: input.executor,
      store: input.store,
      items,
      requestedAt: input.at,
      signal: input.upstreamSignal ?? new AbortController().signal,
      onCommit: (transition) => {
        state = transition.state;
        events.push(...transition.events);
        if (!input.stale?.()) input.onCommit?.(state, transition.events);
      },
      onAllStarted: async (startedState) => {
        state = startedState;
        if (!input.stale?.()) input.onCommit?.(startedState, []);
        await input.onAllStarted?.(startedState);
      },
    });
    state = lifecycle.state;
    if (lifecycle.ok) {
      result = lifecycle.result;
      if (lifecycle.result.status === "cancelled" || lifecycle.result.status === "interrupted") {
        outcome = "interrupted";
        reason = lifecycle.result.error?.trim() || `The check attempt was ${lifecycle.result.status}.`;
      } else {
        outcome = "completed";
      }
    } else {
      outcome = "failed";
      reason = diagnosticText(lifecycle.diagnostics);
      if (lifecycle.result) result = lifecycle.result;
    }
  } catch (error) {
    outcome = "failed";
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    for (const handle of handles) handle.release();
  }

  if (input.stale?.()) {
    return {
      ok: true,
      dispatched: true,
      stale: true,
      state,
      events,
      outcome: "interrupted",
      reason: "The Pi session changed while the parallel check batch was active.",
      ...(result ? { result } : {}),
    };
  }

  const finished = await finishReadyCheckDispatchAndCommit(
    input.store,
    state,
    { ...request, at: input.finishedAt ?? new Date().toISOString() },
    outcome,
    reason,
  );
  if (!finished.ok) {
    return {
      ok: false,
      dispatched: true,
      state,
      events,
      diagnostics: finished.diagnostics,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(result ? { result } : {}),
    };
  }
  state = finished.state;
  events.push(...finished.events);
  input.onCommit?.(state, finished.events);

  return {
    ok: true,
    dispatched: true,
    stale: false,
    state,
    events,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(result ? { result } : {}),
  };
}
