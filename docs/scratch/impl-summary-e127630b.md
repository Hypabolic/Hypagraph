# Wave 2 implementation summary — Interaction bottom dock

## Status

**Code complete. Live interactive Pi dogfood pending (L1–L8).**

## Slices

| Slice | Result |
| --- | --- |
| **S2.1** | Present path uses `bottomDockOverlayOptions`; test asserts bottom-center options |
| **S2.2** | Top border chrome + **option viewport** so selection and key help stay visible |
| **S2.3** | Free-text / feedback on host `ui.input` (bottom editor slot); documented |
| **Review r1** | maxHeight 55%, footer margin 3, tui row budget |
| **Review r2** | Internal viewport under maxContentLines; honest “code done / live pending” status |

## Files changed

| File | Change |
| --- | --- |
| `src/ui/bottom-dock-overlay.ts` | Shared dock options: 55% / margin 3 / `resolveBottomDockMaxHeight` |
| `src/extension.ts` | Factory captures TUI; dock options + `maxContentLines` into dialog |
| `src/pi/interaction-dialog.ts` | Top border; `maxContentLines` viewport; `optionWindowForSelection` |
| `tests/bottom-dock-overlay.test.ts` | Sizing defaults and tui derivation |
| `tests/interaction-bottom-dock.test.ts` | Present path + chrome + viewport navigation tests |
| `docs/scratch/wave2-dogfood-note.md` | Static pass matrix; live L1–L8 pending |
| `docs/interaction-bottom-dock-plan.md` | Code complete; live dogfood pending |
| `docs/product-surface-orchestration-plan.md` | Wave 2 code done; live dogfood pending |

## Design decisions

1. Bottom dock via shared helper (`anchor: "bottom-center"`, width 100%, footer margin 3).
2. With live TUI rows: absolute maxHeight; dialog receives same number as `maxContentLines`.
3. Option list windows around selection; key help always last; more-above/below indicators.
4. Free-text stays on `ctx.ui.input` (no placement API).
5. Wave 2 acceptance stays open until live Pi L1–L8.

## Tests run

```text
npm run typecheck  # clean
npx vitest run tests/bottom-dock-overlay.test.ts \
  tests/interaction-bottom-dock.test.ts \
  tests/m6-1-interaction-slice-1-1.test.ts
# 3 files, 47 tests passed
```

## Not done

- Live interactive Pi L1–L8
- Waves 3–8

## Review round 3

- Fixed selected-label drop under tight budget with long descriptions.
- Closed layout priority: key help + selected `›` label always kept; trim indicators, neighbors, description end, then question.
- Regression test: width 40, maxContentLines 8, long description → label + help visible, length ≤ 8.
- Tests: 48 passed; typecheck clean.
