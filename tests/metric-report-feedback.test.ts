import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";
import { formatPiCheckResult } from "../src/pi/check-runner.js";

const roots: string[] = [];
const at = "2026-07-23T15:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (mode: "aggregate" | "bounded-diagnostics"): HypagraphDefinition => ({
  title: "Evaluation feedback",
  goal: "Publish bounded evaluator feedback",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "evaluation.score", type: "number", required: true }],
    check: {
      kind: "metric-report",
      command: process.execPath,
      arguments: ["-e", `const fs=require("node:fs"); console.log("private stdout"); console.error("private stderr"); fs.writeFileSync("metrics.json", JSON.stringify({schemaVersion:1,score:0.8,diagnostics:[{code:"first",message:"First public diagnostic."},{code:"second",message:"Second public diagnostic."},{code:"private_case",message:"This item must not be public."}],expectedAnswer:"private answer"}))`],
      timeoutMs: 30_000,
      reportPath: "metrics.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
      evaluation: {
        kind: "development",
        feedback: mode === "aggregate"
          ? { mode: "aggregate" }
          : { mode: "bounded-diagnostics", maximumDiagnosticItems: 2 },
      },
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M5A evaluator feedback controls", () => {
  it("stores protected output but exposes only bounded diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-feedback-"));
    roots.push(root);
    const created = createWorkflow(definition("bounded-diagnostics"), at, "workflow-feedback");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const artifacts = new MemoryCheckArtifactStore();
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: new CommandCheckExecutor({ rootDirectory: root, artifactStore: artifacts }),
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.result.evaluation).toEqual({
      kind: "development",
      feedbackMode: "bounded-diagnostics",
      diagnostics: [
        { code: "first", message: "First public diagnostic." },
        { code: "second", message: "Second public diagnostic." },
      ],
      diagnosticsTruncated: true,
    });
    expect(result.result.stdoutRef).toBeUndefined();
    expect(result.result.stderrRef).toBeUndefined();
    expect(result.result.evidence.length).toBeGreaterThan(0);
    expect(result.result.evidence.every((item) => item.visibility === "protected")).toBe(true);
    expect(result.state.runtime.facts["evaluation.score"]?.evidence).toEqual([]);
    expect(artifacts.artifacts.size).toBeGreaterThanOrEqual(3);

    const text = formatPiCheckResult(result.state, "evaluate", result.result);
    expect(text).toContain("first: First public diagnostic.");
    expect(text).toContain("More diagnostics were not shown.");
    expect(text).not.toContain("private stdout");
    expect(text).not.toContain("private stderr");
    expect(text).not.toContain("private answer");
    expect(text).not.toContain("private_case");
  });

  it("uses aggregate feedback without public diagnostic details", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-aggregate-feedback-"));
    roots.push(root);
    const created = createWorkflow(definition("aggregate"), at, "workflow-aggregate-feedback");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: new CommandCheckExecutor({ rootDirectory: root, artifactStore: new MemoryCheckArtifactStore() }),
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.result.evaluation).toEqual({
      kind: "development",
      feedbackMode: "aggregate",
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(formatPiCheckResult(result.state, "evaluate", result.result)).not.toContain("First public diagnostic.");
  });

  it("requires aggregate protected feedback for a holdout evaluation", () => {
    const value = definition("bounded-diagnostics");
    const check = value.nodes[0]!.check;
    if (!check || check.kind !== "metric-report" || !check.evaluation) throw new Error("The metric evaluation is missing.");
    check.evaluation.kind = "holdout";
    check.evaluation.feedback.exposeRawReport = true;
    const codes = validateDefinition(value).map((item) => item.code);
    expect(codes).toContain("holdout_feedback_must_be_aggregate");
    expect(codes).toContain("holdout_raw_report_not_allowed");
  });
});
