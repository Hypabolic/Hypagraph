import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { classifyGoalBlockage } from "../src/domain/goal-blockage.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { enumerateRootWorkActions } from "../src/domain/goal-runnable.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-27T12:00:00.000Z";

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const interactionDefinition = (): HypagraphDefinition => ({
  title: "Plan approval with independent work",
  goal: "Ask for plan approval while an independent loop continues",
  nodes: [
    {
      id: "approve-plan",
      title: "Approve the plan",
      kind: "interaction",
      requires: [],
      acceptance: ["The user answers the plan question."],
      produces: [
        { name: "plan.approved", type: "boolean", required: true },
      ],
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
      title: "Continue after approval",
      requires: ["approve-plan"],
      acceptance: ["Work continues after the answer."],
    },
    {
      id: "repair",
      title: "Repair work",
      requires: ["probe"],
      acceptance: [],
    },
    {
      id: "probe",
      title: "Probe work",
      kind: "check",
      requires: ["repair"],
      acceptance: [],
      produces: [{ name: "probe.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "true",
        timeoutMs: 1_000,
        publish: [{ source: "passed", fact: "probe.passed" }],
      },
    },
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["repair", "probe"],
    entry: "repair",
    evaluateAfter: "probe",
    feedbackEdges: [{ from: "probe", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "probe.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    failurePolicy: "fail-workflow",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const branchDefinition = (): HypagraphDefinition => ({
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
          {
            id: "approve",
            label: "Approve",
            publish: [{ name: "plan.approved", type: "boolean", value: true }],
          },
        ],
      },
    },
    {
      id: "independent-work",
      title: "Independent work",
      requires: [],
      acceptance: ["Independent work completes."],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M6.1 Slice 1 interaction node kind and wait behaviour", () => {
  it("accepts a valid interaction definition", () => {
    expect(validateDefinition(interactionDefinition())).toEqual([]);
  });

  it("rejects an interaction node without an interaction definition", () => {
    const value = interactionDefinition();
    delete value.nodes[0]!.interaction;
    expect(validateDefinition(value).map((item) => item.code)).toContain("interaction_definition_required");
  });

  it("rejects a semantic presentation until M7 exists", () => {
    const value = interactionDefinition();
    value.nodes[0]!.interaction = {
      ...value.nodes[0]!.interaction!,
      presentation: { class: "semantic", kind: "none" },
    };
    const codes = validateDefinition(value).map((item) => item.code);
    expect(codes).toContain("semantic_presentation_requires_m7");
  });

  it("requests an interaction and leaves the node awaiting a response", () => {
    const created = createWorkflow(branchDefinition(), at, "workflow-interaction-wait");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const events: DomainEvent[] = [...created.events];

    const requested = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    });
    state = requested.state;
    events.push(...requested.events);

    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(requested.events.map((event) => event.type)).toContain("hypagraph.interaction.requested");
    expect(enumerateRootWorkActions(state).some((action) => action.nodeId === "approve-plan")).toBe(false);
    expect(enumerateRootWorkActions(state)).toEqual([
      { kind: "start-ready-task", nodeId: "independent-work" },
    ]);

    const replayed = replayEvents(events);
    expect(replayed.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
  });

  it("does not stop an independent branch while an interaction awaits a response", () => {
    const created = createWorkflow(branchDefinition(), at, "workflow-interaction-branch");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;

    state = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    }).state;

    expect(state.goal).toBeUndefined();
    const actions = enumerateRootWorkActions(state);
    expect(actions).toEqual([{ kind: "start-ready-task", nodeId: "independent-work" }]);

    state = apply(state, {
      type: "start-node",
      nodeId: "independent-work",
      attemptId: "attempt-work-1",
      commandId: "command-start-work",
      at,
    }).state;
    expect(state.runtime.nodes["independent-work"]?.status).toBe("running");
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
  });

  it("does not stop an independent loop while an interaction awaits a response", () => {
    const created = createWorkflow(interactionDefinition(), at, "workflow-interaction-loop");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;

    state = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    }).state;

    const actions = enumerateRootWorkActions(state);
    expect(actions.some((action) => action.kind === "start-ready-task" && action.nodeId === "repair")).toBe(true);
    expect(actions.some((action) => action.nodeId === "approve-plan")).toBe(false);

    state = apply(state, {
      type: "start-node",
      nodeId: "repair",
      attemptId: "attempt-repair-1",
      commandId: "command-start-repair",
      at,
    }).state;
    expect(state.runtime.nodes["repair"]?.status).toBe("running");
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(state.runtime.loops["repair-loop"]?.status).toBe("running");
  });

  it("publishes exactly the declared response facts and replays them", () => {
    const created = createWorkflow(branchDefinition(), at, "workflow-interaction-answer");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const events: DomainEvent[] = [...created.events];

    const requested = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    });
    state = requested.state;
    events.push(...requested.events);

    const answered = apply(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      responseId: "approve",
      commandId: "command-answer",
      at: "2026-07-27T12:01:00.000Z",
    });
    state = answered.state;
    events.push(...answered.events);

    expect(state.runtime.nodes["approve-plan"]?.status).toBe("succeeded");
    expect(state.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(answered.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.interaction.answered",
      "hypagraph.fact.published",
      "hypagraph.verification.passed",
    ]));
    expect(state.runtime.nodes["independent-work"]?.status).toBe("ready");

    const replayed = replayEvents(events);
    expect(replayed.runtime.nodes["approve-plan"]?.status).toBe("succeeded");
    expect(replayed.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(replayed.runtime.facts["plan.approved"]?.producerNodeId).toBe("approve-plan");
  });

  it("rejects an unknown response identifier", () => {
    const created = createWorkflow(branchDefinition(), at, "workflow-interaction-unknown");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    state = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    }).state;

    const result = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      responseId: "missing",
      commandId: "command-answer",
      at,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("unknown_interaction_response");
  });
});

describe("M6.1 Slice 1 waiting presentation and blockage", () => {
  it("does not request revision while an interaction awaits a response and no other work is runnable", () => {
    const created = createWorkflow(branchDefinition(), at, "workflow-interaction-wait-only");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;

    // Complete the independent branch so only the interaction remains outstanding.
    state = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve-1",
      commandId: "command-request",
      at,
    }).state;
    state = apply(state, {
      type: "start-node",
      nodeId: "independent-work",
      attemptId: "attempt-work-1",
      commandId: "command-start-work",
      at,
    }).state;
    state = apply(state, {
      type: "submit-result",
      nodeId: "independent-work",
      attemptId: "attempt-work-1",
      evidence: [],
      commandId: "command-submit-work",
      at,
    }).state;
    state = apply(state, {
      type: "begin-verification",
      nodeId: "independent-work",
      attemptId: "attempt-work-1",
      commandId: "command-begin-work",
      at,
    }).state;
    state = apply(state, {
      type: "complete-verification",
      nodeId: "independent-work",
      attemptId: "attempt-work-1",
      passed: true,
      commandId: "command-pass-work",
      at,
    }).state;

    // Attach a goal so continuation and blockage classification run.
    state = apply(state, {
      type: "start-goal",
      goalId: "goal-wait",
      commandId: "command-start-goal",
      at,
    }).state;

    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(enumerateRootWorkActions(state)).toEqual([]);

    expect(classifyGoalBlockage(state).kind).toBe("not-blocked");
    const decision = selectGoalContinuation(state);
    expect(decision.kind).toBe("stop-waiting-response");
    if (decision.kind === "stop-waiting-response") {
      expect(decision.reason).toMatch(/user response/i);
    }
  });
});
