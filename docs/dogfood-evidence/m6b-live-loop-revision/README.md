# M6B loop and revision live path evidence

- Case ID: `CASE-M6B-LOOP-REVISION`
- Status: recorded (RPC Pi dogfood)
- Parent write-up: `docs/m6b-dogfood.md`
- Artifacts: `summary.json`, `canonical.json`, and workspace files under this directory

## Scope

Retrospective case ID for the existing M6B loop, gate, and revision live path.

Objective includes loop `lint-repair` and gates `route` and `publish-gate`. Recorded events show gate evaluation and loop completion.

## Live transport

Recorded Pi RPC-driver dogfood. Ledger §2 treats recorded Pi RPC and recorded Pi TUI as Live when a case ID and an evidence path both exist.

## Capabilities covered

| Capability ledger row | Live by this case |
| --- | --- |
| Single-root gate execution | Yes (gates `route`, `publish-gate`) |
| Bounded loops | Yes (loop `lint-repair`) |

Not covered as Live by this case alone:

- Trusted evaluation contracts (protected evaluator, trust modes, integrity)
- Concurrent multi-pending family selection
- Report, file, or Git check kinds as Live
