import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { HypagraphState, InteractionDefinition } from "../src/domain/model.js";
import {
  BOTTOM_DOCK_FOOTER_MARGIN,
  BOTTOM_DOCK_MAX_HEIGHT,
  BOTTOM_DOCK_MIN_WIDTH,
  bottomDockOverlayOptions,
} from "../src/ui/bottom-dock-overlay.js";
import { InteractionDialogComponent } from "../src/pi/interaction-dialog.js";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: any,
  ) => Promise<any>;
}

const objective = "Ask the user to approve the plan, then finish the work.";

const soleInteractionInput = () => ({
  objective,
  definition: {
    title: "Plan approval",
    goal: "The model cannot replace the objective.",
    nodes: [
      {
        id: "approve-plan",
        title: "Approve the plan",
        kind: "interaction",
        requires: [],
        acceptance: [],
        produces: [{ name: "plan.approved", type: "boolean", required: true }],
        interaction: {
          kind: "interaction",
          version: 1,
          presentation: { class: "deterministic", kind: "none" },
          question: "Approve the implementation plan?",
          responses: [
            {
              id: "approve",
              label: "Approve",
              publish: [{ name: "plan.approved", type: "boolean", value: true }],
            },
            {
              id: "reject",
              label: "Reject",
              publish: [{ name: "plan.approved", type: "boolean", value: false }],
            },
          ],
        },
      },
      {
        id: "after-approval",
        title: "Continue after the answer",
        requires: ["approve-plan"],
        acceptance: [],
      },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  },
});

/**
 * Extension harness with TUI custom overlay support.
 *
 * The present path uses ctx.mode === "tui" and ctx.ui.custom. The mock records
 * overlayOptions so tests can assert the bottom dock contract.
 */
const tuiHarness = (options: {
  customImpl?: (factory: any, customOptions: any) => Promise<any>;
  /** When set, the mock custom path invokes the factory with this TUI first. */
  factoryTui?: { terminal: { columns: number; rows: number }; requestRender?: () => void };
} = {}) => {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const captured: { overlay?: boolean; overlayOptions?: any }[] = [];
  const factoryTui = options.factoryTui ?? {
    terminal: { columns: 80, rows: 24 },
    requestRender: vi.fn(),
  };
  const custom =
    options.customImpl
    ?? vi.fn(async (factory: any, customOptions: any) => {
      // Match host order: factory first, then resolve overlay options once.
      const theme = { fg: (_c: string, text: string) => text };
      factory(factoryTui, theme, {}, () => undefined);
      captured.push({
        overlay: customOptions?.overlay,
        overlayOptions: customOptions?.overlayOptions,
      });
      return { kind: "cancelled" };
    });
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    appendEntry: vi.fn((customType: string, data?: unknown) =>
      entries.push({ type: "custom", customType, data })),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      custom,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, entries, custom, captured, ctx, factoryTui };
};

const createRoot = async (value: ReturnType<typeof tuiHarness>, input: unknown) =>
  value.tools.get("hypagoal_start")!.execute("create-root", input, undefined, undefined, value.ctx);

const currentState = (value: ReturnType<typeof tuiHarness>): HypagraphState => {
  const batch = [...value.entries].reverse().find((entry) => entry.data?.snapshot);
  if (!batch) throw new Error("The session holds no Hypagraph snapshot.");
  return batch.data.snapshot as HypagraphState;
};

/** Host accepts OverlayOptions or a zero-arg resolver. */
const resolveOverlayOptions = (overlayOptions: unknown) => {
  if (typeof overlayOptions === "function") {
    return overlayOptions();
  }
  return overlayOptions;
};

describe("interaction bottom dock present path (S2.1)", () => {
  it("requests bottom-center dock options through ui.custom", async () => {
    const value = tuiHarness();
    await createRoot(value, soleInteractionInput());

    await value.tools.get("hypagraph_ask")!.execute(
      "ask",
      { nodeId: "approve-plan" },
      undefined,
      undefined,
      value.ctx,
    );

    expect(value.custom).toHaveBeenCalledOnce();
    expect(value.captured).toHaveLength(1);
    expect(value.captured[0]!.overlay).toBe(true);

    const options = resolveOverlayOptions(value.captured[0]!.overlayOptions);
    // Factory captured tui with 24 rows; options use terminal-derived maxHeight.
    expect(options).toEqual(bottomDockOverlayOptions({ tui: value.factoryTui }));
    expect(options).toMatchObject({
      anchor: "bottom-center",
      width: "100%",
      minWidth: BOTTOM_DOCK_MIN_WIDTH,
      margin: {
        top: 0,
        right: 0,
        bottom: BOTTOM_DOCK_FOOTER_MARGIN,
        left: 0,
      },
    });
    expect(options.anchor).not.toBe("center");
    expect(options.maxHeight).toBe(13);
  });

  it("keeps the durable wait when the dock is cancelled", async () => {
    const value = tuiHarness();
    await createRoot(value, soleInteractionInput());

    await value.tools.get("hypagraph_ask")!.execute(
      "ask",
      { nodeId: "approve-plan" },
      undefined,
      undefined,
      value.ctx,
    );

    expect(currentState(value).runtime.nodes["approve-plan"]!.status).toBe("awaiting_response");
  });

  it("resolves overlay options as object or function form", async () => {
    const value = tuiHarness();
    await createRoot(value, soleInteractionInput());

    await value.tools.get("hypagraph_ask")!.execute(
      "ask",
      { nodeId: "approve-plan" },
      undefined,
      undefined,
      value.ctx,
    );

    const raw = value.captured[0]!.overlayOptions;
    const options = resolveOverlayOptions(raw);
    expect(options).toMatchObject({
      anchor: "bottom-center",
      width: "100%",
      minWidth: BOTTOM_DOCK_MIN_WIDTH,
    });
    // Factory runs before options resolve, so tui-derived sizing applies.
    const margin = options.margin;
    expect(typeof margin === "object" ? margin.bottom : margin).toBe(BOTTOM_DOCK_FOOTER_MARGIN);
  });
});

