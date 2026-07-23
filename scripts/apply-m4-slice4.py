from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}: {old[:80]!r}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists() or file.read_text() != content:
        file.write_text(content)


replace_once(
    "src/domain/model.ts",
    'export type LoopStatus = "pending" | "running" | "succeeded" | "requires_revision";\nexport type LoopDecision = "complete" | "continue" | "pending";',
    'export type LoopStatus = "pending" | "running" | "succeeded" | "failed" | "requires_revision";\nexport type LoopDecision = "complete" | "continue" | "fail" | "pending";\nexport type LoopExitReason = "success" | "max_iterations";',
)
replace_once(
    "src/domain/model.ts",
    '  exitReason?: "success";',
    '  exitReason?: LoopExitReason;',
)
replace_once(
    "src/domain/model.ts",
    '  | "hypagraph.loop.evaluated"\n  | "hypagraph.loop.completed";',
    '  | "hypagraph.loop.evaluated"\n  | "hypagraph.loop.completed"\n  | "hypagraph.loop.failed";',
)

replace_once(
    "src/domain/projection.ts",
    '        const decision = event.data.decision === "complete" ? "complete" : event.data.decision === "continue" ? "continue" : "pending";',
    '        const decision = event.data.decision === "complete" ? "complete" : event.data.decision === "continue" ? "continue" : event.data.decision === "fail" ? "fail" : "pending";',
)
replace_once(
    "src/domain/projection.ts",
    '''    case "hypagraph.loop.completed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "succeeded";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "success";
      }
      break;
    }
''',
    '''    case "hypagraph.loop.completed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "succeeded";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "success";
      }
      break;
    }
    case "hypagraph.loop.failed": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        runtime.status = "failed";
        runtime.completedAt = event.timestamp;
        runtime.exitReason = "max_iterations";
      }
      break;
    }
''',
)

replace_once(
    "src/domain/reducer.ts",
    '''const isFailedCheckLoopObservation = (state: HypagraphState, nodeId: string, attemptId: string): boolean => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  if ((definition?.kind ?? "task") !== "check") return false;
  if (!state.definition.loops.some((loop) => loop.evaluateAfter === nodeId)) return false;
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (attempt?.checkResult?.status !== "failed") return false;
  return requiredFactsArePresent(state, nodeId, attemptId).length === 0;
};

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (["completed", "failed", "cancelled"].includes(state.phase)) return reject("terminal_workflow", `The workflow is ${state.phase}.`);
''',
    '''const isFailedCheckLoopObservation = (state: HypagraphState, nodeId: string, attemptId: string): boolean => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  if ((definition?.kind ?? "task") !== "check") return false;
  if (!state.definition.loops.some((loop) => loop.evaluateAfter === nodeId)) return false;
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (attempt?.checkResult?.status !== "failed") return false;
  return requiredFactsArePresent(state, nodeId, attemptId).length === 0;
};

const exhaustedLoopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => {
    const runtime = state.runtime.loops[loop.id];
    return loop.nodes.includes(nodeId) && runtime?.status === "failed" && runtime.exitReason === "max_iterations";
  });

export function handleCommand(state: HypagraphState, command: HypagraphCommand): ReducerResult {
  if (["completed", "failed", "cancelled"].includes(state.phase)) {
    if (state.phase === "failed" && "nodeId" in command) {
      const exhausted = exhaustedLoopForNode(state, command.nodeId);
      if (exhausted) return reject("loop_exhausted", `Loop '${exhausted.id}' reached its limit of ${exhausted.maxIterations} iterations. It cannot start another iteration.`);
    }
    return reject("terminal_workflow", `The workflow is ${state.phase}.`);
  }
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''        const completes = command.passed && evaluation.success;
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const decision = completes ? "complete" : canContinue ? "continue" : "pending";
''',
    '''        const completes = command.passed && evaluation.success;
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const exhausted = !completes && !canContinue && !!loopRuntime && evaluation.iteration >= loopRuntime.maxIterations;
        const decision = completes ? "complete" : canContinue ? "continue" : exhausted ? "fail" : "pending";
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''            verificationPassed: command.passed,
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
''',
    '''            verificationPassed: command.passed,
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
            ...(exhausted ? { exitReason: "max_iterations" } : {}),
''',
)
replace_once(
    "src/domain/reducer.ts",
    '''          next = appendReadyEvents(next, events, command);
        }
      }
      if (command.passed) { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
''',
    '''          next = appendReadyEvents(next, events, command);
        } else if (exhausted) {
          next = append(next, events, command, {
            type: "hypagraph.loop.failed",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration,
              maxIterations: loopRuntime.maxIterations,
              exitReason: "max_iterations",
            },
          });
          next = append(next, events, command, {
            type: "hypagraph.workflow.failed",
            data: {
              reason: "loop_failed",
              loopId: evaluation.loopId,
              exitReason: "max_iterations",
            },
          });
        }
      }
      if (command.passed && next.phase !== "failed") { next = appendReadyEvents(next, events, command); next = appendCompletionIfNeeded(next, events, command); }
''',
)

