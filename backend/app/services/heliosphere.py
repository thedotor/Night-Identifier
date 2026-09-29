"""The space around the Earth and out to the planets, from public data (no account needed).

* Ground magnetometers: the US Geological Survey's geomagnetism service (geomag.usgs.gov) publishes 1-minute readings from its
  observatories (Alaska, the western and eastern US, Hawaii, Guam, Puerto Rico). They measure how much the field at the ground
  is being shaken by what happens in space. There are 13 with live data, all in US territory: the network is US-centred, and
  the app says so. (INTERMAGNET stations of other countries are listed by the service but do not serve live data.)
* Dst: the storm-time disturbance index (NOAA SWPC, from the Kyoto observatories): hourly, negative in a magnetic storm, and
  NOAA's hour-ahead Geospace model estimate.
* The solar wind flow: NOAA SWPC's WSA-Enlil model runs. WSA-Enlil follows the wind from the Sun's surface magnetic map out to
  about 1.7 AU. NOAA publishes it as hourly pictures of a slice through the plane of the planets (density and speed) and as a
  time series at Earth for the next week. It is a forecast MODEL, not a measurement, and is only available as pictures.

Everything is cached (memory, and disk for the pictures) and fails soft: with no connection the last answer is served.
"""

import io
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _http_get

logger = log_capture.get_logger("heliosphere")

SWPC = "https://services.swpc.noaa.gov"
USGS = "https://geomag.usgs.gov/ws"
CREDIT_GROUND = "Ground magnetometers: U.S. Geological Survey Geomagnetism Program (geomag.usgs.gov), public domain"
CREDIT_DST = "Dst: NOAA SWPC / World Data Center for Geomagnetism, Kyoto"
CREDIT_ENLIL = "Solar wind model: NOAA SWPC WSA-Enlil (a forecast model, not a measurement)"

# id, name, region (their coordinates come from the service)
STATIONS = ["BOU", "BRW", "BSL", "CMO", "DED", "FRD", "GUA", "HON", "NEW", "SHU", "SIT", "SJG", "TUC"]
STATION_CACHE_S = 120
DST_CACHE_S = 300
ENLIL_LIST_CACHE_S = 30 * 60
ENLIL_SERIES_CACHE_S = 30 * 60

# Where the two square panels sit in NOAA's 960 x 600 Enlil pictures (measured): the Sun is at the centre of each circle,
# the circle reaches 1.70 AU, and Earth's orbit (1 AU) is 73.25 px from the centre.
ENLIL_PANELS = {"density": (201.5, 183.5), "velocity": (201.5, 449.5)}
ENLIL_RADIUS_PX = 124.5
ENLIL_AU_PX = 73.25
ENLIL_OUT_PX = 384

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "enlil"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _iso_ms(t: str) -> int:
    return int(datetime.fromisoformat(t.replace("Z", "")).replace(tzinfo=timezone.utc).timestamp() * 1000)


def _cached(key: str, ttl: float, make: Any) -> Any:
    now = time.time()
    with _lock:
        hit = _mem.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        val = make()
    except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
        if hit:
            logger.info("Heliosphere: could not refresh %s (%s); serving the last one", key, e)
            return hit[1]
        raise FetchError(f"could not get {key} ({e})") from e
    with _lock:
        _mem[key] = (now, val)
    return val


# ---------- Dst ----------


def _dst() -> dict[str, Any]:
    kyoto = _get_json(f"{SWPC}/products/kyoto-dst.json", timeout=30) or []
    series = [[_iso_ms(r["time_tag"]), float(r["dst"])] for r in kyoto if r.get("dst") is not None]
    if not series:
        raise FetchError("no Dst values")
    series.sort()
    forecast: list[list[float]] = []
    try:
        geo = _get_json(f"{SWPC}/json/geospace/geospace_dst_1_hour.json", timeout=30) or []
        forecast = sorted([[_iso_ms(r["time_tag"]), float(r["dst"])] for r in geo if r.get("dst") is not None])
    except (FetchError, ValueError, KeyError, TypeError):
        pass
    return {"series": series, "now": series[-1], "forecast": forecast, "credit": CREDIT_DST}