describe("interaction dialog dock chrome (S2.2)", () => {
  const closedInteraction = (responseCount = 2): InteractionDefinition => ({
    kind: "interaction",
    version: 1,
    presentation: { class: "deterministic", kind: "none" },
    question: "Approve the plan?",
    responses: Array.from({ length: responseCount }, (_, index) => ({
      id: `choice-${index + 1}`,
      label: `Choice ${index + 1}`,
      recommended: index === 0,
      publish: [] as any,
    })),
  });

  const openInteraction = (): InteractionDefinition => ({
    kind: "interaction",
    version: 1,
    presentation: { class: "deterministic", kind: "none" },
    question: "What should change?",
    openAnswer: { prompt: "Type the change.", maxBytes: 200, fact: "clarify.answer" },
  });

  const dialog = (
    interaction: InteractionDefinition,
    options: { maxContentLines?: number } = {},
  ) => {
    const done = vi.fn();
    const tui = { requestRender: vi.fn() } as any;
    // Theme returns color name + text so tests can assert border styling.
    const theme = {
      fg: (color: string, text: string) => `[${color}]${text}`,
    } as any;
    return {
      component: new InteractionDialogComponent(tui, theme, interaction, done, options),
      done,
    };
  };

  it("renders a full-width top border as dock chrome", () => {
    const { component } = dialog(closedInteraction());
    const lines = component.render(40);

    expect(lines[0]).toBe(`[border]${"─".repeat(40)}`);
    expect(lines.join("\n")).toContain("Approve the plan?");
    expect(lines.join("\n")).toContain("Choice 1 (Recommended)");
  });

  it("keeps recommended preselect and keyboard select after chrome polish", () => {
    const { component, done } = dialog(closedInteraction());
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("› ");
    expect(rendered).toContain("1. Choice 1 (Recommended)");

    component.handleInput("2");
    expect(done).toHaveBeenCalledWith({ kind: "response", responseId: "choice-2" });
  });

  it("keeps open-answer editor behaviour with the top border", () => {
    const { component, done } = dialog(openInteraction());
    const lines = component.render(50);
    expect(lines[0]).toMatch(/^\[border\]─+/);
    expect(lines.join("\n")).toContain("Type the change.");

    for (const character of "retry") component.handleInput(character);
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "open", openText: "retry" });
  });

  it("cancels with Esc without publishing an answer", () => {
    const { component, done } = dialog(closedInteraction());
    component.handleInput("\u001b");
    expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
  });

  it("windows many responses so the selected row and key help stay visible", () => {
    const dock = bottomDockOverlayOptions({
      tui: { terminal: { columns: 80, rows: 24 } },
    });
    const maxHeight = dock.maxHeight;
    expect(typeof maxHeight).toBe("number");
    expect(maxHeight as number).toBeGreaterThanOrEqual(13);

    // 12 responses + chat row. Without a viewport the host would clip the tail.
    const { component } = dialog(closedInteraction(12), {
      maxContentLines: maxHeight as number,
    });

    // Navigate to the last declared response (before chat).
    for (let step = 0; step < 11; step += 1) {
      component.handleInput("\u001b[B"); // down
    }

    const lines = component.render(80);
    const text = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(maxHeight as number);
    expect(text).toContain("Choice 12");
    expect(text).toContain("› ");
    expect(text).toContain("Enter to select");
    // First options scroll out of the window when selection is at the end.
    expect(text).not.toContain("Choice 1 (Recommended)");
    expect(text).toMatch(/more above|Choice 1[12]/);
    expect(BOTTOM_DOCK_MAX_HEIGHT).toBe("55%");
  });

  it("keeps key help when navigating to the chat row under a tight budget", () => {
    const { component } = dialog(closedInteraction(8), { maxContentLines: 10 });
    // 8 responses + chat = 9 rows; move to chat (index 8).
    for (let step = 0; step < 8; step += 1) {
      component.handleInput("\u001b[B");
    }
    const lines = component.render(80);
    const text = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(text).toContain("Chat about this");
    expect(text).toContain("Enter to select");
  });

  it("keeps the selected label when a long description exceeds a tight budget", () => {
    const longDescription = Array.from({ length: 20 }, (_, index) => `detail word${index}`).join(" ");
    const interaction: InteractionDefinition = {
      kind: "interaction",
      version: 1,
      presentation: { class: "deterministic", kind: "none" },
      question: "Pick one path for the release?",
      responses: [
        {
          id: "ship",
          label: "Ship now",
          recommended: true,
          description: longDescription,
          publish: [] as any,
        },
        {
          id: "wait",
          label: "Wait",
          description: "Short note.",
          publish: [] as any,
        },
      ],
    };

    const { component } = dialog(interaction, { maxContentLines: 8 });
    const lines = component.render(40);
    const text = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(8);
    // Selected label and marker must remain even when description is huge.
    expect(text).toContain("› ");
    expect(text).toContain("Ship now (Recommended)");
    expect(text).toContain("Enter to select");
    // Description may be truncated; the label must not be sliced away for it.
    const labelIndex = lines.findIndex((line) => line.includes("Ship now (Recommended)"));
    expect(labelIndex).toBeGreaterThanOrEqual(0);
    const helpIndex = lines.findIndex((line) => line.includes("Enter to select"));
    expect(helpIndex).toBeGreaterThan(labelIndex);
  });
});
