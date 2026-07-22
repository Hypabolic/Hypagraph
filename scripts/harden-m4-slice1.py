from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


replace(
    "src/domain/model.ts",
    'export type LoopStatus = "inactive" | "running" | "completed" | "requires_revision";',
    'export type LoopStatus = "pending" | "running" | "succeeded" | "requires_revision";',
)
replace(
    "src/domain/model.ts",
    '  evaluatedAt?: string;\n  success?: boolean;',
    '  evaluatedAt?: string;\n  evaluationEventId?: string;\n  evaluationSequence?: number;\n  success?: boolean;',
)

replace(
    "src/domain/projection.ts",
    'const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate =>\n  typeof value === "string" || value.kind === "legacy-text";',
    '''const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyLoopPredicate>;
  return candidate.kind === "legacy-text" && typeof candidate.text === "string";
};''',
)
replace(
    "src/domain/projection.ts",
    '  const legacyText = typeof loop.successWhen === "string" ? loop.successWhen : loop.successWhen.kind === "legacy-text" ? loop.successWhen.text : undefined;',
    '  const legacyText = typeof loop.successWhen === "string" ? loop.successWhen : isLegacyPredicate(loop.successWhen) ? loop.successWhen.text : undefined;',
)
replace("src/domain/projection.ts", '    status: legacy ? "requires_revision" : "inactive",', '    status: legacy ? "requires_revision" : "pending",')
replace("src/domain/projection.ts", 'Object.values(state.runtime.loops).every((loop) => loop.status === "completed");', 'Object.values(state.runtime.loops).every((loop) => loop.status === "succeeded");')
replace(
    "src/domain/projection.ts",
    '          record.evaluatedAt = event.timestamp;\n          record.success = success;',
    '          record.evaluatedAt = event.timestamp;\n          record.evaluationEventId = event.eventId;\n          record.evaluationSequence = event.sequence;\n          record.success = success;',
)
replace("src/domain/projection.ts", '        runtime.status = "completed";', '        runtime.status = "succeeded";')

replace(
    "src/domain/reducer.ts",
    'const allLoopsCompleted = (state: HypagraphState): boolean => Object.values(state.runtime.loops).every((loop) => loop.status === "completed");',
    'const allLoopsCompleted = (state: HypagraphState): boolean => Object.values(state.runtime.loops).every((loop) => loop.status === "succeeded");',
)
replace(
    "src/domain/reducer.ts",
    'const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || value.kind === "legacy-text";',
    '''const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyLoopPredicate>;
  return candidate.kind === "legacy-text" && typeof candidate.text === "string";
};''',
)
replace("src/domain/reducer.ts", '  if (runtime.status === "completed") return reject("loop_already_completed", `Loop \'${definition.id}\' is complete.`);', '  if (runtime.status === "succeeded") return reject("loop_already_completed", `Loop \'${definition.id}\' is complete.`);')
replace("src/domain/reducer.ts", '  if (runtime.status === "inactive") {', '  if (runtime.status === "pending") {')

