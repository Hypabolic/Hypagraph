from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        if new in text:
            return
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/domain/model.ts",
    "  noProgressCount: number;\n  startedAt?: string;",
    "  noProgressCount?: number;\n  startedAt?: string;",
)

replace_once(
    "src/domain/projection.ts",
    "    factsUsed: [],\n    noProgressCount: 0,\n    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),",
    "    factsUsed: [],\n    ...(legacyText === undefined ? {} : { legacyPredicate: legacyText }),",
)

replace_once(
    "src/domain/reducer.ts",
    "      noProgressCount: runtime.noProgressCount,",
    "      noProgressCount: runtime.noProgressCount ?? 0,",
)
replace_once(
    "src/domain/reducer.ts",
    "    noProgressCount: improved ? 0 : runtime.noProgressCount + 1,",
    "    noProgressCount: improved ? 0 : (runtime.noProgressCount ?? 0) + 1,",
)

replace_once(
    "tests/loop-progress.test.ts",
    'import { replayEvents } from "../src/domain/projection.js";\n',
    'import { replayEvents } from "../src/domain/projection.js";\nimport { restoreLatestSession } from "../src/persistence/session-rebuild.js";\n',
)
replace_once(
    "tests/loop-progress.test.ts",
    'describe("M4 Slice 5 progress and patience", () => {\n',
    '''describe("M4 Slice 5 progress and patience", () => {\n  it("keeps existing schema-3 loop sessions hash compatible", () => {\n    const existing = definition();\n    delete existing.loops[0]!.progress;\n    delete existing.loops[0]!.patience;\n    const created = createWorkflow(existing, at, "workflow-schema3-loop");\n    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));\n    expect(Object.hasOwn(created.state.runtime.loops["quality-loop"]!, "noProgressCount")).toBe(false);\n    const restored = restoreLatestSession([{\n      type: "message",\n      message: {\n        role: "toolResult",\n        toolName: "hypagraph_define",\n        details: { hypagraph: { events: created.events, snapshot: created.state } },\n      },\n    }]);\n    expect(restored?.snapshot).toEqual(created.state);\n  });\n\n''',
)
