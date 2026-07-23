from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "README.md",
    "2. The first dependency-free nodes and loop entries become ready.",
    "2. The first dependency-free nodes, including eligible loop entries, become ready.",
)
replace_once(
    "README.md",
    "### Bounded loops",
    "### Bounded iteration regions",
)

replace_once(
    "docs/m4-vertical-slice-plan.md",
    "### 3.3 Use a single-entry and single-exit iteration region",
    "### 3.3 Use a single-entry and single-evaluation iteration region",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """5. Complete the loop when success is true and the evaluation node passed verification.
6. Fail at `max_iterations` when the hard limit is reached.
7. Fail at `no_progress` when patience is exhausted.
8. Otherwise start the next iteration.""",
    """5. Complete the loop when success is true and the evaluation node passed verification.
6. Select `max_iterations` when the hard limit is reached.
7. Select `no_progress` when patience is exhausted.
8. Apply the failure policy when the loop has a failure exit reason.
9. Otherwise start the next iteration.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    "A task-based repair loop runs two iterations and keeps correct history.",
    "A task-based iteration region runs two iterations and keeps correct history.",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    "- workflow failure after loop exhaustion;",
    "- default workflow failure after loop exhaustion before outcome policy is available;",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    "- An unsuccessful final iteration fails the loop and workflow.",
    "- An unsuccessful final iteration fails the loop. Slice 6 applies its failure policy to the workflow and dependants.",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- decision;
- exit reason when applicable.""",
    """- decision;
- exit reason when applicable;
- failure policy when failure applies;
- derived workflow effect when failure applies.""",
)
replace_once(
    "docs/m4-vertical-slice-plan.md",
    """- no-progress count and patience;
- exit reason.""",
    """- no-progress count and patience;
- failure policy;
- graph-component identity;
- local outcome and workflow effect;
- exit reason.""",
)

replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop regions;
- loop feedback edges;""",
    """- loop regions;
- independent top-level graph components;
- loop feedback edges;""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  readyNodeIds: string[];""",
    """  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  components: GraphViewComponent[];
  readyNodeIds: string[];""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- feedback edges;
- maximum iteration count;
- current iteration when M4 provides it.""",
    """- feedback edges;
- maximum iteration count;
- current iteration when M4 provides it;
- failure policy when M4 provides it;
- graph-component ID;
- local outcome and workflow effect.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """Process loops before normal layout:

1. Find strongly connected components.
2. Match declared loop regions.
3. Collapse each loop to one compound layout node.
4. Layout the condensation graph from left to right.
5. Expand each loop region.
6. Route feedback edges on a separate lane.
7. Preserve stable positions when the graph revision changes.""",
    """Process loop regions and graph components before normal layout:

1. Find strongly connected components.
2. Match declared loop regions.
3. Collapse each loop to one compound layout node.
4. Find weakly connected top-level graph components in the condensation graph.
5. Layout each component from left to right.
6. Place disconnected components with stable spacing and ordering.
7. Expand each loop region.
8. Route feedback edges on a separate lane.
9. Preserve stable positions when the graph revision changes.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """+ loop repair [0/3] -------------------+
| [fix] --------> [test]               |
|   ^                |                 |
|   +----------------+ feedback        |
+--------------------------------------+""",
    """+ loop quality [0/3] ------------------+
| [draft] ------> [evaluate]           |
|   ^                |                 |
|   +----------------+ feedback        |
+--------------------------------------+""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop group projection;
- deterministic tests.""",
    """- loop group projection;
- top-level graph-component identity;
- loop failure-policy and local-outcome projection;
- deterministic tests.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    """- loop boundaries and feedback lanes;
- clipping and ASCII fallback.""",
    """- loop boundaries and feedback lanes;
- disconnected component placement;
- clipping and ASCII fallback.""",
)
replace_once(
    "docs/pi-graph-visualisation-plan.md",
    "Done when representative task, gate, check, branch, join, and loop graphs render in snapshot tests.",
    "Done when representative task, gate, check, branch, join, connected-loop, and disconnected-loop graphs render in snapshot tests.",
)
