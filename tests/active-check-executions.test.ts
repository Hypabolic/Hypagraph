import { describe, expect, it } from "vitest";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";

const input = (attemptId: string, upstreamSignal?: AbortSignal) => ({
  workflowId: "workflow-active-check",
  nodeId: "tests",
  attemptId,
  startedAt: "2026-07-22T12:00:00.000Z",
  ...(upstreamSignal ? { upstreamSignal } : {}),
});

describe("active check execution registry", () => {
  it("propagates the Pi abort signal and releases the entry", () => {
    const registry = new ActiveCheckExecutionRegistry();
    const upstream = new AbortController();
    const handle = registry.register(input("attempt-1", upstream.signal));

    expect(registry.hasActive("workflow-active-check")).toBe(true);
    upstream.abort("Pi stopped the tool.");
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe("Pi stopped the tool.");

    handle.release();
    expect(registry.hasActive()).toBe(false);
  });

  it("cancels only the selected node or attempt", () => {
    const registry = new ActiveCheckExecutionRegistry();
    const first = registry.register(input("attempt-1"));
    const second = registry.register({
      ...input("attempt-2"),
      nodeId: "lint",
    });

    const cancelled = registry.cancel({
      workflowId: "workflow-active-check",
      nodeId: "tests",
      reason: "Stop tests.",
    });

    expect(cancelled.map((entry) => entry.attemptId)).toEqual(["attempt-1"]);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    first.release();
    second.release();
  });

  it("rejects duplicate active attempt registration", () => {
    const registry = new ActiveCheckExecutionRegistry();
    const first = registry.register(input("attempt-1"));
    expect(() => registry.register(input("attempt-1"))).toThrow("already active");
    first.release();
  });
});
