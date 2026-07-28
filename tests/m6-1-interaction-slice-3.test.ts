import { describe, expect, it } from "vitest";
import type {
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
  InteractionDefinition,
} from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import {
  expiredInteractionCandidates,
  projectAllTaskContexts,
  projectTaskContext,
  renderTaskContextLines,
} from "../src/domain/task-context.js";
import { validateDefinition } from "../src/domain/validate.js";
import { buildGoalContinuationPrompt, continuationSystemPrompt } from "../src/pi/hypagoal-continuation.js";
import { projectModelVisibleWorkflowSummary } from "../src/pi/model-visible-state.js";

const at = "2026-07-28T12:00:00.000Z";
const later = "2026-07-28T12:30:00.000Z";
const tooEarly = "2026-07-28T12:00:30.000Z";

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const closedInteraction = (
  overrides: Partial<InteractionDefinition> = {},
): InteractionDefinition => ({
  kind: "interaction",
  version: 1,
  presentation: { class: "deterministic", kind: "none" },
  question: "Review the plan?",
  responses: [
    {
      id: "approve",
      label: "Approve",
      publish: [{ name: "review.changes_requested", type: "boolean", value: false }],
    },
    {
      id: "changes_requested",
      label: "Request changes",
      publish: [{ name: "review.changes_requested", type: "boolean", value: true }],
    },
  ],
  ...overrides,
});

