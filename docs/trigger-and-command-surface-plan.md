# Trigger and command surface plan

- Status: slices 1–3 implemented; slice H (live editor highlight) code complete — live interactive dogfood pending
- Related highlight plan: `docs/trigger-editor-highlight-plan.md` (H1–H4 code complete; live dogfood pending)
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

A user must be able to start graph-backed work without a command. A user must
also be able to control and inspect the active work with one command.

Before slices 1–3, `/hypagoal <objective>` was the only start path. A user had
to know the command before Hypagoal could help them. The skill told the model
to author a graph for any repository work, but the user surface read as an
opt-in command. Submit arming, the merged `/hypagraph` control surface, and
live editor highlight close that gap. Live highlight code is complete; live
interactive dogfood remains.

## 2. Two separate mechanisms

Keep these apart. They have different costs.

**Arming** decides whether the model may create a Hypagoal for a request. Submit
arming uses the `input` hook. Live pre-submit visibility uses the editor
highlight plan.

**Highlighting** shows the user that the draft text will arm creation. This
needs a custom editor component. It is required product surface, not an optional
later affordance. `docs/trigger-editor-highlight-plan.md` is the implementation
plan.

Build order: submit arming and command surface first (slices 1–3), then live
editor highlight (highlight plan slices H1–H4). Live highlight is required
product surface. Do not treat it as optional polish.

## 3. Arming

### 3.1 Rule

When the user message contains the trigger word, Hypagoal creation is armed for
that turn.

Arming is not forcing. The model still decides whether the request is real
repository work which needs a graph. A message which only mentions the word does
not create a goal.

### 3.2 Default trigger word

The default trigger word is `hypagoal`.

The word must be configurable, because a repository which discusses Hypagraph
itself contains the word in ordinary text. `/hypagraph trigger set <word>` sets
it. `/hypagraph trigger off` disables arming.

### 3.3 Implementation

The `input` hook receives the message text and returns `continue`, `transform`,
or `handled`. Hypagraph inspects the text and records the armed state for the
turn. It returns `continue`, so it does not change the message.

The armed state then reaches the model through the existing
`before_agent_start` system prompt block.

### 3.4 Rules

1. Arming must not create canonical state. Only `hypagoal_start` creates it.
2. Arming must not force the model to create a goal.
3. Arming lasts for one turn.
4. A trigger word inside a code block or a file path must not arm the behaviour.

Rule 4 needs a word-boundary match which ignores fenced code.

## 4. Are all graphs goals?

### 4.1 Historical state (before slice 2)

Two creation paths existed.

`hypagraph_define` created a workflow with no goal. `hypagoal_start` created a
workflow and a goal in one atomic append.

A goal supplies the budget, the continuation scheduler, the automatic revision
attempt, and the concurrency fences. A workflow with no goal therefore has no
controller. Nothing selects its next action, and no deterministic dispatch runs.

### 4.2 The decision

Every graph must be a goal.

A graph with no goal is a graph which nothing drives. It cannot use the M6A
deterministic dispatch lane, and it cannot use any orchestration in
`docs/deterministic-orchestration-plan.md`. It was the state which the M5B
controller replaced, and it survived only while the earlier tool remained.

Two creation paths also make the product harder to explain. A user asks what the
difference is between a graph and a goal. The honest answer is that one of them
does not work without the other.

### 4.3 The change (implemented)

1. Remove workflow creation from `hypagraph_define` (tool removed from the model surface).
2. Add `hypagraph_validate`. The tool validates a definition and returns the
   diagnostics. It creates no state. The authoring loop needs this, because a
   model must be able to test a definition before it commits one.
3. Keep `hypagoal_start` as the one creation path.
4. Update the tests which used `hypagraph_define` to create a workflow. They can
   use the domain reducer directly, or they can use `hypagoal_start`.

This removes one tool from the model surface and adds one which is safer.

Active product docs and the model surface must not present `hypagraph_define` as
a create path. Use `hypagraph_validate` before create and `hypagoal_start` to create.

### 4.4 Why not keep both

A sub-graph does not need a goal-free workflow. M7 goal families give a child
Hypagoal for nested work, and a child goal keeps its own budget and its own
controller. That is the correct model for nesting.

## 5. Highlighting

### 5.1 Cost

The Pi extension interface offers no text decoration. `setEditorFactory`
replaces the whole editor component, so a highlight means that Hypagraph owns
the input editor (or wraps the previous factory when Pi allows composition).

Two costs follow:

1. Hypagraph must reimplement or wrap the editor behaviour which the user expects.
2. Two extensions which both replace the editor can conflict. The last one wins
   unless a wrap pattern is available.

These costs are accepted. Live highlight is required.

### 5.2 Decision

Slices 1–3 ship submit-time arming and the status entry `Hypagoal armed`.

Live composer highlight while typing is required product surface. Status bar
alone is not the complete product signal.

Highlight code is complete per `docs/trigger-editor-highlight-plan.md` (H1–H4).
Live interactive dogfood of highlight remains.

## 6. The command surface

`/hypagraph` becomes the one control and inspection surface.

| Subcommand | Result |
| --- | --- |
| (no argument) | Show the workflow |
| `help` | Show the usage text |
| `ask [<nodeId>]` | Present an open question again |
| `status` | Show the goal status |
| `pause`, `resume`, `cancel` | Control the goal |
| `history`, `explain`, `loop` | Inspect canonical state |
| `check active`, `check cancel` | Inspect or stop a check |
| `graph` | Control the graph pane |
| `trigger set <word>`, `trigger off` | Control arming |

`/hypagoal <objective>` stays, because a user who knows the command must keep a
direct path. The trigger word gives the same result without the command.

The command must report an unknown subcommand. It must not show the workflow in
silence.

## 7. Slice sequence

| Slice | Result |
| --- | --- |
| 1 | Arming through the `input` hook, the status entry, and the trigger settings |
| 2 | `hypagraph_validate`, and the removal of workflow creation from `hypagraph_define` |
| 3 | The merged `/hypagraph` control surface |
| H | Live editor trigger highlight (see `docs/trigger-editor-highlight-plan.md`) |

Slices 1–3 are implemented. Slice H is code complete; live interactive dogfood is pending.

## 8. Acceptance criteria

- A message which contains the trigger word arms Hypagoal creation for one turn.
- A message which contains the word in a code fence does not arm it.
- Arming creates no canonical state.
- The model can decline to create a goal for an armed message.
- The status bar reports the armed state after submit.
- The composer highlights matching trigger tokens while the user types, before submit.
- Live highlight and submit arming use the same matcher.
- `hypagraph_validate` returns diagnostics and creates no state.
- One creation path exists.
- `/hypagraph` reports an unknown subcommand.

## 9. Out of scope

- a trigger which forces goal creation;
- a second keyword for graph work. Every graph is a goal, so one keyword is
  enough.

Live editor highlight is in scope and code complete. See `docs/trigger-editor-highlight-plan.md`.
