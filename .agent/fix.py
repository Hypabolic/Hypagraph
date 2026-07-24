from pathlib import Path

path = Path('src/pi/hypagoal-loop-guidance.ts')
text = path.read_text()
text = text.replace('  GoalContinuationAction,\n', '  GoalWorkContinuationAction,\n')
text = text.replace('Pick<GoalContinuationAction, "nodeId" | "loopId">', 'Pick<GoalWorkContinuationAction, "nodeId" | "loopId">')
path.write_text(text)

path = Path('src/extension.ts')
text = path.read_text()
blocker_field = '      blockerKind: Type.Optional(StringEnum(["repository-work", "external-dependency", "safeguard", "unknown"] as const)),\n'
text = text.replace(blocker_field, '', 1)
anchor = 'if (!state?.goal?.pendingContinuation) return;'
anchor_index = text.index(anchor)
start = text.rfind('\n', 0, anchor_index) + 1
end_marker = '      const semanticSequenceBeforeAccounting = state.sequence;'
end = text.index(end_marker, anchor_index)
replacement = (
    '      const goal = state?.goal;\n'
    '      const revisionRequest = goal?.pendingContinuation;\n'
    '      if (!state || !goal || !revisionRequest) return;\n'
    '      if (delivered.action.kind === "request-revision" && !revisionProposalHandled && goal.automaticRevision.lastAttempt?.outcome === "pending") {\n'
    '        const abandoned = await applyCommandsAndCommit(eventStore.lease(), state, [{\n'
    '          type: "abandon-goal-revision",\n'
    '          goalId: goal.goalId,\n'
    '          workflowId: state.workflowId,\n'
    '          expectedRevision: state.revision,\n'
    '          expectedSequence: state.sequence,\n'
    '          expectedSnapshotHash: state.snapshotHash,\n'
    '          revisionOperationId: delivered.operationId,\n'
    '          continuationOperationId: revisionRequest.operationId,\n'
    '          continuationOrdinal: revisionRequest.ordinal,\n'
    '          requestSequence: revisionRequest.requestSequence,\n'
    '          sessionGeneration: revisionRequest.sessionGeneration,\n'
    '          branchGeneration: revisionRequest.branchGeneration,\n'
    '          outcomeCode: "revision_turn_no_proposal",\n'
    '          reason: "The automatic revision turn ended without one valid replacement definition.",\n'
    '          commandId: `abandon-goal-revision:${randomUUID()}`,\n'
    '          correlationId: delivered.operationId,\n'
    '          at: new Date().toISOString(),\n'
    '        }]);\n'
    '        if (abandoned.ok) {\n'
    '          state = abandoned.value.state;\n'
    '          events.push(...abandoned.value.events);\n'
    '        }\n'
    '      }\n'
)
text = text[:start] + replacement + text[end:]
text = text.replace('      const canonical = state.goal.pendingContinuation;', '      const canonical = goal.pendingContinuation;', 1)
usage_start = text.index('      const canonical = goal.pendingContinuation;', start)
usage_end = text.index('      if (!recorded.ok)', usage_start)
usage = text[usage_start:usage_end].replace('goalId: state.goal.goalId', 'goalId: goal.goalId')
text = text[:usage_start] + usage + text[usage_end:]
path.write_text(text)

path = Path('tests/hypagoal-revision.test.ts')
text = path.read_text()
old = '    expect(selectGoalContinuation({ ...structuredClone(value.state), goal: { ...structuredClone(value.state.goal!), pendingContinuation: undefined } })).toMatchObject({ kind: "stop-blocked" });'
new = '    const exhausted = structuredClone(value.state);\n    delete exhausted.goal!.pendingContinuation;\n    expect(selectGoalContinuation(exhausted)).toMatchObject({ kind: "stop-blocked" });'
text = text.replace(old, new)
text = text.replace('runtime.nodes.migration.status', 'runtime.nodes.migration!.status')
text = text.replace('runtime.nodes.independent.status', 'runtime.nodes.independent!.status')
text = text.replace('runtime.nodes.independent.attemptCount', 'runtime.nodes.independent!.attemptCount')
text = text.replace('runtime.nodes.prepare.status', 'runtime.nodes.prepare!.status')
path.write_text(text)
