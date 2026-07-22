import { describe, expect, it, vi } from "vitest";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type { CheckExecutor, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";

const definition: HypagraphDefinition = {
  title: "Cancel a check",
  goal: "Reject a late success result after cancellation",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [
      { name: "tests.passed", type: "boolean", required: true },
      { name: "tests.status", type: "string", required: true },
      { name: "tests.cancelled", type: "boolean", required: true },
    ],
    check: {
      kind: "command",
      command: "test-command",
      timeoutMs: 60_000,
      publish: [
        { source: "passed", fact: "tests.passed" },
        { source: "status", fact: "tests.status" },
        { source: "cancelled", fact: "tests.cancelled" },
      ],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

describe("check cancellation policy", () => {
  it("converts a late success result to a cancelled result", async () => {
    const created = createWorkflow(definition, "2026-07-22T12:30:00.000Z", "workflow-cancel-late-result");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const controller = new AbortController();
    const executor: CheckExecutor = {
      execute: vi.fn(async (request) => {
        controller.abort("The user cancelled the check.");
        return {
          checkKind: request.definition.kind,
          attemptId: request.attemptId,
          startedAt: request.requestedAt,
          completedAt: "2026-07-22T12:30:02.000Z",
          status: "passed",
          exitCode: 0,
          facts: [],
          evidence: [{ ref: "artifact:late", kind: "file", summary: "Late output." }],
          stdoutRef: "artifact:late",
        };
      }),
    };

    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: "2026-07-22T12:30:00.000Z",
      signal: controller.signal,
      now: () => new Date("2026-07-22T12:30:03.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("cancelled");
    expect(result.result.error).toContain("later executor result was ignored");
    expect(result.result.stdoutRef).toBe("artifact:late");
    expect(result.state.runtime.nodes.tests?.status).toBe("failed");
    expect(result.state.runtime.facts["tests.passed"]?.value).toBe(false);
    expect(result.state.runtime.facts["tests.status"]?.value).toBe("cancelled");
    expect(result.state.runtime.facts["tests.cancelled"]?.value).toBe(true);
    const recorded = result.events.find((event) => event.type === "hypagraph.check.result-recorded");
    expect((recorded?.data.result as { status?: string } | undefined)?.status).toBe("cancelled");
  });
});
