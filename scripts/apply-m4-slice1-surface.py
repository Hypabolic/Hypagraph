from pathlib import Path


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


write("src/domain/validate.ts", r'''import { measureCondition, type Condition, type ValueExpression } from "./conditions.js";
import type { FactType, FactValue } from "./facts.js";
import type { CheckFactSource, Diagnostic, HypagraphDefinition, LegacyLoopPredicate, LoopDefinition, NodeDefinition } from "./model.js";
import { buildOutgoing, isCyclicComponent, stronglyConnectedComponents } from "./scc.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FACT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CHECK_ATTEMPTS = 20;
const MAX_RETRY_BACKOFF_MS = 86_400_000;
const RETRY_STATUSES = new Set(["failed", "timed_out", "error"]);

type ConditionValueType = FactType | "unknown";

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((item) => values.has(item));
};

const literalType = (value: FactValue): ConditionValueType => {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "string-list";
  return "string";
};

const valueType = (value: ValueExpression, factTypes: ReadonlyMap<string, FactType>): ConditionValueType => (
  value.kind === "literal" ? literalType(value.value) : factTypes.get(value.name) ?? "unknown"
);

const numericType = (type: ConditionValueType): boolean => type === "integer" || type === "number";
const equalTypes = (left: ConditionValueType, right: ConditionValueType): boolean => left === "unknown" || right === "unknown" || left === right || (numericType(left) && numericType(right));

const operatorAccepts = (operator: Extract<Condition, { kind: "compare" }>["operator"], left: ConditionValueType, right: ConditionValueType): boolean => {
  if (left === "unknown" || right === "unknown") return true;
  switch (operator) {
    case "eq":
    case "neq": return equalTypes(left, right);
    case "gt":
    case "gte":
    case "lt":
    case "lte": return numericType(left) && numericType(right);
    case "contains": return (left === "string" || left === "string-list") && right === "string";
    case "in": return left === "string" && right === "string-list";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const isFactValue = (value: unknown): value is FactValue =>
  typeof value === "boolean" || typeof value === "number" || typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isValueExpression = (value: unknown): value is ValueExpression => {
  if (!isRecord(value)) return false;
  if (value.kind === "fact") return typeof value.name === "string";
  return value.kind === "literal" && isFactValue(value.value);
};

const isConditionShape = (value: unknown, depth = 0): value is Condition => {
  if (!isRecord(value) || depth > 32 || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "exists": return typeof value.fact === "string";
    case "not": return isConditionShape(value.condition, depth + 1);
    case "all":
    case "any": return Array.isArray(value.conditions) && value.conditions.every((item) => isConditionShape(item, depth + 1));
    case "compare": return ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"].includes(String(value.operator)) && isValueExpression(value.left) && isValueExpression(value.right);
    default: return false;
  }
};

const validateCondition = (condition: unknown, factTypes: ReadonlyMap<string, FactType>, availableFacts: ReadonlySet<string>, location: string): Diagnostic[] => {
  if (!isConditionShape(condition)) return [{ code: "invalid_condition", message: "The condition must use the supported typed condition structure.", location }];
  const complexity = measureCondition(condition);
  if (!complexity.ok) return [{ code: complexity.code, message: complexity.message, location }];
  const diagnostics: Diagnostic[] = [];
  const visit = (value: Condition, currentLocation: string): void => {
    switch (value.kind) {
      case "exists":
        if (!factTypes.has(value.fact)) diagnostics.push({ code: "unknown_condition_fact", message: `The condition uses undeclared fact '${value.fact}'.`, location: currentLocation });
        else if (!availableFacts.has(value.fact)) diagnostics.push({ code: "condition_fact_not_upstream", message: `Fact '${value.fact}' is not available before this decision.`, location: currentLocation });
        break;
      case "not": visit(value.condition, `${currentLocation}.condition`); break;
      case "all":
      case "any":
        if (value.conditions.length === 0) diagnostics.push({ code: "empty_condition_group", message: `Condition group '${value.kind}' must contain at least one condition.`, location: currentLocation });
        value.conditions.forEach((item, index) => visit(item, `${currentLocation}.conditions[${index}]`));
        break;
      case "compare": {
        for (const expression of [value.left, value.right]) {
          if (expression.kind !== "fact") continue;
          if (!factTypes.has(expression.name)) diagnostics.push({ code: "unknown_condition_fact", message: `The condition uses undeclared fact '${expression.name}'.`, location: currentLocation });
          else if (!availableFacts.has(expression.name)) diagnostics.push({ code: "condition_fact_not_upstream", message: `Fact '${expression.name}' is not available before this decision.`, location: currentLocation });
        }
        const left = valueType(value.left, factTypes);
        const right = valueType(value.right, factTypes);
        if (!operatorAccepts(value.operator, left, right)) diagnostics.push({ code: "condition_type_mismatch", message: `Operator '${value.operator}' cannot compare '${left}' with '${right}'.`, location: currentLocation });
        break;
      }
    }
  };
  visit(condition, location);
  return diagnostics;
};

const upstreamNodeIds = (definition: HypagraphDefinition, nodeId: string): Set<string> => {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  const queue = [...(byId.get(nodeId)?.requires ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...(byId.get(current)?.requires ?? []));
  }
  return result;
};

const sourceType = (source: CheckFactSource): FactType => {
  switch (source) {
    case "passed":
    case "timedOut":
    case "cancelled": return "boolean";
    case "exitCode": return "integer";
    case "durationMs": return "number";
    case "status": return "string";
  }
};

const validateCheck = (node: NodeDefinition, location: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (!node.check) return [{ code: "check_definition_required", message: `Check node '${node.id}' requires a check definition.`, location: `${location}.check` }];
  const check = node.check as NodeDefinition["check"] & { kind?: string };
  if (check.kind !== "command") return [{ code: "unsupported_check_kind", message: `Check kind '${String(check.kind)}' is not executable in this release.`, location: `${location}.check.kind` }];
  if (!check.command.trim()) diagnostics.push({ code: "check_command_required", message: `Check node '${node.id}' requires a command.`, location: `${location}.check.command` });
  if (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0) diagnostics.push({ code: "invalid_check_timeout", message: `Check node '${node.id}' requires a positive integer timeout.`, location: `${location}.check.timeoutMs` });
  if (check.expectedExitCodes) {
    if (check.expectedExitCodes.length === 0 || check.expectedExitCodes.some((value) => !Number.isInteger(value))) diagnostics.push({ code: "invalid_expected_exit_codes", message: `Check node '${node.id}' requires integer expected exit codes.`, location: `${location}.check.expectedExitCodes` });
    if (new Set(check.expectedExitCodes).size !== check.expectedExitCodes.length) diagnostics.push({ code: "duplicate_expected_exit_code", message: `Check node '${node.id}' repeats an expected exit code.`, location: `${location}.check.expectedExitCodes` });
  }
  if (check.environmentVariables) {
    const names = new Set<string>();
    check.environmentVariables.forEach((name, index) => {
      const itemLocation = `${location}.check.environmentVariables[${index}]`;
      if (!ENVIRONMENT_VARIABLE_PATTERN.test(name)) diagnostics.push({ code: "invalid_environment_variable", message: `Environment variable '${name}' is not valid.`, location: itemLocation });
      const key = name.toUpperCase();
      if (names.has(key)) diagnostics.push({ code: "duplicate_environment_variable", message: `Check node '${node.id}' repeats environment variable '${name}'.`, location: itemLocation });
      names.add(key);
    });
  }
  if (check.retry) {
    if (!Number.isInteger(check.retry.maxAttempts) || check.retry.maxAttempts < 2 || check.retry.maxAttempts > MAX_CHECK_ATTEMPTS) {
      diagnostics.push({ code: "invalid_check_attempt_limit", message: `Check node '${node.id}' retry attempts must be between 2 and ${MAX_CHECK_ATTEMPTS}.`, location: `${location}.check.retry.maxAttempts` });
    }
    if (check.retry.retryOn.length === 0) diagnostics.push({ code: "retry_status_required", message: `Check node '${node.id}' must identify at least one retry status.`, location: `${location}.check.retry.retryOn` });
    const statuses = new Set<string>();
    check.retry.retryOn.forEach((status, index) => {
      const itemLocation = `${location}.check.retry.retryOn[${index}]`;
      if (!RETRY_STATUSES.has(status)) diagnostics.push({ code: "invalid_retry_status", message: `Retry status '${status}' is not supported.`, location: itemLocation });
      if (statuses.has(status)) diagnostics.push({ code: "duplicate_retry_status", message: `Check node '${node.id}' repeats retry status '${status}'.`, location: itemLocation });
      statuses.add(status);
    });
    if (check.retry.backoffMs !== undefined && (!Number.isInteger(check.retry.backoffMs) || check.retry.backoffMs < 0 || check.retry.backoffMs > MAX_RETRY_BACKOFF_MS)) {
      diagnostics.push({ code: "invalid_retry_backoff", message: `Check node '${node.id}' retry backoff must be between 0 and ${MAX_RETRY_BACKOFF_MS} milliseconds.`, location: `${location}.check.retry.backoffMs` });
    }
  }
  const mappings = new Set<string>();
  const contracts = new Map((node.produces ?? []).map((fact) => [fact.name, fact.type]));
  check.publish.forEach((mapping, index) => {
    const mappingLocation = `${location}.check.publish[${index}]`;
    if (mappings.has(mapping.fact)) diagnostics.push({ code: "duplicate_check_fact_mapping", message: `Check node '${node.id}' maps fact '${mapping.fact}' more than one time.`, location: mappingLocation });
    mappings.add(mapping.fact);
    const contractType = contracts.get(mapping.fact);
    if (!contractType) diagnostics.push({ code: "check_fact_not_declared", message: `Check node '${node.id}' maps undeclared fact '${mapping.fact}'.`, location: `${mappingLocation}.fact` });
    else if (contractType !== sourceType(mapping.source)) diagnostics.push({ code: "check_fact_type_mismatch", message: `Check source '${mapping.source}' cannot publish fact '${mapping.fact}' with type '${contractType}'.`, location: mappingLocation });
  });
  return diagnostics;
};

const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || (isRecord(value) && value.kind === "legacy-text");

const feedbackKey = (from: string, to: string): string => `${from}\u0000${to}`;

const iterationOutgoing = (definition: HypagraphDefinition, loop: LoopDefinition): Map<string, string[]> => {
  const nodes = new Set(loop.nodes);
  const feedback = new Set(loop.feedbackEdges.map((edge) => feedbackKey(edge.from, edge.to)));
  const outgoing = new Map(loop.nodes.map((nodeId) => [nodeId, [] as string[]]));
  for (const target of definition.nodes) {
    if (!nodes.has(target.id)) continue;
    for (const source of target.requires) {
      if (!nodes.has(source) || feedback.has(feedbackKey(source, target.id))) continue;
      outgoing.get(source)?.push(target.id);
    }
  }
  for (const values of outgoing.values()) values.sort();
  return outgoing;
};

const reachableFrom = (start: string, outgoing: ReadonlyMap<string, readonly string[]>): Set<string> => {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return result;
};

const hasCycle = (nodes: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): boolean => {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const values of outgoing.values()) for (const target of values) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  const queue = nodes.filter((node) => indegree.get(node) === 0).sort();
  let count = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    count += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
    queue.sort();
  }
  return count !== nodes.length;
};

export function validateDefinition(definition: HypagraphDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();
  const factOwners = new Map<string, string>();
  const factTypes = new Map<string, FactType>();
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
      if (owner && owner !== node.id) diagnostics.push({ code: "conflicting_fact_producer", message: `Fact '${fact.name}' has producers '${owner}' and '${node.id}'.`, location: `${factLocation}.name` });
      factOwners.set(fact.name, node.id);
      factTypes.set(fact.name, fact.type);
    });
  });

  definition.nodes.forEach((node, index) => node.requires.forEach((required, requiredIndex) => {
    if (!ids.has(required)) diagnostics.push({ code: "dangling_dependency", message: `Node '${node.id}' requires node '${required}', but that node does not exist.`, location: `nodes[${index}].requires[${requiredIndex}]` });
  }));

  definition.nodes.forEach((node, index) => {
    const location = `nodes[${index}]`;
    const kind = node.kind ?? "task";
    if (kind !== "gate" && node.gate) diagnostics.push({ code: "non_gate_has_gate", message: `Node '${node.id}' must not contain a gate definition.`, location: `${location}.gate` });
    if (kind !== "check" && node.check) diagnostics.push({ code: "non_check_has_check", message: `Node '${node.id}' must not contain a check definition.`, location: `${location}.check` });
    if (kind === "check") {
      if (node.gate) diagnostics.push({ code: "check_has_gate", message: `Check node '${node.id}' must not contain a gate definition.`, location: `${location}.gate` });
      diagnostics.push(...validateCheck(node, location));
    }
    if (kind === "gate") {
      if (!node.gate) { diagnostics.push({ code: "gate_definition_required", message: `Gate node '${node.id}' requires a gate definition.`, location: `${location}.gate` }); return; }
      if (node.produces && node.produces.length > 0) diagnostics.push({ code: "gate_produces_facts", message: `Gate node '${node.id}' must not produce facts.`, location: `${location}.produces` });
      if (node.gate.onTrue.length === 0 || node.gate.onFalse.length === 0) diagnostics.push({ code: "gate_routes_required", message: `Gate '${node.id}' requires true and false route targets.`, location: `${location}.gate` });
      const trueTargets = new Set(node.gate.onTrue);
      const falseTargets = new Set(node.gate.onFalse);
      if (trueTargets.size !== node.gate.onTrue.length || falseTargets.size !== node.gate.onFalse.length) diagnostics.push({ code: "duplicate_gate_target", message: `Gate '${node.id}' repeats a route target.`, location: `${location}.gate` });
      for (const targetId of [...node.gate.onTrue, ...node.gate.onFalse]) {
        const target = definition.nodes.find((item) => item.id === targetId);
        if (targetId === node.id) diagnostics.push({ code: "gate_targets_self", message: `Gate '${node.id}' must not target itself.`, location: `${location}.gate` });
        else if (!target) diagnostics.push({ code: "dangling_gate_target", message: `Gate '${node.id}' targets node '${targetId}', but that node does not exist.`, location: `${location}.gate` });
        else if (!target.requires.includes(node.id)) diagnostics.push({ code: "gate_target_dependency_required", message: `Gate target '${targetId}' must require gate '${node.id}'.`, location: `${location}.gate` });
      }
      for (const targetId of trueTargets) if (falseTargets.has(targetId)) diagnostics.push({ code: "overlapping_gate_target", message: `Gate target '${targetId}' occurs in both outcomes.`, location: `${location}.gate` });
      const upstream = upstreamNodeIds(definition, node.id);
      const availableFacts = new Set([...factOwners].filter(([, owner]) => upstream.has(owner)).map(([name]) => name));
      diagnostics.push(...validateCondition(node.gate.condition, factTypes, availableFacts, `${location}.gate.condition`));
    }
  });

  if (diagnostics.some((item) => item.code === "duplicate_node_id" || item.code === "dangling_dependency")) return diagnostics;
  const outgoing = buildOutgoing(definition.nodes);
  const components = stronglyConnectedComponents(definition.nodes.map((node) => node.id), outgoing);
  const cyclic = components.components.filter((component) => isCyclicComponent(component, outgoing));
  const claimedNodes = new Map<string, string>();
  const loopIds = new Set<string>();
  definition.loops.forEach((loop, index) => {
    const location = `loops[${index}]`;
    const loopNodes = new Set(loop.nodes);
    if (!ID_PATTERN.test(loop.id)) diagnostics.push({ code: "invalid_loop_id", message: `Loop ID '${loop.id}' is not valid.`, location: `${location}.id` });
    if (loopIds.has(loop.id)) diagnostics.push({ code: "duplicate_loop_id", message: `Loop ID '${loop.id}' occurs more than one time.`, location: `${location}.id` });
    loopIds.add(loop.id);
    if (new Set(loop.nodes).size !== loop.nodes.length) diagnostics.push({ code: "duplicate_loop_node", message: `Loop '${loop.id}' repeats a node.`, location: `${location}.nodes` });
    if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) diagnostics.push({ code: "invalid_loop_limit", message: `Loop '${loop.id}' must have a positive iteration limit.`, location: `${location}.maxIterations` });
    if (loop.patience !== undefined) diagnostics.push({ code: "loop_patience_not_available", message: `Loop '${loop.id}' cannot use patience before the M4 progress slice.`, location: `${location}.patience` });
    for (const node of loop.nodes) {
      if (!ids.has(node)) diagnostics.push({ code: "dangling_loop_node", message: `Loop '${loop.id}' refers to node '${node}', but that node does not exist.`, location: `${location}.nodes` });
      const owner = claimedNodes.get(node);
      if (owner && owner !== loop.id) diagnostics.push({ code: "overlapping_loop", message: `Node '${node}' is in loops '${owner}' and '${loop.id}'.`, location: `${location}.nodes` });
      claimedNodes.set(node, loop.id);
    }
    if (!loop.nodes.includes(loop.entry)) diagnostics.push({ code: "invalid_loop_entry", message: `Loop entry '${loop.entry}' is not in loop '${loop.id}'.`, location: `${location}.entry` });
    if (!loop.nodes.includes(loop.evaluateAfter)) diagnostics.push({ code: "invalid_loop_evaluator", message: `Loop evaluator '${loop.evaluateAfter}' is not in loop '${loop.id}'.`, location: `${location}.evaluateAfter` });
    const entryNode = definition.nodes.find((node) => node.id === loop.entry);
    const evaluatorNode = definition.nodes.find((node) => node.id === loop.evaluateAfter);
    if (entryNode && (entryNode.kind ?? "task") === "gate") diagnostics.push({ code: "loop_entry_cannot_be_gate", message: `Loop entry '${loop.entry}' must be a task or check node.`, location: `${location}.entry` });
    if (evaluatorNode && (evaluatorNode.kind ?? "task") === "gate") diagnostics.push({ code: "loop_evaluator_cannot_be_gate", message: `Loop evaluator '${loop.evaluateAfter}' must be a task or check node.`, location: `${location}.evaluateAfter` });

    for (const nodeId of loop.nodes) {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      for (const required of node.requires) {
        if (!loopNodes.has(required) && node.id !== loop.entry) diagnostics.push({ code: "loop_external_input_not_entry", message: `External dependency '${required}' must enter loop '${loop.id}' through '${loop.entry}'.`, location: `${location}.nodes` });
      }
    }
    for (const target of definition.nodes) {
      if (loopNodes.has(target.id)) continue;
      for (const required of target.requires) {
        if (loopNodes.has(required) && required !== loop.evaluateAfter) diagnostics.push({ code: "loop_external_output_not_evaluator", message: `External node '${target.id}' must leave loop '${loop.id}' through '${loop.evaluateAfter}'.`, location: `${location}.evaluateAfter` });
      }
    }

    for (const edge of loop.feedbackEdges) {
      const target = definition.nodes.find((node) => node.id === edge.to);
      if (!loopNodes.has(edge.from) || !loopNodes.has(edge.to) || !target?.requires.includes(edge.from)) diagnostics.push({ code: "invalid_feedback_edge", message: `Feedback edge '${edge.from} -> ${edge.to}' must be a dependency in loop '${loop.id}'.`, location: `${location}.feedbackEdges` });
      if (edge.from !== loop.evaluateAfter || edge.to !== loop.entry) diagnostics.push({ code: "invalid_feedback_boundary", message: `Feedback in loop '${loop.id}' must go from '${loop.evaluateAfter}' to '${loop.entry}'.`, location: `${location}.feedbackEdges` });
    }
    if (loop.feedbackEdges.length === 0) diagnostics.push({ code: "missing_feedback_edge", message: `Loop '${loop.id}' must identify at least one feedback edge.`, location: `${location}.feedbackEdges` });

    if (!cyclic.find((component) => sameSet(component, loop.nodes))) diagnostics.push({ code: "loop_scc_mismatch", message: `The nodes in loop '${loop.id}' must be the same as one cyclic component.`, location: `${location}.nodes` });

    if (loop.nodes.every((nodeId) => ids.has(nodeId)) && loopNodes.has(loop.entry) && loopNodes.has(loop.evaluateAfter)) {
      const iteration = iterationOutgoing(definition, loop);
      if (hasCycle(loop.nodes, iteration)) diagnostics.push({ code: "loop_iteration_not_acyclic", message: `Loop '${loop.id}' must become acyclic after feedback edges are removed.`, location: `${location}.feedbackEdges` });
      const fromEntry = reachableFrom(loop.entry, iteration);
      for (const nodeId of loop.nodes) if (!fromEntry.has(nodeId)) diagnostics.push({ code: "loop_node_not_reachable_from_entry", message: `Node '${nodeId}' is not reachable from loop entry '${loop.entry}'.`, location: `${location}.nodes` });
      for (const nodeId of loop.nodes) if (!reachableFrom(nodeId, iteration).has(loop.evaluateAfter)) diagnostics.push({ code: "loop_node_cannot_reach_evaluator", message: `Node '${nodeId}' cannot reach loop evaluator '${loop.evaluateAfter}'.`, location: `${location}.nodes` });
    }

    if (isLegacyPredicate(loop.successWhen)) {
      diagnostics.push({ code: typeof loop.successWhen === "string" ? "loop_predicate_must_be_typed" : "loop_predicate_revision_required", message: `Loop '${loop.id}' requires a typed success condition.`, location: `${location}.successWhen` });
    } else {
      const allowedOwners = new Set([...upstreamNodeIds(definition, loop.entry), ...loop.nodes]);
      const availableFacts = new Set([...factOwners].filter(([, owner]) => allowedOwners.has(owner)).map(([name]) => name));
      diagnostics.push(...validateCondition(loop.successWhen, factTypes, availableFacts, `${location}.successWhen`));
    }
  });
  for (const component of cyclic) {
    const matches = definition.loops.filter((loop) => sameSet(loop.nodes, component));
    if (matches.length === 0) diagnostics.push({ code: "undeclared_cycle", message: `Cyclic component [${component.join(", ")}] must be a bounded loop.`, location: "nodes", suggestion: "Add one loop with the same nodes and identify its feedback edges." });
    if (matches.length > 1) diagnostics.push({ code: "duplicate_loop_for_scc", message: `Cyclic component [${component.join(", ")}] has more than one loop declaration.`, location: "loops" });
  }
  return diagnostics;
}
''')

