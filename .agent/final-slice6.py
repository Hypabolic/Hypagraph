from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    target = Path(path)
    text = target.read_text()
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {actual}: {old[:140]!r}")
    target.write_text(text.replace(old, new, count))


replace(
    "src/extension.ts",
    '''    if (suppressContinuationAtNextAgentEnd) {
      suppressContinuationAtNextAgentEnd = false;
      await abandonPendingContinuation("Interactive input interrupted the automatic continuation.");
      pendingContinuation = undefined;
      deliveredContinuation = undefined;
      updateUi(state, ctx, graphPane);
      return;
    }
    if (deliveredContinuation) {''',
    '''    if (suppressContinuationAtNextAgentEnd) {
      suppressContinuationAtNextAgentEnd = false;
      const interruptedRevision = deliveredContinuation?.action.kind === "request-revision"
        ? deliveredContinuation
        : undefined;
      if (!interruptedRevision) {
        await abandonPendingContinuation("Interactive input interrupted the automatic continuation.");
        pendingContinuation = undefined;
        deliveredContinuation = undefined;
        updateUi(state, ctx, graphPane);
        return;
      }
      const goal = state?.goal;
      const revisionRequest = goal?.pendingContinuation;
      if (state && goal && revisionRequest?.action.kind === "request-revision" && goal.automaticRevision.lastAttempt?.outcome === "pending") {
        const interrupted = await applyCommandsAndCommit(eventStore.lease(), state, [{
          type: "abandon-goal-revision",
          goalId: goal.goalId,
          workflowId: state.workflowId,
          expectedRevision: state.revision,
          expectedSequence: state.sequence,
          expectedSnapshotHash: state.snapshotHash,
          revisionOperationId: interruptedRevision.operationId,
          continuationOperationId: revisionRequest.operationId,
          continuationOrdinal: revisionRequest.ordinal,
          requestSequence: revisionRequest.requestSequence,
          sessionGeneration: revisionRequest.sessionGeneration,
          branchGeneration: revisionRequest.branchGeneration,
          outcomeCode: "revision_turn_interrupted",
          reason: "Interactive input interrupted the delivered automatic revision turn.",
          commandId: `abandon-goal-revision:interrupted:${randomUUID()}`,
          correlationId: interruptedRevision.operationId,
          at: new Date().toISOString(),
        }]);
        if (interrupted.ok) {
          state = interrupted.value.state;
          events.push(...interrupted.value.events);
        }
      }
      updateUi(state, ctx, graphPane);
    }
    if (deliveredContinuation) {''',
)

path = Path("tests/hypagoal-revision-pi.test.ts")
text = path.read_text()
insert = '''

  it("charges one interrupted delivered revision turn and exhausts the allowance", async () => {
    const value = harness();
    await create(value);
    await agentEnd(value);
    await before(value, prompts(value).at(-1)!);
    await transition(value, "inventory", "block", { reason: "A bounded repository step is missing.", blockerKind: "repository-work" });
    await agentEnd(value);
    const revisionPrompt = prompts(value).at(-1)!;
    await before(value, revisionPrompt);

    await invoke(value, "input", {
      type: "input",
      text: "Stop the revision turn.",
      source: "interactive",
      streamingBehavior: "steer",
    });
    const promptCount = prompts(value).length;
    await agentEnd(value);

    const state = latest(value);
    expect(prompts(value)).toHaveLength(promptCount);
    expect(state.goal).toMatchObject({
      status: "blocked",
      budget: { consumedTurns: 3, consumedTokens: { totalTokens: 36 } },
      automaticRevision: {
        consumedAttempts: 1,
        lastAttempt: { outcome: "abandoned", outcomeCode: "revision_turn_interrupted" },
      },
    });
    expect(state.goal.pendingContinuation).toBeUndefined();
  });
'''
closing = "\n});\n"
if not text.endswith(closing):
    raise RuntimeError("Pi revision test closing marker was not found")
path.write_text(text[:-len(closing)] + insert + closing)

# Temporary branch-local patch; the validation workflow removes it after success.
