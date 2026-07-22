import { describe, expect, it } from "vitest";
import type { Condition } from "../src/domain/conditions.js";
import { evaluateCondition, MAX_CONDITION_DEPTH } from "../src/domain/conditions.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-22T00:00:00.000Z";

const basicDefinition = (): HypagraphDefinition => ({
  title: "Deterministic runtime",
  goal: "Check M2 hardening",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const routingDefinition = (): HypagraphDefinition => ({
  title: "Retain routes",
  goal: "Keep unaffected route state",
  nodes: [
    { id: "inspect", title: "Inspect", requires: [], acceptance: [], produces: [{ name: "tests.failed", type: "integer", required: true }] },
    {
      id: "choose",
      title: "Choose",
      kind: "gate",
      requires: ["inspect"],
      acceptance: [],
      gate: {
        condition: { kind: "compare", left: { kind: "fact", name: "tests.failed" }, operator: "eq", right: { kind: "literal", value: 0 } },
        onTrue: ["pass"],
        onFalse: ["fail"],
      },
    },
    { id: "pass", title: "Pass", requires: ["choose"], acceptance: [] },
    { id: "fail", title: "Fail", requires: ["choose"], acceptance: [] },
    { id: "unrelated", title: "Unrelated", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const completeInspectAndRoute = (): HypagraphState => {
  const created = createWorkflow(routingDefinition(), at, "workflow-route");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  let state = created.state;
  state = apply(state, { type: "start-node", nodeId: "inspect", attemptId: "attempt-1", commandId: "start", at }).state;
  state = apply(state, { type: "publish-facts", nodeId: "inspect", attemptId: "attempt-1", facts: [{ name: "tests.failed", type: "integer", value: 0 }], commandId: "facts", at }).state;
  state = apply(state, { type: "submit-result", nodeId: "inspect", attemptId: "attempt-1", evidence: [], commandId: "submit", at }).state;
  state = apply(state, { type: "begin-verification", nodeId: "inspect", attemptId: "attempt-1", commandId: "begin", at }).state;
  state = apply(state, { type: "complete-verification", nodeId: "inspect", attemptId: "attempt-1", passed: true, commandId: "pass", at }).state;
  return apply(state, { type: "evaluate-gate", nodeId: "choose", commandId: "route", at }).state;
};

describe("M2 hardening", () => {
  it("produces identical events and state for the same state and command", () => {
    const created = createWorkflow(basicDefinition(), at, "workflow-deterministic");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const command = { type: "start-node", nodeId: "one", attemptId: "attempt-1", commandId: "command-1", at } as const;
    expect(handleCommand(created.state, command)).toEqual(handleCommand(created.state, command));
  });

  it("uses Boolean short-circuit semantics", () => {
    expect(evaluateCondition({ kind: "all", conditions: [
      { kind: "compare", left: { kind: "literal", value: 1 }, operator: "eq", right: { kind: "literal", value: 2 } },
      { kind: "compare", left: { kind: "fact", name: "missing.fact" }, operator: "eq", right: { kind: "literal", value: 1 } },
    ] }, {})).toEqual({ ok: true, value: false, factsUsed: [] });

    expect(evaluateCondition({ kind: "any", conditions: [
      { kind: "compare", left: { kind: "literal", value: 1 }, operator: "eq", right: { kind: "literal", value: 1 } },
      { kind: "compare", left: { kind: "fact", name: "missing.fact" }, operator: "eq", right: { kind: "literal", value: 1 } },
    ] }, {})).toEqual({ ok: true, value: true, factsUsed: [] });
  });

  it("rejects a condition that exceeds the depth limit", () => {
    let condition: Condition = { kind: "exists", fact: "tests.failed" };
    for (let index = 0; index < MAX_CONDITION_DEPTH; index += 1) condition = { kind: "not", condition };
    const definition = routingDefinition();
    definition.nodes[1]!.gate!.condition = condition;
    expect(validateDefinition(definition).map((item) => item.code)).toContain("condition_depth_exceeded");
  });

  it("retains an unaffected route selection after revision", () => {
    const routed = completeInspectAndRoute();
    const revisedDefinition = routingDefinition();
    revisedDefinition.nodes[4]!.title = "Unrelated changed";
    const revised = apply(routed, { type: "revise", definition: revisedDefinition, commandId: "revise", at });
    expect(revised.state.runtime.routes.choose?.outcomeId).toBe("true");
    expect(revised.state.runtime.nodes.choose?.status).toBe("succeeded");
  });

  it("rejects fact publication after result submission", () => {
    const created = createWorkflow(routingDefinition(), at, "workflow-frozen");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = apply(created.state, { type: "start-node", nodeId: "inspect", attemptId: "attempt-1", commandId: "start", at });
    const submitted = apply(started.state, { type: "submit-result", nodeId: "inspect", attemptId: "attempt-1", evidence: [], commandId: "submit", at });
    const result = handleCommand(submitted.state, { type: "publish-facts", nodeId: "inspect", attemptId: "attempt-1", facts: [{ name: "tests.failed", type: "integer", value: 0 }], commandId: "facts", at });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("fact_publication_not_allowed");
  });

  it("migrates the same version-one snapshot deterministically and preserves dependency readiness", () => {
    const definition: HypagraphDefinition = {
      title: "Old state",
      goal: "Migrate safely",
      nodes: [
        { id: "first", title: "First", requires: [], acceptance: [] },
        { id: "second", title: "Second", requires: ["first"], acceptance: [] },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const old = {
      schemaVersion: 1,
      workflowId: "workflow-old",
      revision: 1,
      definition,
      runtime: { nodes: { first: { status: "pending" }, second: { status: "pending" } } },
      createdAt: at,
      updatedAt: at,
    };
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "hypagraph_read", details: { hypagraph: old } } }];
    const first = restoreLatestSession(entries);
    const second = restoreLatestSession(entries);
    expect(first).toEqual(second);
    expect(first?.snapshot.runtime.nodes.first?.status).toBe("ready");
    expect(first?.snapshot.runtime.nodes.second?.status).toBe("pending");
  });
});