write("src/persistence/session-rebuild.ts", r'''import {
  HYPAGRAPH_EVENT_VERSION,
  HYPAGRAPH_SCHEMA_VERSION,
  type DomainEvent,
  type HypagraphDefinition,
  type HypagraphState,
  type PersistedHypagraph,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { dependenciesAreSatisfied } from "../domain/readiness.js";
import { replayEvents } from "../domain/projection.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  type PersistedEventBatch,
  validateEventAppend,
  WorkflowSequenceConflictError,
} from "./event-store.js";

interface ToolResultEntry {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    details?: { hypagraph?: unknown };
  };
}

interface CustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

interface StoredSnapshotShape {
  schemaVersion: number;
  workflowId: string;
  revision: number;
  sequence: number;
  snapshotHash: string;
  definition: unknown;
  runtime: unknown;
}

interface StoredPersisted {
  events: DomainEvent[];
  snapshot: StoredSnapshotShape;
}

const isToolResultEntry = (entry: unknown): entry is ToolResultEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ToolResultEntry>;
  return candidate.type === "message" && candidate.message?.role === "toolResult";
};

const isCustomEntry = (entry: unknown): entry is CustomEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CustomEntry>;
  return candidate.type === "custom" && typeof candidate.customType === "string";
};

const isStoredSnapshot = (value: unknown): value is StoredSnapshotShape => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSnapshotShape>;
  return (candidate.schemaVersion === HYPAGRAPH_SCHEMA_VERSION || candidate.schemaVersion === 2)
    && typeof candidate.workflowId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.sequence === "number"
    && typeof candidate.snapshotHash === "string"
    && !!candidate.definition
    && !!candidate.runtime;
};

export function isHypagraphState(value: unknown): value is HypagraphState {
  return isStoredSnapshot(value) && value.schemaVersion === HYPAGRAPH_SCHEMA_VERSION;
}

const isPersisted = (value: unknown): value is StoredPersisted => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPersisted>;
  return Array.isArray(candidate.events) && isStoredSnapshot(candidate.snapshot);
};

export const isPersistedEventBatch = (value: unknown): value is PersistedEventBatch => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedEventBatch> & { snapshot?: unknown };
  return candidate.version === 1
    && typeof candidate.workflowId === "string"
    && typeof candidate.expectedSequence === "number"
    && Array.isArray(candidate.events)
    && isStoredSnapshot(candidate.snapshot);
};

const event = (
  workflowId: string,
  revision: number,
  sequence: number,
  timestamp: string,
  type: DomainEvent["type"],
  data: Record<string, unknown> = {},
  nodeId?: string,
  attemptId?: string,
): DomainEvent => ({
  eventId: sha256({ workflowId, revision, sequence, type, nodeId: nodeId ?? null, attemptId: attemptId ?? null, migration: 1 }),
  workflowId,
  revision,
  sequence,
  type,
  version: HYPAGRAPH_EVENT_VERSION,
  timestamp,
  causationId: "schema-1-migration",
  correlationId: "schema-1-migration",
  ...(nodeId ? { nodeId } : {}),
  ...(attemptId ? { attemptId } : {}),
  data,
});

const migrateVersionOne = (value: unknown): PersistedHypagraph | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const source = value as {
    schemaVersion?: unknown;
    workflowId?: unknown;
    revision?: unknown;
    definition?: unknown;
    runtime?: { nodes?: Record<string, { status?: string; evidence?: unknown[]; startedAt?: string; completedAt?: string; blockedReason?: string }> };
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (source.schemaVersion !== 1 || typeof source.workflowId !== "string" || typeof source.revision !== "number") return undefined;
  if (!source.definition || !source.runtime?.nodes || typeof source.createdAt !== "string") return undefined;

  const definition = source.definition as HypagraphDefinition;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : source.createdAt;
  const events: DomainEvent[] = [event(source.workflowId, source.revision, 1, source.createdAt, "hypagraph.workflow.defined", { definition })];
  let sequence = 1;

  for (const node of definition.nodes) {
    const old = source.runtime.nodes[node.id];
    if (!old) continue;
    if (old.status === "blocked") {
      events.push(event(source.workflowId, source.revision, ++sequence, updatedAt, "hypagraph.node.blocked", { reason: old.blockedReason ?? "Migrated blocked node." }, node.id));
      continue;
    }
    if (old.status === "active" || old.status === "completed") {
      const attemptId = `migration-${sha256({ workflowId: source.workflowId, nodeId: node.id }).slice(0, 24)}`;
      events.push(event(source.workflowId, source.revision, ++sequence, old.startedAt ?? source.createdAt, "hypagraph.attempt.started", {}, node.id, attemptId));
      if (old.status === "completed") {
        const timestamp = old.completedAt ?? updatedAt;
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.attempt.result-submitted", { evidence: old.evidence ?? [] }, node.id, attemptId));
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.verification.started", {}, node.id, attemptId));
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.verification.passed", {}, node.id, attemptId));
      }
    }
  }

  let snapshot = replayEvents(events);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of definition.nodes) {
      const runtime = snapshot.runtime.nodes[node.id];
      if (!runtime || runtime.status !== "pending" || !dependenciesAreSatisfied(snapshot, node.id)) continue;
      events.push(event(source.workflowId, source.revision, ++sequence, updatedAt, "hypagraph.node.ready", {}, node.id));
      snapshot = replayEvents(events);
      changed = true;
    }
  }

  snapshot = replayEvents(events);
  return { events, snapshot };
};

const acceptPersisted = (stored: StoredPersisted): PersistedHypagraph => {
  const snapshot = replayEvents(stored.events);
  if (stored.snapshot.schemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== stored.snapshot.snapshotHash) throw new Error("The stored Hypagraph snapshot does not match its event stream.");
  return { events: structuredClone(stored.events), snapshot };
};

const appendStoredBatch = (
  latest: PersistedHypagraph | undefined,
  batch: PersistedEventBatch,
): PersistedHypagraph => {
  const sameWorkflow = latest?.snapshot.workflowId === batch.workflowId;
  const actualSequence = sameWorkflow ? latest.snapshot.sequence : 0;
  if (actualSequence !== batch.expectedSequence) {
    throw new WorkflowSequenceConflictError(batch.workflowId, batch.expectedSequence, actualSequence);
  }
  validateEventAppend(batch);

  const events = [...(sameWorkflow ? latest.events : []), ...structuredClone(batch.events)];
  const snapshot = replayEvents(events);
  const storedSchemaVersion = (batch.snapshot as unknown as StoredSnapshotShape).schemaVersion;
  if (storedSchemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== batch.snapshot.snapshotHash) {
    throw new Error("The stored Hypagraph event batch does not match its snapshot.");
  }
  return { events, snapshot };
};

export function restoreLatestSession(entries: readonly unknown[]): PersistedHypagraph | undefined {
  let latest: PersistedHypagraph | undefined;
  for (const entry of entries) {
    if (isCustomEntry(entry) && entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE) {
      if (!isPersistedEventBatch(entry.data)) throw new Error("The stored Hypagraph event batch is invalid.");
      latest = appendStoredBatch(latest, entry.data);
      continue;
    }
    if (!isToolResultEntry(entry) || !entry.message.toolName.startsWith("hypagraph_")) continue;
    const stored = entry.message.details?.hypagraph;
    if (isPersisted(stored)) {
      latest = acceptPersisted(stored);
      continue;
    }
    const migrated = migrateVersionOne(stored);
    if (migrated) latest = migrated;
  }
  return latest;
}

export function restoreLatestSnapshot(entries: readonly unknown[]): HypagraphState | undefined {
  return restoreLatestSession(entries)?.snapshot;
}
''')