write("tests/loop-max-iterations.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";
import { workflowSummary } from "../src/ui/format.js";

const at = "2026-07-23T05:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Hard loop limit",
  goal: "Stop after two unsuccessful iterations",
  nodes: [
    { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["repair"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["repair", "evaluate"],
    entry: "repair",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [{ ref: `note://${attemptId}`, kind: "note" }], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at });
};

const runIteration = (state: HypagraphState, events: DomainEvent[], iteration: number, passed: boolean): HypagraphState => {
  let next = completeTask(state, events, "repair", `repair-${iteration}`);
  return completeTask(next, events, "evaluate", `evaluate-${iteration}`, [{ name: "tests.passed", type: "boolean", value: passed }]);
};

describe("M4 Slice 4 hard iteration limit", () => {
  it("fails exactly after the final unsuccessful iteration and keeps its history", () => {
    const created = createWorkflow(definition(), at, "workflow-hard-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = runIteration(created.state, events, 1, false);
    expect(state.runtime.loops["repair-loop"]).toMatchObject({ status: "running", currentIteration: 2 });
    state = runIteration(state, events, 2, false);

    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["repair-loop"]).toMatchObject({
      status: "failed",
      currentIteration: 2,
      lastSuccess: false,
      exitReason: "max_iterations",
    });
    expect(state.runtime.loops["repair-loop"]?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue" }),
      expect.objectContaining({ iteration: 2, success: false, decision: "fail" }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ value: false, attemptId: "evaluate-2", iteration: 2 });
    expect(Object.keys(state.runtime.nodes.repair!.attempts).sort()).toEqual(["repair-1", "repair-2"]);
    expect(Object.keys(state.runtime.nodes.evaluate!.attempts).sort()).toEqual(["evaluate-1", "evaluate-2"]);
    expect(events.slice(-4).map((event) => event.type)).toEqual([
      "hypagraph.verification.passed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ]);
    expect(events.at(-3)?.data).toMatchObject({ decision: "fail", exitReason: "max_iterations" });

    const graph = projectGraphView(state);
    expect(graph.phase).toBe("failed");
    expect(graph.loops[0]).toMatchObject({ status: "failed", currentIteration: 2, exitReason: "max_iterations" });
    const summary = workflowSummary(state);
    expect(summary.loops).toEqual([expect.objectContaining({ status: "failed", exitReason: "max_iterations" })]);

    const rejected = handleCommand(state, {
      type: "start-node",
      nodeId: "repair",
      attemptId: "repair-3",
      commandId: "repair-3-start",
      at,
    });
    expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: "loop_exhausted" }] });

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.runtime.loops["repair-loop"]?.exitReason).toBe("max_iterations");
  });

  it("succeeds on the final allowed iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-final-success");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = runIteration(created.state, events, 1, false);
    state = runIteration(state, events, 2, true);

    expect(state.phase).toBe("running");
    expect(state.runtime.loops["repair-loop"]).toMatchObject({ status: "succeeded", currentIteration: 2, exitReason: "success" });
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(events.some((event) => event.type === "hypagraph.loop.failed")).toBe(false);
    expect(events.some((event) => event.type === "hypagraph.workflow.failed")).toBe(false);
  });
});
''')

write("tests/loop-max-iterations-check.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T05:10:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Check hard limit",
  goal: "Fail after one unsuccessful command check",
  nodes: [
    { id: "repair", title: "Repair", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["repair"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "test-command",
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["repair", "test"],
    entry: "repair",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 1,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeRepair = (state: HypagraphState, events: DomainEvent[]): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "repair", attemptId: "repair-1", commandId: "repair-start", at });
  next = apply(next, events, { type: "submit-result", nodeId: "repair", attemptId: "repair-1", evidence: [], commandId: "repair-submit", at });
  next = apply(next, events, { type: "begin-verification", nodeId: "repair", attemptId: "repair-1", commandId: "repair-begin", at });
  return apply(next, events, { type: "complete-verification", nodeId: "repair", attemptId: "repair-1", passed: true, commandId: "repair-complete", at });
};

describe("M4 Slice 4 check exhaustion", () => {
  it("stores the failed check observation and hard-stop events in one verification batch", async () => {
    const created = createWorkflow(definition(), at, "workflow-check-hard-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const ready = completeRepair(created.state, events);
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events, snapshot: ready });
    const resultValue: CheckResult = {
      checkKind: "command",
      attemptId: "test-1",
      startedAt: at,
      completedAt: "2026-07-23T05:10:01.000Z",
      status: "failed",
      exitCode: 1,
      facts: [],
      evidence: [{ ref: "artifact://test-1", kind: "artifact" }],
      stdoutRef: "artifact://test-1/stdout",
      stderrRef: "artifact://test-1/stderr",
    };
    const executor: CheckExecutor = { execute: vi.fn(async () => resultValue) };

    const lifecycle = await runDurableCheckLifecycle({
      state: ready,
      executor,
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.state.phase).toBe("failed");
    expect(lifecycle.state.runtime.loops["repair-loop"]).toMatchObject({ status: "failed", exitReason: "max_iterations" });
    expect(lifecycle.state.runtime.facts["tests.passed"]).toMatchObject({ value: false, attemptId: "test-1", iteration: 1 });
    expect(lifecycle.state.runtime.nodes.test?.attempts["test-1"]?.checkResult).toMatchObject({
      status: "failed",
      stdoutRef: "artifact://test-1/stdout",
      stderrRef: "artifact://test-1/stderr",
    });
    expect(lifecycle.events.slice(-5).map((event) => event.type)).toEqual([
      "hypagraph.check.result-recorded",
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ].slice(-5));
    const stored = store.read(lifecycle.state.workflowId)!;
    expect(stored.events.slice(-4).map((event) => event.type)).toEqual([
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ]);
    expect(replayEvents(stored.events)).toEqual(lifecycle.state);
  });
});
''')

