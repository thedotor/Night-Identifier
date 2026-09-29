"""Near-Earth asteroid close approaches (NASA's NeoWs, api.nasa.gov/neo/rest/v1).

A simplified, sorted list from NeoWs's `feed` endpoint: miss distance, size estimate, hazard flag, relative
velocity, and a JPL link for each object passing near Earth in the coming week. This is not full orbital
elements (see app.services.orbits for the catalogued minor bodies with real orbits) - NeoWs's cheap `feed`
call does not include orbital elements, only the heavier per-object `lookup` endpoint does, one call per
object, which is not worth it just to show "how close and when".

Shares the same NASA API key as app.services.sun's DONKI fetches (DEMO_KEY: 30 requests an hour), so it is
cached on disk for an hour.
"""

import json
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import app_settings
from app.services.deepspace import FetchError, _get_json

NEOWS = "https://api.nasa.gov/neo/rest/v1/feed"
CREDIT = "Near-Earth object data: NASA/JPL Near Earth Object Web Service (NeoWs)."
CACHE_S = 3600.0

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "neows"
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


def _nasa_key() -> str:
    return app_settings.get_nasa_api_key() or "DEMO_KEY"


def _fetch() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    start, end = now.date(), now.date() + timedelta(days=7)
    url = f"{NEOWS}?start_date={start}&end_date={end}&api_key={urllib.parse.quote(_nasa_key())}"
    raw = _get_json(url, timeout=20) or {}
    out: list[dict[str, Any]] = []
    for day_rows in (raw.get("near_earth_objects") or {}).values():
        for o in day_rows:
            ca = (o.get("close_approach_data") or [None])[0]
            if not ca:
                continue
            d = o["estimated_diameter"]["meters"]
            out.append(
                {
                    "id": o["id"],
                    "name": o["name"].strip("()"),
                    "close_approach_time": int(ca["epoch_date_close_approach"]),
                    "miss_distance_km": float(ca["miss_distance"]["kilometers"]),
                    "miss_distance_ld": float(ca["miss_distance"]["lunar"]),
                    "relative_velocity_kmps": float(ca["relative_velocity"]["kilometers_per_second"]),
                    "diameter_min_m": d["estimated_diameter_min"],
                    "diameter_max_m": d["estimated_diameter_max"],
                    "is_hazardous": bool(o["is_potentially_hazardous_asteroid"]),
                    "jpl_url": o.get("nasa_jpl_url"),
                }
            )
    out.sort(key=lambda x: x["close_approach_time"])
    return out


def close_approaches() -> dict[str, Any]:
    rows = _cached("feed", CACHE_S, _fetch, disk=True)
    return {"rows": rows, "credit": CREDIT, "nasa_key": _nasa_key() != "DEMO_KEY"}
