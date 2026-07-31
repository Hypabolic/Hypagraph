import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { HypagraphState } from "../src/domain/model.js";
import {
  hostSupportsPostCreateDock,
  PostCreateDockComponent,
  postCreateDockMeta,
  postCreateDiagramLines,
  POST_CREATE_DOCK_ROWS,
} from "../src/pi/post-create-dock.js";
import {
  BOTTOM_DOCK_FOOTER_MARGIN,
  BOTTOM_DOCK_MIN_WIDTH,
  bottomDockOverlayOptions,
} from "../src/ui/bottom-dock-overlay.js";
import { withCurrentSessionTaskProfile } from "./helpers/current-session-task.js";

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

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

const objective = "Implement a small feature and document it.";

const simpleDefinition = () => ({
  title: "Feature and docs",
  goal: "The model cannot replace the objective.",
  nodes: [
    withCurrentSessionTaskProfile({
      id: "implement",
      title: "Implement the feature",
      requires: [],
      acceptance: [],
    }),
    withCurrentSessionTaskProfile({
      id: "document",
      title: "Document the change",
      requires: ["implement"],
      acceptance: [],
    }),
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const rootInput = () => ({
  objective,
  definition: simpleDefinition(),
});

/** Host with optional TUI custom dock for post-create gate tests. */
const harness = (options: {
  mode?: string;
  hasUI?: boolean;
  customResult?: { kind: "run" | "question" | "cancel" };
  /** Delay custom resolution so callers can assert mid-gate state. */
  holdCustom?: boolean;
} = {}) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const captured: { overlay?: boolean; overlayOptions?: any }[] = [];
  const factoryTui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: vi.fn(),
  };
  let releaseCustom: ((result: { kind: "run" | "question" | "cancel" }) => void) | undefined;
  /** Armed after create so the cancel commit can be forced to fail. */
  let failNextAppend = false;
  const custom = vi.fn(async (factory: any, customOptions: any) => {
    const theme = { fg: (_c: string, text: string) => text };
    factory(factoryTui, theme, {}, () => undefined);
    captured.push({
      overlay: customOptions?.overlay,
      overlayOptions: customOptions?.overlayOptions,
    });
    if (options.holdCustom) {
      return new Promise<{ kind: "run" | "question" | "cancel" }>((resolve) => {
        releaseCustom = resolve;
      });
    }
    return options.customResult ?? { kind: "run" };
  });
  const appendEntry = vi.fn((customType: string, data?: unknown) => {
    if (failNextAppend) {
      failNextAppend = false;
      throw new Error("session append failed");
    }
    entries.push({ type: "custom", customType, data });
  });
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry,
    sendUserMessage,
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      select: vi.fn(),
      input: vi.fn(),
      custom,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return {
    tools,
    commands,
    handlers,
    entries,
    sendUserMessage,
    notify,
    custom,
    captured,
    factoryTui,
    appendEntry,
    ctx,
    armFailNextAppend: () => {
      failNextAppend = true;
    },
    releaseCustom: (result: { kind: "run" | "question" | "cancel" }) => {
      if (!releaseCustom) throw new Error("custom is not held");
      releaseCustom(result);
    },
  };
};

const createRoot = async (value: ReturnType<typeof harness>) =>
  value.tools.get("hypagoal_start")!.execute("create-root", rootInput(), undefined, undefined, value.ctx);

const invoke = async (
  handlers: Map<string, Array<(event: any, ctx: any) => any>>,
  name: string,
  event: any,
  ctx: any,
) => {
  const values = [];
  for (const handler of handlers.get(name) ?? []) values.push(await handler(event, ctx));
  return values;
};

const agentEnd = async (value: ReturnType<typeof harness>) => {
  await invoke(value.handlers, "agent_end", {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }],
  }, value.ctx);
};

const continuationPrompts = (value: ReturnType<typeof harness>): string[] =>
  value.sendUserMessage.mock.calls
    .map((call) => String(call[0]))
    .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

const currentState = (value: ReturnType<typeof harness>): HypagraphState => {
  const batch = [...value.entries].reverse().find((entry) => entry.data?.snapshot);
  if (!batch) throw new Error("The session holds no Hypagraph snapshot.");
  return batch.data.snapshot as HypagraphState;
};

const resolveOverlayOptions = (overlayOptions: unknown) => {
  if (typeof overlayOptions === "function") return overlayOptions();
  return overlayOptions;
};

