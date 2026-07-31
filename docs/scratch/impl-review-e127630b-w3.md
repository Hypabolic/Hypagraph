# Wave 3 Mermaid implementation review

## Summary

Result: Changes requested (addressed).

Confirmed:

- G1 and G2 match the documented scope.
- The pure projection module has no `grok-mermaid` import. It imports only graph-view types.
- `grok-mermaid` is a production dependency at `^0.2.0`. The lock file resolves version `0.2.0`.
- Tests exist for linear, gate, and loop projections.
- Tests exist for source-box and text fallbacks.
- `npm run typecheck` passes.
- Direct `grok-mermaid` smoke checks rendered the linear, gate, and loop syntax without warnings.
- Vitest could not run in the current read-only sandbox. Vitest received `EPERM` while creating its temporary SSR directory.

## Issues

### Mermaid identifier conversion can merge valid Hypagraph nodes

- Severity: `bug`
- Status: `resolved`
- Location: [src/graph/mermaid-projection.ts](/Users/matthew/Development/hypabolic/Hypagraph/src/graph/mermaid-projection.ts)

`mermaidSafeId` replaces hyphens with underscores. Hypagraph permits both characters in identifiers. Therefore, valid identifiers such as `a-b` and `a_b` both become `a_b`.

The projection emits both declarations with the same Mermaid identifier. `grok-mermaid` then renders one node and overwrites its label. Edges also connect to the merged node. This violates the G1 requirement to emit one node for each graph-view node.

Use an injective encoding or allocate unique Mermaid identifiers for the complete projection. Add a regression test for colliding node identifiers and node/subgraph identifiers.

**Resolution:** `mermaidSafeId` now encodes non-alphanumeric code points as `_` + hex + `_` (injective). Projection allocates node and subgraph ids in one space via `buildMermaidIdTables` / `allocateUniqueMermaidIds`, with subgraphs under a structural `sg_` prefix. Regression tests cover hyphen/underscore node pairs and node-vs-subgraph collisions.

### The render-null fallback path has no direct test

- Severity: `suggestion`
- Status: `resolved`
- Location: [tests/mermaid-art.test.ts](/Users/matthew/Development/hypabolic/Hypagraph/tests/mermaid-art.test.ts)

The fallback tests force width overflow, but they do not make `grok-mermaid` return `null`. The helper handles both cases through the same main branch, but the `art: null`, warning, and invalid-source behavior remain unverified.

Add one unsupported, invalid, or empty Mermaid fixture. Confirm source-box fallback and text fallback when `render` returns `null`.

**Resolution:** Tests assert `render("")` and unsupported kinds return null, then confirm `renderMermaidArt` uses source-box by default and text when `preferSourceBox: false`.
