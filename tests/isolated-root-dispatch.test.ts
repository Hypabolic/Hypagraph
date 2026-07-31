import { describe, expect, it } from "vitest";
import {
  buildExecutorResultPayload,
  type ExecutorContextEnvelope,
  type ExecutorProfileRef,
} from "../src/domain/executor-contract.js";
import { settleExecutorResult } from "../src/domain/executor-settlement.js";
import { createRootFamily } from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  CURRENT_SESSION_OPT_IN_PROFILE,
  DEFAULT_MODEL_EXECUTOR_PROFILE,
} from "../src/domain/model-executor-profile.js";
import {
  acceptIsolatedRootSettlement,
  buildOrphanedTaskCancelCommands,
  buildPostSubmitVerificationCommands,
  isolatedRootSettleMeta,
  markIsolatedRootAttemptSettled,
  prepareIsolatedRootAttempt,
  routeRootModelLaneAction,
  withHostTimestamp,
  type ActiveIsolatedRootAttempt,
} from "../src/pi/isolated-root-dispatch.js";
import { materializeIsolatedPiContext } from "../src/pi/isolated-pi-executor.js";

const at = "2026-07-31T12:00:00.000Z";

const definition = (executorProfile?: HypagraphDefinition["nodes"][0]["executorProfile"]): HypagraphDefinition => ({
  title: "Isolated root fixture",
  goal: "Ship isolated default routing",
  nodes: [
    {
      id: "implement",
      title: "Implement",
      requires: [],
      acceptance: ["done"],
      produces: [{ name: "work.done", type: "boolean", required: true }],
      ...(executorProfile === undefined ? {} : { executorProfile }),
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const startedState = (def: HypagraphDefinition = definition()): HypagraphState => {
  const created = createHypagoalWorkflow(def, {
    workflowId: "workflow-root",
    goalId: "goal-root",
    goalWorkflowId: "workflow-root",
    at,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  return created.state;
};

const familyFor = (state: HypagraphState) => {
  const family = createRootFamily({
    familyId: "family-root",
    rootGoalId: state.goal!.goalId,
    rootWorkflowId: state.workflowId,
    at,
  });
  if (!family.ok) throw new Error(JSON.stringify(family.diagnostics));
  return family.family;
};

const startReadyAction = (state: HypagraphState) => ({
  kind: "start-ready-task" as const,
  nodeId: "implement",
  goalId: state.goal!.goalId,
  workflowId: state.workflowId,
  revision: state.revision,
  sequence: state.sequence,
  snapshotHash: state.snapshotHash,
  continuationOrdinal: state.goal!.continuationOrdinal,
});

describe("isolated root dispatch routing (S6.2)", () => {
  it("routes default start-ready-task to isolated-worker without follow-up", () => {
    const state = startedState();
    const routing = routeRootModelLaneAction(startReadyAction(state), state);
    expect(routing.kind).toBe("isolated-worker");
    if (routing.kind !== "isolated-worker") return;
    expect(routing.resolved.profile).toEqual(DEFAULT_MODEL_EXECUTOR_PROFILE);
    expect(routing.resolved.source).toBe("default");
  });

  it("routes current-session opt-in to follow-up", () => {
    const state = startedState(definition({
      profileId: "current-session-default",
      kind: "current-session",
    }));
    const routing = routeRootModelLaneAction(startReadyAction(state), state);
    expect(routing.kind).toBe("current-session-follow-up");
    if (routing.kind !== "current-session-follow-up") return;
    expect(routing.resolved?.profile).toEqual(CURRENT_SESSION_OPT_IN_PROFILE);
  });

  it("keeps revision and interaction on orchestrator follow-up", () => {
    const state = startedState();
    const revision = routeRootModelLaneAction({
      kind: "request-revision",
      blocker: {
        kind: "blocked-node",
        id: "x",
        reason: "blocked",
        sourceRevision: 0,
        sourceSequence: 0,
        sourceSnapshotHash: "h",
      },
      goalId: state.goal!.goalId,
      workflowId: state.workflowId,
      revision: state.revision,
      sequence: state.sequence,
      snapshotHash: state.snapshotHash,
      continuationOrdinal: state.goal!.continuationOrdinal,
    }, state);
    expect(revision.kind).toBe("orchestrator-follow-up");
  });
});

describe("prepare and settle isolated root attempts (S6.2–S6.3)", () => {
  it("prepares start-node and materializes isolated context", () => {
    const state = startedState();
    const family = familyFor(state);
    const prepared = prepareIsolatedRootAttempt({
      state,
      family,
      action: startReadyAction(state),
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-1",
      operationId: "op-1",
      sessionGeneration: 1,
      branchGeneration: 0,
      startedAt: at,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.startCommands).toHaveLength(1);
    expect(prepared.startCommands[0]?.type).toBe("start-node");
    expect(prepared.context.profile.kind).toBe("isolated-pi");
    expect(prepared.active.attemptId).toBe("attempt-1");
    expect(prepared.active.settled).toBe(false);

    const stamped = withHostTimestamp(prepared.startCommands, at);
    expect(stamped[0]?.at).toBe(at);
  });

  it("rejects double settle of the same active attempt", () => {
    const state = startedState();
    const family = familyFor(state);
    const prepared = prepareIsolatedRootAttempt({
      state,
      family,
      action: startReadyAction(state),
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-double",
      operationId: "op-double",
      sessionGeneration: 2,
      branchGeneration: 1,
      startedAt: at,
    });
    if (!prepared.ok) throw new Error("prepare failed");

    let next = handleCommand(state, {
      ...prepared.startCommands[0]!,
      at,
    });
    if (!next.ok) throw new Error(JSON.stringify(next.diagnostics));
    next = { ok: true, state: next.state, events: next.events };

    const context = materializeIsolatedPiContext({
      family,
      state: next.state,
      nodeId: "implement",
      attemptId: "attempt-double",
    });
    if (!context.ok) throw new Error(JSON.stringify(context.diagnostics));

    const payload = buildExecutorResultPayload({
      identity: context.value.identity,
      outcome: "submitted",
      facts: [{
        name: "work.done",
        type: "boolean",
        value: true,
        evidence: [{ ref: "evidence://done", kind: "note" }],
      }],
      evidence: [{ ref: "evidence://done", kind: "note" }],
      summary: "worker done",
    });
    const settlement = settleExecutorResult(
      context.value,
      payload,
      isolatedRootSettleMeta("op-double", at),
    );
    expect(settlement.ok).toBe(true);

    const first = acceptIsolatedRootSettlement({
      active: prepared.active,
      settlement,
      sessionGeneration: 2,
      branchGeneration: 1,
    });
    expect(first.ok).toBe(true);

    const second = acceptIsolatedRootSettlement({
      active: prepared.active,
      settlement,
      sessionGeneration: 2,
      branchGeneration: 1,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/already settled/);
    expect(second.diagnostics?.[0]?.code).toBe("isolated_root_double_settle");
  });

  it("rejects settlement after generation change", () => {
    const active: ActiveIsolatedRootAttempt = {
      operationId: "op-gen",
      nodeId: "implement",
      attemptId: "attempt-gen",
      goalId: "goal-gen",
      workflowId: "workflow-gen",
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      actionKind: "start-ready-task",
      sessionGeneration: 1,
      branchGeneration: 0,
      settled: false,
      abortController: new AbortController(),
      startedAt: at,
      timeoutMs: 60_000,
    };
    const rejected = acceptIsolatedRootSettlement({
      active,
      settlement: {
        ok: false,
        diagnostics: [{ code: "x", message: "unused" }],
      },
      sessionGeneration: 2,
      branchGeneration: 0,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toMatch(/generation is stale/);
  });

  it("builds orphan cancel for tracked attempt only", () => {
    let state = startedState();
    const started = handleCommand(state, {
      type: "start-node",
      nodeId: "implement",
      attemptId: "attempt-orphan",
      commandId: "start-orphan",
      correlationId: "start-orphan",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    state = started.state;

    const commands = buildOrphanedTaskCancelCommands({
      state,
      at,
      reason: "restore",
      correlationId: "corr",
      only: { nodeId: "implement", attemptId: "attempt-orphan" },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "cancel-attempt",
      nodeId: "implement",
      attemptId: "attempt-orphan",
    });
  });

  it("builds post-submit verification when awaiting_evidence", () => {
    let state = startedState();
    const started = handleCommand(state, {
      type: "start-node",
      nodeId: "implement",
      attemptId: "attempt-v",
      commandId: "s",
      correlationId: "s",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    state = started.state;
    const published = handleCommand(state, {
      type: "publish-facts",
      nodeId: "implement",
      attemptId: "attempt-v",
      facts: [{
        name: "work.done",
        type: "boolean",
        value: true,
        evidence: [{ ref: "e", kind: "note" }],
      }],
      commandId: "p",
      correlationId: "p",
      at,
    });
    if (!published.ok) throw new Error(JSON.stringify(published.diagnostics));
    state = published.state;
    const submitted = handleCommand(state, {
      type: "submit-result",
      nodeId: "implement",
      attemptId: "attempt-v",
      evidence: [{ ref: "e", kind: "note" }],
      commandId: "sub",
      correlationId: "sub",
      at,
    });
    if (!submitted.ok) throw new Error(JSON.stringify(submitted.diagnostics));
    state = submitted.state;

    const verify = buildPostSubmitVerificationCommands({
      state,
      nodeId: "implement",
      attemptId: "attempt-v",
      operationId: "op-v",
      at,
    });
    expect(verify).toHaveLength(2);
    expect(verify?.[0]?.type).toBe("begin-verification");
    expect(verify?.[1]?.type).toBe("complete-verification");
  });

  it("markIsolatedRootAttemptSettled is one-shot", () => {
    const active: ActiveIsolatedRootAttempt = {
      operationId: "op",
      nodeId: "implement",
      attemptId: "a1",
      goalId: "goal-root",
      workflowId: "workflow-root",
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE as ExecutorProfileRef,
      actionKind: "start-ready-task",
      sessionGeneration: 0,
      branchGeneration: 0,
      settled: false,
      abortController: new AbortController(),
      startedAt: at,
      timeoutMs: 60_000,
    };
    expect(markIsolatedRootAttemptSettled(active, "a1")).toBe(true);
    expect(active.settled).toBe(true);
    expect(markIsolatedRootAttemptSettled(active, "a1")).toBe(false);
  });

  it("prepare attaches abort controller and default timeout", () => {
    const state = startedState();
    const family = familyFor(state);
    const prepared = prepareIsolatedRootAttempt({
      state,
      family,
      action: startReadyAction(state),
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-timeout",
      operationId: "op-timeout",
      sessionGeneration: 1,
      branchGeneration: 0,
      startedAt: at,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.active.abortController).toBeInstanceOf(AbortController);
    expect(prepared.active.startedAt).toBe(at);
    expect(prepared.active.timeoutMs).toBe(15 * 60 * 1000);
    expect(prepared.active.goalId).toBe(state.goal!.goalId);
    expect(prepared.active.workflowId).toBe(state.workflowId);
    prepared.active.abortController.abort("test-cancel");
    expect(prepared.active.abortController.signal.aborted).toBe(true);
  });
});