write("src/pi/definition.ts", r'''import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { HypagraphDefinition } from "../domain/model.js";

const factTypeSchema = StringEnum(["boolean", "integer", "number", "string", "duration", "timestamp", "string-list"] as const);
const factValueSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String())]);
const conditionSchema = Type.Any({ description: "A Hypagraph typed condition AST. The domain validator checks its recursive structure, fact references, types, and limits." });
const checkFactSourceSchema = StringEnum(["passed", "status", "exitCode", "durationMs", "timedOut", "cancelled"] as const);
const retryStatusSchema = StringEnum(["failed", "timed_out", "error"] as const);

const factContractSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  required: Type.Optional(Type.Boolean()),
});

const gateSchema = Type.Object({
  condition: conditionSchema,
  onTrue: Type.Array(Type.String(), { minItems: 1 }),
  onFalse: Type.Array(Type.String(), { minItems: 1 }),
});

const factMappingSchema = Type.Object({
  source: checkFactSourceSchema,
  fact: Type.String(),
});

const retrySchema = Type.Object({
  maxAttempts: Type.Integer({ minimum: 2, maximum: 20 }),
  retryOn: Type.Array(retryStatusSchema, { minItems: 1, uniqueItems: true }),
  backoffMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
});

const commandCheckSchema = Type.Object({
  kind: StringEnum(["command"] as const),
  command: Type.String(),
  arguments: Type.Optional(Type.Array(Type.String())),
  workingDirectory: Type.Optional(Type.String()),
  timeoutMs: Type.Integer({ minimum: 1 }),
  expectedExitCodes: Type.Optional(Type.Array(Type.Integer())),
  environmentVariables: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { uniqueItems: true })),
  retry: Type.Optional(retrySchema),
  publish: Type.Array(factMappingSchema),
});

const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node ID" }),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  kind: Type.Optional(StringEnum(["task", "gate", "check"] as const)),
  requires: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String())),
  produces: Type.Optional(Type.Array(factContractSchema)),
  gate: Type.Optional(gateSchema),
  check: Type.Optional(commandCheckSchema),
  scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
});

const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopSchema = Type.Object({
  id: Type.String(),
  nodes: Type.Array(Type.String()),
  entry: Type.String(),
  evaluateAfter: Type.String(),
  feedbackEdges: Type.Array(feedbackEdgeSchema, { minItems: 1 }),
  successWhen: conditionSchema,
  maxIterations: Type.Integer({ minimum: 1 }),
});

export const definitionSchema = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  nodes: Type.Array(nodeSchema, { minItems: 1 }),
  loops: Type.Optional(Type.Array(loopSchema)),
  policy: Type.Optional(Type.Object({
    mode: Type.Optional(StringEnum(["guided", "strict"] as const)),
    requireEvidence: Type.Optional(Type.Boolean()),
  })),
});

export const evidenceSchema = Type.Object({
  ref: Type.String({ description: "Tool call, command, file, approval, or event reference" }),
  kind: Type.Optional(StringEnum(["tool", "command", "file", "approval", "note"] as const)),
  summary: Type.Optional(Type.String()),
});

export const factInputSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  value: factValueSchema,
  evidence: Type.Optional(Type.Array(evidenceSchema)),
});

export type HypagraphDefineInput = Static<typeof definitionSchema>;

export function normalizeDefinition(input: HypagraphDefineInput): HypagraphDefinition {
  return {
    title: input.title.trim(),
    goal: input.goal.trim(),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      ...(node.description === undefined ? {} : { description: node.description }),
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      requires: [...(node.requires ?? [])],
      acceptance: [...(node.acceptance ?? [])],
      ...(node.produces === undefined ? {} : { produces: node.produces.map((fact) => ({ ...fact })) }),
      ...(node.gate === undefined ? {} : { gate: structuredClone(node.gate) }),
      ...(node.check === undefined ? {} : {
        check: {
          kind: "command" as const,
          command: node.check.command,
          ...(node.check.arguments === undefined ? {} : { arguments: [...node.check.arguments] }),
          ...(node.check.workingDirectory === undefined ? {} : { workingDirectory: node.check.workingDirectory }),
          timeoutMs: node.check.timeoutMs,
          ...(node.check.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...node.check.expectedExitCodes] }),
          ...(node.check.environmentVariables === undefined ? {} : { environmentVariables: [...node.check.environmentVariables] }),
          ...(node.check.retry === undefined ? {} : {
            retry: {
              maxAttempts: node.check.retry.maxAttempts,
              retryOn: [...node.check.retry.retryOn],
              ...(node.check.retry.backoffMs === undefined ? {} : { backoffMs: node.check.retry.backoffMs }),
            },
          }),
          publish: node.check.publish.map((mapping) => ({ ...mapping })),
        },
      }),
      ...(node.scope === undefined ? {} : { scope: { paths: [...node.scope.paths] } }),
    })),
    loops: (input.loops ?? []).map((loop) => ({
      id: loop.id,
      nodes: [...loop.nodes],
      entry: loop.entry,
      evaluateAfter: loop.evaluateAfter,
      feedbackEdges: loop.feedbackEdges.map((edge) => ({ ...edge })),
      successWhen: structuredClone(loop.successWhen),
      maxIterations: loop.maxIterations,
    })),
    policy: { mode: input.policy?.mode ?? "guided", requireEvidence: input.policy?.requireEvidence ?? true },
  };
}
''')

