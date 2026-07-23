import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { requireRunnableCommandCheck } from "../src/pi/check-tool.js";

const roots: string[] = [];
const at = "2026-07-23T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (): HypagraphDefinition => ({
  title: "Pi report dispatch",
  goal: "Run a report check through the legacy Pi entry points",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [
      { name: "tests.success", type: "boolean", required: true },
      { name: "tests.suites.total", type: "integer", required: true },
      { name: "tests.suites.passed", type: "integer", required: true },
      { name: "tests.suites.failed", type: "integer", required: true },
      { name: "tests.total", type: "integer", required: true },
      { name: "tests.passed", type: "integer", required: true },
      { name: "tests.failed", type: "integer", required: true },
      { name: "tests.skipped", type: "integer", required: true },
      { name: "tests.duration-ms", type: "number", required: false },
    ],
    check: {
      kind: "test-report",
      command: process.execPath,
      arguments: [
        "-e",
        "require('node:fs').writeFileSync('vitest.json', JSON.stringify({success:true,numTotalTestSuites:1,numPassedTestSuites:1,numFailedTestSuites:0,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0}))",
      ],
      timeoutMs: 10_000,
      reportPath: "vitest.json",
      parser: { name: "vitest-json", version: 1 },
      namespace: "tests",
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("Pi report dispatch compatibility", () => {
  it("accepts and executes a report check through legacy entry points", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-pi-report-"));
    roots.push(root);
    const created = createWorkflow(definition(), at, "workflow-pi-report");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const runnable = requireRunnableCommandCheck(created.state, "tests", "attempt-1", at);
    expect(runnable.definition.kind).toBe("test-report");

    const result = await new CommandCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
    }).execute({
      workflowId: created.state.workflowId,
      revision: created.state.revision,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: at,
      definition: runnable.definition,
    }, new AbortController().signal);

    expect(result.checkKind).toBe("test-report");
    expect(result.status).toBe("passed");
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "tests.success", value: true }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "tests.passed", value: 1 }));
  });
});
