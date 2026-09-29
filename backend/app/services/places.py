"""Towns and villages of the world, for the 3D Earth's town names and for "near <town>" on the photo map.

GeoNames "cities1000" lists every populated place with 1,000 or more people (about 140,000 of them, CC BY 4.0). It is downloaded once,
reduced to a compact list (biggest first) and cached on disk; country and region names come from two small GeoNames tables.
"""

import io
import json
import math
import threading
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _http_get

logger = log_capture.get_logger("places")

BASE = "https://download.geonames.org/export/dump"
CREDIT = "Towns: GeoNames (geonames.org), CC BY 4.0"
_lock = threading.Lock()
_index: dict[str, Any] | None = None


def _path() -> Path:
    d = settings.deepspace_dir / "places"
    d.mkdir(parents=True, exist_ok=True)
    return d / "towns.json"


def _table(text: str) -> list[list[str]]:
    return [line.split("\t") for line in text.splitlines() if line and not line.startswith("#")]


def _build() -> dict[str, Any]:
    body, _ = _http_get(f"{BASE}/cities1000.zip", accept="application/zip", attempts=3, timeout=120)
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            text = z.read("cities1000.txt").decode("utf-8")
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError) as e:
        raise FetchError("the town list is not readable") from e
    countries = {r[0]: r[4] for r in _table(_get_text(f"{BASE}/countryInfo.txt")) if len(r) > 4}
    admins = {r[0]: r[1] for r in _table(_get_text(f"{BASE}/admin1CodesASCII.txt")) if len(r) > 1}
    cc_list: list[str] = []
    cc_at: dict[str, int] = {}
    ad_list: list[str] = []
    ad_at: dict[str, int] = {}
    rows: list[list[Any]] = []
    for r in _table(text):
        try:
            name, lat, lon, feature, cc, a1, pop = r[1], float(r[4]), float(r[5]), r[7], r[8], r[10], int(r[14] or 0)
        except (IndexError, ValueError):
            continue
        ci = cc_at.setdefault(cc, len(cc_list))
        if ci == len(cc_list):
            cc_list.append(countries.get(cc, cc))
        ai = -1
        if a1:
            key = f"{cc}.{a1}"
            if key in admins:
                ai = ad_at.setdefault(key, len(ad_list))
                if ai == len(ad_list):
                    ad_list.append(admins[key])
        rows.append([name, ci, round(lat, 3), round(lon, 3), pop, 1 if feature == "PPLC" else 0, ai])
    rows.sort(key=lambda x: (-x[4], x[0]))
    return {"fields": ["name", "country", "lat", "lon", "population", "capital", "region"], "countries": cc_list, "regions": ad_list, "rows": rows, "credit": CREDIT}


def _get_text(url: str) -> str:
    body, _ = _http_get(url, accept="text/plain", attempts=3, timeout=60)
    return body.decode("utf-8", errors="replace")


def towns_file() -> Path:
    """The cached town list (built on first use: one download of about 10 MB)."""
    path = _path()
    if path.is_file():
        return path
    with _lock:
        if path.is_file():
            return path
        data = _build()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        logger.info("Towns: %d places cached", len(data["rows"]))
        return path


def _load() -> dict[str, Any]:
    global _index
    if _index is None:
        data = json.loads(towns_file().read_text(encoding="utf-8"))
        rows = data["rows"]
        _index = {
            "data": data,
            "lat": np.radians(np.array([r[2] for r in rows], dtype=np.float64)),
            "lon": np.radians(np.array([r[3] for r in rows], dtype=np.float64)),
        }
    return _index


def nearest(lat: float, lon: float, max_km: float = 60.0) -> dict[str, Any] | None:
    """The closest town to a point (within `max_km`), or None: name, country, region, population, distance in km."""
    idx = _load()
    la, lo = math.radians(lat), math.radians(lon)
    dlat = idx["lat"] - la
    dlon = idx["lon"] - lo
    a = np.sin(dlat / 2) ** 2 + np.cos(la) * np.cos(idx["lat"]) * np.sin(dlon / 2) ** 2
    km = 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    i = int(np.argmin(km))
    if float(km[i]) > max_km:
        return None
    data = idx["data"]
    r = data["rows"][i]
    return {
        "name": r[0],
        "country": data["countries"][r[1]],
        "region": data["regions"][r[6]] if r[6] >= 0 else "",
        "population": r[4],
        "km": round(float(km[i]), 1),
    }
