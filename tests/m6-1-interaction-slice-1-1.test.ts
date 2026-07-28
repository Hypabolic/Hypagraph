import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  interactionOptions,
  responseForOptionText,
} from "../src/domain/interaction-presentation.js";
import type { HypagraphState, InteractionDefinition } from "../src/domain/model.js";
import {
  hasIndependentWorkBesideWait,
  waitingLifecycleNote,
  waitingQuestionLines,
  waitingStatusLabel,
  waitingUnavailableNote,
  waitingWidgetLines,
} from "../src/ui/interaction-surface.js";
import { InteractionDialogComponent, interactionDialogRows } from "../src/pi/interaction-dialog.js";
import { validateDefinition } from "../src/domain/validate.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { renderWidget } from "../src/ui/format.js";
import { renderHypagoalLifecycleMessage, renderHypagoalStatus } from "../src/ui/hypagoal-surface.js";

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

  it("queues controller continuation when the person answers through /hypagraph ask", async () => {
    const select = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("approve - Approve");
    const value = harness({ select });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");

    await value.commands.get("hypagraph")!.handler("ask", value.ctx);

    expect(statusOf(value, "approve-plan")).toBe("succeeded");
    // Follow-on work is ready and the controller must re-enter after the command
    // answer, or the graph stalls until a later turn.
    const state = currentState(value);
    expect(state.runtime.nodes["after-approval"]?.status).toBe("ready");
    expect(state.goal?.pendingContinuation ?? state.goal?.actionDispatch?.pending).toBeTruthy();
  });

  it("tells the person how to re-open the dialog after a controller dismissal", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    const value = harness({ select });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    value.notify.mockClear();

    // The controller reaches the waiting stop and presents again. The person
    // dismisses, so the durable wait stays and the surface names /hypagraph ask.
    await agentEnd(value);

    expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
    const notes = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(notes).toContain("Waiting for a user response");
    expect(notes).toContain("/hypagraph ask");
    expect(notes).toContain("approve-plan");
    expect(value.notify.mock.calls.some((call) => call[1] === "info")).toBe(true);
  });

  it("does not recommend /hypagraph ask when the host has no dialog capability", async () => {
    const headless = harness({ hasUI: false });
    await createRoot(headless, soleInteractionInput());
    // Sole interaction: presentation is allowed, so the tool stores the request
    // and then reports unavailable without recommending a dialog recovery path.
    const result = await ask(headless);
    expect(String(result.content[0].text)).toContain("no dialog capability");
    expect(String(result.content[0].text)).not.toContain("Use /hypagraph ask");
    expect(statusOf(headless, "approve-plan")).toBe("awaiting_response");

    headless.notify.mockClear();
    await agentEnd(headless);
    const notes = headless.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(notes).toContain("no dialog capability");
    expect(notes).not.toContain("Use /hypagraph ask");
    expect(headless.notify.mock.calls.some((call) => call[1] === "warning")).toBe(true);

    headless.notify.mockClear();
    await headless.commands.get("hypagraph")!.handler("ask", headless.ctx);
    const commandNotes = headless.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(commandNotes).toContain("no dialog capability");
    expect(commandNotes).not.toContain("Use /hypagraph ask");
  });
});

