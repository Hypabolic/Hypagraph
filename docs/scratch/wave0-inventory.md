# Wave 0 inventory (S0.1)

- Date: working-tree inventory for product-surface orchestration Wave 0
- Branch: `main` (uncommitted start-surface work present)
- Source: `docs/product-surface-orchestration-plan.md` section 3 and section 6

## Baseline B1–B8

| ID | Capability | Status | Evidence |
| --- | --- | --- | --- |
| B1 | Keyword arming (`messageArmsHypagoal`), one-turn, fences/paths excluded | Present | `src/pi/hypagoal-arming.ts`, `tests/hypagoal-arming.test.ts`, `src/extension.ts` input hook |
| B2 | Status `Hypagoal armed` after submit | Present | `HYPAGOAL_ARMED_STATUS_TEXT` in `src/pi/hypagoal-arming.ts`; status set from `hypagoalArmedForTurn` in `src/extension.ts` |
| B3 | `/hypagraph trigger set\|off\|status` | Present | `/hypagraph trigger` handler and usage in `src/extension.ts` |
| B4 | `hypagraph_validate` pure tool (no state) | Present | Tool registration in `src/extension.ts`; `src/pi/validate-definition.ts`; `tests/hypagraph-validate.test.ts` |
| B5 | `hypagraph_define` removed from model surface | Present | No `hypagraph_define` tool registration in `src/extension.ts` |
| B6 | `hypagoal_start` as the only creation path | Present | `hypagoal_start` registered; no other create tool on the model surface |
| B7 | Merged `/hypagraph` control | Present | Usage covers status, pause, resume, cancel, ask, history, explain, loop, check, graph, executor, trigger |
| B8 | Loop authoring guidance + validation suggestions on hard diagnostics | Present | Prompt guidelines in `src/extension.ts` and `src/pi/hypagoal.ts`; domain diagnostics carry `suggestion` in `src/domain/validate.ts` |

No baseline gap requires a new product design in Wave 0.

## Known defects F1–F5

| ID | Defect | Status after inventory | Wave 0 owner |
| --- | --- | --- | --- |
| F1 | `renderHypagraphValidation` omits diagnostic `suggestion` | Confirmed open: `src/pi/validate-definition.ts` maps code, location, message only | S0.2 |
| F2 | Dead `commitCreatedWorkflow` import / stale comment in `extension.ts` | Confirmed open: import and comment present; no call site in `src/extension.ts` | S0.3 |
| F3 | Product docs still name `hypagraph_define` or primary `/hypagoal` control | Partially open: trigger plan still describes old dual create path; README still lists full `/hypagoal` control table ahead of `/hypagraph` | S0.4 |
| F4 | Roadmap/plan status strings still say “proposed” for shipped trigger slices | Trigger plan already says slices 1–3 implemented; orchestration plan Wave 0 board still pending; other shipped-status drift may remain | S0.4 |
| F5 | Optional: do not block pure `hypagraph_validate` on stale-continuation turns | Confirmed: stale-continuation tool block list includes `hypagraph_validate` in `src/extension.ts` | S0.3 if easy |

## Branch note

Work continues on the current `main` working tree that already holds uncommitted start-surface changes. No separate branch was required for inventory.

## Out of scope (do not start in Wave 0)

- Waves 1–8 product features (bottom dock, Mermaid dock, highlight, isolated sessions, authoring store, dogfood packaging)

## Next slices

1. S0.2 — include `suggestion` in `renderHypagraphValidation` and test invalid-loop feedback text
2. S0.3 — remove dead `commitCreatedWorkflow` import; consider F5 if safe
3. S0.4 — doc truth for trigger slices, README/skill control surface, Wave 0 status board
