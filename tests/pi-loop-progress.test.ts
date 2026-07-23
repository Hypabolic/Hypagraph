import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";
import { projectGraphView } from "../src/graph/projection.js";

interface RegisteredTool { name: string; execute: (...args: any[]) => Promise<any> }

describe("M4 Slice 5 Pi progress surface", () => {
  it("shows the best metric and remaining patience", async () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = { on: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)), appendEntry: vi.fn() } as unknown as ExtensionAPI;
    hypagraphExtension(pi);
    const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() } };
    const signal = new AbortController().signal;
    await tools.get("hypagraph_define")!.execute("define", {
      title: "Pi progress loop", goal: "Show progress", nodes: [
        { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
        { id: "evaluate", title: "Evaluate", requires: ["repair"], acceptance: [], produces: [
          { name: "quality.passed", type: "boolean", required: true },
          { name: "quality.score", type: "number", required: true },
        ] },
      ], loops: [{ id: "quality-loop", nodes: ["repair", "evaluate"], entry: "repair", evaluateAfter: "evaluate", feedbackEdges: [{ from: "evaluate", to: "repair" }], successWhen: { kind: "compare", left: { kind: "fact", name: "quality.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 4, progress: { fact: "quality.score", direction: "maximize", minDelta: 1 }, patience: 2 }], policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);
    const transition = tools.get("hypagraph_transition")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);
    await call("repair-start", { action: "start", nodeId: "repair" });
    await call("repair-submit", { action: "submit", nodeId: "repair", evidence: [] });
    await call("repair-verify", { action: "verify", nodeId: "repair", passed: true });
    await call("evaluate-start", { action: "start", nodeId: "evaluate" });
    await call("evaluate-facts", { action: "publish", nodeId: "evaluate", facts: [{ name: "quality.passed", type: "boolean", value: false }, { name: "quality.score", type: "number", value: 10 }] });
    await call("evaluate-submit", { action: "submit", nodeId: "evaluate", evidence: [] });
    const result = await call("evaluate-verify", { action: "verify", nodeId: "evaluate", passed: true });
    const persisted = result.details.hypagraph as PersistedHypagraph;
    expect(persisted.snapshot.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 10, bestIteration: 1, noProgressCount: 0 });
    expect(projectGraphView(persisted.snapshot).loops[0]).toMatchObject({ bestMetric: 10, bestIteration: 1, remainingPatience: 2 });
    expect(result.content[0].text).toContain("metric 10, best 10 at 1, no-progress 0/2");
  });
});
