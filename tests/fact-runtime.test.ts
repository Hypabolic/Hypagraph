import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const at = "2026-07-21T00:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Publish test facts",
  goal: "Store deterministic test results",
  nodes: [
    {
      id: "test",
      title: "Run tests",
      requires: [],
      acceptance: ["Tests pass"],
      produces: [
        { name: "tests.failed", type: "integer", required: true },
        { name: "tests.passed", type: "boolean" },
      ],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const command = (type: Parameters<typeof handleCommand>[1]["type"], suffix: string) => ({
  type,
  commandId: `command-${suffix}`,
  at,
} as const);

const apply = (state: HypagraphState, value: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, value);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

describe("fact runtime", () => {
  it("publishes declared facts and rebuilds them by replay", () => {
    const created = createWorkflow(definition(), at, "workflow-facts");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events: DomainEvent[] = [...created.events];

    const started = apply(created.state, { ...command("start-node", "start"), nodeId: "test", attemptId: "attempt-1" });
    events.push(...started.events);

    const published = apply(started.state, {
      ...command("publish-facts", "publish"),
      nodeId: "test",
      attemptId: "attempt-1",
      facts: [
        { name: "tests.failed", type: "integer", value: 0, evidence: [{ ref: "command:npm-test", kind: "command" }] },
        { name: "tests.passed", type: "boolean", value: true },
      ],
    });
    events.push(...published.events);

    expect(published.events.map((event) => event.type)).toEqual([
      "hypagraph.fact.published",
      "hypagraph.fact.published",
    ]);
    expect(published.state.runtime.facts["tests.failed"]?.value).toBe(0);
    expect(published.state.runtime.facts["tests.failed"]?.attemptId).toBe("attempt-1");
    expect(replayEvents(events)).toEqual(published.state);
  });

  it("rejects undeclared and invalid facts without events", () => {
    const created = createWorkflow(definition(), at, "workflow-facts");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = apply(created.state, { ...command("start-node", "start"), nodeId: "test", attemptId: "attempt-1" });

    const undeclared = handleCommand(started.state, {
      ...command("publish-facts", "unknown"),
      nodeId: "test",
      attemptId: "attempt-1",
      facts: [{ name: "tests.total", type: "integer", value: 5 }],
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.diagnostics[0]?.code).toBe("fact_not_declared");

    const wrongType = handleCommand(started.state, {
      ...command("publish-facts", "type"),
      nodeId: "test",
      attemptId: "attempt-1",
      facts: [{ name: "tests.failed", type: "integer", value: 1.5 }],
    });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.diagnostics[0]?.code).toBe("fact_value_invalid");
  });

  it("requires current-attempt facts before verification can pass", () => {
    const created = createWorkflow(definition(), at, "workflow-facts");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = apply(created.state, { ...command("start-node", "start"), nodeId: "test", attemptId: "attempt-1" });
    const submitted = apply(started.state, {
      ...command("submit-result", "submit"),
      nodeId: "test",
      attemptId: "attempt-1",
      evidence: [{ ref: "command:npm-test", kind: "command" }],
    });
    const verifying = apply(submitted.state, {
      ...command("begin-verification", "verify"),
      nodeId: "test",
      attemptId: "attempt-1",
    });

    const rejected = handleCommand(verifying.state, {
      ...command("complete-verification", "pass"),
      nodeId: "test",
      attemptId: "attempt-1",
      passed: true,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("required_facts_missing");
  });
});
