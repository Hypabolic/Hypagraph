# Interaction bottom-dock presentation plan

- Status: Wave 2 code complete — D1–D3 delivered; live interactive Pi dogfood pending
- Priority: required product UX for interaction and ask surfaces
- Applies to: `hypagraph_ask`, controller-presented interactions, `/hypagraph ask`
- Related: `docs/m6-1-interaction-node-plan.md`, `docs/post-create-graph-dock-plan.md`
- Reference UX: Pi composer and ask-user style bottom chrome (not a floating center modal)
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

An interaction question must appear at the **bottom of the terminal**, in the same zone as the normal Pi composer and status chrome.

Today the rich dialog opens as a **centered modal overlay**. That layout is wrong for this product.

The attached reference shows the Pi session with the working surface and chrome at the bottom. Hypagraph ask must match that pattern: the person answers at the bottom, while chat history remains above.

## 2. Current behaviour

`presentInteractionDialog` in `src/extension.ts` calls:

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: { width: "80%", minWidth: 48, maxHeight: "70%" },
});
```

Pi TUI defaults `OverlayOptions.anchor` to `"center"` when the anchor is omitted. The dialog therefore floats in the middle of the screen as a popup modal.

The component itself (`InteractionDialogComponent`) is layout-agnostic. It only renders lines. Placement is entirely an overlay options problem, with optional layout polish in the component.

Plain fallback hosts use `ctx.ui.select` and `ctx.ui.input`. Those hosts keep their host-default placement. This plan focuses on the interactive TUI rich path.

## 3. Product decision

### 3.1 Required layout

1. Interaction UI docks to the **bottom** of the terminal.
2. Default anchor is `bottom-center` (or equivalent full-width bottom dock).
3. Width is full terminal width, or nearly full width with a small side margin.
4. Height is content-driven, capped so chat history above remains visible.
5. The dock sits above the footer status line when the terminal shows a footer, so status and key help stay readable.
6. Closing, cancelling, or answering removes the dock and restores normal composer focus.

### 3.2 Visual target

```text
┌──────────────────────────────────────────────┐
│  chat / tool output (scrolls above)          │
│                                              │
├──────────────────────────────────────────────┤  ← interaction dock
│  Question text                               │
│  › 1. Approve (Recommended)                  │
│    2. Reject                                 │
│    3. Chat about this                        │
│  Enter · ↑/↓ · Esc                           │
├──────────────────────────────────────────────┤
│  status / model / session footer             │
└──────────────────────────────────────────────┘
```

Open questions put the typed answer row in the same bottom dock.

### 3.3 What must not change

1. Canonical wait rules (`awaiting_response` is node-local).
2. Present only when no other action is runnable.
3. Store request before presentation.
4. Dismiss leaves the wait open.
5. Answer path, facts, feedback, free text, and chat row behaviour.
6. Graph pane overlay placement (side or center) stays separate.

## 4. Pi API facts

From `@earendil-works/pi-tui` `OverlayOptions`:

| Field | Use for this plan |
| --- | --- |
| `anchor` | `"bottom-center"` for the dock |
| `width` | `"100%"` or terminal width minus side margin |
| `minWidth` | keep a sensible floor on narrow terminals |
| `maxHeight` | percentage or rows so the dock does not cover the full chat |
| `margin` | bottom margin for footer; optional left/right margin |
| `offsetY` | fine vertical nudge if footer collision appears |
| `visible` | optional hide when the terminal is too short |

`ctx.ui.custom` already supports these options. Graph pane already uses non-default anchors (`right-center`). Interaction should do the same for the bottom.

## 5. Preferred implementation

### Option A — Bottom-anchored overlay (recommended first)

Keep `ctx.ui.custom` and change options only:

```ts
{
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center",
    width: "100%",
    minWidth: 40,
    maxHeight: "40%", // or dynamic from content
    margin: { bottom: 1, left: 0, right: 0, top: 0 },
  },
}
```

Tune `maxHeight` and `margin.bottom` in dogfood so the dock sits in the composer zone without covering the footer or the whole history.

**Why first:** smallest change, reuses the existing component and focus model, matches existing graph-pane pattern of non-center anchors.

### Option B — Editor-slot presentation (optional later)

Temporarily replace the composer through `setEditorComponent` / `setEditorFactory` with an interaction editor that owns the bottom slot.

**Why later:** higher conflict cost with the trigger-highlight editor plan; more code; only needed if Option A cannot sit cleanly above the footer.

### Option C — Widget-only (rejected for answer capture)

`setWidget` can show the question above the editor, but widgets are not the full focus answer path for closed options. Do not use widget-only as the answer UI.

## 6. Component polish (same slice or immediate follow-up)

While moving placement:

1. Render a clear top border so the dock reads as a bottom panel, not a floating card with large empty margins.
2. Keep recommended response preselected.
3. Keep open-answer editor behaviour.
4. Ensure free-text and feedback follow-ups also feel bottom-local when they use `ctx.ui.input` (host-default input may already be bottom; verify in dogfood).
5. If free-text after a closed answer still opens a center modal, dock that path too when the API allows.

## 7. Implementation slices

### Slice D1. Overlay placement change

Deliver:

- bottom-center (or full-width bottom) options in `presentInteractionDialog`;
- shared options helper, for example `interactionDockOverlayOptions(tui)`, so tests and dogfood can assert the contract;
- no change to answer mapping or reducer paths.

### Slice D2. Layout dogfood and tuning

Deliver:

- interactive dogfood for closed and open questions;
- narrow terminal behaviour;
- long question text and many responses under `maxHeight`;
- confirm footer remains visible;
- screenshots or notes under dogfood evidence if useful.

### Slice D3. Tests and docs

Deliver:

- unit or extension test that the present path requests bottom dock options (mock `ui.custom` and assert `overlayOptions`);
- update M6.1 plan and product docs: interaction presents at the bottom, not as a center modal;
- skill line if it mentions a dialog popup.

### Slice D4. Follow-up only if needed

Deliver:

- Option B editor-slot presentation if Option A cannot clear the footer/composer conflict;
- integration with the trigger editor factory so both can coexist.

## 8. Acceptance criteria

1. In interactive Pi TUI, `/hypagraph ask` or controller presentation shows the question at the **bottom**, not centered as a modal card.
2. Chat history remains visible above the dock.
3. Keyboard selection and open-answer typing still work.
4. Esc cancel leaves `awaiting_response`.
5. Selecting a response still publishes declared facts through the existing path.
6. Headless and plain-select hosts still work without the rich dock.
7. Graph pane overlay placement is unchanged.
8. A test asserts the dock overlay options (anchor bottom, full width or equivalent).

## 9. Non-goals

1. Redesigning response semantics or fact publication.
2. Changing when a dialog is allowed to open.
3. Moving the graph pane to the bottom.
4. Requiring rainbow trigger highlight for this change (separate plan).
5. Pixel-perfect clone of a third-party ask-user extension skin beyond bottom placement and clear dock chrome.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Footer collision | `margin.bottom` and dogfood on real Pi footer height |
| Dock covers too much chat | Cap `maxHeight`; scroll internal content if the component grows |
| Free-text follow-up still centers | Verify host `input`; dock second step if needed |
| Conflict with future custom editor | Keep Option A first; coordinate with trigger-editor plan in D4 |

## 11. Immediate next work

1. Accept this plan.
2. Implement Slice D1 (change overlay options and extract helper).
3. Dogfood in interactive Pi against the bottom composer zone.
4. Add the assertion test and doc updates in D3.

## 12. Code touch points

| File | Change |
| --- | --- |
| `src/extension.ts` | `presentInteractionDialog` overlay options |
| `src/pi/interaction-dialog.ts` | optional border/chrome polish |
| `src/ui/` or `src/pi/` new small helper | `interactionDockOverlayOptions` |
| tests for interaction presentation | assert options |
| `docs/m6-1-interaction-node-plan.md` | record bottom-dock requirement |
