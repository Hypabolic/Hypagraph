import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  interactionOptions,
  responseForOptionText,
} from "../src/domain/interaction-presentation.js";
import type { HypagraphState, InteractionDefinition } from "../src/domain/model.js";
import { waitingQuestionLines } from "../src/ui/interaction-surface.js";

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

const objective = "Ask the user to approve the plan, then finish the work.";

const interactionNode = (extraResponse = false) => ({
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
      { id: "approve", label: "Approve", publish: [{ name: "plan.approved", type: "boolean", value: true }] },
      {
        id: extraResponse ? "reject-quietly" : "reject",
        // Slice 1.1 rule 1.1.6. Two responses can carry the same label.
        label: extraResponse ? "Approve" : "Reject",
        publish: [{ name: "plan.approved", type: "boolean", value: false }],
      },
    ],
  },
});

/** One graph where the interaction is the only runnable work. */
const soleInteractionInput = () => ({
  objective,
  definition: {
    title: "Plan approval",
    goal: "The model cannot replace the objective.",
    nodes: [
      interactionNode(),
      { id: "after-approval", title: "Continue after the answer", requires: ["approve-plan"], acceptance: [] },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  },
});

/** One graph where an independent task stays runnable beside the interaction. */
const independentWorkInput = () => ({
  objective,
  definition: {
    title: "Plan approval with independent work",
    goal: "The model cannot replace the objective.",
    nodes: [
      interactionNode(),
      { id: "after-approval", title: "Continue after the answer", requires: ["approve-plan"], acceptance: [] },
      { id: "document", title: "Document independently", requires: [], acceptance: [] },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  },
});

const harness = (options: { hasUI?: boolean; select?: any; input?: any } = {}) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const select = options.select ?? vi.fn().mockResolvedValue(undefined);
  const input = options.input ?? vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    ui: { confirm: vi.fn().mockResolvedValue(true), notify, select, input, setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, notify, select, input, ctx };
};

const createRoot = async (value: ReturnType<typeof harness>, input: unknown) =>
  value.tools.get("hypagoal_start")!.execute("create-root", input, undefined, undefined, value.ctx);

const currentState = (value: ReturnType<typeof harness>): HypagraphState => {
  const batch = [...value.entries].reverse().find((entry) => entry.data?.snapshot);
  if (!batch) throw new Error("The session holds no Hypagraph snapshot.");
  return batch.data.snapshot as HypagraphState;
};

const statusOf = (value: ReturnType<typeof harness>, nodeId: string): string =>
  currentState(value).runtime.nodes[nodeId]!.status;

const ask = async (value: ReturnType<typeof harness>, nodeId = "approve-plan") =>
  value.tools.get("hypagraph_ask")!.execute("ask", { nodeId }, undefined, undefined, value.ctx);

const agentEnd = async (value: ReturnType<typeof harness>) => {
  for (const handler of value.handlers.get("agent_end") ?? []) {
    await handler({ type: "agent_end", messages: [] }, value.ctx);
  }
};

describe("M6.1 Slice 1.1 interactive presentation", () => {
  it("presents a ready interaction and stores the selected answer", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue("approve - Approve") });
    await createRoot(value, soleInteractionInput());

    await ask(value);

    expect(value.select).toHaveBeenCalledWith(
      "Approve the implementation plan?",
      ["approve - Approve", "reject - Reject"],
    );
    expect(statusOf(value, "approve-plan")).toBe("succeeded");
    expect(currentState(value).runtime.facts["plan.approved"]?.value).toBe(true);
  });

  it("does not open a dialog while another action is runnable", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue("approve - Approve") });
    await createRoot(value, independentWorkInput());

    const result = await ask(value);

    expect(value.select).not.toHaveBeenCalled();
    expect(String(result.content[0].text)).toContain("other runnable work");
    expect(statusOf(value, "approve-plan")).toBe("ready");
  });

  it("keeps the durable wait when the user dismisses the dialog", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
    await createRoot(value, soleInteractionInput());

    await ask(value);

    expect(value.select).toHaveBeenCalledOnce();
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
  });

  it("keeps the durable wait when the host has no dialog capability", async () => {
    const value = harness({ hasUI: false, select: vi.fn() });
    await createRoot(value, soleInteractionInput());

    const result = await ask(value);

    expect(value.select).not.toHaveBeenCalled();
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
    expect(String(result.content[0].text)).toContain("no dialog capability");
  });

  it("presents an open question again from the controller after a dismissal", async () => {
    const select = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("reject - Reject");
    const value = harness({ select });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");

    // The controller reaches the waiting stop, because the open question is the
    // only remaining work. It presents the question without a model turn.
    await agentEnd(value);

    expect(select).toHaveBeenNthCalledWith(
      2,
      "Approve the implementation plan?",
      ["approve - Approve", "reject - Reject"],
    );
    expect(currentState(value).runtime.facts["plan.approved"]?.value).toBe(false);
  });

  it("registers no command which accepts a typed answer", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");

    await value.commands.get("hypagraph")!.handler("answer approve-plan approve", value.ctx);

    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
    const help = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(help).not.toContain("<responseId>");
  });

  it("presents the open question again through /hypagraph ask", async () => {
    const select = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("approve - Approve");
    const value = harness({ select });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");

    await value.commands.get("hypagraph")!.handler("ask", value.ctx);

    expect(select).toHaveBeenCalledTimes(2);
    expect(statusOf(value, "approve-plan")).toBe("succeeded");
  });
});

describe("M6.1 Slice 1.1 waiting surface and option identity", () => {
  const interaction = (): InteractionDefinition => interactionNode(true).interaction as InteractionDefinition;

  it("maps two responses with the same label to different response IDs", () => {
    const value = interaction();
    const options = interactionOptions(value);

    expect(options).toEqual(["approve - Approve", "reject-quietly - Approve"]);
    expect(responseForOptionText(value, options[0]!)?.id).toBe("approve");
    expect(responseForOptionText(value, options[1]!)?.id).toBe("reject-quietly");
  });

  it("shows the question and every response ID in the waiting surface", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
    await createRoot(value, soleInteractionInput());
    await ask(value);

    const lines = waitingQuestionLines(currentState(value)).join("\n");

    expect(lines).toContain("Approve the implementation plan?");
    expect(lines).toContain("approve - Approve");
    expect(lines).toContain("reject - Reject");
  });

  it("reports no waiting question when nothing awaits an answer", async () => {
    const value = harness();
    await createRoot(value, soleInteractionInput());

    expect(waitingQuestionLines(currentState(value))).toEqual([]);
  });
});
