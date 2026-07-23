from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        if new in text:
            return
        raise SystemExit(f"Required text was not found in {path}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "tests/pi-loop-check-repair.test.ts",
    'import type { PersistedHypagraph } from "../src/domain/model.js";',
    'import type { CheckResult, HypagraphCommand, PersistedHypagraph } from "../src/domain/model.js";',
)
replace_once(
    "tests/pi-loop-check-repair.test.ts",
    '''    const first = firstResult.details.hypagraph as PersistedHypagraph;

    expect(first.result.status).toBe("failed");
    expect(first.snapshot.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(first.snapshot.runtime.nodes.implement?.status).toBe("ready");
    expect(first.snapshot.runtime.nodes.test?.attempts[first.commands.find((command) => command.type === "start-check")!.attemptId!]).toMatchObject({ status: "failed", iteration: 1 });
''',
    '''    const first = firstResult.details.hypagraph as PersistedHypagraph;
    const firstCheck = firstResult.details.check as { attemptId: string; result: CheckResult; commands: HypagraphCommand[] };

    expect(firstCheck.result.status).toBe("failed");
    expect(first.snapshot.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(first.snapshot.runtime.nodes.implement?.status).toBe("ready");
    expect(first.snapshot.runtime.nodes.test?.attempts[firstCheck.attemptId]).toMatchObject({ status: "failed", iteration: 1 });
''',
)
replace_once(
    "tests/pi-loop-check-repair.test.ts",
    '''    const second = secondResult.details.hypagraph as PersistedHypagraph;

    expect(second.result.status).toBe("passed");
''',
    '''    const second = secondResult.details.hypagraph as PersistedHypagraph;
    const secondCheck = secondResult.details.check as { attemptId: string; result: CheckResult; commands: HypagraphCommand[] };

    expect(secondCheck.result.status).toBe("passed");
''',
)

replace_once(
    "tests/loop-check-repair.test.ts",
    '''  it("does not continue after a failed non-evaluation check and keeps retries in the same iteration", async () => {
''',
    '''  it("keeps a true condition pending when the evaluation check failed verification", async () => {
    const value = repairDefinition();
    value.loops[0]!.successWhen = {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: false },
    };
    const created = createWorkflow(value, at, "workflow-failed-check-true-condition");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const state = await completeTask(store, created.state, "implement", "implement-1");
    const lifecycle = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => failedResult("test-1")) },
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
    expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1, lastSuccess: true });
    expect(lifecycle.state.runtime.loops.repair?.iterations[0]).toMatchObject({ success: true, decision: "pending" });
    expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.completed")).toBe(false);
  });

  it.each(["timed_out", "cancelled", "interrupted", "error"] as const)(
    "does not continue from an evaluation check with status %s",
    async (status) => {
      const created = createWorkflow(repairDefinition(), at, `workflow-check-${status}`);
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      const store = new InMemoryWorkflowEventStore();
      store.seed({ events: created.events, snapshot: created.state });
      const state = await completeTask(store, created.state, "implement", "implement-1");
      const result: CheckResult = {
        checkKind: "command",
        attemptId: "test-1",
        startedAt: at,
        completedAt: "2026-07-23T03:00:02.000Z",
        status,
        facts: [],
        evidence: [],
      };
      const lifecycle = await runDurableCheckLifecycle({
        state,
        executor: { execute: vi.fn(async () => result) },
        store,
        nodeId: "test",
        attemptId: "test-1",
        requestedAt: at,
        signal: new AbortController().signal,
      });
      expect(lifecycle.ok).toBe(true);
      if (!lifecycle.ok) return;
      expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
      expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
    },
  );

  it("does not continue after a failed non-evaluation check and keeps retries in the same iteration", async () => {
''',
)

for path in ["tests/pi-loop-check-repair.test.ts", "tests/loop-check-repair.test.ts"]:
    if b"\x00" in Path(path).read_bytes():
        raise SystemExit(f"NUL control character found in {path}")
