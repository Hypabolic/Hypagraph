import { measureCondition, type Condition, type ValueExpression } from "./conditions.js";
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

const isLegacyPredicate = (value: unknown): value is string | LegacyLoopPredicate => typeof value === "string" || (isRecord(value) && value.kind === "legacy-text" && typeof value.text === "string");

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
    if (loop.progress) {
      const type = factTypes.get(loop.progress.fact);
      const owner = factOwners.get(loop.progress.fact);
      if (!type) diagnostics.push({ code: "unknown_progress_fact", message: `Loop '${loop.id}' uses undeclared progress fact '${loop.progress.fact}'.`, location: `${location}.progress.fact` });
      else if (!numericType(type)) diagnostics.push({ code: "progress_fact_not_numeric", message: `Loop progress fact '${loop.progress.fact}' must be numeric.`, location: `${location}.progress.fact` });
      if (owner && !loopNodes.has(owner)) diagnostics.push({ code: "progress_fact_not_in_loop", message: `Loop progress fact '${loop.progress.fact}' must be produced inside loop '${loop.id}'.`, location: `${location}.progress.fact` });
      if (loop.progress.direction !== "minimize" && loop.progress.direction !== "maximize") diagnostics.push({ code: "invalid_progress_direction", message: `Loop '${loop.id}' progress direction must be 'minimize' or 'maximize'.`, location: `${location}.progress.direction` });
      if (loop.progress.minDelta !== undefined && (!Number.isFinite(loop.progress.minDelta) || loop.progress.minDelta < 0)) diagnostics.push({ code: "invalid_progress_delta", message: `Loop '${loop.id}' minimum progress delta must be a finite non-negative number.`, location: `${location}.progress.minDelta` });
    }
    if (loop.patience !== undefined) {
      if (!loop.progress) diagnostics.push({ code: "patience_requires_progress", message: `Loop '${loop.id}' can use patience only with a progress definition.`, location: `${location}.patience` });
      if (!Number.isInteger(loop.patience) || loop.patience < 1) diagnostics.push({ code: "invalid_loop_patience", message: `Loop '${loop.id}' patience must be a positive integer.`, location: `${location}.patience` });
    }
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

    const feedbackEdges = new Set<string>();
    for (const edge of loop.feedbackEdges) {
      const key = feedbackKey(edge.from, edge.to);
      feedbackEdges.add(key);
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
