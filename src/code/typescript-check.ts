import ts from "typescript";
import type { Diagnostic } from "../domain/model.js";
import { SANDBOX_COMPILER_OPTIONS_RECORD } from "../domain/sandbox-runtime-identity.js";

const scriptTargetFromRecord = (): ts.ScriptTarget => {
  const name = String(SANDBOX_COMPILER_OPTIONS_RECORD.target ?? "ES2020");
  const table = ts.ScriptTarget as unknown as Record<string, ts.ScriptTarget | undefined>;
  return table[name] ?? ts.ScriptTarget.ES2020;
};

const moduleKindFromRecord = (): ts.ModuleKind => {
  const name = String(SANDBOX_COMPILER_OPTIONS_RECORD.module ?? "ESNext");
  const table = ts.ModuleKind as unknown as Record<string, ts.ModuleKind | undefined>;
  return table[name] ?? ts.ModuleKind.ESNext;
};

/**
 * Compiler options for the sandbox TypeScript check.
 * Derived from `SANDBOX_COMPILER_OPTIONS_RECORD` so one object is authoritative.
 */
export const DEFAULT_SANDBOX_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: scriptTargetFromRecord(),
  module: moduleKindFromRecord(),
  strict: Boolean(SANDBOX_COMPILER_OPTIONS_RECORD.strict),
  lib: (SANDBOX_COMPILER_OPTIONS_RECORD.lib as string[] | undefined) ?? ["lib.es2020.d.ts"],
  skipLibCheck: Boolean(SANDBOX_COMPILER_OPTIONS_RECORD.skipLibCheck ?? true),
  noEmitOnError: false,
  removeComments: Boolean(SANDBOX_COMPILER_OPTIONS_RECORD.removeComments ?? true),
};

const ambientPrelude = (inputs: readonly string[]): string => {
  const bindingFields = inputs
    .map((name) => `  readonly ${JSON.stringify(name)}: unknown;`)
    .join("\n");
  // No index signature when inputs are empty. Undeclared access fails at define time.
  return `
interface HypagraphBindings {
${bindingFields}
}
declare const inputs: HypagraphBindings;
declare const host: {
  call(action: string, args?: unknown): unknown;
};
`;
};

export type SandboxTypeCheckResult =
  | { ok: true; compiledJavaScript: string }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Type-check a sandbox program and emit JavaScript.
 * Line numbers in diagnostics refer to the author program, not the ambient prelude.
 */
export function checkSandboxProgramTypeScript(
  program: string,
  inputs: readonly string[] = [],
  compilerOptions: ts.CompilerOptions = DEFAULT_SANDBOX_COMPILER_OPTIONS,
): SandboxTypeCheckResult {
  if (!program.trim()) {
    return {
      ok: false,
      diagnostics: [{
        code: "code_program_empty",
        message: "A code program must not be empty.",
        location: "code.execution.program",
      }],
    };
  }

  const prelude = ambientPrelude(inputs);
  const preludeLineCount = prelude.split("\n").length;
  // Author programs may use top-level return. Wrap for type-check only.
  const wrappedSource = `${prelude}
function __hypagraphMain() {
${program}
}
`;
  // Line offset: prelude lines + "function __hypagraphMain() {" line
  const bodyLineOffset = preludeLineCount + 1;
  const fileName = "sandbox-program.ts";
  const options: ts.CompilerOptions = {
    ...compilerOptions,
    lib: compilerOptions.lib ?? ["lib.es2020.d.ts"],
  };

  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (name === fileName || name.endsWith(`/${fileName}`) || name.endsWith(`\\${fileName}`)) {
      return ts.createSourceFile(fileName, wrappedSource, languageVersion, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.writeFile = () => undefined;

  const programHandle = ts.createProgram([fileName], options, host);
  const emit = programHandle.emit();
  const allDiagnostics = ts.getPreEmitDiagnostics(programHandle).concat(emit.diagnostics);
  const errors = allDiagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const diagnostics: Diagnostic[] = errors.map((item) => {
      const message = ts.flattenDiagnosticMessageText(item.messageText, "\n");
      if (item.file && item.start !== undefined) {
        const { line, character } = item.file.getLineAndCharacterOfPosition(item.start);
        const programLine = line + 1 - bodyLineOffset;
        const displayLine = programLine > 0 ? programLine : line + 1;
        return {
          code: "code_typescript_error",
          message: `Line ${displayLine}, column ${character + 1}: ${message}`,
          location: `code.execution.program:${displayLine}:${character + 1}`,
        };
      }
      return {
        code: "code_typescript_error",
        message,
        location: "code.execution.program",
      };
    });
    return { ok: false, diagnostics };
  }

  // Emit the program body wrapped so the sandbox receives a return value.
  const transpile = ts.transpileModule(`function __hypagraphMain() {\n${program}\n}\n__hypagraphMain();`, {
    compilerOptions: {
      target: options.target ?? ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      strict: true,
      removeComments: true,
    },
    reportDiagnostics: false,
  });
  return { ok: true, compiledJavaScript: transpile.outputText };
}
