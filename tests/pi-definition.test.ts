import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-22T11:00:00.000Z";

const validInput = (): HypagraphDefineInput => ({
  title: "Pi check workflow",
  goal: "Run tests and route from the result",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: ["The command passes."],
    produces: [
      { name: "tests.passed", type: "boolean", required: true },
      { name: "tests.status", type: "string", required: true },
    ],
    check: {
      kind: "command",
      command: "npm",
      arguments: ["test"],
      workingDirectory: ".",
      timeoutMs: 60_000,
      expectedExitCodes: [0],
      environmentVariables: ["PATH", "CI"],
      retry: {
        maxAttempts: 3,
        retryOn: ["failed", "timed_out"],
        backoffMs: 1_000,
      },
      publish: [
        { source: "passed", fact: "tests.passed" },
        { source: "status", fact: "tests.status" },
      ],
    },
  }],
  policy: { mode: "guided", requireEvidence: false },
});

describe("Pi command-check definition", () => {
  it("normalizes a command check without sharing mutable arrays", () => {
    const input = validInput();
    const definition = normalizeDefinition(input);
    const node = definition.nodes[0]!;
    expect(node.kind).toBe("check");
    expect(node.check?.command).toBe("npm");
    expect(node.check?.arguments).toEqual(["test"]);
    expect(node.check?.environmentVariables).toEqual(["PATH", "CI"]);
    expect(node.check?.retry).toEqual({
      maxAttempts: 3,
      retryOn: ["failed", "timed_out"],
      backoffMs: 1_000,
    });
    expect(node.check?.publish).toEqual([
      { source: "passed", fact: "tests.passed" },
      { source: "status", fact: "tests.status" },
    ]);
    input.nodes[0]!.check!.arguments![0] = "changed";
    input.nodes[0]!.check!.environmentVariables![0] = "SECRET";
    input.nodes[0]!.check!.retry!.retryOn[0] = "error";
    input.nodes[0]!.check!.publish[0]!.fact = "changed.fact";
    expect(node.check?.arguments).toEqual(["test"]);
    expect(node.check?.environmentVariables).toEqual(["PATH", "CI"]);
    expect(node.check?.retry?.retryOn).toEqual(["failed", "timed_out"]);
    expect(node.check?.publish[0]?.fact).toBe("tests.passed");
  });

  it("passes a valid public command check through domain validation", () => {
    const created = createWorkflow(normalizeDefinition(validInput()), at, "workflow-pi-check");
    expect(created.ok).toBe(true);
  });

  it("normalizes a typed public loop condition", () => {
    const input: HypagraphDefineInput = {
      title: "Pi loop",
      goal: "Complete one iteration",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        { id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: { kind: "compare", left: { kind: "fact", name: "tests.passed" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const definition = normalizeDefinition(input);
    expect(definition.loops[0]?.successWhen).toEqual(input.loops?.[0]?.successWhen);
    expect(createWorkflow(definition, at, "workflow-pi-loop").ok).toBe(true);
  });

  it("uses the domain validator for invalid public check mappings", () => {
    const input = validInput();
    input.nodes[0]!.check!.publish[0]!.fact = "tests.undeclared";
    const created = createWorkflow(normalizeDefinition(input), at, "workflow-invalid-pi-check");
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.diagnostics.some((item) => item.code === "check_fact_not_declared")).toBe(true);
  });
});
