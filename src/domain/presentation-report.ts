import type { FactValue } from "./facts.js";
import type { HypagraphState } from "./model.js";
import { protectedTextPolicy } from "./presentation-redaction.js";

const formatFactValue = (
  value: FactValue,
  producerNodeId: string,
  text: (value: string, owner?: { nodeId?: string }) => string,
): string => {
  if (typeof value === "string") {
    return JSON.stringify(text(value, { nodeId: producerNodeId }));
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => (
      typeof item === "string" ? text(item, { nodeId: producerNodeId }) : item
    )));
  }
  return JSON.stringify(value);
};

/**
 * Build a canonical Markdown report for one interaction node.
 *
 * The content is a pure function of the workflow state and the node ID.
 * The function does not read the clock, the network, or the file system.
 * Protected evaluator detail is redacted with the shared presentation policy.
 */
export function renderInteractionReport(state: HypagraphState, nodeId: string): string {
  const policy = protectedTextPolicy(state);
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  const interaction = node?.interaction;
  const lines: string[] = [
    "# Interaction report",
    "",
    `Workflow: ${state.definition.title}`,
    `Workflow ID: ${state.workflowId}`,
    `Revision: ${state.revision}`,
    `Sequence: ${state.sequence}`,
    `Phase: ${state.phase}`,
    `Snapshot: ${state.snapshotHash}`,
    "",
    `Node: ${nodeId}`,
    `Title: ${node?.title ?? ""}`,
    `Status: ${runtime?.status ?? "unknown"}`,
    "",
    "## Question",
    "",
    interaction?.question ?? "",
    "",
  ];

  if (interaction?.responses && interaction.responses.length > 0) {
    lines.push("## Responses", "");
    for (const response of interaction.responses) {
      const recommended = response.recommended ? " (recommended)" : "";
      lines.push(`- \`${response.id}\`: ${response.label}${recommended}`);
      if (response.description?.trim()) lines.push(`  ${response.description.trim()}`);
    }
    lines.push("");
  } else if (interaction?.openAnswer) {
    lines.push(
      "## Open answer",
      "",
      `Prompt: ${interaction.openAnswer.prompt}`,
      `Fact: ${interaction.openAnswer.fact}`,
      `Max bytes: ${interaction.openAnswer.maxBytes}`,
      "",
    );
  }

  lines.push("## Facts", "");
  const factNames = Object.keys(state.runtime.facts).sort();
  if (factNames.length === 0) {
    lines.push("None.", "");
  } else {
    for (const name of factNames) {
      const fact = state.runtime.facts[name]!;
      lines.push(
        `- \`${name}\` (${fact.type}) = ${formatFactValue(fact.value, fact.producerNodeId, policy.text)}`,
      );
    }
    lines.push("");
  }

  lines.push("## Nodes", "");
  for (const definitionNode of state.definition.nodes) {
    const nodeRuntime = state.runtime.nodes[definitionNode.id];
    const title = policy.isProtectedNode(definitionNode.id)
      ? policy.text(definitionNode.title, { nodeId: definitionNode.id })
      : definitionNode.title;
    lines.push(`- \`${definitionNode.id}\`: ${nodeRuntime?.status ?? "unknown"} - ${title}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
