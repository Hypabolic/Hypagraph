import type { FactMapping, ReportParserDefinition } from "./model.js";
import "./model.js";

declare module "./model.js" {
  interface FileAssertionCheckDefinition {
    /** Transitional source compatibility only. Assertion checks do not execute these fields. */
    command?: undefined;
    arguments?: undefined;
    workingDirectory?: undefined;
    timeoutMs?: number;
    expectedExitCodes?: number[];
    environmentVariables?: string[];
    publish?: FactMapping[];
    parser?: ReportParserDefinition;
    reportPath?: string;
    maxReportBytes?: number;
  }

  interface GitAssertionCheckDefinition {
    /** Transitional source compatibility only. Assertion checks do not execute these fields. */
    command?: undefined;
    arguments?: undefined;
    workingDirectory?: undefined;
    timeoutMs?: number;
    expectedExitCodes?: number[];
    environmentVariables?: string[];
    publish?: FactMapping[];
    parser?: ReportParserDefinition;
    reportPath?: string;
    maxReportBytes?: number;
  }
}
