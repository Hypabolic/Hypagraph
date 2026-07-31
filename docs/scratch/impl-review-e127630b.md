## Review Issues (round 2)

### Issue 1 [Codex] — Severity: bug
- **File**: src/pi/interaction-dialog.ts:123
- **Description**: Height change does not keep the selected row visible. Component still renders all rows; Pi truncates to first maxHeight lines. Keyboard can select a hidden response.
- **Suggestion**: Add an internal viewport that keeps the selected row and key help visible. Add a test that navigates to the last response and asserts visible output contains selected response and key help.
- **Status**: fixed
- **Response**: Added `maxContentLines` and `optionWindowForSelection` to `InteractionDialogComponent`. Options window around the selection; more-above/more-below indicators; key-help footer always last via `fitWithinBudget`. Present path passes dock `maxHeight` (row budget) as `maxContentLines`. Tests: navigate to last of 12 choices under 13-line budget — render ≤ budget, contains Choice 12 + key help, drops Choice 1.

### Issue 2 [Codex] — Severity: suggestion
- **File**: docs/product-surface-orchestration-plan.md status board
- **Description**: Wave 2 marked complete without live Pi dogfood. Honest status should be code complete / live acceptance pending.
- **Suggestion**: Mark Wave 2 as "code done; live dogfood pending" rather than fully complete. Expand dogfood note accordingly.
- **Status**: fixed
- **Response**: Status board: `code done; live dogfood pending`. Interaction plan and wave2-dogfood-note state code complete / live L1–L8 pending. Orchestration header no longer claims Wave 2 fully complete.

---

## Implementation Summary (round 2 fix)

### Code
| File | Change |
| --- | --- |
| `src/pi/interaction-dialog.ts` | Option viewport + key-help-last fit; `optionWindowForSelection` export; `InteractionDialogOptions.maxContentLines` |
| `src/extension.ts` | Pass dock numeric maxHeight as `maxContentLines` into dialog |
| `tests/interaction-bottom-dock.test.ts` | Viewport tests: last selection + chat row under tight budget |
| `docs/product-surface-orchestration-plan.md` | Wave 2 code done; live dogfood pending |
| `docs/interaction-bottom-dock-plan.md` | Code complete; live dogfood pending |
| `docs/scratch/wave2-dogfood-note.md` | Viewport documented; A7 updated; acceptance open until L1–L8 |

### Design
- Component owns visibility under the dock budget; host still clips but content already fits.
- Expand option window down then up around selection within line budget.
- Prefer footer (key help) over body over header if a final hard fit is required.

### Tests
```text
npm run typecheck  # clean
npx vitest run tests/bottom-dock-overlay.test.ts \
  tests/interaction-bottom-dock.test.ts \
  tests/m6-1-interaction-slice-1-1.test.ts
# 3 files, 47 tests passed
```
