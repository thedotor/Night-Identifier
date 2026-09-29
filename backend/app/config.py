import json
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    return Path.home() / "Documents" / "Night Identifier"


def _pointer_file() -> Path:
    """Fixed location (independent of data_dir, since that's what it points
    to) recording a user-chosen data directory, if they remapped it in
    Settings."""
    return Path.home() / ".night-identifier" / "config.json"


def _resolve_data_dir() -> Path:
    pointer = _pointer_file()
    if pointer.exists():
        try:
            data = json.loads(pointer.read_text())
            stored = data.get("data_dir")
            if stored:
                return Path(stored)
        except (json.JSONDecodeError, OSError):
            pass
    return _default_data_dir()


def set_data_dir_pointer(path: Path) -> None:
    pointer = _pointer_file()
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(json.dumps({"data_dir": str(path)}))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NIGHT_ID_")

    host: str = "127.0.0.1"
    port: int = 8765
    # Set by the Electron app for the packaged build (see services/api_guard.py); empty = no check.
    api_token: str = ""

    data_dir: Path = _resolve_data_dir()

    @property
    def db_path(self) -> Path:
        return self.data_dir / "night_identifier.db"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def previews_dir(self) -> Path:
        return self.data_dir / "previews"

    @property
    def reference_images_dir(self) -> Path:
        return self.data_dir / "reference_images"

    @property
    def deepspace_dir(self) -> Path:
        return self.data_dir / "deepspace_cache"

    @property
    def watch_dir(self) -> Path:
        return self.data_dir / "watch"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for d in (
            self.data_dir,
            self.images_dir,
            self.previews_dir,
            self.reference_images_dir,
            self.deepspace_dir,
            self.watch_dir,
            self.models_dir,
            self.logs_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
