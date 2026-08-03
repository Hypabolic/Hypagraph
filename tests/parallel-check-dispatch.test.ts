/**
 * Independent ready checks may start together and run in parallel.
 */

import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { handleCommand } from "../src/domain/reducer.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import {
  enumerateGoalContinuationCandidates,
  selectGoalContinuation,
} from "../src/domain/goal-continuation.js";
import { isReadyCheckDecision } from "../src/domain/deterministic-check-dispatch.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import { FileCheckArtifactStore } from "../src/checks/file-artifact-store.js";
import { runParallelDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const at = "2026-08-03T12:00:00.000Z";

const parallelDefinition = (): HypagraphDefinition => ({
  title: "Parallel checks",
  goal: "Two independent builds then merge.",
  nodes: [
    {
      id: "alpha-build",
      title: "Alpha build",
      kind: "check",
      requires: [],
      acceptance: ["Alpha builds."],
      check: {
        kind: "command",
        command: "true",
        timeoutMs: 5_000,
        publish: [{ source: "passed", fact: "alpha.ready" }],
      },
      produces: [{ name: "alpha.ready", type: "boolean", required: true }],
    },
    {
      id: "beta-build",
      title: "Beta build",
      kind: "check",
      requires: [],
      acceptance: ["Beta builds."],
      check: {
        kind: "command",
        command: "true",
        timeoutMs: 5_000,
        publish: [{ source: "passed", fact: "beta.ready" }],
      },
      produces: [{ name: "beta.ready", type: "boolean", required: true }],
    },
    {
      id: "merge",
      title: "Merge",
      kind: "check",
      requires: ["alpha-build", "beta-build"],
      acceptance: ["Merged."],
      check: {
        kind: "command",
        command: "true",
        timeoutMs: 5_000,
        publish: [{ source: "passed", fact: "merge.done" }],
      },
      produces: [{ name: "merge.done", type: "boolean", required: true }],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("parallel independent check starts", () => {
  it("allows a second start-check while another check is running", () => {
    const created = createHypagoalWorkflow(parallelDefinition(), {
      workflowId: "workflow-parallel",
      goalId: "goal-parallel",
      goalWorkflowId: "workflow-parallel",
      at,
      budget: { maximumTurns: 20 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    let state = created.state;
    const alpha = handleCommand(state, {
      type: "start-check",
      nodeId: "alpha-build",
      attemptId: "attempt-alpha",
      commandId: "start-alpha",
      at,
    });
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    state = alpha.state;
    expect(state.runtime.nodes["alpha-build"]?.status).toBe("running");
    const beta = handleCommand(state, {
      type: "start-check",
      nodeId: "beta-build",
      attemptId: "attempt-beta",
      commandId: "start-beta",
      at,
    });
    expect(beta.ok, JSON.stringify(beta)).toBe(true);
    if (!beta.ok) return;
    expect(beta.state.runtime.nodes["alpha-build"]?.status).toBe("running");
    expect(beta.state.runtime.nodes["beta-build"]?.status).toBe("running");
  });

  it("dispatches both ready builds in one parallel batch", async () => {
    const created = createHypagoalWorkflow(parallelDefinition(), {
      workflowId: "workflow-parallel-batch",
      goalId: "goal-parallel-batch",
      goalWorkflowId: "workflow-parallel-batch",
      at,
      budget: { maximumTurns: 20 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const root = mkdtempSync(join(tmpdir(), "hypagraph-parallel-"));
    const executor = new CommandCheckExecutor({
      rootDirectory: root,
      artifactStore: new FileCheckArtifactStore(join(root, "artifacts")),
    });
    const registry = new ActiveCheckExecutionRegistry();
    const decisions = enumerateGoalContinuationCandidates(created.state)
      .filter(isReadyCheckDecision);
    expect(decisions.map((item) => item.nodeId).sort()).toEqual(["alpha-build", "beta-build"]);

    let sawBothRunning = false;
    // Put non-selected peer first on purpose: runner must re-order so primary
    // matches selectGoalContinuation (avoids stale_action_dispatch).
    const selected = selectGoalContinuation(created.state);
    expect(isReadyCheckDecision(selected)).toBe(true);
    if (!isReadyCheckDecision(selected)) return;
    const reordered = [
      ...decisions.filter((item) => item.nodeId !== selected.nodeId),
      selected,
    ];
    const dispatch = await runParallelDeterministicCheckDispatch({
      state: created.state,
      decisions: reordered,
      store,
      executor,
      registry,
      at: new Date().toISOString(),
      onAllStarted: (started) => {
        sawBothRunning = started.runtime.nodes["alpha-build"]?.status === "running"
          && started.runtime.nodes["beta-build"]?.status === "running";
      },
    });
    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);
    if (!dispatch.ok) return;
    expect(sawBothRunning).toBe(true);
    expect(dispatch.state.runtime.nodes["alpha-build"]?.status).toBe("succeeded");
    expect(dispatch.state.runtime.nodes["beta-build"]?.status).toBe("succeeded");
    expect(dispatch.state.runtime.facts["alpha.ready"]?.value).toBe(true);
    expect(dispatch.state.runtime.facts["beta.ready"]?.value).toBe(true);
  });
});