write("src/graph/projection.ts", r'''import type {
  CheckResultStatus,
  HypagraphState,
  LoopStatus,
  NodeKind,
  NodeStatus,
  WorkflowPhase,
} from "../domain/model.js";

export type GraphEdgeKind = "dependency" | "route" | "feedback";
export type GraphRouteOutcome = "true" | "false";

export interface GraphViewCheckSummary {
  status: CheckResultStatus;
  exitCode?: number;
  error?: string;
}

export interface GraphViewNode {
  id: string;
  title: string;
  kind: NodeKind;
  status: NodeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  active: boolean;
  ready: boolean;
  factCount: number;
  evidenceCount: number;
  loopId?: string;
  iteration?: number;
  check?: GraphViewCheckSummary;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  selected: boolean;
  skipped: boolean;
  outcome?: GraphRouteOutcome;
}

export interface GraphViewFeedbackEdge {
  source: string;
  target: string;
}

export interface GraphViewLoop {
  id: string;
  nodeIds: string[];
  entryNodeId: string;
  evaluationNodeId: string;
  feedbackEdges: GraphViewFeedbackEdge[];
  maxIterations: number;
  status: LoopStatus;
  currentIteration: number;
  lastSuccess?: boolean;
  exitReason?: string;
}

export interface GraphViewModel {
  workflowId: string;
  revision: number;
  sequence: number;
  phase: WorkflowPhase;
  title: string;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  loops: GraphViewLoop[];
  readyNodeIds: string[];
  activeNodeId?: string;
}

const ACTIVE_STATUSES = new Set<NodeStatus>(["starting", "running", "awaiting_evidence", "verifying"]);

const edgeId = (
  kind: GraphEdgeKind,
  source: string,
  target: string,
  outcome?: GraphRouteOutcome,
): string => `${kind}:${source}:${target}${outcome === undefined ? "" : `:${outcome}`}`;

const edgeSort = (left: GraphViewEdge, right: GraphViewEdge): number =>
  left.source.localeCompare(right.source)
  || left.target.localeCompare(right.target)
  || left.kind.localeCompare(right.kind)
  || (left.outcome ?? "").localeCompare(right.outcome ?? "");

export function projectGraphView(state: HypagraphState): GraphViewModel {
  const loopByNode = new Map<string, string>();
  const feedbackKeys = new Set<string>();
  const loops: GraphViewLoop[] = state.definition.loops
    .map((loop) => {
      for (const nodeId of loop.nodes) loopByNode.set(nodeId, loop.id);
      const feedbackEdges = loop.feedbackEdges
        .map((edge) => ({ source: edge.from, target: edge.to }))
        .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
      for (const edge of feedbackEdges) feedbackKeys.add(`${edge.source}\u0000${edge.target}`);
      const runtime = state.runtime.loops[loop.id];
      return {
        id: loop.id,
        nodeIds: [...loop.nodes].sort(),
        entryNodeId: loop.entry,
        evaluationNodeId: loop.evaluateAfter,
        feedbackEdges,
        maxIterations: loop.maxIterations,
        status: runtime?.status ?? "inactive",
        currentIteration: runtime?.currentIteration ?? 0,
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const factCountByNode = new Map<string, number>();
  for (const fact of Object.values(state.runtime.facts)) {
    factCountByNode.set(fact.producerNodeId, (factCountByNode.get(fact.producerNodeId) ?? 0) + 1);
  }

  const nodes: GraphViewNode[] = state.definition.nodes
    .map((definition) => {
      const runtime = state.runtime.nodes[definition.id];
      if (!runtime) throw new Error(`Graph projection cannot find runtime state for node '${definition.id}'.`);
      const attempt = runtime.currentAttemptId === undefined
        ? undefined
        : runtime.attempts[runtime.currentAttemptId];
      const checkResult = attempt?.checkResult;
      return {
        id: definition.id,
        title: definition.title,
        kind: definition.kind ?? "task",
        status: runtime.status,
        attemptCount: runtime.attemptCount,
        ...(runtime.currentAttemptId === undefined ? {} : { currentAttemptId: runtime.currentAttemptId }),
        active: ACTIVE_STATUSES.has(runtime.status),
        ready: runtime.status === "ready",
        factCount: factCountByNode.get(definition.id) ?? 0,
        evidenceCount: runtime.evidence.length,
        ...(loopByNode.get(definition.id) === undefined ? {} : { loopId: loopByNode.get(definition.id)! }),
        ...(attempt?.iteration === undefined ? {} : { iteration: attempt.iteration }),
        ...(checkResult === undefined
          ? {}
          : {
              check: {
                status: checkResult.status,
                ...(checkResult.exitCode === undefined ? {} : { exitCode: checkResult.exitCode }),
                ...(checkResult.error === undefined ? {} : { error: checkResult.error }),
              },
            }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const routeTargetKeys = new Set<string>();
  const edges: GraphViewEdge[] = [];

  for (const gateNode of state.definition.nodes.filter((node) => node.kind === "gate" && node.gate)) {
    const selection = state.runtime.routes[gateNode.id];
    const routes: Array<{ outcome: GraphRouteOutcome; targets: string[] }> = [
      { outcome: "true", targets: gateNode.gate!.onTrue },
      { outcome: "false", targets: gateNode.gate!.onFalse },
    ];
    for (const route of routes) {
      for (const target of [...route.targets].sort()) {
        routeTargetKeys.add(`${gateNode.id}\u0000${target}`);
        const selected = selection?.outcomeId === route.outcome && selection.targetNodeIds.includes(target);
        edges.push({
          id: edgeId("route", gateNode.id, target, route.outcome),
          source: gateNode.id,
          target,
          kind: "route",
          selected,
          skipped: selection !== undefined && !selected,
          outcome: route.outcome,
        });
      }
    }
  }

  for (const targetNode of state.definition.nodes) {
    for (const source of [...targetNode.requires].sort()) {
      const key = `${source}\u0000${targetNode.id}`;
      if (feedbackKeys.has(key)) {
        edges.push({
          id: edgeId("feedback", source, targetNode.id),
          source,
          target: targetNode.id,
          kind: "feedback",
          selected: false,
          skipped: false,
        });
      } else if (!routeTargetKeys.has(key)) {
        edges.push({
          id: edgeId("dependency", source, targetNode.id),
          source,
          target: targetNode.id,
          kind: "dependency",
          selected: false,
          skipped: state.runtime.nodes[targetNode.id]?.status === "skipped",
        });
      }
    }
  }

  const readyNodeIds = nodes.filter((node) => node.ready).map((node) => node.id);
  const activeNodeId = nodes.find((node) => node.active)?.id;

  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    phase: state.phase,
    title: state.definition.title,
    nodes,
    edges: edges.sort(edgeSort),
    loops,
    readyNodeIds,
    ...(activeNodeId === undefined ? {} : { activeNodeId }),
  };
}

export function graphLayoutKey(view: GraphViewModel): string {
  return JSON.stringify({
    revision: view.revision,
    nodes: view.nodes.map((node) => [node.id, node.title, node.kind, node.loopId ?? null]),
    edges: view.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.outcome ?? null]),
    loops: view.loops.map((loop) => [loop.id, loop.nodeIds, loop.entryNodeId, loop.evaluationNodeId, loop.maxIterations]),
  });
}
''')

