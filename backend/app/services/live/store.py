"""Saved cameras and Live View settings, kept in <data dir>/live_cameras.json.

Passwords (and URLs with a login in them) are encrypted in this file with Windows DPAPI, see
secrets_at_rest.py, and are never sent to the renderer -- `public()` strips them."""

from __future__ import annotations

import copy
import json
import threading
import uuid
from typing import Any

from app.config import settings
from app.services import secrets_at_rest
from app.services.live.network import mask_url

_lock = threading.RLock()

SECRET_KEYS = ("password",)

DEFAULT_MOTION: dict[str, Any] = {
    "enabled": False,
    "mode": "motion",  # 'motion' | 'meteor'
    "sensitivity": 50,  # 0..100
    "min_area_pct": 0.05,
    "cooldown_s": 10,
    "save_frame": True,
    "save_clip": True,
}


def _path():
    return settings.data_dir / "live_cameras.json"


def _sensitive(key: str, value: Any) -> bool:
    """Params that get encrypted at rest: passwords, and URLs only when they carry a login."""
    if not isinstance(value, str) or not value:
        return False
    return key in SECRET_KEYS or (key == "url" and mask_url(value) != value)


def _transform_params(data: dict[str, Any], fn) -> None:
    for cam in data.get("cameras", []):
        params = cam.get("params") or {}
        for k, v in list(params.items()):
            if _sensitive(k, v) or secrets_at_rest.is_encrypted(v):
                params[k] = fn(v)


def _read() -> dict[str, Any]:
    p = _path()
    if not p.exists():
        return {"cameras": [], "settings": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"cameras": [], "settings": {}}
    data.setdefault("cameras", [])
    data.setdefault("settings", {})
    plain_on_disk = any(
        (_sensitive(k, v) and not secrets_at_rest.is_encrypted(v)) for cam in data["cameras"] for k, v in (cam.get("params") or {}).items()
    )
    _transform_params(data, secrets_at_rest.decrypt)
    if plain_on_disk and secrets_at_rest.available():
        try:
            _write(data)  # a file from an older version: encrypt it now
        except OSError:
            pass
    return data


def _write(data: dict[str, Any]) -> None:
    settings.ensure_dirs()
    on_disk = copy.deepcopy(data)
    _transform_params(on_disk, secrets_at_rest.encrypt)
    _path().write_text(json.dumps(on_disk, indent=2), encoding="utf-8")


def list_cameras() -> list[dict[str, Any]]:
    with _lock:
        return [_with_defaults(c) for c in _read()["cameras"]]


def _with_defaults(cfg: dict[str, Any]) -> dict[str, Any]:
    out = dict(cfg)
    out.setdefault("params", {})
    out.setdefault("background", False)
    out.setdefault("auto_reconnect", True)
    out["motion"] = {**DEFAULT_MOTION, **(cfg.get("motion") or {})}
    return out


def get_camera(camera_id: str) -> dict[str, Any] | None:
    for c in list_cameras():
        if c["id"] == camera_id:
            return c
    return None


def add_camera(cfg: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = _read()
        cfg = {**cfg, "id": uuid.uuid4().hex[:10]}
        data["cameras"].append(cfg)
        _write(data)
        return _with_defaults(cfg)


def update_camera(camera_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
    with _lock:
        data = _read()
        for i, c in enumerate(data["cameras"]):
            if c["id"] != camera_id:
                continue
            merged = {**c}
            for k, v in changes.items():
                if k == "params":
                    params = {**c.get("params", {})}
                    for pk, pv in (v or {}).items():
                        # an empty/masked password from the UI means "keep the stored one"
                        if pk in SECRET_KEYS and (pv is None or pv == ""):
                            continue
                        params[pk] = pv
                    merged["params"] = params
                elif k == "motion":
                    merged["motion"] = {**(c.get("motion") or {}), **(v or {})}
                elif k != "id":
                    merged[k] = v
            data["cameras"][i] = merged
            _write(data)
            return _with_defaults(merged)
    return None


def remove_camera(camera_id: str) -> bool:
    with _lock:
        data = _read()
        kept = [c for c in data["cameras"] if c["id"] != camera_id]
        if len(kept) == len(data["cameras"]):
            return False
        data["cameras"] = kept
        _write(data)
        return True


def get_settings() -> dict[str, Any]:
    with _lock:
        return dict(_read()["settings"])


def update_settings(changes: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = _read()
        data["settings"].update(changes)
        _write(data)
        return dict(data["settings"])


def public(cfg: dict[str, Any]) -> dict[str, Any]:
    """A camera config safe to send to the renderer: no passwords, masked URLs."""
    out = dict(cfg)
    params = dict(out.get("params", {}))
    for k in SECRET_KEYS:
        if params.get(k):
            params[k] = "••••"
    if params.get("url"):
        params["url"] = mask_url(str(params["url"]))
    out["params"] = params
    return out
