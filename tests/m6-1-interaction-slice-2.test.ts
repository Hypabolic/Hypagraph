import { describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { DefaultPresentationExecutor } from "../src/checks/presentation-executor.js";
import type {
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
  InteractionPresentation,
} from "../src/domain/model.js";
import {
  interactionPresentationNeedsEffect,
  interactionPresentationSucceeded,
} from "../src/domain/interaction-presentation.js";
import { renderInteractionReport } from "../src/domain/presentation-report.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-28T12:00:00.000Z";

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const baseInteraction = (
  presentation: InteractionPresentation,
): HypagraphDefinition => ({
  title: "Presentation effect graph",
  goal: "Present a report and accept an answer",
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
        presentation,
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
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const requestInteraction = (state: HypagraphState, attemptId = "attempt-1") =>
  apply(state, {
    type: "request-interaction",
    nodeId: "approve-plan",
    attemptId,
    commandId: `command-request-${attemptId}`,
    at,
  });

describe("M6.1 Slice 2 deterministic presentation effects", () => {
  it("accepts report and command presentation definitions", () => {
    expect(validateDefinition(baseInteraction({ class: "deterministic", kind: "none" }))).toEqual([]);
    expect(validateDefinition(baseInteraction({
      class: "deterministic",
      kind: "report",
      mediaType: "text/markdown; charset=utf-8",
      maxBytes: 4_096,
    }))).toEqual([]);
    expect(validateDefinition(baseInteraction({
      class: "deterministic",
      kind: "command",
      command: "true",
      timeoutMs: 1_000,
    }))).toEqual([]);
  });

  it("rejects a semantic presentation until M7 exists", () => {
    const codes = validateDefinition(baseInteraction({ class: "semantic", kind: "report" }))
      .map((item) => item.code);
    expect(codes).toContain("semantic_presentation_requires_m7");
  });

  it("rejects unsafe command presentation fields", () => {
    const codes = validateDefinition(baseInteraction({
      class: "deterministic",
      kind: "command",
      command: "echo",
      timeoutMs: 1_000,
      workingDirectory: "../outside",
    })).map((item) => item.code);
    expect(codes).toContain("interaction_presentation_working_directory_outside_workspace");
  });

  it("runs the presentation effect after the request event and never before", async () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-order",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const events: DomainEvent[] = [...created.events];

    const requestIndexBefore = events.findIndex((event) => event.type === "hypagraph.interaction.requested");
    expect(requestIndexBefore).toBe(-1);

    const requested = requestInteraction(state);
    state = requested.state;
    events.push(...requested.events);

    const requestIndex = events.findIndex((event) => event.type === "hypagraph.interaction.requested");
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(events.some((event) => event.type === "hypagraph.interaction.presented")).toBe(false);
    expect(interactionPresentationNeedsEffect(state, "approve-plan", "attempt-1")).toBe(true);

    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });
    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("succeeded");
    expect(observation.artifactRef).toBeDefined();

    const presented = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present",
      at,
    });
    state = presented.state;
    events.push(...presented.events);

    const presentedIndex = events.findIndex((event) => event.type === "hypagraph.interaction.presented");
    expect(presentedIndex).toBeGreaterThan(requestIndex);
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
    expect(interactionPresentationSucceeded(state, "approve-plan", "attempt-1")).toBe(true);
    expect(interactionPresentationNeedsEffect(state, "approve-plan", "attempt-1")).toBe(false);
  });

  it("stores a bounded presentation artifact by identity", async () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report", maxBytes: 65_536 }),
      at,
      "workflow-presentation-artifact",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestInteraction(created.state).state;

    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });
    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("succeeded");
    expect(observation.artifactRef).toMatch(/^memory:\/\//);
    const artifact = await store.read(observation.artifactRef!, 65_536);
    expect(artifact).toBeDefined();
    expect(artifact!.content.byteLength).toBeGreaterThan(0);
    expect(artifact!.content.byteLength).toBeLessThanOrEqual(65_536);

    state = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present",
      at,
    }).state;

    expect(state.runtime.nodes["approve-plan"]?.attempts["attempt-1"]?.presentation?.artifactRef)
      .toBe(observation.artifactRef);
  });

  it("produces deterministic report content from state", () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-report",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;

    const first = renderInteractionReport(state, "approve-plan");
    const second = renderInteractionReport(state, "approve-plan");
    expect(first).toBe(second);
    expect(first).toContain("# Interaction report");
    expect(first).toContain("Approve the implementation plan?");
    expect(first).toContain("`approve-plan`");
    expect(first).toContain(state.snapshotHash);
  });

  it("records an explicit failed state when the presentation effect fails", async () => {
    const created = createWorkflow(
      baseInteraction({
        class: "deterministic",
        kind: "command",
        command: process.execPath,
        arguments: ["-e", "process.exit(2)"],
        timeoutMs: 2_000,
      }),
      at,
      "workflow-presentation-failed",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestInteraction(created.state).state;

    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });
    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("failed");

    const presented = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present-failed",
      at,
    });
    state = presented.state;

    expect(state.runtime.nodes["approve-plan"]?.status).toBe("failed");
    expect(state.runtime.nodes["approve-plan"]?.attempts["attempt-1"]?.presentation?.status).toBe("failed");
    expect(state.runtime.nodes["approve-plan"]?.attempts["attempt-1"]?.status).toBe("failed");
    expect(presented.events.map((event) => event.type)).toContain("hypagraph.interaction.presented");

    const answer = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      commandId: "command-answer",
      at,
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.diagnostics.map((item) => item.code)).toContain("interaction_not_awaiting");
    }
  });

  it("allows the answer flow after a successful presentation", async () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-answer",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const requested = requestInteraction(created.state);
    let state = requested.state;
    const allEvents: DomainEvent[] = [...created.events, ...requested.events];

    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });
    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    const presented = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present",
      at,
    });
    state = presented.state;
    allEvents.push(...presented.events);

    const answered = apply(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      commandId: "command-answer",
      at,
    });
    state = answered.state;
    allEvents.push(...answered.events);

    expect(state.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(state.runtime.nodes["approve-plan"]?.status).toBe("succeeded");
    expect(state.runtime.nodes["after-approval"]?.status).toBe("ready");

    const types = allEvents.map((event) => event.type);
    const requestAt = types.indexOf("hypagraph.interaction.requested");
    const presentAt = types.indexOf("hypagraph.interaction.presented");
    const answerAt = types.indexOf("hypagraph.interaction.answered");
    expect(requestAt).toBeGreaterThanOrEqual(0);
    expect(presentAt).toBeGreaterThan(requestAt);
    expect(answerAt).toBeGreaterThan(presentAt);

    const replayed = replayEvents(allEvents);
    expect(replayed.runtime.facts["plan.approved"]?.value).toBe(true);
    expect(replayed.runtime.nodes["approve-plan"]?.attempts["attempt-1"]?.presentation?.status)
      .toBe("succeeded");
  });

  it("does not re-run a successful presentation effect when the observation already exists", async () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-no-rerun",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = requestInteraction(created.state).state;

    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });
    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    state = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present",
      at,
    }).state;

    expect(interactionPresentationNeedsEffect(state, "approve-plan", "attempt-1")).toBe(false);
    expect(store.artifacts.size).toBe(1);

    const second = handleCommand(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present-again",
      at,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.diagnostics.map((item) => item.code)).toContain("interaction_already_presented");
    }
  });

  it("stores a command presentation artifact on success", async () => {
    const created = createWorkflow(
      baseInteraction({
        class: "deterministic",
        kind: "command",
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('plan summary')"],
        timeoutMs: 2_000,
      }),
      at,
      "workflow-presentation-command",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;
    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });

    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("succeeded");
    expect(observation.artifactRef).toBeDefined();
    const artifact = await store.read(observation.artifactRef!, 1_048_576);
    expect(new TextDecoder().decode(artifact!.content)).toBe("plan summary");
  });

  it("rejects an answer when a report presentation has no observation", () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-answer-requires-present",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;

    const answer = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      commandId: "command-answer-without-present",
      at,
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.diagnostics.map((item) => item.code)).toContain("interaction_presentation_observation_required");
    }
  });

  it("rejects an answer when a command presentation has no observation", () => {
    const created = createWorkflow(
      baseInteraction({
        class: "deterministic",
        kind: "command",
        command: "true",
        timeoutMs: 1_000,
      }),
      at,
      "workflow-presentation-command-answer-requires-present",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;

    const answer = handleCommand(state, {
      type: "answer-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      responseId: "approve",
      commandId: "command-answer-without-present",
      at,
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.diagnostics.map((item) => item.code)).toContain("interaction_presentation_observation_required");
    }
  });

  it("fails a report presentation which exceeds maxBytes", async () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report", maxBytes: 16 }),
      at,
      "workflow-presentation-report-overflow",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;
    const store = new MemoryCheckArtifactStore();
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: store,
      now: () => new Date(at),
    });

    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("failed");
    expect(observation.error).toContain("exceeds the maximum");
    expect(store.artifacts.size).toBe(0);

    const presented = apply(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: observation,
      commandId: "command-present-overflow",
      at,
    });
    expect(presented.state.runtime.nodes["approve-plan"]?.status).toBe("failed");
  });

  it("records timed_out when a command presentation exceeds its timeout", async () => {
    const created = createWorkflow(
      baseInteraction({
        class: "deterministic",
        kind: "command",
        command: process.execPath,
        arguments: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000)"],
        timeoutMs: 50,
      }),
      at,
      "workflow-presentation-timeout",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: new MemoryCheckArtifactStore(),
      now: () => new Date(at),
    });

    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, new AbortController().signal);

    expect(observation.status).toBe("timed_out");
  });

  it("records cancelled when a command presentation is aborted", async () => {
    const created = createWorkflow(
      baseInteraction({
        class: "deterministic",
        kind: "command",
        command: process.execPath,
        arguments: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000)"],
        timeoutMs: 5_000,
      }),
      at,
      "workflow-presentation-cancelled",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;
    const executor = new DefaultPresentationExecutor({
      rootDirectory: process.cwd(),
      artifactStore: new MemoryCheckArtifactStore(),
      now: () => new Date(at),
    });
    const controller = new AbortController();
    controller.abort();

    const observation = await executor.execute({
      state,
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      presentation: state.definition.nodes[0]!.interaction!.presentation,
      requestedAt: at,
    }, controller.signal);

    expect(observation.status).toBe("cancelled");
  });

  it("rejects a present observation whose kind does not match the definition", () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-kind-mismatch",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;

    const result = handleCommand(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: {
        status: "succeeded",
        kind: "none",
        presentedAt: at,
      },
      commandId: "command-present-mismatch",
      at,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("interaction_presentation_kind_mismatch");
    }
  });

  it("rejects a successful report presentation without an artifact reference", () => {
    const created = createWorkflow(
      baseInteraction({ class: "deterministic", kind: "report" }),
      at,
      "workflow-presentation-artifact-required",
    );
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = requestInteraction(created.state).state;

    const result = handleCommand(state, {
      type: "present-interaction",
      nodeId: "approve-plan",
      attemptId: "attempt-1",
      result: {
        status: "succeeded",
        kind: "report",
        presentedAt: at,
      },
      commandId: "command-present-no-artifact",
      at,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("interaction_presentation_artifact_required");
    }
  });

  it("redacts protected evaluator detail in the presentation report", () => {
    const definition: HypagraphDefinition = {
      title: "Protected report",
      goal: "Hide protected evaluator detail in reports",
      nodes: [
        {
          id: "probe",
          title: "Protected probe",
          kind: "check",
          requires: [],
          acceptance: [],
          produces: [{ name: "probe.note", type: "string", required: false }],
          check: {
            kind: "metric-report",
            command: "true",
            timeoutMs: 1_000,
            reportPath: "report.json",
            parser: { name: "metric-json", version: 1 },
            mappings: [{ source: "note", fact: "probe.note", type: "string", required: false }],
            evaluation: {
              kind: "holdout",
              feedback: { mode: "aggregate" },
            },
          },
        },
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
            presentation: { class: "deterministic", kind: "report" },
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
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };

    const created = createWorkflow(definition, at, "workflow-presentation-redaction");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    // Publish a string fact from the protected probe through a synthetic fact record.
    const state: HypagraphState = {
      ...created.state,
      runtime: {
        ...created.state.runtime,
        facts: {
          "probe.note": {
            name: "probe.note",
            type: "string",
            value: "SECRET_EVALUATOR_PATH=/hidden/eval",
            producerNodeId: "probe",
            attemptId: "attempt-probe",
            revision: created.state.revision,
            evidence: [],
            eventId: "event-fact",
            sequence: 1,
          },
        },
      },
    };

    const report = renderInteractionReport(state, "approve-plan");
    expect(report).not.toContain("SECRET_EVALUATOR_PATH");
    expect(report).not.toContain("/hidden/eval");
    expect(report).toContain("The evaluator is protected");
  });
});
