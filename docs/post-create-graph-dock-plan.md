# Post-create graph dock plan

- Status: G1–G5 implemented (Waves 3–4)
- Priority: required product UX after Hypagoal creation
- Applies to: successful `hypagoal_start` and root replacement create in interactive TUI
- Renderer: [grok-mermaid](https://github.com/xl0/grok-mermaid) (`npm` package `grok-mermaid`, Apache-2.0)
- Related: `docs/interaction-bottom-dock-plan.md`, `docs/pi-graph-visualisation-plan.md`, `docs/trigger-editor-highlight-plan.md`
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

When a Hypagoal is created, the user must see the new graph at the **bottom** of the terminal and must choose one of three actions before autonomous work continues:

1. **Run** — start controller execution for the created goal.
2. **Question** — ask about the graph without starting execution.
3. **Cancel** — cancel the created goal and leave no active run.

The diagram must be drawn with **grok-mermaid**: Mermaid source projected from canonical graph view, rendered as Unicode box-drawing art for the terminal.

This surface is a human gate after authoring. It is not the live side graph pane, and it is not an interaction node inside the workflow.

## 2. Problem

Today a successful `hypagoal_start`:

1. returns `renderHypagoalCreated` text to the model;
2. ends the authoring turn;
3. can allow `agent_end` to queue the first model-lane or deterministic continuation without an explicit human confirmation in the TUI.

The user does not get a clear bottom-of-screen review of the compiled graph with Run / Question / Cancel.

The live graph pane is a separate side overlay for ongoing inspection. It is not a post-create confirmation dock.

## 3. Product decision

### 3.1 When the dock appears

Show the post-create dock when **all** of these are true:

1. interactive TUI host (`runMode` supports `ui.custom`);
2. `hypagoal_start` (or root replacement create) just succeeded;
3. a root goal is active and ready for first continuation;
4. the host has not already suppressed auto-start for this create operation.

Do not show the dock:

- on validate-only paths;
- on rejected create;
- on headless or RPC hosts that cannot present a bottom dock (use text summary + no auto-start, or plain select if available);
- when the user later opens `/hypagraph graph` (that remains the live pane).

### 3.2 Layout

Dock at the bottom, same zone as the interaction bottom-dock plan:

```text
┌──────────────────────────────────────────────┐
│  chat / tool results (above)                 │
├──────────────────────────────────────────────┤
│  Hypagoal created · <title>                  │
│  <grok-mermaid unicode diagram>              │
│  Ready: …  Loops: …  Budget: …               │
│                                              │
│  › 1. Run (Recommended)                      │
│    2. Question                               │
│    3. Cancel                                 │
│  Enter · ↑/↓ · Esc = Cancel                  │
├──────────────────────────────────────────────┤
│  status footer                               │
└──────────────────────────────────────────────┘
```

Use `ctx.ui.custom` with bottom-center full-width overlay options (shared helper with the interaction dock plan when that lands).

### 3.3 Actions

| Action | Result |
| --- | --- |
| **Run** | Close the dock. Allow the controller to select and dispatch the next action (`queueGoalContinuation` or the deterministic lane path). This is the only path that starts autonomous work after create. |
| **Question** | Close the dock. Do **not** start autonomous work. Keep the goal durable and active (or paused with an explicit resume policy — see open decisions). Focus returns to the composer so the user can type a question. Optionally inject a short system note that the graph is created and waiting for a user question before Run. |
| **Cancel** | Close the dock. Cancel the root goal with an explicit user reason. Canonical state records cancellation. No autonomous work runs. |

Esc maps to **Cancel** only if product dogfood confirms that is safe. Preferred default: Esc maps to **Question** (dismiss without destroy) or is disabled with an explicit Cancel row only. **Recommended decision:** Esc dismisses like Question (no destroy); Cancel requires the Cancel row. Record the final choice in implementation.

### 3.4 Auto-continue gate

After create, interactive TUI must **not** auto-queue continuation until Run is chosen.

Today `agent_end` may call `queueGoalContinuation`. Change:

1. On successful create in TUI, set a host flag `postCreateAwaitingUserChoice = true` for this goal/session.
2. `queueGoalContinuation` no-ops while that flag is set.
3. Run clears the flag and then queues.
4. Question leaves the flag set (or sets `postCreateDeferred = true`) so later Run is still required unless product chooses resume-from-status later.
5. Cancel clears the flag after cancel succeeds.

Headless hosts may keep auto-continue or require an explicit CLI flag. Recommended default for headless: auto-continue after create (no dock). Document the difference.

## 4. Diagram pipeline

### 4.1 Dependency

Add production dependency:

```text
grok-mermaid
```

Source: https://github.com/xl0/grok-mermaid  
License: Apache-2.0 (compatible with package use; keep NOTICE attribution as required).

Use the public API:

```ts
import { render, toAnsi, sourceBox, diagramKind } from "grok-mermaid";
```

### 4.2 Canonical path

```text
HypagraphState
  -> projectGraphView(state)
  -> projectMermaidFlowchart(view, options)
  -> grok-mermaid render(source)
  -> plain or themed ANSI lines for the dock
```

The Mermaid source is a **view projection**. It is not canonical state. It must not be stored as authority. Optional: store the last Mermaid string in tool details for the model; never use it for restore.

### 4.3 Mermaid projection rules

Produce `flowchart` / `graph` source that grok-mermaid supports well.

Recommended defaults:

1. Direction `TD` for tall graphs, `LR` when node count is small and width budget allows.
2. One node per graph view node. Label = short title or id; escape Mermaid-special characters.
3. Edges:
   - dependency: `A --> B`
   - selected route: solid with label `true` / `false` when present
   - skipped route: dotted or labeled `skipped` if supported; otherwise omit from compact mode
   - feedback: labeled `feedback` or use a distinct link style when supported
4. Loop regions: optional `subgraph` per loop when the loop has more than one node.
5. Status is not required in the first Mermaid labels if it makes the diagram too wide. A one-line summary under the art can list ready nodes.
6. Bound node count and label length so art fits typical terminals. If `art.width` exceeds terminal columns, fall back to:
   - `sourceBox(mermaid, cols)`, or
   - a compact text topology from existing `renderWorkflow` / graph summary.

### 4.4 Theme

Map grok-mermaid `Cls` spans through Pi theme colours when available (`border`, `text`, `edge`, `edgeLabel`). Fall back to `toAnsi` defaults.

Rendering is host UI only. The pure Mermaid string builder must not depend on ANSI.

### 4.5 Pure module boundary

| Module | Responsibility |
| --- | --- |
| `src/graph/mermaid-projection.ts` | Pure: `GraphViewModel` → Mermaid string + diagnostics |
| `src/ui/mermaid-render.ts` or `src/pi/mermaid-art.ts` | Host: call `grok-mermaid`, fit width, theme |
| `src/pi/post-create-dock.ts` | Host: bottom dock component + actions |
| `src/extension.ts` | Wire create success → present dock → gate auto-continue |

Domain reducer stays pure and does not import `grok-mermaid`.

## 5. Component behaviour

### 5.1 Content

1. Title line: objective or definition title.
2. Diagram art (scroll or clip with max height).
3. Compact metadata: workflow id short form optional, ready tasks/checks, loop count, budgets if set.
4. Three action rows: Run (recommended), Question, Cancel.
5. Key help line.

### 5.2 Diagram overflow

If art height exceeds dock max height:

1. Show a window of lines from the top of the art with a muted “diagram truncated” note, or
2. Provide simple `j`/`k` scroll inside the dock.

First slice may truncate with a note. Scroll is a follow-up if dogfood requires it.

### 5.3 Concurrent UI

While the post-create dock is open:

1. Do not open the live graph side pane automatically.
2. Do not open interaction dialogs for the same turn.
3. Status may still show the active goal.

## 6. Model-facing behaviour

After create, the tool result text may still include `renderHypagoalCreated` for the model transcript.

In interactive TUI:

1. Present the dock to the **user** (not as model tool chrome only).
2. Prefer presenting the dock after the tool returns and before the next autonomous continuation, from the extension create path or `agent_end` when `postCreateAwaitingUserChoice` is set.
3. The model must not call task tools for this goal until Run, unless the user later starts work another way (`/hypagraph resume` if product maps resume to Run).

Skill and authoring prompt updates:

1. After `hypagoal_start` succeeds, wait for the user decision when the host presents the dock.
2. Do not start repository work until the user chooses Run or an explicit resume path.

## 7. Relation to other surfaces

| Surface | Role after this plan |
| --- | --- |
| Post-create dock | One-shot human gate with Mermaid art + Run / Question / Cancel |
| Live graph pane (`/hypagraph graph`) | Ongoing inspection; may later also use Mermaid art, but side/right layout can remain |
| Widget | Compact summary when no dock is open |
| Interaction bottom dock | In-graph questions during execution |
| Trigger highlight | Composer typing UX; independent |

Later optional work: reuse Mermaid projection inside the live graph pane. Not required to close this plan.

## 8. Implementation slices

### Slice G1. Mermaid projection (pure) — done

Deliver:

- `projectMermaidFlowchart(view, options)` from `projectGraphView`;
- unit tests for linear, gate-branch, and loop graphs;
- character escaping and empty-graph behaviour;
- no `grok-mermaid` import in pure module.

### Slice G2. grok-mermaid integration — done

Deliver:

- add dependency `grok-mermaid`;
- host helper: render, theme, width fit, fallback to source box or text summary;
- unit tests with fixed Mermaid fixtures (assert non-empty art for simple flowchart).

### Slice G3. Post-create bottom dock component — done

Deliver:

- dock UI with diagram + Run / Question / Cancel;
- bottom-center overlay options (share with interaction dock helper when available);
- keyboard selection and recommended Run.

### Slice G4. Create-path gate — done

Deliver:

- after successful interactive create, set awaiting-user-choice flag;
- suppress `queueGoalContinuation` until Run;
- Run / Question / Cancel host behaviours;
- tests for flag gating and cancel path;
- headless auto-continue documented and tested.

### Slice G5. Docs and skill — done

Deliver:

- README / skill: after create, user reviews the graph and chooses Run, Question, or Cancel;
- dogfood note or evidence for the dock;
- NOTICE / license attribution for grok-mermaid as required.

## 9. Acceptance criteria

1. After a successful interactive `/hypagoal` create, a bottom dock shows a Unicode diagram of the created graph.
2. The diagram is produced by projecting Mermaid from the graph view and rendering with `grok-mermaid`.
3. The dock offers **Run**, **Question**, and **Cancel**.
4. No autonomous continuation starts until **Run** (interactive TUI).
5. **Question** returns to the composer without starting work and without cancelling the goal (unless open decision chooses pause).
6. **Cancel** cancels the goal and starts no work.
7. When the diagram is wider than the terminal, the UI falls back without crashing.
8. Pure Mermaid projection tests do not load terminal or Pi UI.
9. Domain reducer does not depend on `grok-mermaid`.
10. Headless create still succeeds without requiring a dock.

## 10. Non-goals

1. Pixel-perfect browser Mermaid or SVG in Pi.
2. Replacing the live graph pane in this plan.
3. Editing the graph from the dock (no drag nodes).
4. Multi-goal family diagram in the first slice (root workflow only).
5. Streaming partial Mermaid during authoring (optional later).

## 11. Open decisions

Record answers before G4.

1. After **Question**, is the goal left `active` with auto-continue suppressed, or `paused` until `/hypagraph resume` / Run?  
   **Recommended:** active + suppress auto-continue until Run or explicit resume mapped to Run.
2. Does Esc mean Cancel or Question?  
   **Recommended:** Esc = Question (safe dismiss); Cancel is explicit.
3. Should replacement create also show the dock?  
   **Recommended:** yes.
4. Should the model transcript include the Mermaid source, the ASCII art, both, or neither?  
   **Recommended:** short created summary + Mermaid source in details; art is TUI-only to save tokens.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Large graphs overflow the dock | Truncate art, cap labels, fallback summary |
| grok-mermaid null for unsupported shapes | Prefer flowchart subset; test fixtures; fallback text |
| Auto-continue race on agent_end | Single host flag checked before every queue |
| Dependency size / license | Apache-2.0 npm package; pin version; NOTICE |
| Conflict with other bottom docks | One focused custom UI at a time; post-create before interactions |

## 13. Immediate next work

G1–G5 are implemented. Open decisions follow the recommended defaults:

1. After Question: goal stays active; auto-continue stays suppressed until Run or `/hypagraph resume`.
2. Esc maps to Question (safe dismiss); Cancel is explicit.
3. Replacement create shows the dock.
4. Model transcript: created summary + Mermaid source in details; art is TUI-only.

Optional follow-up: reuse Mermaid art in the live graph pane; dogfood evidence under `docs/dogfood-evidence/`.

## 14. Code touch points

| Area | Path |
| --- | --- |
| Mermaid projection | `src/graph/mermaid-projection.ts` |
| Art render helper | `src/ui/mermaid-art.ts` or `src/pi/mermaid-art.ts` |
| Dock component | `src/pi/post-create-dock.ts` |
| Create + gate | `src/extension.ts` (`hypagoal_start`, `queueGoalContinuation`) |
| Tests | `tests/mermaid-projection.test.ts`, dock/gate extension tests |
| Dependency | `package.json` → `grok-mermaid` |
