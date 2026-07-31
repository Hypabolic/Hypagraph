# Wave 5 implementation summary — Live trigger editor highlight (post-review)

## Status

**Wave 5 code complete (S5.0–S5.4 / H1–H4). Review bugs resolved. Live interactive dogfood still pending.**

## Review fixes

| Bug | Fix |
| --- | --- |
| Paint diverged from pure spans (re-regex per line) | `paintHypagoalTriggerLines` applies only `findHypagoalTriggerSpans` ranges via `applyTriggerSpansToPlainText`; maps painted buffer lines into render output; wrap uses line-local columns only |
| Large paste lost pre-submit signal | Evaluate `getExpandedText()` when present; when only expanded content arms, colour paste markers (`armedInCollapsedPaste`) |

## Slices

| Slice | Result |
| --- | --- |
| **S5.0** | Discovery note updated for expanded paste + exact-span paint |
| **S5.1 / H1** | Pure spans; arming delegates to spans |
| **S5.2 / H2** | Editor wrap; exact-span paint; paste-marker armed signal |
| **S5.3 / H3** | trigger set/off refresh; stock behaviour via render wrap only |
| **S5.4 / H4** | README, skill, help text |

## Key modules

| File | Role |
| --- | --- |
| `src/pi/hypagoal-arming.ts` | `findHypagoalTriggerSpans`, parity arming |
| `src/pi/hypagoal-trigger-editor.ts` | Exact-span paint, wrap factory, expanded-text evaluation |
| `tests/hypagoal-trigger-spans.test.ts` | Spans, mixed excluded tokens, paste markers |

## Design decisions

1. Same matcher for highlight and submit: spans empty iff not armed.
2. Paint never re-discovers tokens with a second regex on each line.
3. Evaluation text prefers `getExpandedText()` for submit parity.
4. Collapsed paste: colour the `[paste #N …]` marker when expanded text arms.
5. Domain stays pure. Paint has no events or reducer calls.

## Tests run

```text
npx tsc --noEmit
npx vitest run tests/hypagoal-trigger-spans.test.ts tests/hypagoal-arming.test.ts tests/hypagoal-arming-extension.test.ts
```

55/55 passed. Typecheck clean.

## Not done

- Live Pi dogfood (type, paste, multiline, trigger set/off)
- Waves 6–8
