/**
 * Skill free-form interaction recipe must validate and create.
 * Matches skills/hypagraph/SKILL.md demo product path and
 * docs/scratch/product-surface-e2e-path.md §4.
 */
import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-31T15:00:00.000Z";

/** Free-form interaction recipe from skills/hypagraph/SKILL.md. */
const skillInteractionDemoDefinition = (): HypagraphDefinition => ({
  title: "Product surface E2E",
  goal: "Run one isolated task, then ask the user to approve",
  nodes: [
    {
      id: "do-work",
      title: "Do the work",
      kind: "task",
      requires: [],
      acceptance: ["The work is done."],
    },
    {
      id: "approve-work",
      title: "Approve the work",
      kind: "interaction",
      requires: ["do-work"],
      acceptance: ["The user answers the approval question."],
      produces: [
        { name: "work.approved", type: "boolean", required: true },
      ],
      interaction: {
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Approve the completed work?",
        responses: [
          {
            id: "approve",
            label: "Approve",
            publish: [
              { name: "work.approved", type: "boolean", value: true },
            ],
          },
          {
            id: "reject",
            label: "Reject",
            publish: [
              { name: "work.approved", type: "boolean", value: false },
            ],
          },
        ],
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("skill free-form interaction recipe", () => {
  it("validates the SKILL.md demo definition", () => {
    // validateDefinition returns an empty diagnostic list when the definition is valid.
    expect(validateDefinition(skillInteractionDemoDefinition())).toEqual([]);
  });

  it("creates a root Hypagoal from free-form definition (no draftId)", () => {
    const definition = skillInteractionDemoDefinition();
    const created = createHypagoalWorkflow(definition, {
      workflowId: "workflow-skill-demo",
      goalId: "goal-skill-demo",
      goalWorkflowId: "workflow-skill-demo",
      at,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    expect(created.state.goal?.status).toBe("active");
    expect(created.state.definition.nodes.map((node) => node.id)).toEqual([
      "do-work",
      "approve-work",
    ]);
    const interaction = created.state.definition.nodes.find((node) => node.id === "approve-work");
    expect(interaction?.kind).toBe("interaction");
    expect(interaction?.requires).toEqual(["do-work"]);
    // First ready work is the task; interaction waits on it.
    expect(created.state.runtime.nodes["do-work"]?.status).toBe("ready");
    expect(created.state.runtime.nodes["approve-work"]?.status).not.toBe("ready");
  });
});
