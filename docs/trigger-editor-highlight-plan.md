# Trigger editor highlight plan

- Status: code complete (H1–H4); live interactive dogfood pending
- Priority: required product surface (not an optional later affordance)
- Depends on: `docs/trigger-and-command-surface-plan.md` slices 1–3 (arming, validate, command merge)
- Reference UX: keyword arming in pi-dynamic-workflows; live token highlight in the Pi composer
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Hypagoal arming must be visible **while the user types**, not only after submit.

The status bar entry `Hypagoal armed` remains useful after submit. It is not enough as the only signal. The user must see the configured trigger word light up in the composer as soon as the draft text would arm creation.

This visibility is part of the start surface. It is not a polish item.

## 2. Product decision

### 2.1 Required behaviour

1. While the user edits the Pi input composer, Hypagraph evaluates the draft text with the same arming rules as submit.
2. When the draft would arm, each matching trigger token in the composer is highlighted (rainbow or multi-colour cycle is the target visual).
3. When the draft would not arm, no highlight remains.
4. Highlight updates on every editor change, not only on submit.
5. Status bar still reports `Hypagoal armed` after the `input` hook accepts a matching user message.
6. Highlight and arming use one pure matcher. They must not diverge.

### 2.2 What highlight is not

1. Highlight does not create a goal.
2. Highlight does not force `hypagoal_start`.
3. Highlight does not rewrite the message.
4. Highlight is not required in headless or RPC hosts that have no TUI composer.

### 2.3 Relation to arming

| Stage | Mechanism | User signal |
| --- | --- | --- |
| Typing in composer | Live editor evaluation | Token highlight |
| Submit (`input` hook) | Durable one-turn arm state | Status `Hypagoal armed` + system prompt block |
| Agent end | Clear arm state | Status and turn arming clear |

Live highlight is the **pre-submit** signal. Status arming is the **accepted-turn** signal. Both are required in interactive TUI use.

## 3. Why this needs a custom editor

Pi does not provide a public API that decorates substrings inside the default composer.

`setEditorFactory` replaces the input editor component. Highlight therefore means Hypagraph owns the composer for interactive sessions, or cooperates with a shared editor factory if Pi later supports composition.

This cost is accepted. The product requires the signal.

## 4. Constraints

1. **Same matcher as submit**  
   Reuse `messageArmsHypagoal` and the same token rules from `src/pi/hypagoal-arming.ts` (fences, inline code, path-like tokens, whole-token match, case-insensitive).

2. **No domain side effects**  
   Editor paint must not write events, create drafts, or change goal state.

3. **Headless safety**  
   If the host has no editor factory, no custom UI, or is RPC-only, skip registration and keep submit-time arming only.

4. **Performance**  
   Evaluation on each keystroke must stay cheap. Matching is pure string work on the draft buffer. Do not parse the full repository or hit disk.

5. **Accessibility**  
   Colour is not the only cue. Prefer also a subtle non-colour cue when the terminal supports it (for example bold, underline, or a fixed “armed” marker near the token). Document that colour alone may fail on monochrome terminals.

6. **Extension conflict**  
   Only one `setEditorFactory` wins if Pi does not compose factories. Document the conflict. Prefer a cooperative factory pattern if the installed Pi version supports wrapping a previous factory.

## 5. Visual specification

### 5.1 Target look

- Matching trigger tokens in the draft receive a multi-colour (rainbow) foreground cycle or an equivalent high-attention palette.
- Non-matching text keeps the default editor style.
- Multiple matches in one draft all highlight.
- Partial typing of the word does not highlight until the token is a full match under the arming rules.

### 5.2 Theme rules

1. Prefer terminal theme-aware colours when Pi exposes them.
2. Fall back to a fixed high-contrast palette when theme colours are unavailable.
3. Do not rely on background colour alone if foreground colour is available.

### 5.3 Disabled and off states

| Condition | Highlight |
| --- | --- |
| Trigger off (`word === null`) | Never |
| Word present but only inside fence or path | Never |
| Word matches | Yes on those tokens |
| User is in a non-composer UI (dialog input, select) | No Hypagoal composer highlight |

## 6. Architecture

### 6.1 Pure layer (domain-adjacent, no I/O)

Extend or reuse `src/pi/hypagoal-arming.ts`:

```ts
export interface TriggerMatchSpan {
  start: number; // inclusive UTF-16 or code-unit index matching the editor buffer
  end: number;   // exclusive
  text: string;
}

/** Return all highlightable spans for the current draft and settings. */
export function findHypagoalTriggerSpans(
  text: string,
  settings: HypagoalTriggerSettings,
): TriggerMatchSpan[];
```

Rules:

- `findHypagoalTriggerSpans` returns a non-empty list if and only if `messageArmsHypagoal(text, settings)` is true, for every span that contributes to arming.
- Indices must match the editor buffer coordinate system. Document and test that system (UTF-16 code units vs code points) against the component Pi uses.
- Keep strip-fence and path rules identical to submit arming.

### 6.2 Editor component (host / UI)

New module, for example `src/ui/hypagoal-trigger-editor.ts` or `src/pi/hypagoal-trigger-editor.ts`:

- Registers through `pi.setEditorFactory` when the API and TUI are available.
- Wraps or reimplements the default composer behaviour the user expects:
  - multi-line edit;
  - cursor movement;
  - submit key binding consistent with Pi;
  - paste;
  - history if the default editor exposes it.
