from pathlib import Path

path = Path("tests/loop-max-iterations-check.test.ts")
text = path.read_text()
old = '{ ref: "artifact://test-1", kind: "artifact" }'
new = '{ ref: "artifact://test-1", kind: "file" }'
if old in text:
    path.write_text(text.replace(old, new, 1))
elif new not in text:
    raise SystemExit("The Slice 4 evidence fixture was not found.")
