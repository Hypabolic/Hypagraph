# Product surface orchestration plan

- Status: Waves 0–7 code complete for the primary product path (see status board); Wave 8 S8.1 script complete (live acceptance pending); S8.2 complete; S8.3 release packaging skipped — no release request; live interactive dogfood still pending for Waves 2, 4, 5, 6, and full E2E
- Purpose: one ordered, sliced work program an orchestrator can run without re-deriving intent
- Baseline product: Hypagraph v0.14 on `main`, plus uncommitted start-surface work in the working tree
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Program goal

Deliver a complete **user and model start-to-run surface** for Hypagraph:

1. The user can arm and create a Hypagoal clearly (trigger, highlight, validate, create).
2. After create, the user sees the graph and chooses **Run**, **Question**, or **Cancel**.
3. Interaction questions dock at the bottom, not as a center modal.
4. Model node work runs in isolated worker sessions by default (orchestrator session is not the runner).
5. Authoring moves toward constructor tools and durable `.hypagraph` project storage.

Kernel milestones M7–M9 (families, worktrees, fan-out, ACP/CLI) stay shipped. This program is the **product shell** around that kernel.

## 2. Source plans

| Plan | Path |
| --- | --- |
| Trigger and command surface | `docs/trigger-and-command-surface-plan.md` |
| Trigger editor highlight | `docs/trigger-editor-highlight-plan.md` |
| Interaction bottom dock | `docs/interaction-bottom-dock-plan.md` |
| Post-create graph dock (grok-mermaid) | `docs/post-create-graph-dock-plan.md` |
| Isolated model-session execution | `docs/isolated-model-session-execution-plan.md` |
| Authoring tools and project store | `docs/authoring-tools-and-project-store-plan.md` |
| Goal-family product surface (multi-member hypergraph path) | `docs/goal-family-product-surface-plan.md` |
| Goal-family product remediation (R1–R6 trust fixes) | `docs/goal-family-product-remediation-plan.md` |

Detail for each slice lives in those plans. This document is the **execution order**, **dependencies**, and **done checks** for an orchestrator for the start-to-run shell. Multi-member family productization is a separate program in the goal-family product surface plan. Trust remediations after dual review are in the remediation plan.

## 3. Baseline inventory

### 3.1 Treat as done (do not re-implement)

Confirm in the working tree before Wave 0 closes. If missing on the branch under execution, implement the missing piece as a Wave 0 fix, not as a new product design.

| ID | Capability |
| --- | --- |
| B1 | Keyword arming (`messageArmsHypagoal`), one-turn, fences/paths excluded |
| B2 | Status `Hypagoal armed` after submit |
| B3 | `/hypagraph trigger set\|off\|status` |
| B4 | `hypagraph_validate` pure tool (no state) |
| B5 | `hypagraph_define` removed from model surface |
| B6 | `hypagoal_start` as the only creation path |
| B7 | Merged `/hypagraph` control (status, pause, resume, cancel, ask, history, …) |
| B8 | Loop authoring guidance + validation suggestions on hard diagnostics |

### 3.2 Known defects to fix early (Wave 0)

| ID | Defect |
| --- | --- |
| F1 | `hypagraph_validate` tool text omits diagnostic `suggestion` fields |
| F2 | Dead `commitCreatedWorkflow` import / stale comment in `extension.ts` if still present |
| F3 | Product docs still name `hypagraph_define` or primary `/hypagoal` control in places |
| F4 | Roadmap/plan status strings still say “proposed” for shipped trigger slices |
| F5 | Optional: do not block pure `hypagraph_validate` on stale-continuation turns |

### 3.3 Explicitly not in this program

- Rainbow graph pane redesign (side pane may later reuse Mermaid; not required here)
- Resident supervisor / trigger service / timers
- Named recipe library / Gauntlet product pack
- Formal v1.0 hardening pass beyond the slices below

## 4. Orchestrator rules

