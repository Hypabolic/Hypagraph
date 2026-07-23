from pathlib import Path

# Update the one-off migration to the current UI line. This file is removed before merge.
path = Path("scripts/apply-m4-slice7.py")
text = path.read_text()
old = """replace_once(
    \"src/ui/format.ts\",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - policy ${loop.failurePolicy ?? \"fail-workflow\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - policy ${loop.failurePolicy ?? \"fail-workflow\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : \"\"}${progress}`);''',
)
"""
new = """replace_once(
    \"src/ui/format.ts\",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"} - policy ${loopFailurePolicy(loop)}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? \"pending\"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : \"\"} - policy ${loopFailurePolicy(loop)}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : \"\"}${progress}`);''',
)
"""
if old not in text:
    if new in text:
        raise SystemExit(0)
    raise SystemExit("Could not find the stale Slice 7 UI migration block.")
path.write_text(text.replace(old, new, 1))
