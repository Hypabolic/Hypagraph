# M6B short live path evidence

- Case ID: `CASE-M6B-RESULT-TXT`
- Status: recorded (RPC Pi dogfood)
- Parent write-up: `docs/m6b-dogfood.md`
- Artifacts: `summary.json`, `canonical.json`, `result.txt`

## Scope

Retrospective case ID for the existing M6B short live path.

Objective: create `result.txt` with exact text `m6b-dogfood` and verify that file with a deterministic command check.

Nodes in this case: `create-result` (task) and `verify-result` (command check). This case has no gate node.

## Live transport

Recorded Pi RPC-driver dogfood. Ledger §2 treats recorded Pi RPC and recorded Pi TUI as Live when a case ID and an evidence path both exist.

## Capabilities covered

| Capability ledger row | Live by this case |
| --- | --- |
| Single-root task + command check execution | Yes |
| Deterministic command checks | Yes (command check only) |

Not covered as Live by this case:

- Single-root gate execution (see `CASE-M6B-LOOP-REVISION`)
- Deterministic checks (report, file, Git)
- Root Hypagoal create as a multi-session claim
- Concurrent multi-pending family selection
- Bounded loops (see `CASE-M6B-LOOP-REVISION` on loop-revision path)
- Trusted evaluation contracts
