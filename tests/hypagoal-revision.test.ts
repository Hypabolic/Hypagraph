import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { classifyGoalBlockage } from "../src/domain/goal-blockage.js";
import { isDispatchableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateRestoredGoalState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-24T12:00:00.000Z";
const base = (): HypagraphDefinition => ({
  title: "Bounded repository delivery",
  goal: "Deliver the requested repository feature with its required checks.",
  nodes: [
    { id: "prepare", title: "Prepare", requires: [], acceptance: ["Record the repository change"], scope: { paths: ["src/**"] } },
    { id: "finish", title: "Finish", requires: ["prepare"], acceptance: ["Keep the required acceptance condition"] },
  ],
  loops: [],
  policy: { mode: "strict", requireEvidence: true },
});

const createGoal = (definition = base()) => {
  const created = createWorkflow(definition, at, "revision-workflow");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const started = handleCommand(created.state, { type: "start-goal", goalId: "revision-root", budget: { maximumTurns: 5, maximumTokens: 500 }, commandId: "start-goal", at });
  if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
  return { state: started.state, events: [...created.events, ...started.events] };
};

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const block = (value: ReturnType<typeof createGoal>, blockerKind: "repository-work" | "external-dependency" | "safeguard" | "unknown" = "repository-work") => {
  value.state = apply(value.state, value.events, { type: "block-node", nodeId: "prepare", reason: "A bounded migration step is missing.", blockerKind, commandId: "block", at });
  return value;
};

const requestRevision = (value: ReturnType<typeof createGoal>) => {
  const selected = selectGoalContinuation(value.state);
  if (!isDispatchableGoalContinuation(selected) || selected.kind !== "request-revision") throw new Error(`Unexpected decision: ${selected.kind}`);
  value.state = apply(value.state, value.events, {
    type: "request-goal-continuation",
    goalId: selected.goalId,
    workflowId: selected.workflowId,
    expectedRevision: selected.revision,
    expectedSequence: selected.sequence,
    expectedSnapshotHash: selected.snapshotHash,
    expectedContinuationOrdinal: selected.continuationOrdinal,
    sessionGeneration: 1,
    branchGeneration: 2,
    action: { kind: "request-revision", blocker: selected.blocker },
    commandId: "revision-operation",
    at,
  });
  return selected;
};

const proposalCommand = (state: HypagraphState, definition: HypagraphDefinition): HypagraphCommand => {
  const pending = state.goal!.pendingContinuation!;
  const action = pending.action;
  if (action.kind !== "request-revision") throw new Error("Expected a revision action.");
  return {
    type: "apply-goal-revision",
    goalId: state.goal!.goalId,
    workflowId: state.workflowId,
    expectedRevision: state.revision,
    expectedSequence: state.sequence,
    expectedSnapshotHash: state.snapshotHash,
    revisionOperationId: pending.operationId,
    continuationOperationId: pending.operationId,
    continuationOrdinal: pending.ordinal,
    requestSequence: pending.requestSequence,
    sessionGeneration: pending.sessionGeneration,
    branchGeneration: pending.branchGeneration,
    blocker: action.blocker,
    definition,
    commandId: "apply-revision",
    at,
  };
};

const acceptedProposal = (definition = base()): HypagraphDefinition => ({
  ...structuredClone(definition),
  nodes: [
    { id: "migration", title: "Add the missing bounded migration", requires: [], acceptance: ["Implement the missing repository step"], scope: { paths: ["src/**"] } },
    ...definition.nodes.map((node) => node.id === "prepare"
      ? { ...structuredClone(node), requires: [...node.requires, "migration"] }
      : structuredClone(node)),
  ],
});

describe("bounded Hypagoal revision", () => {
  it("classifies a typed blocked repository node deterministically", () => {
    const value = block(createGoal());
    expect(classifyGoalBlockage(value.state)).toMatchObject({ kind: "revision-eligible", blocker: { kind: "blocked-node", id: "prepare" } });
    expect(classifyGoalBlockage(value.state)).toEqual(classifyGoalBlockage(value.state));
  });

  it.each(["external-dependency", "safeguard", "unknown"] as const)("does not revise a %s blocker", (kind) => {
    const value = block(createGoal(), kind);
    expect(classifyGoalBlockage(value.state).kind).toBe("revision-not-allowed");
    expect(selectGoalContinuation(value.state).kind).toBe("stop-blocked");
  });

  it("does not revise while another root component is runnable", () => {
    const definition = base();
    definition.nodes.push({ id: "independent", title: "Independent", requires: [], acceptance: [] });
    const value = block(createGoal(definition));
    expect(classifyGoalBlockage(value.state)).toEqual({ kind: "not-blocked" });
    expect(selectGoalContinuation(value.state)).toMatchObject({ kind: "start-ready-task", nodeId: "independent" });
  });

  it.each(["paused", "budget_limited", "failed", "cancelled"] as const)("does not request revision for %s goal state", (status) => {
    const value = block(createGoal());
    const changed = structuredClone(value.state);
    changed.goal!.status = status;
    changed.goal!.stopReason = `The goal is ${status}.`;
    if (status === "paused") changed.goal!.pauseCause = "explicit";
    expect(classifyGoalBlockage(changed).kind).toBe("revision-not-allowed");
  });

  it("consumes exactly one automatic allowance when the durable request is stored", () => {
    const value = block(createGoal());
    requestRevision(value);
    expect(value.state.goal?.automaticRevision).toMatchObject({ maximumAttempts: 1, consumedAttempts: 1, lastAttempt: { outcome: "pending", operationId: "revision-operation" } });
    expect(value.events.filter((event) => event.type === "hypagraph.goal.revision-requested")).toHaveLength(1);
    const exhausted = structuredClone(value.state);
    delete exhausted.goal!.pendingContinuation;
    expect(selectGoalContinuation(exhausted)).toMatchObject({ kind: "stop-blocked" });
  });

  it("accepts one safe proposal through the existing workflow revision event", () => {
    const value = block(createGoal());
    requestRevision(value);
    const result = handleCommand(value.state, proposalCommand(value.state, acceptedProposal()));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.events.map((event) => event.type)).toContain("hypagraph.workflow.revised");
    expect(result.events.map((event) => event.type)).toContain("hypagraph.goal.revision-applied");
    expect(result.state).toMatchObject({ revision: 2, phase: "running", goal: { status: "active", automaticRevision: { consumedAttempts: 1, lastAttempt: { outcome: "applied", appliedRevision: 2 } } } });
    expect(result.state.runtime.nodes.migration!.status).toBe("ready");
  });

  it("preserves completed independent work and invalidates only affected dependants", () => {
    const definition = base();
    definition.nodes.unshift({ id: "independent", title: "Independent", requires: [], acceptance: [] });
    const value = createGoal(definition);
    value.state = apply(value.state, value.events, { type: "start-node", nodeId: "independent", attemptId: "independent-1", commandId: "independent-start", at });
    value.state = apply(value.state, value.events, { type: "submit-result", nodeId: "independent", attemptId: "independent-1", evidence: [{ ref: "independent", kind: "note" }], commandId: "independent-submit", at });
    value.state = apply(value.state, value.events, { type: "begin-verification", nodeId: "independent", attemptId: "independent-1", commandId: "independent-verify", at });
    value.state = apply(value.state, value.events, { type: "complete-verification", nodeId: "independent", attemptId: "independent-1", passed: true, commandId: "independent-pass", at });
    block(value);
    requestRevision(value);
    const proposed = acceptedProposal(definition);
    const result = handleCommand(value.state, proposalCommand(value.state, proposed));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.state.runtime.nodes.independent!.status).toBe("succeeded");
    expect(result.state.runtime.nodes.independent!.attemptCount).toBe(1);
    expect(result.state.runtime.nodes.prepare!.status).toBe("stale");
  });

  it("rejects a changed objective byte-for-byte", () => {
    const value = block(createGoal());
    requestRevision(value);
    const proposal = acceptedProposal();
    proposal.goal += " ";
    const result = handleCommand(value.state, proposalCommand(value.state, proposal));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.state.revision).toBe(1);
    expect(result.state.goal?.automaticRevision.lastAttempt).toMatchObject({ outcome: "rejected", outcomeCode: "automatic_revision_objective_changed" });
  });

  it.each([
    ["required acceptance", (definition: HypagraphDefinition) => { definition.nodes.find((node) => node.id === "prepare")!.acceptance = []; }, "automatic_revision_acceptance_removed"],
    ["required evidence", (definition: HypagraphDefinition) => { definition.policy.requireEvidence = false; }, "automatic_revision_evidence_weakened"],
    ["strict enforcement", (definition: HypagraphDefinition) => { definition.policy.mode = "guided"; }, "automatic_revision_enforcement_weakened"],
    ["existing node", (definition: HypagraphDefinition) => { definition.nodes = definition.nodes.filter((node) => node.id !== "prepare"); }, "automatic_revision_node_removed"],
  ] as const)("rejects removal of %s", (_label, mutate, code) => {
    const value = block(createGoal());
    requestRevision(value);
    const proposal = acceptedProposal();
    mutate(proposal);
    const result = handleCommand(value.state, proposalCommand(value.state, proposal));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.state.goal?.automaticRevision.lastAttempt).toMatchObject({ outcome: "rejected", outcomeCode: code });
  });

  it("rejects a no-op and a proposal which still has no runnable path", () => {
    const noOpValue = block(createGoal());
    requestRevision(noOpValue);
    const noOp = handleCommand(noOpValue.state, proposalCommand(noOpValue.state, base()));
    if (!noOp.ok) throw new Error(JSON.stringify(noOp.diagnostics));
    expect(noOp.state.goal?.automaticRevision.lastAttempt).toMatchObject({ outcome: "rejected", outcomeCode: "automatic_revision_no_op" });

    const blockedValue = block(createGoal());
    requestRevision(blockedValue);
    const proposal = structuredClone(base());
    proposal.title = "Changed title only";
    const blocked = handleCommand(blockedValue.state, proposalCommand(blockedValue.state, proposal));
    if (!blocked.ok) throw new Error(JSON.stringify(blocked.diagnostics));
    expect(blocked.state.goal?.automaticRevision.lastAttempt).toMatchObject({ outcome: "rejected", outcomeCode: "automatic_revision_still_blocked" });
  });

  it("rejects stale proposal identity without mutating canonical state", () => {
    const value = block(createGoal());
    requestRevision(value);
    const command = proposalCommand(value.state, acceptedProposal()) as Extract<HypagraphCommand, { type: "apply-goal-revision" }>;
    command.expectedSequence += 1;
    const result = handleCommand(value.state, command);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "stale_goal_revision" }] });
    expect(value.state.revision).toBe(1);
  });

  it("rejects revision while a task or check attempt is active", () => {
    const value = createGoal();
    const active = apply(value.state, value.events, { type: "start-node", nodeId: "prepare", attemptId: "prepare-active", commandId: "active", at });
    const result = handleCommand(active, { type: "revise", definition: acceptedProposal(), commandId: "manual-revise", at });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "active_revision_not_allowed" }] });
  });

  it("replay and restore reproduce the consumed revision attempt without dispatch", () => {
    const value = block(createGoal());
    requestRevision(value);
    const replayed = replayEvents(value.events);
    expect(replayed).toEqual(value.state);
    expect(replayed.goal?.automaticRevision.consumedAttempts).toBe(1);
    expect(() => validateRestoredGoalState(replayed)).not.toThrow();
  });

  it("old revision results cannot mutate the revised graph", () => {
    const value = block(createGoal());
    requestRevision(value);
    const accepted = handleCommand(value.state, proposalCommand(value.state, acceptedProposal()));
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.diagnostics));
    const stale = handleCommand(accepted.state, { type: "submit-result", nodeId: "prepare", attemptId: "old-attempt", evidence: [], commandId: "stale-result", at });
    expect(stale).toMatchObject({ ok: false });
  });
});
