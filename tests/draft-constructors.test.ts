import { describe, expect, it } from "vitest";
import {
  createEmptyDraft,
  projectDraftDefinition,
  summarizeDraft,
} from "../src/domain/draft.js";
import {
  addTaskToDraft,
  declareLoopOnDraft,
  requireOnDraft,
} from "../src/domain/draft-constructors.js";
import { applyImplementVerifyLoopRecipe } from "../src/domain/draft-recipes.js";
import { validateDefinition } from "../src/domain/validate.js";
import { validateDraftProjection } from "../src/pi/draft-tools.js";

const at = "2026-07-31T12:00:00.000Z";

const empty = () => createEmptyDraft({
  draftId: "draft-1",
  objective: "Ship a verified change",
  createdAt: at,
});

describe("S7.2 draft model and projection", () => {
  it("projects an empty draft as invalid without create side effects", () => {
    const draft = empty();
    const projected = projectDraftDefinition(draft);
    expect(projected.ok).toBe(false);
    if (!projected.ok) {
      expect(projected.diagnostics[0]?.code).toBe("draft_empty");
    }
    expect(summarizeDraft(draft).nodeCount).toBe(0);
  });

  it("projects tasks and validates through the shared validate path", () => {
    let draft = empty();
    const a = addTaskToDraft(draft, { id: "implement", title: "Implement", acceptance: ["done"] }, at);
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("expected ok");
    draft = a.draft;
    const validation = validateDraftProjection(draft);
    expect(validation.ok).toBe(true);
    expect(validation.definition?.nodes[0]?.id).toBe("implement");
  });
});

describe("S7.3 low-level constructors and loop tool", () => {
  it("owns feedback edges so invalid_feedback_edge cannot happen on the happy path", () => {
    let draft = empty();
    const implement = addTaskToDraft(draft, {
      id: "implement",
      title: "Implement",
      acceptance: ["code written"],
    }, at);
    expect(implement.ok).toBe(true);
    if (!implement.ok) throw new Error("implement");
    draft = implement.draft;

    const verify = addTaskToDraft(draft, {
      id: "verify",
      title: "Verify",
      acceptance: ["tests pass"],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      requires: ["implement"],
    }, at);
    expect(verify.ok).toBe(true);
    if (!verify.ok) throw new Error("verify");
    draft = verify.draft;

    // Intentionally do not add the cycle-closing requires edge by hand.
    const implementNode = draft.nodes.find((node) => node.id === "implement");
    expect(implementNode?.requires.includes("verify")).toBe(false);

    const loop = declareLoopOnDraft(draft, {
      loopId: "implement-verify-loop",
      entry: "implement",
      evaluateAfter: "verify",
      successWhen: {
        kind: "compare",
        left: { kind: "fact", name: "tests.passed" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maxIterations: 4,
    }, at);
    expect(loop.ok).toBe(true);
    if (!loop.ok) throw new Error(JSON.stringify(loop.diagnostics));
    draft = loop.draft;

    // Loop tool owns the feedback requires edge.
    const entry = draft.nodes.find((node) => node.id === "implement");
    expect(entry?.requires).toContain("verify");

    const projected = projectDraftDefinition(draft);
    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error(JSON.stringify(projected.diagnostics));

    expect(projected.definition.loops[0]?.feedbackEdges).toEqual([
      { from: "verify", to: "implement" },
    ]);
    expect(projected.definition.loops[0]?.nodes.sort()).toEqual(["implement", "verify"]);

    const diagnostics = validateDefinition(projected.definition);
    expect(diagnostics.filter((item) => item.code === "invalid_feedback_edge")).toEqual([]);
    expect(diagnostics.filter((item) => item.code === "loop_scc_mismatch")).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("adds require edges without creating runtime state", () => {
    let draft = empty();
    draft = (addTaskToDraft(draft, { id: "a", title: "A" }, at) as Extract<ReturnType<typeof addTaskToDraft>, { ok: true }>).draft;
    draft = (addTaskToDraft(draft, { id: "b", title: "B" }, at) as Extract<ReturnType<typeof addTaskToDraft>, { ok: true }>).draft;
    const required = requireOnDraft(draft, { from: "a", to: "b" }, at);
    expect(required.ok).toBe(true);
    if (!required.ok) throw new Error("require");
    expect(required.draft.nodes.find((node) => node.id === "b")?.requires).toContain("a");
    expect(required.draft.edges).toContainEqual({ from: "a", to: "b" });
  });
});

describe("S7.4 implement/verify recipe", () => {
  it("builds a valid loop without hand-authored feedbackEdges", () => {
    const draft = empty();
    const result = applyImplementVerifyLoopRecipe(draft, {
      maxIterations: 6,
      loopId: "iv-loop",
    }, at);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    // Recipe notes must not include author-supplied feedbackEdges.
    expect(JSON.stringify(result.draft.loops)).not.toContain("feedbackEdges");

    const projected = projectDraftDefinition(result.draft);
    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error(JSON.stringify(projected.diagnostics));

    expect(projected.definition.loops[0]?.feedbackEdges).toEqual([
      { from: "verify", to: "implement" },
    ]);
    const diagnostics = validateDefinition(projected.definition);
    expect(diagnostics).toEqual([]);

    const toolValidation = validateDraftProjection(result.draft);
    expect(toolValidation.ok).toBe(true);
  });
});
