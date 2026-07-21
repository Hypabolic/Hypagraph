import type { Diagnostic, WorkGraphDefinition } from "./model.js";
import { buildOutgoing, isCyclicComponent, stronglyConnectedComponents } from "./scc.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((item) => values.has(item));
};

export function validateDefinition(definition: WorkGraphDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();

  if (!definition.title.trim()) {
    diagnostics.push({ code: "empty_title", message: "Workflow title cannot be empty.", location: "title" });
  }
  if (!definition.goal.trim()) {
    diagnostics.push({ code: "empty_goal", message: "Workflow goal cannot be empty.", location: "goal" });
  }
  if (definition.nodes.length === 0) {
    diagnostics.push({ code: "empty_graph", message: "A workflow requires at least one node.", location: "nodes" });
  }

  definition.nodes.forEach((node, index) => {
    const location = `nodes[${index}]`;
    if (!ID_PATTERN.test(node.id)) {
      diagnostics.push({
        code: "invalid_node_id",
        message: `Node id '${node.id}' must match ${ID_PATTERN}.`,
        location: `${location}.id`,
      });
    }
    if (ids.has(node.id)) {
      diagnostics.push({ code: "duplicate_node_id", message: `Duplicate node id '${node.id}'.`, location: `${location}.id` });
    }
    ids.add(node.id);
    if (!node.title.trim()) {
      diagnostics.push({ code: "empty_node_title", message: `Node '${node.id}' has an empty title.`, location: `${location}.title` });
    }
    if (new Set(node.requires).size !== node.requires.length) {
      diagnostics.push({ code: "duplicate_dependency", message: `Node '${node.id}' repeats a dependency.`, location: `${location}.requires` });
    }
  });

  definition.nodes.forEach((node, index) => {
    node.requires.forEach((required, requiredIndex) => {
      if (!ids.has(required)) {
        diagnostics.push({
          code: "dangling_dependency",
          message: `Node '${node.id}' requires missing node '${required}'.`,
          location: `nodes[${index}].requires[${requiredIndex}]`,
        });
      }
    });
  });

  if (diagnostics.some((diagnostic) => diagnostic.code === "duplicate_node_id" || diagnostic.code === "dangling_dependency")) {
    return diagnostics;
  }

  const outgoing = buildOutgoing(definition.nodes);
  const scc = stronglyConnectedComponents(definition.nodes.map((node) => node.id), outgoing);
  const cyclic = scc.components.filter((component) => isCyclicComponent(component, outgoing));
  const claimedNodes = new Map<string, string>();
  const loopIds = new Set<string>();

  definition.loops.forEach((loop, index) => {
    const location = `loops[${index}]`;
    if (!ID_PATTERN.test(loop.id)) {
      diagnostics.push({ code: "invalid_loop_id", message: `Loop id '${loop.id}' is invalid.`, location: `${location}.id` });
    }
    if (loopIds.has(loop.id)) {
      diagnostics.push({ code: "duplicate_loop_id", message: `Duplicate loop id '${loop.id}'.`, location: `${location}.id` });
    }
    loopIds.add(loop.id);
    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) {
      diagnostics.push({ code: "invalid_loop_limit", message: `Loop '${loop.id}' needs a positive hard iteration limit.`, location: `${location}.maxIterations` });
    }
    if (!loop.successWhen.trim()) {
      diagnostics.push({ code: "missing_success_predicate", message: `Loop '${loop.id}' needs a success predicate.`, location: `${location}.successWhen` });
    }
    for (const node of loop.nodes) {
      if (!ids.has(node)) {
        diagnostics.push({ code: "dangling_loop_node", message: `Loop '${loop.id}' references missing node '${node}'.`, location: `${location}.nodes` });
      }
      const owner = claimedNodes.get(node);
      if (owner && owner !== loop.id) {
        diagnostics.push({ code: "overlapping_loop", message: `Node '${node}' is claimed by loops '${owner}' and '${loop.id}'.`, location: `${location}.nodes` });
      }
      claimedNodes.set(node, loop.id);
    }
    if (!loop.nodes.includes(loop.entry)) {
      diagnostics.push({ code: "invalid_loop_entry", message: `Loop entry '${loop.entry}' is not in loop '${loop.id}'.`, location: `${location}.entry` });
    }
    if (!loop.nodes.includes(loop.evaluateAfter)) {
      diagnostics.push({ code: "invalid_loop_evaluator", message: `Loop evaluator '${loop.evaluateAfter}' is not in loop '${loop.id}'.`, location: `${location}.evaluateAfter` });
    }
    for (const edge of loop.feedbackEdges) {
      const target = definition.nodes.find((node) => node.id === edge.to);
      if (!loop.nodes.includes(edge.from) || !loop.nodes.includes(edge.to) || !target?.requires.includes(edge.from)) {
        diagnostics.push({
          code: "invalid_feedback_edge",
          message: `Feedback edge '${edge.from} -> ${edge.to}' must be a real dependency wholly inside loop '${loop.id}'.`,
          location: `${location}.feedbackEdges`,
        });
      }
    }
    if (loop.feedbackEdges.length === 0) {
      diagnostics.push({ code: "missing_feedback_edge", message: `Loop '${loop.id}' must identify at least one feedback edge.`, location: `${location}.feedbackEdges` });
    }

    const matchingComponent = cyclic.find((component) => sameSet(component, loop.nodes));
    if (!matchingComponent) {
      diagnostics.push({
        code: "loop_scc_mismatch",
        message: `Loop '${loop.id}' node set must exactly match one cyclic strongly connected component.`,
        location: `${location}.nodes`,
      });
    }
  });

  for (const component of cyclic) {
    const matches = definition.loops.filter((loop) => sameSet(loop.nodes, component));
    if (matches.length === 0) {
      diagnostics.push({
        code: "undeclared_cycle",
        message: `Cyclic component [${component.join(", ")}] must be declared as a bounded loop.`,
        location: "nodes",
        suggestion: "Declare one loop whose nodes exactly match this component and identify its feedback edges.",
      });
    }
    if (matches.length > 1) {
      diagnostics.push({ code: "duplicate_loop_for_scc", message: `Cyclic component [${component.join(", ")}] has multiple loop declarations.`, location: "loops" });
    }
  }

  return diagnostics;
}
