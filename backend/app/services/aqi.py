"""Air quality (OpenAQ v3, api.openaq.org). Needs a free API key - OpenAQ has no keyless tier at all, unlike
this app's other optional keys - saved via app_settings.get_openaq_key()/set_openaq_key().

PM2.5 (OpenAQ parameter id 2) is used as the headline pollutant and converted to the standard US EPA Air
Quality Index. Getting many stations' latest readings takes two bulk, paginated calls (there is no single
endpoint that returns both a location's name and its latest reading): `/v3/locations` for id -> name/country,
and `/v3/parameters/2/latest` for id -> coordinates/value, joined by location id.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services import app_settings
from app.services.deepspace import FetchError, _get_json

BASE = "https://api.openaq.org/v3"
PM25_PARAMETER_ID = 2
CREDIT = "Air quality: OpenAQ (openaq.org). PM2.5 converted to the US EPA Air Quality Index."
CACHE_S = 45 * 60.0
PAGE_SIZE = 1000
MAX_PAGES = 3
FRESH_HOURS = 48

_mem: dict[str, tuple[float, Any]] = {}

# US EPA AQI breakpoints for 24-hour PM2.5, ug/m3: (conc_lo, conc_hi, aqi_lo, aqi_hi)
_PM25_BREAKPOINTS = [
    (0.0, 12.0, 0, 50),
    (12.1, 35.4, 51, 100),
    (35.5, 55.4, 101, 150),
    (55.5, 150.4, 151, 200),
    (150.5, 250.4, 201, 300),
    (250.5, 500.4, 301, 500),
]


def _pm25_to_aqi(c: float) -> int:
    c = max(0.0, c)
    for lo, hi, aqi_lo, aqi_hi in _PM25_BREAKPOINTS:
        if c <= hi:
            return round((aqi_hi - aqi_lo) / (hi - lo) * (c - lo) + aqi_lo)
    return 500


def _headers() -> dict[str, str]:
    return {"X-API-Key": app_settings.get_openaq_key()}


def _locations_lookup() -> dict[int, dict[str, str]]:
    out: dict[int, dict[str, str]] = {}
    for page in range(1, MAX_PAGES + 1):
        raw = _get_json(f"{BASE}/locations?limit={PAGE_SIZE}&page={page}", timeout=30, headers=_headers())
        rows = (raw or {}).get("results") or []
        for r in rows:
            out[r["id"]] = {"name": r.get("name") or "", "country": (r.get("country") or {}).get("name") or ""}
        if len(rows) < PAGE_SIZE:
            break
    return out


def _fetch() -> list[dict[str, Any]]:
    if not app_settings.get_openaq_key():
        return []
    since = (datetime.now(timezone.utc) - timedelta(hours=FRESH_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    names = _locations_lookup()
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    for page in range(1, MAX_PAGES + 1):
        raw = _get_json(f"{BASE}/parameters/{PM25_PARAMETER_ID}/latest?limit={PAGE_SIZE}&page={page}&datetime_min={since}", timeout=30, headers=_headers())
        results = (raw or {}).get("results") or []
        for r in results:
            loc_id = r.get("locationsId")
            value = r.get("value")
            coords = r.get("coordinates") or {}
            lat, lon = coords.get("latitude"), coords.get("longitude")
            if loc_id is None or loc_id in seen or value is None or lat is None or lon is None:
                continue
            seen.add(loc_id)
            info = names.get(loc_id, {})
            rows.append(
                {
                    "id": loc_id,
                    "name": info.get("name") or f"Station {loc_id}",
                    "country": info.get("country") or "",
                    "lat": lat,
                    "lon": lon,
                    "pm25": value,
                    "aqi": _pm25_to_aqi(value),
                    "measured_at": (r.get("datetime") or {}).get("utc"),
                }
            )
        if len(results) < PAGE_SIZE:
            break
    return rows


def stations() -> dict[str, Any]:
    now = time.time()
    hit = _mem.get("stations")
    if hit and now - hit[0] < CACHE_S:
        return hit[1]
    try:
        rows = _fetch()
    except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
        if hit:
            return hit[1]
        raise FetchError(f"could not get air quality stations ({e})") from e
    out = {"rows": rows, "credit": CREDIT, "has_key": bool(app_settings.get_openaq_key())}
    _mem["stations"] = (now, out)
    return out
