import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-22T00:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Route test results",
  goal: "Choose repair or documentation",
  nodes: [
    {
      id: "inspect",
      title: "Inspect tests",
      requires: [],
      acceptance: ["Tests run"],
      produces: [{ name: "tests.failed", type: "integer", required: true }],
    },
    {
      id: "choose",
      title: "Choose route",
      kind: "gate",
      requires: ["inspect"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "tests.failed" },
          operator: "eq",
          right: { kind: "literal", value: 0 },
        },
        onTrue: ["document"],
        onFalse: ["repair"],
      },
    },
    { id: "repair", title: "Repair", requires: ["choose"], acceptance: ["Repair complete"] },
    { id: "repair-check", title: "Check repair", requires: ["repair"], acceptance: ["Repair checked"] },
    { id: "document", title: "Document", requires: ["choose"], acceptance: ["Documentation complete"] },
    { id: "finish", title: "Finish", requires: ["repair-check", "document"], acceptance: ["Work complete"] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const prepareGate = () => {
  const created = createWorkflow(definition(), at, "workflow-gate");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const events: DomainEvent[] = [...created.events];
  let state = created.state;

  const started = apply(state, { type: "start-node", nodeId: "inspect", attemptId: "attempt-1", commandId: "command-start", at });
  state = started.state;
  events.push(...started.events);

  const published = apply(state, {
    type: "publish-facts",
    nodeId: "inspect",
    attemptId: "attempt-1",
    facts: [{ name: "tests.failed", type: "integer", value: 0 }],
    commandId: "command-facts",
    at,
  });
  state = published.state;
  events.push(...published.events);

  const submitted = apply(state, { type: "submit-result", nodeId: "inspect", attemptId: "attempt-1", evidence: [], commandId: "command-submit", at });
  state = submitted.state;
  events.push(...submitted.events);

  const verifying = apply(state, { type: "begin-verification", nodeId: "inspect", attemptId: "attempt-1", commandId: "command-verify", at });
  state = verifying.state;
  events.push(...verifying.events);

  const passed = apply(state, { type: "complete-verification", nodeId: "inspect", attemptId: "attempt-1", passed: true, commandId: "command-pass", at });
  state = passed.state;
  events.push(...passed.events);

  return { state, events };
};

describe("gate routing", () => {
  it("selects one route, skips the other route, and replays the same state", () => {
    const prepared = prepareGate();
    const routed = apply(prepared.state, { type: "evaluate-gate", nodeId: "choose", commandId: "command-route", at });
    const events = [...prepared.events, ...routed.events];

    expect(routed.state.runtime.routes.choose).toMatchObject({
      gateNodeId: "choose",
      outcomeId: "true",
      targetNodeIds: ["document"],
      factsUsed: ["tests.failed"],
    });
    expect(routed.state.runtime.nodes.choose?.status).toBe("succeeded");
    expect(routed.state.runtime.nodes.document?.status).toBe("ready");
    expect(routed.state.runtime.nodes.repair?.status).toBe("skipped");
    expect(routed.state.runtime.nodes["repair-check"]?.status).toBe("skipped");
    expect(routed.state.runtime.nodes.finish?.status).toBe("pending");
    expect(routed.events.map((event) => event.type)).toContain("hypagraph.route.selected");
    expect(replayEvents(events)).toEqual(routed.state);
  });

  it("rejects a gate when a required fact is not available", () => {
    const value = definition();
    value.nodes[1]!.requires = [];
    const created = createWorkflow(value, at, "workflow-missing-fact");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const rejected = handleCommand(created.state, { type: "evaluate-gate", nodeId: "choose", commandId: "command-route", at });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("fact_missing");
  });

  it("validates gate targets and declared facts", () => {
    const value = definition();
    value.nodes[1]!.gate!.onTrue = ["missing"];
    const diagnostics = validateDefinition(value);
    expect(diagnostics.map((item) => item.code)).toContain("dangling_gate_target");
  });
});
