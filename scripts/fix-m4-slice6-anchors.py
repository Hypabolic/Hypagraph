from pathlib import Path

path = Path("scripts/apply-m4-slice6.py")
text = path.read_text()

old_readme = '''replace_once(
    "README.md",
    "M4 is in progress. Slices 1 to 5 provide multi-iteration task and check repair loops, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
    "M4 is in progress. Slices 1 to 6 provide generic bounded iteration regions, independent graph components, explicit failure policies, hard iteration limits, numeric progress, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
)'''
new_readme = '''replace_once(
    "README.md",
    "M4 is in progress. Slices 1 to 5 provide generic multi-iteration regions, hard iteration limits, numeric progress metrics, best-result tracking, and patience failure. Later slices add independent-region outcome policy, recovery hardening, and the complete Pi loop surface.",
    "M4 is in progress. Slices 1 to 6 provide generic bounded iteration regions, independent graph components, explicit failure policies, hard iteration limits, numeric progress, best-result tracking, and patience failure. Later slices add recovery hardening and the complete Pi loop surface.",
)'''

old_skill = '''replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slices 1 to 5 execute bounded task-based and command-check repair loops. Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Do not select loop decisions manually.",
    "M4 Slices 1 to 6 execute generic bounded iteration regions. A region can be disconnected from the wider graph. Optional progress uses one numeric fact with a minimize or maximize direction. Failure policy is `fail-workflow`, `block-dependants`, or `record-and-continue`; omission means `fail-workflow`. A local failure never releases a dependant that requires region success. Unrelated ready work can continue when policy permits. Do not infer repair intent from node names and do not select region decisions manually.",
)'''
new_skill = '''replace_once(
    "skills/hypagraph/SKILL.md",
    "Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`.",
    "Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Failure policy is `fail-workflow`, `block-dependants`, or `record-and-continue`; omission means `fail-workflow`. A local failure never releases a dependant that requires region success. Unrelated ready work can continue when policy permits."
)'''

for old, new, name in ((old_readme, new_readme, "README"), (old_skill, new_skill, "skill")):
    if old not in text:
        raise SystemExit(f"The Slice 6 {name} migration block was not found.")
    text = text.replace(old, new, 1)

path.write_text(text)
