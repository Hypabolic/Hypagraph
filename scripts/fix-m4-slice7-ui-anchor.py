from pathlib import Path

path = Path("scripts/apply-m4-slice7.py")
text = path.read_text()
old = '''replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - policy ${loop.failurePolicy ?? "fail-workflow"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - policy ${loop.failurePolicy ?? "fail-workflow"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : ""}${progress}`);''',
)'''
new = '''replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""} - policy ${loopFailurePolicy(loop)}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : ""} - policy ${loopFailurePolicy(loop)}${progress}`);''',
)'''
if old in text:
    path.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit("The Slice 7 UI migration block was not found.")
