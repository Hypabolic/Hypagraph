import { measureCondition, type Condition, type ValueExpression } from "./conditions.js";
import type { FactType, FactValue } from "./facts.js";
import type {
  CheckFactSource,
  CheckRetryPolicy,
  Diagnostic,
  FileAssertionCheckDefinition,
  GitAssertionCheckDefinition,
  HypagraphDefinition,
  LegacyLoopPredicate,
  LoopDefinition,
  MetricReportCheckDefinition,
  NodeDefinition,
} from "./model.js";
import { buildOutgoing, isCyclicComponent, stronglyConnectedComponents } from "./scc.js";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FACT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHECK_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const METRIC_SOURCE_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const FORBIDDEN_METRIC_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CHECK_ATTEMPTS = 20;
const MAX_RETRY_BACKOFF_MS = 86_400_000;
const MAX_REPORT_BYTES = 16_777_216;
const MAX_ASSERTION_BYTES = 16_777_216;
const MAX_INVALID_EVALUATIONS = 1_000;
const RETRY_STATUSES = new Set(["failed", "timed_out", "error"]);
const REPORT_PARSERS = {
  "test-report": "vitest-json",
  "lint-report": "eslint-json",
  "coverage-report": "istanbul-coverage-summary",
} as const;

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
const isFactValue = (value: unknown): value is FactValue => typeof value === "boolean" || typeof value === "number" || typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
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
  const dependencies = (targetId: string): string[] => (byId.get(targetId)?.requires ?? []).filter((sourceId) => !feedback.has(edgeKey(sourceId, targetId)));
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

const validateRetry = (nodeId: string, retry: CheckRetryPolicy | undefined, location: string): Diagnostic[] => {
  if (!retry) return [];
  const diagnostics: Diagnostic[] = [];
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 2 || retry.maxAttempts > MAX_CHECK_ATTEMPTS) diagnostics.push({ code: "invalid_check_attempt_limit", message: `Check node '${nodeId}' retry attempts must be between 2 and ${MAX_CHECK_ATTEMPTS}.`, location: `${location}.maxAttempts` });
  if (retry.retryOn.length === 0) diagnostics.push({ code: "retry_status_required", message: `Check node '${nodeId}' must identify at least one retry status.`, location: `${location}.retryOn` });
  const statuses = new Set<string>();
  retry.retryOn.forEach((status, index) => {
    const itemLocation = `${location}.retryOn[${index}]`;
    if (!RETRY_STATUSES.has(status)) diagnostics.push({ code: "invalid_retry_status", message: `Retry status '${status}' is not supported.`, location: itemLocation });
    if (statuses.has(status)) diagnostics.push({ code: "duplicate_retry_status", message: `Check node '${nodeId}' repeats retry status '${status}'.`, location: itemLocation });
    statuses.add(status);
  });
  if (retry.backoffMs !== undefined && (!Number.isInteger(retry.backoffMs) || retry.backoffMs < 0 || retry.backoffMs > MAX_RETRY_BACKOFF_MS)) diagnostics.push({ code: "invalid_retry_backoff", message: `Check node '${nodeId}' retry backoff must be between 0 and ${MAX_RETRY_BACKOFF_MS} milliseconds.`, location: `${location}.backoffMs` });
  return diagnostics;
};

const validateCommandFields = (nodeId: string, check: Extract<NodeDefinition["check"], { command: string }>, location: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (!check.command.trim()) diagnostics.push({ code: "check_command_required", message: `Check node '${nodeId}' requires a command.`, location: `${location}.command` });
  if (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0) diagnostics.push({ code: "invalid_check_timeout", message: `Check node '${nodeId}' requires a positive integer timeout.`, location: `${location}.timeoutMs` });
  if (check.expectedExitCodes) {
    if (check.expectedExitCodes.length === 0 || check.expectedExitCodes.some((value) => !Number.isInteger(value))) diagnostics.push({ code: "invalid_expected_exit_codes", message: `Check node '${nodeId}' requires integer expected exit codes.`, location: `${location}.expectedExitCodes` });
    if (new Set(check.expectedExitCodes).size !== check.expectedExitCodes.length) diagnostics.push({ code: "duplicate_expected_exit_code", message: `Check node '${nodeId}' repeats an expected exit code.`, location: `${location}.expectedExitCodes` });
  }
  if (check.environmentVariables) {
    const names = new Set<string>();
    check.environmentVariables.forEach((name, index) => {
      const itemLocation = `${location}.environmentVariables[${index}]`;
      if (!ENVIRONMENT_VARIABLE_PATTERN.test(name)) diagnostics.push({ code: "invalid_environment_variable", message: `Environment variable '${name}' is not valid.`, location: itemLocation });
      const key = name.toUpperCase();
      if (names.has(key)) diagnostics.push({ code: "duplicate_environment_variable", message: `Check node '${nodeId}' repeats environment variable '${name}'.`, location: itemLocation });
      names.add(key);
    });
  }
  return diagnostics;
};

