import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  hashExecutorContext,
  materializeExecutorContext,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorResult,
} from "../src/domain/executor-contract.js";
import { settleExecutorResult } from "../src/domain/executor-settlement.js";
import {
  createRootFamily,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  ISOLATED_PI_EXECUTOR_ID,
  ISOLATED_PI_PROFILE,
  IsolatedPiProcessRegistry,
  IsolatedPiSessionLostError,
  bindActiveIsolatedPiHost,
  buildIsolatedPiResultPayload,
  clampExecutorDiagnostics,
  buildIsolatedPiRpcPrompt,
  createChildProcessIsolatedPiTransport,
  createFakeIsolatedPiTransport,
  createIsolatedPiExecutor,
  createIsolatedPiHost,
  createNodeExecutorForProfile,
  dispatchIsolatedPiAttempt,
  executeAndSettleIsolatedPi,
  extractStructuredResultFromAssistantText,
  JsonlUtf8LineReader,
  killPidBestEffort,
  materializeIsolatedPiContext,
  normalizeExecutorUsage,
  parseWorkerReply,
  reconcileIsolatedPiOrphans,
  resultFromContext,
  settleIsolatedPiResult,
  terminateChildProcessTree,
} from "../src/pi/isolated-pi-executor.js";
import {
  CURRENT_SESSION_PROFILE,
  createCurrentSessionExecutor,
} from "../src/pi/current-session-executor.js";

const at = "2026-07-29T22:00:00.000Z";
const later = "2026-07-29T22:05:00.000Z";

const profile = ISOLATED_PI_PROFILE;

const chainDefinition = (): HypagraphDefinition => ({
  title: "Isolated Pi executor fixture",
  goal: "Ship isolated Pi settlement",
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
    familyId: "family-s8",
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
    familyId: "family-s8",
    goalId: "goal-root",
    workflowId: "workflow-root",
    revision: state.revision,
    nodeId: "work",
    attemptId: "attempt-work-1",
  };

  return { family: familyResult.family, state, identity };
};

