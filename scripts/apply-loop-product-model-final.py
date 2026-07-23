from pathlib import Path

path = Path("docs/pi-graph-visualisation-plan.md")
text = path.read_text()
old = """```\n\nA graph node includes:\n"""
new = """```\n\nA graph component includes:\n\n- a stable component ID;\n- member node IDs;\n- member loop IDs;\n- whether it has an edge to another component after loop collapse;\n- its derived terminal outcome when one exists.\n\nComponent identity is a projection value. It is not a new workflow node and it is not a domain event.\n\nA graph node includes:\n"""
if old not in text:
    raise SystemExit("Graph view-model insertion point was not found.")
path.write_text(text.replace(old, new, 1))
