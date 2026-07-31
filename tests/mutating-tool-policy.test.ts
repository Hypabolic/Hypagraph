import { describe, expect, it } from "vitest";
import {
  createChildBlockedByIsolatedWorkerReason,
  HYPAGRAPH_AUTHORING_BLOCKED_TOOLS,
  HYPAGRAPH_WORK_MUTATING_TOOLS,
  isHypagraphAuthoringBlockedTool,
  isHypagraphWorkMutatingTool,
  NON_ROOT_CURRENT_SESSION_BAN_REASON,
} from "../src/pi/mutating-tool-policy.js";

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

  it("names current-session when create-child is blocked by an isolated parent worker", () => {
    const reason = createChildBlockedByIsolatedWorkerReason("delegate", "attempt-1");
    expect(reason).toMatch(/current-session/i);
    expect(reason).toMatch(/delegate/);
    expect(reason).toMatch(/Workers never create child/i);
  });

  it("bans current-session on non-root members with a clear reason", () => {
    expect(NON_ROOT_CURRENT_SESSION_BAN_REASON).toMatch(/Current-session is not supported on child/i);
    expect(NON_ROOT_CURRENT_SESSION_BAN_REASON).toMatch(/isolated-pi/i);
  });
});
