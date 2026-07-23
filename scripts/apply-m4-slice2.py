from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists() or file.read_text() != content:
        file.write_text(content)


replace_once(
    "src/domain/model.ts",
    'export type LoopDecision = "complete" | "pending";',
    'export type LoopDecision = "complete" | "continue" | "pending";',
)

replace_once(
    "src/domain/projection.ts",
    '''    case "hypagraph.loop.iteration-started": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      if (runtime) {
        const iteration = Number(event.data.iteration);
        runtime.status = "running";
        runtime.currentIteration = iteration;
        runtime.startedAt ??= event.timestamp;
        runtime.iterations.push({ iteration, startedAt: event.timestamp, factsUsed: [] });
      }
      break;
    }
''',
    '''    case "hypagraph.loop.iteration-started": {
      const loopId = event.loopId ?? String(event.data.loopId ?? "");
      const runtime = next.runtime.loops[loopId];
      const definition = next.definition.loops.find((loop) => loop.id === loopId);
      if (runtime && definition) {
        const iteration = Number(event.data.iteration);
        if (iteration > 1) {
          const loopNodes = new Set(definition.nodes);
          for (const [name, fact] of Object.entries(next.runtime.facts)) {
            if (loopNodes.has(fact.producerNodeId)) delete next.runtime.facts[name];
          }
          for (const nodeId of definition.nodes) {
            const nodeRuntime = next.runtime.nodes[nodeId];
            if (!nodeRuntime) continue;
            nodeRuntime.status = "pending";
            delete nodeRuntime.currentAttemptId;
            nodeRuntime.evidence = [];
            delete nodeRuntime.blockedReason;
            delete next.runtime.routes[nodeId];
          }
        }
        runtime.status = "running";
        runtime.currentIteration = iteration;
        runtime.startedAt ??= event.timestamp;
        if (!runtime.iterations.some((item) => item.iteration === iteration)) {
          runtime.iterations.push({ iteration, startedAt: event.timestamp, factsUsed: [] });
        }
      }
      break;
    }
''',
)

replace_once(
    "src/domain/projection.ts",
    '        const decision = event.data.decision === "complete" ? "complete" : "pending";',
    '        const decision = event.data.decision === "complete" ? "complete" : event.data.decision === "continue" ? "continue" : "pending";',
)

replace_once(
    "src/domain/reducer.ts",
    '''      if (evaluation) {
        next = append(next, events, command, {
          type: "hypagraph.loop.evaluated",
          loopId: evaluation.loopId,
          data: {
            loopId: evaluation.loopId,
            iteration: evaluation.iteration,
            success: evaluation.success,
            factsUsed: structuredClone(evaluation.factsUsed),
            semanticsVersion: evaluation.semanticsVersion,
            decision: evaluation.success ? "complete" : "pending",
          },
        });
        if (evaluation.success) next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
      }
''',
    '''      if (evaluation) {
        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const decision = evaluation.success ? "complete" : canContinue ? "continue" : "pending";
        next = append(next, events, command, {
          type: "hypagraph.loop.evaluated",
          loopId: evaluation.loopId,
          data: {
            loopId: evaluation.loopId,
            iteration: evaluation.iteration,
            success: evaluation.success,
            factsUsed: structuredClone(evaluation.factsUsed),
            semanticsVersion: evaluation.semanticsVersion,
            decision,
          },
        });
        if (evaluation.success) {
          next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
        } else if (canContinue) {
          next = append(next, events, command, {
            type: "hypagraph.loop.iteration-started",
            loopId: evaluation.loopId,
            data: {
              loopId: evaluation.loopId,
              iteration: evaluation.iteration + 1,
              previousIteration: evaluation.iteration,
              maxIterations: loopRuntime.maxIterations,
              reason: "feedback",
            },
          });
          next = appendReadyEvents(next, events, command);
        }
      }
''',
)

