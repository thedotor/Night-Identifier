"""Aurora and space weather from NOAA's Space Weather Prediction Center (services.swpc.noaa.gov, public domain).

* The aurora grid: SWPC's OVATION Aurora "short term forecast" (a "nowcast"): a model, driven by the solar wind
  measured a little upstream of Earth, of how likely visible aurora is at each degree of longitude and latitude
  (0 to 100), valid roughly half an hour to an hour ahead of when it was computed. Both poles, every 5 minutes.
  It says where aurora is likely, not what a camera would see; cloud, moonlight and daylight decide that.
* Space weather: the planetary Kp index (observed, estimated and NOAA's 3-day forecast), the solar wind speed,
  density and magnetic field (Bz) measured at the L1 point about 1.5 million km sunward, and the hemispheric
  power of the aurora in gigawatts.

Everything is cached (memory, and disk for the grid) and fails soft: with no connection the last answer is served.
"""

import base64
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _http_get

logger = log_capture.get_logger("aurora")

BASE = "https://services.swpc.noaa.gov"
GRID_URL = f"{BASE}/json/ovation_aurora_latest.json"
KP_URL = f"{BASE}/products/noaa-planetary-k-index-forecast.json"
WIND_URL = f"{BASE}/json/rtsw/rtsw_wind_1m.json"
MAG_URL = f"{BASE}/json/rtsw/rtsw_mag_1m.json"
HEMI_URL = f"{BASE}/text/aurora-nowcast-hemi-power.txt"
CREDIT = "Aurora and space weather: NOAA Space Weather Prediction Center (swpc.noaa.gov)"

GRID_W = 360
GRID_H = 181
GRID_CACHE_S = 240
WEATHER_CACHE_S = 60
KP_CACHE_S = 30 * 60
WIND_HOURS = 3
ELECTRON_URL = f"{BASE}/json/goes/primary/integral-electrons.json"
ELECTRON_CACHE_S = 10 * 60

_lock = threading.Lock()
_grid_mem: dict[str, Any] | None = None
_weather_mem: tuple[float, dict[str, Any]] | None = None
_kp_mem: tuple[float, list[list[Any]]] | None = None
_electron_mem: tuple[float, dict[str, Any] | None] | None = None


def _grid_path() -> Path:
    d = settings.deepspace_dir / "aurora"
    d.mkdir(parents=True, exist_ok=True)
    return d / "ovation.json"


