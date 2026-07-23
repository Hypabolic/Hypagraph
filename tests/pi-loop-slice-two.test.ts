import { describe, expect, it, vi } from "vitest";
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