replace_once(
    "tests/loop-slice-one.test.ts",
    '''  it("keeps downstream work blocked when the success condition is false", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-false");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: false }]);
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1, lastSuccess: false });
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(events.at(-1)?.type).toBe("hypagraph.loop.evaluated");
  });
''',
    '''  it("starts iteration 2 when the success condition is false", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-false");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: false }]);
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(state.runtime.loops.repair?.iterations[0]).toMatchObject({ iteration: 1, decision: "continue", success: false });
    expect(state.runtime.loops.repair?.iterations[1]).toMatchObject({ iteration: 2 });
    expect(state.runtime.nodes.implement?.status).toBe("ready");
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(state.runtime.facts["tests.passed"]).toBeUndefined();
    expect(events.filter((event) => event.loopId === "repair").map((event) => event.type)).toEqual([
      "hypagraph.loop.iteration-started",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
    ]);
  });
''',
)

write("tests/loop-slice-two.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, EvidenceReference, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-23T01:00:00.000Z";
const evidence = (name: string): EvidenceReference[] => [{ ref: `note://${name}`, kind: "note", summary: name }];

const definition = (): HypagraphDefinition => ({
  title: "Two loop iterations",
  goal: "Reset one failed repair iteration and complete the next iteration",
  nodes: [
    {
      id: "implement",
      title: "Implement",
      requires: ["test"],
      acceptance: [],
      produces: [{ name: "repair.use_a", type: "boolean", required: true }],
    },
    {
      id: "choose",
      title: "Choose repair",
      kind: "gate",
      requires: ["implement"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "repair.use_a" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["repair-a"],
        onFalse: ["repair-b"],
      },
    },
    { id: "repair-a", title: "Repair A", requires: ["choose"], acceptance: [] },
    { id: "repair-b", title: "Repair B", requires: ["choose"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      requires: ["repair-a", "repair-b"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "choose", "repair-a", "repair-b", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
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
  prefix: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${prefix}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${prefix}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: evidence(prefix), commandId: `${prefix}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${prefix}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${prefix}-complete`, at });
};

describe("M4 Slice 2 feedback continuation", () => {
  it("resets the loop and runs a second task iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-two");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = completeTask(created.state, events, "implement", "implement-1", "implement-1", [{ name: "repair.use_a", type: "boolean", value: true }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "choose", commandId: "choose-1", at });
    expect(state.runtime.routes.choose?.outcomeId).toBe("true");
    expect(state.runtime.nodes["repair-b"]?.status).toBe("skipped");
    state = completeTask(state, events, "repair-a", "repair-a-1", "repair-a-1");
    state = completeTask(state, events, "test", "test-1", "test-1", [{ name: "tests.passed", type: "boolean", value: false }]);

    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue", factsUsed: ["tests.passed"] }),
      expect.objectContaining({ iteration: 2 }),
    ]);
    expect(state.runtime.nodes.implement?.status).toBe("ready");
    expect(state.runtime.nodes.choose?.status).toBe("pending");
    expect(state.runtime.nodes["repair-a"]?.status).toBe("pending");
    expect(state.runtime.nodes["repair-b"]?.status).toBe("pending");
    expect(state.runtime.nodes.test?.status).toBe("pending");
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(state.runtime.routes.choose).toBeUndefined();
    expect(state.runtime.facts["repair.use_a"]).toBeUndefined();
    expect(state.runtime.facts["tests.passed"]).toBeUndefined();
    expect(state.runtime.nodes.implement?.currentAttemptId).toBeUndefined();
    expect(state.runtime.nodes.implement?.evidence).toEqual([]);
    expect(state.runtime.nodes.implement?.attempts["implement-1"]).toMatchObject({ iteration: 1, status: "succeeded", evidence: evidence("implement-1") });
    expect(state.runtime.nodes.test?.attempts["test-1"]).toMatchObject({ iteration: 1, status: "succeeded", evidence: evidence("test-1") });

    const staleFact = handleCommand(state, {
      type: "publish-facts",
      nodeId: "test",
      attemptId: "test-1",
      facts: [{ name: "tests.passed", type: "boolean", value: true }],
      commandId: "stale-fact",
      at,
    });
    expect(staleFact).toMatchObject({ ok: false, diagnostics: [{ code: "stale_fact_attempt" }] });
    const staleResult = handleCommand(state, { type: "submit-result", nodeId: "test", attemptId: "test-1", evidence: [], commandId: "stale-result", at });
    expect(staleResult).toMatchObject({ ok: false, diagnostics: [{ code: "stale_attempt" }] });

    state = completeTask(state, events, "implement", "implement-2", "implement-2", [{ name: "repair.use_a", type: "boolean", value: false }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "choose", commandId: "choose-2", at });
    expect(state.runtime.routes.choose?.outcomeId).toBe("false");
    expect(state.runtime.nodes["repair-a"]?.status).toBe("skipped");
    state = completeTask(state, events, "repair-b", "repair-b-2", "repair-b-2");
    state = completeTask(state, events, "test", "test-2", "test-2", [{ name: "tests.passed", type: "boolean", value: true }]);

    expect(state.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue" }),
      expect.objectContaining({ iteration: 2, success: true, decision: "complete" }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(state.runtime.nodes.implement?.attempts["implement-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.implement?.attempts["implement-2"]?.iteration).toBe(2);
    expect(state.runtime.nodes.test?.attempts["test-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.test?.attempts["test-2"]?.iteration).toBe(2);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ iteration: 2, attemptId: "test-2", value: true });

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.snapshotHash).toBe(state.snapshotHash);
  });
});
''')

write("tests/pi-loop-slice-two.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";
import type { PersistedEventBatch } from "../src/persistence/event-store.js";
import type { PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

describe("M4 Slice 2 Pi loop path", () => {
  it("runs two task iterations through the registered tools", async () => {
    const tools = new Map<string, RegisteredTool>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    } as unknown as ExtensionAPI;
    hypagraphExtension(pi);

    const ctx = {
      cwd: process.cwd(),
      sessionManager: { getBranch: () => [] },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);

    await define.execute("define", {
      title: "Pi feedback loop",
      goal: "Run two task iterations",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          requires: ["implement"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
        },
        { id: "document", title: "Document", requires: ["test"], acceptance: [] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await call("start-implement-1", { action: "start", nodeId: "implement" });
    await call("submit-implement-1", { action: "submit", nodeId: "implement", evidence: [{ ref: "note://implement-1", kind: "note" }] });
    await call("verify-implement-1", { action: "verify", nodeId: "implement", passed: true });
    await call("start-test-1", { action: "start", nodeId: "test" });
    await call("publish-test-1", { action: "publish", nodeId: "test", facts: [{ name: "tests.passed", type: "boolean", value: false }] });
    await call("submit-test-1", { action: "submit", nodeId: "test", evidence: [{ ref: "note://test-1", kind: "note" }] });
    const firstResult = await call("verify-test-1", { action: "verify", nodeId: "test", passed: true });
    const first = firstResult.details.hypagraph as PersistedHypagraph;

    expect(first.snapshot.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(first.snapshot.runtime.nodes.implement?.status).toBe("ready");
    expect(first.snapshot.runtime.facts["tests.passed"]).toBeUndefined();
    const continuationBatch = entries
      .map((entry) => entry.data as PersistedEventBatch)
      .find((batch) => Array.isArray(batch.events) && batch.events.some((event) => event.type === "hypagraph.loop.evaluated" && event.data.decision === "continue"));
    expect(continuationBatch?.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.verification.passed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]));

    await call("start-implement-2", { action: "start", nodeId: "implement" });
    await call("submit-implement-2", { action: "submit", nodeId: "implement", evidence: [{ ref: "note://implement-2", kind: "note" }] });
    await call("verify-implement-2", { action: "verify", nodeId: "implement", passed: true });
    await call("start-test-2", { action: "start", nodeId: "test" });
    await call("publish-test-2", { action: "publish", nodeId: "test", facts: [{ name: "tests.passed", type: "boolean", value: true }] });
    await call("submit-test-2", { action: "submit", nodeId: "test", evidence: [{ ref: "note://test-2", kind: "note" }] });
    const finalResult = await call("verify-test-2", { action: "verify", nodeId: "test", passed: true });
    const final = finalResult.details.hypagraph as PersistedHypagraph;

    expect(final.snapshot.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(final.snapshot.runtime.nodes.document?.status).toBe("ready");
    const implementAttempts = Object.values(final.snapshot.runtime.nodes.implement!.attempts);
    const testAttempts = Object.values(final.snapshot.runtime.nodes.test!.attempts);
    expect(implementAttempts).toHaveLength(2);
    expect(testAttempts).toHaveLength(2);
    expect(implementAttempts.map((attempt) => attempt.iteration).sort()).toEqual([1, 2]);
    expect(testAttempts.map((attempt) => attempt.iteration).sort()).toEqual([1, 2]);
    expect(new Set(implementAttempts.map((attempt) => attempt.attemptId)).size).toBe(2);
    expect(new Set(testAttempts.map((attempt) => attempt.attemptId)).size).toBe(2);
  });
});
''')

replace_once(
    "docs/m4-vertical-slice-plan.md",
    '''### Slice 2 - Follow feedback and start iteration 2

#### User result
''',
    '''### Slice 2 - Follow feedback and start iteration 2

- Status: implemented

#### User result
''',
)

replace_once(
    "README.md",
    "M4 is the selected next milestone. Slice 1 adds typed loop success conditions, structured iteration-region validation, schema version 3, canonical loop runtime, and one successful iteration. Later slices add feedback continuation, hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
    "M4 is the selected next milestone. Slices 1 and 2 add typed loop success conditions, structured iteration-region validation, schema version 3, canonical loop runtime, deterministic feedback continuation, and isolated multi-iteration task loops. Later slices add check-driven continuation, hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
)

replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slice 1 executes iteration 1 and can complete a loop when the evaluation node passes verification and the typed success condition is true. A false condition remains in the current iteration until Slice 2 adds feedback continuation. Do not claim that multi-iteration continuation, hard-limit failure, or patience is active yet.",
    "M4 Slices 1 and 2 execute task-based loops across multiple isolated iterations. When a verified evaluation produces a false success condition, Hypagraph follows the declared feedback edge, clears current loop facts and routes, keeps prior attempts and evidence, and makes the entry ready for the next iteration. Do not select a feedback route manually. Check-driven continuation, hard-limit failure, and patience are not active yet.",
)

replace_once(
    "docs/event-runtime.md",
    "## Loop Slice 1 lifecycle",
    "## Loop Slice 1 and Slice 2 lifecycle",
)

replace_once(
    "docs/event-runtime.md",
    "Slice 1 does not start a second iteration. A false condition records a pending decision and keeps downstream work blocked. Slice 2 adds feedback continuation and iteration reset.",
    "When the condition is false and another iteration is available, the evaluation event stores a `continue` decision. The same command batch then stores the next `hypagraph.loop.iteration-started` event and the entry ready event. Projection of the iteration-started event clears current loop facts, gate routes, node evidence, and current-attempt pointers. It keeps prior attempts, results, evidence, artifacts, events, and iteration history. Downstream work remains blocked until the loop succeeds.",
)

for path in [
    "src/domain/model.ts",
    "src/domain/projection.ts",
    "src/domain/reducer.ts",
    "tests/loop-slice-one.test.ts",
    "tests/loop-slice-two.test.ts",
    "tests/pi-loop-slice-two.test.ts",
    "docs/m4-vertical-slice-plan.md",
    "README.md",
    "skills/hypagraph/SKILL.md",
    "docs/event-runtime.md",
]:
    data = Path(path).read_bytes()
    if b"\x00" in data:
        raise SystemExit(f"NUL control character found in {path}")