describe("M6.1 Slice 1.1 interaction dialog", () => {
  const richInteraction = (freeText = true): InteractionDefinition => ({
    kind: "interaction",
    version: 1,
    presentation: { class: "deterministic", kind: "none" },
    question: "Which real development task are we planning right now?",
    responses: [
      { id: "bug-fix", label: "Bug fix", description: "Patch a production issue with minimal risk.", recommended: true, publish: [] as any },
      { id: "new-feature", label: "New feature", description: "Implement a user-facing capability.", publish: [] as any },
    ],
    ...(freeText ? {} : {}),
  });

  const openInteraction = (maxBytes = 200): InteractionDefinition => ({
    kind: "interaction",
    version: 1,
    presentation: { class: "deterministic", kind: "none" },
    question: "What should the retry policy do?",
    openAnswer: { prompt: "Describe the change you want.", maxBytes, fact: "clarify.answer" },
  });

  const dialog = (interaction: InteractionDefinition) => {
    const done = vi.fn();
    const tui = { requestRender: vi.fn() } as any;
    const theme = { fg: (_color: string, text: string) => text } as any;
    return { component: new InteractionDialogComponent(tui, theme, interaction, done), done };
  };

  it("builds declared rows, then the chat row", () => {
    const rows = interactionDialogRows(richInteraction());

    expect(rows.map((row) => row.label)).toEqual(["Bug fix", "New feature", "Chat about this"]);
    expect(rows[0]!.recommended).toBe(true);
    expect(rows.at(-1)!.chat).toBe(true);
  });

  it("shows no response row for an open question", () => {
    const rows = interactionDialogRows(openInteraction());

    expect(rows.map((row) => row.label)).toEqual(["Chat about this"]);
  });

  it("marks and preselects the recommended response", () => {
    const { component } = dialog(richInteraction());

    const rendered = component.render(80).join("\n");

    expect(rendered).toContain("1. Bug fix (Recommended)");
    expect(rendered).toContain("Patch a production issue with minimal risk.");
    expect(rendered).toContain("› 1. Bug fix (Recommended)");
  });

  it("returns the declared response which the person selects", () => {
    const { component, done } = dialog(richInteraction());

    component.handleInput("2");

    expect(done).toHaveBeenCalledWith({ kind: "response", responseId: "new-feature" });
  });

  it("returns the chat result without an answer", () => {
    const { component, done } = dialog(richInteraction());

    component.handleInput("3");

    expect(done).toHaveBeenCalledWith({ kind: "chat" });
  });

  it("opens the editor at once for an open question and returns the typed answer", () => {
    const { component, done } = dialog(openInteraction());

    expect(component.render(80).join("\n")).toContain("Describe the change you want.");
    for (const character of "use a retry") component.handleInput(character);
    component.handleInput("\r");

    expect(done).toHaveBeenCalledWith({ kind: "open", openText: "use a retry" });
  });

  it("stops the typed answer at the declared byte limit", () => {
    const { component, done } = dialog(openInteraction(4));

    for (const character of "abcdefgh") component.handleInput(character);
    component.handleInput("\r");

    expect(done).toHaveBeenCalledWith({ kind: "open", openText: "abcd" });
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

  it("names the wait in the status label, the widget, and the controls", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
    await createRoot(value, soleInteractionInput());
    await ask(value);
    const state = currentState(value);

    expect(waitingStatusLabel(state)).toBe("wait approve-plan");
    expect(waitingWidgetLines(state)[0]).toContain("approve-plan");
    expect(waitingWidgetLines(state).join("\n")).toContain("Present the dialog again with /hypagraph ask");
    expect(waitingWidgetLines(state).join("\n")).not.toContain("Independent ready work continues");
    expect(waitingLifecycleNote(state)).toContain("/hypagraph ask");
    expect(waitingUnavailableNote(state)).toContain("no dialog capability");
    expect(waitingUnavailableNote(state)).not.toContain("/hypagraph ask");
    expect(renderWidget(state).join("\n")).toContain("Waiting: approve-plan");
    expect(renderHypagoalLifecycleMessage(state)).toContain("Waiting for a user response");
    expect(renderHypagoalStatus(state)).toContain("/hypagraph ask");
  });

  it("wires the wait into setStatus and setWidget", async () => {
    const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
    await createRoot(value, soleInteractionInput());
    value.ctx.ui.setStatus.mockClear();
    value.ctx.ui.setWidget.mockClear();
    await ask(value);

    const statusCalls = value.ctx.ui.setStatus.mock.calls.map((call: unknown[]) => String(call[1] ?? ""));
    expect(statusCalls.some((text: string) => text.includes("wait approve-plan"))).toBe(true);
    const widgetCalls = value.ctx.ui.setWidget.mock.calls.map((call: unknown[]) => call[1]);
    const widgetText = widgetCalls.flat().map(String).join("\n");
    expect(widgetText).toContain("Waiting: approve-plan");
    expect(widgetText).toContain("/hypagraph ask");
  });

  it("reports independent ready work only when it exists", () => {
    const at = "2026-07-28T00:00:00.000Z";
    const definition: HypagraphDefinition = {
      title: "Approval with independent branch",
      goal: "An independent branch stays runnable while approval waits",
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
            question: "Approve?",
            responses: [
              { id: "approve", label: "Approve", publish: [{ name: "plan.approved", type: "boolean", value: true }] },
            ],
          },
        },
        {
          id: "independent-work",
          title: "Independent work",
          requires: [],
          acceptance: ["Work continues while approval waits."],
        },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-wait-independent");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const requested = handleCommand(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    });
    if (!requested.ok) throw new Error(JSON.stringify(requested.diagnostics));
    state = requested.state;

    expect(hasIndependentWorkBesideWait(state)).toBe(true);
    expect(waitingWidgetLines(state).join("\n")).toContain("Independent ready work continues");
    expect(waitingStatusLabel(state)).toBe("wait approve-plan");
  });

  it("names multi-wait status and re-open guidance", () => {
    const at = "2026-07-28T00:00:00.000Z";
    const definition: HypagraphDefinition = {
      title: "Two questions",
      goal: "Two waits",
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
            question: "Approve?",
            responses: [
              { id: "approve", label: "Approve", publish: [{ name: "plan.approved", type: "boolean", value: true }] },
            ],
          },
        },
        {
          id: "pick-scope",
          title: "Pick the scope",
          kind: "interaction",
          requires: [],
          acceptance: [],
          produces: [{ name: "scope.ready", type: "boolean", required: true }],
          interaction: {
            kind: "interaction",
            version: 1,
            presentation: { class: "deterministic", kind: "none" },
            question: "Which scope?",
            responses: [
              { id: "small", label: "Small", publish: [{ name: "scope.ready", type: "boolean", value: true }] },
            ],
          },
        },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-two-waits");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    for (const command of [
      {
        type: "request-interaction" as const,
        nodeId: "approve-plan",
        attemptId: "attempt-a",
        commandId: "command-a",
        at,
      },
      {
        type: "request-interaction" as const,
        nodeId: "pick-scope",
        attemptId: "attempt-b",
        commandId: "command-b",
        at,
      },
    ]) {
      const next = handleCommand(state, command);
      if (!next.ok) throw new Error(JSON.stringify(next.diagnostics));
      state = next.state;
    }

    expect(waitingStatusLabel(state)).toBe("wait approve-plan, pick-scope");
    expect(waitingWidgetLines(state).join("\n")).toContain("/hypagraph ask <nodeId>");
    expect(waitingLifecycleNote(state)).toContain("user responses");
    expect(waitingLifecycleNote(state)).toContain("pick-scope");
    expect(waitingQuestionLines(state).join("\n")).toContain("these questions");
    expect(waitingUnavailableNote(state)).toContain("approve-plan, pick-scope");
    expect(waitingUnavailableNote(state)).not.toContain("/hypagraph ask");
  });

  it("reports no waiting question when nothing awaits an answer", async () => {
    const value = harness();
    await createRoot(value, soleInteractionInput());
    const state = currentState(value);

    expect(waitingQuestionLines(state)).toEqual([]);
    expect(waitingStatusLabel(state)).toBeUndefined();
    expect(waitingWidgetLines(state)).toEqual([]);
    expect(waitingLifecycleNote(state)).toBeUndefined();
    expect(waitingUnavailableNote(state)).toBeUndefined();
  });
});

