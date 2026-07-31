# Wave 4 implementation summary — Post-create dock and Run gate

## Status

**Wave 4 complete (S4.1–S4.5 / G3–G5). Review P1–P2 resolved.**

## Slices

| Slice | Result |
| --- | --- |
| **S4.1 / G3** | `src/pi/post-create-dock.ts`: Mermaid art via `projectGraphView` → `projectMermaidFlowchart` → `renderMermaidArt`; Run / Question / Cancel; keyboard; Esc = Question; bottom dock overlay |
| **S4.2 / G4 gate** | Host flags `postCreateAwaitingUserChoice` + `postCreateDockPresented`; `queueGoalContinuation` no-ops while awaiting |
| **S4.3 / G4 wiring** | Interactive TUI create sets gate; `agent_end` presents dock; Run → clear + queue; Question → keep gate + block work tools; Cancel → clear gate only after successful cancel-goal; resume maps to Run after Question |
| **S4.4** | Headless / non-TUI: no dock, no gate, auto-continue (tested) |
| **S4.5 / G5** | Skill + README: after create user reviews graph and chooses Run / Question / Cancel |

## Files changed

| File | Change |
| --- | --- |
| `src/pi/post-create-dock.ts` | New post-create dock component + present helper + host support check |
| `src/extension.ts` | Gate flags; create sets gate; agent_end resolves dock; resume/cancel clear gate |
| `tests/post-create-dock.test.ts` | Component + gate + P1/P2 tests (18) |
| `skills/hypagraph/SKILL.md` | Wait for user decision after interactive create |
| `README.md` | Post-create dock product behaviour |
| `docs/product-surface-orchestration-plan.md` | Wave 4 done |
| `docs/post-create-graph-dock-plan.md` | G3–G5 done |

## Design decisions

1. Host-only gate (not domain reducer). Domain stays pure.
2. Present dock on `agent_end` after create, not mid-tool, so the tool result lands first.
3. Esc = Question (safe dismiss). Cancel requires row/digit 3.
4. Question keeps goal `active` and leaves the gate set; dock is not re-shown on later agent_end.
5. Question turns get a wait prompt and blocked work tools until Run or resume.
6. `/hypagraph resume` after Question clears the gate and queues (maps to Run).
7. Mermaid source in tool details; Unicode art is TUI-only.
8. Dock only when `hasUI && mode === "tui" && ui.custom`. Headless auto-continues.
9. When a delivered model turn completes the goal (pendingContinuation cleared), agent_end notifies the terminal lifecycle and skips usage accounting for that last turn.
10. Cancel clears the host gate only after `cancel-goal` commits successfully (dock Cancel, `/hypagraph cancel`, and `/hypagoal cancel`).

## Tests run

```text
npx tsc --noEmit
npx vitest run tests/post-create-dock.test.ts tests/hypagoal-continuation-pi.test.ts tests/interaction-bottom-dock.test.ts
```

## Not done (later waves)

- Wave 5 trigger editor highlight
- Wave 6 isolated model sessions
- Live graph pane Mermaid reuse
- Live dogfood evidence for the post-create dock
