import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphState } from "../src/domain/model.js";
import {
  attachMember,
  attachRootMember,
  bumpSessionGenerations,
  createSessionContext,
  liveSlotsFromMember,
  resolveLiveSlotRelease,
  sessionGenerationsMatch,
  setSessionFamilyRecord,
  setSessionRootWorkflowId,
  shouldPersistNonRootMemberAfterBind,
  snapshotMember,
  snapshotSession,
  syncMemberFromLiveSlots,
  type MemberContext,
} from "../src/pi/session-context.js";

const minimalState = (workflowId: string, goalId: string, sequence = 1): HypagraphState =>
  ({
    workflowId,
    sequence,
    revision: 0,
    snapshotHash: `hash-${workflowId}-${sequence}`,
    goal: {
      goalId,
      status: "active",
    },
    definition: { title: "t", goal: "g", nodes: [], loops: [], policy: { mode: "guided", requireEvidence: false } },
    runtime: { nodes: {} },
  }) as unknown as HypagraphState;

const event = (workflowId: string, sequence: number): DomainEvent =>
  ({
    type: "workflow-created",
    workflowId,
    sequence,
    at: "2026-08-05T00:00:00.000Z",
  }) as unknown as DomainEvent;

describe("session-context (Seam A)", () => {
  it("createSessionContext sets defaults and optional fields", () => {
    const session = createSessionContext();
    expect(session.sessionGeneration).toBe(0);
    expect(session.branchGeneration).toBe(0);
    expect(session.rootWorkflowId).toBeUndefined();
    expect(session.familyRecord).toBeUndefined();
    expect(session.workerPool).toBeUndefined();
    expect(session.paintPending).toBe(false);

    const custom = createSessionContext({
      sessionGeneration: 3,
      branchGeneration: 1,
      rootWorkflowId: "wf-root",
      paintPending: true,
    });
    expect(custom.sessionGeneration).toBe(3);
    expect(custom.branchGeneration).toBe(1);
    expect(custom.rootWorkflowId).toBe("wf-root");
    expect(custom.paintPending).toBe(true);
  });

  it("attachRootMember marks isLiveRoot, shares references, and records root id when unset", () => {
    const session = createSessionContext();
    const state = minimalState("wf-root", "goal-root");
    const events = [event("wf-root", 1)];
    const member = attachRootMember(session, {
      workflowId: "wf-root",
      goalId: "goal-root",
      state,
      events,
    });
    expect(member.isLiveRoot).toBe(true);
    expect(member.workflowId).toBe("wf-root");
    expect(member.goalId).toBe("goal-root");
    expect(member.state).toBe(state);
    expect(member.events).toBe(events);
    expect(session.rootWorkflowId).toBe("wf-root");
  });

  it("attachRootMember sets isLiveRoot false when workflow id does not match session root", () => {
    const session = createSessionContext({ rootWorkflowId: "wf-root" });
    const member = attachRootMember(session, {
      workflowId: "wf-other",
      goalId: "goal-other",
      state: minimalState("wf-other", "goal-other"),
      events: [event("wf-other", 1)],
    });
    expect(member.isLiveRoot).toBe(false);
    expect(session.rootWorkflowId).toBe("wf-root");
  });

  it("attachMember clones state and events so working slots are independent", () => {
    const session = createSessionContext({ rootWorkflowId: "wf-root" });
    const rootState = minimalState("wf-root", "goal-root");
    const rootEvents = [event("wf-root", 1)];
    const childState = minimalState("wf-child", "goal-child");
    const childEvents = [event("wf-child", 1)];

    const root = attachRootMember(session, {
      workflowId: "wf-root",
      goalId: "goal-root",
      state: rootState,
      events: rootEvents,
    });
    const child = attachMember(session, {
      workflowId: "wf-child",
      goalId: "goal-child",
      state: childState,
      events: childEvents,
    });

    expect(child.isLiveRoot).toBe(false);
    expect(child.state).not.toBe(childState);
    expect(child.events).not.toBe(childEvents);
    expect(child.state?.workflowId).toBe("wf-child");

    // Mutate child; root and original inputs must not change.
    child.state = minimalState("wf-child", "goal-child", 2);
    child.events.push(event("wf-child", 2));
    expect(root.state).toBe(rootState);
    expect(root.events).toHaveLength(1);
    expect(childEvents).toHaveLength(1);
    expect(child.events).toHaveLength(2);
  });

  it("two pure MemberContext values do not clobber each other", () => {
    const session = createSessionContext();
    const a: MemberContext = attachMember(session, {
      workflowId: "wf-a",
      goalId: "goal-a",
      state: minimalState("wf-a", "goal-a"),
      events: [event("wf-a", 1)],
    });
    const b: MemberContext = attachMember(session, {
      workflowId: "wf-b",
      goalId: "goal-b",
      state: minimalState("wf-b", "goal-b"),
      events: [event("wf-b", 1)],
    });

    a.state = minimalState("wf-a", "goal-a", 2);
    a.events = [event("wf-a", 1), event("wf-a", 2)];
    b.state = minimalState("wf-b", "goal-b", 3);
    b.events = [event("wf-b", 1), event("wf-b", 2), event("wf-b", 3)];

    expect(a.workflowId).toBe("wf-a");
    expect(b.workflowId).toBe("wf-b");
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(3);
    expect(a.state?.workflowId).toBe("wf-a");
    expect(b.state?.workflowId).toBe("wf-b");
  });

  it("snapshotMember deep-clones state and events", () => {
    const session = createSessionContext();
    const state = minimalState("wf-1", "goal-1");
    const events = [event("wf-1", 1)];
    const member = attachMember(session, {
      workflowId: "wf-1",
      goalId: "goal-1",
      state,
      events,
    });
    const snap = snapshotMember(member);
    expect(snap.workflowId).toBe("wf-1");
    expect(snap.state).not.toBe(member.state);
    expect(snap.events).not.toBe(member.events);
    expect(snap.state?.workflowId).toBe("wf-1");
    expect(snap.events).toHaveLength(1);
  });

  it("snapshotSession reports generation and cache flags", () => {
    const session = createSessionContext({
      sessionGeneration: 2,
      branchGeneration: 1,
      rootWorkflowId: "wf-root",
    });
    expect(snapshotSession(session)).toEqual({
      sessionGeneration: 2,
      branchGeneration: 1,
      rootWorkflowId: "wf-root",
      paintPending: false,
      hasFamilyRecord: false,
      hasWorkerPool: false,
    });
  });

  it("bumpSessionGenerations increments counters", () => {
    const session = createSessionContext();
    bumpSessionGenerations(session, { branchChanged: false });
    expect(session.sessionGeneration).toBe(1);
    expect(session.branchGeneration).toBe(0);
    bumpSessionGenerations(session, { branchChanged: true });
    expect(session.sessionGeneration).toBe(2);
    expect(session.branchGeneration).toBe(1);
  });

  it("setSessionRootWorkflowId and setSessionFamilyRecord update slots", () => {
    const session = createSessionContext();
    setSessionRootWorkflowId(session, "wf-root");
    expect(session.rootWorkflowId).toBe("wf-root");
    setSessionRootWorkflowId(session, undefined);
    expect(session.rootWorkflowId).toBeUndefined();

    setSessionFamilyRecord(session, undefined);
    expect(session.familyRecord).toBeUndefined();
  });

  it("liveSlotsFromMember and syncMemberFromLiveSlots round-trip working slots", () => {
    const session = createSessionContext();
    const member = attachMember(session, {
      workflowId: "wf-child",
      goalId: "goal-child",
      state: minimalState("wf-child", "goal-child"),
      events: [event("wf-child", 1)],
    });
    const slots = liveSlotsFromMember(member);
    expect(slots.state).toBe(member.state);
    expect(slots.events).toBe(member.events);

    const nextState = minimalState("wf-child", "goal-child", 2);
    const nextEvents = [event("wf-child", 1), event("wf-child", 2)];
    syncMemberFromLiveSlots(member, { state: nextState, events: nextEvents });
    expect(member.state).toBe(nextState);
    expect(member.events).toHaveLength(2);
  });

  describe("shouldPersistNonRootMemberAfterBind", () => {
    it("allows persist when generations match and member state identity holds", () => {
      expect(shouldPersistNonRootMemberAfterBind({
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 1,
        currentBranchGeneration: 0,
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-child", "goal-child", 2),
      })).toBe(true);
    });

    it("skips persist when session generation advanced (restore mid-dispatch)", () => {
      expect(shouldPersistNonRootMemberAfterBind({
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 2,
        currentBranchGeneration: 0,
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-child", "goal-child", 2),
      })).toBe(false);
    });

    it("skips persist when branch generation advanced", () => {
      expect(shouldPersistNonRootMemberAfterBind({
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 1,
        currentBranchGeneration: 1,
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-child", "goal-child", 2),
      })).toBe(false);
    });

    it("skips persist when member state is missing or wrong workflow", () => {
      expect(shouldPersistNonRootMemberAfterBind({
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 1,
        currentBranchGeneration: 0,
        memberWorkflowId: "wf-child",
        memberState: undefined,
      })).toBe(false);
      expect(shouldPersistNonRootMemberAfterBind({
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 1,
        currentBranchGeneration: 0,
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-other", "goal-other", 1),
      })).toBe(false);
    });

    it("sessionGenerationsMatch is the shared generation check", () => {
      expect(sessionGenerationsMatch({
        bindSessionGeneration: 3,
        bindBranchGeneration: 1,
        currentSessionGeneration: 3,
        currentBranchGeneration: 1,
      })).toBe(true);
      expect(sessionGenerationsMatch({
        bindSessionGeneration: 3,
        bindBranchGeneration: 1,
        currentSessionGeneration: 4,
        currentBranchGeneration: 1,
      })).toBe(false);
    });
  });

  describe("resolveLiveSlotRelease (sequential free-slot bind)", () => {
    it("syncs member from free child and restores pre-bind root when generations match", () => {
      const rootState = minimalState("wf-root", "goal-root");
      const rootEvents = [event("wf-root", 1)];
      const childBefore = minimalState("wf-child", "goal-child", 1);
      const childEventsBefore = [event("wf-child", 1)];
      const childAfter = minimalState("wf-child", "goal-child", 2);
      const childEventsAfter = [event("wf-child", 1), event("wf-child", 2)];

      // Sequential bind: install child, mutate free slots, release.
      const freeState = childAfter;
      const freeEvents = childEventsAfter;
      const resolved = resolveLiveSlotRelease({
        memberWorkflowId: "wf-child",
        memberState: childBefore,
        memberEvents: childEventsBefore,
        freeState,
        freeEvents,
        savedRootState: rootState,
        savedRootEvents: rootEvents,
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 1,
        currentBranchGeneration: 0,
      });

      expect(resolved.syncedMemberFromLive).toBe(true);
      expect(resolved.restoredSavedRoot).toBe(true);
      expect(resolved.nextMemberState).toBe(childAfter);
      expect(resolved.nextMemberEvents).toHaveLength(2);
      expect(resolved.nextFreeState).toBe(rootState);
      expect(resolved.nextFreeEvents).toBe(rootEvents);
    });

    it("does not clobber post-restore free slots when generations advanced", () => {
      const preBindRoot = minimalState("wf-root-old", "goal-root-old");
      const preBindRootEvents = [event("wf-root-old", 1)];
      const postRestoreRoot = minimalState("wf-root-new", "goal-root-new");
      const postRestoreEvents = [event("wf-root-new", 1)];

      // Restore replaced free slots mid-bind (generations advanced).
      const resolved = resolveLiveSlotRelease({
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-child", "goal-child", 1),
        memberEvents: [event("wf-child", 1)],
        freeState: postRestoreRoot,
        freeEvents: postRestoreEvents,
        savedRootState: preBindRoot,
        savedRootEvents: preBindRootEvents,
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 2,
        currentBranchGeneration: 0,
      });

      expect(resolved.restoredSavedRoot).toBe(false);
      expect(resolved.syncedMemberFromLive).toBe(false);
      // Member keeps last known working set (free no longer holds child).
      expect(resolved.nextMemberState?.workflowId).toBe("wf-child");
      expect(resolved.nextMemberState?.sequence).toBe(1);
      // Free slots stay as restore left them.
      expect(resolved.nextFreeState).toBe(postRestoreRoot);
      expect(resolved.nextFreeEvents).toBe(postRestoreEvents);
      // Pre-bind root must not overwrite restore.
      expect(resolved.nextFreeState).not.toBe(preBindRoot);
    });

    it("syncs member when free still holds member even if generations advanced", () => {
      const childAfter = minimalState("wf-child", "goal-child", 3);
      const childEventsAfter = [event("wf-child", 1), event("wf-child", 2), event("wf-child", 3)];
      const resolved = resolveLiveSlotRelease({
        memberWorkflowId: "wf-child",
        memberState: minimalState("wf-child", "goal-child", 1),
        memberEvents: [event("wf-child", 1)],
        freeState: childAfter,
        freeEvents: childEventsAfter,
        savedRootState: minimalState("wf-root", "goal-root"),
        savedRootEvents: [event("wf-root", 1)],
        bindSessionGeneration: 1,
        bindBranchGeneration: 0,
        currentSessionGeneration: 2,
        currentBranchGeneration: 1,
      });

      expect(resolved.syncedMemberFromLive).toBe(true);
      expect(resolved.restoredSavedRoot).toBe(false);
      expect(resolved.nextMemberState).toBe(childAfter);
      expect(resolved.nextMemberEvents).toHaveLength(3);
      // Free slots unchanged (no root restore after generation advance).
      expect(resolved.nextFreeState).toBe(childAfter);
    });
  });
});
