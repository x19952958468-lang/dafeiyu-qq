"""Load local settings; filesystem paths are relative to the repository root."""
import json
from pathlib import Path
import os
import sys

REPOSITORY = Path(__file__).resolve().parents[2]


def resolve_path(raw):
    resolved = Path(os.path.expandvars(raw)).expanduser()
    # A custom work directory also relocates the example's work/... defaults.
    if not resolved.is_absolute() and resolved.parts and resolved.parts[0] == "work" and os.environ.get("DAFEIYU_WORK_DIR"):
        return str((Path(os.environ["DAFEIYU_WORK_DIR"]).expanduser().resolve() / Path(*resolved.parts[1:])).resolve())
    return str((REPOSITORY / resolved).resolve())


def load_settings(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("data_root", "seed_root", "reference", "runtime_log"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError(f"Missing path setting: {key}")
        value[key] = resolve_path(value[key])
    for key, default in (("python", sys.executable), ("ffmpeg", os.environ.get("DAFEIYU_FFMPEG", "ffmpeg"))):
        command = os.path.expandvars(value.get(key) or default)
        if "/" in command or "\\" in command:
            command = resolve_path(command)
        value[key] = command
    return value