write("tests/pi-loop-max-iterations.test.ts", r'''import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4 Slice 4 Pi hard limit", () => {
  it("shows a terminal failed loop and rejects another entry attempt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hypagraph-loop-limit-"));
    workspaces.push(workspace);
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    hypagraphExtension(pi);

    const ctx = {
      cwd: workspace,
      sessionManager: { getBranch: () => [] },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const runCheck = tools.get("hypagraph_run_check")!;

    await define.execute("define", {
      title: "Pi hard loop limit",
      goal: "Stop after one failed command check",
      nodes: [
        { id: "repair", title: "Repair", requires: ["test"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          kind: "check",
          requires: ["repair"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: process.execPath,
            arguments: ["-e", "process.exit(1)"],
            timeoutMs: 10_000,
            publish: [{ source: "passed", fact: "tests.passed" }],
          },
        },
        { id: "document", title: "Document", requires: ["test"], acceptance: [] },
      ],
      loops: [{
        id: "repair-loop",
        nodes: ["repair", "test"],
        entry: "repair",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "repair" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 1,
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await transition.execute("repair-start", { action: "start", nodeId: "repair" }, signal, undefined, ctx);
    await transition.execute("repair-submit", { action: "submit", nodeId: "repair", evidence: [] }, signal, undefined, ctx);
    await transition.execute("repair-verify", { action: "verify", nodeId: "repair", passed: true }, signal, undefined, ctx);
    const result = await runCheck.execute("test-run", { nodeId: "test" }, signal, undefined, ctx);
    const persisted = result.details.hypagraph as PersistedHypagraph;

    expect(persisted.snapshot.phase).toBe("failed");
    expect(persisted.snapshot.runtime.loops["repair-loop"]).toMatchObject({
      status: "failed",
      currentIteration: 1,
      exitReason: "max_iterations",
    });
    expect(result.details.graph.loops[0]).toMatchObject({ status: "failed", exitReason: "max_iterations" });
    expect(result.content[0].text).toContain("repair-loop: failed - iteration 1/1 - max_iterations");
    await expect(transition.execute("repair-again", { action: "start", nodeId: "repair" }, signal, undefined, ctx)).rejects.toThrow(/loop_exhausted/);
  });
});
''')

