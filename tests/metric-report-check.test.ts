import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, replayEvents } from "../src/domain/reducer.js";

const roots: string[] = [];
const at = "2026-07-23T13:10:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (program: string): HypagraphDefinition => ({
  title: "Metric report check",
  goal: "Run an evaluator and publish declared scalar metrics",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: ["The report is valid."],
    produces: [
      { name: "evaluation.valid", type: "boolean", required: true },
      { name: "evaluation.score", type: "number", required: true },
      { name: "evaluation.precision", type: "number", required: true },
      { name: "evaluation.summary-code", type: "string", required: false },
    ],
    check: {
      kind: "metric-report",
      command: process.execPath,
      arguments: ["-e", program],
      timeoutMs: 30_000,
      reportPath: "metrics.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [
        { source: "valid", fact: "evaluation.valid", type: "boolean" },
        { source: "score", fact: "evaluation.score", type: "number" },
        { source: "metrics.precision", fact: "evaluation.precision", type: "number" },
        { source: "summaryCode", fact: "evaluation.summary-code", type: "string", required: false },
      ],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const writeReport = (value: unknown): string => `require("node:fs").writeFileSync("metrics.json", JSON.stringify(${JSON.stringify(value)}))`;

describe("M5A executable metric report checks", () => {
  it("runs through the composite executor, publishes exact mapped facts, and replays", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-metric-report-"));
    roots.push(root);
    const created = createWorkflow(definition(writeReport({
      schemaVersion: 1,
      valid: true,
      score: 0.847,
      metrics: { precision: 0.88 },
      summaryCode: "below_target",
    })), at, "workflow-metric-report");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const artifacts = new MemoryCheckArtifactStore();
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: new CommandCheckExecutor({ rootDirectory: root, artifactStore: artifacts }),
      nodeId: "evaluate",
      attemptId: "attempt-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phase).toBe("completed");
    expect(result.result.checkKind).toBe("metric-report");
    expect(result.state.runtime.facts["evaluation.valid"]?.value).toBe(true);
    expect(result.state.runtime.facts["evaluation.score"]?.value).toBe(0.847);
    expect(result.state.runtime.facts["evaluation.precision"]?.value).toBe(0.88);
    expect(result.state.runtime.facts["evaluation.summary-code"]?.value).toBe("below_target");
    expect(result.result.evidence.some((item) => item.summary === "metric-json report.")).toBe(true);
    expect(artifacts.artifacts.size).toBeGreaterThanOrEqual(1);
    expect(replayEvents([...created.events, ...result.events])).toEqual(result.state);
  });

  it("records malformed metric output as an error and publishes no facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-invalid-metric-report-"));
    roots.push(root);
    const created = createWorkflow(definition(writeReport({ schemaVersion: 1, valid: true, score: "bad", metrics: { precision: 0.8 } })), at, "workflow-invalid-metric-report");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: new CommandCheckExecutor({ rootDirectory: root, artifactStore: new MemoryCheckArtifactStore() }),
      nodeId: "evaluate",
      attemptId: "attempt-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("error");
    expect(result.result.error).toContain("evaluation.score");
    expect(Object.keys(result.state.runtime.facts)).toEqual([]);
    expect(result.state.runtime.nodes.evaluate?.status).toBe("failed");
  });
});
