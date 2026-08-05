import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HYPAGRAPH_AUTHORING_BLOCKED_TOOLS,
  HYPAGRAPH_WORK_MUTATING_TOOLS,
  isHypagraphAuthoringBlockedTool,
  isHypagraphFamilyControlToolDuringWorker,
  isHypagraphWorkMutatingTool,
  NON_ROOT_CURRENT_SESSION_BAN_REASON,
} from "../src/pi/mutating-tool-policy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("mutating tool policy", () => {
  it("includes bash in both authoring and work block lists", () => {
    expect(HYPAGRAPH_AUTHORING_BLOCKED_TOOLS).toContain("bash");
    expect(HYPAGRAPH_WORK_MUTATING_TOOLS).toContain("bash");
    expect(isHypagraphAuthoringBlockedTool("bash")).toBe(true);
    expect(isHypagraphWorkMutatingTool("bash")).toBe(true);
  });

  it("allows hypagoal_start during authoring but blocks it after create", () => {
    expect(isHypagraphAuthoringBlockedTool("hypagoal_start")).toBe(false);
    expect(isHypagraphWorkMutatingTool("hypagoal_start")).toBe(true);
  });

  it("blocks hypagoal_create_child as work mutation after create", () => {
    expect(isHypagraphAuthoringBlockedTool("hypagoal_create_child")).toBe(false);
    expect(isHypagraphWorkMutatingTool("hypagoal_create_child")).toBe(true);
    expect(HYPAGRAPH_WORK_MUTATING_TOOLS).toContain("hypagoal_create_child");
  });

  it("allows pure read tools", () => {
    expect(isHypagraphAuthoringBlockedTool("read")).toBe(false);
    expect(isHypagraphWorkMutatingTool("hypagraph_read")).toBe(false);
    expect(isHypagraphWorkMutatingTool("hypagraph_validate")).toBe(false);
  });

  it("treats create-child as family control during an isolated worker", () => {
    expect(isHypagraphFamilyControlToolDuringWorker("hypagoal_create_child")).toBe(true);
    expect(isHypagraphFamilyControlToolDuringWorker("write")).toBe(false);
    expect(isHypagraphFamilyControlToolDuringWorker("edit")).toBe(false);
  });

  it("does not reintroduce Option A block-all create-child for isolated workers", () => {
    const policySource = readFileSync(
      resolve(repoRoot, "src/pi/mutating-tool-policy.ts"),
      "utf8",
    );
    const extensionSource = readFileSync(
      resolve(repoRoot, "src/extension.ts"),
      "utf8",
    );
    // Fence: do not re-export the deleted Option A helper.
    expect(policySource).not.toMatch(/createChildBlockedByIsolatedWorkerReason/);
    expect(extensionSource).not.toMatch(/createChildBlockedByIsolatedWorkerReason/);
    // Fence: family control exemption remains; same-node guard is the only worker create-child block.
    expect(policySource).toMatch(/HYPAGRAPH_FAMILY_CONTROL_TOOLS_DURING_WORKER/);
    expect(isHypagraphFamilyControlToolDuringWorker("hypagoal_create_child")).toBe(true);
    expect(extensionSource).toMatch(/child_create_blocked_active_worker_node/);
    expect(extensionSource).toMatch(/isHypagraphFamilyControlToolDuringWorker/);
    // Fence: same-node guard checks the pool via findIsolatedWorkerByNodeId (S4).
    // Parent node match remains the only worker create-child block.
    expect(extensionSource).toMatch(/findIsolatedWorkerByNodeId/);
  });

  it("bans current-session on non-root members with a clear reason", () => {
    expect(NON_ROOT_CURRENT_SESSION_BAN_REASON).toMatch(/Current-session is not supported on child/i);
    expect(NON_ROOT_CURRENT_SESSION_BAN_REASON).toMatch(/isolated-pi/i);
  });
});