replace_once(
    "docs/m4-vertical-slice-plan.md",
    '### Slice 4 - Enforce the hard iteration limit\n\n#### User result',
    '### Slice 4 - Enforce the hard iteration limit\n\n- Status: implemented\n\n#### User result',
)
replace_once(
    "README.md",
    "M4 is the selected next milestone. Slices 1 to 3 add typed loop success conditions, structured iteration-region validation, schema version 3, deterministic feedback continuation, isolated multi-iteration task loops, and check-driven repair loops. A failed evaluation check can publish a valid false observation and start the next iteration. Later slices add hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
    "M4 is the selected next milestone. Slices 1 to 4 add typed loop success conditions, structured iteration-region validation, schema version 3, deterministic feedback continuation, isolated multi-iteration task loops, check-driven repair loops, and terminal hard-limit failure. A final unsuccessful iteration records `max_iterations` and fails the workflow. Later slices add progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
)
replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slices 1 to 3 execute task-based and command-check repair loops across isolated iterations. A failed evaluation check can continue the loop only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select a feedback route manually. Hard-limit failure and patience are not active yet.",
    "M4 Slices 1 to 4 execute bounded task-based and command-check repair loops across isolated iterations. A failed evaluation check can continue the loop only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select a feedback route manually. The final unsuccessful iteration records `max_iterations`, fails the loop, and fails the workflow. Patience is not active yet.",
)
replace_once(
    "docs/event-runtime.md",
    '''## Current M4 limit

M4 Slices 1 to 3 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, and failed evaluation-check observations.

It does not yet support:

- hard-limit failure;
- progress metrics or patience;
- loop cancellation and revision hardening;
- parallel iterations;
- nested or overlapping loops.
''',
    '''## Hard iteration limit

The runtime evaluates the final allowed iteration before it reports exhaustion. A successful final iteration stores `hypagraph.loop.completed`. An unsuccessful final iteration stores these events in order:

1. the verification result;
2. `hypagraph.loop.evaluated` with decision `fail`;
3. `hypagraph.loop.failed` with exit reason `max_iterations`;
4. `hypagraph.workflow.failed`.

The final iteration facts, attempts, evidence, results, and artifact references remain in history. The exhausted loop cannot start again. A node command for that loop returns `loop_exhausted`.

## Current M4 limit

M4 Slices 1 to 4 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, failed evaluation-check observations, and hard-limit failure.

It does not yet support:

- progress metrics or patience;
- loop cancellation and revision hardening;
- parallel iterations;
- nested or overlapping loops.
''',
)

for path in [
    "src/domain/model.ts",
    "src/domain/projection.ts",
    "src/domain/reducer.ts",
    "tests/loop-max-iterations.test.ts",
    "tests/loop-max-iterations-check.test.ts",
    "tests/pi-loop-max-iterations.test.ts",
    "docs/m4-vertical-slice-plan.md",
    "README.md",
    "skills/hypagraph/SKILL.md",
    "docs/event-runtime.md",
]:
    data = Path(path).read_bytes()
    for byte in data:
        if byte < 32 and byte not in (9, 10, 13):
            raise SystemExit(f"Control character 0x{byte:02x} found in {path}")