const beforeAgentStart = async (value: ReturnType<typeof harness>, prompt = "What does this graph do?") => {
  const results = await invoke(value.handlers, "before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base-system",
    systemPromptOptions: {},
  }, value.ctx);
  return String(results.find((item) => item?.systemPrompt)?.systemPrompt ?? "");
};

const toolCall = async (value: ReturnType<typeof harness>, toolName: string) => {
  const results = await invoke(value.handlers, "tool_call", {
    type: "tool_call",
    toolName,
    toolCallId: `call-${toolName}`,
    input: {},
  }, value.ctx);
  return results.find((item) => item?.block === true) as { block: true; reason: string } | undefined;
};

describe("hostSupportsPostCreateDock", () => {
  it("requires interactive TUI with custom UI", () => {
    expect(hostSupportsPostCreateDock({
      hasUI: true,
      mode: "tui",
      ui: { custom: async () => ({ kind: "run" }) },
    })).toBe(true);
    expect(hostSupportsPostCreateDock({ hasUI: true, mode: "rpc", ui: { custom: () => undefined } })).toBe(false);
    expect(hostSupportsPostCreateDock({ hasUI: false, mode: "tui", ui: { custom: () => undefined } })).toBe(false);
    expect(hostSupportsPostCreateDock({ hasUI: true, mode: "tui", ui: {} })).toBe(false);
  });
});

