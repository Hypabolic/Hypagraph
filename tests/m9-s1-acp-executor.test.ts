import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
  ACP_EXECUTOR_ID,
  ACP_EXECUTOR_VERSION,
  ACP_PROFILE,
  AcpSessionLostError,
  AcpSessionRegistry,
  buildAcpResultPayload,
  clampAcpDiagnostics,
  createAcpExecutor,
  createChildProcessAcpTransport,
  createFakeAcpTransport,
  executeAndSettleAcp,
  extractStructuredResultFromAgentText,
  makeTransportSignal,
  materializeAcpContext,
  mergeTruncationDiagnostic,
  normalizeAcpUsage,
  parseAcpAgentReply,
  resolveDefaultPermissionOutcome,
  resultFromAcpContext,
  settleAcpResult,
  type AcpProgressEvent,
  type AcpSpawnedProcess,
} from "../src/pi/acp-executor.js";
import { JsonlUtf8LineReader } from "../src/pi/child-process-jsonrpc.js";
import {
  bindActiveIsolatedPiHost,
  createFakeIsolatedPiTransport,
  createIsolatedPiHost,
  createNodeExecutorForProfile,
  dispatchIsolatedPiAttempt,
  ISOLATED_PI_PROFILE,
} from "../src/pi/isolated-pi-executor.js";

const at = "2026-07-30T10:00:00.000Z";
const later = "2026-07-30T10:05:00.000Z";

const profile = ACP_PROFILE;

