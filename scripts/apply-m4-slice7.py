from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}: {old[:80]!r}")


def regex_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count == 1:
        file.write_text(updated)
        return
    if replacement not in text:
        raise SystemExit(f"Required pattern was not found in {path}: {pattern[:100]!r}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists() or file.read_text() != content:
        file.write_text(content)


# Domain model.
replace_once(
    "src/domain/model.ts",
    'export type LoopStatus = "pending" | "running" | "succeeded" | "failed" | "requires_revision";',
    'export type LoopStatus = "pending" | "running" | "blocked" | "succeeded" | "failed" | "requires_revision";',
)
replace_once(
    "src/domain/model.ts",
    '''  failurePolicy?: LoopFailurePolicy;
  legacyPredicate?: string;
}''',
    '''  failurePolicy?: LoopFailurePolicy;
  blockedAt?: string;
  blockedReason?: string;
  blockedAttemptId?: string;
  legacyPredicate?: string;
}''',
)
replace_once(
    "src/domain/model.ts",
    '''  | "hypagraph.loop.iteration-started"
  | "hypagraph.loop.evaluated"
  | "hypagraph.loop.completed"
  | "hypagraph.loop.failed";''',
    '''  | "hypagraph.loop.iteration-started"
  | "hypagraph.loop.evaluated"
  | "hypagraph.loop.invalidated"
  | "hypagraph.loop.blocked"
  | "hypagraph.loop.completed"
  | "hypagraph.loop.failed";''',
)

# Workflow outcome treats an interrupted region as blocked, not terminal.
replace_once(
    "src/domain/workflow-outcome.ts",
    '''export const workflowBlockedByFailedLoop = (state: HypagraphState): boolean =>
  state.definition.loops.some((loop) => {
    if (state.runtime.loops[loop.id]?.status !== "failed" || loopFailurePolicy(loop) === "fail-workflow") return false;
    return affectedDependants(state.definition, loop.id).some((nodeId) => !nodeIsSettledForWorkflow(state, nodeId));
  });''',
    '''export const workflowBlockedByFailedLoop = (state: HypagraphState): boolean =>
  state.definition.loops.some((loop) => {
    const status = state.runtime.loops[loop.id]?.status;
    if (status === "blocked") return true;
    if (status !== "failed" || loopFailurePolicy(loop) === "fail-workflow") return false;
    return affectedDependants(state.definition, loop.id).some((nodeId) => !nodeIsSettledForWorkflow(state, nodeId));
  });''',
)

# Projection for invalidation and cancellation.
replace_once(
    "src/domain/projection.ts",
    '''    case "hypagraph.attempt.cancelled":
      if (node && attempt) {
        attempt.status = "cancelled";
        attempt.completedAt = event.timestamp;
        if (typeof event.data.reason === "string") attempt.failureReason = event.data.reason;
        node.status = "cancelled";
      }
      break;
    case "hypagraph.loop.iteration-started": {''',
    '''    case "hypagraph.attempt.cancelled":
      if (node && attempt) {
        attempt.status = "cancelled";
        attempt.completedAt = event.timestamp;
        if (typeof event.data.reason === "string") attempt.failureReason = event.data.reason;
        node.status = "cancelled";
        delete node.currentAttemptId;
      }
      break;
    case "hypagraph.loop.invalidated": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const definition = next.definition.loops.find((loop) => loop.id === loopId);
      if (definition) {
        next.runtime.loops[loopId] = emptyLoop(definition);
        const loopNodes = new Set(definition.nodes);
        for (const [name, fact] of Object.entries(next.runtime.facts)) {
          if (loopNodes.has(fact.producerNodeId)) delete next.runtime.facts[name];
        }
        for (const nodeId of definition.nodes) {
          const loopNode = next.runtime.nodes[nodeId];
          if (!loopNode) continue;
          loopNode.status = "stale";
          delete loopNode.currentAttemptId;
          loopNode.evidence = [];
          delete loopNode.blockedReason;
          delete next.runtime.routes[nodeId];
        }
      }
      break;
    }
    case "hypagraph.loop.blocked": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "blocked";
        runtime.blockedAt = event.timestamp;
        runtime.blockedReason = String(event.data.reason ?? "The loop requires explicit recovery.");
        if (event.attemptId) runtime.blockedAttemptId = event.attemptId;
      }
      if (node && event.attemptId && node.currentAttemptId === event.attemptId) delete node.currentAttemptId;
      break;
    }
    case "hypagraph.loop.iteration-started": {''',
)
replace_once(
    "src/domain/projection.ts",
    '''        runtime.status = "running";
        runtime.currentIteration = iteration;
        runtime.startedAt ??= event.timestamp;''',
    '''        runtime.status = "running";
        runtime.currentIteration = iteration;
        delete runtime.blockedAt;
        delete runtime.blockedReason;
        delete runtime.blockedAttemptId;
        runtime.startedAt ??= event.timestamp;''',
)

# Reducer revision helpers.
regex_once(
    "src/domain/reducer.ts",
    r'''const invalidatedNodes = \(previous: HypagraphDefinition, next: HypagraphDefinition\): Set<string> => \{.*?\n\};\n\nconst loopForNode''',
    '''const ACTIVE_ATTEMPT_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

const directlyChangedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition): Set<string> => {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const oldNode = previousById.get(node.id);
    if (!oldNode || sha256(oldNode) !== sha256(node)) changed.add(node.id);
  }
  return changed;
};

const invalidatedLoopIds = (previous: HypagraphDefinition, next: HypagraphDefinition, changedNodes: ReadonlySet<string>): Set<string> => {
  const previousById = new Map(previous.loops.map((loop) => [loop.id, loop]));
  const changed = new Set<string>();
  for (const loop of next.loops) {
    const oldLoop = previousById.get(loop.id);
    if (!oldLoop || sha256(oldLoop) !== sha256(loop) || loop.nodes.some((nodeId) => changedNodes.has(nodeId))) changed.add(loop.id);
  }
  return changed;
};

const invalidatedNodes = (previous: HypagraphDefinition, next: HypagraphDefinition, loopIds: ReadonlySet<string>): Set<string> => {
  const changed = directlyChangedNodes(previous, next);
  for (const loop of next.loops) if (loopIds.has(loop.id)) for (const nodeId of loop.nodes) changed.add(nodeId);
  const outgoing = buildOutgoing(next.nodes);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of outgoing.get(queue[index]!) ?? []) {
      if (!changed.has(dependent)) { changed.add(dependent); queue.push(dependent); }
    }
  }
  return changed;
};

const activeLoopForRevision = (state: HypagraphState): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.some((nodeId) => ACTIVE_ATTEMPT_STATUSES.has(state.runtime.nodes[nodeId]?.status ?? "pending")));

const loopForNode''',
)
replace_once(
    "src/domain/reducer.ts",
    '''const activeAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => ["starting", "running", "awaiting_evidence", "verifying"].includes(item.status));''',
    '''const activeAttemptExists = (state: HypagraphState): boolean => Object.values(state.runtime.nodes).some((item) => ACTIVE_ATTEMPT_STATUSES.has(item.status));''',
)
replace_once(
    "src/domain/reducer.ts",
    '''  if (runtime.status === "requires_revision") return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  if (runtime.status === "succeeded") return reject("loop_already_completed", `Loop '${definition.id}' is complete.`);''',
    '''  if (runtime.status === "requires_revision") return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  if (runtime.status === "blocked") return reject("loop_blocked", `Loop '${definition.id}' is blocked: ${runtime.blockedReason ?? "explicit recovery is required"}. Revise the affected region before it runs again.`);
  if (runtime.status === "succeeded") return reject("loop_already_completed", `Loop '${definition.id}' is complete.`);''',
)

# Permit revision of terminal workflows and reject only active loop revision.
replace_once(
    "src/domain/reducer.ts",
    '''export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (["completed", "failed", "cancelled"].includes(state.phase)) {''',
    '''export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (command.type !== "revise" && ["completed", "failed", "cancelled"].includes(state.phase)) {''',
)
replace_once(
    "src/domain/reducer.ts",
    '''  if (command.type === "revise") {
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const invalidated = invalidatedNodes(state.definition, command.definition); const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const nodeId of invalidated) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    next = appendReadyEvents(next, events, command); return { ok: true, state: next, events };
  }''',
    '''  if (command.type === "revise") {
    const activeLoop = activeLoopForRevision(state);
    if (activeLoop) return reject("active_loop_revision_not_allowed", `Loop '${activeLoop.id}' has an active attempt. Cancel or finish it before revision.`, `loops.${activeLoop.id}`);
    const diagnostics = validateDefinition(command.definition); if (diagnostics.length > 0) return { ok: false, diagnostics };
    const directChanges = directlyChangedNodes(state.definition, command.definition);
    const invalidatedLoops = invalidatedLoopIds(state.definition, command.definition, directChanges);
    const invalidated = invalidatedNodes(state.definition, command.definition, invalidatedLoops);
    const revision = state.revision + 1;
    const revised = makeEvent(next, command, state.workflowId, revision, { type: "hypagraph.workflow.revised", data: { definition: structuredClone(command.definition) } });
    events.push(revised); next = applyEvent(next, revised);
    for (const loopId of [...invalidatedLoops].sort()) next = append(next, events, command, { type: "hypagraph.loop.invalidated", loopId, data: { loopId, reason: "definition_revision" } });
    for (const nodeId of [...invalidated].sort()) if (next.runtime.nodes[nodeId]) next = append(next, events, command, { type: "hypagraph.node.invalidated", nodeId });
    next = appendReadyEvents(next, events, command); return { ok: true, state: next, events };
  }''',
)

# Check cancellation/interruption blocks a loop after verification.
replace_once(
    "src/domain/reducer.ts",
    '''      const failedCheckObservation = !command.passed && isFailedCheckLoopObservation(state, command.nodeId, command.attemptId);
      const evaluation = command.passed || failedCheckObservation ? prepareLoopEvaluation(state, command.nodeId) : undefined;''',
    '''      const checkResultStatus = definitionNode.check ? node.attempts[command.attemptId]?.checkResult?.status : undefined;
      const interruptedLoopCheck = !command.passed && (checkResultStatus === "cancelled" || checkResultStatus === "interrupted");
      const failedCheckObservation = !command.passed && isFailedCheckLoopObservation(state, command.nodeId, command.attemptId);
      const evaluation = command.passed || failedCheckObservation ? prepareLoopEvaluation(state, command.nodeId) : undefined;''',
)
replace_once(
    "src/domain/reducer.ts",
    '''      }
      if ((command.passed || evaluation !== undefined) && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
      break;''',
    '''      }
      if (interruptedLoopCheck) {
        const loop = loopForNode(next, command.nodeId);
        const runtime = loop ? next.runtime.loops[loop.id] : undefined;
        if (loop && runtime?.status === "running") {
          const reason = command.reason?.trim() || (checkResultStatus === "cancelled" ? "The active loop check was cancelled." : "The active loop check was interrupted during restore.");
          next = append(next, events, command, {
            type: "hypagraph.loop.blocked",
            nodeId: command.nodeId,
            attemptId: command.attemptId,
            loopId: loop.id,
            data: { loopId: loop.id, iteration: runtime.currentIteration, reason, resultStatus: checkResultStatus },
          });
        }
      }
      if ((command.passed || evaluation !== undefined) && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
      break;''',
)
replace_once(
    "src/domain/reducer.ts",
    '''    case "cancel-attempt": { if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The cancellation does not match the current attempt."); next = append(next, events, command, { type: "hypagraph.attempt.cancelled", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} }); break; }''',
    '''    case "cancel-attempt": {
      if (!node.currentAttemptId || node.currentAttemptId !== command.attemptId) return reject("stale_attempt", "The cancellation does not match the current attempt.");
      const loop = loopForNode(state, command.nodeId);
      const attempt = node.attempts[command.attemptId];
      const reason = command.reason?.trim() || "The active attempt was cancelled.";
      next = append(next, events, command, {
        type: "hypagraph.attempt.cancelled",
        nodeId: command.nodeId,
        attemptId: command.attemptId,
        ...(loop ? { loopId: loop.id } : {}),
        data: { reason, ...(attempt?.iteration === undefined ? {} : { iteration: attempt.iteration }) },
      });
      if (loop && next.runtime.loops[loop.id]?.status === "running") {
        next = append(next, events, command, {
          type: "hypagraph.loop.blocked",
          nodeId: command.nodeId,
          attemptId: command.attemptId,
          loopId: loop.id,
          data: { loopId: loop.id, iteration: attempt?.iteration ?? next.runtime.loops[loop.id]!.currentIteration, reason, resultStatus: "cancelled" },
        });
      }
      break;
    }''',
)

# Event-store branch leases and explicit durable diagnostics.
replace_once(
    "src/persistence/event-store.ts",
    '''export class WorkflowSequenceConflictError extends Error {
  constructor(
    readonly workflowId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Workflow '${workflowId}' expected sequence ${expectedSequence}, but the store is at sequence ${actualSequence}.`);
    this.name = "WorkflowSequenceConflictError";
  }
}
''',
    '''export class WorkflowSequenceConflictError extends Error {
  constructor(
    readonly workflowId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Workflow '${workflowId}' expected sequence ${expectedSequence}, but the store is at sequence ${actualSequence}.`);
    this.name = "WorkflowSequenceConflictError";
  }
}

export class WorkflowBranchChangedError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow '${workflowId}' belongs to an earlier Pi session branch. Its result was not stored.`);
    this.name = "WorkflowBranchChangedError";
  }
}
''',
)

replace_once(
    "src/persistence/coordinator.ts",
    '''import type { WorkflowEventStore } from "./event-store.js";''',
    '''import { WorkflowBranchChangedError, WorkflowSequenceConflictError, type WorkflowEventStore } from "./event-store.js";''',
)
replace_once(
    "src/persistence/coordinator.ts",
    '''export type DurableCommandResult =
  | { ok: true; value: CommittedCommandBatch }
  | { ok: false; diagnostics: Diagnostic[] };
''',
    '''export type DurableCommandResult =
  | { ok: true; value: CommittedCommandBatch }
  | { ok: false; diagnostics: Diagnostic[] };

const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : error instanceof WorkflowBranchChangedError
    ? { code: "event_store_branch_changed", message: error.message }
    : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };
''',
)
replace_once(
    "src/persistence/coordinator.ts",
    '''  await store.append({
    workflowId: result.state.workflowId,
    expectedSequence: 0,
    events: result.events,
    snapshot: result.state,
  });
  return result;''',
    '''  try {
    await store.append({
      workflowId: result.state.workflowId,
      expectedSequence: 0,
      events: result.events,
      snapshot: result.state,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return result;''',
)
replace_once(
    "src/persistence/coordinator.ts",
    '''  await store.append({
    workflowId: state.workflowId,
    expectedSequence: state.sequence,
    events,
    snapshot: next,
  });
  return { ok: true, value: { state: next, events, commands: accepted } };''',
    '''  try {
    await store.append({
      workflowId: state.workflowId,
      expectedSequence: state.sequence,
      events,
      snapshot: next,
    });
  } catch (error) {
    return { ok: false, diagnostics: [storeDiagnostic(error)] };
  }
  return { ok: true, value: { state: next, events, commands: accepted } };''',
)

replace_once(
    "src/persistence/pi-session-store.ts",
    '''  WorkflowSequenceConflictError,
  validateEventAppend,''',
    '''  WorkflowBranchChangedError,
  WorkflowSequenceConflictError,
  validateEventAppend,''',
)
replace_once(
    "src/persistence/pi-session-store.ts",
    '''export class PiSessionWorkflowEventStore implements WorkflowEventStore {
  private readonly sequences = new Map<string, number>();

  constructor(private readonly appender: PiSessionEntryAppender) {}

  synchronize(value: PersistedHypagraph | undefined): void {
    this.sequences.clear();
    if (value) this.sequences.set(value.snapshot.workflowId, value.snapshot.sequence);
  }
''',
    '''export class PiSessionWorkflowEventStore implements WorkflowEventStore {
  private readonly sequences = new Map<string, number>();
  private generation = 0;

  constructor(private readonly appender: PiSessionEntryAppender) {}

  synchronize(value: PersistedHypagraph | undefined): void {
    this.generation += 1;
    this.sequences.clear();
    if (value) this.sequences.set(value.snapshot.workflowId, value.snapshot.sequence);
  }

  lease(): WorkflowEventStore {
    const generation = this.generation;
    return {
      append: async (input) => {
        if (generation !== this.generation) throw new WorkflowBranchChangedError(input.workflowId);
        await this.append(input);
      },
    };
  }
''',
)

replace_once(
    "src/checks/durable-lifecycle.ts",
    '''import { WorkflowSequenceConflictError } from "../persistence/event-store.js";''',
    '''import { WorkflowBranchChangedError, WorkflowSequenceConflictError } from "../persistence/event-store.js";''',
)
replace_once(
    "src/checks/durable-lifecycle.ts",
    '''const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };''',
    '''const storeDiagnostic = (error: unknown): Diagnostic => error instanceof WorkflowSequenceConflictError
  ? { code: "event_store_sequence_conflict", message: error.message }
  : error instanceof WorkflowBranchChangedError
    ? { code: "event_store_branch_changed", message: error.message }
    : { code: "event_store_append_failed", message: error instanceof Error ? error.message : String(error) };''',
)

# Recovery hardening and orphaned task attempts.
replace_once(
    "src/checks/recovery.ts",
    '''      return !fact
        || fact.producerNodeId !== nodeId
        || fact.attemptId !== attemptId
        || fact.revision !== state.revision;''',
    '''      const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
      return !fact
        || fact.producerNodeId !== nodeId
        || fact.attemptId !== attemptId
        || fact.revision !== state.revision
        || fact.loopId !== attempt?.loopId
        || fact.iteration !== attempt?.iteration;''',
)
replace_once(
    "src/checks/recovery.ts",
    '''  return { state, events, recoveredAttemptIds };
}
''',
    '''  return { state, events, recoveredAttemptIds };
}

export async function recoverOrphanedLoopAttempts(input: CheckRecoveryInput): Promise<CheckRecoveryResult> {
  let state = input.state;
  const events: DomainEvent[] = [];
  const recoveredAttemptIds: string[] = [];
  const loopByNode = new Map(state.definition.loops.flatMap((loop) => loop.nodes.map((nodeId) => [nodeId, loop.id] as const)));

  for (const definitionNode of [...state.definition.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    if ((definitionNode.kind ?? "task") === "check" || !loopByNode.has(definitionNode.id)) continue;
    const runtime = state.runtime.nodes[definitionNode.id];
    const attemptId = runtime?.currentAttemptId;
    if (!runtime || !attemptId || !["starting", "running", "awaiting_evidence", "verifying"].includes(runtime.status)) continue;
    const command: HypagraphCommand = {
      type: "cancel-attempt",
      nodeId: definitionNode.id,
      attemptId,
      reason: "The host stopped while this loop attempt was active. Revise the loop before it runs again.",
      commandId: recoveryCommandId(state, definitionNode.id, attemptId, "cancel-orphaned-loop-attempt"),
      correlationId: recoveryCommandId(state, definitionNode.id, attemptId, "recover-loop-attempt"),
      at: input.at,
    };
    const committed = await applyCommandsAndCommit(input.store, state, [command]);
    if (!committed.ok) {
      const message = committed.diagnostics.map((item) => item.message).join(" ");
      throw new Error(`Hypagraph could not recover loop attempt '${attemptId}': ${message}`);
    }
    state = committed.value.state;
    events.push(...committed.value.events);
    recoveredAttemptIds.push(attemptId);
    try {
      input.onCommit?.(structuredClone(state), structuredClone(committed.value.events));
    } catch {
      // A view observer cannot change recovery or canonical state.
    }
  }

  return { state, events, recoveredAttemptIds };
}
''',
)

# Restore validation.
replace_once(
    "src/persistence/session-rebuild.ts",
    '''const acceptPersisted = (stored: StoredPersisted): PersistedHypagraph => {
  const snapshot = replayEvents(stored.events);
  if (stored.snapshot.schemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== stored.snapshot.snapshotHash) throw new Error("The stored Hypagraph snapshot does not match its event stream.");
  return { events: structuredClone(stored.events), snapshot };
};''',
    '''export function validateRestoredLoopState(state: HypagraphState): void {
  const active = new Set(["starting", "running", "awaiting_evidence", "verifying"]);
  for (const definition of state.definition.loops) {
    const runtime = state.runtime.loops[definition.id];
    if (!runtime) throw new Error(`Restored loop '${definition.id}' has no runtime state.`);
    if (runtime.maxIterations !== definition.maxIterations) throw new Error(`Restored loop '${definition.id}' has a different iteration limit from its definition.`);
    if ((runtime.status === "pending" || runtime.status === "requires_revision") && runtime.currentIteration !== 0) {
      throw new Error(`Restored loop '${definition.id}' has not started but records iteration ${runtime.currentIteration}.`);
    }
    if (["running", "blocked", "succeeded", "failed"].includes(runtime.status)) {
      if (!Number.isInteger(runtime.currentIteration) || runtime.currentIteration < 1 || runtime.currentIteration > runtime.maxIterations) {
        throw new Error(`Restored loop '${definition.id}' has invalid current iteration ${runtime.currentIteration}.`);
      }
      if (!runtime.iterations.some((item) => item.iteration === runtime.currentIteration)) {
        throw new Error(`Restored loop '${definition.id}' has no record for iteration ${runtime.currentIteration}.`);
      }
    }
    if (runtime.status === "blocked" && !runtime.blockedReason?.trim()) throw new Error(`Restored loop '${definition.id}' is blocked without a reason.`);

    const loopNodes = new Set(definition.nodes);
    for (const nodeId of definition.nodes) {
      const node = state.runtime.nodes[nodeId];
      if (!node) throw new Error(`Restored loop '${definition.id}' cannot find node '${nodeId}'.`);
      const attemptId = node.currentAttemptId;
      if (!attemptId) continue;
      const attempt = node.attempts[attemptId];
      if (!attempt) throw new Error(`Restored node '${nodeId}' points to missing attempt '${attemptId}'.`);
      if (active.has(node.status)) {
        if (attempt.loopId !== definition.id || attempt.iteration !== runtime.currentIteration) {
          throw new Error(`Restored active attempt '${attemptId}' does not match loop '${definition.id}' iteration ${runtime.currentIteration}.`);
        }
        if (runtime.status === "blocked") throw new Error(`Restored blocked loop '${definition.id}' still has active attempt '${attemptId}'.`);
      }
    }
    for (const fact of Object.values(state.runtime.facts)) {
      if (!loopNodes.has(fact.producerNodeId)) continue;
      if (fact.loopId !== definition.id || (runtime.currentIteration > 0 && fact.iteration !== runtime.currentIteration)) {
        throw new Error(`Restored fact '${fact.name}' does not match loop '${definition.id}' iteration ${runtime.currentIteration}.`);
      }
    }
  }
}

const acceptPersisted = (stored: StoredPersisted): PersistedHypagraph => {
  const snapshot = replayEvents(stored.events);
  validateRestoredLoopState(snapshot);
  if (stored.snapshot.schemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== stored.snapshot.snapshotHash) throw new Error("The stored Hypagraph snapshot does not match its event stream.");
  return { events: structuredClone(stored.events), snapshot };
};''',
)
replace_once(
    "src/persistence/session-rebuild.ts",
    '''  const snapshot = replayEvents(events);
  const storedSchemaVersion = (batch.snapshot as unknown as StoredSnapshotShape).schemaVersion;''',
    '''  const snapshot = replayEvents(events);
  validateRestoredLoopState(snapshot);
  const storedSchemaVersion = (batch.snapshot as unknown as StoredSnapshotShape).schemaVersion;''',
)

# Pi extension uses branch leases and restores orphaned tasks without execution.
replace_once(
    "src/extension.ts",
    '''import { recoverInterruptedChecks } from "./checks/recovery.js";''',
    '''import { recoverInterruptedChecks, recoverOrphanedLoopAttempts } from "./checks/recovery.js";''',
)
replace_once(
    "src/extension.ts",
    '''      const recovery = await recoverInterruptedChecks({
        state,
        store: eventStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = recovery.state;
      events.push(...recovery.events);
      if (recovery.recoveredAttemptIds.length > 0) {
        ctx.ui.notify(`Hypagraph closed interrupted attempts: ${recovery.recoveredAttemptIds.join(", ")}.`, "warning");
      }''',
    '''      const recoveryStore = eventStore.lease();
      const recovery = await recoverInterruptedChecks({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = recovery.state;
      events.push(...recovery.events);
      const orphaned = await recoverOrphanedLoopAttempts({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = orphaned.state;
      events.push(...orphaned.events);
      const recovered = [...recovery.recoveredAttemptIds, ...orphaned.recoveredAttemptIds];
      if (recovered.length > 0) {
        ctx.ui.notify(`Hypagraph closed interrupted attempts: ${recovered.join(", ")}.`, "warning");
      }''',
)
replace_once(
    "src/extension.ts",
    '''    const result = await applyCommandsAndCommit(eventStore, state, commands);''',
    '''    const result = await applyCommandsAndCommit(eventStore.lease(), state, commands);''',
)
replace_once(
    "src/extension.ts",
    '''        eventStore,
        createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID()),''',
    '''        eventStore.lease(),
        createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID()),''',
)
replace_once(
    "src/extension.ts",
    '''          store: eventStore,
          nodeId,''',
    '''          store: eventStore.lease(),
          nodeId,''',
)

# UI and docs.
replace_once(
    "src/ui/format.ts",
    '''        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),''',
    '''        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.blockedReason === undefined ? {} : { blockedReason: runtime.blockedReason, blockedAttemptId: runtime.blockedAttemptId }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),''',
)
replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - policy ${loop.failurePolicy ?? "fail-workflow"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - policy ${loop.failurePolicy ?? "fail-workflow"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : ""}${progress}`);''',
)

replace_once(
    "docs/m4-vertical-slice-plan.md",
    '''### Slice 7 - Harden revision, cancellation, and recovery

#### User result''',
    '''### Slice 7 - Harden revision, cancellation, and recovery

- Status: implemented

#### User result''',
)
replace_once(
    "README.md",
    "M4 is in progress. Slices 1 to 6 provide generic bounded iteration regions, independent graph components, explicit failure policies, hard iteration limits, numeric progress, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
    "M4 is in progress. Slices 1 to 7 provide generic bounded iteration regions, independent graph components, explicit failure policies, hard limits, numeric progress, revision invalidation, branch-safe persistence, cancellation blocking, and restore recovery. The remaining slices complete the Pi loop surface and dogfood v0.5.",
)
replace_once(
    "skills/hypagraph/SKILL.md",
    '''A failed evaluation check is one valid loop observation. It can continue only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select loop decisions manually.''',
    '''A failed evaluation check is one valid loop observation. It can continue only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation or interruption blocks the affected loop until an explicit graph revision resets it. Do not revise a loop while one of its attempts is active. A relevant revision invalidates the loop and restarts it from iteration 1 after the entry becomes ready. Session branch changes reject late results from the old branch. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select loop decisions manually.''',
)
replace_once(
    "docs/event-runtime.md",
    '''It does not yet support:

- loop cancellation and revision hardening;
- parallel iterations;''',
    '''## Revision, cancellation, and restore

A revision is rejected while an attempt in the affected loop is active. A change to a loop definition or one of its nodes stores `hypagraph.loop.invalidated`, clears the current region projection, preserves attempt history, and makes the entry eligible to restart at iteration 1. An unchanged completed loop is retained.

Cancellation and restored interruption store a blocked loop outcome. The region cannot start again until an explicit relevant revision invalidates it. Restore validates loop iteration, active-attempt, and fact ownership invariants. It never starts a node or reruns a command.

Pi session branches use generation-bound event-store leases. A late result from an earlier branch fails with `event_store_branch_changed`. Optimistic sequence conflicts return `event_store_sequence_conflict` and do not store part of a loop reset batch.

It does not yet support:

- parallel iterations;''',
)

# Tests.
write("tests/loop-revision-recovery.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateRestoredLoopState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-23T07:00:00.000Z";

const definition = (maxIterations = 2): HypagraphDefinition => ({
  title: "Revision recovery",
  goal: "Keep one bounded region deterministic",
  nodes: [
    { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["work"],
      acceptance: [],
      produces: [{ name: "loop.passed", type: "boolean", required: true }],
    },
    { id: "outside", title: "Outside", requires: [], acceptance: [] },
  ],
  loops: [{
    id: "region",
    nodes: ["work", "evaluate"],
    entry: "work",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "work" }],
    successWhen: { kind: "compare", left: { kind: "fact", name: "loop.passed" }, operator: "eq", right: { kind: "literal", value: true } },
    maxIterations,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string, attemptId: string): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

const completeRegion = (state: HypagraphState, events: DomainEvent[], passed: boolean): HypagraphState => {
  let next = completeTask(state, events, "work", `work-${events.length}`);
  const attemptId = `evaluate-${events.length}`;
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId, commandId: `${attemptId}-start`, at });
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId, facts: [{ name: "loop.passed", type: "boolean", value: passed }], commandId: `${attemptId}-fact`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

describe("M4 Slice 7 loop revision and recovery", () => {
  it("rejects revision while a loop attempt is active", () => {
    const created = createWorkflow(definition(), at, "workflow-active-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "work-active", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const revised = handleCommand(started.state, { type: "revise", definition: definition(3), commandId: "revise", at });
    expect(revised).toMatchObject({ ok: false, diagnostics: [{ code: "active_loop_revision_not_allowed" }] });
  });

  it("invalidates a completed loop after a relevant revision and restarts at iteration 1", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-invalidation");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, true);
    expect(state.runtime.loops.region?.status).toBe("succeeded");
    const oldAttempts = state.runtime.nodes.work!.attemptCount;
    const revised = handleCommand(state, { type: "revise", definition: definition(3), commandId: "revise-limit", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    state = revised.state;
    events.push(...revised.events);
    expect(revised.events.map((event) => event.type)).toContain("hypagraph.loop.invalidated");
    expect(state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0, maxIterations: 3, iterations: [] });
    expect(state.runtime.nodes.work).toMatchObject({ status: "ready", attemptCount: oldAttempts });
    expect(state.runtime.facts["loop.passed"]).toBeUndefined();
    const restarted = handleCommand(state, { type: "start-node", nodeId: "work", attemptId: "work-restarted", commandId: "restart", at });
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.diagnostics));
    expect(restarted.state.runtime.loops.region).toMatchObject({ status: "running", currentIteration: 1 });
    expect(restarted.state.runtime.nodes.work?.attempts["work-restarted"]?.iteration).toBe(1);
    expect(replayEvents([...events, ...restarted.events])).toEqual(restarted.state);
  });

  it("preserves an unchanged completed loop when unrelated work changes", () => {
    const created = createWorkflow(definition(), at, "workflow-safe-loop-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, true);
    state = completeTask(state, events, "outside", "outside-1");
    expect(state.phase).toBe("completed");
    const next = definition();
    next.nodes = next.nodes.map((node) => node.id === "outside" ? { ...node, title: "Outside revised" } : node);
    const revised = handleCommand(state, { type: "revise", definition: next, commandId: "revise-outside", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.events.some((event) => event.type === "hypagraph.loop.invalidated")).toBe(false);
    expect(revised.state.runtime.loops.region).toEqual(state.runtime.loops.region);
    expect(revised.state.runtime.nodes.outside?.status).toBe("ready");
  });

  it("blocks a cancelled loop attempt, rejects late results, and requires relevant revision", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-cancel");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "work-cancel", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const cancelled = handleCommand(started.state, { type: "cancel-attempt", nodeId: "work", attemptId: "work-cancel", reason: "Stop this iteration.", commandId: "cancel", at });
    if (!cancelled.ok) throw new Error(JSON.stringify(cancelled.diagnostics));
    expect(cancelled.state.phase).toBe("blocked");
    expect(cancelled.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "work-cancel", blockedReason: "Stop this iteration." });
    const late = handleCommand(cancelled.state, { type: "submit-result", nodeId: "work", attemptId: "work-cancel", evidence: [], commandId: "late", at });
    expect(late).toMatchObject({ ok: false, diagnostics: [{ code: "stale_attempt" }] });
    const startAgain = handleCommand(cancelled.state, { type: "start-node", nodeId: "work", attemptId: "work-again", commandId: "again", at });
    expect(startAgain).toMatchObject({ ok: false, diagnostics: [{ code: "node_not_ready" }] });
    const revised = handleCommand(cancelled.state, { type: "revise", definition: definition(3), commandId: "recover", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0 });
    expect(revised.state.runtime.nodes.work?.status).toBe("ready");
  });

  it("accepts every replay boundary around evaluation and continuation", () => {
    const created = createWorkflow(definition(), at, "workflow-boundary-restore");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    completeRegion(created.state, events, false);
    const loopEventIndexes = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type.startsWith("hypagraph.loop.")).map(({ index }) => index);
    for (const index of loopEventIndexes) {
      const restored = replayEvents(events.slice(0, index + 1));
      expect(() => validateRestoredLoopState(restored)).not.toThrow();
    }
  });

  it("rejects a restored active attempt with the wrong loop iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-invalid-restore");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "bad-attempt", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const invalid = structuredClone(started.state);
    invalid.runtime.nodes.work!.attempts["bad-attempt"]!.iteration = 2;
    expect(() => validateRestoredLoopState(invalid)).toThrow("does not match loop 'region' iteration 1");
  });
});
''')

write("tests/loop-persistence-hardening.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { recoverInterruptedChecks, recoverOrphanedLoopAttempts } from "../src/checks/recovery.js";
import { applyCommandAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore, WorkflowBranchChangedError } from "../src/persistence/event-store.js";
import { PiSessionWorkflowEventStore } from "../src/persistence/pi-session-store.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-23T07:30:00.000Z";

const taskDefinition = (): HypagraphDefinition => ({
  title: "Persistence hardening",
  goal: "Reject partial or late loop state",
  nodes: [
    { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
    { id: "evaluate", title: "Evaluate", requires: ["work"], acceptance: [], produces: [{ name: "loop.passed", type: "boolean", required: true }] },
  ],
  loops: [{
    id: "region", nodes: ["work", "evaluate"], entry: "work", evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "work" }],
    successWhen: { kind: "compare", left: { kind: "fact", name: "loop.passed" }, operator: "eq", right: { kind: "literal", value: true } },
    maxIterations: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const checkDefinition = (): HypagraphDefinition => ({
  title: "Check recovery",
  goal: "Block an interrupted evaluator",
  nodes: [
    { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate", title: "Evaluate", kind: "check", requires: ["work"], acceptance: [],
      produces: [{ name: "check.passed", type: "boolean", required: true }],
      check: { kind: "command", command: "node", arguments: ["-e", "process.exit(0)"], timeoutMs: 1000, publish: [{ source: "passed", fact: "check.passed" }] },
    },
  ],
  loops: [{
    id: "region", nodes: ["work", "evaluate"], entry: "work", evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "work" }],
    successWhen: { kind: "compare", left: { kind: "fact", name: "check.passed" }, operator: "eq", right: { kind: "literal", value: true } },
    maxIterations: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const command = (state: HypagraphState, eventLog: DomainEvent[], value: Parameters<typeof handleCommand>[1]): HypagraphState => {
  const result = handleCommand(state, value);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  eventLog.push(...result.events);
  return result.state;
};

const completeWorkAndPrepareEvaluation = (created: Extract<ReturnType<typeof createWorkflow>, { ok: true }>) => {
  const events = [...created.events];
  let state = command(created.state, events, { type: "start-node", nodeId: "work", attemptId: "work-1", commandId: "work-start", at });
  state = command(state, events, { type: "submit-result", nodeId: "work", attemptId: "work-1", evidence: [], commandId: "work-submit", at });
  state = command(state, events, { type: "begin-verification", nodeId: "work", attemptId: "work-1", commandId: "work-begin", at });
  state = command(state, events, { type: "complete-verification", nodeId: "work", attemptId: "work-1", passed: true, commandId: "work-verify", at });
  return { state, events };
};

describe("M4 Slice 7 persistence hardening", () => {
  it("blocks an orphaned task attempt on restore without running work", async () => {
    const created = createWorkflow(taskDefinition(), at, "workflow-orphan-task");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "orphan-task", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: [...created.events, ...started.events], snapshot: started.state });
    const recovered = await recoverOrphanedLoopAttempts({ state: started.state, store, at });
    expect(recovered.recoveredAttemptIds).toEqual(["orphan-task"]);
    expect(recovered.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "orphan-task" });
    expect(recovered.state.runtime.nodes.work?.attempts["orphan-task"]?.status).toBe("cancelled");
  });

  it("blocks an interrupted loop check and rejects its late result", async () => {
    const created = createWorkflow(checkDefinition(), at, "workflow-interrupted-check");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const prepared = completeWorkAndPrepareEvaluation(created);
    const started = handleCommand(prepared.state, { type: "start-check", nodeId: "evaluate", attemptId: "check-orphan", commandId: "check-start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const allEvents = [...prepared.events, ...started.events];
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: allEvents, snapshot: started.state });
    const recovered = await recoverInterruptedChecks({ state: started.state, store, at: "2026-07-23T07:31:00.000Z" });
    expect(recovered.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "check-orphan" });
    expect(recovered.state.runtime.nodes.evaluate?.attempts["check-orphan"]?.checkResult?.status).toBe("interrupted");
    const late = handleCommand(recovered.state, {
      type: "record-check-result", nodeId: "evaluate", attemptId: "check-orphan", commandId: "late-result", at,
      result: { checkKind: "command", attemptId: "check-orphan", startedAt: at, completedAt: at, status: "passed", facts: [], evidence: [] },
    });
    expect(late).toMatchObject({ ok: false, diagnostics: [{ code: "stale_check_attempt" }] });
  });

  it("rejects a late append from an earlier Pi session branch", async () => {
    const created = createWorkflow(taskDefinition(), at, "workflow-branch-lease");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const appendEntry = vi.fn();
    const store = new PiSessionWorkflowEventStore({ appendEntry });
    store.synchronize({ events: created.events, snapshot: created.state });
    const oldBranch = store.lease();
    store.synchronize({ events: created.events, snapshot: created.state });
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "old-branch-attempt", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    await expect(oldBranch.append({ workflowId: created.state.workflowId, expectedSequence: created.state.sequence, events: started.events, snapshot: started.state })).rejects.toBeInstanceOf(WorkflowBranchChangedError);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("rejects a loop continuation sequence conflict without partial reset", async () => {
    const created = createWorkflow(taskDefinition(), at, "workflow-loop-sequence-conflict");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const prepared = completeWorkAndPrepareEvaluation(created);
    let state = command(prepared.state, prepared.events, { type: "start-node", nodeId: "evaluate", attemptId: "evaluate-1", commandId: "evaluate-start", at });
    state = command(state, prepared.events, { type: "publish-facts", nodeId: "evaluate", attemptId: "evaluate-1", facts: [{ name: "loop.passed", type: "boolean", value: false }], commandId: "evaluate-fact", at });
    state = command(state, prepared.events, { type: "submit-result", nodeId: "evaluate", attemptId: "evaluate-1", evidence: [], commandId: "evaluate-submit", at });
    state = command(state, prepared.events, { type: "begin-verification", nodeId: "evaluate", attemptId: "evaluate-1", commandId: "evaluate-begin", at });
    const staleState = state;
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: prepared.events, snapshot: staleState });
    const advanced = await applyCommandAndCommit(store, staleState, { type: "pause-workflow", commandId: "pause", at });
    if (!advanced.ok) throw new Error(JSON.stringify(advanced.diagnostics));
    const conflicted = await applyCommandAndCommit(store, staleState, { type: "complete-verification", nodeId: "evaluate", attemptId: "evaluate-1", passed: true, commandId: "stale-complete", at });
    expect(conflicted).toMatchObject({ ok: false, diagnostics: [{ code: "event_store_sequence_conflict" }] });
    const stored = store.read(staleState.workflowId)!;
    expect(stored.snapshot.phase).toBe("paused");
    expect(stored.snapshot.runtime.loops.region).toMatchObject({ status: "running", currentIteration: 1 });
    expect(stored.snapshot.runtime.loops.region?.iterations).toHaveLength(1);
    expect(stored.snapshot.runtime.nodes.work?.status).toBe("succeeded");
  });

  it("completes schema-2 textual predicate migration through explicit typed revision", () => {
    const legacy = taskDefinition();
    legacy.loops[0]!.successWhen = "loop.passed == true";
    const defined = {
      eventId: "legacy-defined", workflowId: "workflow-v2-completion", revision: 1, sequence: 1,
      type: "hypagraph.workflow.defined" as const, version: 1 as const, timestamp: at,
      causationId: "legacy", correlationId: "legacy", data: { definition: legacy },
    };
    const replayed = replayEvents([defined]);
    const storedV2 = { ...replayed, schemaVersion: 2, snapshotHash: "legacy-v2-hash" };
    const restored = restoreLatestSession([{ type: "message", message: { role: "toolResult", toolName: "hypagraph_read", details: { hypagraph: { events: [defined], snapshot: storedV2 } } } }]);
    expect(restored?.snapshot.runtime.loops.region?.status).toBe("requires_revision");
    const revised = handleCommand(restored!.snapshot, { type: "revise", definition: taskDefinition(), commandId: "typed-revision", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.state.schemaVersion).toBe(3);
    expect(revised.state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0 });
    expect(revised.state.runtime.nodes.work?.status).toBe("ready");
    expect(revised.events.some((event) => event.type === "hypagraph.loop.invalidated")).toBe(true);
  });
});
''')

for path in [
    "src/domain/model.ts",
    "src/domain/workflow-outcome.ts",
    "src/domain/projection.ts",
    "src/domain/reducer.ts",
    "src/persistence/event-store.ts",
    "src/persistence/coordinator.ts",
    "src/persistence/pi-session-store.ts",
    "src/persistence/session-rebuild.ts",
    "src/checks/durable-lifecycle.ts",
    "src/checks/recovery.ts",
    "src/extension.ts",
    "src/ui/format.ts",
    "tests/loop-revision-recovery.test.ts",
    "tests/loop-persistence-hardening.test.ts",
    "docs/m4-vertical-slice-plan.md",
    "docs/event-runtime.md",
    "README.md",
    "skills/hypagraph/SKILL.md",
]:
    data = Path(path).read_bytes()
    if b"\x00" in data:
        raise SystemExit(f"NUL control character found in {path}")
