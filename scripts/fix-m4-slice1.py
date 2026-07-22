from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Required text was not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


replace(
    "src/domain/validate.ts",
    'const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || (isRecord(value) && value.kind === "legacy-text");',
    'const isLegacyPredicate = (value: LoopDefinition["successWhen"]): value is string | LegacyLoopPredicate => typeof value === "string" || "text" in value;',
)

replace(
    "tests/graph-layout-renderer.test.ts",
    '    maxIterations: 3,\n  }],',
    '    maxIterations: 3,\n    status: "inactive",\n    currentIteration: 0,\n  }],',
)

replace(
    "tests/loop-slice-one.test.ts",
    'import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";',
    'import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";',
)
replace(
    "tests/loop-slice-one.test.ts",
    '  facts: HypagraphCommand & { type: "publish-facts" }["facts"] = [],',
    '  facts: FactInput[] = [],',
)