replace(
    "src/domain/validate.ts",
    '''const upstreamNodeIds = (definition: HypagraphDefinition, nodeId: string): Set<string> => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  const queue = [...(byId.get(nodeId)?.requires ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...(byId.get(current)?.requires ?? []));
  }
  return result;
};''',
    '''const upstreamNodeIds = (definition: HypagraphDefinition, nodeId: string): Set<string> => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const feedback = new Set(definition.loops.flatMap((loop) => loop.feedbackEdges.map((edge) => `${edge.from}\\u0000${edge.to}`)));
  const dependencies = (targetId: string): string[] => (byId.get(targetId)?.requires ?? [])
    .filter((sourceId) => !feedback.has(`${sourceId}\\u0000${targetId}`));
  const result = new Set<string>();
  const queue = [...dependencies(nodeId)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...dependencies(current));
  }
  return result;
};''',
)
replace(
    "src/domain/validate.ts",
    'const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || "text" in value;',
    'const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => typeof value === "string" || (isRecord(value) && value.kind === "legacy-text" && typeof value.text === "string");',
)
replace(
    "src/domain/validate.ts",
    '''    for (const edge of loop.feedbackEdges) {
      const target = definition.nodes.find((node) => node.id === edge.to);''',
    '''    const feedbackEdges = new Set<string>();
    for (const edge of loop.feedbackEdges) {
      const key = feedbackKey(edge.from, edge.to);
      if (feedbackEdges.has(key)) diagnostics.push({ code: "duplicate_feedback_edge", message: `Loop '${loop.id}' repeats feedback edge '${edge.from} -> ${edge.to}'.`, location: `${location}.feedbackEdges` });
      feedbackEdges.add(key);
      const target = definition.nodes.find((node) => node.id === edge.to);''',
)

replace("src/graph/projection.ts", '        status: runtime?.status ?? "inactive",', '        status: runtime?.status ?? "pending",')
replace("src/graph/renderer.ts", 'viewLoop?.status === "completed"', 'viewLoop?.status === "succeeded"')
replace("src/ui/format.ts", 'status: runtime?.status ?? "inactive",', 'status: runtime?.status ?? "pending",')
replace("src/ui/format.ts", '`${runtime?.status ?? "inactive"}', '`${runtime?.status ?? "pending"}')

for path in ("tests/graph-layout-renderer.test.ts", "tests/graph-projection.test.ts", "tests/loop-slice-one.test.ts"):
    text = Path(path).read_text().replace('status: "inactive"', 'status: "pending"').replace('status: "completed"', 'status: "succeeded"')
    Path(path).write_text(text)

replace(
    "tests/loop-slice-one.test.ts",
    '    expect(state.runtime.nodes.attempts).toBeUndefined();\n',
    '',
)
replace(
    "tests/loop-slice-one.test.ts",
    '      expect.objectContaining({ iteration: 1, success: true, decision: "complete", factsUsed: ["tests.passed"] }),',
    '      expect.objectContaining({ iteration: 1, success: true, decision: "complete", factsUsed: ["tests.passed"], evaluationEventId: expect.any(String), evaluationSequence: expect.any(Number) }),',
)

replace(
    "docs/m4-vertical-slice-plan.md",
    "- Status: implementation in progress",
    "- Status: complete",
)

replace(
    "README.md",
    "- declared loop boundaries;",
    "- declared loop boundaries;\n- typed loop success conditions;\n- schema version 3 canonical loop runtime;\n- one successful loop iteration with a downstream completion barrier;",
)

write("skills/hypagraph/SKILL.md", '''---
name: hypagraph
description: Define and execute multi-step coding work as a directed graph with explicit dependencies, typed facts, deterministic gates, evidence, checks, and bounded loops.
---

# Hypagraph

Use Hypagraph when a coding request has dependent steps, risky sequence requirements, typed outcomes, deterministic routing, multiple ready nodes, or an implement-test-repair cycle.

1. Examine enough of the repository to define correct nodes and dependencies.
2. Call `hypagraph_define`. Use stable lowercase IDs. Add explicit dependencies, acceptance criteria, fact contracts, typed gate and loop conditions, and narrow writable scopes.
3. Call `hypagraph_transition` with `action: "start"` before you work on one ready task node. Use `action: "evaluate"` for a ready gate node.
4. Work only in the contract and scope of the active task node.
5. Use `action: "publish"` to publish declared facts while the attempt is running.
6. Use `action: "submit"` with concrete evidence when the task result is ready. Fact publication stops after submission.
7. Use a separate `action: "verify"` to pass or fail the submitted result. Do not combine submission and verification.
8. Use `hypagraph_run_check` for a ready command-check node. Do not start a check with `hypagraph_transition`.
9. If work cannot continue, use `action: "block"` and give a specific reason. Use `action: "cancel"` for an active attempt that must stop.
10. Call `hypagraph_revise` when new information makes the plan incorrect. Preserve completed work and route selections when their contracts did not change.

Do not add an accidental cycle. A deliberate cycle must be a declared loop. For v0.5, the loop must be a structured single-entry and single-exit region. Its nodes must be the same as one cyclic strongly connected component. Feedback must go from the evaluation node to the entry node. `successWhen` must use the typed condition structure. The loop must have a hard `maxIterations` limit.

M4 Slice 1 executes iteration 1 and can complete a loop when the evaluation node passes verification and the typed success condition is true. A false condition remains in the current iteration until Slice 2 adds feedback continuation. Do not claim that multi-iteration continuation, hard-limit failure, or patience is active yet.
''')

