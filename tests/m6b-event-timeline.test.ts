import { describe, expect, it, vi } from "vitest";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { isReadyCheckDecision } from "../src/domain/deterministic-check-dispatch.js";
import { dispatchReadyGate, isReadyGateDecision } from "../src/domain/deterministic-gate-dispatch.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphDefinition } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  filterTimelineByLane,
  pageTimeline,
  projectEventTimeline,
  type TimelineEntry,
} from "../src/history/timeline.js";
import { runDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { PI_ASSISTANT_USAGE_SOURCE } from "../src/pi/hypagoal-budget.js";

const at = "2026-07-25T18:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Timeline coverage",
  goal: "Project every stored event",
  nodes: [
    { id: "plan", title: "Plan the change", requires: [], acceptance: [] },
    {
      id: "tests",
      title: "Run tests",
      kind: "check",
      requires: ["plan"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 60_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    {
      id: "route",
      title: "Select the route",
      kind: "gate",
      requires: ["tests"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["ship"],
        onFalse: ["repair"],
      },
    },
    { id: "ship", title: "Ship the change", requires: ["route"], acceptance: [] },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const protectedDefinition = (): HypagraphDefinition => ({
  title: "Protected evaluator timeline",
  goal: "Hide evaluator detail in history",
  nodes: [{
    id: "evaluate",
    title: "Evaluate quality",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "evaluate.score", type: "number", required: false }],
    check: {
      kind: "metric-report",
      command: "protected-evaluator",
      arguments: ["--secret-suite"],
      timeoutMs: 30_000,
      reportPath: "protected/evaluate.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluate.score", type: "number", required: false }],
      evaluation: { kind: "holdout", feedback: { mode: "aggregate" } },
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition = definition(), workflowId = "timeline-workflow") => {
  const result = createHypagoalWorkflow(source, {
    workflowId,
    goalId: "timeline-goal",
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const executorFor = (factory: (attemptId: string) => CheckResult): CheckExecutor => ({
  execute: vi.fn(async (request) => factory(request.attemptId)),
});

const entryFor = (entries: readonly TimelineEntry[], type: string): TimelineEntry => {
  const entry = entries.find((item) => item.type === type);
  if (!entry) throw new Error(`The timeline has no '${type}' entry.`);
  return entry;
};

describe("M6B Slice 1 event timeline projection", () => {
  it("projects one entry for each stored event in sequence order", () => {
    const created = create();
    const entries = projectEventTimeline(created.events);

    expect(entries).toHaveLength(created.events.length);
    expect(entries.map((entry) => entry.sequence)).toEqual(created.events.map((event) => event.sequence));
    expect(entries.map((entry) => entry.eventId)).toEqual(created.events.map((event) => event.eventId));
    expect(entryFor(entries, "hypagraph.workflow.defined")).toMatchObject({
      lane: "workflow",
      summary: "The workflow was defined.",
      redacted: false,
    });
    expect(entryFor(entries, "hypagraph.goal.started")).toMatchObject({ lane: "goal", summary: "The goal started." });
    expect(entryFor(entries, "hypagraph.node.ready")).toMatchObject({
      lane: "node",
      nodeId: "plan",
      summary: "Node 'plan' became ready.",
    });
  });

  it("classifies each lane across a complete deterministic and model run", async () => {
    const created = create();
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const events: DomainEvent[] = [...created.events];
    let state = created.state;

    // One model-lane action for the task.
    const decision = selectGoalContinuation(state);
    if (!isRunnableGoalContinuation(decision)) throw new Error(decision.kind);
    const requested = handleCommand(state, {
      type: "request-goal-continuation",
      goalId: decision.goalId,
      workflowId: decision.workflowId,
      expectedRevision: decision.revision,
      expectedSequence: decision.sequence,
      expectedSnapshotHash: decision.snapshotHash,
      expectedContinuationOrdinal: decision.continuationOrdinal,
      sessionGeneration: 0,
      branchGeneration: 0,
      action: { kind: "start-ready-task", nodeId: "plan" },
      commandId: "model-operation",
      correlationId: "model-operation",
      at,
    });
    if (!requested.ok) throw new Error(JSON.stringify(requested.diagnostics));
    state = requested.state;
    events.push(...requested.events);

    for (const command of [
      { type: "start-node" as const, nodeId: "plan", attemptId: "plan-1", commandId: "start-plan", at },
      { type: "submit-result" as const, nodeId: "plan", attemptId: "plan-1", evidence: [], commandId: "submit-plan", at },
      { type: "begin-verification" as const, nodeId: "plan", attemptId: "plan-1", commandId: "begin-plan", at },
      { type: "complete-verification" as const, nodeId: "plan", attemptId: "plan-1", passed: true, commandId: "verify-plan", at },
    ]) {
      const reduced = handleCommand(state, command);
      if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
      state = reduced.state;
      events.push(...reduced.events);
    }

    const recorded = handleCommand(state, {
      type: "record-goal-turn-usage",
      goalId: decision.goalId,
      workflowId: decision.workflowId,
      expectedRevision: state.revision,
      expectedSequence: state.sequence,
      expectedSnapshotHash: state.snapshotHash,
      continuationOperationId: "model-operation",
      continuationOrdinal: state.goal!.pendingContinuation!.ordinal,
      requestSequence: state.goal!.pendingContinuation!.requestSequence,
      selectedSequence: state.goal!.pendingContinuation!.selectedSequence,
      selectedSnapshotHash: state.goal!.pendingContinuation!.selectedSnapshotHash,
      sessionGeneration: 0,
      branchGeneration: 0,
      turnId: "turn-1",
      source: PI_ASSISTANT_USAGE_SOURCE,
      usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 },
      commandId: "record-turn",
      correlationId: "model-operation",
      at,
    });
    if (!recorded.ok) throw new Error(JSON.stringify(recorded.diagnostics));
    state = recorded.state;
    events.push(...recorded.events);

    // One deterministic check dispatch.
    const checkDecision = selectGoalContinuation(state);
    if (!isRunnableGoalContinuation(checkDecision) || !isReadyCheckDecision(checkDecision)) {
      throw new Error(`Expected a ready check, received '${checkDecision.kind}'.`);
    }
    store.seed({ events, snapshot: state });
    const dispatch = await runDeterministicCheckDispatch({
      state,
      decision: checkDecision,
      dispatchId: "check-dispatch",
      attemptId: "tests-1",
      at,
      finishedAt: at,
      store,
      executor: executorFor((attemptId) => ({
        checkKind: "command",
        attemptId,
        startedAt: at,
        completedAt: at,
        status: "passed",
        exitCode: 0,
        facts: [],
        evidence: [],
      })),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));
    state = dispatch.state;
    events.push(...dispatch.events);

    // One deterministic gate dispatch.
    const gateDecision = selectGoalContinuation(state);
    if (!isRunnableGoalContinuation(gateDecision) || !isReadyGateDecision(gateDecision)) {
      throw new Error(`Expected a ready gate, received '${gateDecision.kind}'.`);
    }
    const gate = dispatchReadyGate(state, { dispatchId: "gate-dispatch", decision: gateDecision, at });
    if (!gate.ok) throw new Error(JSON.stringify(gate.diagnostics));
    events.push(...gate.events);

    const entries = projectEventTimeline(events);
    const lanes = new Set(entries.map((entry) => entry.lane));
    expect(lanes).toEqual(new Set(["workflow", "goal", "dispatch", "node", "check", "fact", "route"]));
    expect(entries.some((entry) => entry.lane === "unknown")).toBe(false);

    // M6A: the timeline separates a deterministic action from a delivered model turn.
    const deterministicSelections = entries.filter((entry) => entry.dispatch?.lane === "deterministic");
    const modelSelections = entries.filter((entry) => entry.dispatch?.lane === "model");
    expect(deterministicSelections.map((entry) => entry.type)).toEqual([
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.action.completed",
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.action.completed",
    ]);
    expect(modelSelections.map((entry) => entry.type)).toEqual([
      "hypagraph.goal.continuation-requested",
      "hypagraph.goal.turn-recorded",
    ]);
    expect(deterministicSelections[0]!.summary)
      .toBe("The scheduler selected run check 'tests' in the deterministic lane at ordinal 2.");
    expect(modelSelections[0]!.summary).toBe("The model lane selected start task 'plan' at ordinal 1.");
    expect(modelSelections[1]!.summary).toBe("The model lane charged one turn and 9 tokens.");

    expect(entryFor(entries, "hypagraph.route.selected").summary)
      .toBe("Gate 'route' selected outcome 'true' and routed to ship.");
    expect(entryFor(entries, "hypagraph.fact.published").summary)
      .toBe("Node 'tests' published fact 'tests.passed' as true.");
    expect(entries.every((entry) => entry.redacted === false)).toBe(true);
  });

  it("hides protected evaluator detail and reports the redaction", async () => {
    const created = create(protectedDefinition(), "protected-timeline-workflow");
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const decision = selectGoalContinuation(created.state);
    if (!isRunnableGoalContinuation(decision) || !isReadyCheckDecision(decision)) {
      throw new Error(`Expected a ready check, received '${decision.kind}'.`);
    }

    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision,
      dispatchId: "protected-dispatch",
      attemptId: "evaluate-1",
      at,
      finishedAt: at,
      store,
      executor: executorFor((attemptId) => ({
        checkKind: "metric-report",
        attemptId,
        startedAt: at,
        completedAt: at,
        status: "failed",
        exitCode: 1,
        facts: [{ name: "evaluate.score", type: "number", value: 0.2 }],
        evidence: [],
        error: "secret expectation 'internal-case-7' did not hold",
        stdoutRef: "artifact://protected-stdout",
        stderrRef: "artifact://protected-stderr",
        evaluation: { kind: "holdout", feedbackMode: "aggregate", diagnostics: [], diagnosticsTruncated: false },
      })),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    const entries = projectEventTimeline([...created.events, ...dispatch.events]);
    const rendered = entries.map((entry) => entry.summary).join("\n");
    expect(rendered).not.toContain("internal-case-7");
    expect(rendered).not.toContain("--secret-suite");
    expect(rendered).not.toContain("protected-stdout");
    expect(rendered).not.toContain("protected/evaluate.json");

    expect(entryFor(entries, "hypagraph.check.started")).toMatchObject({
      redacted: true,
      summary: "Check 'evaluate' started a protected evaluator attempt.",
    });
    expect(entryFor(entries, "hypagraph.check.result-recorded")).toMatchObject({
      redacted: true,
      summary: "Check 'evaluate' recorded a protected evaluator result with status 'failed'.",
    });
    expect(entryFor(entries, "hypagraph.verification.failed")).toMatchObject({
      redacted: true,
      summary: "Node 'evaluate' failed verification. The evaluator reason is protected.",
    });
    expect(entryFor(entries, "hypagraph.fact.published")).toMatchObject({
      redacted: true,
      summary: "Node 'evaluate' published protected evaluator fact 'evaluate.score'.",
    });
    // A workflow-level entry carries no node, so it is not redacted.
    expect(entryFor(entries, "hypagraph.workflow.defined").redacted).toBe(false);
  });

  it("projects an unknown event type to a generic entry", () => {
    const created = create();
    const future: DomainEvent = {
      ...created.events[0]!,
      eventId: "future-event",
      sequence: created.state.sequence + 1,
      type: "hypagraph.family.child-created" as DomainEvent["type"],
      data: { childGoalId: "child-1" },
    };

    const entries = projectEventTimeline([...created.events, future]);
    const entry = entries.at(-1)!;
    expect(entry).toMatchObject({
      sequence: created.state.sequence + 1,
      type: "hypagraph.family.child-created",
      lane: "unknown",
      summary: "The workflow stored event 'hypagraph.family.child-created'.",
      redacted: false,
    });
    expect(entries).toHaveLength(created.events.length + 1);
  });

  it("applies the redaction of the revision which was current at each event", async () => {
    // A development evaluation may expose its raw report. A holdout evaluation may not.
    const source = protectedDefinition();
    const sourceCheck = source.nodes[0]!.check!;
    if (sourceCheck.kind !== "metric-report") throw new Error("The fixture must declare a metric report.");
    sourceCheck.evaluation!.kind = "development";
    const created = create(source, "revised-protection-workflow");
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const decision = selectGoalContinuation(created.state);
    if (!isRunnableGoalContinuation(decision) || !isReadyCheckDecision(decision)) {
      throw new Error(`Expected a ready check, received '${decision.kind}'.`);
    }
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision,
      dispatchId: "revised-dispatch",
      attemptId: "evaluate-1",
      at,
      finishedAt: at,
      store,
      executor: executorFor((attemptId) => ({
        checkKind: "metric-report",
        attemptId,
        startedAt: at,
        completedAt: at,
        status: "passed",
        exitCode: 0,
        facts: [{ name: "evaluate.score", type: "number", value: 0.9 }],
        evidence: [],
        evaluation: { kind: "development", feedbackMode: "aggregate", diagnostics: [], diagnosticsTruncated: false },
      })),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    const exposed = structuredClone(source);
    const exposedCheck = exposed.nodes[0]!.check!;
    if (exposedCheck.kind !== "metric-report") throw new Error("The fixture must declare a metric report.");
    exposedCheck.evaluation!.feedback.exposeRawReport = true;
    const revised = handleCommand(dispatch.state, {
      type: "revise",
      definition: exposed,
      commandId: "expose-evaluator",
      at,
    });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));

    const entries = projectEventTimeline([...created.events, ...dispatch.events, ...revised.events]);
    const revision = entryFor(entries, "hypagraph.workflow.revised");
    const nodeEntries = entries.filter((entry) => entry.nodeId === "evaluate");
    const before = nodeEntries.filter((entry) => entry.sequence < revision.sequence);
    const after = nodeEntries.filter((entry) => entry.sequence > revision.sequence);

    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // Each entry keeps the protection rule of the revision which was current when it was stored.
    expect(before.every((entry) => entry.redacted)).toBe(true);
    expect(after.every((entry) => entry.redacted)).toBe(false);
  });

  it("pages the timeline and defaults to the most recent entries", () => {
    const created = create();
    const entries = projectEventTimeline(created.events);

    const recent = pageTimeline(entries, 2);
    expect(recent.total).toBe(entries.length);
    expect(recent.offset).toBe(entries.length - 2);
    expect(recent.entries.map((entry) => entry.sequence)).toEqual(
      entries.slice(-2).map((entry) => entry.sequence),
    );

    const first = pageTimeline(entries, 2, 0);
    expect(first.offset).toBe(0);
    expect(first.entries.map((entry) => entry.sequence)).toEqual([entries[0]!.sequence, entries[1]!.sequence]);

    const beyond = pageTimeline(entries, 50, 0);
    expect(beyond.entries).toHaveLength(entries.length);
  });

  it("filters the timeline by lane", () => {
    const created = create();
    const entries = projectEventTimeline(created.events);
    const nodes = filterTimelineByLane(entries, "node");
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((entry) => entry.lane === "node")).toBe(true);
    expect(filterTimelineByLane(entries, "loop")).toEqual([]);
  });
});

describe("M6B timeline redaction of every free-text field", () => {
  const SENTINEL = "holdout case 'internal-case-7' failed in protected/evaluate.json via --secret-suite";

  const leak = (value: string) => {
    expect(value).not.toContain("internal-case-7");
    expect(value).not.toContain("--secret-suite");
    expect(value).not.toContain("protected/evaluate.json");
  };

  it("redacts a protected node-blocked reason and the goal reason which repeats it", () => {
    const created = create(protectedDefinition(), "timeline-blocked-workflow");
    const blocked = handleCommand(created.state, {
      type: "block-node",
      nodeId: "evaluate",
      reason: SENTINEL,
      blockerKind: "repository-work",
      commandId: "block-evaluate",
      at,
    });
    if (!blocked.ok) throw new Error(JSON.stringify(blocked.diagnostics));

    const events = [...created.events, ...blocked.events];
    const entries = projectEventTimeline(events);
    const rendered = entries.map((entry) => entry.summary).join("\n");
    leak(rendered);

    const nodeBlocked = entryFor(entries, "hypagraph.node.blocked");
    expect(nodeBlocked.redacted).toBe(true);
    expect(nodeBlocked.summary).toContain("The evaluator is protected.");

    // A goal event carries no node, so it inherits protection from the repeated text.
    const goalBlocked = entries.find((entry) => entry.type === "hypagraph.goal.blocked");
    if (goalBlocked) {
      expect(goalBlocked.summary).not.toContain("internal-case-7");
      expect(goalBlocked.redacted).toBe(true);
    }
  });

  it("redacts a protected failed and interrupted action reason", () => {
    const created = create(protectedDefinition(), "timeline-action-workflow");
    const base = created.events[0]!;
    const dispatch = {
      dispatchId: "protected-dispatch",
      action: { kind: "run-ready-check", nodeId: "evaluate" },
      lane: "deterministic",
      selectedSequence: created.state.sequence,
      selectedSnapshotHash: created.state.snapshotHash,
      schedulerOrdinal: 1,
    };
    const actionEvents: DomainEvent[] = [
      { type: "hypagraph.action.selected", data: { dispatch } },
      { type: "hypagraph.action.dispatched", data: { dispatchId: "protected-dispatch" } },
      { type: "hypagraph.action.failed", data: { dispatchId: "protected-dispatch", reason: SENTINEL } },
      { type: "hypagraph.action.interrupted", data: { dispatchId: "protected-dispatch", reason: SENTINEL } },
    ].map((item, index) => ({
      ...base,
      eventId: `action-${index}`,
      sequence: created.state.sequence + index + 1,
      nodeId: "evaluate",
      type: item.type as DomainEvent["type"],
      data: item.data,
    }));

    const entries = projectEventTimeline([...created.events, ...actionEvents]);
    const rendered = entries.map((entry) => entry.summary).join("\n");
    leak(rendered);

    for (const type of ["hypagraph.action.failed", "hypagraph.action.interrupted"]) {
      const entry = entryFor(entries, type);
      expect(entry.redacted).toBe(true);
      expect(entry.summary).toContain("The evaluator is protected.");
      expect(entry.dispatch?.lane).toBe("deterministic");
    }
  });

  it("keeps an unprotected action reason readable", () => {
    const created = create();
    const base = created.events[0]!;
    const events: DomainEvent[] = [
      {
        ...base,
        eventId: "unprotected-selected",
        sequence: created.state.sequence + 1,
        nodeId: "tests",
        type: "hypagraph.action.selected" as DomainEvent["type"],
        data: {
          dispatch: {
            dispatchId: "plain-dispatch",
            action: { kind: "run-ready-check", nodeId: "tests" },
            lane: "deterministic",
            selectedSequence: created.state.sequence,
            selectedSnapshotHash: created.state.snapshotHash,
            schedulerOrdinal: 1,
          },
        },
      },
      {
        ...base,
        eventId: "unprotected-failed",
        sequence: created.state.sequence + 2,
        nodeId: "tests",
        type: "hypagraph.action.failed" as DomainEvent["type"],
        data: { dispatchId: "plain-dispatch", reason: "The command exited with code 2." },
      },
    ];

    const entries = projectEventTimeline([...created.events, ...events]);
    const failed = entryFor(entries, "hypagraph.action.failed");
    expect(failed.redacted).toBe(false);
    expect(failed.summary).toContain("The command exited with code 2.");
  });
});
