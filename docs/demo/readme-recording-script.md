# README demo recording script (real Pi)

- Purpose: capture one short, deterministic Hypagoal product tour for the GitHub README
- Audience: you (human recorder); Hypagraph + Pi already installed
- Target length: **45–90 seconds**
- Output file: `docs/demo/assets/hypagraph-demo.mp4` (or `.gif` under 10 MB if preferred)
- Writing standard: ASD-STE100 Simplified Technical English

## Prefer automated real Pi (recommended)

Load Hypagraph with **`pi -e ./extensions/hypagraph.ts`** (plus `--skill ./skills`).

1. Start QuickTime screen recording.
2. Run `./docs/demo/run-real-pi-demo.command`.
3. Stop recording when the script finishes.
4. Save to `docs/demo/assets/hypagraph-demo.mp4`.

Short guide: [`JUST-RECORD.md`](JUST-RECORD.md).

## 1. What the video must show

Show these moments in order:

1. Pi TUI open in a clean terminal (dark theme, large font).
2. Composer: trigger word **hypagoal** highlights (or you type `/hypagoal …`).
3. Model creates a root Hypagoal (tool call succeeds).
4. **Post-create bottom dock**: Mermaid graph (horizontal LR) + **Run / Question / Cancel**.
5. You choose **Run** (Enter on Run, or press `1`).
6. Work starts: status widget and/or notify lines for ready check / worker.
7. `/hypagraph status` shows goal + ready / hot work.
8. `/hypagraph graph` opens the **live bottom graph dock** (not a side pane).
9. Optional: interaction dock answers **Approve** if the demo graph reaches it.
10. End on a clear success or inspectable running state (do not leave a stuck error).

Do **not** record: private API keys, home directory secrets, long stack traces, unrelated chat.

## 2. Environment checklist (before record)

1. Terminal size: **at least 120×40** (recommended **140×45**).
2. Font size large enough for README stills (14–18 pt).
3. Working directory: this repository root  
   `cd /Users/matthew/Development/hypabolic/Hypagraph`
4. Branch with live graph dock + product surface (e.g. `feature/goal-family-product-remediation` or updated `main`).
5. Load the extension with `pi -e ./extensions/hypagraph.ts --skill ./skills` from this repo.
6. Provider/model already authenticated (no login prompts mid-video).
7. Optional: `PI_BIN` only if you will show an isolated worker path (section 6B). Prefer the **reliable check path** (section 6A) for the first take.
8. Close noisy side panels. One terminal only.
9. Disable notification banners that cover the TUI.

### Recorder settings (QuickTime / CleanShot)

| Setting | Value |
| --- | --- |
| Capture | Single terminal window (not full desktop if possible) |
| Resolution | Native Retina OK; export 1280×720 or 1920×1080 |
| Frame rate | 30 fps |
| Microphone | Off (unless you narrate) |
| Cursor | On |
| Length | Stop under 90 s if possible |

## 3. Preferred create path (no model)

Use the built-in catalog. No free-form definition paste and no `hypagoal_start` authoring:

```text
/hypagraph demo showcase
```

Shorter tour: `/hypagraph demo basic` or `/hypagraph demo loop`.  
List: `/hypagraph demo list`.

After **Run**, each check and gate holds ~2s so the live graph is readable.  
For narration: start Pi with `HYPA_DEMO_SLOW=1` or `HYPA_DEMO_PACE_MS=3500`.

## 4. Optional free-form path (not required for README)

Only if you need a custom graph. Prefer section 3.

