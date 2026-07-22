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

describe("M4 Slice 1 Pi loop path", () => {
  it("completes a task-to-check loop through the registered Pi tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hypagraph-loop-"));
    workspaces.push(workspace);
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
      cwd: workspace,
      sessionManager: { getBranch: () => [] },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const runCheck = tools.get("hypagraph_run_check")!;

    await define.execute("define", {
      title: "Pi one-iteration loop",
      goal: "Pass the command check and release documentation",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          kind: "check",
          requires: ["implement"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: process.execPath,
            arguments: ["-e", "process.exit(0)"],
            timeoutMs: 10_000,
            publish: [{ source: "passed", fact: "tests.passed" }],
          },
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

    await transition.execute("start-implement", { action: "start", nodeId: "implement" }, signal, undefined, ctx);
    await transition.execute("submit-implement", { action: "submit", nodeId: "implement", evidence: [] }, signal, undefined, ctx);
    await transition.execute("verify-implement", { action: "verify", nodeId: "implement", passed: true }, signal, undefined, ctx);
    const result = await runCheck.execute("run-test", { nodeId: "test" }, signal, undefined, ctx);
    const persisted = result.details.hypagraph as PersistedHypagraph;

    expect(persisted.snapshot.runtime.loops.repair).toMatchObject({
      status: "succeeded",
      currentIteration: 1,
      lastSuccess: true,
      exitReason: "success",
    });
    expect(persisted.snapshot.runtime.nodes.document?.status).toBe("ready");
    expect(persisted.snapshot.runtime.nodes.test?.attempts[persisted.snapshot.runtime.nodes.test.currentAttemptId!]).toMatchObject({
      loopId: "repair",
      iteration: 1,
    });
    expect(persisted.snapshot.runtime.facts["tests.passed"]).toMatchObject({ loopId: "repair", iteration: 1, value: true });
    expect(entries.length).toBeGreaterThan(0);
    expect(persisted.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.loop.iteration-started",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.completed",
    ]));
  });
});
