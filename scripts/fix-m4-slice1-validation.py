from pathlib import Path


validate_path = Path("src/domain/validate.ts")
text = validate_path.read_text()
start = text.index("const upstreamNodeIds =")
end = text.index("const sourceType =", start)
replacement = '''const upstreamNodeIds = (definition: HypagraphDefinition, nodeId: string): Set<string> => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const edgeKey = (sourceId: string, targetId: string): string => `${sourceId}->${targetId}`;
  const feedback = new Set(definition.loops.flatMap((loop) => loop.feedbackEdges.map((edge) => edgeKey(edge.from, edge.to))));
  const dependencies = (targetId: string): string[] => (byId.get(targetId)?.requires ?? [])
    .filter((sourceId) => !feedback.has(edgeKey(sourceId, targetId)));
  const result = new Set<string>();
  const queue = [...dependencies(nodeId)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...dependencies(current));
  }
  return result;
};

'''
validate_path.write_text(text[:start] + replacement + text[end:])

validation_test = Path("tests/validation.test.ts")
test_text = validation_test.read_text()
marker = '\n  it("finds only one-node components in generated directed acyclic graphs", () => {'
if marker not in test_text:
    raise SystemExit("The validation test insertion point was not found.")
new_test = r'''
  it("rejects a loop gate that reads a fact from after the gate", () => {
    const definition: HypagraphDefinition = {
      title: "Loop gate fact order",
      goal: "Reject a later fact",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "choose",
          title: "Choose",
          kind: "gate",
          requires: ["implement"],
          acceptance: [],
          gate: {
            condition: successCondition,
            onTrue: ["repair-a"],
            onFalse: ["repair-b"],
          },
        },
        { id: "repair-a", title: "Repair A", requires: ["choose"], acceptance: [] },
        { id: "repair-b", title: "Repair B", requires: ["choose"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          requires: ["repair-a", "repair-b"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
        },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "choose", "repair-a", "repair-b", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: successCondition,
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    expect(validateDefinition(definition).some((item) => item.code === "condition_fact_not_upstream" && item.location?.includes("nodes[1].gate.condition"))).toBe(true);
  });
'''
validation_test.write_text(test_text.replace(marker, new_test + marker, 1))

for root in ("src", "tests", "docs", "skills"):
    for path in Path(root).rglob("*"):
        if path.is_file() and path.suffix in {".ts", ".md", ".json"}:
            content = path.read_text()
            if "\x00" in content:
                raise SystemExit(f"NUL control character found in {path}.")
