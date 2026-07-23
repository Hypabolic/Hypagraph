from pathlib import Path

path = Path("src/graph/layout.ts")
text = path.read_text()
start_marker = "  const layoutNodes: GraphLayoutNode[] = [];\n"
end_marker = "  layoutNodes.sort((left, right) => left.id.localeCompare(right.id));\n"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("The generated layout node block was not found.")
end += len(end_marker)
replacement = '''  const componentByNode = new Map(view.nodes.map((node) => [node.id, node.componentId ?? `component:${node.id}`]));
  const componentIds = [...new Set(visibleNodes.map((node) => componentByNode.get(node.id)!).filter(Boolean))].sort();
  const maxRowsByComponent = new Map(componentIds.map((componentId) => [componentId, 1]));
  for (const ids of nodesByRank.values()) {
    for (const componentId of componentIds) {
      const count = ids.filter((id) => componentByNode.get(id) === componentId).length;
      maxRowsByComponent.set(componentId, Math.max(maxRowsByComponent.get(componentId) ?? 1, count));
    }
  }
  const componentBaseY = new Map<string, number>();
  let nextComponentY = metrics.margin;
  for (const componentId of componentIds) {
    componentBaseY.set(componentId, nextComponentY);
    nextComponentY += (maxRowsByComponent.get(componentId) ?? 1) * (metrics.nodeHeight + metrics.verticalGap) + metrics.verticalGap + 4;
  }

  const layoutNodes: GraphLayoutNode[] = [];
  for (const [nodeRank, ids] of [...nodesByRank.entries()].sort((left, right) => left[0] - right[0])) {
    for (const componentId of componentIds) {
      const componentIdsAtRank = ids.filter((id) => componentByNode.get(id) === componentId);
      componentIdsAtRank.sort((left, right) => {
        const previousLeft = previousById.get(left);
        const previousRight = previousById.get(right);
        if (previousLeft && previousRight && previousLeft.rank === previousRight.rank) return previousLeft.order - previousRight.order || left.localeCompare(right);
        if (previousLeft && !previousRight) return -1;
        if (!previousLeft && previousRight) return 1;
        return left.localeCompare(right);
      });
      componentIdsAtRank.forEach((id, order) => {
        layoutNodes.push({
          id,
          x: metrics.margin + nodeRank * (metrics.nodeWidth + metrics.horizontalGap),
          y: (componentBaseY.get(componentId) ?? metrics.margin) + order * (metrics.nodeHeight + metrics.verticalGap),
          width: metrics.nodeWidth,
          height: metrics.nodeHeight,
          rank: nodeRank,
          order,
        });
      });
    }
  }
  layoutNodes.sort((left, right) => left.id.localeCompare(right.id));
'''
path.write_text(text[:start] + replacement + text[end:])
