from pathlib import Path


def maybe_replace(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        print(f"Skipping unmatched {label}")
        return text
    return text.replace(old, new, 1)


baseline = "836ac10ea8c13c6b0839902d175f718359d1bd07"

path = Path("docs/hypagoal-vertical-slice-plan.md")
text = path.read_text()
text = maybe_replace(text, "- Status: active implementation; Slices 1 and 2 complete; Slice 3 current", "- Status: active implementation; Slices 1, 2, and 3 complete; Slice 4 current", "vertical status")
if "### Slice 3 - Graph-aware continuation — complete" not in text:
    start = text.find("### Slice 3 - Graph-aware continuation\n")
    end = text.find("### Slice 4 - Budgets and reload safety\n", start)
    if start >= 0 and end >= 0:
        text = text[:start] + """### Slice 3 - Graph-aware continuation — complete

PR #67 delivered:

- pure workflow-local continuation decisions;
- explicit goal, workflow, revision, sequence, snapshot, ordinal, node, and loop identity;
- stable definition-order candidate enumeration;
- event-backed round-robin selection through `GoalRuntime.continuationOrdinal`;
- durable `hypagraph.goal.continuation-requested` events;
- one queued Pi follow-up through `agent_end`;
- state-bound delivery and stale rejection in `before_agent_start`;
- user-message priority and no-progress stop behavior;
- dynamic tool exposure and restoration;
- deterministic selection across disconnected branches and independent loop components;
- replay, restore, and realistic Pi smoke coverage.

The merge baseline is `836ac10ea8c13c6b0839902d175f718359d1bd07`.

CI #770 and final PR CI #772 pass 85 test files and 357 tests on Ubuntu, macOS, and Windows with Node.js 22 and 24.

The selector remains workflow-local and can later become one candidate source for the family scheduler without changing its action contract.

""" + text[end:]
    else:
        print("Skipping unmatched Slice 3 section")
text = maybe_replace(text, "### Slice 4 - Budgets and reload safety\n", "### Slice 4 - Budgets and reload safety — current\n", "Slice 4 heading")
text = maybe_replace(text, "M5B is active. Slices 1 and 2 are complete. Slice 3 is the current implementation target.", "M5B is active. Slices 1, 2, and 3 are complete. Slice 4 is the current implementation target.", "vertical current target")
path.write_text(text)

path = Path("docs/execution-roadmap.md")
text = path.read_text()
text = maybe_replace(text, "- Current implementation baseline: `3656caf3e62d26d3dc406e93b5b5e71e96cbfae8`", f"- Current implementation baseline: `{baseline}`", "roadmap baseline")
text = maybe_replace(text, "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1 and 2 complete |", "| M5B | v0.6 | Root Hypagoal autonomous controller | Active; Slices 1, 2, and 3 complete |", "roadmap milestone")
text = maybe_replace(text, "3. Graph-aware continuation — current.\n4. Token and turn budgets plus reload safety.", "3. Graph-aware continuation — complete in PR #67.\n4. Token and turn budgets plus reload safety — current.", "roadmap slice status")
if "### Slice 3 result" not in text:
    marker = "Slice 3 must select deterministically across every runnable root component. It must include goal and workflow identity on continuation actions, support disconnected and independent loop components, avoid recency-based component ownership, and preserve a direct lift into the later family scheduler.\n\n"
    addition = """### Slice 3 result

M5B Slice 3 provides:

- a pure workflow-local continuation selector;
- stable enumeration across every runnable root component;
- event-backed round-robin fairness;
- explicit goal, workflow, revision, sequence, snapshot, ordinal, node, and loop identity;
- durable continuation requests before Pi follow-ups;
- one Pi scheduling authority;
- stale request and delivery rejection;
- user-message priority and no-progress stopping;
- replay, restore, independent-loop fairness, and routed Pi smoke evidence in `docs/m5b-slice-3-dogfood.md`.

Slice 4 adds workflow-local token and turn budgets plus reload and branch-change pause behavior. Usage contracts must be additive so a later family aggregate can sum descendant and executor usage without rewriting root workflow history.

"""
    if marker in text:
        text = text.replace(marker, marker + addition, 1)
    else:
        print("Skipping unmatched roadmap Slice 3 insertion")
path.write_text(text)

path = Path("docs/product-spec.md")
text = path.read_text()
text = maybe_replace(text, "- Version: implementation baseline through M5B Slice 2", "- Version: implementation baseline through M5B Slice 3", "product version")
text = maybe_replace(text, "- Current baseline: `3656caf3e62d26d3dc406e93b5b5e71e96cbfae8`", f"- Current baseline: `{baseline}`", "product baseline")
text = maybe_replace(text, "M5B Slice 2 implements atomic root creation through `/hypagoal` and `hypagoal_start`. It preserves the exact prose objective, persists definition, initial readiness, and goal start in one event batch, requires state-bound replacement confirmation, and does not queue continuation.\n\nThe v0.6 product supports one root Hypagoal in one Pi session.", "M5B Slice 2 implements atomic root creation through `/hypagoal` and `hypagoal_start`. It preserves the exact prose objective, persists definition, initial readiness, and goal start in one event batch, requires state-bound replacement confirmation, and does not queue continuation during creation.\n\nM5B Slice 3 implements pure graph-aware continuation decisions, event-backed component selection, one state-bound Pi follow-up, stale-delivery rejection, user-message priority, and deterministic interleaving across disconnected branches and independent loop components.\n\nThe v0.6 product supports one root Hypagoal in one Pi session.", "product Slice 3 description")
text = maybe_replace(text, "- creation and restore without autonomous continuation.", "- creation and restore without autonomous continuation;\n- pure graph-aware root continuation decisions;\n- durable state-bound continuation requests;\n- deterministic component selection and independent-loop fairness;\n- stale continuation delivery rejection and user-message priority.", "product implementation bullets")
text = maybe_replace(text, "M5B Slices 1 and 2 are complete in PRs #62 and #65. Slice 3, graph-aware continuation across all runnable root components, is the current implementation target.", "M5B Slices 1, 2, and 3 are complete in PRs #62, #65, and #67. Slice 4, token and turn budgets plus reload safety, is the current implementation target.", "product current target")
text = maybe_replace(text, "4. M5B root Hypagoal autonomous controller — active; Slices 1 and 2 complete.", "4. M5B root Hypagoal autonomous controller — active; Slices 1, 2, and 3 complete.", "product delivery status")
text = maybe_replace(text, "CI #722 passes:", "CI #770 and final PR CI #772 pass:", "product CI")
text = maybe_replace(text, "The complete suite contains 83 test files and 333 tests.", "The complete suite contains 85 test files and 357 tests.", "product test count")
path.write_text(text)