const chainDefinition = (): HypagraphDefinition => ({
  title: "ACP executor fixture",
  goal: "Ship ACP settlement",
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
    familyId: "family-m9-s1",
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
    familyId: "family-m9-s1",
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
  summary: "Work completed with a structured ACP result.",
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

describe("m9-s1 ACP executor", () => {
  it("materializeAcpContext uses profile kind acp", () => {
    const base = createFamilyAndState();
    const materialized = materializeAcpContext({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.profile).toEqual(ACP_PROFILE);
    expect(materialized.value.profile.kind).toBe("acp");
    expect(materialized.value.identity.attemptId).toBe("attempt-work-1");

    const hashA = hashExecutorContext(materialized.value);
    const hashB = hashExecutorContext(materialized.value);
    expect(hashA).toBe(hashB);
  });

  it("happy path: successful attempt returns validated ExecutorResult and settles", async () => {
    const { context, state } = materializeDefault();
    const registry = new AcpSessionRegistry();
    const token = "token-happy";
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false },
      },
    });
    const executor = createAcpExecutor({
      transport,
      registry,
      createSessionToken: () => token,
      startedAt: () => later,
    });

    expect(executor.id).toBe(ACP_EXECUTOR_ID);
    expect(executor.version).toBe(ACP_EXECUTOR_VERSION);
    expect(context.profile.kind).toBe("acp");

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.usage.totalTokens).toBe(40);
    expect(registry.get(token)).toBeUndefined();
    expect(registry.hasActive()).toBe(false);
    expect(transport.opened).toHaveLength(1);
    expect(transport.closes.length).toBeGreaterThan(0);

    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);

    const settled = await executeAndSettleAcp(
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

    const next = applyCommands(state, settled.commands);
    expect(next.runtime.facts["work.done"]?.value).toBe(true);
    expect(next.runtime.nodes.work?.status).toBe("awaiting_evidence");
  });

  it("pre-start abort returns cancelled with identity", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createAcpExecutor({ transport });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(context, controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "acp_aborted_before_start")).toBe(true);
    expect(transport.opened).toHaveLength(0);

    const settled = settleAcpResult(context, result, pureMeta("preabort"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]).toMatchObject({
      type: "cancel-attempt",
      attemptId: "attempt-work-1",
    });
  });

  it("mid-run cancel returns cancelled and cancels the session", async () => {
    const { context } = materializeDefault();
    const registry = new AcpSessionRegistry();
    const token = "token-cancel";
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });

    const transport = createFakeAcpTransport({
      runAttempt: async (_context, signal) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new AcpSessionLostError("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new AcpSessionLostError("aborted during run"));
          }, { once: true });
        });
        return matchingResult(_context);
      },
    });

    const executor = createAcpExecutor({
      transport,
      registry,
      createSessionToken: () => token,
      startedAt: () => later,
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await runGate;
    controller.abort();

    const result = await executePromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "acp_cancelled")).toBe(true);
    // Cancel must be observed independently of the always-on close in finally.
    expect(transport.cancels).toHaveLength(1);
    expect(transport.closes.length).toBeGreaterThan(0);
    expect(transport.cancels[0]?.sessionId).toBe(transport.closes[0]?.sessionId);
    expect(registry.get(token)).toBeUndefined();

    const settled = settleAcpResult(context, result, pureMeta("cancel"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]).toMatchObject({
      type: "cancel-attempt",
      attemptId: "attempt-work-1",
    });
  });

  it("session loss mid-run returns interrupted with context identity", async () => {
    const { context, family, state } = materializeDefault();
    const registry = new AcpSessionRegistry();
    const token = "token-lost";
    const familyBefore = structuredClone(family);
    const stateBefore = structuredClone(state);

    const transport = createFakeAcpTransport({
      runAttempt: async () => {
        throw new AcpSessionLostError(
          "The ACP agent process exited during the attempt.",
        );
      },
    });

    const executor = createAcpExecutor({
      transport,
      registry,
      createSessionToken: () => token,
      startedAt: () => later,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.goalId).toBe(context.identity.goalId);
    expect(result.workflowId).toBe(context.identity.workflowId);
    expect(result.revision).toBe(context.identity.revision);
    expect(result.nodeId).toBe(context.identity.nodeId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "acp_session_lost")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    expect(family).toEqual(familyBefore);
    expect(state).toEqual(stateBefore);

    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);

    const settled = settleExecutorResult(context, result, pureMeta("lost"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands).toHaveLength(1);
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("untrusted invalid payload returns failed with diagnostics and does not throw", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async () => ({
        // Missing required identity and shape fields.
        outcome: "submitted",
        summary: "not a full executor result",
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-invalid",
      startedAt: () => later,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // Must not throw; diagnostics carry validation failures.
    expect(result.diagnostics.some((item) =>
      item.code.startsWith("executor_result_") || item.code === "acp_invalid_agent_result",
    )).toBe(true);

    const settled = settleAcpResult(context, result, pureMeta("invalid"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("raw text-only agent reply is not accepted as submitted success", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async () => "the model finished successfully with only text",
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-raw",
      startedAt: () => later,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "acp_invalid_agent_result")).toBe(true);
  });

  it("stale mismatched identity from agent is rewritten to failed with context identity", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => ({
        ...matchingResult(envelope),
        attemptId: "attempt-stale-other",
        familyId: "family-other",
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-stale",
      startedAt: () => later,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "executor_result_identity_mismatch")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "acp_stale_result")).toBe(true);
  });

  it("progress streaming callback is invoked for session/update events", async () => {
    const { context } = materializeDefault();
    const progressEvents: AcpProgressEvent[] = [];
    const transport = createFakeAcpTransport({
      progressEvents: [
        {
          kind: "agent_message_chunk",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working..." },
          },
        },
        {
          kind: "tool_call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "read file",
            status: "pending",
          },
        },
      ],
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "completed after progress",
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-progress",
      startedAt: () => later,
      onProgress: (event) => {
        progressEvents.push(event);
      },
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0]?.kind).toBe("agent_message_chunk");
    expect(progressEvents[1]?.kind).toBe("tool_call");
    expect(progressEvents[0]?.sessionId).toBeTruthy();
    expect(progressEvents[0]?.atSequence).toBe(1);
  });

  it("createNodeExecutorForProfile routes acp and errors when options.acp is missing", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "routed through profile factory",
      }),
    });

    const executor = createNodeExecutorForProfile(ACP_PROFILE, {
      acp: {
        transport,
        createSessionToken: () => "token-route",
        startedAt: () => later,
      },
    });

    expect(executor.id).toBe(ACP_EXECUTOR_ID);
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.summary).toBe("routed through profile factory");
    expect(result.outcome).toBe("submitted");

    expect(() => createNodeExecutorForProfile(ACP_PROFILE, {})).toThrow(
      /options\.acp/,
    );
  });

  it("settle path accepts ACP results via settleExecutorResult", async () => {
    const { context, state } = materializeDefault();
    const payload = buildAcpResultPayload({
      identity: context.identity,
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note", summary: "ok" }],
      summary: "settled ACP result",
      usage: { turns: 1 },
    });

    const settled = settleExecutorResult(context, payload, pureMeta("settle"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.outcome).toBe("submitted");
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);

    const next = applyCommands(state, settled.commands);
    expect(next.runtime.facts["work.done"]?.value).toBe(true);

    // Cancelled ACP result also settles.
    const cancelled = resultFromAcpContext(context, "cancelled", [{
      code: "acp_cancelled",
      message: "cancelled for settle test",
    }]);
    const cancelSettled = settleExecutorResult(context, cancelled, pureMeta("settle-cancel"));
    expect(cancelSettled.ok).toBe(true);
    if (!cancelSettled.ok) return;
    expect(cancelSettled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("completed result wins when result settles before abort is observed", async () => {
    const { context } = materializeDefault();
    let releaseResult: ((value: unknown) => void) | undefined;
    const transport = createFakeAcpTransport({
      runAttempt: async () => new Promise((resolve) => {
        releaseResult = resolve;
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-race",
      startedAt: () => later,
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseResult).toBeTypeOf("function");
    releaseResult?.(matchingResult(context, { summary: "completed before cancel wins" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await executePromise;
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("completed before cancel wins");
  });

  it("cancel-versus-result race: simultaneous release and abort still accepts completed result when race settles result first", async () => {
    // Contract: Promise.race accepts whichever microtask wins. When runAttempt
    // resolves in the same turn as abort, the result branch is preferred if it
    // is already settled before the abort listener fires into the race.
    const { context } = materializeDefault();
    let releaseResult: ((value: unknown) => void) | undefined;
    const transport = createFakeAcpTransport({
      runAttempt: async () => new Promise((resolve) => {
        releaseResult = resolve;
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-race-simultaneous",
      startedAt: () => later,
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseResult).toBeTypeOf("function");
    // No await between release and abort — exercises simultaneous settlement.
    releaseResult?.(matchingResult(context, { summary: "simultaneous race" }));
    controller.abort();
    const result = await executePromise;
    // Result must not throw. Accept either submitted (result won) or cancelled
    // (abort won) depending on microtask ordering; identity is always preserved.
    expect(["submitted", "cancelled"]).toContain(result.outcome);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    if (result.outcome === "submitted") {
      expect(result.summary).toBe("simultaneous race");
    } else {
      expect(result.diagnostics.some((item) => item.code === "acp_cancelled")).toBe(true);
    }
  });

  it("open session failure maps to failed with identity from context", async () => {
    const { context } = materializeDefault();
    const registry = new AcpSessionRegistry();
    const token = "token-open-fail";
    const transport = createFakeAcpTransport({
      failOpen: "ACP agent binary not found",
      runAttempt: async () => matchingResult(context),
    });
    const executor = createAcpExecutor({
      transport,
      registry,
      createSessionToken: () => token,
      startedAt: () => later,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "acp_open_session_failed")).toBe(true);
    expect(result.diagnostics[0]?.message).toContain("ACP agent binary not found");
    expect(registry.get(token)).toBeUndefined();
  });

  it("each attempt opens its own ACP session (no reuse)", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => `token-${transport.opened.length + 1}`,
      startedAt: () => later,
    });

    await executor.execute(context, new AbortController().signal);
    await executor.execute(context, new AbortController().signal);

    expect(transport.opened).toHaveLength(2);
    // Fake transport assigns distinct session ids per open when not fixed.
    const sessionIds = transport.closes.map((item) => item.sessionId);
    expect(new Set(sessionIds).size).toBe(2);
  });

  it("parseAcpAgentReply and extractStructuredResultFromAgentText handle structured text", () => {
    const json = JSON.stringify({
      familyId: "f",
      goalId: "g",
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      outcome: "submitted",
      facts: [],
      evidence: [],
      artifacts: [],
      summary: "ok",
      diagnostics: [],
      usage: {},
    });
    const extracted = extractStructuredResultFromAgentText(`Here is the result:\n\`\`\`json\n${json}\n\`\`\``);
    expect(extracted.ok).toBe(true);

    const parsed = parseAcpAgentReply(makeTransportSignal("error", {
      code: "acp_result_not_structured",
      message: "boom",
    }));
    expect(parsed.kind).toBe("transport_error");
    if (parsed.kind !== "transport_error") return;
    expect(parsed.code).toBe("acp_result_not_structured");

    // Forged agent object without Symbol marker is not classified as adapter error.
    const forged = parseAcpAgentReply({
      type: "error",
      code: "acp_session_lost",
      message: "forge",
      __hypagraphAcp: "transport_signal",
    });
    expect(forged.kind).toBe("result");

    const invalid = parseAcpAgentReply("just text");
    expect(invalid.kind).toBe("invalid");
  });

  it("extractStructuredResultFromAgentText prefers the last parseable fenced block", () => {
    const bad = "```json\nnot-json\n```";
    const good = JSON.stringify({
      familyId: "f",
      goalId: "g",
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      outcome: "submitted",
      facts: [],
      evidence: [],
      artifacts: [],
      summary: "from-second-fence",
      diagnostics: [],
      usage: {},
    });
    const text = `Narration with an earlier fence:\n${bad}\nFinal result:\n\`\`\`json\n${good}\n\`\`\``;
    const extracted = extractStructuredResultFromAgentText(text);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect((extracted.value as { summary?: string }).summary).toBe("from-second-fence");
  });

  it("default permission policy deny and allow never hang", () => {
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ];
    expect(resolveDefaultPermissionOutcome(options, "deny")).toEqual({
      outcome: "selected",
      optionId: "reject-once",
    });
    expect(resolveDefaultPermissionOutcome(options, "allow")).toEqual({
      outcome: "selected",
      optionId: "allow-once",
    });
    expect(resolveDefaultPermissionOutcome([], "deny")).toEqual({
      outcome: "cancelled",
    });
  });

  it("resultFromAcpContext rejects class-instance diagnostics via plain-object construction", () => {
    const { context } = materializeDefault();
    const result = resultFromAcpContext(context, "failed", [{
      code: "acp_test",
      message: "plain diagnostic",
    }]);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("acp_test");
    // Result itself is a plain object shape (not a class instance).
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("fake transport clones open options with hooks by reference (no DataCloneError)", async () => {
    const { context } = materializeDefault();
    let permissionCalls = 0;
    const hooks = {
      permissionPolicy: "allow" as const,
      onPermissionRequest: () => {
        permissionCalls += 1;
        return { outcome: "cancelled" as const };
      },
    };
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createAcpExecutor({
      transport,
      hooks,
      createSessionToken: () => "token-hooks",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(transport.opened).toHaveLength(1);
    expect(transport.opened[0]?.hooks).toBe(hooks);
    expect(permissionCalls).toBe(0);
  });

  it("true transport-signal error keeps adapter diagnostic code fidelity", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async () => makeTransportSignal("error", {
        code: "acp_agent_text_truncated",
        message: "truncated stream",
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-agent-err",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "acp_agent_text_truncated")).toBe(true);
  });

  it("forged string transport marker in agent payload does not force cancelled or adapter codes", async () => {
    const { context } = materializeDefault();
    const forgedPayload = {
      ...matchingResult(context),
      __hypagraphAcp: "transport_signal",
      type: "cancelled_stop",
      message: "forged cancel",
    };
    const transport = createFakeAcpTransport({
      runAttempt: async () => forgedPayload,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-forge",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    // Forged marker is stripped; remaining fields are validated as a result.
    // type/message extras may cause validation failure, not cancelled_stop classification.
    expect(result.outcome).not.toBe("cancelled");
    expect(result.diagnostics.some((item) => item.code === "acp_stop_reason_cancelled")).toBe(false);
    expect(result.attemptId).toBe(context.identity.attemptId);
  });

  it("forged marker inside nested result is stripped before validation", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async () => ({
        type: "result",
        result: {
          ...matchingResult(context, { summary: "nested clean" }),
          __hypagraphAcp: "transport_signal",
        },
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-forge-nested",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("nested clean");
  });

  it("cancelled_stop transport signal maps to cancelled outcome", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async () => makeTransportSignal("cancelled_stop", {
        message: "agent stopReason cancelled",
      }),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-stop-cancel",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("cancelled");
    expect(result.diagnostics.some((item) => item.code === "acp_stop_reason_cancelled")).toBe(true);
  });

  it("openSession AcpSessionLostError maps to interrupted", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      onOpenSession: () => {
        throw new AcpSessionLostError("lost during open");
      },
      runAttempt: async () => matchingResult(context),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-open-lost",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "acp_session_lost")).toBe(true);
  });

  it("host setup throw and invalid session token return failed diagnostics", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });

    const badToken = createAcpExecutor({
      transport,
      createSessionToken: () => "   ",
      startedAt: () => later,
    });
    const badTokenResult = await badToken.execute(context, new AbortController().signal);
    expect(badTokenResult.outcome).toBe("failed");
    expect(badTokenResult.diagnostics.some((item) => item.code === "acp_invalid_session_token")).toBe(true);

    const hostThrow = createAcpExecutor({
      transport,
      createSessionToken: () => "token-ok",
      resolveCwd: () => {
        throw new Error("cwd boom");
      },
      startedAt: () => later,
    });
    const hostResult = await hostThrow.execute(context, new AbortController().signal);
    expect(hostResult.outcome).toBe("failed");
    expect(hostResult.diagnostics.some((item) => item.code === "acp_host_setup_failed")).toBe(true);

    const startedAtThrow = createAcpExecutor({
      transport,
      createSessionToken: () => "token-ok-2",
      startedAt: () => {
        throw new Error("clock boom");
      },
    });
    const startedAtResult = await startedAtThrow.execute(context, new AbortController().signal);
    expect(startedAtResult.outcome).toBe("failed");
    expect(startedAtResult.diagnostics.some((item) => item.code === "acp_host_setup_failed")).toBe(true);
  });

  it("duplicate session token registration fails with distinct code", async () => {
    const { context } = materializeDefault();
    const registry = new AcpSessionRegistry();
    const first = registry.register({
      sessionToken: "dup",
      identity: context.identity,
      live: true,
      startedAt: later,
    });
    expect(first.ok).toBe(true);
    const second = registry.register({
      sessionToken: "dup",
      identity: context.identity,
      live: true,
      startedAt: later,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("acp_session_token_duplicate");
  });

  it("materializeAcpContext rejects incomplete inputs", () => {
    const base = createFamilyAndState();
    const missingNode = materializeAcpContext({
      family: base.family,
      state: base.state,
      nodeId: "",
      attemptId: "a1",
    });
    expect(missingNode.ok).toBe(false);
    if (missingNode.ok) return;
    expect(missingNode.diagnostics[0]?.code).toBe("acp_invalid_node");

    const missingAttempt = materializeAcpContext({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "",
    });
    expect(missingAttempt.ok).toBe(false);
    if (missingAttempt.ok) return;
    expect(missingAttempt.diagnostics[0]?.code).toBe("acp_invalid_attempt");
  });

  it("clampAcpDiagnostics and normalizeAcpUsage bound outputs", () => {
    const clamped = clampAcpDiagnostics(
      [
        { code: "a", message: "1" },
        { code: "b", message: "2" },
        { code: "c", message: "3" },
      ],
      2,
    );
    expect(clamped).toHaveLength(2);
    expect(clamped[1]?.code).toBe("acp_diagnostics_truncated");
    expect(clampAcpDiagnostics([{ code: "a", message: "1" }], 0)).toEqual([]);

    expect(normalizeAcpUsage({ turns: 1, totalTokens: -1, junk: true })).toEqual({ turns: 1 });
    expect(normalizeAcpUsage("nope")).toEqual({});
  });

  it("progress callback throw does not break the attempt", async () => {
    const { context } = materializeDefault();
    const transport = createFakeAcpTransport({
      progressEvents: [{
        kind: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
      }],
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-progress-throw",
      startedAt: () => later,
      onProgress: () => {
        throw new Error("progress boom");
      },
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
  });

  it("profile mismatch returns acp_profile_mismatch without opening a session", async () => {
    const base = createFamilyAndState();
    const wrong = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile: ISOLATED_PI_PROFILE,
    });
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;

    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope),
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-mismatch",
      startedAt: () => later,
    });
    const result = await executor.execute(wrong.value, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "acp_profile_mismatch")).toBe(true);
    expect(transport.opened).toHaveLength(0);

    const settled = await executeAndSettleAcp(
      executor,
      wrong.value,
      new AbortController().signal,
      pureMeta("mismatch"),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.diagnostics[0]?.code).toBe("acp_profile_mismatch");
  });

  it("createIsolatedPiHost routes acp and shares registry for teardown", async () => {
    const { context } = materializeDefault();
    const acpRegistry = new AcpSessionRegistry();
    const acpTransport = createFakeAcpTransport({
      runAttempt: async (envelope) => matchingResult(envelope, {
        summary: "host-dispatched acp",
      }),
    });
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async (envelope) => matchingResult(envelope),
      }),
      acp: {
        transport: acpTransport,
        registry: acpRegistry,
        createSessionToken: () => "host-acp-token",
        startedAt: () => later,
      },
      startedAt: () => later,
    });

    expect(host.acpRegistry).toBe(acpRegistry);
    const acpExecutor = host.resolveNodeExecutor(ACP_PROFILE);
    expect(acpExecutor.id).toBe(ACP_EXECUTOR_ID);

    // Pre-register a live session so active checks and teardown see ACP state.
    expect(acpRegistry.register({
      sessionToken: "pre-live",
      identity: context.identity,
      live: true,
      startedAt: later,
      sessionId: "sess-pre",
    }).ok).toBe(true);
    let closerCalled = false;
    acpRegistry.setCloser("pre-live", async () => {
      closerCalled = true;
    });
    expect(host.hasActiveProcesses()).toBe(true);
    expect(host.activeProcessCount()).toBeGreaterThan(0);

    const teardown = await host.teardownOnRestore({
      reason: "restore",
      kind: "restore",
    });
    expect(teardown.acpClosedCount).toBe(1);
    expect(closerCalled).toBe(true);
    expect(host.hasActiveProcesses()).toBe(false);

    const settled = await host.dispatchAttempt(
      context,
      new AbortController().signal,
      pureMeta("host-acp-ok"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.summary).toBe("host-dispatched acp");
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);
  });

  it("resultFromAcpContext clamps oversized summary and empty diagnostics bound", () => {
    const { context } = materializeDefault();
    const oversized = "x".repeat((context.resultProtocol.maxSummaryChars ?? 4096) + 50);
    const result = resultFromAcpContext(context, "failed", [{
      code: "acp_test",
      message: "m",
    }], oversized);
    expect(result.summary.length).toBeLessThanOrEqual(context.resultProtocol.maxSummaryChars);

    const zeroDiagContext = {
      ...context,
      resultProtocol: {
        ...context.resultProtocol,
        maxDiagnostics: 0,
      },
    };
    const empty = resultFromAcpContext(zeroDiagContext, "failed", [{
      code: "acp_test",
      message: "m",
    }]);
    expect(empty.diagnostics).toEqual([]);
  });

  it("JsonlUtf8LineReader flushes final line without trailing newline", () => {
    const reader = new JsonlUtf8LineReader();
    expect(reader.push(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(reader.flushIncludingPending()).toEqual(['{"b":']);
  });

  it("child-process transport: scripted duplex initialize, session/new, prompt, permission deny", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      authMethods: [],
      onPermission: (params) => {
        // Expect default deny path to respond; scripted agent just continues.
        void params;
      },
      agentText: JSON.stringify(matchingResult(context)),
    });

    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });

    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-stdio",
      startedAt: () => later,
      openRequestTimeoutMs: 5_000,
    });

    // Trigger a permission request mid-prompt from the scripted agent.
    scripted.requestPermissionOnce = true;
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(scripted.receivedMethods).toContain("initialize");
    expect(scripted.receivedMethods).toContain("session/new");
    expect(scripted.receivedMethods).toContain("session/prompt");
  });

  it("child-process transport: protocol mismatch and missing sessionId fail open", async () => {
    const { context } = materializeDefault();

    const badVersion = createScriptedAcpProcess({
      protocolVersion: 99,
      agentText: "{}",
    });
    const transportBadVersion = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => badVersion.process,
      openRequestTimeoutMs: 2_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const exec1 = createAcpExecutor({
      transport: transportBadVersion,
      createSessionToken: () => "token-ver",
      startedAt: () => later,
    });
    const r1 = await exec1.execute(context, new AbortController().signal);
    expect(r1.outcome).toBe("failed");
    expect(r1.diagnostics.some((item) => item.code === "acp_open_session_failed")).toBe(true);

    const noSession = createScriptedAcpProcess({
      omitSessionId: true,
      agentText: "{}",
    });
    const transportNoSession = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => noSession.process,
      openRequestTimeoutMs: 2_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const exec2 = createAcpExecutor({
      transport: transportNoSession,
      createSessionToken: () => "token-sess",
      startedAt: () => later,
    });
    const r2 = await exec2.execute(context, new AbortController().signal);
    expect(r2.outcome).toBe("failed");
    expect(r2.diagnostics.some((item) => item.code === "acp_open_session_failed")).toBe(true);
  });

  it("child-process transport: auth required without hook and stdout without trailing newline", async () => {
    const { context } = materializeDefault();

    const authRequired = createScriptedAcpProcess({
      authMethods: [{ id: "token" }],
      agentText: JSON.stringify(matchingResult(context)),
    });
    const transportAuth = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => authRequired.process,
      openRequestTimeoutMs: 2_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const execAuth = createAcpExecutor({
      transport: transportAuth,
      createSessionToken: () => "token-auth",
      startedAt: () => later,
    });
    const rAuth = await execAuth.execute(context, new AbortController().signal);
    expect(rAuth.outcome).toBe("failed");
    expect(rAuth.diagnostics.some((item) => item.code === "acp_authentication_required")).toBe(true);

    const noNl = createScriptedAcpProcess({
      agentText: JSON.stringify(matchingResult(context, { summary: "no trailing nl" })),
      omitTrailingNewlineOnLastResponse: true,
    });
    const transportNl = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => noNl.process,
      openRequestTimeoutMs: 2_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const execNl = createAcpExecutor({
      transport: transportNl,
      createSessionToken: () => "token-nl",
      startedAt: () => later,
    });
    const rNl = await execNl.execute(context, new AbortController().signal);
    expect(rNl.outcome).toBe("submitted");
    expect(rNl.summary).toBe("no trailing nl");
  });

  it("registry closeAll and list helpers work", async () => {
    const registry = new AcpSessionRegistry();
    const identity: ExecutorAttemptIdentity = {
      familyId: "f",
      goalId: "g",
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
    };
    expect(registry.register({
      sessionToken: "t1",
      identity,
      live: true,
      startedAt: later,
      sessionId: "s1",
    }).ok).toBe(true);
    let closed = false;
    registry.setCloser("t1", async () => {
      closed = true;
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.hasActive()).toBe(true);
    expect(registry.activeCount()).toBe(1);
    expect(await registry.closeAll({ reason: "teardown", kind: "user" })).toBe(1);
    expect(closed).toBe(true);
    expect(registry.hasActive()).toBe(false);
  });

  it("host teardown tombstone maps restore to interrupted and user to cancelled", async () => {
    const { context } = materializeDefault();
    const registry = new AcpSessionRegistry();
    let openGate: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let releaseRun: (() => void) | undefined;
    const transport = createFakeAcpTransport({
      onOpenSession: async () => {
        openGate?.();
      },
      runAttempt: async () => new Promise((resolve) => {
        releaseRun = () => resolve(matchingResult(context));
      }),
    });
    const executor = createAcpExecutor({
      transport,
      registry,
      createSessionToken: () => "token-tombstone",
      startedAt: () => later,
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await opened;
    // Wait until runAttempt is pending.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await registry.closeAll({
      reason: "session restore reclaimed ACP session",
      kind: "restore",
    });
    controller.abort();
    const result = await executePromise;
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "acp_host_teardown")).toBe(true);
    expect(result.diagnostics[0]?.location).toContain("restore");
    releaseRun?.();

    // User teardown → cancelled
    const registry2 = new AcpSessionRegistry();
    let open2: (() => void) | undefined;
    const opened2 = new Promise<void>((resolve) => {
      open2 = resolve;
    });
    const transport2 = createFakeAcpTransport({
      onOpenSession: async () => {
        open2?.();
      },
      runAttempt: async (_ctx, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new AcpSessionLostError("aborted"));
          }, { once: true });
        });
        return matchingResult(context);
      },
    });
    const executor2 = createAcpExecutor({
      transport: transport2,
      registry: registry2,
      createSessionToken: () => "token-tombstone-user",
      startedAt: () => later,
    });
    const controller2 = new AbortController();
    const execute2 = executor2.execute(context, controller2.signal);
    await opened2;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await registry2.closeAll({
      reason: "user cancelled ACP session",
      kind: "user",
    });
    controller2.abort();
    const result2 = await execute2;
    expect(result2.outcome).toBe("cancelled");
    expect(result2.diagnostics.some((item) => item.code === "acp_host_teardown")).toBe(true);
  });

  it("default createSessionToken allows two concurrent dispatches without collision", async () => {
    const { context } = materializeDefault();
    let release1: (() => void) | undefined;
    let release2: (() => void) | undefined;
    let started = 0;
    const transport = createFakeAcpTransport({
      runAttempt: async (envelope) => {
        started += 1;
        if (started === 1) {
          await new Promise<void>((resolve) => {
            release1 = resolve;
          });
        } else {
          await new Promise<void>((resolve) => {
            release2 = resolve;
          });
        }
        return matchingResult(envelope, { summary: `concurrent-${started}` });
      },
    });
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async (envelope) => matchingResult(envelope),
      }),
      acp: {
        transport,
        // Intentionally omit createSessionToken to exercise the default generator.
        startedAt: () => later,
      },
    });

    const p1 = host.dispatchAttempt(context, new AbortController().signal, pureMeta("c1"));
    const p2 = host.dispatchAttempt(context, new AbortController().signal, pureMeta("c2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    expect(host.acpRegistry?.activeCount()).toBe(2);
    release1?.();
    release2?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.result.outcome).toBe("submitted");
    expect(r2.result.outcome).toBe("submitted");
  });

  it("child-process transport records permission deny response body", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      authMethods: [],
      agentText: JSON.stringify(matchingResult(context)),
      capturePermissionResponse: true,
    });
    scripted.requestPermissionOnce = true;

    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
      hooks: { permissionPolicy: "deny" },
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-perm",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(scripted.permissionResponses.length).toBeGreaterThanOrEqual(1);
    const body = scripted.permissionResponses[0] as {
      result?: { outcome?: { outcome?: string; optionId?: string } };
    };
    expect(body.result?.outcome?.outcome).toBe("selected");
    expect(body.result?.outcome?.optionId).toBe("reject-once");
  });

  it("promptTimeoutMs maps hung session/prompt to timed_out / acp_prompt_timeout", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      agentText: "",
      hangOnPrompt: true,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 40,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-prompt-timeout",
      startedAt: () => later,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 40,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("timed_out");
    expect(result.diagnostics.some((item) => item.code === "acp_prompt_timeout")).toBe(true);
  });

  it("prompt survives longer than openRequestTimeoutMs when promptTimeoutMs is large", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      agentText: JSON.stringify(matchingResult(context, { summary: "slow prompt ok" })),
      promptDelayMs: 80,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 30,
      promptTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-prompt-survive",
      startedAt: () => later,
      openRequestTimeoutMs: 30,
      promptTimeoutMs: 5_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("slow prompt ok");
  });

  it("truncated agent_message_chunk forces acp_agent_text_truncated on text extraction path", async () => {
    const { context } = materializeDefault();
    const bigJson = JSON.stringify(matchingResult(context, {
      summary: "x".repeat(200),
    }));
    const fenced = `\`\`\`json\n${bigJson}\n\`\`\``;
    const scripted = createScriptedAcpProcess({
      agentText: fenced,
      omitPromptResultObject: true,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      maxAgentTextChars: 40,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-trunc",
      startedAt: () => later,
      promptTimeoutMs: 5_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "acp_agent_text_truncated")).toBe(true);
  });

  it("promptRecord.result is accepted when stream text was truncated (non-fatal diagnostic)", async () => {
    const { context } = materializeDefault();
    const structured = matchingResult(context, { summary: "structured on response" });
    const scripted = createScriptedAcpProcess({
      agentText: "n".repeat(500),
      promptResultObject: structured as unknown as Record<string, unknown>,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      maxAgentTextChars: 20,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-trunc-accept",
      startedAt: () => later,
      promptTimeoutMs: 5_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("structured on response");
    expect(result.diagnostics.some((item) => item.code === "acp_agent_text_truncated")).toBe(true);
  });

  it("truncation diagnostic survives { type: result, result } wrapper unwrap", async () => {
    const { context } = materializeDefault();
    const nested = matchingResult(context, { summary: "wrapped structured" });
    const scripted = createScriptedAcpProcess({
      agentText: "n".repeat(500),
      promptResultObject: {
        type: "result",
        result: nested,
      },
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      maxAgentTextChars: 20,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-trunc-wrapper",
      startedAt: () => later,
      promptTimeoutMs: 5_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("wrapped structured");
    expect(result.diagnostics.some((item) => item.code === "acp_agent_text_truncated")).toBe(true);
  });

  it("mergeTruncationDiagnostic respects maxDiagnostics bound without failing the result", () => {
    const { context } = materializeDefault();
    const max = 3;
    const filled = matchingResult(context, {
      summary: "at bound",
      diagnostics: [
        { code: "a", message: "1" },
        { code: "b", message: "2" },
        { code: "c", message: "3" },
      ],
    });
    const merged = mergeTruncationDiagnostic(filled, max);
    expect(merged.diagnostics).toHaveLength(max);
    expect(merged.diagnostics[max - 1]?.code).toBe("acp_agent_text_truncated");
    // Still a submitted-shaped result; validation would accept length === max.
    expect(merged.outcome).toBe("submitted");

    const emptyMax = mergeTruncationDiagnostic(filled, 0);
    expect(emptyMax.diagnostics).toHaveLength(3);
    expect(emptyMax.diagnostics.some((item) => item.code === "acp_agent_text_truncated")).toBe(false);

    const withRoom = mergeTruncationDiagnostic(
      matchingResult(context, {
        diagnostics: [{ code: "a", message: "1" }],
      }),
      4,
    );
    expect(withRoom.diagnostics).toHaveLength(2);
    expect(withRoom.diagnostics[1]?.code).toBe("acp_agent_text_truncated");
  });

  it("dispatchIsolatedPiAttempt routes acp when host has acp options", async () => {
    const { context } = materializeDefault();
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async (envelope) => matchingResult(envelope),
      }),
      acp: {
        transport: createFakeAcpTransport({
          runAttempt: async (envelope) => matchingResult(envelope, {
            summary: "product acp dispatch",
          }),
        }),
        createSessionToken: () => "token-dispatch-acp",
        startedAt: () => later,
      },
      startedAt: () => later,
    });
    bindActiveIsolatedPiHost(host);
    try {
      const settled = await dispatchIsolatedPiAttempt(
        context,
        new AbortController().signal,
        pureMeta("acp-product"),
      );
      expect(settled.ok).toBe(true);
      if (!settled.ok) return;
      expect(settled.result.summary).toBe("product acp dispatch");
    } finally {
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("dispatchIsolatedPiAttempt rejects acp when host has no acp options", async () => {
    const { context } = materializeDefault();
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async (envelope) => matchingResult(envelope),
      }),
      startedAt: () => later,
    });
    bindActiveIsolatedPiHost(host);
    try {
      const settled = await dispatchIsolatedPiAttempt(
        context,
        new AbortController().signal,
        pureMeta("acp-unconfigured"),
      );
      expect(settled.ok).toBe(false);
      if (settled.ok) return;
      expect(settled.diagnostics[0]?.code).toBe("acp_host_unconfigured");
    } finally {
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("child process error mid-prompt maps to interrupted without waiting for timeout", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      agentText: "",
      hangOnPrompt: true,
      emitErrorOnPrompt: true,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 10_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-proc-err",
      startedAt: () => later,
      promptTimeoutMs: 10_000,
    });
    const started = Date.now();
    const result = await executor.execute(context, new AbortController().signal);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "acp_session_lost")).toBe(true);
  });

  it("non-JSON banner line before initialize still opens the session", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      agentText: JSON.stringify(matchingResult(context, { summary: "after banner" })),
      bannerBeforeInitialize: "Agent starting...\n",
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 5_000,
      promptTimeoutMs: 5_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-banner",
      startedAt: () => later,
      promptTimeoutMs: 5_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("after banner");
  });

  it("unparseable line bound maps to interrupted / acp_session_lost", async () => {
    const { context } = materializeDefault();
    const scripted = createScriptedAcpProcess({
      agentText: JSON.stringify(matchingResult(context)),
      unparseableBannerCount: 40,
    });
    const transport = createChildProcessAcpTransport({
      requireBinary: false,
      createProcess: () => scripted.process,
      openRequestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
      terminateGraceMs: 20,
      terminateForceMs: 20,
    });
    const executor = createAcpExecutor({
      transport,
      createSessionToken: () => "token-banner-bound",
      startedAt: () => later,
      openRequestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "acp_session_lost")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scripted ACP stdio process for transport tests
// ---------------------------------------------------------------------------

function createScriptedAcpProcess(options: {
  protocolVersion?: number;
  authMethods?: unknown[];
  omitSessionId?: boolean;
  agentText: string;
  omitTrailingNewlineOnLastResponse?: boolean;
  onPermission?: (params: unknown) => void;
  capturePermissionResponse?: boolean;
  hangOnPrompt?: boolean;
  promptDelayMs?: number;
  promptResultObject?: Record<string, unknown>;
  omitPromptResultObject?: boolean;
  emitErrorOnPrompt?: boolean;
  bannerBeforeInitialize?: string;
  unparseableBannerCount?: number;
}): {
  process: AcpSpawnedProcess;
  receivedMethods: string[];
  requestPermissionOnce: boolean;
  permissionResponses: unknown[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const receivedMethods: string[] = [];
  const permissionResponses: unknown[] = [];
  let exitCode: number | null = null;
  let killed = false;
  let requestPermissionOnce = false;
  let buffer = "";
  let initializeSeen = false;

  const writeOut = (payload: unknown, trailingNewline = true): void => {
    const line = JSON.stringify(payload) + (trailingNewline ? "\n" : "");
    stdout.write(line);
  };

  const writeBanners = (): void => {
    if (options.bannerBeforeInitialize && !initializeSeen) {
      stdout.write(options.bannerBeforeInitialize);
    }
    const count = options.unparseableBannerCount ?? 0;
    for (let i = 0; i < count; i += 1) {
      stdout.write(`not-json-banner-${i}\n`);
    }
  };

  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim().length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        options.capturePermissionResponse
        && msg.id !== undefined
        && msg.result !== undefined
        && typeof msg.method !== "string"
      ) {
        permissionResponses.push(msg);
        continue;
      }
      if (typeof msg.method !== "string") continue;
      const method = msg.method;
      receivedMethods.push(method);
      const id = msg.id;

      if (method === "initialize") {
        writeBanners();
        initializeSeen = true;
        writeOut({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: options.protocolVersion ?? 1,
            agentCapabilities: { loadSession: false },
            authMethods: options.authMethods ?? [],
          },
        });
        continue;
      }
      if (method === "session/new") {
        writeOut({
          jsonrpc: "2.0",
          id,
          result: options.omitSessionId ? {} : { sessionId: "scripted-session-1" },
        });
        continue;
      }
      if (method === "session/prompt") {
        if (options.emitErrorOnPrompt) {
          setImmediate(() => {
            emitter.emit("error", new Error("scripted process error mid-prompt"));
          });
          return;
        }
        if (options.hangOnPrompt) {
          return;
        }
        const respond = (): void => {
          if (requestPermissionOnce) {
            requestPermissionOnce = false;
            writeOut({
              jsonrpc: "2.0",
              id: 9001,
              method: "session/request_permission",
              params: {
                sessionId: "scripted-session-1",
                toolCall: { toolCallId: "c1" },
                options: [
                  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
                  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
                ],
              },
            });
          }
          if (options.agentText.length > 0) {
            writeOut({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "scripted-session-1",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: options.agentText },
                },
              },
            });
          }
          const trailing = !(options.omitTrailingNewlineOnLastResponse ?? false);
          const promptResult: Record<string, unknown> = { stopReason: "end_turn" };
          if (options.promptResultObject) {
            promptResult.result = options.promptResultObject;
          } else if (!options.omitPromptResultObject && options.agentText.trim().startsWith("{")) {
            try {
              promptResult.result = JSON.parse(options.agentText) as unknown;
            } catch {
              // text-only path
            }
          }
          writeOut({
            jsonrpc: "2.0",
            id,
            result: promptResult,
          }, trailing);
          if (!trailing) {
            setImmediate(() => {
              stdout.end();
            });
          }
        };
        if (options.promptDelayMs !== undefined && options.promptDelayMs > 0) {
          setTimeout(respond, options.promptDelayMs);
        } else {
          respond();
        }
        continue;
      }
      if (method === "session/cancel") {
        continue;
      }
    }
  });

  const proc = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return null as NodeJS.Signals | null;
    },
    get killed() {
      return killed;
    },
    kill() {
      killed = true;
      exitCode = 0;
      stdin.end();
      stdout.end();
      stderr.end();
      emitter.emit("exit", 0, null);
      return true;
    },
    on(event: "error", listener: (error: Error) => void) {
      emitter.on(event, listener);
      return proc;
    },
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      emitter.once(event, listener);
      return proc;
    },
    removeListener(event: "exit", listener: (...args: unknown[]) => void) {
      emitter.removeListener(event, listener);
      return proc;
    },
  } as AcpSpawnedProcess;

  const state = {
    process: proc,
    receivedMethods,
    permissionResponses,
    get requestPermissionOnce() {
      return requestPermissionOnce;
    },
    set requestPermissionOnce(value: boolean) {
      requestPermissionOnce = value;
    },
  };
  void options.onPermission;
  return state;
}