- On each content change, compute spans and repaint highlighted regions.
- Does not call `hypagoal_start` or mutate canonical state.

Prefer **wrapping** the stock editor factory when Pi exposes the previous factory to the custom factory. If wrap is impossible, implement a minimal compatible editor and document behavioural differences in dogfood.

### 6.3 Extension wiring

In `src/extension.ts`:

1. Keep existing submit-time `input` arming and status paint.
2. On session start (interactive TUI only), register the editor factory with current trigger settings.
3. When `/hypagraph trigger set|off` changes settings, refresh the editor so live highlight uses the new word without reload when possible.
4. On session shutdown, clear factory ownership if the API requires it.

### 6.4 Settings

Live highlight uses the same in-session (and later durable) trigger settings as arming:

- default word `hypagoal`;
- `/hypagraph trigger set <word>`;
- `/hypagraph trigger off`.

Optional later setting (not required for first implementation):

- `highlight: "rainbow" | "solid" | "off"` for users who want arming without colour.

Default highlight mode is on whenever arming is on.

## 7. Pi API discovery (implementation prerequisite)

Before coding the component, record the installed Pi API surface in a short discovery note under `docs/scratch/` or in the PR description:

1. Exact `setEditorFactory` signature and component contract.
2. Whether factories compose or last-writer-wins.
3. Buffer encoding and change events.
4. Default submit keys and multiline behaviour.
5. Minimum Pi version required.

If the installed Pi version cannot support live decoration at all, block the slice and document the version gap. Do not ship a fake highlight that only paints after submit.

## 8. Implementation slices

### Slice H1. Shared match spans

Deliver:

- `findHypagoalTriggerSpans` in pure code;
- property-style unit tests that spans empty iff `messageArmsHypagoal` is false;
- tests for fences, inline code, paths, punctuation, multiple matches, custom words, off state.

No UI yet.

### Slice H2. Editor factory prototype

Deliver:

- interactive-only registration;
- live repaint of matching tokens;
- headless / missing-API no-op;
- manual dogfood checklist for type, paste, multiline, submit.

### Slice H3. Behaviour parity with stock composer

Deliver:

- submit and newline behaviour match default Pi for the supported version;
- paste and cursor movement do not drop text;
- trigger set/off updates highlight without session restart when possible;
- conflict documentation when another extension owns the editor.

### Slice H4. Product integration and docs

Deliver:

- README and skill mention live highlight as part of arming;
- `/hypagraph trigger` help notes that the word highlights in the composer;
- dogfood evidence with screenshots or terminal recordings where practical;
- plan status moves to implemented when H1–H3 pass.

## 9. Acceptance criteria

1. With default settings, typing a standalone token `hypagoal` in the Pi composer highlights that token **before** submit.
2. Typing `hypagoal` only inside a fenced code block does not highlight and does not arm on submit.
3. Typing `src/hypagoal-editor.ts` does not highlight the path token.
4. Changing the word with `/hypagraph trigger set work` makes `work` highlight and stops `hypagoal` from highlighting.
5. `/hypagraph trigger off` removes live highlight.
6. Submit of a matching message still sets status `Hypagoal armed` and still creates no goal by itself.
7. Headless or RPC runs do not crash when no editor factory exists.
8. Pure span finder tests pass without a TUI.
9. Live highlight and submit arming never disagree on the same text and settings.

## 10. Non-goals for this plan

1. Forcing goal creation when the word appears.
2. Owning non-composer editors (dialogs, file editors).
3. Multi-extension highlight composition beyond what Pi supports.
4. Rainbow UI for nodes inside the graph pane (different surface).
5. Changing isolated worker-session execution (separate plan).

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Last-writer editor conflict | Document; try wrap pattern; dogfood with common extensions |
| Incomplete stock editor reimplementation | Prefer wrap; keep H3 acceptance strict |
| UTF index mismatch | Lock buffer encoding in H1 tests against real component |
| Performance on large pastes | Cap paint to visible region if needed; matcher stays O(n) |
| User expects rainbow but runs monochrome terminal | Secondary style cue + status bar |

## 12. Relation to other plans

| Plan | Relation |
| --- | --- |
| `docs/trigger-and-command-surface-plan.md` | Slices 1–3 ship arming and commands. This plan is slice **H** (highlight) and is now required, not out of scope. |
| `docs/authoring-tools-and-project-store-plan.md` | Independent. Constructor authoring does not replace highlight. |
| `docs/isolated-model-session-execution-plan.md` | Independent. Highlight is orchestrator composer UX only. |

## 13. Implementation status (Wave 5)

| Slice | Status | Notes |
| --- | --- | --- |
| H1 / S5.1 | done | `findHypagoalTriggerSpans`; `messageArmsHypagoal` delegates to spans |
| H2 / S5.2 | done | `registerHypagoalTriggerEditor` wraps previous factory or `CustomEditor`; headless no-op |
| H3 / S5.3 | partial | Stock editor parity via wrap of `render` only; trigger set/off calls `requestRender`; full live dogfood of paste/multiline/submit not run here |
| H4 / S5.4 | done | README, skill, `/hypagraph` help note live highlight |
| S5.0 | done | `docs/scratch/pi-editor-factory-discovery.md` |

### Remaining

1. Live dogfood in interactive Pi: type `hypagoal`, paste, multiline, trigger set/off.
2. Mark this plan fully implemented after dogfood accepts H3.
