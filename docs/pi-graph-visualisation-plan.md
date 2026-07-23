# Pi graph visualisation plan

- Status: planned
- Milestone: M3 completion foundation and M5 debugger expansion
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This plan defines a dedicated graph pane for Hypagraph in Pi.

The pane shows:

- workflow nodes;
- directed dependency edges;
- selected gate routes;
- skipped routes;
- loop regions;
- independent top-level graph components;
- loop feedback edges;
- node state;
- the ready frontier;
- the active attempt;
- check execution state.

The pane is a view of canonical state. It does not own workflow state.

## 2. Pi research result

Pi extensions can add:

- text widgets above or below the editor;
- full custom TUI components;
- overlays with an anchor, width, height, margin, and responsive visibility;
- keyboard input for focused custom components;
- programmatic overlay focus and visibility control;
- explicit redraw requests.

Pi does not provide a native extension API that permanently divides the main screen into docked panes.

Hypagraph must not fork Pi to add this function.

Use an extension-owned overlay as the dedicated pane:

```text
+--------------------------------------+---------------------------+
| Pi messages and tool results         | Hypagraph graph           |
|                                      |                           |
|                                      |  [plan] ---> [code]       |
|                                      |                |          |
|                                      |                v          |
|                                      |             [tests]       |
|                                      |              /    \       |
|                                      |             v      v      |
|                                      |          [fix]   [docs]    |
+--------------------------------------+---------------------------+
| editor                                                           |
+------------------------------------------------------------------+
```

The pane uses a right-side overlay on wide terminals. It uses a full-screen custom component on narrow terminals.

The compact widget remains available when the pane is closed.

## 3. Product decision

Bring the read-only live graph pane forward from M5 into the M3 completion phase.

Do not bring the full debugger forward.

M3 provides:

- a live graph pane;
- node and edge state;
- loop visualisation;
- selection and inspection;
- responsive layout;
- stable redraw after events.

M5 adds:

- event timeline navigation;
- replay position;
- revision comparison;
- historical attempts;
- debugger actions;
- advanced filtering.

This split gives the user a graph-native product before the debugger milestone.

## 4. Architecture

Use four independent layers:

```text
HypagraphState and DomainEvent[]
              |
              v
      GraphViewProjection
              |
              v
        GraphLayoutEngine
              |
              v
        TerminalGraphScene
              |
              v
        PiGraphPaneComponent
```

### 4.1 Graph view projection

Add a pure transport-independent projection.

```ts
interface GraphViewModel {
  workflowId: string;
  revision: number;
  sequence: number;
  phase: WorkflowPhase;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  components: GraphViewComponent[];
  readyNodeIds: string[];
  activeNodeId?: string;
}
```

A graph node includes:

- node ID;
- title;
- node kind;
- runtime state;
- attempt count;
- current attempt ID;
- selected state;
- active state;
- check result summary;
- fact count;
- evidence count;
- loop membership.

A graph edge includes:

- source node ID;
- target node ID;
- edge kind;
- selected state;
- skipped state;
- feedback state;
- route outcome when applicable.

A graph loop includes:

- loop ID;
- member node IDs;
- entry node ID;
- evaluation node ID;
- feedback edges;
- maximum iteration count;
- current iteration when M4 provides it;
- failure policy when M4 provides it;
- graph-component ID;
- local outcome and workflow effect.

The projection must have no Pi imports.

The same state and events must produce the same view model.

### 4.2 Layout engine

The layout engine consumes only `GraphViewModel`.

Use a layered directed layout.

Process loop regions and graph components before normal layout:

1. Find strongly connected components.
2. Match declared loop regions.
3. Collapse each loop to one compound layout node.
4. Find weakly connected top-level graph components in the condensation graph.
5. Layout each component from left to right.
6. Place disconnected components with stable spacing and ordering.
7. Expand each loop region.
8. Route feedback edges on a separate lane.
9. Preserve stable positions when the graph revision changes.

Use stable node ID ordering for all tie decisions.

The first implementation should use a small internal layered layout because the terminal renderer needs integer rows and columns, orthogonal edges, stable ordering, and explicit loop lanes.

Keep the layout behind an interface:

```ts
interface GraphLayoutEngine {
  layout(input: GraphViewModel, options: GraphLayoutOptions): GraphLayout;
}
```

