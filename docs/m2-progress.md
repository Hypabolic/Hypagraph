# M2 implementation progress

M2 adds typed facts and deterministic graph conditions.

## Implemented

- A closed set of fact types.
- Fact contracts.
- Fact value validation.
- Workflow revision checks.
- Attempt identity checks.
- A typed condition abstract syntax tree.
- A deterministic condition evaluator.
- Fact-use tracking for future route events.

## Next work

1. Add fact contracts to node definitions.
2. Add a fact publication command.
3. Add fact publication and rejection events.
4. Project accepted facts into workflow state.
5. Add gate node definitions and route selection events.
6. Mark nodes on routes that are not selected as skipped.
