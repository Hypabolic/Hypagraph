from pathlib import Path

# Update one-off migration anchors and stale Slice 3 expectations. This file is removed before merge.
path = Path("scripts/apply-m4-slice7.py")
text = path.read_text()

old_ui = """replace_once(
    \"src/ui/format.ts\",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - policy ${loop.failurePolicy ?? \"fail-workflow\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - policy ${loop.failurePolicy ?? \"fail-workflow\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : \"\"}${progress}`);''',
)
"""
new_ui = """replace_once(
    \"src/ui/format.ts\",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"} - policy ${loopFailurePolicy(loop)}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"} - policy ${loopFailurePolicy(loop)}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : \"\"}${progress}`);''',
)
"""
if old_ui in text:
    text = text.replace(old_ui, new_ui, 1)
elif new_ui not in text:
    raise SystemExit("Could not find the Slice 7 UI migration block.")

snippet = r'''
# Align existing cancellation and interruption tests with the accepted blocked-region rule.
replace_once(
    "tests/loop-check-recovery.test.ts",
    '''    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(recovered.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);''',
    '''    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "blocked", currentIteration: 1, blockedAttemptId: "test-1" });
    expect(recovered.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
    expect(recovered.events.some((event) => event.type === "hypagraph.loop.blocked")).toBe(true);''',
)
replace_once(
    "tests/loop-check-repair.test.ts",
    '''      expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
      expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);''',
    '''      expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
      const blocksRegion = status === "cancelled" || status === "interrupted";
      expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: blocksRegion ? "blocked" : "running", currentIteration: 1 });
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.blocked")).toBe(blocksRegion);''',
)
replace_once(
    "tests/loop-revision-recovery.test.ts",
    '''    expect(cancelled.state.phase).toBe("blocked");
    expect(cancelled.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "work-cancel", blockedReason: "Stop this iteration." });''',
    '''    expect(cancelled.state.phase).toBe("running");
    expect(cancelled.state.runtime.nodes.outside?.status).toBe("ready");
    expect(cancelled.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "work-cancel", blockedReason: "Stop this iteration." });''',
)

'''
marker = "for path in [\n"
if snippet not in text:
    if marker not in text:
        raise SystemExit("Could not find the Slice 7 final scan marker.")
    text = text.replace(marker, snippet + marker, 1)

path.write_text(text)