replace(
    "src/graph/renderer.ts",
    '  canvas.text(loop.x + 2, loop.y, `loop ${loop.id} [0/${loop.maxIterations}]`, Math.max(0, loop.width - 4));',
    '  const viewLoop = view.loops.find((candidate) => candidate.id === loop.id);\n  const iteration = viewLoop?.currentIteration ?? 0;\n  const suffix = viewLoop?.status === "completed" ? " complete" : viewLoop?.status === "requires_revision" ? " revise" : "";\n  canvas.text(loop.x + 2, loop.y, `loop ${loop.id} [${iteration}/${loop.maxIterations}]${suffix}`, Math.max(0, loop.width - 4));',
)
replace(
    "src/graph/renderer.ts",
    'const drawLoop = (canvas: CharacterCanvas, loop: GraphLayout["loops"][number], unicode: boolean): void => {',
    'const drawLoop = (canvas: CharacterCanvas, loop: GraphLayout["loops"][number], view: GraphViewModel, unicode: boolean): void => {',
)
replace(
    "src/graph/renderer.ts",
    '  for (const loop of layout.loops) drawLoop(canvas, loop, unicode);',
    '  for (const loop of layout.loops) drawLoop(canvas, loop, view, unicode);',
)

write("src/ui/format.ts", r'''import type { Diagnostic, HypagraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";

const activeNodeId = (state: HypagraphState): string | null => state.definition.nodes.find((node) => {
  const status = state.runtime.nodes[node.id]?.status;
  return status === "starting" || status === "running" || status === "awaiting_evidence" || status === "verifying";
})?.id ?? null;

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((item) => `- ${item.code}${item.location ? ` at ${item.location}` : ""}: ${item.message}${item.suggestion ? ` ${item.suggestion}` : ""}`)
    .join("\n");
}

export function workflowSummary(state: HypagraphState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const runtime of Object.values(state.runtime.nodes)) counts[runtime.status] = (counts[runtime.status] ?? 0) + 1;
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    phase: state.phase,
    title: state.definition.title,
    goal: state.definition.goal,
    counts,
    active: activeNodeId(state),
    ready: readyNodeIds(state),
    attempts: Object.fromEntries(Object.entries(state.runtime.nodes).map(([nodeId, runtime]) => [nodeId, runtime.attemptCount])),
    loops: state.definition.loops.map((loop) => {
      const runtime = state.runtime.loops[loop.id];
      return {
        id: loop.id,
        nodes: loop.nodes,
        maxIterations: loop.maxIterations,
        status: runtime?.status ?? "inactive",
        currentIteration: runtime?.currentIteration ?? 0,
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
      };
    }),
    snapshotHash: state.snapshotHash,
  };
}

export function renderWorkflow(state: HypagraphState): string {
  const summary = workflowSummary(state);
  const lines = [
    `${state.definition.title} - ${state.phase} (revision ${state.revision}, event ${state.sequence})`,
    `Goal: ${state.definition.goal}`,
    `Active: ${String(summary.active ?? "none")}`,
    `Ready: ${(summary.ready as string[]).join(", ") || "none"}`,
  ];
  if (state.definition.loops.length > 0) {
    lines.push("Loops:");
    for (const loop of state.definition.loops) {
      const runtime = state.runtime.loops[loop.id];
      lines.push(`- ${loop.id}: ${runtime?.status ?? "inactive"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}`);
    }
  }
  lines.push("Nodes:");
  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id]!;
    const attempt = runtime.currentAttemptId ? runtime.attempts[runtime.currentAttemptId] : undefined;
    lines.push(`- ${node.id}: ${runtime.status} - ${node.title} (attempts ${runtime.attemptCount}${attempt?.iteration === undefined ? "" : `, iteration ${attempt.iteration}`})`);
  }
  return lines.join("\n");
}

export function renderWidget(state: HypagraphState): string[] {
  const ready = readyNodeIds(state);
  const activeLoop = Object.values(state.runtime.loops).find((loop) => loop.status === "running");
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${activeLoop ? ` | Loop ${activeLoop.loopId}: ${activeLoop.currentIteration}/${activeLoop.maxIterations}` : ""}`,
  ];
}
''')