/** Interaction → gate → worker | done. Worker binds feedback context. */
const reviewGraph = (
  interaction: InteractionDefinition,
  options: { withContext?: boolean } = {},
): HypagraphDefinition => ({
  title: "Plan review routing",
  goal: "Route on published review facts and carry feedback to the worker",
  nodes: [
    {
      id: "review-plan",
      title: "Review the plan",
      kind: "interaction",
      requires: [],
      acceptance: ["The user answers the review question."],
      produces: [{ name: "review.changes_requested", type: "boolean", required: true }],
      interaction,
    },
    {
      id: "route-review",
      title: "Route the review",
      kind: "gate",
      requires: ["review-plan"],
      acceptance: ["The gate selects the worker or the done path."],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "review.changes_requested" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["revise-work"],
        onFalse: ["done"],
      },
    },
    {
      id: "revise-work",
      title: "Revise the plan",
      requires: ["route-review"],
      acceptance: ["The worker revises the plan from feedback."],
      ...(options.withContext
        ? { context: { feedbackFrom: ["review-plan"] } }
        : {}),
    },
    {
      id: "done",
      title: "Complete the review",
      requires: ["route-review"],
      acceptance: ["The review is complete."],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const requestAndAnswer = (
  state: HypagraphState,
  answer: {
    responseId: string;
    freeText?: string;
    feedbackArtifact?: { ref: string; mediaType?: string; byteLength?: number };
  },
  attemptId = "attempt-1",
) => {
  let next = apply(state, {
    type: "request-interaction",
    nodeId: "review-plan",
    attemptId,
    commandId: `command-request-${attemptId}`,
    at,
  }).state;
  next = apply(next, {
    type: "answer-interaction",
    nodeId: "review-plan",
    attemptId,
    responseId: answer.responseId,
    ...(answer.freeText === undefined ? {} : { freeText: answer.freeText }),
    ...(answer.feedbackArtifact === undefined ? {} : { feedbackArtifact: answer.feedbackArtifact }),
    commandId: `command-answer-${attemptId}`,
    at: later,
  }).state;
  return next;
};

describe("M6.1 Slice 3 routing, free text, and feedback", () => {
  it("accepts freeText notes and feedback on a closed interaction", () => {
    const diagnostics = validateDefinition(reviewGraph(closedInteraction({
      freeText: { prompt: "Optional notes", maxBytes: 1_024 },
      feedback: { maxBytes: 4_096, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true }));
    expect(diagnostics).toEqual([]);
  });

  it("rejects freeText with openAnswer and freeText without responses", () => {
    const withOpen = validateDefinition({
      title: "t",
      goal: "g",
      nodes: [{
        id: "ask",
        title: "Ask",
        kind: "interaction",
        requires: [],
        acceptance: [],
        produces: [{ name: "ask.answer", type: "string", required: true }],
        interaction: {
          kind: "interaction",
          version: 1,
          presentation: { class: "deterministic", kind: "none" },
          question: "What?",
          openAnswer: { prompt: "Type", maxBytes: 100, fact: "ask.answer" },
          freeText: { prompt: "Notes", maxBytes: 100 },
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    });
    expect(withOpen.map((item) => item.code)).toContain("interaction_free_text_with_open_answer");

    const withoutResponses = validateDefinition({
      title: "t",
      goal: "g",
      nodes: [{
        id: "ask",
        title: "Ask",
        kind: "interaction",
        requires: [],
        acceptance: [],
        interaction: {
          kind: "interaction",
          version: 1,
          presentation: { class: "deterministic", kind: "none" },
          question: "What?",
          freeText: { prompt: "Notes", maxBytes: 100 },
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    });
    expect(withoutResponses.map((item) => item.code)).toEqual(
      expect.arrayContaining(["interaction_answer_required", "interaction_free_text_requires_responses"]),
    );
  });

  it("never changes a route because of free text notes", () => {
    const definition = reviewGraph(closedInteraction({
      freeText: { prompt: "Optional notes", maxBytes: 1_024 },
    }));
    const createdA = createWorkflow(definition, at, "workflow-free-text-a");
    const createdB = createWorkflow(definition, at, "workflow-free-text-b");
    if (!createdA.ok || !createdB.ok) throw new Error("create failed");

    let stateA = requestAndAnswer(createdA.state, {
      responseId: "changes_requested",
      freeText: "Please rewrite section 2 with more detail about the gate path.",
    });
    let stateB = requestAndAnswer(createdB.state, {
      responseId: "changes_requested",
    });

    expect(stateA.runtime.facts["review.changes_requested"]?.value).toBe(true);
    expect(stateB.runtime.facts["review.changes_requested"]?.value).toBe(true);

    stateA = apply(stateA, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-a",
      at: later,
    }).state;
    stateB = apply(stateB, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-b",
      at: later,
    }).state;

    expect(stateA.runtime.routes["route-review"]?.outcomeId).toBe("true");
    expect(stateB.runtime.routes["route-review"]?.outcomeId).toBe("true");
    expect(stateA.runtime.nodes["revise-work"]?.status).toBe("ready");
    expect(stateB.runtime.nodes["revise-work"]?.status).toBe("ready");
    expect(stateA.runtime.nodes["done"]?.status).toBe("skipped");
    expect(stateB.runtime.nodes["done"]?.status).toBe("skipped");

    // Free text is evidence only. The full bounded body is durable on the attempt.
    const notes = "Please rewrite section 2 with more detail about the gate path.";
    const attempt = stateA.runtime.nodes["review-plan"]!.attempts["attempt-1"]!;
    const freeTextEvidence = attempt.evidence.find((item) => item.ref.endsWith(":free-text"));
    expect(freeTextEvidence?.summary).toBe(notes);
    expect(attempt.freeText).toBe(notes);
    // Published facts keep a short summary and do not change the route.
    expect(stateA.runtime.facts["review.changes_requested"]?.evidence.some(
      (item) => item.summary === notes,
    )).toBe(false);
  });

  it("keeps free-text notes in full after answer and replay", () => {
    const longNotes = "A".repeat(200) + " end-marker-must-survive";
    const definition = reviewGraph(closedInteraction({
      freeText: { prompt: "Optional notes", maxBytes: 1_024 },
    }));
    const created = createWorkflow(definition, at, "workflow-free-text-durable");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events: DomainEvent[] = [...created.events];
    let state = created.state;

    const requested = apply(state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    });
    state = requested.state;
    events.push(...requested.events);

    const freeTextArtifact = {
      ref: "memory://checks/wf/review-plan/attempt-1/free-text",
      mediaType: "text/plain; charset=utf-8",
      byteLength: Buffer.byteLength(longNotes, "utf8"),
    };
    const answered = apply(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "changes_requested",
      freeText: longNotes,
      freeTextArtifact,
      commandId: "command-answer",
      at: later,
    });
    state = answered.state;
    events.push(...answered.events);

    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.freeText).toBe(longNotes);
    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.freeTextArtifactRef)
      .toBe(freeTextArtifact.ref);
    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.evidence.find(
      (item) => item.ref === freeTextArtifact.ref,
    )?.summary).toBe(longNotes);
    expect(answered.events.find((event) => event.type === "hypagraph.interaction.answered")?.data)
      .toMatchObject({ freeText: longNotes, freeTextArtifactRef: freeTextArtifact.ref });

    const replayed = replayEvents(events);
    expect(replayed.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.freeText).toBe(longNotes);
    expect(replayed.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.freeTextArtifactRef)
      .toBe(freeTextArtifact.ref);
    expect(replayed.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.evidence.find(
      (item) => item.ref === freeTextArtifact.ref,
    )?.summary).toBe(longNotes);
  });

  it("never changes a route because of a feedback artifact", () => {
    const definition = reviewGraph(closedInteraction({
      feedback: { maxBytes: 4_096, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true });
    const createdA = createWorkflow(definition, at, "workflow-feedback-route-a");
    const createdB = createWorkflow(definition, at, "workflow-feedback-route-b");
    if (!createdA.ok || !createdB.ok) throw new Error("create failed");

    let stateA = requestAndAnswer(createdA.state, {
      responseId: "approve",
      feedbackArtifact: {
        ref: "memory://checks/wf/review-plan/attempt-1/feedback.json",
        mediaType: "application/json; charset=utf-8",
        byteLength: 32,
      },
    });
    let stateB = requestAndAnswer(createdB.state, {
      responseId: "approve",
    });

    stateA = apply(stateA, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-a",
      at: later,
    }).state;
    stateB = apply(stateB, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-b",
      at: later,
    }).state;

    expect(stateA.runtime.routes["route-review"]?.outcomeId).toBe("false");
    expect(stateB.runtime.routes["route-review"]?.outcomeId).toBe("false");
    expect(stateA.runtime.nodes["done"]?.status).toBe("ready");
    expect(stateB.runtime.nodes["done"]?.status).toBe("ready");
    expect(stateA.runtime.nodes["revise-work"]?.status).toBe("skipped");
    expect(stateB.runtime.nodes["revise-work"]?.status).toBe("skipped");
  });

  it("reaches the next task through context projection with the feedback artifact ref", () => {
    const feedbackRef = "memory://checks/wf/review-plan/attempt-1/annotations.json";
    const definition = reviewGraph(closedInteraction({
      feedback: { maxBytes: 8_192, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true });
    const created = createWorkflow(definition, at, "workflow-feedback-context");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    let state = requestAndAnswer(created.state, {
      responseId: "changes_requested",
      feedbackArtifact: {
        ref: feedbackRef,
        mediaType: "application/json; charset=utf-8",
        byteLength: 128,
      },
    });
    state = apply(state, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-1",
      at: later,
    }).state;

    expect(state.runtime.nodes["revise-work"]?.status).toBe("ready");
    const context = projectTaskContext(state, "revise-work");
    expect(context.feedbackArtifacts).toEqual([{
      fromNodeId: "review-plan",
      attemptId: "attempt-1",
      ref: feedbackRef,
    }]);
  });

  it("behaves like a gate after a check: published facts select the route", () => {
    const created = createWorkflow(reviewGraph(closedInteraction()), at, "workflow-gate-after-interaction");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestAndAnswer(created.state, { responseId: "changes_requested" });
    expect(state.runtime.nodes["route-review"]?.status).toBe("ready");

    const evaluated = apply(state, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-1",
      at: later,
    });
    state = evaluated.state;
    expect(evaluated.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.route.selected",
    ]));
    expect(state.runtime.routes["route-review"]).toMatchObject({
      outcomeId: "true",
      targetNodeIds: ["revise-work"],
      factsUsed: ["review.changes_requested"],
    });
  });

  it("acceptance: changes_requested with annotations routes to the worker with feedback context", () => {
    const annotations = JSON.stringify({
      annotations: [
        { line: 12, comment: "Clarify the gate condition." },
        { line: 40, comment: "Add the reload path." },
      ],
    });
    const feedbackRef = "memory://checks/acceptance/review-plan/attempt-1/line-annotations.json";
    const definition = reviewGraph(closedInteraction({
      feedback: { maxBytes: 16_384, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true });

    expect(validateDefinition(definition)).toEqual([]);
    const created = createWorkflow(definition, at, "workflow-acceptance-annotations");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events: DomainEvent[] = [...created.events];

    let state = created.state;
    const requested = apply(state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    });
    state = requested.state;
    events.push(...requested.events);

    const answered = apply(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "changes_requested",
      feedbackArtifact: {
        ref: feedbackRef,
        mediaType: "application/json; charset=utf-8",
        byteLength: Buffer.byteLength(annotations, "utf8"),
      },
      commandId: "command-answer",
      at: later,
    });
    state = answered.state;
    events.push(...answered.events);

    expect(state.runtime.facts["review.changes_requested"]?.value).toBe(true);
    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.feedbackArtifactRef).toBe(feedbackRef);

    const gated = apply(state, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "command-gate",
      at: later,
    });
    state = gated.state;
    events.push(...gated.events);

    expect(state.runtime.nodes["revise-work"]?.status).toBe("ready");
    expect(state.runtime.nodes["done"]?.status).toBe("skipped");
    expect(projectTaskContext(state, "revise-work").feedbackArtifacts).toEqual([{
      fromNodeId: "review-plan",
      attemptId: "attempt-1",
      ref: feedbackRef,
    }]);

    const replayed = replayEvents(events);
    expect(replayed.runtime.facts["review.changes_requested"]?.value).toBe(true);
    expect(replayed.runtime.nodes["revise-work"]?.status).toBe("ready");
    expect(projectTaskContext(replayed, "revise-work").feedbackArtifacts[0]?.ref).toBe(feedbackRef);
  });

  it("rejects feedback which exceeds the declared byte bound", () => {
    const created = createWorkflow(reviewGraph(closedInteraction({
      feedback: { maxBytes: 16 },
    }), { withContext: true }), at, "workflow-feedback-too-large");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const result = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "changes_requested",
      feedbackArtifact: {
        ref: "memory://checks/wf/review-plan/attempt-1/big.json",
        byteLength: 64,
      },
      commandId: "command-answer",
      at: later,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("interaction_feedback_too_large");
  });

  it("rejects feedback without byteLength", () => {
    const created = createWorkflow(reviewGraph(closedInteraction({
      feedback: { maxBytes: 1_024 },
    }), { withContext: true }), at, "workflow-feedback-no-bytes");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const result = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "changes_requested",
      feedbackArtifact: {
        ref: "memory://checks/wf/review-plan/attempt-1/feedback.json",
      },
      commandId: "command-answer",
      at: later,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("interaction_feedback_byte_length_required");
  });

  it("rejects freeText that is too large, not declared, or used on an open question", () => {
    const closed = createWorkflow(reviewGraph(closedInteraction({
      freeText: { prompt: "Notes", maxBytes: 8 },
    })), at, "workflow-free-text-errors");
    if (!closed.ok) throw new Error(JSON.stringify(closed.diagnostics));
    let state = apply(closed.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const tooLarge = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      freeText: "this is longer than eight",
      commandId: "command-answer",
      at: later,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.diagnostics[0]?.code).toBe("interaction_free_text_too_large");

    const noFreeText = createWorkflow(reviewGraph(closedInteraction()), at, "workflow-free-text-undeclared");
    if (!noFreeText.ok) throw new Error(JSON.stringify(noFreeText.diagnostics));
    state = apply(noFreeText.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const undeclared = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      freeText: "notes",
      commandId: "command-answer",
      at: later,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.diagnostics[0]?.code).toBe("interaction_free_text_not_declared");

    const openDefinition: HypagraphDefinition = {
      title: "Open",
      goal: "Clarify",
      nodes: [{
        id: "clarify",
        title: "Clarify",
        kind: "interaction",
        requires: [],
        acceptance: [],
        produces: [{ name: "clarify.answer", type: "string", required: true }],
        interaction: {
          kind: "interaction",
          version: 1,
          presentation: { class: "deterministic", kind: "none" },
          question: "What changed?",
          openAnswer: { prompt: "Type the change", maxBytes: 200, fact: "clarify.answer" },
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const openCreated = createWorkflow(openDefinition, at, "workflow-free-text-open");
    if (!openCreated.ok) throw new Error(JSON.stringify(openCreated.diagnostics));
    state = apply(openCreated.state, {
      type: "request-interaction",
      nodeId: "clarify",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const onOpen = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "clarify",
      attemptId: "attempt-1",
      openText: "retry",
      freeText: "notes",
      commandId: "command-answer",
      at: later,
    });
    expect(onOpen.ok).toBe(false);
    if (!onOpen.ok) expect(onOpen.diagnostics[0]?.code).toBe("interaction_free_text_open_question");
  });

  it("rejects feedback not declared, missing ref, and mediaType mismatch", () => {
    const noFeedback = createWorkflow(reviewGraph(closedInteraction()), at, "workflow-feedback-undeclared");
    if (!noFeedback.ok) throw new Error(JSON.stringify(noFeedback.diagnostics));
    let state = apply(noFeedback.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const undeclared = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      feedbackArtifact: { ref: "memory://x", byteLength: 1 },
      commandId: "command-answer",
      at: later,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.diagnostics[0]?.code).toBe("interaction_feedback_not_declared");

    const declared = createWorkflow(reviewGraph(closedInteraction({
      feedback: { maxBytes: 1_024, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true }), at, "workflow-feedback-ref-media");
    if (!declared.ok) throw new Error(JSON.stringify(declared.diagnostics));
    state = apply(declared.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const missingRef = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      feedbackArtifact: { ref: "   ", byteLength: 1 },
      commandId: "command-answer",
      at: later,
    });
    expect(missingRef.ok).toBe(false);
    if (!missingRef.ok) expect(missingRef.diagnostics[0]?.code).toBe("interaction_feedback_ref_required");

    const mediaMismatch = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      feedbackArtifact: {
        ref: "memory://checks/wf/review-plan/attempt-1/feedback.txt",
        mediaType: "text/plain; charset=utf-8",
        byteLength: 4,
      },
      commandId: "command-answer",
      at: later,
    });
    expect(mediaMismatch.ok).toBe(false);
    if (!mediaMismatch.ok) expect(mediaMismatch.diagnostics[0]?.code).toBe("interaction_feedback_media_type_mismatch");

    // Omitting mediaType is allowed when the definition declares one. The declared type is the authority.
    const accepted = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      feedbackArtifact: {
        ref: "memory://checks/wf/review-plan/attempt-1/feedback.json",
        byteLength: 2,
      },
      commandId: "command-answer-default-media",
      at: later,
    });
    expect(accepted.ok).toBe(true);
  });

  it("delivers task context to continuation prompts and model-visible summary", () => {
    const feedbackRef = "memory://checks/wf/review-plan/attempt-1/annotations.json";
    const definition = reviewGraph(closedInteraction({
      feedback: { maxBytes: 8_192, mediaType: "application/json; charset=utf-8" },
    }), { withContext: true });
    const created = createWorkflow(definition, at, "workflow-worker-context");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestAndAnswer(created.state, {
      responseId: "changes_requested",
      feedbackArtifact: { ref: feedbackRef, mediaType: "application/json; charset=utf-8", byteLength: 64 },
    });
    state = apply(state, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "gate-1",
      at: later,
    }).state;
    state = apply(state, {
      type: "start-goal",
      goalId: "goal-worker-context",
      commandId: "command-start-goal",
      at: later,
    }).state;

    const action = {
      kind: "start-ready-task" as const,
      nodeId: "revise-work",
      goalId: "goal-worker-context",
      workflowId: state.workflowId,
      revision: state.revision,
      sequence: state.sequence,
      snapshotHash: state.snapshotHash,
      continuationOrdinal: state.goal?.continuationOrdinal ?? 0,
    };
    const prompt = buildGoalContinuationPrompt(action, state, "op-1");
    expect(prompt).toContain(feedbackRef);
    expect(prompt).toContain("feedback from 'review-plan'");
    expect(prompt).toContain("hypagraph_read returns taskContexts feedback artifact refs only");
    expect(prompt).toContain("Open each feedback artifact at its ref");
    expect(prompt).not.toContain("Read feedback artifact refs with hypagraph_read. Use the declared feedback as task input");

    const system = continuationSystemPrompt({
      operationId: "op-1",
      turnId: "turn-1",
      action,
      requestedOrdinal: 0,
      requestSequence: state.sequence,
      selectedSequence: state.sequence,
      selectedSnapshotHash: state.snapshotHash,
      committedSequence: state.sequence,
      committedSnapshotHash: state.snapshotHash,
      sessionGeneration: 1,
      branchGeneration: 1,
      prompt,
    }, state);
    expect(system).toContain(feedbackRef);

    const summary = projectModelVisibleWorkflowSummary(state);
    expect(summary.taskContexts).toEqual([{
      nodeId: "revise-work",
      feedbackArtifacts: [{
        fromNodeId: "review-plan",
        attemptId: "attempt-1",
        ref: feedbackRef,
      }],
    }]);
    expect(projectAllTaskContexts(state)).toHaveLength(1);
    expect(renderTaskContextLines(state, "revise-work")[1]).toContain(feedbackRef);
  });

  it("finds feedback on the latest succeeded attempt when currentAttemptId is cleared", () => {
    const feedbackRef = "memory://checks/wf/review-plan/attempt-1/annotations.json";
    const definition = reviewGraph(closedInteraction({
      feedback: { maxBytes: 1_024 },
    }), { withContext: true });
    const created = createWorkflow(definition, at, "workflow-context-no-current");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestAndAnswer(created.state, {
      responseId: "changes_requested",
      feedbackArtifact: { ref: feedbackRef, byteLength: 16 },
    });
    // Simulate a path that clears currentAttemptId after success.
    delete state.runtime.nodes["review-plan"]!.currentAttemptId;
    expect(projectTaskContext(state, "revise-work").feedbackArtifacts).toEqual([{
      fromNodeId: "review-plan",
      attemptId: "attempt-1",
      ref: feedbackRef,
    }]);
  });
});

