import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";
import { hypagoalStartSchema } from "../src/pi/hypagoal.js";

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

interface CommandDefinition {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

const proseObjective = "Add an inspect command that reports the current workflow without starting execution.";

const authoredInput = (replacementConfirmation?: unknown, creationRequest?: unknown, objective = proseObjective) => ({
  objective,
  definition: {
    title: "Add workflow inspection",
    goal: "The model must not control the canonical objective field.",
    nodes: [
      {
        id: "implement",
        title: "Implement the inspect command",
        description: "Add the user-facing command through the existing extension structure.",
        requires: [],
        acceptance: ["The command reports the current workflow state."],
        scope: { paths: ["src/**", "tests/**"] },
      },
      {
        id: "verify",
        title: "Run the repository test suite",
        kind: "check",
        requires: ["implement"],
        acceptance: [],
        produces: [{ name: "verify.passed", type: "boolean", required: true }],
        check: {
          kind: "command",
          command: "npm",
          arguments: ["test"],
          timeoutMs: 120000,
          publish: [{ source: "passed", fact: "verify.passed" }],
        },
      },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  },
  advisories: [{
    code: "repository-test-command",
    message: "The graph uses the test command declared by package.json.",
  }],
  ...(creationRequest === undefined ? {} : { creationRequest }),
  ...(replacementConfirmation === undefined ? {} : { replacementConfirmation }),
});

const harness = (confirm = true) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const entries: unknown[] = [];
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage,
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: vi.fn().mockResolvedValue(confirm),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getBranch: () => entries,
    },
  };

  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, sendUserMessage, ctx };
};

const text = (result: Record<string, unknown>): string => {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((item) => item.text).join("\n");
};

const creationRequestFromPrompt = (prompt: string): unknown => {
  const match = prompt.match(/Use this exact creation request identity without changing any field:\n(\{[\s\S]*?\})\n\nCall hypagoal_start/);
  if (!match?.[1]) throw new Error("The authoring prompt did not contain a creation request identity.");
  return JSON.parse(match[1]);
};

