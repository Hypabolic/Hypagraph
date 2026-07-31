# Skill guidance audit — goal-family product surface (F5)

- Source: `skills/hypagraph/SKILL.md`
- Also checked: `README.md` Current status; `docs/scratch/family-product-e2e-path.md`
- Plan checklist: `docs/goal-family-product-surface-plan.md` §11
- Writing standard: ASD-STE100 Simplified Technical English

## Checklist (Wave F5)

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Goal contract before graph | Pass | Skill § Define the goal before you build the graph |
| 2 | Encoding table: node / component / child / revise | Pass | Skill encoding table + wayfinder rows |
| 3 | `hypagoal_create_child` when available | Pass | Skill § `hypagoal_create_child` (live tool) |
| 4 | Parent `waiting_for_child` behaviour | Pass | Child shape + Parent wait and return |
| 5 | Return does not complete parent | Pass | Mental model rule 5; Parent wait and return item 3 |
| 6 | Isolated workers for child tasks | Pass | Child shape item 9; create-child rules |
| 7 | Status inspection for family members | Pass | Parent wait and return items 4–5; wayfinder Inspect state |
| 8 | Flagship free-form root + child recipe | Pass | Skill § Flagship family recipe |

## Excerpts

### Live tool (replaces unavailable honesty)

```
### `hypagoal_create_child` (live tool)

Use this tool when a child Hypagoal is justified and a parent **task** attempt is active (after the user chose **Run** on the root).

Required parameters:

- `parentNodeId` — active parent task node id;
- `childObjective` — child outcome prose;
- `draftId` **or** `definition` — child graph (prefer `draftId` after construction tools);
- `scopePaths` — child repository scope; must equal or narrow the parent grant.
```

### Parent wait and return

```
1. While the parent waits, unrelated ready root components stay eligible for the family scheduler.
2. Child terminal success returns declared output facts and evidence into the binding.
3. The parent task leaves wait and becomes **running** for integration work. It is **not** completed by child success.
4. Inspect members, bindings, child-wait, budget, and focus with `/hypagraph status` and `hypagraph_read`.
```

### Flagship recipe

```
Root free-form shape:

1. `delegate` — task that will call `hypagoal_create_child` ...
2. `integrate` — task, `requires: ["delegate"]` ...
```

### Removed limitation

The skill no longer states that child create is unavailable on the active tool surface.

## README

README Current status lists:

- `hypagoal_create_child`;
- family-aware controller selection;
- child return on product path;
- multi-member status and graph member focus.

## Dogfood

- Automated: `docs/scratch/family-product-e2e-path.md` + `tests/family-product-f5-e2e-extension.test.ts`
- Live: pending unless `docs/scratch/family-product-dogfood.md` records a pass

## Verdict

A11 skill honesty holds for the family product path. A12 automated path is covered by the F5 e2e test and prior F1–F4 suites.
