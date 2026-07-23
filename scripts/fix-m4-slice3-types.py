from pathlib import Path

path = Path("tests/loop-check-repair.test.ts")
text = path.read_text()
text = text.replace(
    '''      acceptance: [],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        retry: { maxAttempts: 2, retryOn: ["error"] },
        publish: [],
      },
''',
    '''      acceptance: [],
      produces: [{ name: "lint.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        retry: { maxAttempts: 2, retryOn: ["error"] },
        publish: [{ source: "passed", fact: "lint.passed" }],
      },
''',
    1,
)
text = text.replace(
    '    successWhen: { kind: "literal", value: true },',
    '''    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "lint.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },''',
    1,
)
text = text.replace(
    '    expect(state.runtime.loops.repair.currentIteration).toBe(1);',
    '    expect(state.runtime.loops.repair?.currentIteration).toBe(1);',
    1,
)
path.write_text(text)
