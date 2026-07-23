import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";
import { projectGraphView } from "../src/graph/projection.js";

interface RegisteredTool { name: string; execute: (...args: any[]) => Promise<any> }

describe("M4 Slice 6 Pi outcome surface", () => {
  it("accepts independent region policies and reports a local failure", async () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = { on: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)), appendEntry: vi.fn() } as unknown as ExtensionAPI;
    hypagraphExtension(pi);
    const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] }, ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() } };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);

    await define.execute("define", {
      title: "Independent Pi regions",
      goal: "Record one local result",
      nodes: [
        { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
        { id: "evaluate", title: "Evaluate", requires: ["work"], acceptance: [], produces: [{ name: "region.passed", type: "boolean", required: true }] },
        { id: "outside", title: "Outside", requires: [], acceptance: [] },
      ],
      loops: [{
        id: "experiment",
        nodes: ["work", "evaluate"],
        entry: "work",
        evaluateAfter: "evaluate",
        feedbackEdges: [{ from: "evaluate", to: "work" }],
        successWhen: { kind: "compare", left: { kind: "fact", name: "region.passed" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 1,
        failurePolicy: "record-and-continue",
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await call("work-start", { action: "start", nodeId: "work" });
    await call("work-submit", { action: "submit", nodeId: "work", evidence: [] });
    await call("work-verify", { action: "verify", nodeId: "work", passed: true });
    await call("evaluate-start", { action: "start", nodeId: "evaluate" });
    await call("evaluate-facts", { action: "publish", nodeId: "evaluate", facts: [{ name: "region.passed", type: "boolean", value: false }] });
    await call("evaluate-submit", { action: "submit", nodeId: "evaluate", evidence: [] });
    const result = await call("evaluate-verify", { action: "verify", nodeId: "evaluate", passed: true });
    const persisted = result.details.hypagraph as PersistedHypagraph;
    expect(persisted.snapshot.phase).toBe("running");
    expect(persisted.snapshot.runtime.loops.experiment).toMatchObject({ status: "failed", failurePolicy: "record-and-continue", exitReason: "max_iterations" });
    expect(persisted.snapshot.runtime.nodes.outside?.status).toBe("ready");
    expect(result.content[0].text).toContain("policy record-and-continue");
    expect(result.content[0].text).toContain("max_iterations");
    expect(projectGraphView(persisted.snapshot).loops[0]).toMatchObject({ failurePolicy: "record-and-continue" });
  });
});