write("tests/validation.test.ts", r'''import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { buildOutgoing, stronglyConnectedComponents } from "../src/domain/scc.js";
import { validateDefinition } from "../src/domain/validate.js";

const successCondition = {
  kind: "compare" as const,
  left: { kind: "fact" as const, name: "tests.passed" },
  operator: "eq" as const,
  right: { kind: "literal" as const, value: true },
};

const cycleDefinition = (): HypagraphDefinition => ({
  title: "Repair loop",
  goal: "Make all tests pass",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    { id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

describe("static graph validation", () => {
  it("rejects a cycle that has no loop declaration", () => {
    const diagnostics = validateDefinition(cycleDefinition());
    expect(diagnostics.some((item) => item.code === "undeclared_cycle")).toBe(true);
  });

  it("accepts a structured bounded loop and starts iteration 1", () => {
    const definition = cycleDefinition();
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition)).toEqual([]);
    const created = createWorkflow(definition, "2026-07-21T00:00:00.000Z", "loop-workflow");
    if (!created.ok) throw new Error("The loop fixture did not start.");
    const transition = handleCommand(created.state, {
      type: "start-node",
      nodeId: "implement",
      attemptId: "attempt-1",
      commandId: "command-1",
      at: "2026-07-21T00:01:00.000Z",
    });
    expect(transition.ok).toBe(true);
    if (transition.ok) {
      expect(transition.events.map((event) => event.type)).toEqual(["hypagraph.loop.iteration-started", "hypagraph.attempt.started"]);
      expect(transition.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    }
  });

  it("rejects a free-text success predicate", () => {
    const definition = cycleDefinition();
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: "tests.passed == true",
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_predicate_must_be_typed")).toBe(true);
  });

  it("rejects a loop that is not the same as one cyclic component", () => {
    const definition = cycleDefinition();
    definition.nodes.push({ id: "report", title: "Report", requires: ["test"], acceptance: [] });
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test", "report"],
      entry: "implement",
      evaluateAfter: "report",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_scc_mismatch")).toBe(true);
  });

  it("rejects an external input that bypasses the entry", () => {
    const definition = cycleDefinition();
    definition.nodes.unshift({ id: "bootstrap", title: "Bootstrap", requires: [], acceptance: [] });
    definition.nodes[2]!.requires.push("bootstrap");
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_external_input_not_entry")).toBe(true);
  });

  it("finds only one-node components in generated directed acyclic graphs", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 15 }),
      fc.array(fc.tuple(fc.nat({ max: 14 }), fc.nat({ max: 14 })), { maxLength: 80 }),
      (size, candidates) => {
        const nodes = Array.from({ length: size }, (_, index) => ({ id: `n${index}`, requires: [] as string[] }));
        for (const [left, right] of candidates) {
          if (left >= size || right >= size || left === right) continue;
          const from = Math.min(left, right);
          const to = Math.max(left, right);
          const requirement = `n${from}`;
          if (!nodes[to]!.requires.includes(requirement)) nodes[to]!.requires.push(requirement);
        }
        const outgoing = buildOutgoing(nodes);
        const components = stronglyConnectedComponents(nodes.map((node) => node.id), outgoing).components;
        expect(components.every((component) => component.length === 1)).toBe(true);
      },
    ));
  });
});
''')

