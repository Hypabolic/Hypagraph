import { describe, expect, it, vi } from "vitest";
import { ActiveCodeExecutionRegistry } from "../src/code/active-executions.js";
import { MemoryCodeExecutor } from "../src/code/memory-executor.js";
import { prepareCodeNodeDefinition } from "../src/code/prepare.js";
import { QuickJSSandboxExecutor } from "../src/code/sandbox-executor.js";
import { checkSandboxProgramTypeScript } from "../src/code/typescript-check.js";
import { CodeHostBridge } from "../src/code/bridge.js";
import { validateCodeReturnValue } from "../src/code/result-validation.js";
import {
  assessCodeAuthoring,
  createSandboxRuntimeIdentity,
  revisionDoesNotWidenCodeCapabilities,
} from "../src/domain/code-authoring.js";
import { pathMatchesAllowlist, canonicalWorkspacePath } from "../src/code/paths.js";
import { isReadyCodeDecision } from "../src/domain/deterministic-code-dispatch.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { validateAutomaticRevision } from "../src/domain/goal-revision-policy.js";
import type {
  CodeExecutor,
  CodeNodeDefinition,
  CodeResult,
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
  NodeDefinition,
} from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";
import { runDeterministicCodeDispatch } from "../src/pi/deterministic-code-runner.js";
import { projectGraphView } from "../src/graph/projection.js";
import {
  InMemoryWorkflowEventStore,
} from "../src/persistence/event-store.js";

const at = "2026-07-28T12:00:00.000Z";
const finishedAt = "2026-07-28T12:00:05.000Z";

const pureProgram = `
return {
  "compute.sum": (inputs["values.left"] as number) + (inputs["values.right"] as number),
  "compute.ok": true,
};
`;

const preparedCode = (): CodeNodeDefinition => {
  const prepared = prepareCodeNodeDefinition({
    kind: "code",
    execution: {
      version: 1,
      program: pureProgram,
      inputs: ["values.left", "values.right"],
      capabilities: [{ kind: "pure", effectClass: "pure" }],
      timeoutMs: 5_000,
      maxMemoryBytes: 8 * 1024 * 1024,
      maxBridgeCalls: 10,
      maxResultBytes: 64_000,
      runtimeIdentity: createSandboxRuntimeIdentity(),
    },
  });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
  return prepared.definition;
};

const sourceNode = (): NodeDefinition => ({
  id: "seed",
  title: "Seed values",
  kind: "task",
  requires: [],
  acceptance: [],
  produces: [
    { name: "values.left", type: "number", required: true },
    { name: "values.right", type: "number", required: true },
  ],
});

const codeNode = (code: CodeNodeDefinition = preparedCode()): NodeDefinition => ({
  id: "compute",
  title: "Compute sum",
  kind: "code",
  requires: ["seed"],
  acceptance: [],
  produces: [
    { name: "compute.sum", type: "number", required: true },
    { name: "compute.ok", type: "boolean", required: true },
  ],
  code,
});

const definition = (code?: CodeNodeDefinition): HypagraphDefinition => ({
  title: "M6.2 code node",
  goal: "Run a pure code node in the sandbox",
  nodes: [sourceNode(), codeNode(code)],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition = definition()) => {
  const result = createHypagoalWorkflow(source, {
    workflowId: "m6-2-code-workflow",
    goalId: "m6-2-code-goal",
    goalWorkflowId: "m6-2-code-workflow",
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const seedFacts = (state: HypagraphState, priorEvents: DomainEvent[] = []): {
  state: HypagraphState;
  events: DomainEvent[];
} => {
  let next = state;
  const events: DomainEvent[] = [...priorEvents];
  const apply = (command: Parameters<typeof handleCommand>[1]): void => {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    next = result.state;
    events.push(...result.events);
  };
  apply({
    type: "start-node",
    nodeId: "seed",
    attemptId: "seed-1",
    commandId: "seed-start",
    at,
  });
  apply({
    type: "publish-facts",
    nodeId: "seed",
    attemptId: "seed-1",
    facts: [
      { name: "values.left", type: "number", value: 2 },
      { name: "values.right", type: "number", value: 3 },
    ],
    commandId: "seed-publish",
    at,
  });
  apply({
    type: "submit-result",
    nodeId: "seed",
    attemptId: "seed-1",
    evidence: [{ ref: "seed", kind: "note", summary: "seed" }],
    commandId: "seed-submit",
    at,
  });
  apply({
    type: "begin-verification",
    nodeId: "seed",
    attemptId: "seed-1",
    commandId: "seed-begin",
    at,
  });
  apply({
    type: "complete-verification",
    nodeId: "seed",
    attemptId: "seed-1",
    passed: true,
    commandId: "seed-complete",
    at,
  });
  return { state: next, events };
};

const readyCode = (state: HypagraphState) => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyCodeDecision(decision)) {
    throw new Error(`Expected a ready code node, received '${decision.kind}'.`);
  }
  return decision;
};

const seededStore = (state: HypagraphState, events: DomainEvent[]) => {
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events, snapshot: state });
  return store;
};

