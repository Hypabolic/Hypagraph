# Product demos from inside Pi (deterministic)

## Start Pi with Hypagraph

```bash
cd /Users/matthew/Development/hypabolic/Hypagraph
pi -e ./extensions/hypagraph.ts --skill ./skills
```

## List and run

```text
/hypagraph demo list
/hypagraph demo              # default = showcase tour (all graphs)
/hypagraph demo loop         # one graph only
/hypagraph demo fanout
```

All demos use **only check, gate, and interaction** nodes.

- After **Run**, the controller advances **without a remote model**.
- **`showcase`** runs **every** feature graph in order (not one combined graph).
- Between each check and gate, the live graph **holds ~2s** so each state is visible on video.
- Override with `HYPA_DEMO_PACE_MS=3500` or `HYPA_DEMO_SLOW=1` for longer holds; `HYPA_DEMO_FAST=1` skips holds.
- You only answer **interaction** docks when they open.
- Token budgets are **not** applied (turns only), so chat usage cannot stop the demo.

## Examples

| Command | What you see |
| --- | --- |
| `/hypagraph demo showcase` | **Tour of 6 graphs:** basic → loop → fanout → parallel → pipeline → rich |
| `/hypagraph demo basic` | Check → approve only |
| `/hypagraph demo loop` | Implement–verify **loop** only |
| `/hypagraph demo fanout` | **Gate** branches + integrate only |
| `/hypagraph demo parallel` | Two **independent** components **running at the same time**, then merge |
| `/hypagraph demo pipeline` | Linear pipeline + release gate + approve only |
| `/hypagraph demo rich` | One dense combined graph only |

## After create (showcase tour)

1. Post-create dock → **Run** (once, for the first graph)  
2. Full colour graph modal opens; each tour member runs with paced steps  
3. Answer interaction when a graph needs it (basic, pipeline, rich)  
4. Host advances to the next graph automatically (Tour 2/6, 3/6, …)  
5. `q` closes the modal; **ctrl+shift+g** re-opens it  

## Record

1. QuickTime record  
2. `pi -e ./extensions/hypagraph.ts --skill ./skills`  
3. `/hypagraph demo showcase` → Run → walk all graphs → answer interactions  
4. Save `docs/demo/assets/hypagraph-demo.mp4`  