replace(
    "tests/graph-projection.test.ts",
    '{ id: "test", title: "Test", requires: ["implement"], acceptance: [] },',
    '{ id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },',
)
replace(
    "tests/graph-projection.test.ts",
    '        successWhen: "tests.failed == 0",',
    '        successWhen: { kind: "compare", left: { kind: "fact", name: "tests.passed" }, operator: "eq", right: { kind: "literal", value: true } },',
)
replace(
    "tests/graph-projection.test.ts",
    '    expect(view.loops).toEqual([expect.objectContaining({ id: "repair", nodeIds: ["implement", "test"], maxIterations: 3 })]);',
    '    expect(view.loops).toEqual([expect.objectContaining({ id: "repair", nodeIds: ["implement", "test"], maxIterations: 3, status: "inactive", currentIteration: 0 })]);',
)

replace(
    "tests/pi-definition.test.ts",
    '  it("uses the domain validator for invalid public check mappings", () => {',
    '''  it("normalizes a typed public loop condition", () => {
    const input: HypagraphDefineInput = {
      title: "Pi loop",
      goal: "Complete one iteration",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        { id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: { kind: "compare", left: { kind: "fact", name: "tests.passed" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const definition = normalizeDefinition(input);
    expect(definition.loops[0]?.successWhen).toEqual(input.loops?.[0]?.successWhen);
    expect(createWorkflow(definition, at, "workflow-pi-loop").ok).toBe(true);
  });

  it("uses the domain validator for invalid public check mappings", () => {''',
)