1. Execute **one slice at a time** unless the slice marks **parallel-safe**.
2. Each slice must end with: code + tests green (`npm run check` or the package check script) + acceptance criteria checked.
3. Do not expand scope into M10+ kernel features.
4. Prefer pure domain first, then host/UI.
5. Keep ASD-STE100 for repository prose.
6. Use the name Hypagraph only. Do not add old product-name aliases.
7. Domain reducer must stay pure (no filesystem, no network, no clock in reduce).
8. All new persisted records must include a schema version.
9. After each wave, update this document’s wave status line and the detail plan status if that wave completed the detail plan.

## 5. Dependency graph (waves)

```text
Wave 0  Baseline polish + defects
   |
   +---> Wave 1  Shared bottom-dock chrome
   |        |
   |        +---> Wave 2  Interaction bottom dock
   |        |
   |        +---> Wave 3  Mermaid projection + grok-mermaid
   |                 |
   |                 +---> Wave 4  Post-create Run/Question/Cancel dock + auto-continue gate
   |
   +---> Wave 5  Live trigger editor highlight   (can start after Wave 0; parallel with 1–4 if capacity)
   |
   +---> Wave 6  Isolated model sessions (default runner off main thread)
   |
   +---> Wave 7  Authoring constructors + .hypagraph store
   |
   +---> Wave 8  Integration dogfood + release packaging
```

**Critical path for “create → see graph → Run” UX:** Wave 0 → 1 → 3 → 4.

**Critical path for “orchestrator ≠ runner”:** Wave 0 → 6.

**Critical path for “type hypagoal → rainbow”:** Wave 0 → 5.

## 6. Wave 0 — Baseline verify and fix

**Goal:** One clean branch that owns shipped trigger/command work and known fixes.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S0.1** | Inventory and branch | — | Confirm B1–B8 present or list gaps; create working branch | Checklist written in PR/notes |
| **S0.2** | Validate suggestions in tool text | S0.1 | `renderHypagraphValidation` includes `suggestion`; test | Invalid loop feedback text contains requires-repair suggestion |
| **S0.3** | Extension cleanup | S0.1 | Remove dead imports/comments; stale-continuation policy for validate if easy | `npm run check` |
| **S0.4** | Doc truth for trigger slices | S0.1 | Status of trigger plan → implemented for 1–3; README/skill prefer `/hypagraph` control | No active doc requires `hypagraph_define` for create |

**Parallel-safe:** S0.2, S0.3, S0.4 after S0.1.

**Exit:** Green check; orchestrator may start Wave 1 and Wave 5.

## 7. Wave 1 — Shared bottom-dock chrome

**Goal:** One placement helper for all bottom TUI docks.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S1.1** | `interactionDockOverlayOptions` (or `bottomDockOverlayOptions`) | S0.2 | Shared helper: `anchor: "bottom-center"`, full width, maxHeight, footer margin | Unit test asserts option shape |
| **S1.2** | Wire helper into present paths as available | S1.1 | At least one call site uses the helper (interaction or stub) | No center-default path for that call site |

**Detail:** `docs/interaction-bottom-dock-plan.md` Option A.

**Exit:** Shared options module exists and is tested.

## 8. Wave 2 — Interaction bottom dock

**Goal:** Ask / interaction UI at the bottom, not a center modal.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S2.1** | Bottom placement for `presentInteractionDialog` | S1.1 | Use shared bottom options | Custom present asserts bottom anchor |
| **S2.2** | Component chrome polish | S2.1 | Clear dock border; keep closed/open behaviour | Manual dogfood: question sits in composer zone |
| **S2.3** | Follow-up free-text/feedback path check | S2.1 | Verify or dock host `input` follow-ups if they still center | Dogfood note |

**Detail:** `docs/interaction-bottom-dock-plan.md` D1–D3.

**Exit:** `/hypagraph ask` and controller presentation dock bottom in interactive Pi.

## 9. Wave 3 — Mermaid projection and grok-mermaid

