from pathlib import Path

path = Path('src/pi/hypagoal-loop-guidance.ts')
text = path.read_text()
text = text.replace('  GoalContinuationAction,\n', '  GoalWorkContinuationAction,\n')
text = text.replace('Pick<GoalContinuationAction, "nodeId" | "loopId">', 'Pick<GoalWorkContinuationAction, "nodeId" | "loopId">')
path.write_text(text)

path = Path('src/domain/goal-continuation.ts')
text = path.read_text()
old = '''  if (action.kind === "request-revision") {
    const decision = classifyGoalBlockage(state);
    return decision.kind === "revision-eligible" && blockerIdentityMatches(decision.blocker, action.blocker);
  }'''
new = '''  if (action.kind === "request-revision") {
    const goal = state.goal;
    const pending = goal?.pendingContinuation;
    const automatic = goal?.automaticRevision.lastAttempt;
    return goal?.status === "blocked"
      && pending?.action.kind === "request-revision"
      && automatic?.outcome === "pending"
      && automatic.operationId === pending.operationId
      && blockerIdentityMatches(pending.action.blocker, action.blocker);
  }'''
if old not in text:
    raise RuntimeError('revision continuation validation target was not found')
path.write_text(text.replace(old, new))

path = Path('src/domain/projection.ts')
text = path.read_text()
old = '''      next.goal.stopReason = String(event.data.reason ?? "The workflow is blocked.");
      delete next.goal.pendingContinuation;
      delete next.goal.completedAt;'''
new = '''      next.goal.stopReason = String(event.data.reason ?? "The workflow is blocked.");
      delete next.goal.completedAt;'''
if old not in text:
    raise RuntimeError('goal blockage continuation target was not found')
path.write_text(text.replace(old, new, 1))

path = Path('src/domain/reducer.ts')
text = path.read_text()
old = '''    const structural = validateDefinition(command.definition);
    const safeguards = structural.length === 0 ? validateAutomaticRevision(state.definition, command.definition) : [];
    const rejection = [...structural, ...safeguards];'''
new = '''    const safeguards = validateAutomaticRevision(state.definition, command.definition);
    const structural = validateDefinition(command.definition);
    const rejection = [...safeguards, ...structural];'''
if old not in text:
    raise RuntimeError('automatic revision validation ordering target was not found')
path.write_text(text.replace(old, new, 1))

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
text = text.replace('      const canonical = state.goal.pendingContinuation;', '      const canonical = revisionRequest;', 1)
usage_start = text.index('      const canonical = revisionRequest;', start)
usage_end = text.index('      if (!recorded.ok)', usage_start)
usage = text[usage_start:usage_end].replace('goalId: state.goal.goalId', 'goalId: goal.goalId')
text = text[:usage_start] + usage + text[usage_end:]
path.write_text(text)

path = Path('tests/hypagoal-revision.test.ts')
text = path.read_text()
old = '''const acceptedProposal = (definition = base()): HypagraphDefinition => ({
  ...structuredClone(definition),
  nodes: [
    { id: "migration", title: "Add the missing bounded migration", requires: [], acceptance: ["Implement the missing repository step"], scope: { paths: ["src/**"] } },
    { ...structuredClone(definition.nodes[0]!), requires: ["migration"] },
    structuredClone(definition.nodes[1]!),
  ],
});'''
new = '''const acceptedProposal = (definition = base()): HypagraphDefinition => ({
  ...structuredClone(definition),
  nodes: [
    { id: "migration", title: "Add the missing bounded migration", requires: [], acceptance: ["Implement the missing repository step"], scope: { paths: ["src/**"] } },
    ...definition.nodes.map((node) => node.id === "prepare"
      ? { ...structuredClone(node), requires: [...node.requires, "migration"] }
      : structuredClone(node)),
  ],
});'''
if old not in text:
    raise RuntimeError('accepted proposal fixture target was not found')
text = text.replace(old, new, 1)
old = '    expect(selectGoalContinuation({ ...structuredClone(value.state), goal: { ...structuredClone(value.state.goal!), pendingContinuation: undefined } })).toMatchObject({ kind: "stop-blocked" });'
new = '    const exhausted = structuredClone(value.state);\n    delete exhausted.goal!.pendingContinuation;\n    expect(selectGoalContinuation(exhausted)).toMatchObject({ kind: "stop-blocked" });'
text = text.replace(old, new)
text = text.replace('runtime.nodes.migration.status', 'runtime.nodes.migration!.status')
text = text.replace('runtime.nodes.independent.status', 'runtime.nodes.independent!.status')
text = text.replace('runtime.nodes.independent.attemptCount', 'runtime.nodes.independent!.attemptCount')
text = text.replace('runtime.nodes.prepare.status', 'runtime.nodes.prepare!.status')
text = text.replace('expect(result.state.runtime.nodes.prepare!.status).toBe("pending")', 'expect(result.state.runtime.nodes.prepare!.status).toBe("stale")')
path.write_text(text)

path = Path('tests/extension.test.ts')
text = path.read_text()
text = text.replace('      "hypagraph_transition",\n      "hypagraph_revise",', '      "hypagraph_transition",\n      "hypagoal_submit_revision",\n      "hypagraph_revise",')
path.write_text(text)

for name in ['tests/loop-persistence-hardening.test.ts', 'tests/loop-slice-one.test.ts']:
    path = Path(name)
    text = path.read_text().replace('.schemaVersion).toBe(4)', '.schemaVersion).toBe(5)')
    path.write_text(text)
