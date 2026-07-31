# Wave 1 exit report

- Goal: shared bottom-dock chrome from `docs/product-surface-orchestration-plan.md`
- Also fixed: terminal goal clears durable model-lane continuation

## Why the Pi Wave 1 hypagoal did no work

1. Wave 0 root still occupied the session (`goal` completed, workflow completed).
2. `hypagoal_start` for Wave 1 returned **replacement-required** with a typed confirmation.
3. The model did not re-submit `hypagoal_start` with that exact `replacementConfirmation`.
4. An orphaned model-lane continuation from Wave 0 could not be abandoned (stale identity after complete).
5. Result: no Wave 1 graph, no implementation — looks like a stall, but it is a **blocked create**, not a running wave.

User recovery in Pi (either path):

- `/hypagraph cancel` if a non-terminal root is active, then `/hypagoal <wave1 objective>`; or
- Call `hypagoal_start` again with the **exact** replacement confirmation from the tool details; or
- Start a **new Pi session** so no root exists.

## Slices done here (outside the stuck Pi goal)

| Slice | Result |
| --- | --- |
| S1.1 | `src/ui/bottom-dock-overlay.ts` — `bottomDockOverlayOptions` / `interactionDockOverlayOptions` |
| S1.2 | `presentInteractionDialog` uses bottom-center full-width dock options |
| Fix | `goal.completed` and `goal.failed` clear `pendingContinuation` (cancel already did) |

## Tests

- `tests/bottom-dock-overlay.test.ts` (4)
- `tests/goal-lifecycle.test.ts` including pending clear on complete (7)

## Not done (later waves)

- Wave 2 polish (dock chrome border, free-text follow-up dogfood)
- Waves 3–8

## Next

Wave 2 (interaction chrome polish) or Wave 3 (Mermaid) per orchestration plan.
