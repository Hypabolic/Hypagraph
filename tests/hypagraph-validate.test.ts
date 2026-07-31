import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { validateHypagraphDefinition, renderHypagraphValidation } from "../src/pi/validate-definition.js";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<Record<string, unknown>>;
}

const validDefinition = () => ({
  title: "Validate sample",
  goal: "Prove hypagraph_validate creates no state",
  nodes: [
    {
      id: "implement",
      title: "Implement",
      requires: [],
      acceptance: ["Done"],
    },
  ],
  policy: { mode: "guided" as const, requireEvidence: false },
});

const invalidDefinition = () => ({
  title: "Invalid sample",
  goal: "Fail validation",
  nodes: [
    {
      id: "bad id",
      title: "Bad",
      requires: ["missing"],
      acceptance: [],
    },
  ],
});

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const entries: unknown[] = [];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => [] },
  };
  hypagraphExtension(pi);
  return { tools, entries, ctx };
};

describe("validateHypagraphDefinition", () => {
  it("accepts a valid definition and returns the normalized definition", () => {
    const result = validateHypagraphDefinition(validDefinition());
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.definition?.nodes[0]?.id).toBe("implement");
    expect(renderHypagraphValidation(result)).toContain("No canonical state was created");
  });

  it("returns diagnostics for an invalid definition", () => {
    const result = validateHypagraphDefinition(invalidDefinition());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(renderHypagraphValidation(result)).toContain("Hypagraph definition is invalid");
  });

  it("includes diagnostic suggestions in invalid loop feedback text", () => {
    const result = validateHypagraphDefinition({
      title: "Broken feedback metadata",
      goal: "Show feedback without requires",
      nodes: [
        { id: "implement", title: "Implement", requires: [], acceptance: [] },
        {
          id: "quorum-review",
          title: "Quorum review",
          requires: ["implement"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
        },
      ],
      loops: [{
        id: "implement-review-loop",
        nodes: ["implement", "quorum-review"],
        entry: "implement",
        evaluateAfter: "quorum-review",
        feedbackEdges: [{ from: "quorum-review", to: "implement" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 4,
      }],
      policy: { mode: "guided", requireEvidence: true },
    });
    expect(result.ok).toBe(false);
    const text = renderHypagraphValidation(result);
    expect(text).toContain("invalid_feedback_edge");
    expect(text).toMatch(/Add 'quorum-review' to node 'implement'\.requires/);
  });
});

describe("hypagraph_validate tool", () => {
  it("registers hypagraph_validate and creates no session entries", async () => {
    const value = harness();
    const tool = value.tools.get("hypagraph_validate");
    expect(tool).toBeDefined();
    expect(value.tools.has("hypagraph_define")).toBe(false);

    const result = await tool!.execute("v1", validDefinition(), undefined, undefined, value.ctx);
    const text = String((result.content as Array<{ text: string }>)[0]?.text ?? "");
    expect(text).toContain("Hypagraph definition is valid");
    expect(text).toContain("No canonical state was created");
    expect(value.entries).toHaveLength(0);
    expect((result.details as { hypagraphValidation: { ok: boolean } }).hypagraphValidation.ok).toBe(true);
  });

  it("returns diagnostics without creating state for an invalid definition", async () => {
    const value = harness();
    const result = await value.tools.get("hypagraph_validate")!.execute(
      "v2",
      invalidDefinition(),
      undefined,
      undefined,
      value.ctx,
    );
    const text = String((result.content as Array<{ text: string }>)[0]?.text ?? "");
    expect(text).toContain("Hypagraph definition is invalid");
    expect(value.entries).toHaveLength(0);
    expect((result.details as { hypagraphValidation: { ok: boolean } }).hypagraphValidation.ok).toBe(false);
  });
});