**Goal:** Canonical graph view → Mermaid → Unicode art.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S3.1** | Pure `projectMermaidFlowchart` | S0.1 | `src/graph/mermaid-projection.ts`; linear, gate, loop fixtures | Pure unit tests; no grok-mermaid import |
| **S3.2** | Add `grok-mermaid` dependency | S0.1 | `package.json` + lock; NOTICE/attribution as required | Install and import works |
| **S3.3** | Host art helper | S3.1, S3.2 | Render, theme, width fit, sourceBox/text fallback | Fixture flowchart produces non-empty art |

**Detail:** `docs/post-create-graph-dock-plan.md` G1–G2.

**Parallel-safe:** S3.1 can start in parallel with Wave 1–2 after Wave 0.

**Exit:** Library can turn a sample state into terminal art without UI.

## 10. Wave 4 — Post-create graph dock and Run gate

**Goal:** After create, bottom dock with diagram + Run / Question / Cancel; no auto-run until Run.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S4.1** | Post-create dock component | S1.1, S3.3 | Diagram + three actions; keyboard; recommended Run | Component tests or extension harness |
| **S4.2** | Auto-continue gate | S4.1 | Host flag; suppress `queueGoalContinuation` until Run | Test: create does not queue until Run |
| **S4.3** | Action wiring | S4.2 | Run → queue; Question → suppress, keep goal; Cancel → cancel-goal | Tests for three outcomes |
| **S4.4** | Headless policy | S4.2 | Headless auto-continue documented + tested | No dock required off TUI |
| **S4.5** | Skill/README | S4.3 | Authoring wait for user decision in TUI | Skill text updated |

**Detail:** `docs/post-create-graph-dock-plan.md` G3–G5.

**Open decisions (use recommended defaults unless user overrides):**

- Question: active + suppress auto-continue until Run.
- Esc: dismiss as Question, not Cancel.
- Replacement create: show dock.
- Model transcript: short summary + Mermaid in details; art TUI-only.

**Exit:** Interactive create shows Mermaid dock; work starts only on Run.

## 11. Wave 5 — Live trigger editor highlight

**Goal:** Typing the trigger word highlights in the composer before submit.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S5.0** | Pi API discovery note | S0.1 | `setEditorFactory` contract, wrap vs last-writer, buffer indices | Short note in PR or `docs/scratch/` |
| **S5.1** | `findHypagoalTriggerSpans` | S0.1 | Pure spans; parity with `messageArmsHypagoal` | Unit tests: fences, paths, multi-match, off |
| **S5.2** | Editor factory prototype | S5.0, S5.1 | Live repaint of matching tokens; headless no-op | Dogfood: highlight before submit |
| **S5.3** | Stock editor parity + trigger set/off refresh | S5.2 | Submit/newline/paste; settings update without reload when possible | Dogfood checklist |
| **S5.4** | Docs | S5.2 | README/skill: live highlight is part of arming | Docs updated |

**Detail:** `docs/trigger-editor-highlight-plan.md` H1–H4.

**Parallel-safe:** Entire wave can run parallel to Waves 1–4 after Wave 0, if capacity allows. Coordinate with Wave 4 if both replace editor focus; prefer overlay docks not owning the editor until S5.2 lands.

**Exit:** Typing standalone `hypagoal` highlights before send; status still arms on submit.

## 12. Wave 6 — Isolated model sessions (default)

**Goal:** Main Pi session is orchestrator only; each model node attempt uses a worker session by default.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S6.1** | Default profile resolution | S0.1 | Model nodes default `isolated-pi`; current-session opt-in only | Pure policy tests |
| **S6.2** | Root dispatch via isolated executor | S6.1 | Replace implement follow-up `sendUserMessage` with isolated dispatch | First task after Run does not implement in orchestrator chat |
| **S6.3** | Restore, cancel, orphan reconciliation | S6.2 | Reload/cancel/timeout settlement | Tests for stale double-settle |
| **S6.4** | Session fork / affinity (optional within wave) | S6.3 | Cold default; `same-node-lineage` opt-in | Tests for cold default |
| **S6.5** | Revision + loop bodies on workers | S6.2 | Automatic revision and loop tasks off main thread | Dogfood or tests |
| **S6.6** | Block orchestrator as worker | S6.2 | Tool block while worker owns mutating attempt | Test |
| **S6.7** | UI/skill/release notes | S6.2 | Status shows worker attempts; behaviour-break notes | Docs |