describe("M6.2 code nodes and sandbox executor", () => {
  it("validates a code node definition and includes the program in the snapshot hash", () => {
    const code = preparedCode();
    const diagnostics = validateDefinition(definition(code));
    expect(diagnostics).toEqual([]);
    const created = create(definition(code));
    const hashWithProgram = created.state.snapshotHash;
    const altered = structuredClone(definition(code));
    altered.nodes[1]!.code!.execution.program = `${pureProgram}\n// changed`;
    const createdAltered = create(altered);
    expect(createdAltered.state.snapshotHash).not.toBe(hashWithProgram);
  });

  it("reports a line-numbered TypeScript error at definition time", () => {
    const result = checkSandboxProgramTypeScript(`
const value: number = "not-a-number";
return { "compute.ok": value };
`, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("code_typescript_error");
    expect(result.diagnostics[0]?.message).toMatch(/Line \d+/);
  });

  it("keeps the reducer pure and runs the sandbox only on the executor side", async () => {
    const created = create();
    const state = seedFacts(created.state).state;
    const start = handleCommand(state, {
      type: "start-code",
      nodeId: "compute",
      attemptId: "code-1",
      commandId: "code-start",
      at,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.state.runtime.nodes.compute?.status).toBe("running");
    // The reducer did not execute the program.
    expect(start.state.runtime.facts["compute.sum"]).toBeUndefined();

    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const request = {
      workflowId: start.state.workflowId,
      revision: start.state.revision,
      nodeId: "compute",
      attemptId: "code-1",
      requestedAt: at,
      definition: structuredClone(start.state.definition.nodes.find((node) => node.id === "compute")!.code!),
      bindings: { "values.left": 2, "values.right": 3 },
      produces: structuredClone(start.state.definition.nodes.find((node) => node.id === "compute")!.produces ?? []),
    };
    const result = await executor.execute(request, new AbortController().signal);
    expect(result.status).toBe("passed");
    expect(result.facts.find((fact) => fact.name === "compute.sum")?.value).toBe(5);
  });

  it("validates the returned value against the produces contract", () => {
    const ok = validateCodeReturnValue(
      { "compute.sum": 5, "compute.ok": true },
      [
        { name: "compute.sum", type: "number", required: true },
        { name: "compute.ok", type: "boolean", required: true },
      ],
    );
    expect(ok.ok).toBe(true);
    const bad = validateCodeReturnValue(
      { "compute.sum": "nope" },
      [{ name: "compute.sum", type: "number", required: true }],
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.diagnostics[0]?.code).toBe("code_return_type_mismatch");
  });

  it("denies undeclared bridge capabilities by default", async () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 5,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const bridge = new CodeHostBridge({ definition: code, maxBridgeCalls: 5 });
    await expect(bridge.call("workspace.read", { path: "src/a.ts" })).rejects.toThrow(/denied by the allowlist/);
    expect(bridge.audit[0]?.status).toBe("denied");
  });

  it("rejects a revision which widens the capability allowlist", () => {
    const previous = preparedCode().execution;
    const next = structuredClone(previous);
    next.capabilities = [
      ...previous.capabilities,
      { kind: "workspace-read", paths: ["src"], effectClass: "observation" },
    ];
    expect(revisionDoesNotWidenCodeCapabilities(previous, next)).toBe(false);

    const previousDefinition = definition();
    const nextDefinition = structuredClone(previousDefinition);
    nextDefinition.nodes[1]!.code!.execution.capabilities = next.capabilities;
    const diagnostics = validateAutomaticRevision(previousDefinition, nextDefinition);
    expect(diagnostics.some((item) => item.code === "automatic_revision_code_capabilities_widened")).toBe(true);
  });

  it("runs a ready code node through durable lifecycle and publishes facts", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    let state = seeded.state;
    const store = seededStore(state, seeded.events);
    const decision = readyCode(state);
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const result = await runDeterministicCodeDispatch({
      state,
      decision,
      dispatchId: "dispatch-code-1",
      attemptId: "code-1",
      at,
      finishedAt,
      store,
      executor,
      registry: new ActiveCodeExecutionRegistry(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("completed");
    expect(result.state.runtime.nodes.compute?.status).toBe("succeeded");
    expect(result.state.runtime.facts["compute.sum"]?.value).toBe(5);
    expect(result.state.runtime.facts["compute.ok"]?.value).toBe(true);
    const types = result.events.map((event) => event.type);
    expect(types).toContain("hypagraph.code.started");
    expect(types).toContain("hypagraph.code.result-recorded");
    expect(types).toContain("hypagraph.fact.published");
    expect(types).toContain("hypagraph.action.completed");
  });

  it("replays a recorded code result and never re-runs the program", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    let state = seeded.state;
    const store = seededStore(state, seeded.events);
    const decision = readyCode(state);
    const execute = vi.fn(async (request, _signal) => {
      const result: CodeResult = {
        attemptId: request.attemptId,
        startedAt: at,
        completedAt: finishedAt,
        status: "passed",
        value: { "compute.sum": 5, "compute.ok": true },
        facts: [
          { name: "compute.sum", type: "number", value: 5 },
          { name: "compute.ok", type: "boolean", value: true },
        ],
        evidence: [],
      };
      return result;
    });
    const executor: CodeExecutor = { id: "spy", version: 1, execute };
    const run = await runDeterministicCodeDispatch({
      state,
      decision,
      dispatchId: "dispatch-code-replay",
      attemptId: "code-replay-1",
      at,
      finishedAt,
      store,
      executor,
      registry: new ActiveCodeExecutionRegistry(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(execute).toHaveBeenCalledTimes(1);

    const events = [...seeded.events, ...run.events];
    const restored = replayEvents(events);
    expect(restored.runtime.nodes.compute?.status).toBe("succeeded");
    expect(restored.runtime.facts["compute.sum"]?.value).toBe(5);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restored.runtime.nodes.compute?.attempts["code-replay-1"]?.codeResult?.status).toBe("passed");
  });

  it("reports a definition-time advisory for a program that is probably more than one node", () => {
    const largeProgram = `return { ${Array.from({ length: 6 }, (_, index) => `"facts.item${index}": ${index}`).join(", ")} };`;
    const code = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: largeProgram.padEnd(2_100, " "),
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 10_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!code.ok) throw new Error(JSON.stringify(code.diagnostics));
    const source: HypagraphDefinition = {
      title: "Large code node",
      goal: "Advisory",
      nodes: [{
        id: "big",
        title: "Big program",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: Array.from({ length: 6 }, (_, index) => ({
          name: `facts.item${index}`,
          type: "number" as const,
          required: true,
        })),
        code: code.definition,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const advisories = assessCodeAuthoring(source);
    expect(advisories.some((item) => item.code === "code_program_probably_multiple_nodes")).toBe(true);
    expect(validateDefinition(source)).toEqual([]);
  });

  it("rejects external-effect capabilities on code nodes", () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{
          kind: "mcp",
          server: "deploy",
          methods: ["ship"],
          effectClass: "external-effect",
        }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 1,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const diagnostics = validateDefinition({
      title: "Bad capability",
      goal: "Reject external effect",
      nodes: [{
        id: "bad",
        title: "Bad",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        code,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    });
    expect(diagnostics.some((item) => item.code === "code_capability_external_effect_denied")).toBe(true);
  });

  it("requires scope.paths for a mutating code program", () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 1,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const diagnostics = validateDefinition({
      title: "Mutation without scope",
      goal: "Require scope",
      nodes: [{
        id: "mutate",
        title: "Mutate",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        code,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    });
    expect(diagnostics.some((item) => item.code === "code_mutation_scope_required")).toBe(true);
  });

  it("exposes code result status on the graph projection", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    let state = seeded.state;
    const store = seededStore(state, seeded.events);
    const decision = readyCode(state);
    const executor = new MemoryCodeExecutor({
      now: () => new Date(finishedAt),
      evaluate: () => ({ "compute.sum": 5, "compute.ok": true }),
    });
    const run = await runDeterministicCodeDispatch({
      state,
      decision,
      dispatchId: "dispatch-code-view",
      attemptId: "code-view-1",
      at,
      finishedAt,
      store,
      executor,
      registry: new ActiveCodeExecutionRegistry(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const view = projectGraphView(run.state);
    const compute = view.nodes.find((node) => node.id === "compute");
    expect(compute?.kind).toBe("code");
    expect(compute?.code?.status).toBe("passed");
  });

  it("rejects undeclared binding access at definition time", () => {
    const typecheck = checkSandboxProgramTypeScript(
      `return { "compute.ok": Boolean(inputs["values.missing"]) };`,
      ["values.left"],
    );
    expect(typecheck.ok).toBe(false);
    if (typecheck.ok) return;
    expect(typecheck.diagnostics[0]?.code).toBe("code_typescript_error");
  });

  it("rejects stored compiled JavaScript when compiledHash does not match the stored bytes", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 2_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const tampered = structuredClone(prepared.definition);
    // Keep compiledHash; change only the stored bytes so resolveExecutableJavaScript rejects.
    tampered.execution.compiledJavaScript =
      `function __hypagraphMain() { return { "compute.ok": false }; }\n__hypagraphMain();`;
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: tampered,
      bindings: {},
      produces: [{ name: "compute.ok", type: "boolean", required: true }],
    }, new AbortController().signal);
    expect(result.status).toBe("error");
    expect(result.error ?? "").toMatch(/compiledJavaScript does not match compiledHash/);
  });

  it("denies path allowlist prefix escapes", () => {
    expect(pathMatchesAllowlist("src/../../etc/passwd", ["src"])).toBe(false);
    expect(pathMatchesAllowlist("src/foo.ts", ["src"])).toBe(true);
    expect(canonicalWorkspacePath("src/../../etc/passwd")).toBeUndefined();
  });

  it("fails closed when a mutating program has no workspace root", async () => {
    const code = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!code.ok) throw new Error(JSON.stringify(code.diagnostics));
    const definition: HypagraphDefinition = {
      title: "Mutate",
      goal: "Fail closed",
      nodes: [{
        id: "mutate",
        title: "Mutate",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        scope: { paths: ["src"] },
        code: code.definition,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(definition, {
      workflowId: "mutate-workflow",
      goalId: "mutate-goal",
      goalWorkflowId: "mutate-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = seededStore(created.state, created.events);
    const decision = readyCode(created.state);
    const run = await runDeterministicCodeDispatch({
      state: created.state,
      decision,
      dispatchId: "dispatch-mutate",
      attemptId: "mutate-1",
      at,
      finishedAt,
      store,
      executor: new MemoryCodeExecutor({
        now: () => new Date(finishedAt),
        evaluate: () => ({ "compute.ok": true }),
      }),
      registry: new ActiveCodeExecutionRegistry(),
      // rootDirectory intentionally omitted
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.result?.status).toBe("failed");
    expect(run.result?.error ?? "").toMatch(/workspace root/i);
  });

  it("allows capability allowlist narrowing on automatic revision", () => {
    const previous = preparedCode().execution;
    const next = structuredClone(previous);
    next.capabilities = [
      { kind: "workspace-write", paths: ["src", "lib"], effectClass: "workspace-mutation" },
    ];
    const narrower = structuredClone(next);
    narrower.capabilities = [
      { kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" },
    ];
    expect(revisionDoesNotWidenCodeCapabilities(
      { ...previous, capabilities: next.capabilities },
      { ...previous, capabilities: narrower.capabilities },
    )).toBe(true);
    expect(revisionDoesNotWidenCodeCapabilities(
      { ...previous, capabilities: narrower.capabilities },
      { ...previous, capabilities: next.capabilities },
    )).toBe(false);
  });

  it("type-checks programs through normalizeDefinition", async () => {
    const { normalizeDefinition, CodeDefinitionError } = await import("../src/pi/definition.js");
    expect(() => normalizeDefinition({
      title: "Bad program",
      goal: "Fail typecheck",
      nodes: [{
        id: "bad",
        title: "Bad",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        code: {
          kind: "code",
          execution: {
            version: 1,
            program: `const x: number = "no"; return { "compute.ok": true };`,
            inputs: [],
            capabilities: [{ kind: "pure", effectClass: "pure" }],
            timeoutMs: 1_000,
            maxMemoryBytes: 1_000_000,
            maxBridgeCalls: 0,
            maxResultBytes: 1_000,
            runtimeIdentity: createSandboxRuntimeIdentity(),
          },
        },
      }],
      policy: { mode: "guided", requireEvidence: false },
    } as never)).toThrow(CodeDefinitionError);

    const ok = normalizeDefinition({
      title: "Good program",
      goal: "Pass typecheck",
      nodes: [{
        id: "good",
        title: "Good",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        code: {
          kind: "code",
          execution: {
            version: 1,
            program: `return { "compute.ok": true };`,
            inputs: [],
            capabilities: [{ kind: "pure", effectClass: "pure" }],
            timeoutMs: 1_000,
            maxMemoryBytes: 1_000_000,
            maxBridgeCalls: 0,
            maxResultBytes: 1_000,
            runtimeIdentity: createSandboxRuntimeIdentity(),
          },
        },
      }],
      policy: { mode: "guided", requireEvidence: false },
    } as never);
    expect(ok.nodes[0]?.code?.execution.compiledJavaScript).toBeTruthy();
    expect(ok.nodes[0]?.code?.execution.compiledHash).toBeTruthy();
  });

  it("parses porcelain renames and reports advisories on workflow summary", async () => {
    const { parsePorcelainZ } = await import("../src/code/scope-verification.js");
    // Real git status -z order for renames: NEW path first, OLD path second.
    const paths = parsePorcelainZ("R  new.ts\0old.ts\0 M src/a.ts\0");
    expect(paths).toContain("new.ts");
    expect(paths).toContain("old.ts");
    expect(paths).toContain("src/a.ts");

    const large = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { ${Array.from({ length: 6 }, (_, i) => `"facts.item${i}": ${i}`).join(", ")} };`.padEnd(2_100, " "),
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 10_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!large.ok) throw new Error(JSON.stringify(large.diagnostics));
    const source: HypagraphDefinition = {
      title: "Advisory surface",
      goal: "Show advisories",
      nodes: [{
        id: "big",
        title: "Big",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: Array.from({ length: 6 }, (_, i) => ({ name: `facts.item${i}`, type: "number" as const, required: true })),
        code: large.definition,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(source, {
      workflowId: "adv-workflow",
      goalId: "adv-goal",
      goalWorkflowId: "adv-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const { workflowSummary, renderWorkflow } = await import("../src/ui/format.js");
    const summary = workflowSummary(created.state);
    expect(Array.isArray(summary.codeAuthoringAdvisories)).toBe(true);
    expect((summary.codeAuthoringAdvisories as unknown[]).length).toBeGreaterThan(0);
    expect(renderWorkflow(created.state)).toMatch(/Code authoring advisories/);
  });

  it("enforces maxBridgeCalls and records an error audit entry", async () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "workspace-read", paths: ["src"], effectClass: "observation" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 2,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const bridge = new CodeHostBridge({
      definition: code,
      maxBridgeCalls: 2,
      handlers: {
        "workspace.read": () => "ok",
      },
    });
    expect(bridge.callSync("workspace.read", { path: "src/a.ts" })).toBe("ok");
    expect(bridge.callSync("workspace.read", { path: "src/b.ts" })).toBe("ok");
    expect(() => bridge.callSync("workspace.read", { path: "src/c.ts" })).toThrow(/bridge-call limit/);
    expect(bridge.audit.at(-1)?.status).toBe("error");
  });

  it("rejects maxResultBytes overflow in the sandbox executor", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true, "compute.payload": "x".repeat(200) };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 2_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 40,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: prepared.definition,
      bindings: {},
      produces: [
        { name: "compute.ok", type: "boolean", required: true },
        { name: "compute.payload", type: "string", required: true },
      ],
    }, new AbortController().signal);
    expect(result.status).toBe("error");
    expect(result.error ?? "").toMatch(/maxResultBytes/);
  });

  it("times out an infinite loop program", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `while (true) {}\nreturn { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 50,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: prepared.definition,
      bindings: {},
      produces: [{ name: "compute.ok", type: "boolean", required: true }],
    }, new AbortController().signal);
    expect(result.status).toBe("timed_out");
  }, 15_000);

  it("cancels when AbortSignal is already aborted before execute", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 5_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: prepared.definition,
      bindings: {},
      produces: [{ name: "compute.ok", type: "boolean", required: true }],
    }, controller.signal);
    expect(result.status).toBe("cancelled");
  });

  it("rejects external-effect capabilities again at the bridge", async () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{
          kind: "mcp",
          server: "deploy",
          methods: ["ship"],
          effectClass: "external-effect",
        }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 5,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const bridge = new CodeHostBridge({
      definition: code,
      maxBridgeCalls: 5,
      handlers: { "mcp.deploy.ship": () => true },
    });
    expect(() => bridge.callSync("mcp.deploy.ship", {})).toThrow(/not permitted on a code node/);
    expect(bridge.audit[0]?.status).toBe("denied");
  });

  it("matches MCP actions exactly and rejects dotted methods", async () => {
    const code: CodeNodeDefinition = {
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{
          kind: "mcp",
          server: "linear",
          methods: ["list"],
          effectClass: "observation",
        }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 5,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    };
    const bridge = new CodeHostBridge({
      definition: code,
      maxBridgeCalls: 5,
      handlers: {
        "mcp.linear.list": () => [],
      },
    });
    expect(bridge.callSync("mcp.linear.list", {})).toEqual([]);
    await expect(bridge.call("mcp.linear.list.extra", {})).rejects.toThrow(/denied by the allowlist/);
    await expect(bridge.call("mcp.linear.list.nested", {})).rejects.toThrow(/denied by the allowlist/);
  });

  it("fails scope verification for a path outside the allowlist", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const { verifyCodeScope, captureScopeBaseline } = await import("../src/code/scope-verification.js");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-scope-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "docs-out.txt"), "outside scope\n");
    const baseline = await captureScopeBaseline(root);
    // docs-out.txt is already dirty at baseline; leave it unchanged so it is exempt.
    writeFileSync(join(root, "outside.ts"), "introduced outside allowlist\n");
    const scope = await verifyCodeScope({
      rootDirectory: root,
      scopePaths: ["src"],
      capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
      baseline,
    });
    expect(scope.passed).toBe(false);
    expect(scope.error ?? "").toMatch(/outside\.ts/);
    expect(scope.baselinePaths).toEqual(expect.arrayContaining(baseline.paths));
  });

  it("detects further modification of a baseline-dirty path by content hash", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const { verifyCodeScope, captureScopeBaseline } = await import("../src/code/scope-verification.js");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-baseline-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=old\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=dirty\n");
    const baseline = await captureScopeBaseline(root);
    expect(baseline.paths).toContain("secrets/config.env");
    // Program further modifies the baseline-dirty secret.
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=stolen\n");
    const scope = await verifyCodeScope({
      rootDirectory: root,
      scopePaths: ["src"],
      capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
      baseline,
    });
    expect(scope.passed).toBe(false);
    expect(scope.baselinePaths).toContain("secrets/config.env");
    expect(scope.changedPaths).toContain("secrets/config.env");
    expect(scope.error ?? "").toMatch(/secrets\/config\.env/);
  });

  it("detects a baseline-dirty path the program returns to clean", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const { verifyCodeScope, captureScopeBaseline } = await import("../src/code/scope-verification.js");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-revert-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=committed\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=dirty\n");
    const baseline = await captureScopeBaseline(root);
    expect(baseline.paths).toContain("secrets/config.env");
    // Program restores the committed bytes. Git status no longer lists the path.
    writeFileSync(join(root, "secrets", "config.env"), "TOKEN=committed\n");
    const scope = await verifyCodeScope({
      rootDirectory: root,
      scopePaths: ["src"],
      capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
      baseline,
    });
    expect(scope.passed).toBe(false);
    expect(scope.changedPaths).toContain("secrets/config.env");
    expect(scope.error ?? "").toMatch(/secrets\/config\.env/);
  });

  it("reports both rename paths from real git mv against declared scope", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const { verifyCodeScope, captureScopeBaseline } = await import("../src/code/scope-verification.js");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-rename-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "docs", ".gitkeep"), "\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });
    const baseline = await captureScopeBaseline(root);
    spawnSync("git", ["mv", "src/a.ts", "docs/a.ts"], { cwd: root });
    const scope = await verifyCodeScope({
      rootDirectory: root,
      scopePaths: ["src"],
      capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
      baseline,
    });
    expect(scope.passed).toBe(false);
    expect(scope.changedPaths).toEqual(expect.arrayContaining(["docs/a.ts", "src/a.ts"]));
  });

  it("rejects undeclared binding access when inputs are empty", () => {
    // Bracket access on empty interface without index signature is a definition-time error.
    const direct = checkSandboxProgramTypeScript(
      `return { "compute.ok": Boolean(inputs["values.left"]) };`,
      [],
    );
    expect(direct.ok).toBe(false);
  });

  it("pins runtime identity versions to package reality", async () => {
    const ts = await import("typescript");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const {
      SANDBOX_QUICKJS_VERSION,
      SANDBOX_TYPESCRIPT_VERSION,
      createSandboxRuntimeIdentity: createIdentity,
      pinnedSandboxRuntimeIdentity,
      runtimeIdentityMatches,
    } = await import("../src/domain/sandbox-runtime-identity.js");
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(SANDBOX_TYPESCRIPT_VERSION).toBe(ts.default.version);
    expect(SANDBOX_QUICKJS_VERSION).toBe(pkg.dependencies["quickjs-emscripten-core"]);
    const identity = pinnedSandboxRuntimeIdentity(["values.left"]);
    expect(runtimeIdentityMatches(identity, pinnedSandboxRuntimeIdentity(["values.left"]))).toBe(true);
    expect(runtimeIdentityMatches(identity, pinnedSandboxRuntimeIdentity([]))).toBe(false);
    // Default create equals the empty-inputs pin so hand-built fixtures remain executable.
    expect(runtimeIdentityMatches(createIdentity(), pinnedSandboxRuntimeIdentity([]))).toBe(true);
  });

  it("rejects a mismatched runtime identity at execute time", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 1_000,
        maxMemoryBytes: 1_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const tampered = structuredClone(prepared.definition);
    tampered.execution.runtimeIdentity = {
      ...tampered.execution.runtimeIdentity,
      quickjsVersion: "0.0.1",
    };
    const executor = new QuickJSSandboxExecutor({ now: () => new Date(finishedAt) });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: tampered,
      bindings: {},
      produces: [{ name: "compute.ok", type: "boolean", required: true }],
    }, new AbortController().signal);
    expect(result.status).toBe("error");
    expect(result.error ?? "").toMatch(/runtime identity/i);
  });

  it("ignores author-supplied runtime identity overrides during prepare", async () => {
    const { normalizeDefinition } = await import("../src/pi/definition.js");
    const { SANDBOX_QUICKJS_VERSION } = await import("../src/domain/sandbox-runtime-identity.js");
    const ok = normalizeDefinition({
      title: "Identity pin",
      goal: "Host pin only",
      nodes: [{
        id: "good",
        title: "Good",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        code: {
          kind: "code",
          execution: {
            version: 1,
            program: `return { "compute.ok": true };`,
            inputs: [],
            capabilities: [{ kind: "pure", effectClass: "pure" }],
            timeoutMs: 1_000,
            maxMemoryBytes: 1_000_000,
            maxBridgeCalls: 0,
            maxResultBytes: 1_000,
          },
        },
      }],
      policy: { mode: "guided", requireEvidence: false },
    } as never);
    expect(ok.nodes[0]?.code?.execution.runtimeIdentity.quickjsVersion).toBe(SANDBOX_QUICKJS_VERSION);
    expect(ok.nodes[0]?.code?.execution.runtimeIdentity.compilerOptions.strict).toBe(true);
  });

  it("cancels all active code executions from the registry", () => {
    const registry = new ActiveCodeExecutionRegistry();
    const first = registry.register({
      workflowId: "w1",
      nodeId: "n1",
      attemptId: "a1",
      startedAt: at,
    });
    const second = registry.register({
      workflowId: "w2",
      nodeId: "n2",
      attemptId: "a2",
      startedAt: at,
    });
    expect(registry.cancelAll("session_shutdown")).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.hasActive()).toBe(false);
  });

  it("handles run-ready-code in continuation prompts and tools", async () => {
    const { continuationSystemPrompt, requiredContinuationTools } = await import("../src/pi/hypagoal-continuation.js");
    const action = {
      kind: "run-ready-code" as const,
      goalId: "g",
      workflowId: "w",
      revision: 1,
      nodeId: "compute",
    };
    const tools = requiredContinuationTools(action as never);
    expect(tools).toEqual(["hypagraph_read"]);
    const created = create();
    const pending = {
      operationId: "op-1",
      requestedOrdinal: 1,
      action: {
        ...action,
      },
    };
    const prompt = continuationSystemPrompt(pending as never, created.state);
    expect(prompt).toMatch(/deterministic lane/);
    expect(prompt).not.toMatch(/Evaluate gate/);
  });

  it("runs a prepared program through the default MemoryCodeExecutor path", async () => {
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true, "compute.sum": 7 };`,
        inputs: [],
        capabilities: [{ kind: "pure", effectClass: "pure" }],
        timeoutMs: 2_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 4_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const executor = new MemoryCodeExecutor({ now: () => new Date(finishedAt) });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: prepared.definition,
      bindings: {},
      produces: [
        { name: "compute.ok", type: "boolean", required: true },
        { name: "compute.sum", type: "number", required: true },
      ],
    }, new AbortController().signal);
    expect(result.status).toBe("passed");
    expect(result.facts.find((fact) => fact.name === "compute.sum")?.value).toBe(7);
  });

  it("cancels mid-eval when a bridge handler aborts the signal", async () => {
    const controller = new AbortController();
    const prepared = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `
host.call("workspace.read", { path: "src/a.ts" });
while (true) {}
return { "compute.ok": true };
`,
        inputs: [],
        capabilities: [{ kind: "workspace-read", paths: ["src"], effectClass: "observation" }],
        timeoutMs: 10_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 2,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const executor = new QuickJSSandboxExecutor({
      now: () => new Date(finishedAt),
      handlers: {
        "workspace.read": () => {
          controller.abort();
          return "ok";
        },
      },
    });
    const result = await executor.execute({
      workflowId: "w",
      revision: 1,
      nodeId: "n",
      attemptId: "a",
      requestedAt: at,
      definition: prepared.definition,
      bindings: {},
      produces: [{ name: "compute.ok", type: "boolean", required: true }],
    }, controller.signal);
    expect(result.status).toBe("cancelled");
  }, 15_000);

  it("drives scope verification through durable lifecycle and replays baselinePaths", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-lifecycle-scope-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });
    writeFileSync(join(root, "pre-existing.txt"), "already dirty\n");

    const code = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
        timeoutMs: 2_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!code.ok) throw new Error(JSON.stringify(code.diagnostics));
    const definition: HypagraphDefinition = {
      title: "Lifecycle scope",
      goal: "Fail scope through durable path",
      nodes: [{
        id: "mutate",
        title: "Mutate",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        scope: { paths: ["src"] },
        code: code.definition,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(definition, {
      workflowId: "lifecycle-scope-workflow",
      goalId: "lifecycle-scope-goal",
      goalWorkflowId: "lifecycle-scope-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = seededStore(created.state, created.events);
    const decision = readyCode(created.state);
    const run = await runDeterministicCodeDispatch({
      state: created.state,
      decision,
      dispatchId: "dispatch-lifecycle-scope",
      attemptId: "mutate-1",
      at,
      finishedAt,
      store,
      rootDirectory: root,
      executor: new MemoryCodeExecutor({
        now: () => new Date(finishedAt),
        evaluate: () => {
          writeFileSync(join(root, "outside.ts"), "introduced outside scope\n");
          return { "compute.ok": true };
        },
      }),
      registry: new ActiveCodeExecutionRegistry(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.result?.status).toBe("failed");
    expect(run.result?.scopeVerification?.passed).toBe(false);
    expect(run.result?.scopeVerification?.baselinePaths).toEqual(
      expect.arrayContaining(["pre-existing.txt"]),
    );
    expect(run.result?.error ?? "").toMatch(/outside\.ts/);

    const replayed = replayEvents([...created.events, ...run.events]);
    const attempt = replayed.runtime.nodes.mutate?.attempts["mutate-1"];
    expect(attempt?.codeResult?.scopeVerification?.baselinePaths).toEqual(
      expect.arrayContaining(["pre-existing.txt"]),
    );
    expect(attempt?.codeResult?.scopeVerification?.passed).toBe(false);
  });

  it("attaches scope verification when a mutating program fails", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "hypagraph-failed-scope-"));
    spawnSync("git", ["init"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root });

    const code = prepareCodeNodeDefinition({
      kind: "code",
      execution: {
        version: 1,
        program: `return { "compute.ok": true };`,
        inputs: [],
        capabilities: [{ kind: "workspace-write", paths: ["src"], effectClass: "workspace-mutation" }],
        timeoutMs: 2_000,
        maxMemoryBytes: 2_000_000,
        maxBridgeCalls: 0,
        maxResultBytes: 1_000,
        runtimeIdentity: createSandboxRuntimeIdentity(),
      },
    });
    if (!code.ok) throw new Error(JSON.stringify(code.diagnostics));
    const definition: HypagraphDefinition = {
      title: "Failed program scope",
      goal: "Still verify after failure",
      nodes: [{
        id: "mutate",
        title: "Mutate",
        kind: "code",
        requires: [],
        acceptance: [],
        produces: [{ name: "compute.ok", type: "boolean", required: true }],
        scope: { paths: ["src"] },
        code: code.definition,
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(definition, {
      workflowId: "failed-scope-workflow",
      goalId: "failed-scope-goal",
      goalWorkflowId: "failed-scope-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = seededStore(created.state, created.events);
    const decision = readyCode(created.state);
    const run = await runDeterministicCodeDispatch({
      state: created.state,
      decision,
      dispatchId: "dispatch-failed-scope",
      attemptId: "mutate-fail-1",
      at,
      finishedAt,
      store,
      rootDirectory: root,
      executor: new MemoryCodeExecutor({
        now: () => new Date(finishedAt),
        evaluate: () => {
          writeFileSync(join(root, "leak.ts"), "wrote then failed\n");
          throw new Error("program exploded after write");
        },
      }),
      registry: new ActiveCodeExecutionRegistry(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.result?.status).not.toBe("passed");
    expect(run.result?.scopeVerification).toBeDefined();
    expect(run.result?.scopeVerification?.passed).toBe(false);
    expect(run.result?.scopeVerification?.error ?? "").toMatch(/leak\.ts/);
  });
});