interface ExpectedAssertionFact { type: FactType; required: boolean }

const assertionFacts = (check: FileAssertionCheckDefinition | GitAssertionCheckDefinition): Map<string, ExpectedAssertionFact> => {
  const facts = new Map<string, ExpectedAssertionFact>([
    [`${check.namespace}.success`, { type: "boolean", required: true }],
    [`${check.namespace}.kind`, { type: "string", required: true }],
  ]);
  if (check.kind === "file-assertion") {
    facts.set(`${check.namespace}.path`, { type: "string", required: true });
    facts.set(`${check.namespace}.exists`, { type: "boolean", required: false });
    facts.set(`${check.namespace}.size-bytes`, { type: "integer", required: false });
    if (check.assertion.kind === "size") facts.set(`${check.namespace}.expected-size-bytes`, { type: "integer", required: false });
    if (check.assertion.kind === "sha256") facts.set(`${check.namespace}.sha256`, { type: "string", required: false });
    if (check.assertion.kind === "text-contains") facts.set(`${check.namespace}.text-contains`, { type: "boolean", required: false });
  } else if (check.assertion.kind === "clean") {
    facts.set(`${check.namespace}.clean`, { type: "boolean", required: false });
    facts.set(`${check.namespace}.changed-paths`, { type: "string-list", required: false });
  } else if (check.assertion.kind === "branch") {
    facts.set(`${check.namespace}.branch`, { type: "string", required: false });
    facts.set(`${check.namespace}.expected-branch`, { type: "string", required: false });
  } else if (check.assertion.kind === "revision") {
    facts.set(`${check.namespace}.revision`, { type: "string", required: false });
    facts.set(`${check.namespace}.expected-revision`, { type: "string", required: false });
  } else {
    facts.set(`${check.namespace}.changed-paths`, { type: "string-list", required: false });
    facts.set(`${check.namespace}.expected-changed-paths`, { type: "string-list", required: false });
    facts.set(`${check.namespace}.changed-path-mode`, { type: "string", required: false });
  }
  return facts;
};

const validateAssertionContracts = (node: NodeDefinition, check: FileAssertionCheckDefinition | GitAssertionCheckDefinition, location: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const actual = new Map((node.produces ?? []).map((fact) => [fact.name, fact]));
  const expected = assertionFacts(check);
  for (const [name, specification] of expected) {
    const contract = actual.get(name);
    if (!contract) diagnostics.push({ code: "assertion_fact_contract_missing", message: `Assertion check '${node.id}' must declare fact '${name}'.`, location: `${location}.produces` });
    else {
      if (contract.type !== specification.type) diagnostics.push({ code: "assertion_fact_type_mismatch", message: `Assertion fact '${name}' must use type '${specification.type}'.`, location: `${location}.produces` });
      if (specification.required && !contract.required) diagnostics.push({ code: "assertion_fact_must_be_required", message: `Assertion fact '${name}' must be required.`, location: `${location}.produces` });
    }
  }
  for (const name of actual.keys()) if (!expected.has(name)) diagnostics.push({ code: "assertion_fact_not_produced", message: `Assertion check '${node.id}' cannot produce declared fact '${name}'.`, location: `${location}.produces` });
  return diagnostics;
};

const relativePathInvalid = (path: string): boolean => !path.trim() || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path) || path.split(/[\\/]+/).includes("..");