**Detail:** `docs/isolated-model-session-execution-plan.md` slices 1–7.

**Depends on product UX:** Prefer Wave 4 before broad dogfood of S6.2 so create → Run → first task is one coherent path. Implementation of S6.1 can start earlier.

**Exit:** Default model work is not same-session implement follow-up; orphaned continuation noise for task bodies should drop sharply.

## 13. Wave 7 — Authoring constructors and project store

**Goal:** Argument-driven construction + durable `.hypagraph` drafts/definitions.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S7.1** | Project store skeleton | S0.1 | `.hypagraph` index, settings, README helpers | Schema version reject test |
| **S7.2** | Draft model + validate tools | S7.1 | begin/status/validate/discard; disk drafts | Pure projection + no accidental create |
| **S7.3** | Low-level constructors + loop tool | S7.2 | add task/check/require; loop owns feedback edges | Feedback-edge failure mode cannot be hand-authored on happy path |
| **S7.4** | Recipes + commit-by-draft-id | S7.3 | implement/verify recipe; `hypagoal_start` prefers draft id | Create from draft; free-form demoted |
| **S7.5** | Project-first events (optional later in wave) | S7.1 | Event log under workflows if scheduled | Restore from project store |
| **S7.6** | Skill teaches tools first | S7.4 | Authoring prompt/skill | No primary free-form loop JSON teaching |

**Detail:** `docs/authoring-tools-and-project-store-plan.md` slices A–F.

**Ordering note:** After Wave 4 and Wave 6 preferred so constructors feed a stable run surface. S7.1–S7.2 can start earlier if capacity allows.

**Exit:** Model can build a valid loop without hand-writing `feedbackEdges`; drafts survive on disk.

## 14. Wave 8 — Integration dogfood and packaging

**Goal:** One coherent path works end-to-end; docs and release notes match.

| Slice | Title | Depends | Deliverables | Acceptance |
| --- | --- | --- | --- | --- |
| **S8.1** | E2E dogfood script | Waves 2, 4, 5, 6 (as landed) | Written path: arm → create → dock → Run → isolated task → ask dock | Script authored under `docs/scratch/`; live evidence under `docs/dogfood-evidence/` or PR when run |
| **S8.2** | Plan status reconciliation | S8.1 script | Mark completed detail plans implemented; roadmap section 18 updated | No contradictory “defer highlight” language |
| **S8.3** | Release packaging (only if user requests) | S8.2 | Version, CHANGELOG, release notes | User-approved cut |

**Wave 8 progress:** S8.1 **script complete; live acceptance pending** — written path at `docs/scratch/product-surface-e2e-path.md`; live E2E dogfood evidence not recorded. S8.2 complete (status board, detail plans, roadmap section 18). S8.3 skipped — no release request.

**Exit:** Orchestrator can stop after S8.2; product path is code-complete and scripted. Live demo still needs interactive Pi dogfood for S8.1 acceptance. Release packaging is separate (S8.3).

## 15. Slice card template (for implementers)

Copy this into each PR or agent task:

```text
Slice ID:
Wave:
Depends on:
Source plan section:
Deliverables:
Out of scope:
Acceptance criteria:
Tests to add/run:
Risk notes:
```

## 16. Recommended single-threaded schedule

If one implementer or one agent:

1. Wave 0  
2. Wave 1  
3. Wave 3 (Mermaid; unblocks create dock)  
4. Wave 4 (post-create dock — highest user-visible create UX)  
5. Wave 2 (interaction dock — shared chrome already exists)  
6. Wave 5 (highlight)  
7. Wave 6 (isolated sessions)  
8. Wave 7 (authoring store)  
9. Wave 8  

If two parallel agents after Wave 0:

| Agent A (UX path) | Agent B (execution path) |
| --- | --- |
| Wave 1 → 3 → 4 → 2 | Wave 5 (highlight) then join for Wave 6 |
| Then both: Wave 7 → 8 | |

