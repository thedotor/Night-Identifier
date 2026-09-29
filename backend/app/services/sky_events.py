"""Data for the sky-events calendar that is not maths: comets and asteroid close approaches from NASA/JPL, and a 10-day cloud outlook.

* Comets: JPL's Small-Body Database (ssd-api.jpl.nasa.gov): orbital elements and the two brightness numbers (M1, K1) that predict
  a comet's magnitude from its distances: m = M1 + 5 log(distance from Earth) + K1 log(distance from Sun). Those numbers are averages
  fitted to past observations, and comets flare and fade unpredictably: the calendar says so.
* Asteroid close approaches: JPL's Close Approach Data service (CAD), everything passing within 20 Moon distances in the next year.
* Cloud outlook: hourly cloud cover for 10 days from Open-Meteo, for scoring how good a night will be.

Cached in memory and on disk (one day for the JPL lists, 30 minutes for the weather); offline the last answer is served.
"""

import json
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _get_json

logger = log_capture.get_logger("sky_events")

SBDB = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
CAD = "https://ssd-api.jpl.nasa.gov/cad.api"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
CREDIT = "Comets and asteroids: NASA/JPL Small-Body Database and Close Approach Data. Cloud: Open-Meteo."
LIST_CACHE_S = 24 * 3600
OUTLOOK_CACHE_S = 30 * 60
LUNAR_DISTANCE_AU = 0.00256955

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "events"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _jd(dt: datetime) -> float:
    return dt.timestamp() / 86400.0 + 2440587.5


def _cached(name: str, ttl: float, make: Any, disk: bool = True) -> Any:
    now = time.time()
    with _lock:
        hit = _mem.get(name)
    if hit is None and disk:
        try:
            cached = json.loads((_dir() / f"{name}.json").read_text(encoding="utf-8"))
            hit = (cached["at"], cached["data"])
        except (OSError, ValueError, KeyError):
            hit = None
    if hit and now - hit[0] < ttl:
        with _lock:
            _mem[name] = hit
        return hit[1]
    try:
        data = make()
    except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
        if hit:
            logger.info("Events: could not refresh %s (%s); serving the last one", name, e)
            return hit[1]
        raise FetchError(f"could not get {name} ({e})") from e
    with _lock:
        _mem[name] = (now, data)
    if disk:
        try:
            (_dir() / f"{name}.json").write_text(json.dumps({"at": now, "data": data}), encoding="utf-8")
        except OSError:
            pass
    return data


def _comets() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    lo, hi = _jd(now - timedelta(days=500)), _jd(now + timedelta(days=900))
    cdata = json.dumps({"AND": [f"tp|RG|{lo:.0f}|{hi:.0f}", "M1|LT|17"]})
    url = f"{SBDB}?fields=full_name,pdes,e,q,i,om,w,tp,M1,K1&sb-kind=c&sb-cdata={urllib.parse.quote(cdata)}&limit=600"
    raw = _get_json(url, timeout=60)
    if not isinstance(raw, dict) or "data" not in raw:
        raise FetchError("JPL sent an unexpected comet list")
    out = []
    for r in raw["data"]:
        try:
            full, pdes, e, q, i, om, w, tp, m1, k1 = r
            out.append({"name": (full or pdes or "").strip(), "e": float(e), "q": float(q), "i": float(i), "om": float(om), "w": float(w), "tp": float(tp), "m1": float(m1), "k1": float(k1) if k1 not in (None, "") else 10.0})
        except (TypeError, ValueError):
            continue
    return out


def comets() -> dict[str, Any]:
    """Comets with a brightness estimate whose perihelion is within about the last 1.5 years to the next 2.5, with their orbital elements."""
    return {"comets": _cached("comets", LIST_CACHE_S, _comets), "credit": CREDIT}


def _asteroids() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    end = now + timedelta(days=400)
    url = f"{CAD}?date-min={now:%Y-%m-%d}&date-max={end:%Y-%m-%d}&dist-max=20LD&sort=date&fullname=true"
    raw = _get_json(url, timeout=60)
    if not isinstance(raw, dict) or "data" not in raw:
        raise FetchError("JPL sent an unexpected close-approach list")
    fields = raw["fields"]
    out = []
    for row in raw["data"]:
        r = dict(zip(fields, row))
        try:
            t = datetime.strptime(r["cd"], "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc)
            out.append({"name": (r.get("fullname") or r["des"]).strip(), "t": int(t.timestamp() * 1000), "ld": float(r["dist"]) / LUNAR_DISTANCE_AU, "v": float(r["v_rel"]), "h": float(r["h"]) if r.get("h") not in (None, "") else None})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def asteroids() -> dict[str, Any]:
    """Asteroids passing within 20 Moon distances of the Earth in the next year: time (ms), distance in Moon distances, speed km/s, absolute magnitude H."""
    return {"asteroids": _cached("asteroids", LIST_CACHE_S, _asteroids), "credit": CREDIT}


def outlook(lat: float, lon: float) -> dict[str, Any]:
    """Hourly cloud cover (%) and rain chance for the next 10 days at a place, UTC hours."""
    key = f"outlook-{round(lat, 1)}-{round(lon, 1)}"

    def make() -> dict[str, Any]:
        q = f"{OPEN_METEO}?latitude={round(lat, 1)}&longitude={round(lon, 1)}&timezone=UTC&forecast_days=10&hourly=cloud_cover,precipitation_probability"
        raw = _get_json(q, timeout=30)
        if not isinstance(raw, dict) or "hourly" not in raw:
            raise FetchError("the weather service sent an unexpected answer")
        h = raw["hourly"]
        times = [int(datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp() * 1000) for t in h["time"]]
        return {"t": times, "cloud": h["cloud_cover"], "rain": h.get("precipitation_probability")}

    return _cached(key, OUTLOOK_CACHE_S, make, disk=False)
