export interface StronglyConnectedComponents {
  components: string[][];
  componentByNode: Map<string, number>;
}

/** Tarjan's O(V + E) strongly-connected-components algorithm. */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
): StronglyConnectedComponents {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of outgoing.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };

  for (const node of nodes) {
    if (!indices.has(node)) visit(node);
  }

  const componentByNode = new Map<string, number>();
  components.forEach((component, index) => {
    component.forEach((node) => componentByNode.set(node, index));
  });

  return { components, componentByNode };
}

export function buildOutgoing(
  nodes: readonly { id: string; requires: readonly string[] }[],
): Map<string, string[]> {
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const required of node.requires) {
      outgoing.get(required)?.push(node.id);
    }
  }
  return outgoing;
}

export function isCyclicComponent(
  component: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (component.length > 1) return true;
  const node = component[0];
  return node !== undefined && (outgoing.get(node) ?? []).includes(node);
}