Do not run two editor-factory owners without coordination (Wave 5 vs any editor-slot fallback in Wave 2/4). Prefer overlay docks for 2/4.

## 17. Definition of done (program)

The program is done when:

1. Trigger highlight works while typing (Wave 5) and status arming still works on submit (baseline).
2. Interaction ask docks at the bottom (Wave 2).
3. Create shows grok-mermaid art with Run / Question / Cancel; interactive auto-continue only after Run (Wave 4).
4. Default model node attempts run off the main session (Wave 6).
5. Authoring has at least draft validate + loop constructor path or an explicit deferred waiver for Wave 7 signed in the PR (Wave 7 may be partial if capacity ends; document remainder).
6. `npm run check` green.
7. Detail plans and roadmap section 18 no longer contradict reality.

## 18. Orchestrator start command (prompt seed)

Use this as the root task prompt for an implement/review workflow:

```text
Execute docs/product-surface-orchestration-plan.md.

Rules:
- Follow wave order and slice dependencies.
- Complete Wave 0 first.
- Prefer the single-threaded schedule unless told to parallelize.
- Each slice: implement, test, meet acceptance, then next slice.
- Do not implement rainbow as optional; Waves 4 and 5 are required UX.
- Do not auto-continue interactive create until Run (Wave 4).
- Keep domain pure; use Hypagraph naming; ASD-STE100 for repo prose.
- Stop after S8.2 unless the user requests a release cut (S8.3).

Report after each wave: slices done, tests run, remaining blockers.
```

## 19. Status board (orchestrator updates)

| Wave | Status | Notes |
| --- | --- | --- |
| 0 Baseline fix | done | B1–B8 confirmed; F1 suggestions in validate text; F2 dead import removed; F5 validate allowed on stale turn; F3/F4 doc truth for `/hypagraph` control and trigger plan slices 1–3 |
| 1 Shared bottom dock | done | `bottomDockOverlayOptions` + interaction present path; goal complete/fail clear pending continuation |
| 2 Interaction dock | code done; live dogfood pending | Bottom dock, top border, option viewport, free-text note; L1–L8 live Pi not run (`docs/scratch/wave2-dogfood-note.md`) |
| 3 Mermaid + grok-mermaid | done | `projectMermaidFlowchart`, `grok-mermaid` 0.2.0, `renderMermaidArt`, NOTICE |
| 4 Post-create dock + Run gate | code done; live dogfood pending | Post-create dock, host gate, Run/Question/Cancel, headless auto-continue, skill/README. Live TUI dogfood of the dock not recorded. |
| 5 Trigger highlight | code done; live dogfood pending | S5.0 discovery note; pure spans; editor wrap factory; trigger set/off refresh; README/skill. Live Pi dogfood not run. Highlight is required product surface, not deferred polish. |
| 6 Isolated sessions | code done; S6.4–S6.5 deferred | S6.1 profile default isolated-pi; S6.2 root task dispatch via isolated workers (no default followUp); S6.3 restore/cancel/double-settle; S6.6 tool block; S6.7 status/skill. Live dogfood and affinity (S6.4) / revision workers (S6.5) remain. |
| 7 Authoring + `.hypagraph` | code done for S7.1–S7.4; S7.5 deferred; S7.6 partial | Project store, drafts, constructors, recipe, commit-by-draft-id. Skill teaches tools first. Project-first events (S7.5) deferred. Live multi-tool dogfood pending. |
| 8 Dogfood + packaging | S8.1 script complete (live acceptance pending); S8.2 done; S8.3 skipped | E2E script at `docs/scratch/product-surface-e2e-path.md`. Plan statuses reconciled. No release cut. Live E2E dogfood evidence not recorded. |

---

**Immediate next work:** live interactive Pi dogfood of the E2E path in `docs/scratch/product-surface-e2e-path.md` (arm → create → dock → Run → isolated task → interaction dock). Optional remainder: S6.4 affinity, S6.5 revision/loop workers, S7.5 project-first events. Do not cut a release unless the user requests S8.3.
