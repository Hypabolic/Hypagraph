# Product surface end-to-end path

- Status: S8.1 **script complete; live acceptance pending** — path and fixture written; live interactive Pi dogfood not recorded
- Source program: `docs/product-surface-orchestration-plan.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This note records the intended start-to-run path for Hypagraph product surface work.

A person must be able to follow this path in interactive Pi. Automated tests cover most host and pure domain behaviour. Live interactive dogfood still remains for several UI steps.

## 2. Intended path

```text
arm
  → create (interaction-capable graph; draft tools optional)
  → post-create dock (Run / Question / Cancel)
  → isolated task (default)
  → interaction dock
```

Each step below states the product behaviour, the code status, and whether live dogfood has run.

## 3. Step detail

### 3.1 Arm

| Field | Value |
| --- | --- |
| Intent | The person types the trigger word (default `hypagoal`). The composer highlights matching tokens before submit. On submit, status shows `Hypagoal armed` for one turn. |
| Commands / surfaces | Typing in the Pi composer; optional `/hypagraph trigger set\|off\|status` |
| Primary modules | `src/pi/hypagoal-arming.ts`, `src/pi/hypagoal-trigger-editor.ts`, `src/extension.ts` (`input` hook) |
| Detail plans | `docs/trigger-and-command-surface-plan.md` slices 1–3; `docs/trigger-editor-highlight-plan.md` H1–H4 |
| Code status | **Code complete** (Waves 0 and 5) |
| Automated evidence | `tests/hypagoal-arming*.test.ts`, `tests/hypagoal-trigger-spans.test.ts` |
| Live dogfood | **Pending** — type, paste, multiline, and trigger set/off refresh in interactive Pi not recorded |

### 3.2 Create (interaction-capable graph)

| Field | Value |
| --- | --- |
| Intent | Create one root goal whose graph has a ready model task first and an interaction node after that task. After Run, the controller can dispatch the isolated task, then present the interaction dock. |
| Required shape | Linear: `do-work` (task, no `requires`) → `approve-work` (interaction, `requires: ["do-work"]`) |
| Create method for this dogfood | Free-form `definition` on `hypagoal_start` (or `/hypagoal` then model supplies that definition). Draft tools may build other graphs; they do not yet expose `hypagraph_add_interaction`, so the interaction node must come from free-form definition for this path. |
| Fixture | Section 4 below |
| Primary modules | `src/pi/hypagoal.ts`, `src/extension.ts`, `src/domain/validate.ts` |
| Detail plan | `docs/authoring-tools-and-project-store-plan.md` (draft path optional); interaction shape from M6.1 tests |
| Code status | **Code complete** for create + free-form definition; draft tools complete for S7.1–S7.4 without an interaction constructor |
| Automated evidence | Interaction definition fixtures in `tests/m6-1-interaction-*.test.ts`; create path tests |
| Live dogfood | **Pending** — create of the section 4 fixture in interactive Pi not recorded |

### 3.3 Post-create dock (Run / Question / Cancel)

| Field | Value |
| --- | --- |
| Intent | After interactive TUI create, the bottom dock shows Mermaid Unicode art of the graph. The person chooses **Run**, **Question**, or **Cancel**. Work does not auto-continue until Run (or `/hypagraph resume` after Question). |
| Actions | **Run** — clear gate and queue controller continuation. **Question** — keep goal active; suppress auto-continue; block work tools until Run or resume. **Cancel** — cancel the goal after successful `cancel-goal`. **Esc** maps to Question. |
| Headless policy | No dock. No gate. Auto-continue after create. |
| Primary modules | `src/pi/post-create-dock.ts`, `src/graph/mermaid-projection.ts`, `src/ui/mermaid-art.ts`, `src/ui/bottom-dock-overlay.ts`, `src/extension.ts` |
| Detail plan | `docs/post-create-graph-dock-plan.md` G1–G5 (Waves 3–4) |
| Code status | **Code complete** (Waves 3–4) |
| Automated evidence | `tests/post-create-dock.test.ts`, `tests/mermaid-projection.test.ts`, `tests/mermaid-art.test.ts` |
| Live dogfood | **Pending** — create → see art → Run / Question / Cancel in interactive Pi not recorded |

### 3.4 Isolated task (default)

| Field | Value |
| --- | --- |
| Intent | After Run, the controller selects `do-work`. Default model-node task attempts run in isolated-pi worker sessions. The main Pi session stays the orchestrator. Task body work does not appear as an implement follow-up in the orchestrator chat. |
| Opt-in exception | `executorProfile.kind: "current-session"` on the task node (or test-only legacy suite flag) |
| Primary modules | `src/domain/model-executor-profile.ts`, `src/pi/isolated-root-dispatch.ts`, `src/pi/isolated-pi-executor.ts`, `src/extension.ts` |
| Detail plan | `docs/isolated-model-session-execution-plan.md` slices 1–3 and 6–7 |
| Code status | **Code complete** for S6.1–S6.3 and S6.6–S6.7. **Deferred:** S6.4 session affinity; S6.5 revision and loop bodies fully on workers. |
| Automated evidence | `tests/model-executor-profile.test.ts`, `tests/isolated-root-dispatch.test.ts`, `tests/wave6-isolated-root-extension.test.ts` |
| Live dogfood | **Pending** — create → Run → real worker process in interactive Pi not recorded |

### 3.5 Interaction dock

| Field | Value |
| --- | --- |
| Intent | When `approve-work` becomes ready after `do-work` completes, the controller presents the interaction. The question docks at the bottom of the terminal. History stays above. Free-text follow-ups use the host composer slot. |
| Re-present only | `/hypagraph ask` re-presents an **existing open** interaction. It does not create an interaction node. Use it only if the person dismissed the dock and must open it again. |
| Primary modules | `src/ui/bottom-dock-overlay.ts`, `src/pi/interaction-dialog.ts`, `src/extension.ts` |
| Detail plan | `docs/interaction-bottom-dock-plan.md` D1–D3 (Waves 1–2) |
| Code status | **Code complete** (Waves 1–2) |
| Automated evidence | `tests/bottom-dock-overlay.test.ts`, `tests/interaction-bottom-dock.test.ts`; note `docs/scratch/wave2-dogfood-note.md` |
| Live dogfood | **Pending** — L1–L8 and full E2E interaction step not run |

## 4. Interaction-capable graph fixture

Use this free-form definition for live dogfood of the full path. Validate with `hypagraph_validate` before create if useful.

```json
{
  "title": "Product surface E2E",
  "goal": "Run one isolated task, then ask the user to approve",
  "nodes": [
    {
      "id": "do-work",
      "title": "Do the work",
      "kind": "task",
      "requires": [],
      "acceptance": ["The work is done."]
    },
    {
      "id": "approve-work",
      "title": "Approve the work",
      "kind": "interaction",
      "requires": ["do-work"],
      "acceptance": ["The user answers the approval question."],
      "produces": [
        { "name": "work.approved", "type": "boolean", "required": true }
      ],
      "interaction": {
        "kind": "interaction",
        "version": 1,
        "presentation": { "class": "deterministic", "kind": "none" },
        "question": "Approve the completed work?",
        "responses": [
          {
            "id": "approve",
            "label": "Approve",
            "publish": [
              { "name": "work.approved", "type": "boolean", "value": true }
            ]
          },
          {
            "id": "reject",
            "label": "Reject",
            "publish": [
              { "name": "work.approved", "type": "boolean", "value": false }
            ]
          }
        ]
      }
    }
  ],
  "loops": [],
  "policy": { "mode": "guided", "requireEvidence": false }
}
```

### 4.1 Authoring sequence (exact)

1. Start a clean interactive Pi session with no active root goal.
2. Arm with the trigger word (section 5 step 1–2), or call create without arming via explicit authoring.
3. Call `hypagoal_start` with:
   - a short objective string that matches the goal text above; and
   - `definition` set to the JSON fixture in this section.
4. Do not use a draft-only recipe for this path. The implement/verify recipe does not add an interaction node.
5. After successful create, the post-create dock must show both nodes (task then interaction).

Shape source: interaction node contract in `tests/m6-1-interaction-slice-1.test.ts` (linear dependency simplified for this path).

## 5. Path status matrix

| Step | Wave(s) | Code | Automated tests | Live interactive dogfood |
| --- | --- | --- | --- | --- |
| Arm (submit + live highlight) | 0, 5 | complete | pass (focused suites) | pending |
| Create (interaction-capable fixture) | 4, 7 | complete | pass (focused suites) | pending |
| Post-create dock | 3, 4 | complete | pass (focused suites) | pending |
| Isolated task default | 6 | complete for S6.1–S6.3, S6.6–S6.7 | pass (focused suites) | pending |
| Interaction dock | 1, 2 | complete | pass (focused suites) | pending |

## 6. Recommended live dogfood script

Run this sequence in interactive Pi from a clean session with no active root goal.

1. Type a message that contains the standalone trigger word `hypagoal` and a short objective such as `run product surface E2E`. Confirm the token highlights before submit.
2. Submit. Confirm status shows `Hypagoal armed`.
3. Create with the **section 4 fixture** via `hypagoal_start` (`definition` = fixture JSON). Confirm validation accepts the definition. Confirm the graph contains `do-work` then `approve-work`.
4. Confirm the post-create bottom dock shows Mermaid art and three actions (Run / Question / Cancel).
5. Choose **Question**. Confirm work does not start. Then `/hypagraph resume` (maps to Run) or create again and choose **Run** on the fresh create.
6. On **Run**, confirm the first model task is `do-work`, that it does not implement in the orchestrator chat, and that executor status reports isolated routing.
7. After `do-work` completes, confirm the controller presents `approve-work` in the bottom interaction dock (top border, two responses, usable keyboard). Do **not** treat `/hypagraph ask` as the primary step. Use `/hypagraph ask` only if the dock was dismissed and must be re-opened while the interaction remains open.
8. Answer **Approve** or **Reject**. Confirm the goal advances or ends according to the answer.
9. Optional second create: choose **Cancel** on the post-create dock and confirm the goal cancels only after success.

Record evidence under `docs/dogfood-evidence/` or attach notes to the PR when live checks pass. S8.1 acceptance stays open until that evidence exists.

## 7. Explicitly out of this path

- S8.3 release packaging (version cut, CHANGELOG) — only when the user requests a release
- Rainbow graph pane redesign
- Resident supervisor, trigger service, or timers
- S6.4 affinity, S6.5 revision/loop workers on isolated sessions
- S7.5 project-first event log under `.hypagraph`
- Using `/hypagraph ask` as a substitute for an interaction node in the graph

## 8. Definition of “path ready to demo”

The path is ready for a live demo when:

1. Steps 3.1–3.5 pass the live script in section 6 in one session using the section 4 fixture.
2. `npm run check` is green.
3. Detail plans and the orchestration status board match this note.
4. Live evidence is stored under `docs/dogfood-evidence/` or the PR.

Until live dogfood completes, S8.1 is **script complete; live acceptance pending**. The path is **code-complete and test-backed**, not **live-verified**.
