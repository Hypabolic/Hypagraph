import type { CheckResult, Diagnostic, FactInput } from "../domain/model.js";
import { parseVitestJsonReport } from "./test-report-parser.js";

export interface TestReportAdapterOptions {
  namespace?: string;
}

export type TestReportAdapterResult =
  | { ok: true; result: CheckResult }
  | { ok: false; diagnostics: Diagnostic[] };

const validNamespace = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;

const publicFactName = (name: string, namespace: string): string => {
  if (name === "passed") return `${namespace}.success`;
  if (name.startsWith("tests.")) return `${namespace}.${name.slice("tests.".length)}`;
  if (name.startsWith("testSuites.")) return `${namespace}.suites.${name.slice("testSuites.".length)}`;
  return `${namespace}.${name}`;
};

const namespaceFacts = (facts: FactInput[], namespace: string, evidence: CheckResult["evidence"]): FactInput[] => facts.map((fact) => ({
  ...fact,
  name: publicFactName(fact.name, namespace),
  evidence: structuredClone(evidence),
}));

export function adaptVitestJsonResult(
  commandResult: CheckResult,
  reportText: string,
  options: TestReportAdapterOptions = {},
): TestReportAdapterResult {
  const namespace = options.namespace ?? "tests";
  const diagnostics: Diagnostic[] = [];

  if (commandResult.checkKind !== "command") {
    diagnostics.push({
      code: "invalid_test_report_source",
      message: "A test report adapter requires a command check result.",
      location: "result.checkKind",
    });
  }
  if (!validNamespace.test(namespace)) {
    diagnostics.push({
      code: "invalid_test_report_namespace",
      message: "The test report fact namespace is invalid.",
      location: "adapter.namespace",
    });
  }
  if (commandResult.status === "timed_out" || commandResult.status === "cancelled" || commandResult.status === "interrupted" || commandResult.status === "error") {
    diagnostics.push({
      code: "test_report_command_incomplete",
      message: `The test report command ended with status '${commandResult.status}' and cannot publish parsed facts.`,
      location: "result.status",
    });
  }

  const parsed = parseVitestJsonReport(reportText);
  if (!parsed.ok) diagnostics.push(...parsed.diagnostics);
  if (diagnostics.length > 0 || !parsed.ok) return { ok: false, diagnostics };

  const facts = namespaceFacts(parsed.value.facts, namespace, commandResult.evidence);
  const parsedPassed = facts.find((fact) => fact.name === `${namespace}.success`)?.value;
  const commandPassed = commandResult.status === "passed";
  if (typeof parsedPassed !== "boolean" || parsedPassed !== commandPassed) {
    return {
      ok: false,
      diagnostics: [{
        code: "inconsistent_test_report_status",
        message: "The test report pass state must match the command result status.",
        location: "report.success",
      }],
    };
  }

  const names = facts.map((fact) => fact.name);
  if (new Set(names).size !== names.length) {
    return {
      ok: false,
      diagnostics: [{
        code: "duplicate_test_report_fact",
        message: "The test report adapter produced duplicate public fact names.",
        location: "adapter.namespace",
      }],
    };
  }

  return {
    ok: true,
    result: {
      ...structuredClone(commandResult),
      checkKind: "test-report",
      facts,
    },
  };
}