This interface permits a later Dagre or ELK adapter. Dagre provides directed layered layout and edge control points. ELK provides compound graph and layered layout functions. Do not make either library part of the domain model.

### 4.3 Terminal scene

Convert layout coordinates to terminal cells.

A scene contains:

- node rectangles;
- text labels;
- edge segments;
- arrow heads;
- loop borders;
- status markers;
- selection markers;
- a viewport.

Use orthogonal edges. Do not use diagonal line characters.

Use Unicode box-drawing characters when the terminal supports them. Provide an ASCII fallback.

The renderer must ensure that no rendered line is wider than the supplied component width.

### 4.4 Pi pane component

Implement `PiGraphPaneComponent` with the Pi TUI `Component` interface.

The component must implement:

- `render(width)`;
- `handleInput(data)`;
- `invalidate()`.

The component stores only view state:

- selected node ID;
- viewport origin;
- density level;
- loop expansion state;
- detail panel state.

It must not change canonical workflow state directly.

## 5. Pane behaviour

### 5.1 Open and close

Use:

```text
/hypagraph graph
/hypagraph graph close
/hypagraph graph toggle
```

The existing `/hypagraph` command continues to show the compact workflow view.

Add a configurable shortcut after command behaviour is stable.

### 5.2 Wide terminal mode

For a terminal width of at least 100 columns:

- anchor the overlay at `right-center`;
- use approximately 45 percent of terminal width;
- use at least 48 columns;
- use at most 96 columns;
- use up to 90 percent of terminal height;
- keep a small outside margin.

The pane can remain visible while normal Pi input has focus.

When the user enters navigation mode, the pane takes focus. When the user exits navigation mode, the pane releases focus but stays visible.

### 5.3 Narrow terminal mode

For a terminal width below 100 columns:

- do not cover the editor with a side pane;
- open the graph as a full-screen custom component;
- close it with Escape;
- keep the compact widget after close.

### 5.4 Non-interactive modes

Pi print and JSON modes do not have an interactive TUI.

In these modes:

- do not open the pane;
- keep graph projection available as structured data;
- return a text summary when requested;
- permit RPC clients to build their own graph view from the projection.

## 6. Visual language

Use status as the primary node decoration.

Suggested markers:

```text
○ pending
◇ ready
▶ running
? awaiting evidence
V verifying
✓ succeeded
✗ failed
■ blocked
– skipped
! stale
× cancelled
```

Use the active Pi theme for colour.

Do not make colour the only signal.

Use edge styles:

```text
solid arrow      dependency
bright arrow     selected gate route
dim arrow        unselected or skipped route
double marker    loop entry
return lane      loop feedback edge
```

Use a visible loop boundary with the loop ID and iteration limit.

Example:

```text
+ loop quality [0/3] ------------------+
| [draft] ------> [evaluate]           |
|   ^                |                 |
|   +----------------+ feedback        |
+--------------------------------------+
```

## 7. Interaction

Initial keyboard actions:

```text
Arrow keys or h/j/k/l   move node selection
Enter                   open node details
Escape                  release focus or close pane
Tab                     cycle graph and details
Home                    focus the active node
r                       focus the ready frontier
l                       collapse or expand selected loop
f                       open filter mode
+ and -                 change density
```

Node details show:

- node title and description;
- kind and status;
- dependencies;
- acceptance criteria;
- fact contracts;
- current facts;
- attempts;
- check command and result;
- evidence references;
- failure or blocked reason.

M3 keeps details read-only.

M5 can add pause, cancel, retry, approval, and replay actions.

## 8. Redraw and state updates

Create one pane controller in the Pi adapter.

The controller owns:

- the current `GraphViewModel`;
- the current layout;
- the pane component reference;
- the overlay handle;
- the open or closed state.

After each accepted event batch:

1. build a new graph projection;
2. compare its layout-affecting hash;
3. recompute layout only when structure or labels change;
4. update state decorations without layout when only runtime state changes;
5. invalidate the component;
6. request a TUI redraw.

Do not recompute layout for elapsed-time updates.

Throttle elapsed-time redraw to at most one update each second.

## 9. Stable layout across revisions

Position stability is important because a moving graph is difficult to read.

Use these rules:

1. Keep the same rank for unchanged nodes when valid.
2. Keep the same order inside a rank when valid.
3. Place new nodes near their dependencies.
4. Do not move unaffected loop groups.
5. Re-layout only the smallest affected region when practical.
6. Store optional view preferences separately from canonical state.

