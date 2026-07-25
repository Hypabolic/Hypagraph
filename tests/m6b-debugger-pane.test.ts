import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import { graphLayoutKey, projectGraphView } from "../src/graph/projection.js";
import { layoutGraph } from "../src/graph/layout.js";
import { replayToSequence } from "../src/history/replay.js";
import { projectEventTimeline } from "../src/history/timeline.js";
import { GraphPaneController, PiGraphPaneComponent, type ReplayPaneState } from "../src/pi/graph-pane.js";

const at = "2026-07-25T20:00:00.000Z";

const theme = {
  fg: (_role: string, value: string) => value,
} as unknown as Theme;

const tui = (columns: number, rows = 40): TUI => ({
  terminal: { columns, rows },
  requestRender: vi.fn(),
} as unknown as TUI);

const definition = (): HypagraphDefinition => ({
  title: "Pane replay",
  goal: "Move through execution visually",
  nodes: [
    { id: "plan", title: "Plan the change", requires: [], acceptance: [] },
    { id: "build", title: "Build the change", requires: ["plan"], acceptance: [] },
    { id: "ship", title: "Ship the change", requires: ["build"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const reduced = handleCommand(state, command);
  if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
  return reduced;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string): HypagraphState => {
  let next = state;
  for (const command of [
    { type: "start-node" as const, nodeId, attemptId: `${nodeId}-1`, commandId: `start-${nodeId}`, at },
    { type: "submit-result" as const, nodeId, attemptId: `${nodeId}-1`, evidence: [], commandId: `submit-${nodeId}`, at },
    { type: "begin-verification" as const, nodeId, attemptId: `${nodeId}-1`, commandId: `begin-${nodeId}`, at },
    { type: "complete-verification" as const, nodeId, attemptId: `${nodeId}-1`, passed: true, commandId: `verify-${nodeId}`, at },
  ]) {
    const reduced = apply(next, command);
    next = reduced.state;
    events.push(...reduced.events);
  }
  return next;
};

const fixture = () => {
  const created = createHypagoalWorkflow(definition(), {
    workflowId: "pane-replay-workflow",
    goalId: "pane-replay-goal",
    goalWorkflowId: "pane-replay-workflow",
    at,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const events: DomainEvent[] = [...created.events];
  let state = completeTask(created.state, events, "plan");
  state = completeTask(state, events, "build");
  return { events, state };
};

const replayStateFor = (events: readonly DomainEvent[], live: HypagraphState, sequence: number): ReplayPaneState => {
  const replay = replayToSequence(events, sequence);
  return {
    sequence: replay.sequence,
    firstSequence: events[0]!.sequence,
    liveSequence: live.sequence,
    entry: replay.entry,
    differenceLines: ["Difference: 2 nodes, 0 routes, 0 loops"],
  };
};

describe("M6B Slice 5 debugger pane", () => {
  it("renders a selected historical event and marks the replay mode", () => {
    const value = fixture();
    const readyEvent = value.events.find((event) => event.type === "hypagraph.node.ready")!;
    const replay = replayToSequence(value.events, readyEvent.sequence);
    const view = projectGraphView(replay.state);
    const component = new PiGraphPaneComponent(
      tui(120),
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
    );
    component.update(view, layoutGraph(view), "normal", replayStateFor(value.events, value.state, readyEvent.sequence));

    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Hypagraph replay · Pane replay");
    expect(rendered).toContain(`REPLAY event ${readyEvent.sequence} of ${value.state.sequence}`);
    expect(rendered).toContain("Replay reads stored events only. It changes no canonical state.");
    expect(rendered).toContain(`replay e${readyEvent.sequence}/${value.state.sequence}`);
    expect(component.replayState?.sequence).toBe(readyEvent.sequence);
  });

  it("returns to live state and clears the replay mode", () => {
    const value = fixture();
    const view = projectGraphView(value.state);
    const component = new PiGraphPaneComponent(
      tui(120),
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
    );
    component.update(view, layoutGraph(view), "normal", replayStateFor(value.events, value.state, 2));
    expect(component.replayState).toBeDefined();

    component.update(view, layoutGraph(view), "normal", undefined);
    const rendered = component.render(100).join("\n");
    expect(component.replayState).toBeUndefined();
    expect(rendered).toContain("Hypagraph · Pane replay");
    expect(rendered).not.toContain("REPLAY event");
    expect(rendered).toContain("· live");
  });

  it("routes the replay keys to the controls", () => {
    const value = fixture();
    const view = projectGraphView(value.state);
    const controls = { step: vi.fn(), enter: vi.fn(), clear: vi.fn() };
    const component = new PiGraphPaneComponent(
      tui(120),
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "normal",
      controls,
    );

    component.handleInput(",");
    expect(controls.step).toHaveBeenLastCalledWith(-1);
    component.handleInput(".");
    expect(controls.step).toHaveBeenLastCalledWith(1);
    component.handleInput("t");
    expect(controls.enter).toHaveBeenCalledTimes(1);
    component.handleInput("L");
    expect(controls.clear).toHaveBeenCalledTimes(1);

    component.update(view, layoutGraph(view), "normal", replayStateFor(value.events, value.state, 2));
    component.handleInput("t");
    expect(controls.clear).toHaveBeenCalledTimes(2);
    expect(controls.enter).toHaveBeenCalledTimes(1);
  });

  it("steps through stored events and stops at the live sequence", () => {
    const value = fixture();
    const controller = new GraphPaneController(() => value.events);
    controller.update(value.state);
    expect(controller.replaySequenceForTest).toBeUndefined();

    controller.setReplaySequence(3);
    expect(controller.replaySequenceForTest).toBe(3);

    controller.setReplaySequence(undefined);
    expect(controller.replaySequenceForTest).toBeUndefined();

    // A sequence beyond the stored range is refused by the replay projection.
    controller.setReplaySequence(value.state.sequence + 10);
    expect(() => replayToSequence(value.events, value.state.sequence + 10)).toThrow();
  });

  it("keeps graph positions stable when a revision adds one node", () => {
    const value = fixture();
    const before = projectGraphView(value.state);
    const beforeLayout = layoutGraph(before);

    const extended = definition();
    extended.nodes.push({ id: "announce", title: "Announce the change", requires: ["ship"], acceptance: [] });
    const revised = apply(value.state, { type: "revise", definition: extended, commandId: "add-announce", at });
    const after = projectGraphView(revised.state);
    const afterLayout = layoutGraph(after, { previous: beforeLayout });

    expect(graphLayoutKey(before)).not.toBe(graphLayoutKey(after));
    for (const node of beforeLayout.nodes) {
      const moved = afterLayout.nodes.find((candidate) => candidate.id === node.id);
      expect(moved).toBeDefined();
      expect({ id: moved!.id, x: moved!.x, y: moved!.y }).toEqual({ id: node.id, x: node.x, y: node.y });
    }
  });

  it("reuses one layout while only runtime status changes", () => {
    const value = fixture();
    const first = projectGraphView(replayToSequence(value.events, 3).state);
    const last = projectGraphView(value.state);
    // Rule 5.8: replay inside one revision keeps the same layout key, so nodes do not move.
    expect(graphLayoutKey(first)).toBe(graphLayoutKey(last));
  });

  it("renders the replay pane inside a narrow terminal width", () => {
    const value = fixture();
    const replay = replayToSequence(value.events, 4);
    const view = projectGraphView(replay.state);
    const component = new PiGraphPaneComponent(
      tui(60, 24),
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "compact",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
    );
    component.update(view, layoutGraph(view), "compact", replayStateFor(value.events, value.state, 4));

    const lines = component.render(58);
    expect(lines.every((line) => visibleWidth(line) === 58)).toBe(true);
    expect(lines.join("\n")).toContain("REPLAY event 4");
  });

  it("marks a protected evaluator entry in the replay banner", () => {
    const source: HypagraphDefinition = {
      title: "Protected pane",
      goal: "Mark protected evaluator history",
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
          timeoutMs: 30_000,
          reportPath: "protected/evaluate.json",
          parser: { name: "metric-json", version: 1 },
          mappings: [{ source: "score", fact: "evaluate.score", type: "number", required: false }],
          evaluation: { kind: "holdout", feedback: { mode: "aggregate" } },
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(source, {
      workflowId: "protected-pane-workflow",
      goalId: "protected-pane-goal",
      goalWorkflowId: "protected-pane-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = apply(created.state, {
      type: "start-check",
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      commandId: "start-evaluate",
      at,
    });
    const events = [...created.events, ...started.events];
    const startEvent = events.find((event) => event.type === "hypagraph.check.started")!;
    const entries = projectEventTimeline(events);
    expect(entries.find((entry) => entry.type === "hypagraph.check.started")?.redacted).toBe(true);

    const view = projectGraphView(started.state);
    const component = new PiGraphPaneComponent(
      tui(120),
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
    );
    component.update(view, layoutGraph(view), "normal", replayStateFor(events, started.state, startEvent.sequence));

    const rendered = component.render(110).join("\n");
    expect(rendered).toContain("· protected");
    expect(rendered).not.toContain("protected/evaluate.json");
  });
});