def dst() -> dict[str, Any]:
    """Dst (nT) hourly for the last week, and NOAA's hour-ahead estimate. Around 0 is quiet; below -50 a storm; below -100 an intense one."""
    return _cached("dst", DST_CACHE_S, _dst)


# ---------- ground magnetometers ----------


def _station_info() -> dict[str, dict[str, Any]]:
    raw = _get_json(f"{USGS}/observatories/?format=json", timeout=30) or {}
    out = {}
    for f in raw.get("features", []):
        if f.get("id") in STATIONS:
            lon, lat = f["geometry"]["coordinates"][:2]
            out[f["id"]] = {"id": f["id"], "name": f["properties"].get("name"), "lat": lat, "lon": ((lon + 180) % 360) - 180}
    return out


def _one_station(sid: str, start: datetime, end: datetime) -> dict[str, Any]:
    q = f"id={sid}&format=json&elements=X,Y,Z&type=variation&sampling_period=60&starttime={start:%Y-%m-%dT%H:%M:%SZ}&endtime={end:%Y-%m-%dT%H:%M:%SZ}"
    raw = _get_json(f"{USGS}/data/?{q}", timeout=40)
    if not raw:
        raise FetchError(f"{sid}: no data")
    times = raw["times"]
    comp = {v["id"]: v["values"] for v in raw["values"]}
    last = max((i for i, x in enumerate(comp.get("X", [])) if x is not None), default=None)
    if last is None:
        raise FetchError(f"{sid}: empty")
    t_last = _iso_ms(times[last])

    def rng(name: str, minutes: int) -> float:
        vals = [x for i, x in enumerate(comp.get(name, [])) if x is not None and _iso_ms(times[i]) > t_last - minutes * 60_000]
        return (max(vals) - min(vals)) if len(vals) > 3 else 0.0

    def step(name: str) -> float:
        vals = [x for i, x in enumerate(comp.get(name, [])) if x is not None and _iso_ms(times[i]) > t_last - 10 * 60_000]
        return max((abs(b - a) for a, b in zip(vals, vals[1:])), default=0.0)

    x, y, z = comp["X"][last], comp["Y"][last], comp["Z"][last]
    r1 = max(rng("X", 60), rng("Y", 60), rng("Z", 60))
    r3 = max(rng("X", 180), rng("Y", 180), rng("Z", 180))
    # a small graph: the X (north) component, every 5 minutes, relative to its 3-hour mean
    xs = [(i, v) for i, v in enumerate(comp.get("X", [])) if v is not None]
    mean = sum(v for _, v in xs) / len(xs)
    spark = [[_iso_ms(times[i]), round(v - mean, 1)] for i, v in xs[::5]]
    return {
        "time": t_last,
        "x": x,
        "y": y,
        "z": z,
        "f": (x * x + y * y + z * z) ** 0.5,
        "range_1h": round(r1, 1),
        "range_3h": round(r3, 1),
        "max_step": round(max(step("X"), step("Y"), step("Z")), 1),
        "spark": spark,
    }


def _stations() -> dict[str, Any]:
    info = _station_info()
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=3)
    rows: list[dict[str, Any]] = []
    errors: list[str] = []

    def work(sid: str) -> dict[str, Any] | None:
        try:
            return {**info[sid], **_one_station(sid, start, end)} if sid in info else None
        except (FetchError, LookupError, ValueError, KeyError, TypeError) as e:
            errors.append(str(e))
            return None

    with ThreadPoolExecutor(6) as ex:
        for r in ex.map(work, STATIONS):
            if r:
                rows.append(r)
    if not rows:
        raise FetchError("the USGS magnetometers are not answering")
    return {"stations": rows, "errors": errors, "fetched_at": time.time(), "credit": CREDIT_GROUND}


