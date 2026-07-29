import { describe, expect, it } from "vitest";
import {
  materializeExecutorContext,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorProfileRef,
  type ExecutorResult,
  type NodeExecutor,
} from "../src/domain/executor-contract.js";
import {
  buildSettlementCommands,
  mapExecutorResultToSettlementPlan,
  settleExecutorResult,
} from "../src/domain/executor-settlement.js";
import {
  createRootFamily,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  CURRENT_SESSION_EXECUTOR_ID,
  CURRENT_SESSION_PROFILE,
  buildCurrentSessionCompletionUntrusted,
  buildCurrentSessionResultPayload,
  commandsFromLiveTaskRouting,
  createCurrentSessionExecutor,
  createCurrentSessionExecutorFromCompletion,
  executeAndSettleCurrentSession,
  materializeCurrentSessionContext,
  produceAndSettleCurrentSessionResult,
  produceCurrentSessionCompletion,
  routeLiveTaskCompletion,
  settleCurrentSessionResult,
  settleCurrentSessionTaskResult,
} from "../src/pi/current-session-executor.js";

const at = "2026-07-29T21:00:00.000Z";
const later = "2026-07-29T21:05:00.000Z";

const profile: ExecutorProfileRef = CURRENT_SESSION_PROFILE;

const chainDefinition = (): HypagraphDefinition => ({
  title: "Current-session executor fixture",
  goal: "Ship current-session settlement",
  nodes: [
    {
      id: "upstream",
      title: "Upstream work",
      description: "Publish a fact for the next node.",
      requires: [],
      acceptance: ["upstream complete"],
      produces: [{ name: "upstream.ready", type: "boolean", required: true }],
      scope: { paths: ["src/**"] },
    },
    {
      id: "work",
      title: "Main work",
      description: "Consume upstream facts and return a structured result.",
      requires: ["upstream"],
      acceptance: ["work complete"],
      produces: [{ name: "work.done", type: "boolean", required: true }],
      scope: { paths: ["src/**"] },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const createStartedWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const startNode = (
  state: HypagraphState,
  nodeId: string,
  attemptId = `attempt-${nodeId}`,
): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const publishFact = (
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  facts: FactInput[],
): HypagraphState => {
  const result = handleCommand(state, {
    type: "publish-facts",
    nodeId,
    attemptId,
    facts,
    commandId: `publish-${nodeId}`,
    correlationId: `publish-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const submitAndSucceed = (
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): HypagraphState => {
  let next = state;
  const submit = handleCommand(next, {
    type: "submit-result",
    nodeId,
    attemptId,
    evidence: [{ ref: `evidence://${nodeId}`, kind: "note", summary: "done" }],
    commandId: `submit-${nodeId}`,
    correlationId: `submit-${nodeId}`,
    at: later,
  });
  if (!submit.ok) throw new Error(JSON.stringify(submit.diagnostics));
  next = submit.state;
  const begin = handleCommand(next, {
    type: "begin-verification",
    nodeId,
    attemptId,
    commandId: `begin-verify-${nodeId}`,
    correlationId: `begin-verify-${nodeId}`,
    at: later,
  });
  if (!begin.ok) throw new Error(JSON.stringify(begin.diagnostics));
  next = begin.state;
  const complete = handleCommand(next, {
    type: "complete-verification",
    nodeId,
    attemptId,
    passed: true,
    commandId: `complete-verify-${nodeId}`,
    correlationId: `complete-verify-${nodeId}`,
    at: later,
  });
  if (!complete.ok) throw new Error(JSON.stringify(complete.diagnostics));
  return complete.state;
};

const createFamilyAndState = (): {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  identity: ExecutorAttemptIdentity;
} => {
  const familyResult = createRootFamily({
    familyId: "family-s7",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  let state = createStartedWorkflow(chainDefinition(), "workflow-root", "goal-root");
  state = startNode(state, "upstream", "attempt-upstream");
  state = publishFact(state, "upstream", "attempt-upstream", [{
    name: "upstream.ready",
    type: "boolean",
    value: true,
    evidence: [{ ref: "evidence://upstream-fact", kind: "note" }],
  }]);
  state = submitAndSucceed(state, "upstream", "attempt-upstream");
  state = startNode(state, "work", "attempt-work-1");

  const identity: ExecutorAttemptIdentity = {
    familyId: "family-s7",
    goalId: "goal-root",
    workflowId: "workflow-root",
    revision: state.revision,
    nodeId: "work",
    attemptId: "attempt-work-1",
  };

  return { family: familyResult.family, state, identity };
};

const materializeDefault = (): ExecutorContextEnvelope => {
  const base = createFamilyAndState();
  const result = materializeExecutorContext({
    family: base.family,
    state: base.state,
    identity: base.identity,
    profile,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};

const matchingResult = (
  context: ExecutorContextEnvelope,
  overrides?: Partial<ExecutorResult>,
): ExecutorResult => ({
  familyId: context.identity.familyId,
  goalId: context.identity.goalId,
  workflowId: context.identity.workflowId,
  revision: context.identity.revision,
  nodeId: context.identity.nodeId,
  attemptId: context.identity.attemptId,
  outcome: "submitted",
  facts: [{ name: "work.done", type: "boolean", value: true }],
  evidence: [{ ref: "evidence://work", kind: "note", summary: "structured" }],
  artifacts: [],
  summary: "Work completed with a structured result.",
  diagnostics: [],
  usage: { turns: 1, totalTokens: 12 },
  ...overrides,
});

const pureMeta = (prefix = "cmd") => {
  let sequence = 0;
  return {
    at: later,
    correlationId: `${prefix}-correlation`,
    commandIdForStep: (stepIndex: number) => `${prefix}-${stepIndex}-${sequence++}`,
  };
};

const applyCommands = (
  state: HypagraphState,
  commands: readonly HypagraphCommand[],
): HypagraphState => {
  let next = state;
  for (const command of commands) {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    next = result.state;
  }
  return next;
};

describe("m7-s7 current-session executor and shared settlement", () => {
  it("settles a valid structured result through validateExecutorResult", () => {
    const context = materializeDefault();
    const untrusted = matchingResult(context);
    const settled = settleExecutorResult(context, untrusted, pureMeta("submit"));

    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    expect(settled.result.outcome).toBe("submitted");
    expect(settled.plan.steps.map((step) => step.kind)).toEqual([
      "publish-facts",
      "submit-result",
    ]);
    expect(settled.commands).toHaveLength(2);
    expect(settled.commands[0]).toMatchObject({
      type: "publish-facts",
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(settled.commands[1]).toMatchObject({
      type: "submit-result",
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
  });

  it("applies a submitted settlement plan to domain state", () => {
    const base = createFamilyAndState();
    const context = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    const settled = settleExecutorResult(
      context.value,
      matchingResult(context.value),
      pureMeta("apply"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const next = applyCommands(base.state, settled.commands);
    expect(next.runtime.nodes.work?.status).toBe("awaiting_evidence");
    expect(next.runtime.facts["work.done"]?.value).toBe(true);
    expect(next.runtime.nodes.work?.currentAttemptId).toBe("attempt-work-1");
  });

  it("rejects raw assistant text and does not mutate state", () => {
    const base = createFamilyAndState();
    const context = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    const stateBefore = structuredClone(base.state);
    const settled = settleExecutorResult(
      context.value,
      "the model finished successfully",
      pureMeta("raw"),
    );

    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.diagnostics[0]?.code).toBe("executor_result_raw_text");
    expect(base.state).toEqual(stateBefore);
  });

  it("rejects identity mismatch and does not produce commands", () => {
    const context = materializeDefault();
    const mismatched = matchingResult(context, {
      attemptId: "attempt-other",
      familyId: "family-other",
    });
    const settled = settleExecutorResult(context, mismatched, pureMeta("mismatch"));

    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.diagnostics.some((item) => item.code === "executor_result_identity_mismatch")).toBe(true);
  });

  it("maps cancelled, failed, timed_out, and interrupted to cancel-attempt with terminal status cancelled", () => {
    // Intentional m7-s7 mapping: no fail-attempt domain command exists yet.
    // cancel-attempt projects node/attempt status to cancelled for all four outcomes.
    const outcomes = ["cancelled", "failed", "timed_out", "interrupted"] as const;

    for (const outcome of outcomes) {
      const base = createFamilyAndState();
      const context = materializeExecutorContext({
        family: base.family,
        state: base.state,
        identity: base.identity,
        profile,
      });
      expect(context.ok).toBe(true);
      if (!context.ok) return;

      const settled = settleExecutorResult(
        context.value,
        matchingResult(context.value, {
          outcome,
          facts: [{ name: "work.done", type: "boolean", value: false }],
          evidence: [{ ref: "evidence://failure", kind: "note" }],
          summary: `Outcome ${outcome}`,
          diagnostics: [{ code: "worker_note", message: "worker detail" }],
        }),
        pureMeta(outcome),
      );
      expect(settled.ok).toBe(true);
      if (!settled.ok) return;

      // Non-submitted outcomes do not commit facts or evidence.
      expect(settled.plan.steps).toEqual([
        expect.objectContaining({
          kind: "cancel-attempt",
          nodeId: "work",
          attemptId: "attempt-work-1",
        }),
      ]);
      expect(settled.commands).toHaveLength(1);
      expect(settled.commands[0]).toMatchObject({
        type: "cancel-attempt",
        nodeId: "work",
        attemptId: "attempt-work-1",
      });
      // Host can still read executor diagnostics; they are not domain commits.
      expect(settled.resultDiagnostics).toEqual([
        { code: "worker_note", message: "worker detail" },
      ]);
      expect(settled.result.facts).toHaveLength(1);
      expect(settled.result.evidence).toHaveLength(1);

      const next = applyCommands(base.state, settled.commands);
      // Terminal domain status is cancelled until a fail-attempt path exists.
      expect(next.runtime.nodes.work?.status).toBe("cancelled");
      expect(next.runtime.nodes.work?.currentAttemptId).toBeUndefined();
      expect(next.runtime.facts["work.done"]).toBeUndefined();
    }
  });

  it("applies a cancelled settlement plan and leaves the node cancelled", () => {
    const base = createFamilyAndState();
    const context = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;

    const settled = settleExecutorResult(
      context.value,
      matchingResult(context.value, {
        outcome: "cancelled",
        facts: [],
        evidence: [],
        summary: "User cancelled the attempt.",
      }),
      pureMeta("cancel-apply"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const next = applyCommands(base.state, settled.commands);
    expect(next.runtime.nodes.work?.status).toBe("cancelled");
    expect(next.runtime.nodes.work?.currentAttemptId).toBeUndefined();
  });

  it("uses one shared settleExecutorResult helper for current-session and isolated stub call sites", async () => {
    const context = materializeDefault();
    const sharedCalls: unknown[] = [];

    const settleShared = (
      ctx: ExecutorContextEnvelope,
      untrusted: unknown,
      meta: ReturnType<typeof pureMeta>,
    ) => {
      sharedCalls.push(untrusted);
      return settleExecutorResult(ctx, untrusted, meta);
    };

    const currentSessionPayload = buildCurrentSessionResultPayload({
      identity: context.identity,
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note" }],
      summary: "current-session path",
    });
    const currentSessionSettled = settleShared(context, currentSessionPayload, pureMeta("cs"));
    expect(currentSessionSettled.ok).toBe(true);

    const isolatedStub: NodeExecutor = {
      id: "isolated-pi-stub",
      version: 1,
      async execute(envelope) {
        return matchingResult(envelope, { summary: "isolated stub path" });
      },
    };
    const isolatedRaw = await isolatedStub.execute(context, new AbortController().signal);
    const isolatedSettled = settleShared(context, isolatedRaw, pureMeta("iso"));
    expect(isolatedSettled.ok).toBe(true);

    expect(sharedCalls).toHaveLength(2);
    expect(currentSessionSettled.ok && isolatedSettled.ok).toBe(true);
    if (currentSessionSettled.ok && isolatedSettled.ok) {
      expect(currentSessionSettled.plan.steps.map((step) => step.kind)).toEqual(
        isolatedSettled.plan.steps.map((step) => step.kind),
      );
    }

    // Public aliases also call the same settleExecutorResult entry point.
    const aliasA = settleCurrentSessionResult(context, currentSessionPayload, pureMeta("alias-a"));
    const aliasB = settleExecutorResult(context, currentSessionPayload, pureMeta("alias-b"));
    expect(aliasA.ok).toBe(true);
    expect(aliasB.ok).toBe(true);
    if (aliasA.ok && aliasB.ok) {
      expect(aliasA.plan).toEqual(aliasB.plan);
      expect(aliasA.result).toEqual(aliasB.result);
    }
  });

  it("current-session task helper materializes context and settles submit", () => {
    const base = createFamilyAndState();
    const settled = settleCurrentSessionTaskResult({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note", summary: "done" }],
      summary: "Task complete through current-session helper.",
      meta: pureMeta("task"),
    });

    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.familyId).toBe("family-s7");
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);

    const next = applyCommands(base.state, settled.commands);
    expect(next.runtime.facts["work.done"]?.value).toBe(true);
    expect(next.runtime.nodes.work?.status).toBe("awaiting_evidence");
  });

  it("current-session NodeExecutor validates results before return", async () => {
    const context = materializeDefault();
    const executor = createCurrentSessionExecutor(async () =>
      buildCurrentSessionResultPayload({
        identity: context.identity,
        outcome: "submitted",
        facts: [{ name: "work.done", type: "boolean", value: true }],
        evidence: [{ ref: "evidence://work", kind: "note" }],
        summary: "adapter completed",
      }),
    );

    expect(executor.id).toBe(CURRENT_SESSION_EXECUTOR_ID);
    expect(executor.version).toBe(1);

    const raw = await executor.execute(context, new AbortController().signal);
    const validated = validateExecutorResult(context, raw);
    expect(validated.ok).toBe(true);

    const settled = await executeAndSettleCurrentSession(
      executor,
      context,
      new AbortController().signal,
      pureMeta("exec-settle"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.summary).toBe("adapter completed");
  });

  it("current-session NodeExecutor rejects raw text through executeAndSettle", async () => {
    const context = materializeDefault();
    const executor = createCurrentSessionExecutor(async () => "raw assistant text is not a result");
    const settled = await executeAndSettleCurrentSession(
      executor,
      context,
      new AbortController().signal,
      pureMeta("raw-exec"),
    );
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.diagnostics[0]?.code).toBe("executor_result_raw_text");
    }
  });

  it("materializeCurrentSessionContext uses the current-session profile", () => {
    const base = createFamilyAndState();
    const materialized = materializeCurrentSessionContext({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.profile).toEqual(CURRENT_SESSION_PROFILE);
    expect(materialized.value.identity.attemptId).toBe("attempt-work-1");
  });

  it("submitted without facts maps only to submit-result", () => {
    const context = materializeDefault();
    const planned = mapExecutorResultToSettlementPlan(
      matchingResult(context, { facts: [] }),
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.steps.map((step) => step.kind)).toEqual(["submit-result"]);

    const built = buildSettlementCommands(planned.plan, pureMeta("no-facts"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.commands).toHaveLength(1);
    expect(built.commands[0]?.type).toBe("submit-result");
  });

  it("rejects invalid settlement meta with distinct diagnostic codes", () => {
    const context = materializeDefault();
    const missingAt = settleExecutorResult(context, matchingResult(context), {
      at: "",
      correlationId: "corr",
      commandIdForStep: () => "id-1",
    });
    expect(missingAt.ok).toBe(false);
    if (!missingAt.ok) {
      expect(missingAt.diagnostics[0]?.code).toBe("executor_settlement_invalid_meta");
    }

    const badId = settleExecutorResult(context, matchingResult(context), {
      at: later,
      correlationId: "corr",
      commandIdForStep: () => "  ",
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok) {
      expect(badId.diagnostics[0]?.code).toBe("executor_settlement_invalid_command_id");
    }
  });

  it("does not mutate the untrusted payload or context during settlement", () => {
    const context = materializeDefault();
    const contextSnapshot = structuredClone(context);
    const untrusted = matchingResult(context);
    const untrustedSnapshot = structuredClone(untrusted);

    const settled = settleExecutorResult(context, untrusted, pureMeta("immut"));
    expect(settled.ok).toBe(true);
    expect(context).toEqual(contextSnapshot);
    expect(untrusted).toEqual(untrustedSnapshot);
  });

  it("rejects class-instance result payloads at the shared settlement path", () => {
    const context = materializeDefault();
    class ResultEnvelope {
      constructor(public payload: ExecutorResult) {}
    }
    const settled = settleExecutorResult(
      context,
      new ResultEnvelope(matchingResult(context)),
      pureMeta("class"),
    );
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.diagnostics[0]?.code).toBe("executor_result_not_object");
    }
  });

  it("surfaces resultDiagnostics and summary on successful settlement for the host", () => {
    const context = materializeDefault();
    const settled = settleExecutorResult(
      context,
      matchingResult(context, {
        summary: "Host-visible summary",
        diagnostics: [{ code: "note_a", message: "detail a" }],
      }),
      pureMeta("diag-surface"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.summary).toBe("Host-visible summary");
    expect(settled.resultDiagnostics).toEqual([{ code: "note_a", message: "detail a" }]);
    expect(settled.plan.resultDiagnostics).toEqual(settled.resultDiagnostics);
  });

  it("product and NodeExecutor share produce payload builder then settleExecutorResult", async () => {
    const base = createFamilyAndState();
    const completion = {
      outcome: "submitted" as const,
      facts: [{ name: "work.done" as const, type: "boolean" as const, value: true }],
      evidence: [{ ref: "evidence://work", kind: "note" as const }],
      summary: "shared produce path",
    };

    const produced = produceCurrentSessionCompletion({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      completion,
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;

    const fromContextBuilder = buildCurrentSessionCompletionUntrusted(
      produced.context,
      completion,
    );
    expect(fromContextBuilder).toEqual(produced.untrusted);

    const productSettled = produceAndSettleCurrentSessionResult({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: completion.outcome,
      facts: completion.facts,
      evidence: completion.evidence,
      summary: completion.summary,
      meta: pureMeta("product-produce"),
    });
    expect(productSettled.ok).toBe(true);

    const executor = createCurrentSessionExecutorFromCompletion(async () => completion);
    const executorSettled = await executeAndSettleCurrentSession(
      executor,
      produced.context,
      new AbortController().signal,
      pureMeta("executor-produce"),
    );
    expect(executorSettled.ok).toBe(true);
    if (!productSettled.ok || !executorSettled.ok) return;
    expect(productSettled.plan.steps.map((step) => step.kind)).toEqual(
      executorSettled.plan.steps.map((step) => step.kind),
    );
    expect(productSettled.result.summary).toBe(executorSettled.result.summary);
  });

  it("routeLiveTaskCompletion settles submit with optional facts for goal+family", () => {
    const base = createFamilyAndState();
    const routing = routeLiveTaskCompletion({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note", summary: "done" }],
      summary: "Product submit through routeLiveTaskCompletion.",
      meta: pureMeta("route-submit"),
    });

    expect(routing.kind).toBe("settled");
    if (routing.kind !== "settled") return;
    expect(routing.settlement.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);

    const extracted = commandsFromLiveTaskRouting(routing);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.commands).toHaveLength(2);

    const next = applyCommands(base.state, routing.settlement.commands);
    expect(next.runtime.facts["work.done"]?.value).toBe(true);
    expect(next.runtime.nodes.work?.status).toBe("awaiting_evidence");
  });

  it("routeLiveTaskCompletion settles cancel for goal+family", () => {
    const base = createFamilyAndState();
    const routing = routeLiveTaskCompletion({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "cancelled",
      reason: "User cancelled through product path.",
      meta: pureMeta("route-cancel"),
    });

    expect(routing.kind).toBe("settled");
    if (routing.kind !== "settled") return;
    expect(routing.settlement.commands).toHaveLength(1);
    expect(routing.settlement.commands[0]).toMatchObject({
      type: "cancel-attempt",
      reason: "User cancelled through product path.",
    });

    const next = applyCommands(base.state, routing.settlement.commands);
    expect(next.runtime.nodes.work?.status).toBe("cancelled");
  });

  it("routeLiveTaskCompletion uses legacy path when goal or family is absent", () => {
    const base = createFamilyAndState();
    const noFamily = routeLiveTaskCompletion({
      family: undefined,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "submitted",
      meta: pureMeta("legacy-family"),
    });
    expect(noFamily.kind).toBe("legacy");

    const stateWithoutGoal = structuredClone(base.state);
    delete stateWithoutGoal.goal;
    const noGoal = routeLiveTaskCompletion({
      family: base.family,
      state: stateWithoutGoal,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "submitted",
      meta: pureMeta("legacy-goal"),
    });
    expect(noGoal.kind).toBe("legacy");

    const extracted = commandsFromLiveTaskRouting(noGoal);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.commands).toBeNull();
  });

  it("routeLiveTaskCompletion rejects when the goal is not in the family", () => {
    const base = createFamilyAndState();
    const badFamily = structuredClone(base.family);
    badFamily.members = {};
    const rejected = routeLiveTaskCompletion({
      family: badFamily,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
      outcome: "submitted",
      meta: pureMeta("route-goal-missing"),
    });
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") return;
    expect(rejected.diagnostics[0]?.code).toMatch(/executor_context_|current_session_/);

    const extracted = commandsFromLiveTaskRouting(rejected);
    expect(extracted.ok).toBe(false);
    if (extracted.ok) return;
    expect(extracted.diagnostics.length).toBeGreaterThan(0);
  });
});