write("tests/loop-slice-one.test.ts", r'''import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { replayEvents } from "../src/domain/projection.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-22T16:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "One successful loop iteration",
  goal: "Pass the evaluation and release documentation",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
  commandPrefix: string,
  facts: HypagraphCommand & { type: "publish-facts" }["facts"] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${commandPrefix}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${commandPrefix}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${commandPrefix}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${commandPrefix}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${commandPrefix}-complete`, at });
};

describe("M4 Slice 1 loop execution", () => {
  it("completes one iteration and releases downstream work", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-one");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    expect(created.state.schemaVersion).toBe(3);
    expect(created.state.runtime.loops.repair).toMatchObject({ status: "inactive", currentIteration: 0 });
    expect(created.state.runtime.nodes.implement?.status).toBe("ready");
    expect(created.state.runtime.nodes.document?.status).toBe("pending");

    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(state.runtime.nodes.attempts).toBeUndefined();
    expect(state.runtime.nodes.implement?.attempts["attempt-implement"]).toMatchObject({ loopId: "repair", iteration: 1 });
    expect(state.runtime.nodes.test?.status).toBe("ready");
    expect(state.runtime.nodes.document?.status).toBe("pending");

    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: true }]);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ loopId: "repair", iteration: 1, attemptId: "attempt-test" });
    expect(state.runtime.loops.repair).toMatchObject({
      status: "completed",
      currentIteration: 1,
      lastSuccess: true,
      exitReason: "success",
      factsUsed: ["tests.passed"],
    });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: true, decision: "complete", factsUsed: ["tests.passed"] }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("ready");

    const evaluationTypes = events.filter((event) => event.loopId === "repair").map((event) => event.type);
    expect(evaluationTypes).toEqual([
      "hypagraph.loop.iteration-started",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.completed",
    ]);

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.snapshotHash).toBe(state.snapshotHash);
  });

  it("keeps downstream work blocked when the success condition is false", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-false");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: false }]);
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1, lastSuccess: false });
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(events.at(-1)?.type).toBe("hypagraph.loop.evaluated");
  });

  it("migrates a version 2 loop with text to requires_revision", () => {
    const legacyDefinition = definition() as HypagraphDefinition;
    legacyDefinition.loops[0]!.successWhen = "tests.passed == true";
    const legacyEvent: DomainEvent = {
      eventId: "legacy-defined",
      workflowId: "legacy-loop",
      revision: 1,
      sequence: 1,
      type: "hypagraph.workflow.defined",
      version: 1,
      timestamp: at,
      causationId: "legacy",
      correlationId: "legacy",
      data: { definition: legacyDefinition },
    };
    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_define",
        details: {
          hypagraph: {
            events: [legacyEvent],
            snapshot: {
              schemaVersion: 2,
              workflowId: "legacy-loop",
              revision: 1,
              sequence: 1,
              snapshotHash: "legacy-hash",
              definition: legacyDefinition,
              runtime: { nodes: {} },
            },
          },
        },
      },
    }]);
    expect(restored?.snapshot.schemaVersion).toBe(3);
    expect(restored?.snapshot.runtime.loops.repair).toMatchObject({ status: "requires_revision", currentIteration: 0, legacyPredicate: "tests.passed == true" });
    expect(restored?.snapshot.definition.loops[0]?.successWhen).toEqual({ kind: "legacy-text", text: "tests.passed == true" });
  });

  it("migrates a version 2 workflow without loops", () => {
    const noLoop: HypagraphDefinition = {
      title: "Legacy acyclic workflow",
      goal: "Migrate",
      nodes: [{ id: "task", title: "Task", requires: [], acceptance: [] }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const legacyEvent: DomainEvent = {
      eventId: "legacy-no-loop-defined",
      workflowId: "legacy-no-loop",
      revision: 1,
      sequence: 1,
      type: "hypagraph.workflow.defined",
      version: 1,
      timestamp: at,
      causationId: "legacy",
      correlationId: "legacy",
      data: { definition: noLoop },
    };
    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_define",
        details: {
          hypagraph: {
            events: [legacyEvent],
            snapshot: {
              schemaVersion: 2,
              workflowId: "legacy-no-loop",
              revision: 1,
              sequence: 1,
              snapshotHash: "legacy-hash",
              definition: noLoop,
              runtime: { nodes: {} },
            },
          },
        },
      },
    }]);
    expect(restored?.snapshot.schemaVersion).toBe(3);
    expect(restored?.snapshot.runtime.loops).toEqual({});
  });
});
''')

replace(
    "README.md",
    "M4 is the selected next milestone. It adds typed loop success conditions, deterministic feedback continuation, hard iteration limits, progress and patience rules, durable iteration history, and live Pi loop state. M3.1 parser adapters are deferred until after v0.5.",
    "M4 is the selected next milestone. Slice 1 adds typed loop success conditions, structured iteration-region validation, schema version 3, canonical loop runtime, and one successful iteration. Later slices add feedback continuation, hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
)

replace(
    "docs/m4-vertical-slice-plan.md",
    "### Slice 1 - Execute one successful iteration",
    "### Slice 1 - Execute one successful iteration\n\n- Status: implementation in progress",
)
