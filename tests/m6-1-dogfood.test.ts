import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { enumerateRootWorkActions } from "../src/domain/goal-runnable.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { waitingQuestionLines } from "../src/ui/interaction-surface.js";
import { isDerivedWaitingForUser } from "../src/domain/interaction-presentation.js";

const at = "2026-07-28T12:00:00.000Z";

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

/** Product path: plan approval interaction + independent repair loop. */
const dogfoodDefinition = (): HypagraphDefinition => ({
  title: "M6.1 dogfood approval and independent loop",
  goal: "Ask for plan approval while an independent loop continues",
  nodes: [
    {
      id: "approve-plan",
      title: "Approve the plan",
      kind: "interaction",
      requires: [],
      acceptance: ["The user answers the plan question."],
      produces: [{ name: "plan.approved", type: "boolean", required: true }],
      interaction: {
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Approve the implementation plan?",
        responses: [
          { id: "approve", label: "Approve", publish: [{ name: "plan.approved", type: "boolean", value: true }] },
          { id: "reject", label: "Reject", publish: [{ name: "plan.approved", type: "boolean", value: false }] },
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

describe("M6.1 dogfood product path", () => {
  it("lets an independent loop complete while plan approval waits, then answers approve", () => {
    const created = createWorkflow(dogfoodDefinition(), at, "workflow-m6-1-dogfood");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const events: DomainEvent[] = [...created.events];

    // Request the interaction and leave it waiting.
    let step = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve",
      commandId: "request-approve",
      at,
    });
    state = step.state;
    events.push(...step.events);

    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(waitingQuestionLines(state).join("\n")).toContain("Approve the implementation plan?");
    // Other loop work remains runnable while the question waits.
    expect(enumerateRootWorkActions(state).some((action) => action.nodeId === "repair" || action.nodeId === "probe" || action.kind.includes("loop") || action.nodeId === "repair")).toBe(true);
    const actions = enumerateRootWorkActions(state);
    expect(actions.some((action) => action.nodeId === "repair" || action.nodeId === "probe")).toBe(true);

    // Drive one successful loop task while approval still waits.
    step = apply(state, {
      type: "start-node",
      nodeId: "repair",
      attemptId: "attempt-repair-1",
      commandId: "start-repair",
      at,
    });
    state = step.state;
    events.push(...step.events);
    step = apply(state, {
      type: "submit-result",
      nodeId: "repair",
      attemptId: "attempt-repair-1",
      commandId: "submit-repair",
      at,
      evidence: [{ ref: "repair:1", kind: "note", summary: "repaired" }],
    });
    state = step.state;
    events.push(...step.events);
    step = apply(state, {
      type: "begin-verification",
      nodeId: "repair",
      attemptId: "attempt-repair-1",
      commandId: "begin-repair",
      at,
    });
    state = step.state;
    events.push(...step.events);
    step = apply(state, {
      type: "complete-verification",
      nodeId: "repair",
      attemptId: "attempt-repair-1",
      commandId: "complete-repair",
      at,
      passed: true,
    });
    state = step.state;
    events.push(...step.events);

    // Approval still waits after loop work progressed.
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(state.runtime.nodes["repair"]?.status).toBe("succeeded");

    // Answer approve and publish the routing fact.
    step = apply(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve",
      responseId: "approve",
      commandId: "answer-approve",
      at,
    });
    state = step.state;
    events.push(...step.events);

    expect(state.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("succeeded");
    expect(state.runtime.nodes["after-approval"]?.status).toBe("ready");

    // Replay preserves the wait-then-answer history.
    const replayed = replayEvents(events);
    expect(replayed.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(events.some((event) => event.type === "hypagraph.interaction.requested")).toBe(true);
    expect(events.some((event) => event.type === "hypagraph.interaction.answered")).toBe(true);
  });

  it("reports derived waiting only when the interaction is the sole stop", () => {
    const created = createWorkflow(dogfoodDefinition(), at, "workflow-m6-1-dogfood-derived");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    state = apply(state, {
      type: "request-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-approve",
      commandId: "request-approve",
      at,
    }).state;

    // Independent loop work is still runnable, so the goal is not only waiting.
    expect(isDerivedWaitingForUser(state)).toBe(false);
    expect(waitingQuestionLines(state).length).toBeGreaterThan(0);
  });
});
