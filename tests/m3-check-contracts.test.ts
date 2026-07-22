import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const definition = (): HypagraphDefinition => ({
  title: "Run deterministic tests",
  goal: "Publish test command facts",
  nodes: [
    {
      id: "run-tests",
      title: "Run tests",
      kind: "check",
      requires: [],
      acceptance: ["The command completes."],
      produces: [
        { name: "tests.passed", type: "boolean", required: true },
        { name: "tests.exit_code", type: "integer", required: true },
        { name: "tests.duration_ms", type: "number" },
      ],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 120_000,
        expectedExitCodes: [0],
        publish: [
          { source: "passed", fact: "tests.passed" },
          { source: "exitCode", fact: "tests.exit_code" },
          { source: "durationMs", fact: "tests.duration_ms" },
        ],
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const codes = (value: HypagraphDefinition): string[] => validateDefinition(value).map((item) => item.code);

describe("M3 check contracts", () => {
  it("accepts and persists a valid command check definition", () => {
    const value = definition();
    expect(validateDefinition(value)).toEqual([]);
    const created = createWorkflow(value, "2026-07-22T08:00:00.000Z", "workflow-check-contract");
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.state.definition.nodes[0]?.check).toEqual(value.nodes[0]?.check);
  });

  it("does not run a check through the task lifecycle", () => {
    const created = createWorkflow(definition(), "2026-07-22T08:00:00.000Z", "workflow-check-contract");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const result = handleCommand(created.state, {
      type: "start-node",
      nodeId: "run-tests",
      attemptId: "attempt-1",
      commandId: "command-start-check",
      at: "2026-07-22T08:01:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("check_execution_pending");
  });

  it("requires a check definition on a check node", () => {
    const value = definition();
    delete value.nodes[0]!.check;
    expect(codes(value)).toContain("check_definition_required");
  });

  it("rejects check configuration on task and gate nodes", () => {
    const task = definition();
    task.nodes[0]!.kind = "task";
    expect(codes(task)).toContain("non_check_has_check");

    const gate = definition();
    gate.nodes[0]!.kind = "gate";
    expect(codes(gate)).toContain("non_check_has_check");
  });

  it("rejects invalid command bounds", () => {
    const value = definition();
    value.nodes[0]!.check!.command = " ";
    value.nodes[0]!.check!.timeoutMs = 0;
    value.nodes[0]!.check!.expectedExitCodes = [0, 0];
    expect(codes(value)).toEqual(expect.arrayContaining([
      "check_command_required",
      "invalid_check_timeout",
      "duplicate_expected_exit_code",
    ]));
  });

  it("rejects undeclared, duplicate, and mistyped fact mappings", () => {
    const value = definition();
    value.nodes[0]!.check!.publish = [
      { source: "passed", fact: "tests.exit_code" },
      { source: "exitCode", fact: "tests.exit_code" },
      { source: "status", fact: "tests.status" },
    ];
    expect(codes(value)).toEqual(expect.arrayContaining([
      "check_fact_type_mismatch",
      "duplicate_check_fact_mapping",
      "check_fact_not_declared",
    ]));
  });

  it("rejects check nodes that also contain gate configuration", () => {
    const value = definition();
    value.nodes[0]!.gate = {
      condition: { kind: "exists", fact: "tests.passed" },
      onTrue: ["run-tests"],
      onFalse: ["run-tests"],
    };
    expect(codes(value)).toContain("check_has_gate");
  });
});
