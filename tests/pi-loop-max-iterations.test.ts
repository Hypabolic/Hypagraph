import { mkdtemp, rm } from "node:fs/promises";
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
