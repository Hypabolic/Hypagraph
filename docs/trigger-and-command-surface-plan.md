# Trigger and command surface plan

- Status: proposed
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

A user must be able to start graph-backed work without a command. A user must
also be able to control and inspect the active work with one command.

Today `/hypagoal <objective>` is the only start path. A user must know the
command before Hypagoal can help them. The skill tells the model to author a
graph for any repository work, but the user surface still reads as an opt-in
command.

## 2. Two separate mechanisms

Keep these apart. They have different costs.

**Arming** decides whether the model may create a Hypagoal for a request. This
needs the `input` hook only, and it is cheap.

**Highlighting** shows the user that a word in their message armed the
behaviour. This needs a custom editor component, and it is not cheap. Section 5
states the cost.

Arming delivers the product result. Highlighting delivers the affordance. Build
arming first.

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

### 4.1 The current state

Two creation paths exist.

`hypagraph_define` creates a workflow with no goal. `hypagoal_start` creates a
workflow and a goal in one atomic append.

A goal supplies the budget, the continuation scheduler, the automatic revision
attempt, and the concurrency fences. A workflow with no goal therefore has no
controller. Nothing selects its next action, and no deterministic dispatch runs.

### 4.2 The decision

Every graph must be a goal.

A graph with no goal is a graph which nothing drives. It cannot use the M6A
deterministic dispatch lane, and it cannot use any orchestration in
`docs/deterministic-orchestration-plan.md`. It is the state which the M5B
controller replaced, and it survives only because the earlier tool remains.

Two creation paths also make the product harder to explain. A user asks what the
difference is between a graph and a goal. The honest answer is that one of them
does not work without the other.

### 4.3 The change

1. Remove workflow creation from `hypagraph_define`.
2. Add `hypagraph_validate`. The tool validates a definition and returns the
   diagnostics. It creates no state. The authoring loop needs this, because a
   model must be able to test a definition before it commits one.
3. Keep `hypagoal_start` as the one creation path.
4. Update the tests which use `hypagraph_define` to create a workflow. They can
   use the domain reducer directly, or they can use `hypagoal_start`.

This removes one tool from the model surface and adds one which is safer.

### 4.4 Why not keep both

A sub-graph does not need a goal-free workflow. M7 goal families give a child
Hypagoal for nested work, and a child goal keeps its own budget and its own
controller. That is the correct model for nesting.

## 5. Highlighting

### 5.1 Cost

The Pi extension interface offers no text decoration. `setEditorFactory`
replaces the whole editor component, so a highlight means that Hypagraph owns
the input editor.

Two costs follow:

1. Hypagraph must reimplement the editor behaviour which the user expects.
2. Two extensions which both replace the editor conflict. The last one wins.

### 5.2 Decision

Do not replace the editor in the first slice.

Report the armed state in the status bar instead. `ctx.ui.setStatus` already
exists, and Hypagraph already uses it. A status entry which reads
`Hypagoal armed` gives the user the same information with none of the cost.

Reconsider the editor only when a user reports that the status entry is not
enough.

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

## 8. Acceptance criteria

- A message which contains the trigger word arms Hypagoal creation for one turn.
- A message which contains the word in a code fence does not arm it.
- Arming creates no canonical state.
- The model can decline to create a goal for an armed message.
- The status bar reports the armed state.
- `hypagraph_validate` returns diagnostics and creates no state.
- One creation path exists.
- `/hypagraph` reports an unknown subcommand.

## 9. Out of scope

- a replacement input editor;
- a trigger which forces goal creation;
- a second keyword for graph work. Every graph is a goal, so one keyword is
  enough.