View preferences can include:

- pane open state;
- selected node ID;
- collapsed loop IDs;
- density;
- viewport position.

These values are not domain events.

## 10. Security and correctness

The pane must follow these rules:

1. Treat titles, descriptions, command text, and evidence summaries as untrusted text.
2. Remove control characters that can change terminal state.
3. Permit only renderer-created ANSI sequences.
4. Truncate labels before rendering.
5. Bound node, edge, and line counts for one frame.
6. Bound graph layout time.
7. Do not read artifact content during normal graph rendering.
8. Do not start an executor from a view action.
9. Do not change canonical state from selection or viewport actions.
10. Use the canonical projection for all state colours and markers.

## 11. Performance limits

Initial limits:

- 250 visible nodes;
- 600 visible edges;
- 80 characters for a full node title;
- 24 characters for a compact node label;
- 50 milliseconds target for runtime-only redraw;
- 200 milliseconds target for full layout;
- one elapsed-time redraw each second.

For larger graphs, use:

- loop collapse;
- neighbourhood focus;
- filters;
- viewport clipping;
- a warning that the pane shows a partial graph.

## 12. Delivery slices

### V1 - Pure graph projection

Add:

- graph view-model types;
- projection from canonical state;
- edge classification;
- loop group projection;
- top-level graph-component identity;
- loop failure-policy and local-outcome projection;
- deterministic tests.

Done when the same state always produces the same graph view model.

### V2 - Terminal layout and renderer

Add:

- condensation-graph layout;
- rank assignment;
- stable ordering;
- node boxes;
- orthogonal dependency edges;
- loop boundaries and feedback lanes;
- disconnected component placement;
- clipping and ASCII fallback.

Done when representative task, gate, check, branch, join, connected-loop, and disconnected-loop graphs render in snapshot tests.

### V3 - Dedicated Pi pane

Add:

- right-side overlay;
- full-screen narrow-terminal fallback;
- open, close, and toggle commands;
- selection and viewport navigation;
- theme support;
- component redraw after event batches.

Done when a live Pi session shows graph state changes without closing the pane.

### V4 - Node inspection

Add:

- read-only node details;
- check result details;
- fact and evidence summaries;
- loop details;
- responsive detail layout.

Done when the user can identify why a node is ready, blocked, failed, skipped, or stale.

### V5 - M5 debugger expansion

Add:

- event timeline;
- replay cursor;
- revision comparison;
- historical attempts;
- debugger actions;
- advanced filters.

## 13. Test plan

### Projection tests

- Project task, gate, and check nodes.
- Classify dependency and route edges.
- Project selected and skipped routes.
- Project declared loops and feedback edges.
- Preserve stable ordering.
- Reject no canonical state.

### Layout tests

- Render a linear graph.
- Render a branch and join.
- Render nested branches.
- Render a declared loop.
- Route feedback separately.
- Keep lines within width.
- Preserve positions after a small revision.
- Bound large graph layout.

### Pi component tests

- Open and close the pane.
- Use side-pane mode on a wide terminal.
- Use full-screen mode on a narrow terminal.
- Navigate nodes.
- Release focus while the pane stays visible.
- Redraw after events.
- Change theme and invalidate cached styles.
- Sanitize control characters.
- Do not open in print mode.

## 14. Acceptance criteria

- [ ] Pi can show a dedicated live Hypagraph graph pane.
- [ ] The pane shows nodes and directed edges.
- [ ] The pane shows selected and skipped routes.
- [ ] The pane shows loop groups and feedback edges.
- [ ] Runtime states update without a full layout when structure does not change.
- [ ] The pane is usable while the normal editor has focus.
- [ ] Narrow terminals use a full-screen fallback.
- [ ] The compact widget remains available when the pane is closed.
- [ ] The renderer does not emit untrusted terminal control sequences.
- [ ] The domain and reducer have no Pi or TUI dependency.
- [ ] Projection, layout, and rendering have deterministic tests.

## 15. Recommended sequence

Complete the current Pi command-check integration first.

Then implement V1 and V2 before the durable lifecycle slice changes the host adapter further.

Implement V3 and V4 as part of the M3 completion release.

Keep V5 in the existing debugger milestone.
