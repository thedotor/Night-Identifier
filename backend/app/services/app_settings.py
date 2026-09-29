import json
from pathlib import Path

from app.config import settings
from app.services import secrets_at_rest


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


def _get_secret(name: str) -> str:
    """An API key, decrypted (they are stored with Windows DPAPI; a plain-text one from an older version is encrypted now)."""
    data = _read()
    stored = str(data.get(name, "") or "")
    if stored and not secrets_at_rest.is_encrypted(stored) and secrets_at_rest.available():
        _set_secret(name, stored)
    return secrets_at_rest.decrypt(stored)


def _set_secret(name: str, value: str) -> None:
    data = _read()
    data[name] = secrets_at_rest.encrypt(value)
    _write(data)


def get_watch_dir() -> Path:
    data = _read()
    stored = data.get("watch_dir")
    return Path(stored) if stored else settings.watch_dir


def set_watch_dir(path: Path) -> None:
    data = _read()
    data["watch_dir"] = str(path)
    _write(data)


def get_lightning_enabled() -> bool:
    """Whether the backend collects live lightning strikes while the app is open (on unless switched off in Settings)."""
    return bool(_read().get("lightning_enabled", True))


def set_lightning_enabled(enabled: bool) -> None:
    data = _read()
    data["lightning_enabled"] = bool(enabled)
    _write(data)


def get_traffic_enabled() -> bool:
    """Whether the web traffic layer reads this PC's connection table (off until the user switches it on)."""
    return bool(_read().get("traffic_enabled", False))


def set_traffic_enabled(enabled: bool) -> None:
    data = _read()
    data["traffic_enabled"] = bool(enabled)
    _write(data)


def get_traffic_history() -> bool:
    """Whether the (encrypted, 7-day) web traffic history is kept while the layer is on."""
    return bool(_read().get("traffic_history", True))


def set_traffic_history(on: bool) -> None:
    data = _read()
    data["traffic_history"] = bool(on)
    _write(data)


def get_nasa_api_key() -> str:
    """An optional free api.nasa.gov key; without one the shared DEMO_KEY (30 requests an hour) is used."""
    return _get_secret("nasa_api_key")


def set_nasa_api_key(key: str) -> None:
    _set_secret("nasa_api_key", key)


def get_aisstream_key() -> str:
    """An optional free aisstream.io API key: with one, the ship layer covers the whole world; without, only the Baltic (Digitraffic)."""
    return _get_secret("aisstream_key")


def set_aisstream_key(key: str) -> None:
    _set_secret("aisstream_key", key)


def get_firms_key() -> str:
    """An optional free NASA FIRMS map key: with one, the satellite heat spots layer works (volcano heat, lava, wildfires)."""
    return _get_secret("firms_key")


def set_firms_key(key: str) -> None:
    _set_secret("firms_key", key)


def get_openaq_key() -> str:
    """A free OpenAQ v3 API key: required for the air quality layer (OpenAQ has no keyless tier)."""
    return _get_secret("openaq_key")


def set_openaq_key(key: str) -> None:
    _set_secret("openaq_key", key)
