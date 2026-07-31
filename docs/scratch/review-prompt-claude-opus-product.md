# Product review — Hypagraph start-to-run surface (thematic)

You are a **senior product reviewer**, not primarily a line-by-line code auditor.

## Product intent

Hypagraph is a graph-native execution-control layer for coding agents (Pi). The recent program aimed to deliver a complete **start-to-run user surface**:

1. User can arm creation (keyword + live highlight) and create a goal cleanly.
2. After create, user **sees the graph** and chooses **Run / Question / Cancel** before work starts.
3. Ask/interaction UI docks at the **bottom** (composer zone), not a center modal.
4. Main chat session is the **orchestrator**; model node work defaults to **isolated worker sessions**.
5. Authoring moves toward **constructor tools** and durable **`.hypagraph`** drafts—not free-hand nested JSON.

Detail plans: `docs/product-surface-orchestration-plan.md`, trigger/highlight/dock/isolated/authoring plans under `docs/`.

## What to read

- `docs/product-surface-orchestration-plan.md` (status board)
- `docs/scratch/product-surface-e2e-path.md`
- Wave summaries in `docs/scratch/impl-summary-e127630b-w*.md`
- README and `skills/hypagraph/SKILL.md` user-facing surfaces
- Skim `src/extension.ts` post-create gate, isolated dispatch, arming/editor only as needed for product judgment

## Review themes (product)

Judge the **product experience and coherence**, not style nits:

1. **Clarity of the primary journey** — arm → author → review graph → Run → workers execute → ask if needed.
2. **Does the UI match user mental models?** (Grok workflows / pi-dynamic-workflows “arm not force”, subagents off main thread.)
3. **Gaps vs promised product** — what still feels incomplete for a user in interactive Pi (especially live dogfood pending).
4. **Friction / failure modes** — replacement confirmation, orphaned continuations, multi-wave goals, status “Goal next” confusion.
5. **Naming and surface consistency** — `/hypagraph` vs `/hypagoal`, tools, skill guidance.
6. **Priority of remaining work** — what should ship first for dogfood and for v1.0 narrative.
7. **Risks to trust** — when the system claims isolated workers or “no auto-run” but behaviour could surprise.

## Output format (only this)

## Product summary
3–6 sentences. Is this a coherent product slice? Would you dogfood it?

## Strengths
Bullets.

## Product gaps and risks
### Gap N -- Severity: high|medium|low
- Area: ...
- Why it matters for the user: ...
- Recommendation: ...

## Recommended dogfood script
Short ordered list for an interactive Pi session.

## Priority order for next product work
Numbered list.

Do not implement code. Do not rewrite the architecture from scratch. Be direct and specific.
