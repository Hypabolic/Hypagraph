from pathlib import Path
import re

# Keep the one-off migration resilient to the current customer-facing loop format.
path = Path("scripts/apply-m4-slice7.py")
text = path.read_text()
pattern = r'''replace_once\(\n    "src/ui/format\.ts",\n    '''.*?lines\.push\(`- \$\{loop\.id\}:.*?\n\)\n\nreplace_once\(\n    "docs/m4-vertical-slice-plan\.md",'''
replacement = '''replace_once(
    "src/ui/format.ts",
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""} - policy ${loopFailurePolicy(loop)}${progress}`);''',
    '''      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""} - policy ${loopFailurePolicy(loop)}${runtime?.blockedReason ? ` - ${runtime.blockedReason}` : ""}${progress}`);''',
)

replace_once(
    "docs/m4-vertical-slice-plan.md",'''
updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    raise SystemExit("Could not update the Slice 7 UI migration anchor.")
path.write_text(updated)
