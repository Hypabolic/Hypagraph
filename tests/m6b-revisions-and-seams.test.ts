import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import { replayToSequence } from "../src/history/replay.js";
import {
  projectRevisionHistory,
  projectStaleResults,
  renderRevisionHistory,
} from "../src/history/revisions.js";
import { projectEventTimeline } from "../src/history/timeline.js";

const at = "2026-07-25T21:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Revision history",
  goal: "Read revisions and stale results",
  nodes: [
    { id: "plan", title: "Plan the change", requires: [], acceptance: [] },
    { id: "build", title: "Build the change", requires: ["plan"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const loopDefinition = (): HypagraphDefinition => ({
  title: "Revision history with a loop",
  goal: "Invalidate a loop through a revision",
  nodes: [
    { id: "refine", title: "Refine", requires: ["assess"], acceptance: [] },
    {
      id: "assess",
      title: "Assess",
      kind: "check",
      requires: ["refine"],
      acceptance: [],
      produces: [{ name: "assess.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 60_000,
        publish: [{ source: "passed", fact: "assess.passed" }],
      },
    },
  ],
  loops: [{
    id: "refine-loop",
    nodes: ["refine", "assess"],
    entry: "refine",
    evaluateAfter: "assess",
    feedbackEdges: [{ from: "assess", to: "refine" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "assess.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    failurePolicy: "fail-workflow",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition, workflowId: string) => {
  const result = createHypagoalWorkflow(source, {
    workflowId,
    goalId: `${workflowId}-goal`,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const apply = (state: HypagraphState, events: DomainEvent[], command: Parameters<typeof handleCommand>[1]): HypagraphState => {
  const reduced = handleCommand(state, command);
  if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
  events.push(...reduced.events);
  return reduced.state;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId: `${nodeId}-1`, commandId: `start-${nodeId}`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId: `${nodeId}-1`, evidence: [], commandId: `submit-${nodeId}`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId: `${nodeId}-1`, commandId: `begin-${nodeId}`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId: `${nodeId}-1`, passed: true, commandId: `verify-${nodeId}`, at });
};

describe("M6B Slice 6 revisions, stale results, and future seams", () => {
  it("marks each revision boundary once in the timeline", () => {
    const created = create(definition(), "revision-boundary-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");

    const changed = definition();
    changed.nodes[0]!.title = "Plan the change again";
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-plan", at });

    const entries = projectEventTimeline(events);
    const boundaries = entries.filter((entry) => entry.revisionBoundary === true);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      type: "hypagraph.workflow.revised",
      revision: 2,
      summary: "The workflow was revised to revision 2.",
    });
    expect(entries.filter((entry) => entry.type === "hypagraph.workflow.revised")).toHaveLength(1);
  });

  it("splits the stream into one segment for each revision", () => {
    const created = create(definition(), "revision-segment-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");

    const changed = definition();
    changed.nodes[0]!.title = "Plan the change again";
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-plan", at });

    const segments = projectRevisionHistory(events);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ revision: 1, firstSequence: 1 });
    expect(segments[0]!.lastSequence).toBe(segments[1]!.firstSequence - 1);
    expect(segments[1]).toMatchObject({ revision: 2 });
    expect(segments[1]!.lastSequence).toBeUndefined();
    expect(segments.reduce((total, segment) => total + segment.eventCount, 0)).toBe(events.length);
    // The reducer records the invalidated nodes in sorted order.
    expect(segments[1]!.invalidatedNodeIds).toEqual(["build", "plan"]);
  });

  it("reports an invalidated node and its stale result", () => {
    const created = create(definition(), "stale-node-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");
    expect(state.runtime.nodes.plan?.status).toBe("succeeded");

    const changed = definition();
    changed.nodes[0]!.acceptance = ["Record the revised acceptance"];
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-acceptance", at });

    // An invalidated node returns to 'ready' when its dependencies allow it, and it
    // stays 'stale' while they do not.
    expect(state.runtime.nodes.plan?.status).toBe("ready");
    expect(state.runtime.nodes.build?.status).toBe("stale");

    const stale = projectStaleResults(state, events);
    expect(stale).toEqual([
      {
        nodeId: "build",
        kind: "task",
        revision: 2,
        status: "stale",
        attemptCount: 0,
        discardedResult: false,
      },
      {
        nodeId: "plan",
        kind: "task",
        revision: 2,
        status: "ready",
        attemptCount: 1,
        discardedResult: true,
        // The attempt identity comes from the state before the invalidation, which is
        // where the discarded result lives. The invalidation clears the live pointer.
        lastAttemptId: "plan-1",
      },
    ]);

    const entries = projectEventTimeline(events);
    const invalidated = entries.filter((entry) => entry.type === "hypagraph.node.invalidated");
    expect(invalidated.map((entry) => entry.nodeId)).toEqual(["build", "plan"]);
    expect(invalidated.every((entry) => entry.revision === 2 && entry.lane === "node")).toBe(true);
    expect(invalidated.find((entry) => entry.nodeId === "plan")?.summary)
      .toBe("Node 'plan' became stale after a revision.");
  });

  it("does not claim a post-revision result was discarded", () => {
    const created = create(definition(), "post-revision-result-workflow");
    const events: DomainEvent[] = [...created.events];
    // 'build' has no result before the revision, because 'plan' never ran.
    let state = apply(created.state, events, {
      type: "revise",
      definition: (() => {
        const changed = definition();
        changed.nodes[1]!.acceptance = ["Record the revised acceptance"];
        return changed;
      })(),
      commandId: "revise-build",
      at,
    });
    expect(projectRevisionHistory(events).at(-1)?.invalidatedNodeIds).toContain("build");

    // Run both nodes after the revision. The new results are valid, not discarded.
    state = completeTask(state, events, "plan");
    state = completeTask(state, events, "build");

    const stale = projectStaleResults(state, events);
    const build = stale.find((item) => item.nodeId === "build")!;
    expect(build.status).toBe("succeeded");
    expect(build.attemptCount).toBe(0);
    expect(build.discardedResult).toBe(false);
    expect(build.lastAttemptId).toBeUndefined();
  });

  it("reports the pre-revision attempt when an invalidated node runs again", () => {
    const created = create(definition(), "rerun-after-revision-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");
    expect(state.runtime.nodes.plan?.attemptCount).toBe(1);

    const changed = definition();
    changed.nodes[0]!.acceptance = ["Record the revised acceptance"];
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-plan", at });

    // Run 'plan' again after the revision. Its second attempt is the live result.
    state = apply(state, events, { type: "start-node", nodeId: "plan", attemptId: "plan-2", commandId: "start-plan-2", at });
    state = apply(state, events, { type: "submit-result", nodeId: "plan", attemptId: "plan-2", evidence: [], commandId: "submit-plan-2", at });
    state = apply(state, events, { type: "begin-verification", nodeId: "plan", attemptId: "plan-2", commandId: "begin-plan-2", at });
    state = apply(state, events, { type: "complete-verification", nodeId: "plan", attemptId: "plan-2", passed: true, commandId: "verify-plan-2", at });

    expect(state.runtime.nodes.plan?.currentAttemptId).toBe("plan-2");
    const plan = projectStaleResults(state, events).find((item) => item.nodeId === "plan")!;
    // The discarded result is the first attempt, not the attempt which ran afterwards.
    expect(plan.lastAttemptId).toBe("plan-1");
    expect(plan.attemptCount).toBe(1);
    expect(plan.discardedResult).toBe(true);
    expect(plan.status).toBe("succeeded");
  });

  it("reports an invalidated loop at its revision", () => {
    const created = create(loopDefinition(), "stale-loop-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "refine");

    const changed = loopDefinition();
    changed.loops[0]!.maxIterations = 5;
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-loop", at });

    const segments = projectRevisionHistory(events);
    expect(segments.at(-1)?.invalidatedLoopIds).toEqual(["refine-loop"]);
    const entries = projectEventTimeline(events);
    expect(entries.find((entry) => entry.type === "hypagraph.loop.invalidated")).toMatchObject({
      loopId: "refine-loop",
      lane: "loop",
      summary: "Loop 'refine-loop' became stale after a revision.",
    });
  });

  it("replays across a revision boundary to the historical definition", () => {
    const created = create(definition(), "replay-revision-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");

    const changed = definition();
    changed.nodes[0]!.title = "Plan the change again";
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-plan", at });

    const revisionEvent = events.find((event) => event.type === "hypagraph.workflow.revised")!;
    const before = replayToSequence(events, revisionEvent.sequence - 1);
    const after = replayToSequence(events, revisionEvent.sequence);

    expect(before.state.revision).toBe(1);
    expect(before.state.definition.nodes[0]!.title).toBe("Plan the change");
    expect(before.state.runtime.nodes.plan?.status).toBe("succeeded");

    expect(after.state.revision).toBe(2);
    expect(after.state.definition.nodes[0]!.title).toBe("Plan the change again");
  });

  it("renders the revision history and the stale results", () => {
    const created = create(definition(), "render-revision-workflow");
    const events: DomainEvent[] = [...created.events];
    let state = completeTask(created.state, events, "plan");

    const changed = definition();
    changed.nodes[0]!.acceptance = ["Record the revised acceptance"];
    state = apply(state, events, { type: "revise", definition: changed, commandId: "revise-acceptance", at });

    const rendered = renderRevisionHistory(events, state);
    expect(rendered).toContain("Hypagraph revision history: 2 revisions");
    expect(rendered).toContain("- revision 1: sequence 1 to");
    expect(rendered).toContain("- revision 2: sequence");
    expect(rendered).toContain("to current");
    expect(rendered).toContain("invalidated nodes: build, plan");
    expect(rendered).toContain("Discarded results: plan is now ready (1 attempts)");
    expect(rendered).toContain("Stale nodes: build");
  });

  it("reports no stale result for an unrevised workflow", () => {
    const created = create(definition(), "no-stale-workflow");
    expect(projectStaleResults(created.state, created.events)).toEqual([]);
    const rendered = renderRevisionHistory(created.events, created.state);
    expect(rendered).toContain("Discarded results: none.");
    expect(rendered).toContain("Stale nodes: none.");
  });

  it("projects each future namespace through the generic seam", () => {
    const created = create(definition(), "future-seam-workflow");
    const base = created.events[0]!;
    const namespaces = [
      { type: "hypagraph.family.child-created", data: { childGoalId: "child-1" } },
      { type: "hypagraph.executor.attempt-started", data: { executorId: "worktree-1" } },
      { type: "hypagraph.workspace.lease-acquired", data: { leaseId: "lease-1" } },
      { type: "hypagraph.integration.merge-requested", data: { branch: "feature" } },
    ];
    const future: DomainEvent[] = namespaces.map((namespace, index) => ({
      ...base,
      eventId: `future-${index}`,
      sequence: created.state.sequence + index + 1,
      type: namespace.type as DomainEvent["type"],
      data: namespace.data,
    }));

    const entries = projectEventTimeline([...created.events, ...future]);
    const generic = entries.slice(created.events.length);
    expect(generic).toHaveLength(namespaces.length);
    for (const [index, entry] of generic.entries()) {
      expect(entry.lane).toBe("unknown");
      expect(entry.redacted).toBe(false);
      expect(entry.summary).toBe(`The workflow stored event '${namespaces[index]!.type}'.`);
    }

    // The revision projection also tolerates a future namespace.
    const segments = projectRevisionHistory([...created.events, ...future]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.eventCount).toBe(created.events.length + namespaces.length);
  });
});