def grid() -> dict[str, Any]:
    """The aurora chance grid: 360 x 181 bytes (longitude 0..359 east, latitude -90..90 from row 0), base64, each byte a percentage."""
    global _grid_mem
    with _lock:
        have = _grid_mem
        if have is None:
            try:
                have = json.loads(_grid_path().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                have = None
        if have is None or time.time() - have["fetched_at"] > GRID_CACHE_S:
            try:
                raw = _get_json(GRID_URL, timeout=40)
                if not isinstance(raw, dict) or "coordinates" not in raw:
                    raise FetchError("NOAA sent an unexpected aurora file")
                data = bytearray(GRID_W * GRID_H)
                for lon, lat, val in raw["coordinates"]:
                    lon = int(lon) % GRID_W
                    lat = int(lat)
                    if -90 <= lat <= 90:
                        data[(lat + 90) * GRID_W + lon] = max(0, min(255, int(val)))
                have = {
                    "width": GRID_W,
                    "height": GRID_H,
                    "data": base64.b64encode(bytes(data)).decode("ascii"),
                    "observation_time": raw.get("Observation Time"),
                    "forecast_time": raw.get("Forecast Time"),
                    "max": max(data),
                    "fetched_at": time.time(),
                    "credit": CREDIT,
                }
                _grid_path().write_text(json.dumps(have), encoding="utf-8")
                logger.info("Aurora: new OVATION grid (valid %s, peak %d%%)", have["forecast_time"], have["max"])
            except (FetchError, LookupError, ValueError, OSError) as e:
                if have is None:
                    raise FetchError(f"could not get the aurora forecast ({e})") from e
                logger.info("Aurora: could not refresh the grid (%s); serving the last one", e)
        _grid_mem = have
        return {**have, "stale": time.time() - have["fetched_at"] > 3 * GRID_CACHE_S}


def _iso_ms(t: str) -> int:
    return int(datetime.fromisoformat(t.replace("Z", "")).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _kp_rows() -> list[list[Any]]:
    """[time (UTC ISO), kp, "observed" | "estimated" | "predicted", NOAA scale "G1".."G5" or null] every 3 hours."""
    global _kp_mem
    if _kp_mem and time.time() - _kp_mem[0] < KP_CACHE_S:
        return _kp_mem[1]
    try:
        raw = _get_json(KP_URL, timeout=30)
        rows = [[r["time_tag"], float(r["kp"]), r.get("observed") or "observed", r.get("noaa_scale")] for r in raw or [] if r.get("kp") is not None]
        if not rows:
            raise FetchError("no Kp values")
        _kp_mem = (time.time(), rows)
    except (FetchError, LookupError, ValueError, KeyError, TypeError):
        if _kp_mem is None:
            raise
    return _kp_mem[1]


def _series(url: str, fields: dict[str, str], hours: float) -> list[dict[str, Any]]:
    """The last `hours` of a 1-minute real-time solar wind file, from the active spacecraft only, oldest first. (The files are not in time order.)"""
    raw = _get_json(url, timeout=40)
    if not isinstance(raw, list):
        raise FetchError("unexpected solar wind file")
    rows = [r for r in raw if r.get("active")]
    rows.sort(key=lambda r: r["time_tag"])
    if not rows:
        return []
    end = _iso_ms(rows[-1]["time_tag"])
    out = []
    for r in rows:
        if _iso_ms(r["time_tag"]) < end - hours * 3_600_000:
            continue
        item = {"t": r["time_tag"]}
        for name, key in fields.items():
            v = r.get(key)
            item[name] = float(v) if isinstance(v, (int, float)) and v > -9990 else None
        out.append(item)
    return out


def _hemi_power() -> dict[str, Any] | None:
    try:
        body, _ = _http_get(HEMI_URL, accept="text/plain", attempts=2, timeout=20)
    except (FetchError, LookupError):
        return None
    last = None
    for line in body.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0][:2] == "20":
            last = parts
    if not last:
        return None
    try:
        return {"time": last[1].replace("_", "T"), "north_gw": float(last[2]), "south_gw": float(last[3])}
    except ValueError:
        return None


def _electron_flux() -> dict[str, Any] | None:
    """GOES's >=2 MeV electron flux at geostationary orbit: a standard proxy for how charged the outer Van Allen belt is right now."""
    global _electron_mem
    if _electron_mem and time.time() - _electron_mem[0] < ELECTRON_CACHE_S:
        return _electron_mem[1]
    try:
        raw = _get_json(ELECTRON_URL, timeout=30) or []
        rows = sorted((r for r in raw if r.get("energy") == ">=2 MeV" and r.get("flux") is not None), key=lambda r: r["time_tag"])
        if not rows:
            raise FetchError("no electron flux data")
        val = {"flux": float(rows[-1]["flux"]), "time": rows[-1]["time_tag"]}
        _electron_mem = (time.time(), val)
    except (FetchError, LookupError, ValueError, KeyError, TypeError):
        if _electron_mem is None:
            _electron_mem = (time.time(), None)
    return _electron_mem[1]


def _decimate(rows: list[dict[str, Any]], every: int) -> list[dict[str, Any]]:
    return rows[::every] + ([rows[-1]] if rows and (len(rows) - 1) % every else [])


def space_weather() -> dict[str, Any]:
    """Kp (now, the last 24 hours and the 3-day forecast), the solar wind and Bz over the last 3 hours, and the aurora's power."""
    global _weather_mem
    with _lock:
        if _weather_mem and time.time() - _weather_mem[0] < WEATHER_CACHE_S:
            return _weather_mem[1]
        out: dict[str, Any] = {"credit": CREDIT, "fetched_at": time.time(), "errors": []}
        try:
            kp = _kp_rows()
            now = time.time() * 1000
            done = [r for r in kp if r[2] != "predicted" and _iso_ms(r[0]) <= now]  # a row is the 3 hours that START at its time: the block holding now
            out["kp"] = kp
            out["kp_now"] = done[-1][1] if done else None
            out["kp_now_time"] = done[-1][0] if done else None
        except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
            out["errors"].append(f"Kp: {e}")
        try:
            wind = _series(WIND_URL, {"speed": "proton_speed", "density": "proton_density", "temperature": "proton_temperature"}, WIND_HOURS)
            mag = _series(MAG_URL, {"bz": "bz_gsm", "bt": "bt"}, WIND_HOURS)
            by_t: dict[str, dict[str, Any]] = {}
            for r in wind + mag:
                by_t.setdefault(r["t"], {"t": r["t"]}).update({k: v for k, v in r.items() if k != "t"})
            merged = [by_t[t] for t in sorted(by_t)]
            out["solar_wind"] = _decimate(merged, 3)
            latest: dict[str, Any] = {}
            for key in ("speed", "density", "temperature", "bz", "bt"):
                for r in reversed(merged):
                    if r.get(key) is not None:
                        latest[key] = r[key]
                        latest[f"{key}_time"] = r["t"]
                        break
            out["solar_wind_now"] = latest
        except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
            out["errors"].append(f"Solar wind: {e}")
        out["hemispheric_power"] = _hemi_power()
        out["electron_flux_2mev"] = _electron_flux()
        if "kp" not in out and "solar_wind" not in out:
            if _weather_mem:
                return {**_weather_mem[1], "stale": True}
            raise FetchError("NOAA's space weather service is not answering")
        _weather_mem = (time.time(), out)
        return out