describe("M6.1 Slice 3 level-triggered deadlines", () => {
  it("stores an absolute deadline on request from durationMs", () => {
    const definition = reviewGraph(closedInteraction({
      timeout: { durationMs: 60_000, onTimeout: "block" },
    }));
    const created = createWorkflow(definition, at, "workflow-deadline-store");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const requested = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    });
    const attempt = requested.state.runtime.nodes["review-plan"]!.attempts["attempt-1"]!;
    expect(attempt.deadline).toEqual({
      absolute: "2026-07-28T12:01:00.000Z",
      source: "requested-at-plus-duration",
    });
    expect(attempt.timeoutPolicy).toEqual({ onTimeout: "block" });
    expect(requested.events.find((event) => event.type === "hypagraph.interaction.requested")?.data)
      .toMatchObject({
        deadline: {
          absolute: "2026-07-28T12:01:00.000Z",
          source: "requested-at-plus-duration",
        },
      });
  });

  it("blocks the node when the deadline passed on the next wake", () => {
    const definition = reviewGraph(closedInteraction({
      timeout: { durationMs: 60_000, onTimeout: "block" },
    }));
    const created = createWorkflow(definition, at, "workflow-deadline-block");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;

    expect(expiredInteractionCandidates(state, tooEarly)).toEqual([]);
    expect(expiredInteractionCandidates(state, later)).toHaveLength(1);

    const early = handleCommand(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire-early",
      at: tooEarly,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.diagnostics[0]?.code).toBe("interaction_deadline_not_passed");

    const expired = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire",
      at: later,
    });
    state = expired.state;
    expect(expired.events.map((event) => event.type)).toContain("hypagraph.interaction.expired");
    expect(state.runtime.nodes["review-plan"]?.status).toBe("blocked");
    expect(state.runtime.nodes["review-plan"]?.blockedReason).toMatch(/deadline/);
    expect(state.runtime.nodes["review-plan"]?.blockerKind).toBe("external-dependency");
  });

  it("publishes the default facts when the deadline select action fires", () => {
    const definition = reviewGraph(closedInteraction({
      timeout: {
        durationMs: 60_000,
        onTimeout: "select",
        selectResponseId: "approve",
      },
    }));
    const created = createWorkflow(definition, at, "workflow-deadline-select");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;

    const expired = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire",
      at: later,
    });
    state = expired.state;
    expect(expired.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.interaction.expired",
      "hypagraph.fact.published",
      "hypagraph.verification.passed",
    ]));
    expect(state.runtime.nodes["review-plan"]?.status).toBe("succeeded");
    expect(state.runtime.facts["review.changes_requested"]?.value).toBe(false);
    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.responseId).toBe("approve");

    state = apply(state, {
      type: "evaluate-gate",
      nodeId: "route-review",
      commandId: "command-gate",
      at: later,
    }).state;
    expect(state.runtime.routes["route-review"]?.outcomeId).toBe("false");
    expect(state.runtime.nodes["done"]?.status).toBe("ready");
  });

  it("rejects a select timeout without a declared response", () => {
    const codes = validateDefinition(reviewGraph(closedInteraction({
      timeout: { durationMs: 1_000, onTimeout: "select" },
    }))).map((item) => item.code);
    expect(codes).toContain("interaction_timeout_select_required");
  });

  it("replays a blocked deadline expiry", () => {
    const definition = reviewGraph(closedInteraction({
      timeout: { absolute: "2026-07-28T12:05:00.000Z", onTimeout: "block" },
    }));
    const created = createWorkflow(definition, at, "workflow-deadline-replay");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events: DomainEvent[] = [...created.events];
    let state = created.state;

    const requested = apply(state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    });
    state = requested.state;
    events.push(...requested.events);
    expect(state.runtime.nodes["review-plan"]?.attempts["attempt-1"]?.deadline).toEqual({
      absolute: "2026-07-28T12:05:00.000Z",
      source: "declared-absolute",
    });

    const expired = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire",
      at: later,
    });
    events.push(...expired.events);
    const replayed = replayEvents(events);
    expect(replayed.runtime.nodes["review-plan"]?.status).toBe("blocked");
  });

  it("rejects expire without a deadline, double expire, and answer after expire", () => {
    const withTimeout = reviewGraph(closedInteraction({
      timeout: { durationMs: 60_000, onTimeout: "block" },
    }));
    const withoutTimeout = reviewGraph(closedInteraction());
    const createdNoDeadline = createWorkflow(withoutTimeout, at, "workflow-expire-no-deadline");
    if (!createdNoDeadline.ok) throw new Error(JSON.stringify(createdNoDeadline.diagnostics));
    let state = apply(createdNoDeadline.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    const missing = handleCommand(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire",
      at: later,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0]?.code).toBe("interaction_deadline_missing");

    const created = createWorkflow(withTimeout, at, "workflow-expire-double");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    state = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire-1",
      at: later,
    }).state;
    const double = handleCommand(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire-2",
      at: later,
    });
    expect(double.ok).toBe(false);
    if (!double.ok) expect(double.diagnostics[0]?.code).toBe("interaction_not_awaiting");

    const answerAfterBlock = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      commandId: "command-answer-after-block",
      at: later,
    });
    expect(answerAfterBlock.ok).toBe(false);
    if (!answerAfterBlock.ok) expect(answerAfterBlock.diagnostics[0]?.code).toBe("interaction_not_awaiting");

    const selectGraph = reviewGraph(closedInteraction({
      timeout: { durationMs: 60_000, onTimeout: "select", selectResponseId: "approve" },
    }));
    const selectCreated = createWorkflow(selectGraph, at, "workflow-expire-select-then-answer");
    if (!selectCreated.ok) throw new Error(JSON.stringify(selectCreated.diagnostics));
    state = apply(selectCreated.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    state = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire-select",
      at: later,
    }).state;
    const answerAfterSelect = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      responseId: "changes_requested",
      commandId: "command-answer-after-select",
      at: later,
    });
    expect(answerAfterSelect.ok).toBe(false);
    if (!answerAfterSelect.ok) expect(answerAfterSelect.diagnostics[0]?.code).toBe("interaction_not_awaiting");
  });

  it("applies a deadline that was already past at request time on the next evaluation", () => {
    const past = "2026-07-28T11:00:00.000Z";
    const definition = reviewGraph(closedInteraction({
      timeout: { absolute: past, onTimeout: "block" },
    }));
    const created = createWorkflow(definition, at, "workflow-deadline-already-past");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = apply(created.state, {
      type: "request-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-request",
      at,
    }).state;
    expect(state.runtime.nodes["review-plan"]?.status).toBe("awaiting_response");
    expect(expiredInteractionCandidates(state, at)).toHaveLength(1);
    state = apply(state, {
      type: "expire-interaction",
      nodeId: "review-plan",
      attemptId: "attempt-1",
      commandId: "command-expire",
      at,
    }).state;
    expect(state.runtime.nodes["review-plan"]?.status).toBe("blocked");
  });
});
