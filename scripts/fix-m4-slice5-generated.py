from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required generated text was not found in {path}")
    file.write_text(text.replace(old, new, 1))

replace(
    "src/domain/reducer.ts",
    '''    metric,
    improved,
    bestMetric: improved ? metric : runtime.bestMetric,
    bestIteration: improved ? runtime.currentIteration : runtime.bestIteration,
    noProgressCount: improved ? 0 : runtime.noProgressCount + 1,
''',
    '''    metric,
    improved,
    ...(improved ? { bestMetric: metric, bestIteration: runtime.currentIteration } : {
      ...(runtime.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
      ...(runtime.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
    }),
    noProgressCount: improved ? 0 : runtime.noProgressCount + 1,
''',
)
replace(
    "src/domain/reducer.ts",
    '''              maxIterations: loopRuntime.maxIterations,
              exitReason,
''',
    '''              maxIterations: loopRuntime?.maxIterations ?? loopDefinition.maxIterations,
              exitReason,
''',
)
replace(
    "src/graph/projection.ts",
    '''  noProgressCount: number;
  patience?: number;
''',
    '''  noProgressCount?: number;
  patience?: number;
''',
)
replace(
    "tests/loop-progress.test.ts",
    '''    const noProgress = definition({ progress: undefined, patience: 2 });
    expect(validateDefinition(noProgress).map((item) => item.code)).toContain("patience_requires_progress");
''',
    '''    const noProgress = definition();
    delete noProgress.loops[0]!.progress;
    noProgress.loops[0]!.patience = 2;
    expect(validateDefinition(noProgress).map((item) => item.code)).toContain("patience_requires_progress");
''',
)