describe("M6.1 Slice 1.1 open questions", () => {
  const openNode = () => ({
    id: "clarify",
    title: "Clarify the retry policy",
    kind: "interaction",
    requires: [],
    acceptance: [],
    produces: [{ name: "clarify.answer", type: "string", required: true }],
    interaction: {
      kind: "interaction",
      version: 1,
      presentation: { class: "deterministic", kind: "none" },
      question: "What should the retry policy do?",
      openAnswer: { prompt: "Describe the change you want.", maxBytes: 200, fact: "clarify.answer" },
    },
  });

  const openInput = () => ({
    objective,
    definition: {
      title: "Clarify then implement",
      goal: "The model cannot replace the objective.",
      nodes: [openNode(), { id: "implement", title: "Implement it", requires: ["clarify"], acceptance: [] }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    },
  });

  it("publishes the typed answer into the declared string fact", async () => {
    const value = harness({ input: vi.fn().mockResolvedValue("retry three times") });
    await createRoot(value, openInput());

    await value.tools.get("hypagraph_ask")!.execute("ask", { nodeId: "clarify" }, undefined, undefined, value.ctx);

    expect(value.input).toHaveBeenCalledWith("Describe the change you want.");
    expect(statusOf(value, "clarify")).toBe("succeeded");
    expect(currentState(value).runtime.facts["clarify.answer"]?.value).toBe("retry three times");
  });

  it("keeps the durable wait when the person types nothing", async () => {
    const value = harness({ input: vi.fn().mockResolvedValue("   ") });
    await createRoot(value, openInput());

    await value.tools.get("hypagraph_ask")!.execute("ask", { nodeId: "clarify" }, undefined, undefined, value.ctx);

    expect(statusOf(value, "clarify")).toBe("awaiting_response");
  });

  it("rejects a definition which declares responses and an open answer", () => {
    const node: any = openNode();
    node.interaction.responses = [{ id: "yes", label: "Yes", publish: [] }];

    const diagnostics = validateDefinition({
      title: "t", goal: "g", nodes: [node], loops: [], policy: { mode: "guided", requireEvidence: true },
    } as any);

    expect(diagnostics.map((item) => item.code)).toContain("interaction_answer_kind_conflict");
  });

  it("rejects a gate which routes on an open-answer fact", () => {
    const diagnostics = validateDefinition({
      title: "t",
      goal: "g",
      nodes: [
        openNode() as any,
        {
          id: "route", title: "Route", kind: "gate", requires: ["clarify"], acceptance: [],
          gate: {
            condition: { kind: "compare", left: { kind: "fact", name: "clarify.answer" }, operator: "eq", right: { kind: "literal", value: "x" } },
            onTrue: ["yes"], onFalse: ["no"],
          },
        },
        { id: "yes", title: "Yes", requires: ["route"], acceptance: [] },
        { id: "no", title: "No", requires: ["route"], acceptance: [] },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: true },
    } as any);

    expect(diagnostics.map((item) => item.code)).toContain("gate_routes_on_open_answer");
  });
});
