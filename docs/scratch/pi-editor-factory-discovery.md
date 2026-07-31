# Pi editor factory discovery (Wave 5 / S5.0)

- Package: `@earendil-works/pi-coding-agent` **0.80.10**
- Companion: `@earendil-works/pi-tui` **0.80.10**
- Date: 2026-07-31
- Writing standard: ASD-STE100 Simplified Technical English

## 1. API name

The installed API is **`setEditorComponent` / `getEditorComponent`**, not `setEditorFactory`.

The plan text used `setEditorFactory` as a conceptual name. The real types live on `ExtensionUIContext`:

```ts
type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

setEditorComponent(factory: EditorFactory | undefined): void;
getEditorComponent(): EditorFactory | undefined;
```

Pass `undefined` to restore the default stock editor.

## 2. Component contract

1. The factory must return an `EditorComponent` (`getText`, `setText`, `handleInput`, `render`, optional `onSubmit` / `onChange`).
2. For full app keybindings (escape, Ctrl+D, model switch, shortcuts), extend `CustomEditor` from `@earendil-works/pi-coding-agent` and call `super.handleInput` for keys you do not handle.
3. Interactive mode wires `onSubmit`, `onChange`, text, padding, autocomplete, and `CustomEditor` action handlers after the factory returns (`interactive-mode.setCustomEditorComponent`).
4. Reference example: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/rainbow-editor.ts`.

## 3. Composition: wrap vs last-writer

| Mode | Behaviour |
| --- | --- |
| **Last-writer** | `setEditorComponent` stores one factory. A later call replaces the previous factory. |
| **getEditorComponent** | Returns the currently configured custom factory, or `undefined` for the stock editor. |
| **RPC / non-TUI** | `setEditorComponent` is a no-op. `getEditorComponent` returns `undefined`. |

Pi does not compose factories automatically. Hypagraph must:

1. Call `getEditorComponent()` before `setEditorComponent`.
2. Wrap that previous factory when it exists so render decoration stacks.
3. Document that another extension which sets the factory later without wrapping will remove Hypagraph highlight.

## 4. Buffer encoding and indices

| Item | Value |
| --- | --- |
| Buffer source | `Editor.getText()` → `state.lines.join("\n")` |
| Encoding | JavaScript string (UTF-16 code units) |
| Index system | Inclusive start / exclusive end via `String.prototype.slice` |
| Newlines | `\n` between lines; one `\n` per line break in the joined string |
| Pastes | Large pastes may use markers such as `[paste #1 +N lines]`. `getText()` keeps the marker. `getExpandedText()` expands markers to full paste content (same expansion submit uses). |
| Highlight evaluation | Live highlight evaluates `getExpandedText()` when present, otherwise `getText()`. |
| Collapsed-paste signal | When expanded text arms and the collapsed display has no visible span, Hypagraph colours the paste marker in the composer so the pre-submit signal remains visible. |
| Paint mapping | Paint applies only exact ranges from `findHypagoalTriggerSpans`. It does not re-match each rendered line with a separate regular expression. |

`findHypagoalTriggerSpans` uses UTF-16 code-unit indices so they match the editor buffer coordinate system.

## 5. Default submit and multiline behaviour

Stock `CustomEditor` / `Editor` behaviour (unchanged when Hypagraph only wraps `render`):

1. Enter submits when the stock keybinding says so (app submit path on `onSubmit`).
2. Multiline edit, cursor movement, paste, history, and autocomplete stay on the base editor.
3. Hypagraph paint runs only in `render` after `super.render` / the wrapped factory `render`. Paint does not rewrite buffer text.

## 6. Minimum Pi version

Live highlight needs:

- `ExtensionUIContext.setEditorComponent`
- `ExtensionUIContext.getEditorComponent` (for cooperative wrap)
- `CustomEditor` export from `@earendil-works/pi-coding-agent`

Verified on **0.80.10**. RPC and print modes keep submit-time arming only.

## 7. Hypagraph registration policy

1. Register only when `hasUI === true`, `mode === "tui"`, and `setEditorComponent` is a function.
2. Prefer wrap of the previous factory.
3. On `/hypagraph trigger set|off`, call `requestRender` on the active TUI so highlight updates without session reload.
4. On session shutdown, restore the previous factory when Hypagraph still owns the slot.
5. Headless / missing API: no-op. Do not throw.
