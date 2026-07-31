# Wave 2 dogfood note — interaction bottom dock

- Status: Wave 2 **code complete**; live interactive Pi dogfood **pending** (L1–L8 not run)
- Scope: dock placement, chrome, option viewport, free-text follow-ups, sizing budget
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Free-text and feedback follow-ups (S2.3)

After a closed answer in the rich dock, Hypagraph may call `ctx.ui.input` for:

1. optional free-text notes (`interaction.freeText`);
2. optional structured feedback (`interaction.feedback`).

### Host API facts

`ExtensionUIContext.input` accepts only:

- title;
- optional placeholder;
- optional `ExtensionUIDialogOptions` (`signal`, `timeout`).

The host API does not accept overlay placement options for `input`.

In interactive Pi, `showExtensionInput` does not open a centered overlay. It replaces the editor container (the bottom composer slot) with `ExtensionInputComponent`, then restores the editor when the person submits or cancels.

### Placement conclusion

| Path | Placement | Dock control |
| --- | --- | --- |
| Rich closed/open dialog (`ui.custom`) | Bottom via `bottomDockOverlayOptions` | Yes — shared helper |
| Free-text / feedback follow-up (`ui.input`) | Bottom composer slot (host default) | No extra options; host already bottom-local |
| Plain select host (`ui.select` / `ui.input`) | Host default | Unchanged |

No new API is available to force dock placement on `ui.input`. Inventing a custom overlay for free-text would duplicate host behaviour and is out of scope.

## 2. Dock sizing (static analysis)

Defaults after review fix:

| Setting | Value | Reason |
| --- | --- | --- |
| `BOTTOM_DOCK_MAX_HEIGHT` | `55%` | Old `40%` clipped dialog tail on 24-row terminals (~9 rows) |
| `BOTTOM_DOCK_FOOTER_MARGIN` | `3` | Pi footer is often 2–3 lines |
| Live `tui.terminal.rows` | absolute row budget at open | Prefer content head+help; leave footer and one history row |

On 24 rows with margin 3: maxHeight resolves to 13 rows (`floor(24 * 0.55)`). That budget covers top border, question, several responses, and key help more often than 40%.

The dialog windows options around the selection when `maxContentLines` matches the dock maxHeight. Selected row and key help stay inside the budget. More-above / more-below indicators show when the list scrolls.

## 3. Check matrix

### 3.1 Static / automated (done in this pass)

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| A1 | Present path requests `anchor: "bottom-center"` | pass | `tests/interaction-bottom-dock.test.ts` |
| A2 | Footer margin ≥ 3 | pass | `BOTTOM_DOCK_FOOTER_MARGIN` + unit test |
| A3 | Default maxHeight ≥ 55% | pass | `BOTTOM_DOCK_MAX_HEIGHT` + unit test |
| A4 | Live tui rows produce absolute maxHeight | pass | `bottomDockOverlayOptions({ tui })` tests |
| A5 | Dialog top border chrome | pass | dialog chrome tests |
| A6 | Recommended preselect + keyboard + Esc | pass | dialog chrome tests |
| A7 | Many-response viewport keeps selection + key help | pass | navigate-to-last under maxContentLines |
| A8 | Free-text uses host `input` (no invented API) | pass | `extension.ts` + this note |
| A9 | Typecheck / focused vitest green | pass | `npm run typecheck` + focused tests |

### 3.2 Live interactive Pi (recommended; not run in this agent pass)

| ID | Check | Status | Notes for the person who dogfoods |
| --- | --- | --- | --- |
| L1 | Closed question docks at bottom with top border | not run | `/hypagraph ask` or controller present |
| L2 | Footer (path / stats / status) remains readable | not run | Confirm margin 3 clears 2–3 line footer |
| L3 | Narrow terminal (~80×24) still usable | not run | Options and key help visible or navigable |
| L4 | Long question text wraps inside dock | not run | History above stays visible |
| L5 | Many responses (8+) under maxHeight | not run | Viewport must keep selection and key help visible |
| L6 | Open question types in bottom dock | not run | Editor row in same panel |
| L7 | Free-text follow-up after closed answer | not run | Must stay in composer zone, not center card |
| L8 | Graph pane stays side/center layout | not run | Unrelated to interaction dock |

Do not mark L1–L8 as pass without a real interactive Pi session.

## 4. Decision

1. Keep free-text and feedback on `ctx.ui.input`.
2. Keep Option A bottom overlay for the rich dialog.
3. Use raised maxHeight, footer margin 3, tui-derived row budget, and an option viewport around the selection.
4. Wave 2 **code** is complete. Wave 2 **acceptance** stays open until L1–L8 pass in a live Pi session.
