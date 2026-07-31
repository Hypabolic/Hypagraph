# Wave 3 implementation summary — Mermaid projection and grok-mermaid

## Status

**Wave 3 complete (S3.1–S3.3 / G1–G2).** Review issues resolved.

## Slices

| Slice | Result |
| --- | --- |
| **S3.1 / G1** | Pure `projectMermaidFlowchart` in `src/graph/mermaid-projection.ts`; linear, gate, loop fixtures; escaping; empty graph; no `grok-mermaid` import |
| **S3.2 / G2 dep** | Production dependency `grok-mermaid@^0.2.0`; root `NOTICE` with Apache-2.0 attribution |
| **S3.3 / G2 host** | `src/ui/mermaid-art.ts` `renderMermaidArt`: render, optional ANSI theme, width fit, sourceBox / text fallback |

## Review fixes (round 2)

| Issue | Fix |
| --- | --- |
| **mermaidSafeId collision** | Injective encode: non-alphanumeric → `_hex_`. Hyphen (`a-b` → `a_2d_b`) ≠ underscore (`a_b` → `a_5f_b`). |
| **Unique allocation** | `buildMermaidIdTables` + `allocateUniqueMermaidIds` assign node and subgraph ids in one space; subgraphs use `sg_` prefix. |
| **Null art path** | Tests for empty/unsupported source: `art === null`, source-box default, text when `preferSourceBox: false`. |

## Files changed

| File | Change |
| --- | --- |
| `src/graph/mermaid-projection.ts` | Pure projection; injective ids; unique tables; exposed id maps |
| `src/ui/mermaid-art.ts` | Host render helper via grok-mermaid |
| `tests/mermaid-projection.test.ts` | Linear/gate/loop + collision + allocation regression tests |
| `tests/mermaid-art.test.ts` | Non-empty art, width fallback, **null render** fallbacks, ANSI |
| `package.json` / `package-lock.json` | `grok-mermaid` production dependency |
| `NOTICE` | Third-party notice for grok-mermaid (Apache-2.0) |
| `docs/product-surface-orchestration-plan.md` | Wave 3 done; next work Wave 4 or 5 |
| `docs/post-create-graph-dock-plan.md` | G1–G2 done; G3–G5 pending |

## Design decisions

1. Pure module boundary: projection only imports `GraphViewModel` types; host art imports `grok-mermaid`.
2. Direction default: `LR` for graphs with ≤ 4 nodes and no multi-node loop; otherwise `TD`. Options override.
3. Node shapes: task rectangle, gate diamond, check/interaction stadium, code/effect parallelogram.
4. Edges: dependency solid; route labelled `true`/`false`; skipped dotted (omit in compact); feedback labelled `feedback`.
5. Multi-node loops emit `subgraph sg_<encodedLoopId>`; single-node loops stay flat.
6. Width overflow or null render: use `sourceBox` by default; optional text fallback.
7. Labels: double-quoted; strip newlines; map `"` `[]` `{}` `#` to safe forms; truncate with `…`.
8. Identifiers: injective `mermaidSafeId` + projection-wide unique allocation (nodes + subgraphs).

## Tests run

```text
npx tsc --noEmit
npx vitest run tests/mermaid-projection.test.ts tests/mermaid-art.test.ts
# 2 files, 20 tests passed
```

## Not done (deferred to Wave 4+)

- Post-create bottom dock component (G3)
- Auto-continue gate and Run / Question / Cancel wiring (G4)
- Skill / README post-create UX (G5)
- Live graph pane Mermaid reuse

## Acceptance (Wave 3 exit)

1. Library can turn a sample state into terminal art without UI — yes via `projectGraphView` → `projectMermaidFlowchart` → `renderMermaidArt`.
2. Pure unit tests do not load Pi UI — yes.
3. Domain / pure graph does not import grok-mermaid — yes.
4. Dependency installs and renders — yes (`grok-mermaid@0.2.0`).
5. Distinct Hypagraph node ids never share one Mermaid id — yes (injective encode + unique tables).
6. Null render path covered by tests — yes.
