import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { PersistedEventBatch } from "../src/persistence/event-store.js";
import type { CheckResult, HypagraphCommand, PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4 Slice 3 Pi check repair loop", () => {
  it("uses a failed command check to continue and a later pass to exit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hypagraph-check-loop-"));
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
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const runCheck = tools.get("hypagraph_run_check")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);

    await define.execute("define", {
      title: "Pi command-check repair loop",
      goal: "Fail once and pass after the repair marker exists",
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
            arguments: ["-e", "process.exit(require('node:fs').existsSync('repair.complete') ? 0 : 1)"],
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

    await call("start-implement-1", { action: "start", nodeId: "implement" });
    await call("submit-implement-1", { action: "submit", nodeId: "implement", evidence: [] });
    await call("verify-implement-1", { action: "verify", nodeId: "implement", passed: true });
    const firstResult = await runCheck.execute("run-test-1", { nodeId: "test" }, signal, undefined, ctx);
    const first = firstResult.details.hypagraph as PersistedHypagraph;
    const firstCheck = firstResult.details.check as { attemptId: string; result: CheckResult; commands: HypagraphCommand[] };

    expect(firstCheck.result.status).toBe("failed");
    expect(first.snapshot.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(first.snapshot.runtime.nodes.implement?.status).toBe("ready");
    expect(first.snapshot.runtime.nodes.test?.attempts[firstCheck.attemptId]).toMatchObject({ status: "failed", iteration: 1 });
    const continuationBatch = entries
      .map((entry) => entry.data as PersistedEventBatch)
      .find((batch) => Array.isArray(batch.events) && batch.events.some((event) => event.type === "hypagraph.loop.evaluated" && event.data.decision === "continue"));
    expect(continuationBatch?.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);

    await writeFile(join(workspace, "repair.complete"), "complete\n");
    await call("start-implement-2", { action: "start", nodeId: "implement" });
    await call("submit-implement-2", { action: "submit", nodeId: "implement", evidence: [] });
    await call("verify-implement-2", { action: "verify", nodeId: "implement", passed: true });
    const secondResult = await runCheck.execute("run-test-2", { nodeId: "test" }, signal, undefined, ctx);
    const second = secondResult.details.hypagraph as PersistedHypagraph;
    const secondCheck = secondResult.details.check as { attemptId: string; result: CheckResult; commands: HypagraphCommand[] };

    expect(secondCheck.result.status).toBe("passed");
    expect(second.snapshot.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(second.snapshot.runtime.nodes.document?.status).toBe("ready");
    const attempts = Object.values(second.snapshot.runtime.nodes.test!.attempts);
    expect(attempts.map((attempt) => attempt.iteration).sort()).toEqual([1, 2]);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
  });
});
