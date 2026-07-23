import type { FactMapping } from "./model.js";
import "./model.js";

declare module "./model.js" {
  interface ReportCheckDefinition {
    /**
     * Transitional source-compatibility field for command-only callers.
     * Declarative report checks must leave this empty; parsed facts are
     * published from the report result itself.
     */
    publish?: FactMapping[];
  }

  interface MetricReportCheckDefinition {
    /**
     * Transitional source-compatibility field for command-only callers.
     * Metric facts are published only from declared scalar mappings.
     */
    publish?: FactMapping[];
  }
}
