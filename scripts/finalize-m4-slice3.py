from pathlib import Path

path = Path("docs/event-runtime.md")
text = path.read_text()
old = """## Current M4 limit

M4 Slice 1 supports one successful loop iteration.

It does not yet support:

- feedback continuation into iteration 2;
- hard-limit failure;
- progress metrics or patience;
- failed-check observation as a continuation signal;
- loop cancellation and revision hardening;
- parallel iterations;
- nested or overlapping loops.
"""
new = """## Current M4 limit

M4 Slices 1 to 3 support successful task and check iterations, deterministic feedback continuation, isolated iteration reset, and failed evaluation-check observations.

It does not yet support:

- hard-limit failure;
- progress metrics or patience;
- loop cancellation and revision hardening;
- parallel iterations;
- nested or overlapping loops.
"""
if old in text:
    path.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit("The M4 limit section was not found in docs/event-runtime.md")