```json
{
  "title": "README product demo",
  "goal": "Demo: run one check, then ask the user to approve the result.",
  "nodes": [
    {
      "id": "smoke-check",
      "title": "Smoke check",
      "kind": "check",
      "requires": [],
      "acceptance": ["The smoke check passes."],
      "check": {
        "kind": "command",
        "command": "true",
        "timeoutMs": 5000,
        "publish": [{ "source": "passed", "fact": "demo.check_passed" }]
      },
      "produces": [{ "name": "demo.check_passed", "type": "boolean", "required": true }]
    },
    {
      "id": "approve-demo",
      "title": "Approve demo",
      "kind": "interaction",
      "requires": ["smoke-check"],
      "acceptance": ["The user answers the approval question."],
      "produces": [{ "name": "demo.approved", "type": "boolean", "required": true }],
      "interaction": {
        "kind": "interaction",
        "version": 1,
        "presentation": { "class": "deterministic", "kind": "none" },
        "question": "Approve the README demo check result?",
        "responses": [
          {
            "id": "approve",
            "label": "Approve",
            "publish": [
              { "name": "demo.approved", "type": "boolean", "value": true }
            ]
          },
          {
            "id": "reject",
            "label": "Reject",
            "publish": [
              { "name": "demo.approved", "type": "boolean", "value": false }
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

Why this graph:

- **Fast and deterministic** (check is `true`).
- Shows **post-create Mermaid dock**.
- Shows **controller dispatch** after Run.
- Shows **interaction bottom dock**.
- Shows **live graph dock** with status colour when nodes advance.
- Avoids isolated-pi spawn risk on the critical path.

## 5. Exact key / command sequence (primary take)

### 5A. Start recording, then open Pi

```bash
cd /Users/matthew/Development/hypabolic/Hypagraph
pi
```

Wait until the composer is idle.

### 5B. Start the in-Pi demo

Type and submit:

```text
/hypagraph demo showcase
```

Or for a shorter path: `/hypagraph demo basic`.

### 5C. Post-create dock (must capture)

1. Dock appears at the **bottom** with Mermaid art (horizontal).
2. Pause 2 seconds so the graph is readable.
3. Press **Enter** (Run is preselected) **or** press **1**.
4. Dock closes; the deterministic controller continues with paced steps.

### 5D. After Run (capture graph steps)

Expect:

- each check and gate holds ~2s while the live graph updates;
- independent branches and loops light up in sequence;
- bottom **interaction** dock opens for final approval when the graph reaches it.

If interaction opens:

1. Pause 1 second.
2. Press **Enter** on **Approve** (or select Approve and Enter).

If interaction does not open automatically:

```text
/hypagraph status
```

Then:

```text
/hypagraph ask
```

Answer **Approve**.

### 5E. Live graph dock (must capture)

```text
/hypagraph graph
```

1. Bottom live dock opens (title like `Hypagraph live · …`).
2. Pause 3 seconds. Status glyphs / hot line should be visible.
3. Optional: `/hypagraph graph focus` then arrows if you want navigation.
4. Press **q** to close the dock (or leave open for the final frame).

### 5F. Status close-out

```text
/hypagraph status
```

Pause 2 seconds. Stop recording.

## 6. Alternate takes (optional)

### 6A. Failed take recovery

If create invents a huge graph: cancel (`/hypagraph cancel`), re-prompt with the fixed JSON only.

If post-create dock never appears: confirm TUI mode (`hasUI`), interactive mode, and that create succeeded. Restart Pi from this repo.

If check never runs after Run: run `/hypagraph status`, then `/hypagraph resume` only if the goal is paused. Do not invent shell work in the chat.

### 6B. Isolated worker take (only if executor is healthy)

Use the free-form interaction recipe in `skills/hypagraph/SKILL.md` (task `do-work` + interaction `approve-work`).  
Require a working isolated-pi path (`/hypagraph executor status` OK before record).  
Same post-create → Run → graph sequence.

### 6C. Family create-child take (longer, advanced)

Only after the single-member demo is published. Follow `docs/goal-family-product-remediation-plan.md` flagship recipe (current-session parent + isolated child). Target length 2–3 minutes; not required for the first README asset.

## 7. Export and drop-in

1. Export video as **H.264 MP4**, under **15 MB** if possible (GitHub README embeds prefer modest size).
2. Save as:

```text
docs/demo/assets/hypagraph-demo.mp4
```

3. Optional poster still (first readable post-create frame):

```text
docs/demo/assets/hypagraph-demo-poster.png
```

4. Tell the agent or open a PR: “demo asset dropped; wire README.”

## 8. README embed (ready after the file exists)

Insert under the intro (after the static mermaid block), when the MP4 is in-repo:

```markdown
## Product tour

https://github.com/Hypabolic/Hypagraph/assets/<ASSET_ID>/hypagraph-demo.mp4
```

Or, when committed to the tree:

```markdown
## Product tour

https://github.com/user-attachments/assets/...   <!-- if uploaded via GitHub UI -->

<!-- local path embed (GitHub renders committed mp4 on some views): -->
<video src="docs/demo/assets/hypagraph-demo.mp4" controls width="100%"></video>
```

GitHub also accepts drag-and-drop of the MP4 into a README edit or issue; paste the resulting URL into README for reliable embedding across devices.

## 9. Acceptance checklist for the take

- [ ] Terminal only; text readable at 1× speed
- [ ] Post-create dock visible before Run
- [ ] Run pressed by the human (not auto-start without dock)
- [ ] Graph is horizontal Mermaid, not a right-side box pane
- [ ] Live `/hypagraph graph` bottom dock appears after Run
- [ ] No secrets, no long error dump
- [ ] Under ~90 seconds (primary take)
- [ ] File at `docs/demo/assets/hypagraph-demo.mp4`

## 10. One-line prompt card (print or second monitor)

```text
1) pi in Hypagraph repo
2) paste hypagoal message + fixed definition
3) wait dock → Enter (Run)
4) Approve interaction if shown
5) /hypagraph graph → pause → q
6) /hypagraph status → stop record
```
