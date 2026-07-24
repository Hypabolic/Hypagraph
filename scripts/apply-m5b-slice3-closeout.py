from pathlib import Path
import base64
import io
import tarfile

payload = Path("scripts/slice3-closeout-payload-00").read_text()
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload)), mode="r:gz") as archive:
    archive.extractall(Path("."), filter="data")
