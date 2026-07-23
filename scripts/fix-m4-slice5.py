from pathlib import Path

path = Path("scripts/apply-m4-slice5.py")
text = path.read_text()
old = '''replace_once(\n    "README.md",\n    "M4 is the selected next milestone. Slices 1 to 4 add typed loop success conditions, structured iteration-region validation, schema version 3, deterministic feedback continuation, isolated multi-iteration task and check loops, failed check observations, and hard iteration limits. Later slices add progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",\n    "M4 is the selected next milestone. Slices 1 to 5 add typed loop success conditions, structured iteration-region validation, deterministic feedback continuation, check-driven repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",\n)'''
new = '''replace_once(\n    "README.md",\n    "M4 is in progress. It extends executable bounded loops with multi-iteration repair behavior, progress rules, recovery hardening, and the complete Pi loop surface.",\n    "M4 is in progress. Slices 1 to 5 provide multi-iteration task and check repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",\n)'''
if old not in text:
    raise SystemExit("The Slice 5 README migration block was not found.")
path.write_text(text.replace(old, new, 1))