def stations() -> dict[str, Any]:
    """The last three hours at each live USGS observatory: latest field components, how much they moved in the last hour, and a small graph."""
    return _cached("stations", STATION_CACHE_S, _stations)


# ---------- WSA-Enlil ----------

_FRAME_RE = re.compile(r"enlil_com2_\d+_(\d{8}T\d{6})\.jpg")


def _enlil_frames() -> list[dict[str, Any]]:
    raw = _get_json(f"{SWPC}/products/animations/enlil.json", timeout=30) or []
    out = []
    for r in raw:
        m = _FRAME_RE.search(r.get("url", ""))
        if m:
            t = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            out.append({"t": int(t.timestamp() * 1000), "url": r["url"]})
    out.sort(key=lambda x: x["t"])
    if not out:
        raise FetchError("no Enlil frames listed")
    return out


def enlil_frames() -> list[dict[str, Any]]:
    """The hourly frames NOAA currently offers (about 7 days: a few days before now to a few days after)."""
    return _cached("enlil-frames", ENLIL_LIST_CACHE_S, _enlil_frames)


def enlil_image(panel: str, when_ms: int | None) -> tuple[bytes, int, int, int]:
    """A JPEG of one panel (density or velocity) cropped to the circle, for the frame nearest `when_ms` (None = the frame nearest now).
    Returns the bytes, the frame's time, the first and the last frame times."""
    if panel not in ENLIL_PANELS:
        raise ValueError("unknown panel")
    frames = enlil_frames()
    target = when_ms if when_ms is not None else int(time.time() * 1000)
    best = min(frames, key=lambda f: abs(f["t"] - target))
    stem = re.sub(r"[^0-9A-Za-z]", "", best["url"].rsplit("/", 1)[-1])
    path = _dir() / f"{stem}-{panel}.jpg"
    if not path.exists():
        body, _ = _http_get(SWPC + best["url"], timeout=40, attempts=2)
        from PIL import Image

        im = Image.open(io.BytesIO(body)).convert("RGB")
        cx, cy = ENLIL_PANELS[panel]
        r = ENLIL_RADIUS_PX
        crop = im.crop((int(round(cx - r)), int(round(cy - r)), int(round(cx + r)) + 1, int(round(cy + r)) + 1)).resize((ENLIL_OUT_PX, ENLIL_OUT_PX), Image.LANCZOS)
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=90)
        path.write_bytes(buf.getvalue())
        old = sorted(_dir().glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in old[260:]:
            p.unlink(missing_ok=True)
    return path.read_bytes(), best["t"], frames[0]["t"], frames[-1]["t"]


def _enlil_earth() -> dict[str, Any]:
    raw = _get_json(f"{SWPC}/json/enlil_time_series.json", timeout=60) or []
    rows = []
    for r in raw:
        try:
            t = _iso_ms(r["time_tag"])
            b = (r["b_r"] ** 2 + r["b_theta"] ** 2 + r["b_phi"] ** 2) ** 0.5
            rows.append([t, round(r["v_r"], 1), round(r["earth_particles_per_cm3"], 2), round(b, 2), round(r["temperature"])])
        except (KeyError, TypeError):
            continue
    rows.sort()
    if not rows:
        raise FetchError("no Enlil time series")
    # every hour is plenty for the graphs
    hourly: list[list[float]] = []
    last = -1
    for r in rows:
        h = r[0] // 3_600_000
        if h != last:
            hourly.append(r)
            last = h
    return {"rows": hourly, "columns": ["t_ms", "speed_kms", "density_cm3", "b_nt", "temperature_k"], "credit": CREDIT_ENLIL}


def enlil_earth() -> dict[str, Any]:
    """NOAA's WSA-Enlil forecast of the wind at Earth, hourly for about a week: speed (km/s), density (per cm3), field strength (nT), temperature (K)."""
    return _cached("enlil-earth", ENLIL_SERIES_CACHE_S, _enlil_earth)