write("docs/event-runtime.md", '''# Hypagraph event-driven runtime

- Status: implemented
- Version: 0.5 development
- Date: 2026-07-22
- Writing standard: ASD-STE100 Simplified Technical English

## Purpose

The graph defines the work. The deterministic runtime controls state changes.

Hypagraph uses commands, versioned events, and pure projections. The Pi extension does not change canonical graph state directly.

## Source of truth

The ordered event stream is the source of truth.

A snapshot is a projection of that event stream. Hypagraph stores each accepted event batch with its resulting snapshot. Restore replays the events and checks the snapshot hash.

Schema version 2 snapshots are accepted only through the migration path. New schema version 3 batches must match their replayed hash.

## Event envelope

Each event contains:

- event ID;
- workflow ID;
- graph revision;
- sequence number;
- event type and version;
- timestamp;
- causation ID;
- correlation ID;
- optional node ID;
- optional attempt ID;
- optional loop ID;
- event data.

Sequence numbers are contiguous. The first event has sequence number 1.

## Commands

The runtime supports commands for:

- workflow revision, pause, and resume;
- task and check start;
- check-result recording;
- typed fact publication;
- gate evaluation;
- result submission and verification;
- node block and unblock;
- attempt cancellation.

A command returns events or diagnostics. A rejected command returns no events.

The model cannot select a loop decision. Loop start and evaluation are deterministic effects of existing task and check commands.

## Node and attempt lifecycle

Node states are:

```text
pending
ready
starting
running
awaiting_evidence
verifying
succeeded
failed
blocked
cancelled
skipped
stale
```

Each node start creates an immutable attempt ID. Attempts inside a loop also store the loop ID and iteration number.

A result is valid only when its attempt ID is the current attempt ID for the node. Hypagraph rejects stale results and stale cancellation requests.

## Typed facts and gates

Facts are bound to:

- producer node;
- attempt ID;
- workflow revision;
- optional loop ID;
- optional loop iteration.

A gate uses the typed condition structure. The route-selection event stores the outcome, facts used, and condition-semantics version.

## Loop Slice 1 lifecycle

A new loop definition uses a typed `successWhen` condition.

When the ready loop entry starts, one command batch records:

1. `hypagraph.loop.iteration-started`;
2. the task-attempt or check-start event.

When the evaluation node passes verification, the same command batch records:

1. the verification-passed event;
2. `hypagraph.loop.evaluated`;
3. `hypagraph.loop.completed` when the condition is true;
4. any newly ready downstream nodes;
5. workflow completion when applicable.

The loop evaluation event stores the iteration, success value, facts used, condition-semantics version, and decision. Replay uses the stored decision. It does not evaluate the condition again from later facts.

A node outside the loop cannot become ready from the evaluation node until the loop status is `succeeded`.

Slice 1 does not start a second iteration. A false condition records a pending decision and keeps downstream work blocked. Slice 2 adds feedback continuation and iteration reset.

## Readiness

Readiness is recorded as an event.

Hypagraph emits a node-ready event when:

- the node is pending or stale;
- all non-feedback dependencies succeeded or were skipped;
- each source loop for an external dependency succeeded.

The ready frontier is a projection of node-ready events.

## Durable check boundary

A command check keeps this order:

```text
store check start
    |
    v
run command
    |
    v
store facts
    |
    v
store raw result
    |
    v
store verification and loop decision
```

Restore does not run a task or check.

## Replay rules

Replay must obey these rules:

1. The first event defines the workflow.
2. Every event has the same workflow ID.
3. Event sequence numbers are contiguous.
4. Events are applied in sequence order.
5. The same event stream produces the same snapshot hash.
6. Loop decisions come from stored events.
7. Replay does not read the clock, run a process, or call Pi.

## Schema migration

Schema version 3 is the current snapshot format.

A valid version 2 event stream without loops replays into schema version 3 automatically.

A version 2 loop with a textual predicate remains readable. Migration stores the text as legacy predicate data and sets the loop status to `requires_revision`. Hypagraph does not guess how to convert the text into executable logic. A definition revision must supply a typed condition before the loop can run.

## Pi adapter boundary

The Pi extension can:

- convert tool input into commands;
- call the domain command handler;
- append returned event batches;
- run an external check only after its start event is stored;
- render text and graph projections;
- enforce file scope at the Pi boundary.

The Pi extension must not contain loop decision rules.

## Current M4 limit

M4 Slice 1 supports one successful loop iteration.

It does not yet support:

- feedback continuation into iteration 2;
- hard-limit failure;
- progress metrics or patience;
- failed-check observation as a continuation signal;
- loop cancellation and revision hardening;
- parallel iterations;
- nested or overlapping loops.
''')

