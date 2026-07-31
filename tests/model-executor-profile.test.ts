import { describe, expect, it } from "vitest";
import {
  CURRENT_SESSION_OPT_IN_PROFILE,
  DEFAULT_MODEL_EXECUTOR_PROFILE,
  currentSessionAuthoringAdvisory,
  isModelWorkerActionKind,
  modelLaneUsesCurrentSession,
  modelLaneUsesIsolatedWorker,
  parseExecutorProfileRef,
  readNodeExecutorProfile,
  resolveModelNodeExecutorProfile,
  shouldSendModelLaneFollowUp,
} from "../src/domain/model-executor-profile.js";
import type { NodeDefinition } from "../src/domain/model.js";

const taskNode = (executorProfile?: NodeDefinition["executorProfile"]): NodeDefinition => ({
  id: "work",
  title: "Work",
  requires: [],
  acceptance: [],
  ...(executorProfile === undefined ? {} : { executorProfile }),
});

describe("model executor profile resolution (S6.1)", () => {
  it("defaults model nodes to isolated-pi", () => {
    const resolved = resolveModelNodeExecutorProfile({ node: taskNode() });
    expect(resolved.profile).toEqual(DEFAULT_MODEL_EXECUTOR_PROFILE);
    expect(resolved.profile.kind).toBe("isolated-pi");
    expect(resolved.source).toBe("default");
    expect(resolved.advisory).toBeUndefined();
  });

  it("uses current-session only when the node opts in", () => {
    const resolved = resolveModelNodeExecutorProfile({
      node: taskNode({
        profileId: "current-session-default",
        kind: "current-session",
      }),
    });
    expect(resolved.profile.kind).toBe("current-session");
    expect(resolved.source).toBe("node");
    expect(resolved.advisory).toContain("current-session");
    expect(resolved.advisory).toContain("orchestrator");
  });

  it("prefers explicit profile over node and default", () => {
    const resolved = resolveModelNodeExecutorProfile({
      explicit: { profileId: "acp-default", kind: "acp" },
      node: taskNode({
        profileId: "current-session-default",
        kind: "current-session",
      }),
    });
    expect(resolved.profile).toEqual({ profileId: "acp-default", kind: "acp" });
    expect(resolved.source).toBe("explicit");
  });

  it("legacy flag restores current-session default only when requested", () => {
    const legacy = resolveModelNodeExecutorProfile({
      node: taskNode(),
      legacyCurrentSessionDefault: true,
    });
    expect(legacy.profile).toEqual(CURRENT_SESSION_OPT_IN_PROFILE);
    expect(legacy.source).toBe("default");

    const product = resolveModelNodeExecutorProfile({
      node: taskNode(),
      legacyCurrentSessionDefault: false,
    });
    expect(product.profile.kind).toBe("isolated-pi");
  });

  it("parseExecutorProfileRef rejects unknown kinds", () => {
    const bad = parseExecutorProfileRef({ profileId: "x", kind: "not-a-kind" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.diagnostics[0]?.code).toBe("executor_profile_invalid_kind");
  });

  it("readNodeExecutorProfile ignores invalid node shapes", () => {
    expect(readNodeExecutorProfile({
      executorProfile: { profileId: "", kind: "isolated-pi" },
    })).toBeUndefined();
    expect(readNodeExecutorProfile({
      executorProfile: { profileId: "ok", kind: "isolated-pi" },
    })).toEqual({ profileId: "ok", kind: "isolated-pi" });
  });

  it("classifies worker vs current-session routing", () => {
    expect(modelLaneUsesIsolatedWorker(DEFAULT_MODEL_EXECUTOR_PROFILE)).toBe(true);
    expect(modelLaneUsesIsolatedWorker({ profileId: "acp", kind: "acp" })).toBe(true);
    expect(modelLaneUsesCurrentSession(CURRENT_SESSION_OPT_IN_PROFILE)).toBe(true);
    expect(modelLaneUsesIsolatedWorker(CURRENT_SESSION_OPT_IN_PROFILE)).toBe(false);
  });

  it("follow-up is required only for current-session task actions", () => {
    expect(isModelWorkerActionKind("start-ready-task")).toBe(true);
    expect(isModelWorkerActionKind("request-revision")).toBe(false);

    expect(shouldSendModelLaneFollowUp({
      actionKind: "start-ready-task",
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
    })).toBe(false);

    expect(shouldSendModelLaneFollowUp({
      actionKind: "continue-active-task",
      profile: CURRENT_SESSION_OPT_IN_PROFILE,
    })).toBe(true);

    expect(shouldSendModelLaneFollowUp({
      actionKind: "request-revision",
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
    })).toBe(true);

    expect(shouldSendModelLaneFollowUp({
      actionKind: "request-ready-interaction",
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
    })).toBe(true);
  });

  it("currentSessionAuthoringAdvisory names the node", () => {
    expect(currentSessionAuthoringAdvisory("implement")).toContain("implement");
    expect(currentSessionAuthoringAdvisory("implement")).toContain("isolated-pi");
  });
});