const validateAssertion = (node: NodeDefinition, check: FileAssertionCheckDefinition | GitAssertionCheckDefinition, location: string): Diagnostic[] => {
  const diagnostics = [...validateRetry(node.id, check.retry, `${location}.retry`)];
  if (check.version !== 1) diagnostics.push({ code: "unsupported_assertion_version", message: `Assertion check '${node.id}' requires version 1.`, location: `${location}.version` });
  if (!CHECK_NAMESPACE_PATTERN.test(check.namespace)) diagnostics.push({ code: "invalid_assertion_namespace", message: `Assertion namespace '${check.namespace}' is invalid.`, location: `${location}.namespace` });
  if (check.kind === "file-assertion") {
    const assertion = check.assertion;
    if (relativePathInvalid(assertion.path)) diagnostics.push({ code: "file_assertion_path_outside_workspace", message: `File assertion path '${assertion.path}' must remain inside the workspace.`, location: `${location}.assertion.path` });
    if (assertion.kind === "size" && (!Number.isInteger(assertion.bytes) || assertion.bytes < 0)) diagnostics.push({ code: "invalid_file_assertion_size", message: "The expected file size must be a non-negative integer.", location: `${location}.assertion.bytes` });
    if (assertion.kind === "sha256") {
      if (!/^[a-f0-9]{64}$/i.test(assertion.hash)) diagnostics.push({ code: "invalid_file_assertion_hash", message: "The expected SHA-256 value must contain 64 hexadecimal characters.", location: `${location}.assertion.hash` });
      if (assertion.maxBytes !== undefined && (!Number.isInteger(assertion.maxBytes) || assertion.maxBytes < 1 || assertion.maxBytes > MAX_ASSERTION_BYTES)) diagnostics.push({ code: "invalid_file_assertion_limit", message: `The hash read limit must be between 1 and ${MAX_ASSERTION_BYTES} bytes.`, location: `${location}.assertion.maxBytes` });
    }
    if (assertion.kind === "text-contains") {
      if (!assertion.text.length) diagnostics.push({ code: "file_assertion_text_required", message: "A text assertion requires non-empty expected text.", location: `${location}.assertion.text` });
      if (assertion.maxBytes !== undefined && (!Number.isInteger(assertion.maxBytes) || assertion.maxBytes < 1 || assertion.maxBytes > MAX_ASSERTION_BYTES)) diagnostics.push({ code: "invalid_file_assertion_limit", message: `The text read limit must be between 1 and ${MAX_ASSERTION_BYTES} bytes.`, location: `${location}.assertion.maxBytes` });
    }
  } else {
    const assertion = check.assertion;
    if (assertion.kind === "branch" && !assertion.name.trim()) diagnostics.push({ code: "git_assertion_branch_required", message: "A branch assertion requires a branch name.", location: `${location}.assertion.name` });
    if (assertion.kind === "revision" && !/^[a-f0-9]{7,64}$/i.test(assertion.sha)) diagnostics.push({ code: "invalid_git_revision", message: "The expected revision must be a hexadecimal Git object ID.", location: `${location}.assertion.sha` });
    if (assertion.kind === "changed-paths") {
      if (new Set(assertion.paths).size !== assertion.paths.length) diagnostics.push({ code: "duplicate_git_changed_path", message: "A changed-path assertion must not repeat paths.", location: `${location}.assertion.paths` });
      assertion.paths.forEach((path, index) => {
        if (relativePathInvalid(path)) diagnostics.push({ code: "invalid_git_changed_path", message: `Changed path '${path}' must be workspace-relative.`, location: `${location}.assertion.paths[${index}]` });
      });
    }
  }
  diagnostics.push(...validateAssertionContracts(node, check, location));
  return diagnostics;
};

