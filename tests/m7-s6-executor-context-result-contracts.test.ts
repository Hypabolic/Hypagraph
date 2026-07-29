import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESULT_EVIDENCE,
  DEFAULT_MAX_RESULT_FACTS,
  DEFAULT_MAX_SELECTED_ARTIFACTS,
  DEFAULT_MAX_SELECTED_FACTS,
  EXECUTOR_OUTCOMES,
  buildGoalAncestry,
  hashExecutorContext,
  materializeExecutorContext,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorOutcome,
  type ExecutorProfileRef,
  type ExecutorResult,
  type NodeExecutor,
} from "../src/domain/executor-contract.js";
import {
  createRootFamily,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { FactRecord } from "../src/domain/facts.js";
import type { FactInput, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-29T20:00:00.000Z";
const later = "2026-07-29T20:05:00.000Z";

const profile: ExecutorProfileRef = {
  profileId: "current-session-default",
  kind: "current-session",
};

const chainDefinition = (): HypagraphDefinition => ({
  title: "Executor contract fixture",
  goal: "Ship executor contracts",
  nodes: [
    {
      id: "upstream",
      title: "Upstream work",
      description: "Publish a fact for the next node.",
      requires: [],
      acceptance: ["upstream complete"],
      produces: [{ name: "upstream.ready", type: "boolean", required: true }],
      scope: { paths: ["src/**"] },
    },
    {
      id: "work",
      title: "Main work",
      description: "Consume upstream facts and return a structured result.",
      requires: ["upstream"],
      acceptance: ["work complete"],
      produces: [{ name: "work.done", type: "boolean", required: true }],
      scope: { paths: ["src/**"] },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const createStartedWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const startNode = (
  state: HypagraphState,
  nodeId: string,
  attemptId = `attempt-${nodeId}`,
): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const publishFact = (
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  facts: FactInput[],
): HypagraphState => {
  const result = handleCommand(state, {
    type: "publish-facts",
    nodeId,
    attemptId,
    facts,
    commandId: `publish-${nodeId}`,
    correlationId: `publish-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const submitAndSucceed = (
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): HypagraphState => {
  let next = state;
  const submit = handleCommand(next, {
    type: "submit-result",
    nodeId,
    attemptId,
    evidence: [{ ref: `evidence://${nodeId}`, kind: "note", summary: "done" }],
    commandId: `submit-${nodeId}`,
    correlationId: `submit-${nodeId}`,
    at: later,
  });
  if (!submit.ok) throw new Error(JSON.stringify(submit.diagnostics));
  next = submit.state;
  const begin = handleCommand(next, {
    type: "begin-verification",
    nodeId,
    attemptId,
    commandId: `begin-verify-${nodeId}`,
    correlationId: `begin-verify-${nodeId}`,
    at: later,
  });
  if (!begin.ok) throw new Error(JSON.stringify(begin.diagnostics));
  next = begin.state;
  const complete = handleCommand(next, {
    type: "complete-verification",
    nodeId,
    attemptId,
    passed: true,
    commandId: `complete-verify-${nodeId}`,
    correlationId: `complete-verify-${nodeId}`,
    at: later,
  });
  if (!complete.ok) throw new Error(JSON.stringify(complete.diagnostics));
  return complete.state;
};

const createFamilyAndState = (): {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  identity: ExecutorAttemptIdentity;
} => {
  const familyResult = createRootFamily({
    familyId: "family-s6",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  let state = createStartedWorkflow(chainDefinition(), "workflow-root", "goal-root");
  state = startNode(state, "upstream", "attempt-upstream");
  state = publishFact(state, "upstream", "attempt-upstream", [{
    name: "upstream.ready",
    type: "boolean",
    value: true,
    evidence: [{ ref: "evidence://upstream-fact", kind: "note" }],
  }]);
  state = submitAndSucceed(state, "upstream", "attempt-upstream");
  state = startNode(state, "work", "attempt-work-1");

  const identity: ExecutorAttemptIdentity = {
    familyId: "family-s6",
    goalId: "goal-root",
    workflowId: "workflow-root",
    revision: state.revision,
    nodeId: "work",
    attemptId: "attempt-work-1",
  };

  return { family: familyResult.family, state, identity };
};

const materializeDefault = (
  overrides?: Partial<Parameters<typeof materializeExecutorContext>[0]>,
) => {
  const base = createFamilyAndState();
  return materializeExecutorContext({
    family: base.family,
    state: base.state,
    identity: base.identity,
    profile,
    ...overrides,
  });
};

const matchingResult = (context: ExecutorContextEnvelope, overrides?: Partial<ExecutorResult>): ExecutorResult => ({
  familyId: context.identity.familyId,
  goalId: context.identity.goalId,
  workflowId: context.identity.workflowId,
  revision: context.identity.revision,
  nodeId: context.identity.nodeId,
  attemptId: context.identity.attemptId,
  outcome: "submitted",
  facts: [{ name: "work.done", type: "boolean", value: true }],
  evidence: [{ ref: "evidence://work", kind: "note", summary: "structured" }],
  artifacts: [],
  summary: "Work completed with a structured result.",
  diagnostics: [],
  usage: { turns: 1, totalTokens: 12 },
  ...overrides,
});

describe("m7-s6 executor context and result contracts", () => {
  it("materialize produces a reproducible hash for identical pure inputs", () => {
    const a = materializeDefault();
    const b = materializeDefault();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.value).toEqual(b.value);
    expect(hashExecutorContext(a.value)).toBe(hashExecutorContext(b.value));
    expect(hashExecutorContext(a.value)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("materialize includes attempt identity and bounded selected facts", () => {
    const result = materializeDefault({
      maxSelectedFacts: 1,
      selectedFactNames: ["upstream.ready", "missing.fact"],
      attemptBudget: { maximumTurns: 3, maximumTokens: 1000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const envelope = result.value;
    expect(envelope.identity).toEqual({
      familyId: "family-s6",
      goalId: "goal-root",
      workflowId: "workflow-root",
      revision: envelope.identity.revision,
      nodeId: "work",
      attemptId: "attempt-work-1",
    });
    expect(envelope.profile).toEqual(profile);
    expect(envelope.rootObjective).toBe("Ship executor contracts");
    expect(envelope.localObjective).toBe("Ship executor contracts");
    expect(envelope.nodeIntent).toContain("Consume upstream facts");
    expect(envelope.acceptanceCriteria).toEqual(["work complete"]);
    expect(envelope.scope.writePaths).toEqual(["src/**"]);
    expect(envelope.selectedFacts).toHaveLength(1);
    expect(envelope.selectedFacts[0]).toMatchObject({
      name: "upstream.ready",
      type: "boolean",
      value: true,
      producerNodeId: "upstream",
      attemptId: "attempt-upstream",
    });
    expect(envelope.selectedFacts.length).toBeLessThanOrEqual(DEFAULT_MAX_SELECTED_FACTS);
    expect(envelope.predecessorSummaries).toEqual([
      expect.objectContaining({
        nodeId: "upstream",
        status: "succeeded",
      }),
    ]);
    expect(envelope.attemptBudget).toEqual({ maximumTurns: 3, maximumTokens: 1000 });
    expect(envelope.resultProtocol.version).toBe(1);
    expect(envelope.resultProtocol.outcomes).toEqual([...EXECUTOR_OUTCOMES]);
    expect(envelope.resultProtocol.factContracts).toEqual([
      { name: "work.done", type: "boolean", required: true },
    ]);
    expect(envelope.workspace).toBeUndefined();
    expect(buildGoalAncestry(
      createFamilyAndState().family,
      "goal-root",
    )).toEqual([{
      goalId: "goal-root",
      workflowId: "workflow-root",
      depth: 0,
    }]);
  });

  it("materialize rejects identity mismatches against family and state", () => {
    const base = createFamilyAndState();
    const badFamily = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: { ...base.identity, familyId: "other-family" },
      profile,
    });
    expect(badFamily.ok).toBe(false);
    if (badFamily.ok) return;
    expect(badFamily.diagnostics[0]?.code).toBe("executor_context_family_mismatch");

    const badRevision = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: { ...base.identity, revision: base.identity.revision + 1 },
      profile,
    });
    expect(badRevision.ok).toBe(false);
    if (badRevision.ok) return;
    expect(badRevision.diagnostics[0]?.code).toBe("executor_context_revision_mismatch");

    const badNode = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: { ...base.identity, nodeId: "missing-node" },
      profile,
    });
    expect(badNode.ok).toBe(false);
    if (badNode.ok) return;
    expect(badNode.diagnostics[0]?.code).toBe("executor_context_node_missing");
  });

  it("validate accepts a well-formed matching result", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;

    const result = matchingResult(materialized.value);
    const validated = validateExecutorResult(materialized.value, result);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.outcome).toBe("submitted");
    expect(validated.value.facts).toEqual([{ name: "work.done", type: "boolean", value: true }]);
    expect(validated.value.evidence[0]?.ref).toBe("evidence://work");
    expect(validated.value.usage).toEqual({ turns: 1, totalTokens: 12 });
  });

  it("validate rejects identity mismatch for each identity key", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const cases: Array<{ field: keyof ExecutorAttemptIdentity; value: string | number }> = [
      { field: "familyId", value: "stale-family" },
      { field: "goalId", value: "stale-goal" },
      { field: "workflowId", value: "stale-workflow" },
      { field: "revision", value: context.identity.revision + 9 },
      { field: "nodeId", value: "stale-node" },
      { field: "attemptId", value: "stale-attempt" },
    ];

    for (const item of cases) {
      const result = matchingResult(context, {
        [item.field]: item.value,
      } as Partial<ExecutorResult>);
      const validated = validateExecutorResult(context, result);
      expect(validated.ok, `expected mismatch for ${item.field}`).toBe(false);
      if (validated.ok) continue;
      expect(validated.diagnostics.some((d) => d.code === "executor_result_identity_mismatch")).toBe(true);
      expect(validated.diagnostics.some((d) => d.location === item.field)).toBe(true);
    }
  });

  it("validate rejects missing outcome and malformed facts", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const missingOutcome = matchingResult(context);
    delete (missingOutcome as { outcome?: string }).outcome;
    const missing = validateExecutorResult(context, missingOutcome);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics.some((d) => d.code === "executor_result_outcome_missing")).toBe(true);
    }

    const unknownOutcome = validateExecutorResult(
      context,
      matchingResult(context, { outcome: "succeeded" as ExecutorResult["outcome"] }),
    );
    expect(unknownOutcome.ok).toBe(false);
    if (!unknownOutcome.ok) {
      expect(unknownOutcome.diagnostics.some((d) => d.code === "executor_result_outcome_unknown")).toBe(true);
    }

    const badFacts = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [{ name: "work.done", type: "boolean", value: "not-boolean" as unknown as boolean }],
      }),
    );
    expect(badFacts.ok).toBe(false);
    if (!badFacts.ok) {
      expect(badFacts.diagnostics.some((d) => d.code === "executor_result_invalid_fact_value")).toBe(true);
    }

    const notArrayFacts = validateExecutorResult(
      context,
      matchingResult(context, { facts: "nope" as unknown as FactInput[] }),
    );
    expect(notArrayFacts.ok).toBe(false);
    if (!notArrayFacts.ok) {
      expect(notArrayFacts.diagnostics.some((d) => d.code === "executor_result_invalid_facts")).toBe(true);
    }
  });

  it("validate rejects raw string and non-envelope results", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const rawText = validateExecutorResult(context, "the model finished successfully");
    expect(rawText.ok).toBe(false);
    if (!rawText.ok) {
      expect(rawText.diagnostics[0]?.code).toBe("executor_result_raw_text");
    }

    const arrayResult = validateExecutorResult(context, [{ outcome: "submitted" }]);
    expect(arrayResult.ok).toBe(false);
    if (!arrayResult.ok) {
      expect(arrayResult.diagnostics[0]?.code).toBe("executor_result_not_object");
    }

    const missing = validateExecutorResult(context, null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics[0]?.code).toBe("executor_result_missing");
    }
  });

  it("validate does not mutate the input result object", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const result = matchingResult(context, {
      facts: [{
        name: "work.done",
        type: "boolean",
        value: true,
        evidence: [{ ref: "evidence://inner", kind: "note" }],
      }],
    });
    const snapshot = structuredClone(result);
    const validated = validateExecutorResult(context, result);
    expect(validated.ok).toBe(true);
    expect(result).toEqual(snapshot);

    if (!validated.ok) return;
    validated.value.summary = "mutated accepted value";
    validated.value.facts[0]!.value = false;
    expect(result.summary).toBe(snapshot.summary);
    expect(result.facts[0]!.value).toBe(true);
  });

  it("enforces max summary and diagnostics bounds from the protocol", () => {
    const materialized = materializeDefault({
      maxResultSummaryChars: 8,
      maxResultDiagnostics: 1,
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const longSummary = validateExecutorResult(
      context,
      matchingResult(context, { summary: "this summary is too long" }),
    );
    expect(longSummary.ok).toBe(false);
    if (!longSummary.ok) {
      expect(longSummary.diagnostics.some((d) => d.code === "executor_result_summary_too_long")).toBe(true);
    }

    const tooManyDiagnostics = validateExecutorResult(
      context,
      matchingResult(context, {
        diagnostics: [
          { code: "a", message: "one" },
          { code: "b", message: "two" },
        ],
      }),
    );
    expect(tooManyDiagnostics.ok).toBe(false);
    if (!tooManyDiagnostics.ok) {
      expect(tooManyDiagnostics.diagnostics.some((d) => d.code === "executor_result_diagnostics_too_many")).toBe(true);
    }
  });

  it("supports a tiny in-memory stub executor that returns structured results only", async () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;
    const contextSnapshot = structuredClone(context);

    const stub: NodeExecutor = {
      id: "memory-stub",
      version: 1,
      async execute(envelope, signal) {
        expect(signal.aborted).toBe(false);
        // Stub never mutates the context envelope.
        return matchingResult(envelope, {
          summary: "stub submitted",
          usage: { turns: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        });
      },
    };

    const controller = new AbortController();
    const raw = await stub.execute(context, controller.signal);
    expect(context).toEqual(contextSnapshot);

    const validated = validateExecutorResult(context, raw);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.summary).toBe("stub submitted");
    expect(validated.value.outcome).toBe("submitted");
  });

  it("rejects a class-instance result envelope", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    class ResultEnvelope {
      constructor(public payload: ExecutorResult) {}
    }
    const instance = new ResultEnvelope(matchingResult(materialized.value));
    const validated = validateExecutorResult(materialized.value, instance);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.diagnostics[0]?.code).toBe("executor_result_not_object");
    }
  });

  it("materialize returns diagnostics for nullish input and incomplete family or state", () => {
    const nullInput = materializeExecutorContext(null as unknown as Parameters<typeof materializeExecutorContext>[0]);
    expect(nullInput.ok).toBe(false);
    if (!nullInput.ok) {
      expect(nullInput.diagnostics[0]?.code).toBe("executor_context_invalid_input");
    }

    const undefinedInput = materializeExecutorContext(
      undefined as unknown as Parameters<typeof materializeExecutorContext>[0],
    );
    expect(undefinedInput.ok).toBe(false);
    if (!undefinedInput.ok) {
      expect(undefinedInput.diagnostics[0]?.code).toBe("executor_context_invalid_input");
    }

    const base = createFamilyAndState();
    const incompleteFamily = materializeExecutorContext({
      family: {
        familyId: base.family.familyId,
        rootGoalId: base.family.rootGoalId,
      } as GoalFamilyRuntime,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(incompleteFamily.ok).toBe(false);
    if (!incompleteFamily.ok) {
      expect(incompleteFamily.diagnostics[0]?.code).toBe("executor_context_invalid_family");
      expect(incompleteFamily.diagnostics[0]?.location).toBe("family.members");
    }

    // Valid identifiers and members, but missing bindings must not throw.
    const missingBindings = materializeExecutorContext({
      family: {
        familyId: base.family.familyId,
        rootGoalId: base.family.rootGoalId,
        members: base.family.members,
      } as GoalFamilyRuntime,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(missingBindings.ok).toBe(false);
    if (!missingBindings.ok) {
      expect(missingBindings.diagnostics[0]?.code).toBe("executor_context_invalid_family");
      expect(missingBindings.diagnostics[0]?.location).toBe("family.bindings");
    }

    const malformedBindings = materializeExecutorContext({
      family: {
        ...base.family,
        bindings: null,
      } as unknown as GoalFamilyRuntime,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(malformedBindings.ok).toBe(false);
    if (!malformedBindings.ok) {
      expect(malformedBindings.diagnostics[0]?.code).toBe("executor_context_invalid_family");
      expect(malformedBindings.diagnostics[0]?.location).toBe("family.bindings");
    }

    const familyArray = materializeExecutorContext({
      family: [] as unknown as GoalFamilyRuntime,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(familyArray.ok).toBe(false);
    if (!familyArray.ok) {
      expect(familyArray.diagnostics[0]?.code).toBe("executor_context_invalid_family");
    }

    const incompleteState = materializeExecutorContext({
      family: base.family,
      state: {
        workflowId: base.state.workflowId,
        revision: base.state.revision,
      } as HypagraphState,
      identity: base.identity,
      profile,
    });
    expect(incompleteState.ok).toBe(false);
    if (!incompleteState.ok) {
      expect(incompleteState.diagnostics[0]?.code).toBe("executor_context_invalid_state");
    }

    const stateArray = materializeExecutorContext({
      family: base.family,
      state: [] as unknown as HypagraphState,
      identity: base.identity,
      profile,
    });
    expect(stateArray.ok).toBe(false);
    if (!stateArray.ok) {
      expect(stateArray.diagnostics[0]?.code).toBe("executor_context_invalid_state");
    }
  });

  it("materialize rejects goal and workflow identity mismatches with stable codes", () => {
    const base = createFamilyAndState();

    const missingGoal = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: { ...base.identity, goalId: "missing-goal" },
      profile,
    });
    expect(missingGoal.ok).toBe(false);
    if (!missingGoal.ok) {
      expect(missingGoal.diagnostics[0]?.code).toBe("executor_context_goal_not_in_family");
    }

    const workflowMismatch = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: { ...base.identity, workflowId: "other-workflow" },
      profile,
    });
    expect(workflowMismatch.ok).toBe(false);
    if (!workflowMismatch.ok) {
      expect(workflowMismatch.diagnostics[0]?.code).toBe("executor_context_workflow_mismatch");
    }

    const stateWorkflowMismatch = materializeExecutorContext({
      family: base.family,
      state: { ...base.state, workflowId: "other-workflow" },
      identity: base.identity,
      profile,
    });
    expect(stateWorkflowMismatch.ok).toBe(false);
    if (!stateWorkflowMismatch.ok) {
      expect(stateWorkflowMismatch.diagnostics[0]?.code).toBe("executor_context_state_workflow_mismatch");
    }

    expect(base.state.goal).toBeDefined();
    const stateWithMismatchedGoal: HypagraphState = {
      ...base.state,
      goal: {
        ...base.state.goal!,
        goalId: "other-goal",
      },
    };
    const stateGoalMismatch = materializeExecutorContext({
      family: base.family,
      state: stateWithMismatchedGoal,
      identity: base.identity,
      profile,
    });
    expect(stateGoalMismatch.ok).toBe(false);
    if (!stateGoalMismatch.ok) {
      expect(stateGoalMismatch.diagnostics[0]?.code).toBe("executor_context_state_goal_mismatch");
    }
  });

  it("materialize rejects invalid bounds, workspace, and attempt budget", () => {
    const badBound = materializeDefault({ maxSelectedFacts: -1 });
    expect(badBound.ok).toBe(false);
    if (!badBound.ok) {
      expect(badBound.diagnostics[0]?.code).toBe("executor_context_invalid_bound");
      expect(badBound.diagnostics[0]?.location).toBe("maxSelectedFacts");
    }

    const badArtifactsBound = materializeDefault({ maxSelectedArtifacts: -1 });
    expect(badArtifactsBound.ok).toBe(false);
    if (!badArtifactsBound.ok) {
      expect(badArtifactsBound.diagnostics[0]?.code).toBe("executor_context_invalid_bound");
      expect(badArtifactsBound.diagnostics[0]?.location).toBe("maxSelectedArtifacts");
    }

    const badWorkspace = materializeDefault({
      workspace: { leaseId: "" },
    });
    expect(badWorkspace.ok).toBe(false);
    if (!badWorkspace.ok) {
      expect(badWorkspace.diagnostics[0]?.code).toBe("executor_context_invalid_workspace");
    }

    const badBudget = materializeDefault({
      attemptBudget: { maximumTurns: 0 },
    });
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) {
      expect(badBudget.diagnostics[0]?.code).toBe("executor_context_invalid_attempt_budget");
    }
  });

  it("materialize rejects incomplete ancestry and does not mutate family or state", () => {
    const base = createFamilyAndState();
    const familySnapshot = structuredClone(base.family);
    const stateSnapshot = structuredClone(base.state);

    const corrupted = structuredClone(base.family);
    const root = corrupted.members["goal-root"];
    if (!root) throw new Error("expected root member");
    corrupted.members["goal-root"] = { ...root, goalId: "corrupted-goal-id" };

    const incompleteAncestry = materializeExecutorContext({
      family: corrupted,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(incompleteAncestry.ok).toBe(false);
    if (!incompleteAncestry.ok) {
      expect(incompleteAncestry.diagnostics[0]?.code).toBe("executor_context_ancestry_incomplete");
    }

    const ok = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(ok.ok).toBe(true);
    expect(base.family).toEqual(familySnapshot);
    expect(base.state).toEqual(stateSnapshot);
  });

  it("materialize caps selected facts at the default bound when many facts exist", () => {
    const base = createFamilyAndState();
    for (let index = 0; index < DEFAULT_MAX_SELECTED_FACTS + 8; index += 1) {
      const name = `bulk.fact${String(index).padStart(3, "0")}`;
      const record: FactRecord = {
        name,
        type: "boolean",
        value: true,
        producerNodeId: "upstream",
        attemptId: "attempt-upstream",
        revision: base.state.revision,
        evidence: [],
        eventId: `event-${index}`,
        sequence: index,
      };
      base.state.runtime.facts[name] = record;
    }

    const result = materializeExecutorContext({
      family: base.family,
      state: base.state,
      identity: base.identity,
      profile,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedFacts).toHaveLength(DEFAULT_MAX_SELECTED_FACTS);
    expect(result.value.resultProtocol.maxFacts).toBe(DEFAULT_MAX_RESULT_FACTS);
    expect(result.value.resultProtocol.maxEvidence).toBe(DEFAULT_MAX_RESULT_EVIDENCE);
    expect(DEFAULT_MAX_SELECTED_ARTIFACTS).toBeGreaterThan(0);
  });

  it("validate rejects nullish context and missing required result fields", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const nullContext = validateExecutorResult(
      null as unknown as ExecutorContextEnvelope,
      matchingResult(context),
    );
    expect(nullContext.ok).toBe(false);
    if (!nullContext.ok) {
      expect(nullContext.diagnostics[0]?.code).toBe("executor_result_invalid_context");
    }

    for (const field of ["facts", "evidence", "artifacts", "diagnostics", "usage"] as const) {
      const payload = matchingResult(context) as unknown as Record<string, unknown>;
      delete payload[field];
      const validated = validateExecutorResult(context, payload);
      expect(validated.ok, `expected missing ${field}`).toBe(false);
      if (validated.ok) continue;
      const expectedCode = `executor_result_${field}_missing`;
      expect(validated.diagnostics.some((d) => d.code === expectedCode)).toBe(true);
    }
  });

  it("validate rejects too many facts, evidence, and artifacts", () => {
    const materialized = materializeDefault({
      maxResultFacts: 1,
      maxResultEvidence: 1,
      maxResultArtifacts: 1,
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const tooManyFacts = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [
          { name: "work.done", type: "boolean", value: true },
          { name: "work.extra", type: "boolean", value: false },
        ],
      }),
    );
    expect(tooManyFacts.ok).toBe(false);
    if (!tooManyFacts.ok) {
      expect(tooManyFacts.diagnostics.some((d) => d.code === "executor_result_facts_too_many")).toBe(true);
    }

    const tooManyEvidence = validateExecutorResult(
      context,
      matchingResult(context, {
        evidence: [
          { ref: "evidence://a", kind: "note" },
          { ref: "evidence://b", kind: "note" },
        ],
      }),
    );
    expect(tooManyEvidence.ok).toBe(false);
    if (!tooManyEvidence.ok) {
      expect(tooManyEvidence.diagnostics.some((d) => d.code === "executor_result_evidence_too_many")).toBe(true);
    }

    const tooManyArtifacts = validateExecutorResult(
      context,
      matchingResult(context, {
        artifacts: [
          { ref: "artifact://a" },
          { ref: "artifact://b" },
        ],
      }),
    );
    expect(tooManyArtifacts.ok).toBe(false);
    if (!tooManyArtifacts.ok) {
      expect(tooManyArtifacts.diagnostics.some((d) => d.code === "executor_result_artifacts_too_many")).toBe(true);
    }
  });

  it("validate rejects duplicate facts, invalid usage, and invalid workspace", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    const duplicate = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [
          { name: "work.done", type: "boolean", value: true },
          { name: "work.done", type: "boolean", value: false },
        ],
      }),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics.some((d) => d.code === "executor_result_duplicate_fact")).toBe(true);
    }

    const badUsage = validateExecutorResult(
      context,
      matchingResult(context, {
        usage: { turns: -1 as unknown as number },
      }),
    );
    expect(badUsage.ok).toBe(false);
    if (!badUsage.ok) {
      expect(badUsage.diagnostics.some((d) => d.code === "executor_result_invalid_usage")).toBe(true);
    }

    const badWorkspace = validateExecutorResult(
      context,
      matchingResult(context, {
        workspace: { status: "not-a-status" as "clean" },
      }),
    );
    expect(badWorkspace.ok).toBe(false);
    if (!badWorkspace.ok) {
      expect(badWorkspace.diagnostics.some((d) => d.code === "executor_result_invalid_workspace")).toBe(true);
    }
  });

  it("validate accepts every known executor outcome when the envelope shape matches", () => {
    const materialized = materializeDefault();
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;

    for (const outcome of EXECUTOR_OUTCOMES) {
      const validated = validateExecutorResult(
        context,
        matchingResult(context, {
          outcome: outcome as ExecutorOutcome,
          // Non-submitted outcomes do not require facts; keep declared facts empty.
          ...(outcome === "submitted"
            ? {}
            : { facts: [], evidence: [] }),
        }),
      );
      expect(validated.ok, `outcome ${outcome}`).toBe(true);
      if (!validated.ok) continue;
      expect(validated.value.outcome).toBe(outcome);
    }
  });

  it("validate rejects undeclared facts, wrong contract types, and missing required evidence", () => {
    const materialized = materializeDefault({
      requiredEvidence: ["evidence://required-proof"],
    });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    const context = materialized.value;
    expect(context.resultProtocol.requiredEvidence).toEqual(["evidence://required-proof"]);

    const undeclared = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [
          { name: "work.done", type: "boolean", value: true },
          { name: "extra.undeclared", type: "string", value: "nope" },
        ],
        evidence: [{ ref: "evidence://required-proof", kind: "note" }],
      }),
    );
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.diagnostics.some((d) => d.code === "executor_result_fact_not_declared")).toBe(true);
    }

    const wrongType = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [{ name: "work.done", type: "string", value: "yes" }],
        evidence: [{ ref: "evidence://required-proof", kind: "note" }],
      }),
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.diagnostics.some((d) => d.code === "executor_result_fact_type_mismatch")).toBe(true);
    }

    // Empty facts without prior publication fail when required contracts exist.
    const emptyFacts = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [],
        evidence: [{ ref: "evidence://required-proof", kind: "note" }],
      }),
    );
    expect(emptyFacts.ok).toBe(false);
    if (!emptyFacts.ok) {
      expect(emptyFacts.diagnostics.some((d) => d.code === "executor_result_required_fact_missing")).toBe(true);
    }

    // Prior publish on the same attempt satisfies required fact contracts.
    const fromPriorPublish = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [],
        evidence: [{ ref: "evidence://required-proof", kind: "note" }],
      }),
      {
        publishedAttemptFacts: [{ name: "work.done", type: "boolean" }],
      },
    );
    expect(fromPriorPublish.ok).toBe(true);

    const missingRequiredEvidence = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [{ name: "work.done", type: "boolean", value: true }],
        evidence: [{ ref: "evidence://other", kind: "note" }],
      }),
    );
    expect(missingRequiredEvidence.ok).toBe(false);
    if (!missingRequiredEvidence.ok) {
      expect(missingRequiredEvidence.diagnostics.some((d) =>
        d.code === "executor_result_required_evidence_missing",
      )).toBe(true);
    }

    const accepted = validateExecutorResult(
      context,
      matchingResult(context, {
        facts: [{ name: "work.done", type: "boolean", value: true }],
        evidence: [{ ref: "evidence://required-proof", kind: "note" }],
      }),
    );
    expect(accepted.ok).toBe(true);
  });

  it("rejects materialization when captured child inputs exceed maxSelectedFacts", () => {
    const base = createFamilyAndState();
    // Seed a child binding with more captured inputs than the allowed bound.
    const family = structuredClone(base.family);
    family.members["goal-child"] = {
      goalId: "goal-child",
      workflowId: "workflow-child",
      rootGoalId: "goal-root",
      depth: 1,
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      childGoalIds: [],
    };
    family.members["goal-root"]!.childGoalIds = ["goal-child"];
    family.bindings["binding-inputs"] = {
      bindingId: "binding-inputs",
      childGoalId: "goal-child",
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
      parentAttemptId: "attempt-work-1",
      inputFacts: ["parent.a", "parent.b"],
      capturedInputFacts: [
        {
          name: "parent.a",
          type: "boolean",
          value: true,
          producerNodeId: "work",
          attemptId: "attempt-work-1",
          revision: base.state.revision,
        },
        {
          name: "parent.b",
          type: "string",
          value: "x",
          producerNodeId: "work",
          attemptId: "attempt-work-1",
          revision: base.state.revision,
        },
      ],
      outputFacts: [],
      budget: {},
      failurePolicy: "fail-parent-node",
      scopePaths: ["src/**"],
      status: "active",
      createdAt: later,
    };

    const childState = createStartedWorkflow(chainDefinition(), "workflow-child", "goal-child");
    const tooSmall = materializeExecutorContext({
      family,
      state: childState,
      identity: {
        familyId: family.familyId,
        goalId: "goal-child",
        workflowId: "workflow-child",
        revision: childState.revision,
        nodeId: "work",
        attemptId: "attempt-child",
      },
      profile,
      maxSelectedFacts: 1,
    });
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) {
      expect(tooSmall.diagnostics[0]?.code).toBe("executor_context_captured_inputs_exceed_bound");
    }

    const enough = materializeExecutorContext({
      family,
      state: childState,
      identity: {
        familyId: family.familyId,
        goalId: "goal-child",
        workflowId: "workflow-child",
        revision: childState.revision,
        nodeId: "work",
        attemptId: "attempt-child",
      },
      profile,
      maxSelectedFacts: 2,
    });
    expect(enough.ok).toBe(true);
    if (!enough.ok) return;
    expect(enough.value.selectedFacts.map((item) => item.name)).toEqual(["parent.a", "parent.b"]);
  });
});