write("tests/pi-loop-slice-one.test.ts", r'''import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4 Slice 1 Pi loop path", () => {
  it("completes a task-to-check loop through the registered Pi tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hypagraph-loop-"));
    workspaces.push(workspace);
    const tools = new Map<string, RegisteredTool>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    } as unknown as ExtensionAPI;
    hypagraphExtension(pi);

    const ctx = {
      cwd: workspace,
      sessionManager: { getBranch: () => [] },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const runCheck = tools.get("hypagraph_run_check")!;

    await define.execute("define", {
      title: "Pi one-iteration loop",
      goal: "Pass the command check and release documentation",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          kind: "check",
          requires: ["implement"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: process.execPath,
            arguments: ["-e", "process.exit(0)"],
            timeoutMs: 10_000,
            publish: [{ source: "passed", fact: "tests.passed" }],
          },
        },
        { id: "document", title: "Document", requires: ["test"], acceptance: [] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await transition.execute("start-implement", { action: "start", nodeId: "implement" }, signal, undefined, ctx);
    await transition.execute("submit-implement", { action: "submit", nodeId: "implement", evidence: [] }, signal, undefined, ctx);
    await transition.execute("verify-implement", { action: "verify", nodeId: "implement", passed: true }, signal, undefined, ctx);
    const result = await runCheck.execute("run-test", { nodeId: "test" }, signal, undefined, ctx);
    const persisted = result.details.hypagraph as PersistedHypagraph;

    expect(persisted.snapshot.runtime.loops.repair).toMatchObject({
      status: "succeeded",
      currentIteration: 1,
      lastSuccess: true,
      exitReason: "success",
    });
    expect(persisted.snapshot.runtime.nodes.document?.status).toBe("ready");
    expect(persisted.snapshot.runtime.nodes.test?.attempts[persisted.snapshot.runtime.nodes.test.currentAttemptId!]).toMatchObject({
      loopId: "repair",
      iteration: 1,
    });
    expect(persisted.snapshot.runtime.facts["tests.passed"]).toMatchObject({ loopId: "repair", iteration: 1, value: true });
    expect(entries.length).toBeGreaterThan(0);
    expect(persisted.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hypagraph.loop.iteration-started",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.completed",
    ]));
  });
});
''')
