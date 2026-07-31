# Skill audit — trust fix goal

## Wayfinder checks
- [x] Default sequence: constructors first, free-form when needed
- [x] Explicit constructor coverage list (task/check/require/loop/recipe)
- [x] Explicit non-coverage: interaction, gate, code, effect → free-form definition
- [x] Authoring blocks write/edit/bash stated
- [x] Post-create Run/Question/Cancel and Esc=Question
- [x] Resume after Question re-opens dock (never auto-starts for never-dispatched)
- [x] Reload re-arms gate for never-started goals
- [x] Isolated default, current-session opt-in only, no production env override
- [x] Worker cancel, timeout, status elapsed
- [x] Project-store failure notify and status line

## Files
- skills/hypagraph/SKILL.md
- src/extension.ts hypagoal_start promptGuidelines
- README.md Current status + post-create resume wording
