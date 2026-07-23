import { describe, expect, it, vi } from "vitest";
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
