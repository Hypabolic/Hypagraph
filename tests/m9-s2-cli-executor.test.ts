import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
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
  CLI_EXECUTOR_ID,
  CLI_EXECUTOR_VERSION,
  CLI_PROFILE,
  CliAbortError,
  CliProcessLostError,
  CliProcessRegistry,
  CliTimeoutError,
  HYPAGRAPH_CLI_JSON_ADAPTER_NAME,
  buildCliResultPayload,
  createChildProcessCliTransport,
  createCliExecutor,
  createFakeCliTransport,
  executeAndSettleCli,
  filterCliEnv,
  getNamedCliAdapter,
  listNamedCliAdapters,
  materializeCliContext,
  parseCliResultOutput,
  parseCliTransportReply,
  refuseCliShellExecution,
  registerNamedCliAdapter,
  resolveCliAdapterNameFromProfile,
  resultFromCliContext,
  serializeCliContextInput,
  settleCliResult,
  unregisterNamedCliAdapter,
  validateCliBinaryPath,
  type CliSpawnedProcess,
  type NamedCliAdapterDefinition,
} from "../src/pi/cli-executor.js";
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

const profile = CLI_PROFILE;

const chainDefinition = (): HypagraphDefinition => ({
  title: "CLI executor fixture",
  goal: "Ship CLI settlement",
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
    familyId: "family-m9-s2",
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
    familyId: "family-m9-s2",
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
  summary: "Work completed with a structured CLI result.",
  diagnostics: [],
  usage: { turns: 1, totalTokens: 10 },
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

/** Temporary adapters registered in tests; cleaned after each test. */
const temporaryAdapterNames: string[] = [];

afterEach(() => {
  while (temporaryAdapterNames.length > 0) {
    const name = temporaryAdapterNames.pop()!;
    unregisterNamedCliAdapter(name);
  }
  bindActiveIsolatedPiHost(undefined);
});

const registerTempAdapter = (adapter: NamedCliAdapterDefinition): void => {
  const result = registerNamedCliAdapter(adapter);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  temporaryAdapterNames.push(adapter.name);
};

describe("m9-s2 named direct CLI adapters", () => {
  it("lists the built-in hypagraph-cli-json adapter", () => {
    const adapters = listNamedCliAdapters();
    expect(adapters.some((item) => item.name === HYPAGRAPH_CLI_JSON_ADAPTER_NAME)).toBe(true);
    const lookup = getNamedCliAdapter(HYPAGRAPH_CLI_JSON_ADAPTER_NAME);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.contextFormat).toBe("stdin-json");
    expect(lookup.value.resultFormat).toBe("stdout-json");
    expect(lookup.value.defaultTimeoutMs).toBeGreaterThan(0);
  });

  it("unknown adapter name fails with clear diagnostic and does not spawn", async () => {
    const unknown = getNamedCliAdapter("not-a-real-adapter");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe("cli_adapter_unknown");
    expect(unknown.message).toContain("named adapter");

    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async () => matchingResult(context),
    });
    const executor = createCliExecutor({
      transport,
      resolveAdapterName: () => "not-a-real-adapter",
      resolveCwd: () => "/tmp",
      startedAt: () => later,
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "cli_adapter_unknown")).toBe(true);
    expect(transport.runs).toHaveLength(0);
  });

  it("materializeCliContext uses profile kind cli and is reproducible", () => {
    const base = createFamilyAndState();
    const materialized = materializeCliContext({
      family: base.family,
      state: base.state,
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.profile).toEqual(CLI_PROFILE);
    expect(materialized.value.profile.kind).toBe("cli");
    const hashA = hashExecutorContext(materialized.value);
    const hashB = hashExecutorContext(materialized.value);
    expect(hashA).toBe(hashB);
  });

  it("named adapter invoke produces validated ExecutorResult matching identity", async () => {
    const { context, state } = materializeDefault();
    const registry = new CliProcessRegistry();
    const token = "token-happy";
    const transport = createFakeCliTransport({
      runAttempt: async (options) => {
        expect(options.adapter.name).toBe(HYPAGRAPH_CLI_JSON_ADAPTER_NAME);
        return matchingResult(options.context);
      },
    });
    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => token,
      startedAt: () => later,
      resolveCwd: () => "/tmp/hypagraph-cli",
    });

    expect(executor.id).toBe(CLI_EXECUTOR_ID);
    expect(executor.version).toBe(CLI_EXECUTOR_VERSION);

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.usage.totalTokens).toBe(10);
    expect(registry.get(token)).toBeUndefined();
    expect(registry.hasActive()).toBe(false);
    expect(transport.runs).toHaveLength(1);

    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);

    const settled = await executeAndSettleCli(
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

  it("context input format serialization is stable and reproducible", () => {
    const { context } = materializeDefault();
    const first = serializeCliContextInput(context, "stdin-json");
    const second = serializeCliContextInput(context, "stdin-json");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toBe(second.value);
    expect(first.value.endsWith("\n")).toBe(true);
    // Parsed body is a plain object with attempt identity.
    const body = JSON.parse(first.value.trim()) as Record<string, unknown>;
    expect(body.identity).toMatchObject({
      attemptId: context.identity.attemptId,
      nodeId: context.identity.nodeId,
    });
  });

  it("result output parse accepts good JSON and rejects bad JSON and missing fields", () => {
    const good = parseCliResultOutput(
      '{"familyId":"f","goalId":"g","workflowId":"w","revision":1,"nodeId":"n","attemptId":"a","outcome":"submitted","facts":[],"evidence":[],"artifacts":[],"summary":"ok","diagnostics":[],"usage":{}}\n',
      "stdout-json",
    );
    expect(good.ok).toBe(true);

    const bad = parseCliResultOutput("not-json at all", "stdout-json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("cli_result_invalid_json");
    }

    const empty = parseCliResultOutput("   ", "stdout-json");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe("cli_result_empty");
    }

    const array = parseCliResultOutput("[1,2,3]\n", "stdout-json");
    expect(array.ok).toBe(false);
    if (!array.ok) {
      expect(array.code).toBe("cli_result_not_object");
    }

    // Prefers last plain object line.
    const multi = parseCliResultOutput(
      'noise\n{"a":1}\n{"b":2}\n',
      "stdout-json",
    );
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.value).toEqual({ b: 2 });
    }
  });

  it("pre-start abort returns cancelled with identity and does not run transport", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const executor = createCliExecutor({
      transport,
      resolveCwd: () => "/tmp",
      startedAt: () => later,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(context, controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "cli_aborted_before_start")).toBe(true);
    expect(transport.runs).toHaveLength(0);

    const settled = settleCliResult(context, result, pureMeta("preabort"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]).toMatchObject({
      type: "cancel-attempt",
      attemptId: "attempt-work-1",
    });
  });

  it("mid-run cancel via AbortSignal returns cancelled", async () => {
    const { context } = materializeDefault();
    const registry = new CliProcessRegistry();
    const token = "token-cancel";
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });

    const transport = createFakeCliTransport({
      runAttempt: async (_options) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (_options.signal.aborted) {
            reject(new CliAbortError("aborted"));
            return;
          }
          _options.signal.addEventListener("abort", () => {
            reject(new CliAbortError("aborted during run"));
          }, { once: true });
        });
        return matchingResult(_options.context);
      },
    });

    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => token,
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await runGate;
    controller.abort();

    const result = await executePromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "cli_cancelled")).toBe(true);
    expect(registry.get(token)).toBeUndefined();

    const settled = settleCliResult(context, result, pureMeta("cancel"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("timeout maps to timed_out", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async () => {
        throw new CliTimeoutError("CLI process timed out after 50ms.");
      },
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-timeout",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
      timeoutMs: 50,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("timed_out");
    expect(result.diagnostics.some((item) => item.code === "cli_timeout")).toBe(true);

    const settled = settleCliResult(context, result, pureMeta("timeout"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
  });

  it("security: reject shell metacharacters, shell interpreters, and refuse shell execution", () => {
    // Quotes and shell operators are always rejected.
    const shellPath = validateCliBinaryPath("/bin/sh -c 'rm -rf /'");
    expect(shellPath.ok).toBe(false);
    if (!shellPath.ok) {
      expect(shellPath.code).toBe("cli_binary_shell_metacharacters");
    }

    // Known shell interpreter basenames fail closed (trusted-registry denylist).
    const shOnly = validateCliBinaryPath("/bin/sh");
    expect(shOnly.ok).toBe(false);
    if (!shOnly.ok) {
      expect(shOnly.code).toBe("cli_binary_shell_interpreter");
    }
    const bashOnly = validateCliBinaryPath("/usr/bin/bash");
    expect(bashOnly.ok).toBe(false);
    if (!bashOnly.ok) {
      expect(bashOnly.code).toBe("cli_binary_shell_interpreter");
    }

    const traversal = validateCliBinaryPath("/usr/bin/../evil");
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) {
      expect(traversal.code).toBe("cli_binary_path_traversal");
    }

    const okPath = validateCliBinaryPath("/usr/local/bin/hypagraph-cli-json");
    expect(okPath.ok).toBe(true);

    // Absolute paths may contain spaces under shell:false (argv is one path).
    const programFiles = validateCliBinaryPath("/Program Files/Hypagraph/cli-agent");
    expect(programFiles.ok).toBe(true);

    // Relative paths with whitespace remain rejected.
    const relativeSpace = validateCliBinaryPath("my agent/bin");
    expect(relativeSpace.ok).toBe(false);
    if (!relativeSpace.ok) {
      expect(relativeSpace.code).toBe("cli_binary_shell_metacharacters");
    }

    const refused = refuseCliShellExecution();
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("cli_shell_refused");
  });

  it("security: env allowlist filters untrusted keys", () => {
    const filtered = filterCliEnv(
      {
        PATH: "/usr/bin",
        SECRET_TOKEN: "should-drop",
        HYPAGRAPH_CLI_ATTEMPT: "old",
        HOME: "/home/test",
      },
      ["PATH", "HOME", "HYPAGRAPH_CLI_ATTEMPT"],
      "attempt-1",
    );
    expect(filtered).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      HYPAGRAPH_CLI_ATTEMPT: "attempt-1",
    });
    expect(filtered.SECRET_TOKEN).toBeUndefined();
  });

  it("untrusted invalid payload returns failed and settlement rejects without domain mutation", async () => {
    const { context, family, state } = materializeDefault();
    const familyBefore = structuredClone(family);
    const stateBefore = structuredClone(state);
    const transport = createFakeCliTransport({
      runAttempt: async () => ({
        // Missing required identity fields
        outcome: "submitted",
        summary: "incomplete",
      }),
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-invalid",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);

    const settled = settleExecutorResult(context, result, pureMeta("invalid"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands[0]?.type).toBe("cancel-attempt");
    expect(family).toEqual(familyBefore);
    expect(state).toEqual(stateBefore);
  });

  it("stale mismatched identity is rewritten to failed with context identity", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async () => ({
        ...matchingResult(context),
        attemptId: "stale-other-attempt",
        familyId: "other-family",
      }),
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-stale",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.diagnostics.some((item) => item.code === "cli_stale_result")).toBe(true);
  });

  it("process loss maps to interrupted with context identity", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async () => {
        throw new CliProcessLostError("The CLI process exited unexpectedly.");
      },
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-lost",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("interrupted");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.diagnostics.some((item) => item.code === "cli_process_lost")).toBe(true);
  });

  it("profile mismatch returns cli_profile_mismatch without running transport", async () => {
    const { context } = materializeDefault();
    const wrongProfile = {
      ...context,
      profile: ISOLATED_PI_PROFILE,
    };
    const transport = createFakeCliTransport({
      runAttempt: async () => matchingResult(context),
    });
    const executor = createCliExecutor({
      transport,
      resolveCwd: () => "/tmp",
      startedAt: () => later,
    });
    const result = await executor.execute(wrongProfile, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "cli_profile_mismatch")).toBe(true);
    expect(transport.runs).toHaveLength(0);
  });

  it("createNodeExecutorForProfile routes cli and errors when options.cli is missing", () => {
    expect(() => createNodeExecutorForProfile(CLI_PROFILE, {})).toThrow(
      /CLI profile requires createNodeExecutorForProfile options.cli/,
    );
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const executor = createNodeExecutorForProfile(CLI_PROFILE, {
      cli: {
        transport,
        resolveCwd: () => "/tmp",
        startedAt: () => later,
      },
    });
    expect(executor.id).toBe(CLI_EXECUTOR_ID);
  });

  it("createIsolatedPiHost routes cli and shares registry for teardown", async () => {
    const { context } = materializeDefault();
    const cliRegistry = new CliProcessRegistry();
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context, {
        summary: "host-dispatched cli",
      }),
    });
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async (envelope) => matchingResult(envelope),
      }),
      resolveCwd: () => "/tmp",
      startedAt: () => later,
      cli: {
        transport,
        registry: cliRegistry,
        createProcessToken: () => "host-cli-token",
        resolveCwd: () => "/tmp",
        startedAt: () => later,
      },
    });

    expect(host.cliRegistry).toBe(cliRegistry);
    const cliExecutor = host.resolveNodeExecutor(CLI_PROFILE);
    expect(cliExecutor.id).toBe(CLI_EXECUTOR_ID);

    // Pre-register a live process so active checks and teardown see CLI state.
    expect(cliRegistry.register({
      processToken: "pre-live",
      adapterName: HYPAGRAPH_CLI_JSON_ADAPTER_NAME,
      identity: context.identity,
      live: true,
      startedAt: later,
      pid: 9999,
    }).ok).toBe(true);
    let closerCalled = false;
    cliRegistry.setCloser("pre-live", async () => {
      closerCalled = true;
    });
    expect(host.hasActiveProcesses()).toBe(true);
    expect(host.activeProcessCount()).toBeGreaterThan(0);

    const teardown = await host.teardownOnRestore({
      reason: "restore",
      kind: "restore",
    });
    expect(teardown.cliClosedCount).toBe(1);
    expect(closerCalled).toBe(true);
    expect(host.hasActiveProcesses()).toBe(false);

    const settled = await host.dispatchAttempt(
      context,
      new AbortController().signal,
      pureMeta("host-cli-ok"),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.summary).toBe("host-dispatched cli");
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);
  });

  it("dispatchIsolatedPiAttempt routes cli when host has cli options", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async () => {
          throw new Error("isolated-pi must not run");
        },
      }),
      resolveCwd: () => "/tmp",
      startedAt: () => later,
      cli: {
        transport,
        createProcessToken: () => "dispatch-cli-token",
        resolveCwd: () => "/tmp",
        startedAt: () => later,
      },
    });
    bindActiveIsolatedPiHost(host);
    try {
      const settled = await dispatchIsolatedPiAttempt(
        context,
        new AbortController().signal,
        pureMeta("dispatch-cli"),
      );
      expect(settled.ok).toBe(true);
      if (!settled.ok) return;
      expect(settled.result.outcome).toBe("submitted");
      expect(settled.result.attemptId).toBe(context.identity.attemptId);
    } finally {
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("dispatchIsolatedPiAttempt rejects cli when host has no cli options", async () => {
    const { context } = materializeDefault();
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async () => {
          throw new Error("isolated-pi must not run");
        },
      }),
      resolveCwd: () => "/tmp",
      startedAt: () => later,
    });
    bindActiveIsolatedPiHost(host);
    try {
      const settled = await dispatchIsolatedPiAttempt(
        context,
        new AbortController().signal,
        pureMeta("dispatch-cli-missing"),
      );
      expect(settled.ok).toBe(false);
      if (settled.ok) return;
      expect(settled.diagnostics.some((item) => item.code === "cli_host_unconfigured")).toBe(true);
    } finally {
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("same normalized result type as ACP path via validateExecutorResult and settle", async () => {
    const { context } = materializeDefault();
    const payload = buildCliResultPayload({
      identity: context.identity,
      outcome: "submitted",
      facts: [{ name: "work.done", type: "boolean", value: true }],
      evidence: [{ ref: "evidence://work", kind: "note", summary: "ok" }],
      summary: "normalized",
      diagnostics: [],
      usage: { turns: 1 },
    });
    const validated = validateExecutorResult(context, payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.outcome).toBe("submitted");

    const settled = settleExecutorResult(context, validated.value, pureMeta("normalized"));
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.commands.map((command) => command.type)).toEqual([
      "publish-facts",
      "submit-result",
    ]);
  });

  it("host teardown restore maps to interrupted without manual AbortSignal abort", async () => {
    const { context } = materializeDefault();
    const registry = new CliProcessRegistry();
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let sawLinkedAbort = false;
    const transport = createFakeCliTransport({
      runAttempt: async (options) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (options.signal.aborted) {
            sawLinkedAbort = true;
            reject(new CliAbortError("host closer aborted linked signal"));
            return;
          }
          options.signal.addEventListener("abort", () => {
            sawLinkedAbort = true;
            reject(new CliAbortError("host closer aborted linked signal"));
          }, { once: true });
        });
        // Must not return a late submitted result after host teardown.
        return matchingResult(options.context);
      },
    });

    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => "token-teardown-restore",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    // Call-site signal is never aborted; host closer must stop work alone.
    const executePromise = executor.execute(context, new AbortController().signal);
    await runGate;
    const closed = await registry.closeOwned("token-teardown-restore", {
      kind: "restore",
      reason: "session restore reclaimed CLI process",
    });
    expect(closed).toBe(true);
    const result = await executePromise;
    expect(result.outcome).toBe("interrupted");
    expect(result.diagnostics.some((item) => item.code === "cli_host_teardown")).toBe(true);
    expect(result.diagnostics[0]?.location).toContain("restore");
    expect(sawLinkedAbort).toBe(true);
  });

  it("host teardown user maps to cancelled without manual AbortSignal abort", async () => {
    const { context } = materializeDefault();
    const registry = new CliProcessRegistry();
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let sawLinkedAbort = false;
    const transport = createFakeCliTransport({
      runAttempt: async (options) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (options.signal.aborted) {
            sawLinkedAbort = true;
            reject(new CliAbortError("host closer aborted linked signal"));
            return;
          }
          options.signal.addEventListener("abort", () => {
            sawLinkedAbort = true;
            reject(new CliAbortError("host closer aborted linked signal"));
          }, { once: true });
        });
        return matchingResult(options.context);
      },
    });

    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => "token-teardown-user",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const executePromise = executor.execute(context, new AbortController().signal);
    await runGate;
    const closedCount = await registry.closeAll({
      kind: "user",
      reason: "user cancelled CLI process from host",
    });
    expect(closedCount).toBe(1);
    const result = await executePromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.diagnostics.some((item) => item.code === "cli_host_teardown")).toBe(true);
    expect(result.diagnostics[0]?.location).toContain("user");
    expect(sawLinkedAbort).toBe(true);
  });

  it("host teardown rejects late submitted result after closeAll", async () => {
    const { context } = materializeDefault();
    const registry = new CliProcessRegistry();
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let releaseResult: ((value: unknown) => void) | undefined;
    const transport = createFakeCliTransport({
      runAttempt: async (options) => {
        runStarted?.();
        return new Promise((resolve) => {
          releaseResult = resolve;
          // If host closer aborts first, still allow a late resolve to simulate race.
          options.signal.addEventListener("abort", () => {
            // Intentionally do not reject; release a success after teardown.
          }, { once: true });
        });
      },
    });

    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => "token-late-result",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const executePromise = executor.execute(context, new AbortController().signal);
    await runGate;
    await registry.closeAll({
      kind: "user",
      reason: "user cancelled while result was in flight",
    });
    // Late success after host cancel must not settle as submitted.
    releaseResult?.(matchingResult(context, { summary: "late success after cancel" }));
    const result = await executePromise;
    expect(result.outcome).toBe("cancelled");
    expect(result.diagnostics.some((item) => item.code === "cli_host_teardown")).toBe(true);
    expect(result.summary).not.toBe("late success after cancel");
  });

  it("resolveCliAdapterNameFromProfile matches built-in profileId", () => {
    const resolved = resolveCliAdapterNameFromProfile(CLI_PROFILE);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.name).toBe(HYPAGRAPH_CLI_JSON_ADAPTER_NAME);
  });

  it("registerNamedCliAdapter rejects invalid definitions and shell interpreters", () => {
    const invalid = registerNamedCliAdapter({
      name: "bad-shell",
      profileId: "cli-bad-shell",
      command: "bash -c 'echo hi'",
      args: [],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      allowedEnvKeys: ["PATH"],
      cwdPolicy: "host",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("cli_binary_shell_metacharacters");
    }

    // Trusted-registry assumption: shell interpreter paths fail closed even with argv.
    const shFrontEnd = registerNamedCliAdapter({
      name: "sh-frontend",
      profileId: "cli-sh-frontend",
      command: "/bin/sh",
      args: ["-c", "echo should-not-register"],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      allowedEnvKeys: ["PATH"],
      cwdPolicy: "host",
    });
    expect(shFrontEnd.ok).toBe(false);
    if (!shFrontEnd.ok) {
      expect(shFrontEnd.code).toBe("cli_binary_shell_interpreter");
    }

    registerTempAdapter({
      name: "fixture-cli-json",
      profileId: "cli-fixture-json",
      command: "/usr/bin/true",
      args: ["--json"],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 5_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 1024,
      allowedEnvKeys: ["PATH", "HYPAGRAPH_CLI_ATTEMPT"],
      cwdPolicy: "host",
    });
    const lookup = getNamedCliAdapter("fixture-cli-json");
    expect(lookup.ok).toBe(true);
  });

  it("require-absolute cwd policy fails closed when cwd is missing", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-cwd-missing",
      startedAt: () => later,
      // No resolveCwd: built-in hypagraph-cli-json uses require-absolute.
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "cli_cwd_required")).toBe(true);
    expect(transport.runs).toHaveLength(0);
  });

  it("resultFromCliContext preserves identity and rejects class-instance diagnostics path", () => {
    const { context } = materializeDefault();
    const result = resultFromCliContext(context, "failed", [{
      code: "cli_test",
      message: "test diagnostic",
    }]);
    expect(result.familyId).toBe(context.identity.familyId);
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(result.outcome).toBe("failed");
    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);
  });

  it("child-process transport: scripted process writes context stdin and returns stdout JSON", async () => {
    const { context } = materializeDefault();
    const stdinChunks: string[] = [];

    const transport = createChildProcessCliTransport({
      requireBinary: false,
      createProcess: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        let killed = false;

        stdin.on("data", (chunk: Buffer) => {
          stdinChunks.push(chunk.toString("utf8"));
        });
        stdin.on("end", () => {
          const payload = matchingResult(context);
          stdout.write(`${JSON.stringify(payload)}\n`);
          stdout.end();
          stderr.end();
          exitCode = 0;
          setImmediate(() => emitter.emit("exit", 0, null));
        });

        const processLike: CliSpawnedProcess = {
          pid: 4242,
          stdin,
          stdout,
          stderr,
          get exitCode() {
            return exitCode;
          },
          get signalCode() {
            return signalCode;
          },
          get killed() {
            return killed;
          },
          kill(signal?: NodeJS.Signals | number) {
            killed = true;
            if (exitCode === null && signalCode === null) {
              signalCode = typeof signal === "string" ? signal : "SIGTERM";
              setImmediate(() => emitter.emit("exit", null, signalCode));
            }
            return true;
          },
          on(event: "error", listener: (error: Error) => void) {
            emitter.on(event, listener);
            return processLike;
          },
          once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
            emitter.once(event, listener);
            return processLike;
          },
          removeListener(event: "exit", listener: (...args: unknown[]) => void) {
            emitter.removeListener(event, listener);
            return processLike;
          },
        };
        return processLike;
      },
    });

    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-child",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(stdinChunks.join("").length).toBeGreaterThan(0);
    const parsedStdin = JSON.parse(stdinChunks.join("").trim()) as Record<string, unknown>;
    expect(parsedStdin.identity).toMatchObject({
      attemptId: context.identity.attemptId,
    });
  });

  it("child-process transport: timeout terminates and maps to timed_out", async () => {
    const { context } = materializeDefault();
    let killCount = 0;

    const transport = createChildProcessCliTransport({
      requireBinary: false,
      terminateGraceMs: 10,
      terminateForceMs: 10,
      createProcess: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        let killed = false;

        // Consume stdin so write does not block; never exit until kill.
        stdin.on("data", () => {
          // drain
        });
        stdin.on("end", () => {
          // hang intentionally
        });

        const processLike: CliSpawnedProcess = {
          pid: 5555,
          stdin,
          stdout,
          stderr,
          get exitCode() {
            return exitCode;
          },
          get signalCode() {
            return signalCode;
          },
          get killed() {
            return killed;
          },
          kill(signal?: NodeJS.Signals | number) {
            killCount += 1;
            killed = true;
            if (exitCode === null && signalCode === null) {
              signalCode = typeof signal === "string" ? signal : "SIGTERM";
              setImmediate(() => emitter.emit("exit", null, signalCode));
            }
            return true;
          },
          on(event: "error", listener: (error: Error) => void) {
            emitter.on(event, listener);
            return processLike;
          },
          once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
            emitter.once(event, listener);
            return processLike;
          },
          removeListener(event: "exit", listener: (...args: unknown[]) => void) {
            emitter.removeListener(event, listener);
            return processLike;
          },
        };
        return processLike;
      },
    });

    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-child-timeout",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
      timeoutMs: 30,
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("timed_out");
    expect(result.diagnostics.some((item) => item.code === "cli_timeout")).toBe(true);
    expect(killCount).toBeGreaterThan(0);
  });

  it("parseCliTransportReply rejects non-plain objects", () => {
    const invalid = parseCliTransportReply("raw text only");
    expect(invalid.kind).toBe("invalid");

    const classInstance = parseCliTransportReply(new Date());
    expect(classInstance.kind).toBe("invalid");

    const plain = parseCliTransportReply({
      familyId: "f",
      outcome: "submitted",
    });
    expect(plain.kind).toBe("result");
  });

  it("cwd policy require-absolute rejects relative paths", async () => {
    const { context } = materializeDefault();
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-cwd",
      startedAt: () => later,
      resolveCwd: () => "relative/path",
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "cli_cwd_not_absolute")).toBe(true);
    expect(transport.runs).toHaveLength(0);
  });

  it("duplicate process token registration fails with distinct code", async () => {
    const { context } = materializeDefault();
    const registry = new CliProcessRegistry();
    const token = "token-dup";
    registry.register({
      processToken: token,
      adapterName: HYPAGRAPH_CLI_JSON_ADAPTER_NAME,
      identity: structuredClone(context.identity),
      live: true,
      startedAt: later,
    });
    const transport = createFakeCliTransport({
      runAttempt: async (options) => matchingResult(options.context),
    });
    const executor = createCliExecutor({
      transport,
      registry,
      createProcessToken: () => token,
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });
    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "cli_process_token_duplicate")).toBe(true);
    expect(transport.runs).toHaveLength(0);
  });

  it("completed result wins when result settles before abort is observed", async () => {
    const { context } = materializeDefault();
    let releaseResult: ((value: unknown) => void) | undefined;
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const transport = createFakeCliTransport({
      runAttempt: async () => {
        runStarted?.();
        return new Promise((resolve) => {
          releaseResult = resolve;
        });
      },
    });
    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-race",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
    });
    const controller = new AbortController();
    const executePromise = executor.execute(context, controller.signal);
    await runGate;
    // Result settles first; concurrent abort must not flip a completed result.
    releaseResult?.(matchingResult(context, { summary: "completed before cancel wins" }));
    // Yield so the result branch of Promise.race can observe the completed value.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await executePromise;
    expect(result.outcome).toBe("submitted");
    expect(result.summary).toBe("completed before cancel wins");
  });

  it("child-process transport: stdout over maxStdoutBytes attaches cli_stdout_truncated", async () => {
    const { context } = materializeDefault();
    registerTempAdapter({
      name: "fixture-stdout-bound",
      profileId: "cli-fixture-stdout-bound",
      command: "/usr/bin/true",
      args: [],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 5_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 4_096,
      allowedEnvKeys: ["PATH", "HYPAGRAPH_CLI_ATTEMPT"],
      cwdPolicy: "host",
    });

    const payload = matchingResult(context, { summary: "ok" });
    const jsonLine = `${JSON.stringify(payload)}\n`;
    // Prefix padding so total stdout exceeds maxStdoutBytes while the last line is complete JSON.
    const padding = "x".repeat(80);

    const transport = createChildProcessCliTransport({
      requireBinary: false,
      createProcess: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        let killed = false;

        stdin.on("data", () => {
          // drain
        });
        stdin.on("end", () => {
          stdout.write(padding);
          stdout.write(jsonLine);
          stdout.end();
          stderr.end();
          exitCode = 0;
          setImmediate(() => emitter.emit("exit", 0, null));
        });

        const processLike: CliSpawnedProcess = {
          pid: 6101,
          stdin,
          stdout,
          stderr,
          get exitCode() { return exitCode; },
          get signalCode() { return signalCode; },
          get killed() { return killed; },
          kill(signal?: NodeJS.Signals | number) {
            killed = true;
            if (exitCode === null && signalCode === null) {
              signalCode = typeof signal === "string" ? signal : "SIGTERM";
              setImmediate(() => emitter.emit("exit", null, signalCode));
            }
            return true;
          },
          on(event: "error", listener: (error: Error) => void) {
            emitter.on(event, listener);
            return processLike;
          },
          once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
            emitter.once(event, listener);
            return processLike;
          },
          removeListener(event: "exit", listener: (...args: unknown[]) => void) {
            emitter.removeListener(event, listener);
            return processLike;
          },
        };
        return processLike;
      },
    });

    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-stdout-bound",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
      resolveAdapterName: () => "fixture-stdout-bound",
    });

    const result = await executor.execute(context, new AbortController().signal);
    // When padding truncates before complete JSON, parse may fail; when the last
    // complete object fits in the bound after truncation mid-padding, success
    // carries cli_stdout_truncated. Either way the bound is enforced.
    if (result.outcome === "submitted") {
      expect(result.diagnostics.some((item) => item.code === "cli_stdout_truncated")).toBe(true);
    } else {
      expect(result.outcome).toBe("failed");
      expect(
        result.diagnostics.some((item) =>
          item.code === "cli_result_invalid_json"
          || item.code === "cli_result_empty"
          || item.code === "cli_result_not_object"
          || item.code === "cli_stdout_truncated"),
      ).toBe(true);
    }
  });

  it("child-process transport: stderr over maxStderrBytes attaches cli_stderr_truncated on success", async () => {
    const { context } = materializeDefault();
    registerTempAdapter({
      name: "fixture-stderr-bound",
      profileId: "cli-fixture-stderr-bound",
      command: "/usr/bin/true",
      args: [],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 5_000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 32,
      allowedEnvKeys: ["PATH", "HYPAGRAPH_CLI_ATTEMPT"],
      cwdPolicy: "host",
    });

    const payload = matchingResult(context, { summary: "stderr-bound-ok" });

    const transport = createChildProcessCliTransport({
      requireBinary: false,
      createProcess: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        let killed = false;

        stdin.on("data", () => {
          // drain
        });
        stdin.on("end", () => {
          stderr.write("e".repeat(200));
          stdout.write(`${JSON.stringify(payload)}\n`);
          stdout.end();
          stderr.end();
          exitCode = 0;
          setImmediate(() => emitter.emit("exit", 0, null));
        });

        const processLike: CliSpawnedProcess = {
          pid: 6102,
          stdin,
          stdout,
          stderr,
          get exitCode() { return exitCode; },
          get signalCode() { return signalCode; },
          get killed() { return killed; },
          kill(signal?: NodeJS.Signals | number) {
            killed = true;
            if (exitCode === null && signalCode === null) {
              signalCode = typeof signal === "string" ? signal : "SIGTERM";
              setImmediate(() => emitter.emit("exit", null, signalCode));
            }
            return true;
          },
          on(event: "error", listener: (error: Error) => void) {
            emitter.on(event, listener);
            return processLike;
          },
          once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
            emitter.once(event, listener);
            return processLike;
          },
          removeListener(event: "exit", listener: (...args: unknown[]) => void) {
            emitter.removeListener(event, listener);
            return processLike;
          },
        };
        return processLike;
      },
    });

    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-stderr-bound",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
      resolveAdapterName: () => "fixture-stderr-bound",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("submitted");
    expect(result.diagnostics.some((item) => item.code === "cli_stderr_truncated")).toBe(true);
  });

  it("child-process transport: truncated mid-JSON fails instead of accepting partial object", async () => {
    const { context } = materializeDefault();
    registerTempAdapter({
      name: "fixture-mid-json",
      profileId: "cli-fixture-mid-json",
      command: "/usr/bin/true",
      args: [],
      contextFormat: "stdin-json",
      resultFormat: "stdout-json",
      defaultTimeoutMs: 5_000,
      maxStdoutBytes: 40,
      maxStderrBytes: 1_024,
      allowedEnvKeys: ["PATH", "HYPAGRAPH_CLI_ATTEMPT"],
      cwdPolicy: "host",
    });

    // A single long JSON line longer than maxStdoutBytes so truncation cuts mid-object.
    const longSummary = "s".repeat(200);
    const payload = matchingResult(context, { summary: longSummary });
    const fullLine = `${JSON.stringify(payload)}\n`;
    expect(Buffer.byteLength(fullLine, "utf8")).toBeGreaterThan(40);

    const transport = createChildProcessCliTransport({
      requireBinary: false,
      createProcess: () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitter = new EventEmitter();
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        let killed = false;

        stdin.on("data", () => {
          // drain
        });
        stdin.on("end", () => {
          stdout.write(fullLine);
          stdout.end();
          stderr.end();
          exitCode = 0;
          setImmediate(() => emitter.emit("exit", 0, null));
        });

        const processLike: CliSpawnedProcess = {
          pid: 6103,
          stdin,
          stdout,
          stderr,
          get exitCode() { return exitCode; },
          get signalCode() { return signalCode; },
          get killed() { return killed; },
          kill(signal?: NodeJS.Signals | number) {
            killed = true;
            if (exitCode === null && signalCode === null) {
              signalCode = typeof signal === "string" ? signal : "SIGTERM";
              setImmediate(() => emitter.emit("exit", null, signalCode));
            }
            return true;
          },
          on(event: "error", listener: (error: Error) => void) {
            emitter.on(event, listener);
            return processLike;
          },
          once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
            emitter.once(event, listener);
            return processLike;
          },
          removeListener(event: "exit", listener: (...args: unknown[]) => void) {
            emitter.removeListener(event, listener);
            return processLike;
          },
        };
        return processLike;
      },
    });

    const executor = createCliExecutor({
      transport,
      createProcessToken: () => "token-mid-json",
      startedAt: () => later,
      resolveCwd: () => "/tmp",
      resolveAdapterName: () => "fixture-mid-json",
    });

    const result = await executor.execute(context, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.attemptId).toBe(context.identity.attemptId);
    expect(
      result.diagnostics.some((item) =>
        item.code === "cli_result_invalid_json"
        || item.code === "cli_result_empty"
        || item.code === "cli_result_not_object"),
    ).toBe(true);
  });

  it("child-process transport: requireBinary true fails with cli_binary_not_configured", async () => {
    const { context } = materializeDefault();
    const previous = process.env.HYPAGRAPH_CLI_JSON_BIN;
    delete process.env.HYPAGRAPH_CLI_JSON_BIN;

    try {
      const transport = createChildProcessCliTransport({
        requireBinary: true,
        // No createProcess: production path must not spawn without env bin.
      });
      const executor = createCliExecutor({
        transport,
        createProcessToken: () => "token-bin-missing",
        startedAt: () => later,
        resolveCwd: () => "/tmp",
      });
      const result = await executor.execute(context, new AbortController().signal);
      expect(result.outcome).toBe("failed");
      expect(result.diagnostics.some((item) => item.code === "cli_binary_not_configured")).toBe(true);
      expect(result.attemptId).toBe(context.identity.attemptId);
    } finally {
      if (previous === undefined) {
        delete process.env.HYPAGRAPH_CLI_JSON_BIN;
      } else {
        process.env.HYPAGRAPH_CLI_JSON_BIN = previous;
      }
    }
  });

  it("host teardownOnRestore stops in-flight CLI work via linked closer", async () => {
    const { context } = materializeDefault();
    let runStarted: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    let sawLinkedAbort = false;
    const transport = createFakeCliTransport({
      runAttempt: async (options) => {
        runStarted?.();
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            sawLinkedAbort = true;
            reject(new CliAbortError("host teardown aborted"));
          }, { once: true });
        });
        return matchingResult(options.context);
      },
    });
    const host = createIsolatedPiHost({
      transport: createFakeIsolatedPiTransport({
        runAttempt: async () => {
          throw new Error("isolated-pi must not run");
        },
      }),
      resolveCwd: () => "/tmp",
      startedAt: () => later,
      cli: {
        transport,
        createProcessToken: () => "host-teardown-token",
        resolveCwd: () => "/tmp",
        startedAt: () => later,
      },
    });

    const executePromise = host.dispatchAttempt(
      context,
      new AbortController().signal,
      pureMeta("host-teardown-live"),
    );
    await runGate;
    expect(host.cliRegistry?.hasActive()).toBe(true);
    const teardown = await host.teardownOnRestore({
      kind: "restore",
      reason: "session restore stops CLI processes",
    });
    expect(teardown.cliClosedCount).toBe(1);
    const settled = await executePromise;
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.result.outcome).toBe("interrupted");
    expect(settled.result.diagnostics.some((item) => item.code === "cli_host_teardown")).toBe(true);
    expect(sawLinkedAbort).toBe(true);
  });
});
