"""Upcoming (and recently completed) orbital rocket launches (Launch Library 2, ll.thespacedevs.com).

Free, no key, but the shared free tier is rate-limited to about 15 requests an hour, so this is cached
aggressively and soft-fails to whatever was last fetched. `mode=normal` is used rather than `mode=list`
(which omits the pad and mission entirely) or `mode=detailed` (which balloons each launch to ~50 KB with
full agency biographies) - `normal` is the smallest mode that still carries the pad's coordinates, the
mission name and the provider.
"""

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services.deepspace import FetchError, _get_json

BASE = "https://ll.thespacedevs.com/2.3.0/launches"
CREDIT = "Launch data: Launch Library 2 by The Space Devs (thespacedevs.com)."
CACHE_S = 1500.0  # 25 min: well under the free tier's ~15 requests/hour

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "launches"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cached(key: str, ttl: float, make: Any, disk: bool = False) -> Any:
    now = time.time()
    with _lock:
        hit = _mem.get(key)
    if hit is None and disk:
        try:
            cached = json.loads((_dir() / f"cache-{key}.json").read_text(encoding="utf-8"))
            hit = (cached["at"], cached["data"])
        except (OSError, ValueError, KeyError):
            hit = None
    if hit and now - hit[0] < ttl:
        with _lock:
            _mem[key] = hit
        return hit[1]
    try:
        val = make()
    except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
        if hit:
            return hit[1]
        raise FetchError(f"could not get {key} ({e})") from e
    with _lock:
        _mem[key] = (now, val)
    if disk:
        try:
            (_dir() / f"cache-{key}.json").write_text(json.dumps({"at": now, "data": val}), encoding="utf-8")
        except OSError:
            pass
    return val


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _ms(dt: datetime | None) -> int | None:
    return int(dt.timestamp() * 1000) if dt else None


def _row(r: dict[str, Any]) -> dict[str, Any]:
    pad = r.get("pad") or {}
    mission = r.get("mission") or {}
    status = r.get("status") or {}
    provider = r.get("launch_service_provider") or {}
    rocket = ((r.get("rocket") or {}).get("configuration")) or {}
    return {
        "id": r["id"],
        "name": r["name"],
        "provider": provider.get("name"),
        "pad_name": pad.get("name"),
        "lat": pad.get("latitude"),
        "lon": pad.get("longitude"),
        "net_ms": _ms(_parse(r.get("net"))),
        "status": status.get("abbrev"),
        "status_name": status.get("name"),
        "mission": mission.get("name"),
        "rocket_name": rocket.get("name"),
    }


def _fetch_list(path: str, limit: int) -> list[dict[str, Any]]:
    raw = _get_json(f"{BASE}/{path}/?limit={limit}&mode=normal", timeout=30) or {}
    return [_row(r) for r in raw.get("results") or []]


def _fetch() -> list[dict[str, Any]]:
    upcoming = _fetch_list("upcoming", 20)
    previous = _fetch_list("previous", 6)
    rows = upcoming + previous
    rows.sort(key=lambda x: x["net_ms"] or 0)
    return rows


def upcoming() -> dict[str, Any]:
    rows = _cached("launches", CACHE_S, _fetch, disk=True)
    return {"rows": rows, "credit": CREDIT}
