from pathlib import Path

path = Path("docs/event-runtime.md")
text = path.read_text()
anchor = "## Current M4 limit\n"
marker = "The default stdout and stderr capture limit is 1,048,576 bytes for each stream.\n\n"
if marker not in text:
    if anchor not in text:
        raise SystemExit("The M4 limit section was not found in docs/event-runtime.md")
    text = text.replace(anchor, marker + anchor, 1)
    path.write_text(text)