const validateMetricReport = (node: NodeDefinition, check: MetricReportCheckDefinition, location: string): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const contracts = new Map((node.produces ?? []).map((fact) => [fact.name, fact]));
  if (check.parser.name !== "metric-json" || check.parser.version !== 1) diagnostics.push({ code: "report_parser_kind_mismatch", message: "A metric-report check requires parser 'metric-json' version 1.", location: `${location}.parser` });
  if (relativePathInvalid(check.reportPath)) diagnostics.push({ code: "report_path_outside_workspace", message: `Report path '${check.reportPath}' must remain inside the workspace.`, location: `${location}.reportPath` });
  if (check.maxReportBytes !== undefined && (!Number.isInteger(check.maxReportBytes) || check.maxReportBytes < 1 || check.maxReportBytes > MAX_REPORT_BYTES)) diagnostics.push({ code: "invalid_report_size_limit", message: `Report check '${node.id}' maximum report size must be between 1 and ${MAX_REPORT_BYTES} bytes.`, location: `${location}.maxReportBytes` });
  if (check.mappings.length === 0) diagnostics.push({ code: "metric_report_mapping_required", message: `Metric report check '${node.id}' requires at least one scalar mapping.`, location: `${location}.mappings` });

  const sources = new Set<string>();
  const mappedFacts = new Set<string>();
  check.mappings.forEach((mapping, index) => {
    const mappingLocation = `${location}.mappings[${index}]`;
    const segments = mapping.source.split(".");
    if (!METRIC_SOURCE_PATH_PATTERN.test(mapping.source) || segments.some((segment) => FORBIDDEN_METRIC_SEGMENTS.has(segment))) diagnostics.push({ code: "invalid_metric_source_path", message: `Metric source '${mapping.source}' is not a safe scalar path.`, location: `${mappingLocation}.source` });
    if (sources.has(mapping.source)) diagnostics.push({ code: "duplicate_metric_source", message: `Metric source '${mapping.source}' is mapped more than one time.`, location: `${mappingLocation}.source` });
    if (mappedFacts.has(mapping.fact)) diagnostics.push({ code: "duplicate_metric_fact", message: `Metric fact '${mapping.fact}' is mapped more than one time.`, location: `${mappingLocation}.fact` });
    sources.add(mapping.source);
    mappedFacts.add(mapping.fact);
    const contract = contracts.get(mapping.fact);
    if (!contract) diagnostics.push({ code: "metric_fact_not_declared", message: `Metric mapping refers to undeclared fact '${mapping.fact}'.`, location: `${mappingLocation}.fact` });
    else {
      if (contract.type !== mapping.type) diagnostics.push({ code: "metric_fact_type_mismatch", message: `Metric fact '${mapping.fact}' must use type '${mapping.type}'.`, location: mappingLocation });
      if (mapping.required !== false && !contract.required) diagnostics.push({ code: "metric_fact_must_be_required", message: `Required metric fact '${mapping.fact}' must use a required fact contract.`, location: `${mappingLocation}.fact` });
    }
  });
  for (const name of contracts.keys()) if (!mappedFacts.has(name)) diagnostics.push({ code: "metric_fact_not_mapped", message: `Metric report check '${node.id}' declares unmapped fact '${name}'.`, location: `${location}.mappings` });
  return diagnostics;
};

