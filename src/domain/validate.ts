import type { Diagnostic, HypagraphDefinition } from "./model.js";
import { buildOutgoing, isCyclicComponent, stronglyConnectedComponents } from "./scc.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FACT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((item) => values.has(item));
};

export function validateDefinition(definition: HypagraphDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();
  const factOwners = new Map<string, string>();

  if (!definition.title.trim()) diagnostics.push({ code: "empty_title", message: "The workflow title must not be empty.", location: "title" });
  if (!definition.goal.trim()) diagnostics.push({ code: "empty_goal", message: "The workflow goal must not be empty.", location: "goal" });
  if (definition.nodes.length === 0) diagnostics.push({ code: "empty_graph", message: "The workflow must have at least one node.", location: "nodes" });

  definition.nodes.forEach((node, index) => {
    const location = `nodes[${index}]`;
    if (!ID_PATTERN.test(node.id)) diagnostics.push({ code: "invalid_node_id", message: `Node ID '${node.id}' must match ${ID_PATTERN}.`, location: `${location}.id` });
    if (ids.has(node.id)) diagnostics.push({ code: "duplicate_node_id", message: `Node ID '${node.id}' occurs more than one time.`, location: `${location}.id` });
    ids.add(node.id);
    if (!node.title.trim()) diagnostics.push({ code: "empty_node_title", message: `Node '${node.id}' must have a title.`, location: `${location}.title` });
    if (new Set(node.requires).size !== node.requires.length) diagnostics.push({ code: "duplicate_dependency", message: `Node '${node.id}' has the same dependency more than one time.`, location: `${location}.requires` });

    const localFacts = new Set<string>();
    (node.produces ?? []).forEach((fact, factIndex) => {
      const factLocation = `${location}.produces[${factIndex}]`;
      if (!FACT_PATTERN.test(fact.name)) diagnostics.push({ code: "invalid_fact_name", message: `Fact '${fact.name}' must use a dotted lower-case name.`, location: `${factLocation}.name` });
      if (localFacts.has(fact.name)) diagnostics.push({ code: "duplicate_fact_contract", message: `Node '${node.id}' declares fact '${fact.name}' more than one time.`, location: `${factLocation}.name` });
      localFacts.add(fact.name);
      const owner = factOwners.get(fact.name);
      if (owner && owner !== node.id) diagnostics.push({ code: "conflicting_fact_producer", message: `Facts '${fact.name}' has producers '${owner}' and '${node.id}'.`, location: `${factLocation}.name` });
      factOwners.set(fact.name, node.id);
    });
  });

  definition.nodes.forEach((node, index) => {
    node.requires.forEach((required, requiredIndex) => {
      if (!ids.has(required)) diagnostics.push({ code: "dangling_dependency", message: `Node '${node.id}' requires node '${required}', but that node does not exist.`, location: `nodes[${index}].requires[${requiredIndex}]` });
    });
  });

  if (diagnostics.some((item) => item.code === "duplicate_node_id" || item.code === "dangling_dependency")) return diagnostics;

  const outgoing = buildOutgoing(definition.nodes);
  const components = stronglyConnectedComponents(definition.nodes.map((node) => node.id), outgoing);
  const cyclic = components.components.filter((component) => isCyclicComponent(component, outgoing));
  const claimedNodes = new Map<string, string>();
  const loopIds = new Set<string>();

  definition.loops.forEach((loop, index) => {
    const location = `loops[${index}]`;
    if (!ID_PATTERN.test(loop.id)) diagnostics.push({ code: "invalid_loop_id", message: `Loop ID '${loop.id}' is not valid.`, location: `${location}.id` });
    if (loopIds.has(loop.id)) diagnostics.push({ code: "duplicate_loop_id", message: `Loop ID '${loop.id}' occurs more than one time.`, location: `${location}.id` });
    loopIds.add(loop.id);
    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) diagnostics.push({ code: "invalid_loop_limit", message: `Loop '${loop.id}' must have a positive iteration limit.`, location: `${location}.maxIterations` });
    if (!loop.successWhen.trim()) diagnostics.push({ code: "missing_success_predicate", message: `Loop '${loop.id}' must have a success predicate.`, location: `${location}.successWhen` });

    for (const node of loop.nodes) {
      if (!ids.has(node)) diagnostics.push({ code: "dangling_loop_node", message: `Loop '${loop.id}' refers to node '${node}', but that node does not exist.`, location: `${location}.nodes` });
      const owner = claimedNodes.get(node);
      if (owner && owner !== loop.id) diagnostics.push({ code: "overlapping_loop", message: `Node '${node}' is in loops '${owner}' and '${loop.id}'.`, location: `${location}.nodes` });
      claimedNodes.set(node, loop.id);
    }

    if (!loop.nodes.includes(loop.entry)) diagnostics.push({ code: "invalid_loop_entry", message: `Loop entry '${loop.entry}' is not in loop '${loop.id}'.`, location: `${location}.entry` });
    if (!loop.nodes.includes(loop.evaluateAfter)) diagnostics.push({ code: "invalid_loop_evaluator", message: `Loop evaluator '${loop.evaluateAfter}' is not in loop '${loop.id}'.`, location: `${location}.evaluateAfter` });

    for (const edge of loop.feedbackEdges) {
      const target = definition.nodes.find((node) => node.id === edge.to);
      if (!loop.nodes.includes(edge.from) || !loop.nodes.includes(edge.to) || !target?.requires.includes(edge.from)) {
        diagnostics.push({ code: "invalid_feedback_edge", message: `Feedback edge '${edge.from} -> ${edge.to}' must be a dependency in loop '${loop.id}'.`, location: `${location}.feedbackEdges` });
      }
    }
    if (loop.feedbackEdges.length === 0) diagnostics.push({ code: "missing_feedback_edge", message: `Loop '${loop.id}' must identify at least one feedback edge.`, location: `${location}.feedbackEdges` });

    if (!cyclic.find((component) => sameSet(component, loop.nodes))) {
      diagnostics.push({ code: "loop_scc_mismatch", message: `The nodes in loop '${loop.id}' must be the same as one cyclic component.`, location: `${location}.nodes` });
    }
  });

  for (const component of cyclic) {
    const matches = definition.loops.filter((loop) => sameSet(loop.nodes, component));
    if (matches.length === 0) diagnostics.push({ code: "undeclared_cycle", message: `Cyclic component [${component.join(", ")}] must be a bounded loop.`, location: "nodes", suggestion: "Add one loop with the same nodes and identify its feedback edges." });
    if (matches.length > 1) diagnostics.push({ code: "duplicate_loop_for_scc", message: `Cyclic component [${component.join(", ")}] has more than one loop declaration.`, location: "loops" });
  }

  return diagnostics;
}
