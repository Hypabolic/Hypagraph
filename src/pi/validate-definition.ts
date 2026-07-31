import type { Diagnostic, HypagraphDefinition } from "../domain/model.js";
import { validateDefinition } from "../domain/validate.js";
import {
  CodeDefinitionError,
  normalizeDefinition,
  type HypagraphDefineInput,
} from "./definition.js";

export interface HypagraphValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Present only when normalize and validate both succeed. */
  definition?: HypagraphDefinition;
}

/**
 * Validate a workflow definition without creating canonical state.
 *
 * Runs prepare and normalize, then structural validation. Returns diagnostics
 * for both prepare failures and domain validation failures.
 */
export function validateHypagraphDefinition(input: HypagraphDefineInput): HypagraphValidationResult {
  try {
    const definition = normalizeDefinition(input);
    const diagnostics = validateDefinition(definition);
    if (diagnostics.length > 0) {
      return { ok: false, diagnostics: structuredClone(diagnostics) };
    }
    return { ok: true, diagnostics: [], definition };
  } catch (error) {
    if (error instanceof CodeDefinitionError) {
      return { ok: false, diagnostics: structuredClone(error.diagnostics) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [{
        code: "definition_normalize_failed",
        message,
      }],
    };
  }
}

/**
 * Render a validation result for the Pi tool surface.
 */
export function renderHypagraphValidation(result: HypagraphValidationResult): string {
  if (result.ok) {
    const nodeCount = result.definition?.nodes.length ?? 0;
    const loopCount = result.definition?.loops.length ?? 0;
    return [
      "Hypagraph definition is valid.",
      `Nodes: ${nodeCount}`,
      `Loops: ${loopCount}`,
      "No canonical state was created.",
    ].join("\n");
  }
  const lines = result.diagnostics.map((item) => {
    const location = item.location ? ` at ${item.location}` : "";
    const suggestion = item.suggestion ? ` ${item.suggestion}` : "";
    return `- ${item.code}${location}: ${item.message}${suggestion}`;
  });
  return [
    "Hypagraph definition is invalid.",
    "No canonical state was created.",
    ...lines,
  ].join("\n");
}
