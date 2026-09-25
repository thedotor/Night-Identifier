import json
from pathlib import Path

from app.config import settings


def _settings_file() -> Path:
    return settings.data_dir / "app_settings.json"


def _read() -> dict:
    path = _settings_file()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _write(data: dict) -> None:
    settings.ensure_dirs()
    _settings_file().write_text(json.dumps(data, indent=2))


def get_watch_dir() -> Path:
    data = _read()
    stored = data.get("watch_dir")
    return Path(stored) if stored else settings.watch_dir


def set_watch_dir(path: Path) -> None:
    data = _read()
    data["watch_dir"] = str(path)
    _write(data)