const validateCheck = (node: NodeDefinition, location: string): Diagnostic[] => {
  if (!node.check) return [{ code: "check_definition_required", message: `Check node '${node.id}' requires a check definition.`, location: `${location}.check` }];
  const check = node.check;
  const checkLocation = `${location}.check`;
  if (check.kind === "file-assertion" || check.kind === "git-assertion") return validateAssertion(node, check, checkLocation);

  const diagnostics: Diagnostic[] = [
    ...validateCommandFields(node.id, check, checkLocation),
    ...validateRetry(node.id, check.retry, `${checkLocation}.retry`),
  ];
  const contracts = new Map((node.produces ?? []).map((fact) => [fact.name, fact.type]));
  if (check.kind === "command") {
    const mappings = new Set<string>();
    check.publish.forEach((mapping, index) => {
      const mappingLocation = `${checkLocation}.publish[${index}]`;
      if (mappings.has(mapping.fact)) diagnostics.push({ code: "duplicate_check_fact_mapping", message: `Check node '${node.id}' maps fact '${mapping.fact}' more than one time.`, location: mappingLocation });
      mappings.add(mapping.fact);
      const contractType = contracts.get(mapping.fact);
      if (!contractType) diagnostics.push({ code: "check_fact_not_declared", message: `Check node '${node.id}' maps undeclared fact '${mapping.fact}'.`, location: `${mappingLocation}.fact` });
      else if (contractType !== sourceType(mapping.source)) diagnostics.push({ code: "check_fact_type_mismatch", message: `Check source '${mapping.source}' cannot publish fact '${mapping.fact}' with type '${contractType}'.`, location: mappingLocation });
    });
    return diagnostics;
  }
  if (check.kind === "metric-report") return [...diagnostics, ...validateMetricReport(node, check, checkLocation)];

  const expectedParser = REPORT_PARSERS[check.kind];
  if (check.parser.name !== expectedParser || check.parser.version !== 1) diagnostics.push({ code: "report_parser_kind_mismatch", message: `Check kind '${check.kind}' requires parser '${expectedParser}' version 1.`, location: `${checkLocation}.parser` });
  if (!check.reportPath.trim()) diagnostics.push({ code: "report_path_required", message: `Report check '${node.id}' requires a report path.`, location: `${checkLocation}.reportPath` });
  if (relativePathInvalid(check.reportPath)) diagnostics.push({ code: "report_path_outside_workspace", message: `Report path '${check.reportPath}' must remain inside the workspace.`, location: `${checkLocation}.reportPath` });
  if (!CHECK_NAMESPACE_PATTERN.test(check.namespace)) diagnostics.push({ code: "invalid_report_namespace", message: `Report namespace '${check.namespace}' is invalid.`, location: `${checkLocation}.namespace` });
  if (check.maxReportBytes !== undefined && (!Number.isInteger(check.maxReportBytes) || check.maxReportBytes < 1 || check.maxReportBytes > MAX_REPORT_BYTES)) diagnostics.push({ code: "invalid_report_size_limit", message: `Report check '${node.id}' maximum report size must be between 1 and ${MAX_REPORT_BYTES} bytes.`, location: `${checkLocation}.maxReportBytes` });
  if ((check.publish ?? []).length > 0) diagnostics.push({ code: "report_check_publish_not_allowed", message: `Report check '${node.id}' publishes parser facts and must not define command fact mappings.`, location: `${checkLocation}.publish` });
  if (contracts.size === 0) diagnostics.push({ code: "report_fact_contract_required", message: `Report check '${node.id}' must declare its parser-produced facts.`, location: `${location}.produces` });
  for (const name of contracts.keys()) if (!name.startsWith(`${check.namespace}.`)) diagnostics.push({ code: "report_fact_namespace_mismatch", message: `Report fact '${name}' must use namespace '${check.namespace}'.`, location: `${location}.produces` });
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
    if (loop.evaluation && (!Number.isInteger(loop.evaluation.maximumInvalidEvaluations) || loop.evaluation.maximumInvalidEvaluations < 1 || loop.evaluation.maximumInvalidEvaluations > MAX_INVALID_EVALUATIONS)) diagnostics.push({ code: "invalid_evaluation_limit", message: `Loop '${loop.id}' invalid-evaluation limit must be between 1 and ${MAX_INVALID_EVALUATIONS}.`, location: `${location}.evaluation.maximumInvalidEvaluations` });
    if (loop.failurePolicy !== undefined && !["fail-workflow", "block-dependants", "record-and-continue"].includes(loop.failurePolicy)) diagnostics.push({ code: "invalid_loop_failure_policy", message: `Loop '${loop.id}' has an invalid failure policy.`, location: `${location}.failurePolicy` });
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
      for (const required of node.requires) if (!loopNodes.has(required) && node.id !== loop.entry) diagnostics.push({ code: "loop_external_input_not_entry", message: `External dependency '${required}' must enter loop '${loop.id}' through '${loop.entry}'.`, location: `${location}.nodes` });
    }
    for (const target of definition.nodes) {
      if (loopNodes.has(target.id)) continue;
      for (const required of target.requires) if (loopNodes.has(required) && required !== loop.evaluateAfter) diagnostics.push({ code: "loop_external_output_not_evaluator", message: `External node '${target.id}' must leave loop '${loop.id}' through '${loop.evaluateAfter}'.`, location: `${location}.evaluateAfter` });
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
    const allowedOwners = new Set([...upstreamNodeIds(definition, loop.entry), ...loop.nodes]);
    const availableFacts = new Set([...factOwners].filter(([, owner]) => allowedOwners.has(owner)).map(([name]) => name));
    if (loop.evaluation) diagnostics.push(...validateCondition(loop.evaluation.validWhen, factTypes, availableFacts, `${location}.evaluation.validWhen`));
    if (isLegacyPredicate(loop.successWhen)) diagnostics.push({ code: typeof loop.successWhen === "string" ? "loop_predicate_must_be_typed" : "loop_predicate_revision_required", message: `Loop '${loop.id}' requires a typed success condition.`, location: `${location}.successWhen` });
    else diagnostics.push(...validateCondition(loop.successWhen, factTypes, availableFacts, `${location}.successWhen`));
  });
  for (const component of cyclic) {
    const matches = definition.loops.filter((loop) => sameSet(loop.nodes, component));
    if (matches.length === 0) diagnostics.push({ code: "undeclared_cycle", message: `Cyclic component [${component.join(", ")}] must be a bounded loop.`, location: "nodes", suggestion: "Add one loop with the same nodes and identify its feedback edges." });
    if (matches.length > 1) diagnostics.push({ code: "duplicate_loop_for_scc", message: `Cyclic component [${component.join(", ")}] has more than one loop declaration.`, location: "loops" });
  }
  return diagnostics;
}
