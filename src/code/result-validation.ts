import type {
  CodeResult,
  Diagnostic,
  FactInput,
} from "../domain/model.js";
import type { FactContract, FactType, FactValue } from "../domain/facts.js";
import { isFactValueOfType } from "../domain/facts.js";

export type CodeFactValidationResult =
  | { ok: true; facts: FactInput[] }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Validate the untrusted program return value against the node produces contract.
 * The controller must not trust bridge validation alone.
 */
export function validateCodeReturnValue(
  value: unknown,
  produces: readonly FactContract[],
  evidence: CodeResult["evidence"] = [],
): CodeFactValidationResult {
  const diagnostics: Diagnostic[] = [];
  if (value === undefined || value === null) {
    if (produces.some((contract) => contract.required)) {
      return {
        ok: false,
        diagnostics: [{
          code: "code_return_value_missing",
          message: "The code program did not return a value for its required facts.",
          location: "result.value",
        }],
      };
    }
    return { ok: true, facts: [] };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    if (produces.length === 1) {
      const contract = produces[0]!;
      if (!isFactValueOfType(contract.type, value as FactValue)) {
        return {
          ok: false,
          diagnostics: [{
            code: "code_return_type_mismatch",
            message: `The code program return value does not match fact '${contract.name}' type '${contract.type}'.`,
            location: `result.value.${contract.name}`,
          }],
        };
      }
      return {
        ok: true,
        facts: [{
          name: contract.name,
          type: contract.type,
          value: value as FactValue,
          evidence: structuredClone(evidence),
        }],
      };
    }
    return {
      ok: false,
      diagnostics: [{
        code: "code_return_value_not_object",
        message: "The code program must return an object whose keys are declared fact names.",
        location: "result.value",
      }],
    };
  }

  const record = value as Record<string, unknown>;
  const contracts = new Map(produces.map((contract) => [contract.name, contract]));
  const facts: FactInput[] = [];

  for (const [name, raw] of Object.entries(record)) {
    const contract = contracts.get(name);
    if (!contract) {
      diagnostics.push({
        code: "code_return_fact_not_declared",
        message: `The code program returned undeclared fact '${name}'.`,
        location: `result.value.${name}`,
      });
      continue;
    }
    if (!isFactValueOfType(contract.type, raw as FactValue)) {
      diagnostics.push({
        code: "code_return_type_mismatch",
        message: `Returned fact '${name}' does not match type '${contract.type}'.`,
        location: `result.value.${name}`,
      });
      continue;
    }
    facts.push({
      name,
      type: contract.type as FactType,
      value: raw as FactValue,
      evidence: structuredClone(evidence),
    });
  }

  for (const contract of produces) {
    if (contract.required && !facts.some((fact) => fact.name === contract.name)) {
      diagnostics.push({
        code: "code_required_fact_missing",
        message: `The code program did not return required fact '${contract.name}'.`,
        location: `result.value.${contract.name}`,
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, facts };
}
