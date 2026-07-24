from pathlib import Path
import base64
import io
import tarfile

payload = "".join(
    path.read_text()
    for path in sorted(Path("scripts").glob("slice3-payload-??"))
)

with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload)), mode="r:gz") as archive:
    archive.extractall(Path("."), filter="data")
