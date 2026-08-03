/**
 * Built-in /hypagraph demo catalog definitions must validate.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEMO_DISPATCH_HOLD_MS,
  DEFAULT_DEMO_ID,
  definitionIsDeterministicDemo,
  demoDispatchHoldMs,
  formatDemoCatalog,
  isShowcaseTourId,
  listDemoExamples,
  resolveDemoExample,
  showcaseTourIds,
  SLOW_DEMO_DISPATCH_HOLD_MS,
  validateDemoCatalog,
} from "../src/pi/demo-catalog.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";

const at = "2026-07-31T19:00:00.000Z";

describe("hypagraph demo catalog", () => {
  it("resolves demo dispatch hold for recording pace", () => {
    expect(demoDispatchHoldMs({
      HYPA_DEMO_FAST: "1",
      HYPA_DEMO_PACE_MS: "5000",
    })).toBe(0);
    expect(demoDispatchHoldMs({
      VITEST: "true",
      HYPA_DEMO_PACE_MS: "5000",
    })).toBe(0);
    expect(demoDispatchHoldMs({
      HYPA_DEMO_PACE_MS: "1200",
    })).toBe(1200);
    expect(demoDispatchHoldMs({
      HYPA_DEMO_SLOW: "1",
    })).toBe(SLOW_DEMO_DISPATCH_HOLD_MS);
    expect(demoDispatchHoldMs({})).toBe(DEFAULT_DEMO_DISPATCH_HOLD_MS);
  });

  it("lists multiple showcase examples", () => {
    const examples = listDemoExamples();
    expect(examples.length).toBeGreaterThanOrEqual(6);
    const ids = examples.map((example) => example.id);
    expect(ids).toEqual(expect.arrayContaining([
      "basic",
      "loop",
      "fanout",
      "parallel",
      "pipeline",
      "rich",
      "showcase",
    ]));
  });

  it("resolves aliases and default", () => {
    expect(resolveDemoExample(undefined)?.id).toBe(DEFAULT_DEMO_ID);
    expect(resolveDemoExample("readme")?.id).toBe("basic");
    expect(resolveDemoExample("full")?.id).toBe("showcase");
    expect(resolveDemoExample("tour")?.id).toBe("showcase");
    expect(resolveDemoExample("gates")?.id).toBe("fanout");
    expect(resolveDemoExample("combined")?.id).toBe("rich");
    expect(resolveDemoExample("unknown-xyz")).toBeUndefined();
  });

  it("formatDemoCatalog includes every id", () => {
    const text = formatDemoCatalog();
    for (const example of listDemoExamples()) {
      expect(text).toContain(example.id);
    }
    expect(text).toMatch(/tour of all|every graph/i);
  });

  it("showcase is a tour of every feature graph", () => {
    expect(isShowcaseTourId("showcase")).toBe(true);
    expect(isShowcaseTourId("full")).toBe(true);
    expect(isShowcaseTourId("basic")).toBe(false);
    const tour = showcaseTourIds();
    expect([...tour]).toEqual([
      "basic",
      "loop",
      "fanout",
      "parallel",
      "pipeline",
      "rich",
    ]);
    for (const id of tour) {
      expect(resolveDemoExample(id)?.definition).toBeTypeOf("function");
    }
  });

  it("every catalog definition validates, creates, and is model-free", () => {
    const report = validateDemoCatalog();
    for (const row of report) {
      expect(row.diagnostics, `demo ${row.id} diagnostics`).toEqual([]);
    }
    for (const example of listDemoExamples()) {
      const definition = example.definition();
      expect(definitionIsDeterministicDemo(definition), `demo ${example.id} must be check/gate/interaction only`).toBe(true);
      // No token ceiling — chat tokens must not budget-limit demos.
      expect(example.budget.maximumTokens).toBeUndefined();
      expect(example.budget.maximumTurns).toBeGreaterThan(0);

      const created = createHypagoalWorkflow(definition, {
        workflowId: `workflow-${example.id}`,
        goalId: `goal-${example.id}`,
        goalWorkflowId: `workflow-${example.id}`,
        at,
        budget: example.budget,
      });
      expect(created.ok, `demo ${example.id} create: ${JSON.stringify(created)}`).toBe(true);
      if (!created.ok) continue;
      expect(created.state.definition.goal).toBe(example.objective);
      expect(created.state.definition.nodes.length).toBeGreaterThan(1);
      expect(created.state.goal?.budget.limits.maximumTokens).toBeUndefined();
    }
  });

  it("loop and rich include loop regions for subgraph viz", () => {
    const loop = resolveDemoExample("loop")!.definition();
    expect(loop.loops.length).toBeGreaterThanOrEqual(1);
    expect(loop.loops[0]?.feedbackEdges?.length).toBeGreaterThanOrEqual(1);

    const rich = resolveDemoExample("rich")!.definition();
    expect(rich.loops.length).toBeGreaterThanOrEqual(1);
    expect(rich.nodes.some((node) => (node.kind ?? "task") === "gate")).toBe(true);
    expect(rich.nodes.some((node) => (node.kind ?? "task") === "interaction")).toBe(true);
  });

  it("fanout includes a gate with two branches", () => {
    const fanout = resolveDemoExample("fanout")!.definition();
    const gate = fanout.nodes.find((node) => node.id === "route");
    expect(gate?.kind).toBe("gate");
    expect(gate?.gate?.onTrue).toContain("fast-path");
    expect(gate?.gate?.onFalse).toContain("repair-path");
  });

  it("parallel has two ready roots without mutual requires", () => {
    const parallel = resolveDemoExample("parallel")!.definition();
    const roots = parallel.nodes.filter((node) => (node.requires ?? []).length === 0);
    expect(roots.map((node) => node.id).sort()).toEqual(["alpha-build", "beta-build"]);
  });
});
