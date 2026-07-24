from pathlib import Path

path = Path('.agent/apply.py')
text = path.read_text()
text = text.replace('""", count=2)', '""", count=3)')
text = text.replace('"""       action: { kind: decision.kind', '"""      action: { kind: decision.kind')
text = text.replace('"""       if (!state?.goal?.pendingContinuation)', '"""      if (!state?.goal?.pendingContinuation)')
text = text.replace('\n       const semanticSequenceBeforeAccounting = state.sequence;', '\n      const semanticSequenceBeforeAccounting = state.sequence;')
text = text.replace('\n       const normalized = normalizePiGoalUsage(_event.messages);', '\n      const normalized = normalizePiGoalUsage(_event.messages);')
text = text.replace('"""       "hypagraph_revise",', '"""      "hypagraph_revise",')
text = text.replace(
    '''      blockerKind: Type.Optional(StringEnum(["repository-work", "external-dependency", "safeguard", "unknown"] as const)),
    }),
""", count=1)''',
    '''      blockerKind: Type.Optional(StringEnum(["repository-work", "external-dependency", "safeguard", "unknown"] as const)),
    }),
""", count=2)''',
)
path.write_text(text)
