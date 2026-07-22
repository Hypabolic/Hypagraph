from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace(
    "README.md",
    "M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is complete in v0.4 and adds deterministic check execution and Pi product integration.",
    "M0 provides the stable graph foundation. M1 adds the event-driven execution runtime. M2 adds typed facts and deterministic gates. M3 is complete in v0.4 and adds deterministic check execution and Pi product integration. M4 is active and adds executable bounded loops.",
)
replace(
    "README.md",
    "M3 is complete. Structured report parsers move to M3.1. Executable loops, replay navigation, graph revision comparison, and delegated node execution follow in later milestones.",
    "M4 is the selected next milestone. It adds typed loop success conditions, deterministic feedback continuation, hard iteration limits, progress and patience rules, durable iteration history, and live Pi loop state. M3.1 parser adapters are deferred until after v0.5.",
)
replace(
    "README.md",
    "- [Execution plan and roadmap](docs/execution-roadmap.md)",
    "- [Execution plan and roadmap](docs/execution-roadmap.md)\n- [M4 executable bounded loops vertical-slice plan](docs/m4-vertical-slice-plan.md)",
)

replace(
    "docs/execution-roadmap.md",
    "- Current milestone: M3.1",
    "- Current milestone: M4",
)

old_m4 = """# M4 - Executable bounded loops

## Objective

Execute declared cyclic regions safely.

## Loop state

Track:

- iteration number;
- hard iteration limit;
- patience;
- success predicate;
- progress or loss value;
- best result;
- selected feedback edge;
- exit reason.

Success and progress are different values.

A loop can improve without succeeding. A loop can also satisfy its success predicate without having the best loss value.

## M4 acceptance criteria

- The runtime executes only declared loop cycles.
- The runtime stops at the hard limit.
- The runtime can stop after no progress.
- The runtime stores each iteration result.
- Replay gives the same loop decision.
"""

new_m4 = """# M4 - Executable bounded loops

## Status

Active. The detailed implementation plan is in `docs/m4-vertical-slice-plan.md`.

M4 is selected before the M3.1 parser adapters.

## Objective

Execute declared cyclic regions as deterministic bounded iteration regions.

A valid v0.5 loop has one entry, one evaluation boundary, typed success rules, declared feedback, a hard iteration limit, and optional numeric progress and patience rules.

## Vertical slices

1. Execute one successful iteration.
2. Follow feedback and start iteration 2.
3. Run a check-driven repair loop.
4. Enforce the hard iteration limit.
5. Add progress, loss, best result, and patience.
6. Harden revision, cancellation, and recovery.
7. Complete the Pi loop product surface.
8. Dogfood and release v0.5.

## Loop state

Track:

- loop status;
- iteration number;
- hard iteration limit;
- typed success condition;
- progress or loss value;
- best metric and best iteration;
- no-progress count and patience;
- selected feedback edge;
- iteration history;
- exit reason.

Success and progress are different values.

A loop can improve without succeeding. A loop can also satisfy its success condition without having the best metric value.

## M4 acceptance criteria

- [ ] New loop definitions use typed success conditions.
- [ ] The runtime executes only structured declared loop regions.
- [ ] A false success condition follows only declared feedback.
- [ ] Current facts and gate routes do not leak into a later iteration.
- [ ] A failed evaluation check can drive a repair iteration.
- [ ] The runtime stops at the hard limit.
- [ ] The runtime can stop after no progress.
- [ ] The runtime stores each iteration result and best metric.
- [ ] Downstream work waits for loop success.
- [ ] Restore does not run a node or check.
- [ ] Replay gives the same loop decision and state hash.
- [ ] Pi shows current iteration, progress, and exit reason.
- [ ] The v0.5 dogfood and release checks pass.
"""

replace("docs/execution-roadmap.md", old_m4, new_m4)

replace(
    "docs/m3-completion-phase-plan.md",
    "Start this phase only after v0.4.",
    "This phase is deferred until after v0.5. M4 executable bounded loops is the selected next milestone.",
)