describe("Hypagoal Pi surfaces", () => {
  it("keeps terminal lifecycle fields outside the public creation schema", () => {
    const properties = (hypagoalStartSchema as unknown as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual([
      "objective",
      "definition",
      "advisories",
      "creationRequest",
      "replacementConfirmation",
    ]);
    expect(properties).not.toHaveProperty("status");
    expect(properties).not.toHaveProperty("completed");
    expect(properties).not.toHaveProperty("failed");
    expect(properties).not.toHaveProperty("cancelled");
    expect(properties).not.toHaveProperty("blocked");
  });

  it("routes /hypagoal into a repository-aware authoring turn without persisting state", async () => {
    const value = harness();
    const command = value.commands.get("hypagoal");
    expect(command).toBeDefined();

    await command!.handler(proseObjective, value.ctx);

    expect(value.entries).toHaveLength(0);
    expect(value.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain(JSON.stringify(proseObjective));
    expect(prompt).toContain("Inspect the relevant repository files");
    expect(prompt).toContain("smallest useful canonical Hypagraph workflow");
    expect(prompt).toContain("Repair is one possible loop pattern");
    expect(prompt).toContain("Use this exact creation request identity");
    expect(prompt).toContain("Call hypagoal_start one time");
    expect(prompt).toContain("Do not perform semantic implementation work after creation");
  });

  it("runs the realistic command-to-tool smoke path and stops after atomic creation", async () => {
    const value = harness();
    const command = value.commands.get("hypagoal")!;
    const tool = value.tools.get("hypagoal_start")!;

    await command.handler(proseObjective, value.ctx);
    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);
    const creationRequest = creationRequestFromPrompt(prompt);
    const result = await tool.execute(
      "hypagoal-smoke",
      authoredInput(undefined, creationRequest, "Model rewrote the user's objective."),
      undefined,
      undefined,
      value.ctx,
    );

    expect(result.terminate).toBe(true);
    expect(value.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(value.entries).toHaveLength(1);
    expect(value.entries[0]).toMatchObject({ type: "custom", customType: HYPAGRAPH_EVENT_BATCH_TYPE });
    expect(text(result)).toContain(`Objective: ${proseObjective}`);
    expect(text(result)).toContain("Goal control: active");
    expect(text(result)).toContain("Ready tasks: implement");
    expect(text(result)).toContain("Autonomous continuation has not started");

    const details = result.details as {
      hypagraph: { events: Array<{ type: string }>; snapshot: { definition: { goal: string }; goal: { status: string } } };
      hypagoal: {
        objective: string;
        goalControl: { status: string };
        creation: { operationId: string; correlationId: string; sessionGeneration: number; branchGeneration: number };
        autonomousContinuationStarted: boolean;
      };
    };
    expect(details.hypagraph.events.map((event) => event.type)).toEqual([
      "hypagraph.workflow.defined",
      "hypagraph.node.ready",
      "hypagraph.goal.started",
    ]);
    expect(details.hypagraph.snapshot.definition.goal).toBe(proseObjective);
    expect(details.hypagraph.snapshot.goal.status).toBe("active");
    expect(details.hypagoal.objective).toBe(proseObjective);
    expect(details.hypagoal.goalControl.status).toBe("active");
    expect(details.hypagoal.creation.operationId).toMatch(/^hypagoal-create:/);
    expect(details.hypagoal.creation.correlationId).toMatch(/^define:/);
    expect(details.hypagoal.creation.sessionGeneration).toBe(0);
    expect(details.hypagoal.creation.branchGeneration).toBe(0);
    expect(details.hypagoal.autonomousContinuationStarted).toBe(false);
  });

  it("returns useful invalid-authoring diagnostics without partial persistence or follow-up", async () => {
    const value = harness();
    const tool = value.tools.get("hypagoal_start")!;
    const invalid = authoredInput() as ReturnType<typeof authoredInput> & { definition: { nodes: unknown[] } };
    invalid.definition = { ...invalid.definition, nodes: [] };

    const result = await tool.execute("invalid-authoring", invalid, undefined, undefined, value.ctx);

    expect(result.terminate).toBe(true);
    expect(value.entries).toHaveLength(0);
    expect(value.sendUserMessage).not.toHaveBeenCalled();
    expect(text(result)).toContain("Hypagoal was not created");
    expect(text(result)).toContain("empty_graph");
  });

  it("rejects a slash-command creation request after the Pi branch generation changes", async () => {
    const value = harness();
    await value.commands.get("hypagoal")!.handler(proseObjective, value.ctx);
    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);
    const creationRequest = creationRequestFromPrompt(prompt);

    const sessionTree = value.handlers.get("session_tree")?.[0];
    expect(sessionTree).toBeDefined();
    await sessionTree!({}, value.ctx);

    const result = await value.tools.get("hypagoal_start")!.execute(
      "stale-authoring",
      authoredInput(undefined, creationRequest),
      undefined,
      undefined,
      value.ctx,
    );
    expect(result.terminate).toBe(true);
    expect(text(result)).toContain("stale_hypagoal_creation_request");
    expect(value.entries).toHaveLength(0);
  });

  it("does not let the legacy define surface silently replace an active root", async () => {
    const value = harness();
    await value.tools.get("hypagoal_start")!.execute("first", authoredInput(), undefined, undefined, value.ctx);
    await expect(value.tools.get("hypagraph_define")!.execute(
      "legacy-replace",
      authoredInput().definition,
      undefined,
      undefined,
      value.ctx,
    )).rejects.toThrow("explicit root replacement");
    expect(value.entries).toHaveLength(1);
  });

  it("identifies the current root and requires an exact typed replacement", async () => {
    const value = harness();
    const tool = value.tools.get("hypagoal_start")!;
    const first = await tool.execute("first", authoredInput(), undefined, undefined, value.ctx);
    expect(first.terminate).toBe(true);
    expect(value.entries).toHaveLength(1);

    const required = await tool.execute("replacement-required", authoredInput(), undefined, undefined, value.ctx);
    expect(required.terminate).toBe(true);
    expect(value.entries).toHaveLength(1);
    expect(text(required)).toContain("Root replacement requires explicit confirmation");
    expect(text(required)).toContain(`Current objective: ${proseObjective}`);

    const requiredDetails = required.details as {
      hypagoal: { kind: string; replacementConfirmation: unknown; current: { workflowId: string } };
    };
    expect(requiredDetails.hypagoal.kind).toBe("replacement-required");
    const replaced = await tool.execute(
      "replacement-confirmed",
      authoredInput(requiredDetails.hypagoal.replacementConfirmation),
      undefined,
      undefined,
      value.ctx,
    );
    expect(replaced.terminate).toBe(true);
    expect(value.entries).toHaveLength(2);
    expect(text(replaced)).toContain("Hypagoal created");
  });

  it("binds slash-command replacement confirmation to the current canonical root", async () => {
    const value = harness(true);
    const tool = value.tools.get("hypagoal_start")!;
    await tool.execute("first", authoredInput(), undefined, undefined, value.ctx);

    value.sendUserMessage.mockClear();
    await value.commands.get("hypagoal")!.handler("Replace the current objective safely.", value.ctx);

    expect(value.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(value.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = String(value.sendUserMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain("Use this exact replacement confirmation");
    expect(prompt).toContain("workflowId");
    expect(prompt).toContain("snapshotHash");
    expect(prompt).toContain("sessionGeneration");
    expect(prompt).toContain("branchGeneration");
    expect(value.entries).toHaveLength(1);
  });
});
