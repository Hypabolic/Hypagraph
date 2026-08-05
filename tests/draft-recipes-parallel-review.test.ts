import { describe, expect, it } from "vitest";
import { createEmptyDraft, projectDraftDefinition } from "../src/domain/draft.js";
import {
  applyImplementParallelReviewRecipe,
  buildImplementChildDefinition,
  buildParallelReviewChildDefinition,
  buildParallelReviewChildTemplates,
  buildReviewPanelAcceptance,
  DEFAULT_PARALLEL_REVIEW_ROLES,
} from "../src/domain/draft-recipes.js";
import { validateDefinition } from "../src/domain/validate.js";
import { validateDraftProjection } from "../src/pi/draft-tools.js";

describe("implement/parallel-review flagship recipe", () => {
  it("expands implement → review-panel → integrate with three review roles", () => {
    const draft = createEmptyDraft({
      draftId: "draft-flagship",
      objective: "Add an inspect command",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const result = applyImplementParallelReviewRecipe(
      draft,
      {},
      "2026-08-05T00:01:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.draft.nodes.map((n) => n.id);
    expect(ids).toEqual(["implement", "review-panel", "integrate"]);
    const panel = result.draft.nodes.find((n) => n.id === "review-panel");
    expect(panel?.requires).toEqual(["implement"]);
    expect(panel?.acceptance?.some((line) => /hypagoal_create_child/i.test(line))).toBe(true);
    expect(panel?.acceptance?.some((line) => /join\.passed/i.test(line))).toBe(true);
    expect(panel?.acceptance?.some((line) => /general.*tests.*security|general, tests, security/i.test(line))).toBe(true);

    const integrate = result.draft.nodes.find((n) => n.id === "integrate");
    expect(integrate?.requires).toEqual(["review-panel"]);

    expect(result.notes.some((n) => n.code === "recipe_implement_parallel_review")).toBe(true);
    expect(
      result.notes.filter((n) => n.code === "recipe_parallel_review_child_template"),
    ).toHaveLength(3);

    const projected = projectDraftDefinition(result.draft);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const diagnostics = validateDefinition(projected.definition);
    expect(diagnostics).toEqual([]);
    const validation = validateDraftProjection(result.draft);
    expect(validation.ok).toBe(true);
  });

  it("rejects fewer than two review roles", () => {
    const draft = createEmptyDraft({
      draftId: "draft-roles",
      objective: "x",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const result = applyImplementParallelReviewRecipe(
      draft,
      { reviewRoles: ["general"] },
      "2026-08-05T00:01:00.000Z",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("recipe_parallel_review_roles_min");
  });

  it("adds optional verify after integrate", () => {
    const draft = createEmptyDraft({
      draftId: "draft-verify",
      objective: "x",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    const result = applyImplementParallelReviewRecipe(
      draft,
      { includeVerifyTask: true },
      "2026-08-05T00:01:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes.map((n) => n.id)).toEqual([
      "implement",
      "review-panel",
      "integrate",
      "verify",
    ]);
    const verify = result.draft.nodes.find((n) => n.id === "verify");
    expect(verify?.requires).toEqual(["integrate"]);
    expect(verify?.produces?.[0]?.name).toBe("tests.passed");
  });

  it("builds parallel review child definitions that validate", () => {
    for (const role of DEFAULT_PARALLEL_REVIEW_ROLES) {
      const definition = buildParallelReviewChildDefinition({
        role,
        objective: `Review the inspect command as ${role}.`,
        scopePaths: ["src/**"],
      });
      const diagnostics = validateDefinition(definition);
      expect(diagnostics, role).toEqual([]);
      expect(definition.nodes[0]?.produces?.[0]?.name).toBe(`review.${role}.passed`);
    }
  });

  it("builds implement child definition that validates", () => {
    const definition = buildImplementChildDefinition({
      objective: "Implement the inspect command.",
      scopePaths: ["src/**"],
    });
    expect(validateDefinition(definition)).toEqual([]);
  });

  it("review panel acceptance names ordinary join rules", () => {
    const lines = buildReviewPanelAcceptance(["general", "tests"], "review-panel");
    expect(lines.some((l) => /exactly 2 child/i.test(l))).toBe(true);
    expect(lines.some((l) => /expectedBindingCount/i.test(l))).toBe(true);
    expect(lines.some((l) => /Do not declare produce join\.passed/i.test(l))).toBe(true);
  });

  it("default templates match implement-skill style roles", () => {
    const templates = buildParallelReviewChildTemplates();
    expect(templates.map((t) => t.role)).toEqual(["general", "tests", "security"]);
  });
});