describe("PostCreateDockComponent (S4.1)", () => {
  const dock = async () => {
    const state = await (async () => {
      const value = harness({ mode: "rpc", hasUI: false });
      await createRoot(value);
      return currentState(value);
    })();
    const done = vi.fn();
    const tui = {
      requestRender: vi.fn(),
      terminal: { columns: 80, rows: 24 },
    } as any;
    const theme = {
      fg: (color: string, text: string) => `[${color}]${text}`,
    } as any;
    return {
      component: new PostCreateDockComponent(tui, theme, state, done, { maxContentLines: 40 }),
      done,
      state,
    };
  };

  it("renders title, diagram area, recommended Run, and bottom chrome", async () => {
    const { component, state } = await dock();
    const lines = component.render(80);
    const text = lines.join("\n");

    expect(lines[0]).toBe(`[border]${"─".repeat(80)}`);
    expect(text).toContain("Hypagoal created");
    expect(text).toContain(state.definition.title);
    expect(text).toContain("1. Run (Recommended)");
    expect(text).toContain("2. Question");
    expect(text).toContain("3. Cancel");
    expect(text).toContain("Esc = Question");
    expect(text).toContain("› ");
    expect(text).toMatch(/Ready:/);
  });

  it("preselects Run and finishes on Enter", async () => {
    const { component, done } = await dock();
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "run" });
  });

  it("maps Esc to Question (safe dismiss)", async () => {
    const { component, done } = await dock();
    component.handleInput("\u001b");
    expect(done).toHaveBeenCalledWith({ kind: "question" });
  });

  it("maps digits to Run, Question, and Cancel", async () => {
    const { component: runDock, done: runDone } = await dock();
    runDock.handleInput("1");
    expect(runDone).toHaveBeenCalledWith({ kind: "run" });

    const { component: qDock, done: qDone } = await dock();
    qDock.handleInput("2");
    expect(qDone).toHaveBeenCalledWith({ kind: "question" });

    const { component: cDock, done: cDone } = await dock();
    cDock.handleInput("3");
    expect(cDone).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("navigates with arrows and selects Cancel", async () => {
    const { component, done } = await dock();
    component.handleInput("\u001b[B"); // down → Question
    component.handleInput("\u001b[B"); // down → Cancel
    component.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("keeps action rows under a tight maxContentLines budget", async () => {
    const { component } = await dock();
    // Re-create with a tight budget using the same state path.
    const value = harness({ mode: "rpc", hasUI: false });
    await createRoot(value);
    const state = currentState(value);
    const done = vi.fn();
    const tui = { requestRender: vi.fn(), terminal: { columns: 80, rows: 24 } } as any;
    const theme = { fg: (_c: string, text: string) => text } as any;
    const tight = new PostCreateDockComponent(tui, theme, state, done, { maxContentLines: 10 });
    const lines = tight.render(80);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.join("\n")).toContain("Run (Recommended)");
    expect(lines.join("\n")).toContain("Enter");
  });

  it("exposes the three action rows with Run recommended", () => {
    expect(POST_CREATE_DOCK_ROWS.map((row) => row.kind)).toEqual(["run", "question", "cancel"]);
    expect(POST_CREATE_DOCK_ROWS[0]!.recommended).toBe(true);
  });
});

describe("postCreateDockMeta and diagram", () => {
  it("summarizes ready work and budget", async () => {
    const value = harness({ mode: "rpc", hasUI: false });
    await createRoot(value);
    const state = currentState(value);
    const meta = postCreateDockMeta(state);
    expect(meta.title).toBe("Feature and docs");
    expect(meta.readySummary).toContain("implement");
    expect(meta.loopSummary).toBe("none");
    expect(meta.budgetSummary).toBe("unlimited");

    const diagram = postCreateDiagramLines(state, 80);
    expect(diagram.source).toContain("flowchart");
    expect(diagram.lines.length).toBeGreaterThan(0);
  });
});

describe("post-create gate and wiring (S4.2–S4.4)", () => {
  it("TUI create does not queue continuation until Run (S4.2)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "run" } });
    const created = await createRoot(value);
    expect(created.details.hypagoal.postCreateAwaitingUserChoice).toBe(true);
    expect(created.details.mermaid).toContain("flowchart");
    expect(continuationPrompts(value)).toEqual([]);

    await agentEnd(value);
    expect(value.custom).toHaveBeenCalledOnce();
    expect(value.captured[0]!.overlay).toBe(true);
    const options = resolveOverlayOptions(value.captured[0]!.overlayOptions);
    expect(options).toEqual(bottomDockOverlayOptions({ tui: value.factoryTui }));
    expect(options).toMatchObject({
      anchor: "bottom-center",
      width: "100%",
      minWidth: BOTTOM_DOCK_MIN_WIDTH,
      margin: expect.objectContaining({ bottom: BOTTOM_DOCK_FOOTER_MARGIN }),
    });

    const prompts = continuationPrompts(value);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("implement");
  });

  it("Question leaves the goal active and does not queue (S4.3)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);

    expect(continuationPrompts(value)).toEqual([]);
    expect(currentState(value).goal?.status).toBe("active");
    expect(value.notify).toHaveBeenCalledWith(
      expect.stringContaining("Ask a question"),
      "info",
    );

    // A later agent_end must not re-open the dock or auto-queue.
    value.custom.mockClear();
    value.sendUserMessage.mockClear();
    await agentEnd(value);
    expect(value.custom).not.toHaveBeenCalled();
    expect(continuationPrompts(value)).toEqual([]);
  });

  it("Cancel cancels the goal and starts no work (S4.3)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "cancel" } });
    await createRoot(value);
    await agentEnd(value);

    expect(continuationPrompts(value)).toEqual([]);
    expect(currentState(value).goal?.status).toBe("cancelled");
  });

  it("resume after Question re-opens the dock; Run then queues (S4.3)", async () => {
    // First dock answer is Question. Resume must re-present, not auto-start.
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);
    expect(continuationPrompts(value)).toEqual([]);
    expect(currentState(value).goal?.status).toBe("active");

    // Second dock answer is Run (resume re-opens the review for never-started goals).
    value.custom.mockImplementation(async () => ({ kind: "run" }));
    value.custom.mockClear();
    value.sendUserMessage.mockClear();

    await value.commands.get("hypagraph")!.handler("resume", value.ctx);
    expect(value.custom).toHaveBeenCalledOnce();
    const prompts = continuationPrompts(value);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("implement");
    expect(currentState(value).goal?.status).toBe("active");
  });

  it("resume after Question then Question again still does not auto-start", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);
    value.custom.mockClear();
    value.sendUserMessage.mockClear();

    await value.commands.get("hypagraph")!.handler("resume", value.ctx);
    expect(value.custom).toHaveBeenCalledOnce();
    expect(continuationPrompts(value)).toEqual([]);
    expect(currentState(value).goal?.status).toBe("active");
  });

  it("headless create auto-continues without a dock (S4.4)", async () => {
    const value = harness({ mode: "rpc", hasUI: false });
    // Headless harness has no custom; still create without mode tui.
    value.ctx.hasUI = false;
    value.ctx.mode = "rpc";
    const created = await createRoot(value);
    expect(created.details.hypagoal.postCreateAwaitingUserChoice).toBe(false);

    await agentEnd(value);
    expect(value.custom).not.toHaveBeenCalled();
    const prompts = continuationPrompts(value);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("implement");
  });

  it("hasUI without tui mode does not present the dock and auto-continues (S4.4)", async () => {
    const value = harness({ mode: "rpc", hasUI: true, customResult: { kind: "run" } });
    const created = await createRoot(value);
    expect(created.details.hypagoal.postCreateAwaitingUserChoice).toBe(false);

    await agentEnd(value);
    expect(value.custom).not.toHaveBeenCalled();
    expect(continuationPrompts(value)).toHaveLength(1);
  });

  it("Question blocks task and edit tools and injects a wait prompt (P1)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);
    expect(currentState(value).goal?.status).toBe("active");

    const system = await beforeAgentStart(value, "Why is implement first?");
    expect(system).toContain("POST-CREATE HYPAGOAL GATE");
    expect(system).toContain("waits for the user to choose Run");
    expect(system).toContain("Do not start tasks");
    expect(system).not.toContain("HYPAGRAPH CONTROL:");
    expect(system).not.toContain("Use hypagraph_transition before and after task work");

    for (const toolName of [
      "hypagraph_transition",
      "hypagraph_run_check",
      "hypagraph_cancel_check",
      "hypagraph_revise",
      "hypagoal_submit_revision",
      "write",
      "edit",
      "bash",
      "hypagoal_start",
    ]) {
      const blocked = await toolCall(value, toolName);
      expect(blocked, toolName).toMatchObject({ block: true });
      expect(blocked!.reason).toContain("waiting for the user to choose Run");
    }

    // Pure inspect and validate remain available.
    expect(await toolCall(value, "hypagraph_read")).toBeUndefined();
    expect(await toolCall(value, "hypagraph_validate")).toBeUndefined();
    expect(await toolCall(value, "read")).toBeUndefined();
  });

  it("Run clears the tool block so transition is allowed (P1)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "run" } });
    await createRoot(value);
    await agentEnd(value);

    expect(await toolCall(value, "hypagraph_transition")).toBeUndefined();
    const system = await beforeAgentStart(value, continuationPrompts(value)[0] ?? "go");
    // After Run a continuation may own the turn; the post-create gate prompt must be gone.
    expect(system).not.toContain("POST-CREATE HYPAGOAL GATE");
  });

  it("keeps the gate when post-create cancel fails to persist (P2)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "cancel" } });
    await createRoot(value);
    expect(currentState(value).goal?.status).toBe("active");

    // Fail the durable cancel commit after create succeeded.
    value.armFailNextAppend();
    await agentEnd(value);

    expect(currentState(value).goal?.status).toBe("active");
    expect(continuationPrompts(value)).toEqual([]);
    expect(value.notify).toHaveBeenCalledWith(
      expect.stringContaining("was not cancelled"),
      "warning",
    );

    // Gate remains: work tools still blocked; later agent_end still does not auto-queue.
    const blocked = await toolCall(value, "hypagraph_transition");
    expect(blocked).toMatchObject({ block: true });
    value.sendUserMessage.mockClear();
    await agentEnd(value);
    expect(continuationPrompts(value)).toEqual([]);
  });

  it("command cancel clears the gate only after cancel-goal succeeds (P2)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);
    expect(currentState(value).goal?.status).toBe("active");
    expect(await toolCall(value, "hypagraph_transition")).toMatchObject({ block: true });

    // Failed command cancel must leave the gate set.
    value.armFailNextAppend();
    await expect(value.commands.get("hypagraph")!.handler("cancel", value.ctx)).rejects.toThrow();
    expect(currentState(value).goal?.status).toBe("active");
    expect(await toolCall(value, "hypagraph_transition")).toMatchObject({ block: true });
    value.sendUserMessage.mockClear();
    await agentEnd(value);
    expect(continuationPrompts(value)).toEqual([]);

    // Successful command cancel clears the gate and cancels the goal.
    await value.commands.get("hypagraph")!.handler("cancel", value.ctx);
    expect(currentState(value).goal?.status).toBe("cancelled");
    expect(await toolCall(value, "hypagraph_transition")).toBeUndefined();
  });

  it("/hypagoal cancel also clears the gate only after success (P2)", async () => {
    const value = harness({ mode: "tui", hasUI: true, customResult: { kind: "question" } });
    await createRoot(value);
    await agentEnd(value);
    expect(await toolCall(value, "write")).toMatchObject({ block: true });

    value.armFailNextAppend();
    await expect(value.commands.get("hypagoal")!.handler("cancel", value.ctx)).rejects.toThrow();
    expect(await toolCall(value, "write")).toMatchObject({ block: true });

    await value.commands.get("hypagoal")!.handler("cancel", value.ctx);
    expect(currentState(value).goal?.status).toBe("cancelled");
    expect(await toolCall(value, "write")).toBeUndefined();
  });
});