const materializeDefault = (): {
  context: ExecutorContextEnvelope;
  family: GoalFamilyRuntime;
  state: HypagraphState;
} => {
  const base = createFamilyAndState();
  const result = materializeExecutorContext({
    family: base.family,
    state: base.state,
    identity: base.identity,
    profile,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { context: result.value, family: base.family, state: base.state };
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
  summary: "Work completed with a structured isolated Pi result.",
  diagnostics: [],
  usage: { turns: 2, totalTokens: 40 },
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

describe("m7-s8 isolated Pi executor", () => {
  it("happy path: fake transport returns structured result and settlement produces domain commands", async () => {
    const { context, state } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-happy";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-happy",
    });

    expect(executor.id).toBe(ISOLATED_PI_EXECUTOR_ID);
    expect(executor.version).toBe(1);
    expect(context.profile.kind).toBe("isolated-pi");

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.usage.totalTokens).toBe(40);
    expect(registry.get(token)).toBeUndefined();
    expect(registry.hasActive()).toBe(false);

    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);

    const settled = await executeAndSettleIsolatedPi(
      executor,
      context,
      new AbortController().signal,
      pureMeta("happy"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);
    expect(registry.get(token)).toBeUndefined();

    const next = applyCommands(state, settled.commands);
    expect(next.runtime.facts["work.done"]?.value).toBe(true);
    expect(next.runtime.nodes.work?.status).toBe("awaiting_evidence");
    expect(transport.terminations.length).toBeGreaterThan(0);
  });

  it("cancellation: AbortSignal terminates the process and returns cancelled", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-cancel";
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });

    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (_context, signal) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new IsolatedPiSessionLostError("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new IsolatedPiSessionLostError("aborted during run"));
          }, { once: true });
        });
        return matchingResult(_context);
      },
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-cancel",
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await runGate;
    controller.abort();

    const result = await executePromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_cancelled")).toBe(true);
    expect(transport.terminations.some((item) => item.reason === "cancelled" || item.reason === "cleanup")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    const settled = settleIsolatedPiResult(context, result, pureMeta("cancel"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]).toMatchObject({
      type: "cancel-attempt",
      attemptId: "attempt-work-1",
    });
  });

  it("session loss mid-run returns interrupted with context identity and still settles", async () => {
    const { context, family, state } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-lost";
    const familyBefore = structuredClone(family);
    const stateBefore = structuredClone(state);

    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => {
        throw new IsolatedPiSessionLostError(
          "The isolated Pi process exited during the attempt.",
        );
      },
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-lost",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.goalId).toBe(context.identity.goalId);
    expect(result.workflowId).toBe(context.identity.workflowId);
    expect(result.revision).toBe(context.identity.revision);
    expect(result.nodeId).toBe(context.identity.nodeId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_session_lost")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    expect(family).toEqual(familyBefore);
    expect(state).toEqual(stateBefore);
    expect(family.members["goal-root"]).toBeDefined();

    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);

    const settled = settleExecutorResult(context, result, pureMeta("lost"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands).toHaveLength(1);
    expect(settled.commands[0]?.type).toBe("cancel-attempt");

    const next = applyCommands(state, settled.commands);
    expect(next.runtime.nodes.work?.status).toBe("cancelled");
    expect(family.members["goal-root"]?.workflowId).toBe("workflow-root");
  });

  it("stale mismatched identity from worker is rewritten to failed with context identity", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-stale";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => ({
        ...matchingResult(envelope),
        attemptId: "attempt-stale-other",
        familyId: "family-other",
      }),
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-stale",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "executor_result_identity_mismatch")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_stale_result")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    const settled = settleIsolatedPiResult(context, result, pureMeta("stale"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("orphan reconciliation marks and terminates owned processes that are no longer live", async () => {
    const registry = new IsolatedPiProcessRegistry();
    const identity: ExecutorAttemptIdentity = {
      familyId: "family-s8",
      goalId: "goal-root",
      workflowId: "workflow-root",
      revision: 1,
      nodeId: "work",
      attemptId: "attempt-orphan",
    };

    const liveReg = registry.register({
      ownershipToken: "token-live",
      identity,
      pid: 1001,
      checkoutKey: "checkout-a",
      startedAt: later,
      live: true,
    });
    expect(liveReg.ok).toBe(true);

    const deadReg = registry.register({
      ownershipToken: "token-dead",
      identity: { ...identity, attemptId: "attempt-orphan-2" },
      pid: 1002,
      checkoutKey: "checkout-b",
      startedAt: later,
      live: true,
    });
    expect(deadReg.ok).toBe(true);

    const terminated: string[] = [];
    const result = await reconcileIsolatedPiOrphans(
      registry,
      (record) => record.ownershipToken === "token-live",
      async (record) => {
        terminated.push(record.ownershipToken);
      },
    );

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]?.ownershipToken).toBe("token-dead");
    expect(result.terminatedTokens).toEqual(["token-dead"]);
    expect(terminated).toEqual(["token-dead"]);
    expect(registry.get("token-live")).toBeDefined();
    expect(registry.get("token-dead")).toBeUndefined();
  });

  it("profile kind is isolated-pi and materializeIsolatedPiContext works", () => {
    const base = createFamilyAndState();
    const materialized = materializeIsolatedPiContext({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.profile).toEqual(ISOLATED_PI_PROFILE);
    expect(materialized.value.profile.kind).toBe("isolated-pi");
    expect(materialized.value.identity.attemptId).toBe("attempt-work-1");

    const hashA = hashExecutorContext(materialized.value);
    const hashB = hashExecutorContext(materialized.value);
    expect(hashA).toBe(hashB);
  });

  it("raw text-only worker reply is not accepted as submitted success", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-raw";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => "the model finished successfully with only text",
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-raw",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_invalid_worker_reply")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    const direct = validateExecutorResult(context, "raw assistant text");
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.diagnostics[0]?.code).toBe("executor_result_raw_text");
    }

    const settled = settleExecutorResult(context, "raw assistant text", pureMeta("raw"));
    expect(settled.ok).toBe(false);
  });

  it("maps structured worker error envelope with isolated_pi_worker_error", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-worker-error";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => ({
        type: "error",
        code: "model_timeout",
        message: "The worker model timed out.",
      }),
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-worker-error",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_worker_error")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "model_timeout")).toBe(true);
    expect(result.diagnostics.some((item) => item.message.includes("timed out"))).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_invalid_worker_reply")).toBe(false);
    expect(registry.get(token)).toBeUndefined();

    const settled = settleIsolatedPiResult(context, result, pureMeta("worker-error"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("parseWorkerReply distinguishes error, ownership echo, and invalid shapes", () => {
    expect(parseWorkerReply({ type: "error", code: "x", message: "y" }, "tok")).toEqual({
      kind: "worker_error",
      code: "x",
      message: "y",
    });
    expect(parseWorkerReply({ type: "error" }, "tok").kind).toBe("worker_error");
    expect(parseWorkerReply("raw", "tok").kind).toBe("invalid");
    expect(parseWorkerReply({ ownershipToken: "other", outcome: "submitted" }, "tok").kind)
      .toBe("ownership_echo_mismatch");
    expect(parseWorkerReply({
      type: "result",
      ownershipToken: "tok",
      result: matchingResult(materializeDefault().context),
    }, "tok").kind).toBe("result");
  });

  it("clamps overflow diagnostics and normalizes invalid usage so settlement succeeds", async () => {
    const { context } = materializeDefault();
    const many = Array.from({ length: 80 }, (_, index) => ({
      code: `diag_${index}`,
      message: `Diagnostic ${index}`,
    }));
    const clamped = clampExecutorDiagnostics(many, context.resultProtocol.maxDiagnostics);
    expect(clamped.length).toBeLessThanOrEqual(context.resultProtocol.maxDiagnostics);
    expect(clamped.some((item) => item.code === "isolated_pi_diagnostics_truncated")).toBe(true);

    expect(normalizeExecutorUsage({ turns: "banana", totalTokens: 3 })).toEqual({ totalTokens: 3 });
    expect(normalizeExecutorUsage({ turns: -1, inputTokens: 2.5 })).toEqual({});

    const result = resultFromContext(
      context,
      "failed",
      many,
      "overflow path",
      { turns: "nope" as unknown as number, totalTokens: 9 },
    );
    expect(result.diagnostics.length).toBeLessThanOrEqual(context.resultProtocol.maxDiagnostics);
    expect(result.usage).toEqual({ totalTokens: 9 });

    const settled = settleExecutorResult(context, result, pureMeta("overflow"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");

    // Worker returns many bad facts plus invalid usage → still settleable failed result.
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-overflow-worker";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => ({
        ...matchingResult(envelope),
        facts: Array.from({ length: 64 }, (_, index) => ({
          name: `bad.fact.${index}`,
          type: "not-a-type",
          value: false,
        })),
        evidence: undefined,
        artifacts: undefined,
        diagnostics: many,
        usage: { turns: "banana" },
      }),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-overflow",
    });
    const failed = await executor.execute(context, new AbortController().signal);
    expect(failed.outcome).toBe("failed");
    expect(failed.diagnostics.length).toBeLessThanOrEqual(context.resultProtocol.maxDiagnostics);
    const settledFailed = settleIsolatedPiResult(context, failed, pureMeta("overflow-worker"));
    expect(settledFailed.ok).toBe(true);
    expect(registry.get(token)).toBeUndefined();
  });

  it("completed result wins over concurrent abort", async () => {
    const { context } = materializeDefault();
    let releaseResult: ((value: unknown) => void) | undefined;
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () =>
        new Promise((resolve) => {
          releaseResult = resolve;
        }),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      createOwnershipToken: () => "token-race",
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-race",
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    // Wait until runAttempt is pending, then complete the result first.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseResult).toBeTypeOf("function");
    releaseResult?.(matchingResult(context, { summary: "completed before cancel wins" }));
    // Abort after the result is already resolved into the race.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await executePromise;
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("completed before cancel wins");
  });

  it("createNodeExecutorForProfile routes isolated-pi and current-session", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "routed through profile factory",
      }),
    });

    const executor = createNodeExecutorForProfile(ISOLATED_PI_PROFILE, {
      isolatedPi: {
        transport,
        createOwnershipToken: () => "token-route",
        startedAt: () => later,
        resolveCheckoutKey: () => "/tmp/checkout-route",
      },
    });

    expect(executor.id).toBe(ISOLATED_PI_EXECUTOR_ID);
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.summary).toBe("routed through profile factory");
    expect(result.outcome).toBe("submitted");

    const current = createNodeExecutorForProfile(
      { profileId: "current-session-default", kind: "current-session" },
      {
        createCurrentSession: () => createCurrentSessionExecutor(async () =>
          buildIsolatedPiResultPayload({
            identity: context.identity,
            outcome: "submitted",
            summary: "current session via router",
            facts: [{ name: "work.done", type: "boolean", value: true }],
            evidence: [{ ref: "evidence://work", kind: "note" }],
          }),
        ),
      },
    );
    expect(current.id).toBe("current-session");
  });

  it("start failure maps to failed with identity from context and clears registry", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-start-fail";
    const transport = createFakeIsolatedPiTransport({
      failStart: "Pi binary not found",
      runAttempt: async () => matchingResult(context),
    });

    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-start-fail",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_start_failed")).toBe(true);
    expect(result.diagnostics[0]?.message).toContain("Pi binary not found");
    expect(registry.get(token)).toBeUndefined();
  });

  it("blocks concurrent same-checkout mutation by cwd key", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const first = registry.register({
      ownershipToken: "token-owner-1",
      identity: context.identity,
      checkoutKey: "/shared/cwd",
      startedAt: later,
      live: true,
      pid: 11,
    });
    expect(first.ok).toBe(true);

    const second = registry.register({
      ownershipToken: "token-owner-2",
      identity: { ...context.identity, attemptId: "attempt-work-2" },
      checkoutKey: "/shared/cwd",
      startedAt: later,
      live: true,
      pid: 12,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("isolated_pi_concurrent_checkout_blocked");

    // Different checkouts are allowed.
    const third = registry.register({
      ownershipToken: "token-owner-3",
      identity: { ...context.identity, attemptId: "attempt-work-3", workflowId: "other-workflow" },
      checkoutKey: "/other/cwd",
      startedAt: later,
      live: true,
      pid: 13,
    });
    expect(third.ok).toBe(true);
  });

  it("rejects duplicate ownership tokens", () => {
    const registry = new IsolatedPiProcessRegistry();
    const identity: ExecutorAttemptIdentity = {
      familyId: "family-s8",
      goalId: "goal-root",
      workflowId: "workflow-root",
      revision: 1,
      nodeId: "work",
      attemptId: "attempt-dup",
    };
    const first = registry.register({
      ownershipToken: "same-token",
      identity,
      checkoutKey: "a",
      startedAt: later,
      live: true,
    });
    expect(first.ok).toBe(true);
    const second = registry.register({
      ownershipToken: "same-token",
      identity: { ...identity, attemptId: "attempt-dup-2" },
      checkoutKey: "b",
      startedAt: later,
      live: true,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("isolated_pi_ownership_duplicate");
  });

  it("host setup throw maps to failed and does not leave registry entries", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => matchingResult(context),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => "token-setup",
      resolveCwd: () => {
        throw new Error("ENOENT: cwd gone");
      },
      resolveCheckoutKey: () => {
        throw new Error("ENOENT: cwd gone");
      },
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("isolated_pi_host_setup_failed");
    expect(registry.hasActive()).toBe(false);
  });

  it("rejects handle ownership token mismatch", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-handle-mismatch";
    const transport = createFakeIsolatedPiTransport({
      overrideOwnershipToken: "wrong-handle-token",
      runAttempt: async () => matchingResult(context),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-handle",
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("isolated_pi_handle_ownership_mismatch");
    expect(registry.get(token)).toBeUndefined();
  });

  it("rejects worker ownership token echo mismatch", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-echo";
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => ({
        ...matchingResult(envelope),
        ownershipToken: "echo-wrong",
      }),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-echo",
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_ownership_echo_mismatch")).toBe(true);
    expect(registry.get(token)).toBeUndefined();
  });

  it("createIsolatedPiHost wires dispatch, hasActive, and teardown", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "host dispatch path",
      }),
    });
    const host = createIsolatedPiHost({
      transport,
      resolveCwd: () => "/tmp/host-cwd",
      resolveCheckoutKey: () => "/tmp/host-cwd",
      startedAt: () => later,
      createOwnershipToken: () => "token-host",
      createCurrentSession: () => createCurrentSessionExecutor(async () => ({})),
      // Never kill a real OS process from a seeded registry record.
      isLive: () => false,
    });

    expect(host.executor.id).toBe(ISOLATED_PI_EXECUTOR_ID);
    expect(host.hasActiveProcesses()).toBe(false);

    const settled = await host.dispatchAttempt(
      context,
      new AbortController().signal,
      pureMeta("host"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.summary).toBe("host dispatch path");
    expect(host.hasActiveProcesses()).toBe(false);

    // Seed a live record without a real OS pid. Host teardown must not call process.kill.
    host.registry.register({
      ownershipToken: "token-restore",
      identity: context.identity,
      checkoutKey: "/tmp/host-cwd",
      startedAt: later,
      live: true,
    });
    host.registry.setTerminator("token-restore", async () => {
      // stub terminator — no process to kill
    });
    expect(host.hasActiveProcesses()).toBe(true);
    const teardown = await host.teardownOnRestore({
      kind: "restore",
      reason: "The Pi session reloaded before the isolated Pi attempt completed.",
    });
    expect(teardown.terminatedCount).toBeGreaterThanOrEqual(1);
    expect(host.hasActiveProcesses()).toBe(false);
  });

  it("buildIsolatedPiResultPayload preserves identity and usage", () => {
    const { context } = materializeDefault();
    const payload = buildIsolatedPiResultPayload({
      identity: context.identity,
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note" }],
      summary: "payload builder",
      usage: { turns: 3, totalTokens: 99 },
    });
    expect(payload.familyId).toBe(context.identity.familyId);
    expect(payload.attemptId).toBe(context.identity.attemptId);
    expect(payload.usage).toEqual({ turns: 3, totalTokens: 99 });

    const validated = validateExecutorResult(context, payload);
    expect(validated.ok).toBe(true);
  });

  it("abort before start returns cancelled without starting transport", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => matchingResult(context),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => "token-pre-abort",
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-pre-abort",
    });

    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(context, controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect(result.diagnostics[0]?.code).toBe("isolated_pi_aborted_before_start");
    expect(transport.started).toHaveLength(0);
    expect(registry.hasActive()).toBe(false);
  });

  it("terminateChildProcessTree resolves after signal death without hanging", async () => {
    // Spawn a short-lived process that exits by signal when killed externally.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(child.pid).toBeDefined();

    // Kill from outside so signalCode is set and child.killed stays false.
    process.kill(child.pid!, "SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    // Process already dead by signal. terminate must return promptly.
    const started = Date.now();
    await terminateChildProcessTree(child, { graceMs: 50, forceMs: 50 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("terminateChildProcessTree is bounded when kill is needed", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(child.pid).toBeDefined();
    const started = Date.now();
    await terminateChildProcessTree(child, { graceMs: 20, forceMs: 20 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("host teardown mid-flight maps to interrupted not generic failed", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-host-teardown";
    let releaseRun: (() => void) | undefined;
    let runStarted: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => {
        runStarted?.();
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        return matchingResult(context);
      },
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-host-teardown",
    });

    const executePromise = executor.execute(context, new AbortController().signal);
    await startedGate;
    expect(registry.get(token)).toBeDefined();
    await registry.terminateOwned(token, {
      kind: "restore",
      reason: "The Pi session reloaded before the isolated Pi attempt completed.",
    });
    releaseRun?.();
    const result = await executePromise;
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_host_teardown")).toBe(true);
    expect(result.diagnostics.some((item) => item.location === "hostTeardown.kind:restore")).toBe(true);
    expect(registry.get(token)).toBeUndefined();
  });

  it("killPidBestEffort sends SIGTERM then SIGKILL after grace for live pids", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(child.pid).toBeDefined();
    const started = Date.now();
    await killPidBestEffort(child.pid!, { graceMs: 30, pollMs: 5 });
    expect(Date.now() - started).toBeLessThan(2_000);
    // Process should be gone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      process.kill(child.pid!, 0);
      // If still live, force cleanup for the test process.
      process.kill(child.pid!, "SIGKILL");
    } catch {
      // expected: ESRCH
    }
  });

  it("product dispatchIsolatedPiAttempt uses the bound host", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "product dispatch path",
      }),
      onStart: (options) => {
        // sessionId is synthetic; sessionPath is only set when plumb through.
        expect(options.sessionPath).toBeUndefined();
      },
    });
    const host = createIsolatedPiHost({
      transport,
      resolveCwd: () => "/tmp/product-cwd",
      resolveCheckoutKey: () => "/tmp/product-cwd",
      startedAt: () => later,
      createOwnershipToken: () => "token-product-dispatch",
    });
    bindActiveIsolatedPiHost(host);
    try {
      const settled = await dispatchIsolatedPiAttempt(
        context,
        new AbortController().signal,
        pureMeta("product"),
      );
      expect(settled.ok).toBe(true);
      if (!settled.ok) return;
      expect(settled.result.summary).toBe("product dispatch path");
    } finally {
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("plumbs sessionPath to start options without conflating sessionId", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope, _signal, handle) => {
        expect(handle.sessionId).toMatch(/^session-/);
        return matchingResult(envelope);
      },
      onStart: (options) => {
        expect(options.sessionPath).toBe("/tmp/pi-session-file.json");
        expect(options.piBin).toBe("custom-pi");
        expect(options.env?.CUSTOM).toBe("1");
      },
    });
    const executor = createIsolatedPiExecutor({
      transport,
      createOwnershipToken: () => "token-session-path",
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-session-path",
      resolveSessionPath: () => "/tmp/pi-session-file.json",
      resolvePiBin: () => "custom-pi",
      resolveEnv: () => ({ CUSTOM: "1" }),
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
  });

  it("default checkout key matches resolveCwd; second concurrent execute is blocked", async () => {
    const { context } = materializeDefault();
    // Context may carry a workspace lease; default key must still use resolveCwd.
    const withLease = {
      ...context,
      workspace: { leaseId: "lease-a", baseRevision: "abc" },
    };
    const registry = new IsolatedPiProcessRegistry();
    const startedKeys: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let tokenSeq = 0;
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (envelope) => {
        if (tokenSeq === 1) {
          firstStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return matchingResult(envelope);
      },
      onStart: (options) => {
        startedKeys.push(options.cwd ?? "");
      },
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => `token-cwd-key-${++tokenSeq}`,
      startedAt: () => later,
      resolveCwd: () => "/tmp/shared-cwd",
      // No resolveCheckoutKey: default must use resolveCwd.
    });

    const firstPromise = executor.execute(withLease, new AbortController().signal);
    await firstGate;
    expect(startedKeys[0]).toBe("/tmp/shared-cwd");
    expect(registry.hasActive()).toBe(true);

    // Second execute while first is live on the same cwd must be blocked.
    const second = await executor.execute(
      {
        ...withLease,
        identity: { ...withLease.identity, attemptId: "attempt-work-2" },
        workspace: { leaseId: "lease-b", baseRevision: "def" },
      },
      new AbortController().signal,
    );
    expect(second.outcome).toBe("failed");
    expect(second.diagnostics.some((item) => item.code === "isolated_pi_concurrent_checkout_blocked")).toBe(true);

    releaseFirst?.();
    const first = await firstPromise;
    expect(first.outcome).toBe("submitted");
    expect(registry.hasActive()).toBe(false);
  });

  it("missing Pi binary maps to failed isolated_pi_start_failed without uncaught throw", async () => {
    const { context } = materializeDefault();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const transport = createChildProcessIsolatedPiTransport({
        piBin: "/nonexistent/hypagraph-pi-binary-for-test",
        requireBinary: true,
      });
      const executor = createIsolatedPiExecutor({
        transport,
        createOwnershipToken: () => "token-missing-bin",
        startedAt: () => later,
        resolveCheckoutKey: () => "/tmp/checkout-missing-bin",
      });
      const result = await executor.execute(context, new AbortController().signal);
      // Allow any deferred ENOENT to surface under the error listener.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(result.outcome).toBe("failed");
      expect(result.diagnostics.some((item) => item.code === "isolated_pi_start_failed")).toBe(true);
      expect(result.attemptId).toBe(context.identity.attemptId);
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("spawn-window host teardown preserves restore kind as interrupted", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-spawn-teardown";
    let startCount = 0;
    const transport = createFakeIsolatedPiTransport({
      onStart: async (options) => {
        startCount += 1;
        // Host tears down during the spawn window (after register, during start).
        await registry.terminateOwned(options.ownershipToken, {
          kind: "restore",
          reason: "The Pi session reloaded before the isolated Pi attempt completed.",
        });
      },
      runAttempt: async () => matchingResult(context),
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-spawn-teardown",
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(startCount).toBe(1);
    // update() after start must use the real tombstone kind (restore → interrupted).
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_host_teardown")).toBe(true);
    expect(result.diagnostics.some((item) => item.location === "hostTeardown.kind:restore")).toBe(true);
    expect(result.diagnostics.some((item) =>
      item.message.includes("session reloaded"),
    )).toBe(true);
  });

  it("dispatchAttempt maps non-isolated profile throws to ok:false diagnostics", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => matchingResult(context),
    });
    const host = createIsolatedPiHost({
      transport,
      resolveCwd: () => "/tmp/dispatch-route",
      resolveCheckoutKey: () => "/tmp/dispatch-route",
      startedAt: () => later,
      // No createCurrentSession: routing current-session throws.
    });
    const acpContext = {
      ...context,
      profile: { profileId: "acp-default", kind: "acp" as const },
    };
    const settled = await host.dispatchAttempt(
      acpContext,
      new AbortController().signal,
      pureMeta("route"),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.diagnostics.some((item) => item.code === "isolated_pi_profile_route_failed")).toBe(true);
  });

  it("executeAndSettleIsolatedPi unwraps CurrentSessionExecutorValidationError diagnostics", async () => {
    const { context } = materializeDefault();
    const sessionContext = {
      ...context,
      profile: CURRENT_SESSION_PROFILE,
    };
    const executor = createCurrentSessionExecutor(async () => "raw text is not a result");
    const settled = await executeAndSettleIsolatedPi(
      executor,
      sessionContext,
      new AbortController().signal,
      pureMeta("cs-validate"),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.diagnostics[0]?.code).toBe("executor_result_raw_text");
    expect(settled.diagnostics.some((item) => item.code === "isolated_pi_execute_threw")).toBe(false);
  });

  it("executeAndSettleIsolatedPi maps CurrentSessionExecutorAbortError to cancelled settlement", async () => {
    const { context } = materializeDefault();
    const sessionContext = {
      ...context,
      profile: CURRENT_SESSION_PROFILE,
    };
    const executor = createCurrentSessionExecutor(async () => matchingResult(context));
    const controller = new AbortController();
    controller.abort();
    const settled = await executeAndSettleIsolatedPi(
      executor,
      sessionContext,
      controller.signal,
      pureMeta("cs-abort"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.outcome).toBe("cancelled");
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("dispatchAttempt routes current-session through typed settle path", async () => {
    const { context } = materializeDefault();
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async () => matchingResult(context),
    });
    const host = createIsolatedPiHost({
      transport,
      resolveCwd: () => "/tmp/cs-route",
      resolveCheckoutKey: () => "/tmp/cs-route",
      startedAt: () => later,
      createCurrentSession: () => createCurrentSessionExecutor(async () => "raw text"),
    });
    const sessionContext = {
      ...context,
      profile: CURRENT_SESSION_PROFILE,
    };
    const settled = await host.dispatchAttempt(
      sessionContext,
      new AbortController().signal,
      pureMeta("cs-host"),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    // Typed validation diagnostics preserved (not isolated_pi_execute_threw).
    expect(settled.diagnostics[0]?.code).toBe("executor_result_raw_text");
  });

  it("abort race prefers host restore tombstone over plain cancelled", async () => {
    const { context } = materializeDefault();
    const registry = new IsolatedPiProcessRegistry();
    const token = "token-abort-tombstone";
    let releaseRun: (() => void) | undefined;
    let runStarted: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const transport = createFakeIsolatedPiTransport({
      runAttempt: async (_context, signal) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          releaseRun = () => {
            // Leave run pending until abort fires; then reject as session loss.
            reject(new IsolatedPiSessionLostError("aborted after host teardown"));
          };
          signal.addEventListener("abort", () => {
            releaseRun?.();
          }, { once: true });
        });
        return matchingResult(context);
      },
    });
    const executor = createIsolatedPiExecutor({
      transport,
      registry,
      createOwnershipToken: () => token,
      startedAt: () => later,
      resolveCheckoutKey: () => "/tmp/checkout-abort-tombstone",
    });
    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await startedGate;
    await registry.terminateOwned(token, {
      kind: "restore",
      reason: "The Pi session reloaded before the isolated Pi attempt completed.",
    });
    controller.abort();
    const result = await executePromise;
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_host_teardown")).toBe(true);
    expect(result.diagnostics.some((item) => item.location === "hostTeardown.kind:restore")).toBe(true);
  });

  it("real child_process transport speaks Pi RPC prompt and agent_settled flow", async () => {
    const { context } = materializeDefault();
    const untrusted = matchingResult(context, {
      summary: "echo child_process transport result",
    });
    // Mock Pi RPC worker: accept prompt, emit agent_settled, return structured JSON via
    // get_last_assistant_text. This is the supported Pi RPC protocol shape.
    const workerSource = [
      "let buf='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(c)=>{buf+=c;",
      "while(true){const i=buf.indexOf('\\n');if(i<0)return;",
      "const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;",
      "const req=JSON.parse(line);",
      "const write=(obj)=>process.stdout.write(JSON.stringify(obj)+'\\n');",
      "if(req.type==='prompt'){",
      "write({id:req.id,type:'response',command:'prompt',success:true});",
      "write({type:'agent_start'});",
      "write({type:'agent_settled'});",
      "} else if(req.type==='get_last_assistant_text'){",
      `const result=${JSON.stringify(untrusted)};`,
      "write({id:req.id,type:'response',command:'get_last_assistant_text',success:true,",
      "data:{text:JSON.stringify(result)}});",
      "} else if(req.type==='abort'){",
      "write({id:req.id,type:'response',command:'abort',success:true});",
      "}",
      "}});",
    ].join("");
    const transport = createChildProcessIsolatedPiTransport({
      piBin: process.execPath,
      args: ["-e", workerSource],
      requireBinary: true,
    });
    const executor = createIsolatedPiExecutor({
      transport,
      createOwnershipToken: () => "token-echo-rpc",
      startedAt: () => later,
      resolveCheckoutKey: () => process.cwd(),
      resolveCwd: () => process.cwd(),
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("echo child_process transport result");
    expect(result.attemptId).toBe(context.identity.attemptId);
  });

  it("buildIsolatedPiRpcPrompt and extractStructuredResultFromAssistantText cover protocol shape", () => {
    const { context } = materializeDefault();
    const prompt = buildIsolatedPiRpcPrompt(context, "token-protocol");
    expect(prompt).toContain("Hypagraph isolated executor attempt.");
    expect(prompt).toContain("token-protocol");
    expect(prompt).toContain(context.identity.attemptId);
    expect(prompt).toContain('"resultProtocol"');

    const result = matchingResult(context, { summary: "from assistant text" });
    const plain = extractStructuredResultFromAssistantText(JSON.stringify(result));
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect((plain.value as { summary: string }).summary).toBe("from assistant text");
    }

    const fenced = extractStructuredResultFromAssistantText(
      `Here is the result:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`,
    );
    expect(fenced.ok).toBe(true);

    const raw = extractStructuredResultFromAssistantText("the model finished successfully");
    expect(raw.ok).toBe(false);
  });

  it("JsonlUtf8LineReader preserves multi-byte UTF-8 characters split across chunks", () => {
    // Euro sign is three bytes: E2 82 AC. Split after the first byte.
    const euro = Buffer.from("€", "utf8");
    expect(euro.length).toBe(3);
    const line = Buffer.concat([
      Buffer.from('{"type":"message","text":"', "utf8"),
      euro,
      Buffer.from('"}\n', "utf8"),
    ]);
    const first = line.subarray(0, line.indexOf(euro) + 1);
    const second = line.subarray(first.length);

    const reader = new JsonlUtf8LineReader();
    expect(reader.push(first)).toEqual([]);
    const lines = reader.push(second);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { type: string; text: string };
    expect(parsed.type).toBe("message");
    expect(parsed.text).toBe("€");
  });

  it("real child_process mid-exit maps to interrupted session loss", async () => {
    const { context } = materializeDefault();
    // Worker exits immediately after start without writing a result.
    const workerSource = "process.stdin.resume(); setTimeout(() => process.exit(7), 20);";
    const transport = createChildProcessIsolatedPiTransport({
      piBin: process.execPath,
      args: ["-e", workerSource],
      requireBinary: true,
      terminateGraceMs: 50,
      terminateForceMs: 50,
    });
    const executor = createIsolatedPiExecutor({
      transport,
      createOwnershipToken: () => "token-mid-exit",
      startedAt: () => later,
      resolveCheckoutKey: () => process.cwd(),
      resolveCwd: () => process.cwd(),
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "isolated_pi_session_lost")).toBe(true);
    expect(result.attemptId).toBe(context.identity.attemptId);
  });

  it("terminateAll without in-flight execute does not retain hostTeardown tombstones", async () => {
    const registry = new IsolatedPiProcessRegistry();
    const identity: ExecutorAttemptIdentity = {
      familyId: "family-s8",
      goalId: "goal-root",
      workflowId: "workflow-root",
      revision: 1,
      nodeId: "work",
      attemptId: "attempt-tombstone-age",
    };
    registry.register({
      ownershipToken: "token-age",
      identity,
      checkoutKey: "/tmp/age",
      startedAt: later,
      live: true,
    });
    registry.setTerminator("token-age", async () => {});
    await registry.terminateAll({
      kind: "user",
      reason: "User cancelled with no in-flight execute.",
    });
    // Token can be re-registered after teardown when no execute was watching.
    const reReg = registry.register({
      ownershipToken: "token-age",
      identity,
      checkoutKey: "/tmp/age-2",
      startedAt: later,
      live: true,
    });
    expect(reReg.ok).toBe(true);
    registry.unregister("token-age");
  });
});

