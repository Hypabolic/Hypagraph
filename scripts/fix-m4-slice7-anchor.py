from pathlib import Path

# Replace the old generator with one final idempotent hardening pass.
Path("scripts/apply-m4-slice7.py").write_text(r'''from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}")


replace_once(
    "src/domain/projection.ts",
    '''    case "hypagraph.workflow.revised": {
      next.definition = normaliseDefinition(event.data.definition as HypagraphDefinition);''',
    '''    case "hypagraph.workflow.revised": {
      next.phase = "running";
      next.definition = normaliseDefinition(event.data.definition as HypagraphDefinition);''',
)

replace_once(
    "tests/loop-revision-recovery.test.ts",
    '''  it("preserves an unchanged completed loop when unrelated work changes", () => {''',
    '''  it("restarts a failed fail-workflow loop after a relevant revision", () => {
    const created = createWorkflow(definition(), at, "workflow-failed-loop-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, false);
    state = completeRegion(state, events, false);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops.region).toMatchObject({ status: "failed", currentIteration: 2, exitReason: "max_iterations" });

    const revised = handleCommand(state, { type: "revise", definition: definition(3), commandId: "revise-failed-loop", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.state.phase).toBe("running");
    expect(revised.state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0, maxIterations: 3 });
    expect(revised.state.runtime.nodes.work?.status).toBe("ready");

    const restarted = handleCommand(revised.state, { type: "start-node", nodeId: "work", attemptId: "work-after-failure", commandId: "restart-after-failure", at });
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.diagnostics));
    expect(restarted.state.runtime.loops.region).toMatchObject({ status: "running", currentIteration: 1 });
  });

  it("preserves an unchanged completed loop when unrelated work changes", () => {''',
)
''')
