"""The live Sun: pictures of it, and what it is doing (public data, no account needed).

* Pictures come from the Helioviewer project (api.helioviewer.org), which serves NASA's SDO and ESA/NASA's SOHO images cut
  to any framing. The framing is fixed here so the 3D Sun can be mapped exactly:
    - the surface (visible light, magnetic field, or extreme ultraviolet): 1024 px wide at 2.6 arcsec per pixel, so the Sun's
      disc is about 72% of the half-width across (the exact figure follows the Earth-Sun distance)
    - the corona: SOHO LASCO C2 (2.2 to about 6 solar radii) and C3 (about 4 to 30), 512 px wide.
  Coronagraph pictures block the Sun itself with a disc (the "occulter"), so they only show the outer atmosphere.
* Activity: NOAA's GOES X-ray flux and flare list, NOAA's numbered sunspot groups, and NASA's DONKI catalogue of coronal mass
  ejections (CMEs) with speeds, directions and the model's arrival time at Earth. DONKI is rate-limited without a key
  (DEMO_KEY: 30 requests an hour), so it is cached for an hour; a free key from api.nasa.gov can be saved in Settings.

Everything is cached in memory and on disk and fails soft: offline, the last answer is served.
"""

import io
import json
import math
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import app_settings, log_capture
from app.services.deepspace import FetchError, _get_json, _http_get

logger = log_capture.get_logger("sun")

HELIO = "https://api.helioviewer.org/v2"
SWPC = "https://services.swpc.noaa.gov"
DONKI = "https://api.nasa.gov/DONKI"
CREDIT = "Solar images: NASA SDO and ESA/NASA SOHO via Helioviewer. Activity: NOAA SWPC and NASA CCMC DONKI."

# kind -> (Helioviewer source id, arcsec per pixel, pixels, label)
KINDS: dict[str, tuple[int, float, int, str]] = {
    "visual": (18, 2.6, 1024, "SDO HMI visible light"),
    "magnetogram": (19, 2.6, 1024, "SDO HMI magnetic field"),
    "euv": (11, 2.6, 1024, "SDO AIA 193 A (hot corona)"),
    "euv304": (13, 2.6, 1024, "SDO AIA 304 A (chromosphere)"),
    "euv171": (10, 2.6, 1024, "SDO AIA 171 A (quiet corona)"),
    "c2": (4, 24.0, 512, "SOHO LASCO C2 corona"),
    "c3": (5, 120.0, 512, "SOHO LASCO C3 outer corona"),
}
IMAGE_BUCKET_S = 15 * 60
ACTIVITY_CACHE_S = 5 * 60
DONKI_CACHE_S = 60 * 60
SOLAR_RADIUS_KM = 695_700.0
AU_KM = 149_597_870.7
CME_START_RSUN = 21.5

_lock = threading.Lock()
_mem: dict[str, tuple[float, Any]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "sun"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        s = s.strip().replace("Z", "")
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


# ---------- pictures ----------


def _bucket(when: datetime | None) -> datetime:
    """Snap to a 15-minute step so repeated asks share one download (the coronagraphs only update every 12-20 minutes anyway)."""
    now = datetime.now(timezone.utc)
    if when is None or when > now - timedelta(minutes=10):
        when = now - timedelta(minutes=10)
    t = int(when.timestamp() // IMAGE_BUCKET_S * IMAGE_BUCKET_S)
    return datetime.fromtimestamp(t, tz=timezone.utc)


def image(kind: str, when: datetime | None) -> tuple[bytes, str]:
    """A JPEG of the Sun in the given kind at (about) the given time (None = latest), and the time the picture was actually taken."""
    if kind not in KINDS:
        raise ValueError("unknown kind")
    source, scale, px, _ = KINDS[kind]
    t = _bucket(when)
    stem = f"{kind}-{t.strftime('%Y%m%dT%H%M')}"
    jpg, meta = _dir() / f"{stem}.jpg", _dir() / f"{stem}.json"
    if jpg.exists() and meta.exists():
        return jpg.read_bytes(), json.loads(meta.read_text(encoding="utf-8"))["time"]
    date = _iso(t)
    shot = (
        f"{HELIO}/takeScreenshot/?date={date}&imageScale={scale}&layers={urllib.parse.quote(f'[{source},1,100]')}"
        f"&x0=0&y0=0&width={px}&height={px}&display=true&watermark=false"
    )
    got = _http_get(shot, timeout=60, attempts=2)[0]
    taken = date
    try:
        info = _get_json(f"{HELIO}/getClosestImage/?date={date}&sourceId={source}", timeout=20)
        if isinstance(info, dict) and info.get("date"):
            taken = str(info["date"]).replace(" ", "T")
            if not taken.endswith("Z"):
                taken += "Z"
    except FetchError:
        pass
    from PIL import Image

    im = Image.open(io.BytesIO(got)).convert("RGB")
    if im.size != (px, px):
        raise FetchError("Helioviewer sent a picture of an unexpected size")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=90)
    data = buf.getvalue()
    jpg.write_bytes(data)
    meta.write_text(json.dumps({"time": taken}), encoding="utf-8")
    _prune()
    return data, taken


def _prune(keep: int = 160) -> None:
    files = sorted(_dir().glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[keep:]:
        p.unlink(missing_ok=True)
        p.with_suffix(".json").unlink(missing_ok=True)


# ---------- activity: X-rays, flares, sunspot groups ----------


def _flare_number(cls: str | None) -> float:
    """'M5.2' -> 1e-5 * 5.2 W/m2 ordering key; 0 if unknown."""
    if not cls or len(cls) < 2:
        return 0.0
    base = {"A": 1e-8, "B": 1e-7, "C": 1e-6, "M": 1e-5, "X": 1e-4}.get(cls[0].upper())
    try:
        return base * float(cls[1:]) if base else 0.0
    except ValueError:
        return 0.0


def flux_class(flux: float) -> str:
    """GOES class letter and number for a 0.1-0.8 nm flux in W/m2 (1e-6 is C1.0)."""
    if flux <= 0:
        return "A0.0"
    for letter, base in (("X", 1e-4), ("M", 1e-5), ("C", 1e-6), ("B", 1e-7), ("A", 1e-8)):
        if flux >= base:
            return f"{letter}{flux / base:.1f}"
    return f"A{flux / 1e-8:.1f}"


def _cached(key: str, ttl: float, make: Any, disk: bool = False) -> Any:
    """Memory cache with a time to live; with `disk` the last answer also survives a restart (used for NASA's rate-limited catalogue)."""
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
            logger.info("Sun: could not refresh %s (%s); serving the last one", key, e)
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


def _xray() -> dict[str, Any]:
    raw = _get_json(f"{SWPC}/json/goes/primary/xrays-6-hour.json", timeout=30) or []
    rows = sorted(
        ((_parse(r["time_tag"]), r["flux"]) for r in raw if r.get("energy") == "0.1-0.8nm" and r.get("flux") is not None),
        key=lambda x: x[0] or datetime.min.replace(tzinfo=timezone.utc),
    )
    rows = [(t, f) for t, f in rows if t is not None]
    if not rows:
        raise FetchError("no X-ray data")
    series = [[_ms(t), f] for t, f in rows[::5]]
    if series[-1][0] != _ms(rows[-1][0]):
        series.append([_ms(rows[-1][0]), rows[-1][1]])
    return {"flux": rows[-1][1], "class": flux_class(rows[-1][1]), "time": _ms(rows[-1][0]), "series": series}


_PROTON_SCALE = ((1e5, "S5"), (1e4, "S4"), (1e3, "S3"), (100.0, "S2"), (10.0, "S1"))


def _proton_class(pfu: float) -> str | None:
    """NOAA's S-scale for a >=10 MeV integral proton flux reading, in particle flux units."""
    for base, label in _PROTON_SCALE:
        if pfu >= base:
            return label
    return None


def _proton() -> dict[str, Any]:
    raw = _get_json(f"{SWPC}/json/goes/primary/integral-protons.json", timeout=30) or []
    rows = sorted(
        ((_parse(r["time_tag"]), r["flux"]) for r in raw if r.get("energy") == ">=10 MeV" and r.get("flux") is not None),
        key=lambda x: x[0] or datetime.min.replace(tzinfo=timezone.utc),
    )
    rows = [(t, f) for t, f in rows if t is not None]
    if not rows:
        raise FetchError("no proton flux data")
    t, flux = rows[-1]
    return {"flux_pfu": flux, "class": _proton_class(flux), "time": _ms(t)}


def _flares_noaa() -> list[dict[str, Any]]:
    raw = _get_json(f"{SWPC}/json/goes/primary/xray-flares-7-day.json", timeout=30) or []
    out = []
    for r in raw:
        cls = r.get("max_class")
        b, p = _parse(r.get("begin_time")), _parse(r.get("max_time"))
        if not cls or b is None or p is None:
            continue
        e = _parse(r.get("end_time"))
        out.append({"class": cls, "begin": _ms(b), "peak": _ms(p), "end": _ms(e) if e else None, "region": None})
    return out


def _location(loc: str | None) -> tuple[float, float] | None:
    """'S10W12' -> (latitude -10, longitude +12) (west positive, as on the disc seen from Earth)."""
    if not loc or len(loc) < 6:
        return None
    try:
        lat = float(loc[1:3]) * (1 if loc[0].upper() == "N" else -1)
        lon = float(loc[4:6]) * (1 if loc[3].upper() == "W" else -1)
    except ValueError:
        return None
    return lat, lon


def _regions() -> list[dict[str, Any]]:
    """NOAA's numbered active regions (sunspot groups) on the most recent report, with the position they had at that time."""
    raw = _get_json(f"{SWPC}/json/solar_regions.json", timeout=30) or []
    if not raw:
        return []
    last = max(r.get("observed_date") or "" for r in raw)
    out = []
    for r in raw:
        if r.get("observed_date") != last or r.get("latitude") is None or r.get("longitude") is None:
            continue
        obs = _parse(last)
        out.append(
            {
                "number": r.get("region"),
                "lat": r["latitude"],
                "lon": r["longitude"],
                "observed": _ms(obs) if obs else None,
                "area": r.get("area"),
                "spots": r.get("number_spots"),
                "spot_class": r.get("spot_class"),
                "mag_class": r.get("mag_class"),
                "c_prob": r.get("c_flare_probability"),
                "m_prob": r.get("m_flare_probability"),
                "x_prob": r.get("x_flare_probability"),
            }
        )
    return out


# ---------- CMEs (NASA DONKI) ----------


def _nasa_key() -> str:
    return app_settings.get_nasa_api_key() or "DEMO_KEY"


_donki_retry_at = 0.0


def _donki(kind: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    """One DONKI list. After a failure (typically the shared demo key's hourly limit) it is not asked again for 10 minutes, so a rate-limited key is not hammered and callers do not wait."""
    global _donki_retry_at
    if time.time() < _donki_retry_at:
        raise FetchError("NASA's DONKI service is rate-limited or not answering; trying again in a few minutes")
    url = f"{DONKI}/{kind}?startDate={start:%Y-%m-%d}&endDate={end:%Y-%m-%d}&api_key={urllib.parse.quote(_nasa_key())}"
    try:
        raw = _get_json(url, timeout=20)
    except FetchError:
        _donki_retry_at = time.time() + 600
        raise
    return raw if isinstance(raw, list) else []


def _angle_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a, b, c, d = map(math.radians, (lat1, lon1, lat2, lon2))
    x = math.sin(a) * math.sin(c) + math.cos(a) * math.cos(c) * math.cos(b - d)
    return math.degrees(math.acos(max(-1.0, min(1.0, x))))


def _cme_summary(c: dict[str, Any]) -> dict[str, Any] | None:
    """One CME with its best analysis (speed, direction, width, the time it passed 21.5 solar radii) and when it reaches Earth."""
    an = [a for a in (c.get("cmeAnalyses") or []) if a.get("longitude") is not None and a.get("latitude") is not None and a.get("speed")]
    if not an:
        return None
    best = next((a for a in an if a.get("isMostAccurate")), an[0])
    t0 = _parse(best.get("time21_5")) or _parse(c.get("startTime"))
    if t0 is None:
        return None
    lat, lon, half, speed = float(best["latitude"]), float(best["longitude"]), float(best.get("halfAngle") or 30), float(best["speed"])
    arrival: datetime | None = None
    source = None
    for a in an:
        for m in a.get("enlilList") or []:
            for imp in m.get("impactList") or []:
                if str(imp.get("location", "")).lower() == "earth" and _parse(imp.get("arrivalTime")):
                    arrival, source = _parse(imp["arrivalTime"]), "NASA's ENLIL model"
            if arrival is None and _parse(m.get("estimatedShockArrivalTime")):
                arrival, source = _parse(m["estimatedShockArrivalTime"]), "NASA's ENLIL model"
    sep = _angle_between(lat, lon, 0.0, 0.0)
    directed = arrival is not None or sep < half * 0.9
    if arrival is None and directed:
        travel_s = (AU_KM - CME_START_RSUN * SOLAR_RADIUS_KM) / speed
        arrival, source = t0 + timedelta(seconds=travel_s), "a rough estimate (constant speed)"
    src = c.get("sourceLocation") or ""
    return {
        "id": c.get("activityID"),
        "start": _ms(_parse(c.get("startTime")) or t0),
        "t215": _ms(t0),
        "lat": lat,
        "lon": lon,
        "half_angle": half,
        "speed": speed,
        "type": best.get("type"),
        "source": src or None,
        "note": (c.get("note") or "").strip()[:400] or None,
        "earth_directed": bool(directed),
        "arrival": _ms(arrival) if arrival else None,
        "arrival_source": source,
        "separation": round(sep, 1),
    }


def _cmes(start: datetime, end: datetime) -> list[dict[str, Any]]:
    out = []
    for c in _donki("CME", start, end):
        s = _cme_summary(c)
        if s:
            out.append(s)
    out.sort(key=lambda x: x["t215"])
    return out


def _flares_donki(start: datetime, end: datetime) -> list[dict[str, Any]]:
    out = []
    for f in _donki("FLR", start, end):
        b, p = _parse(f.get("beginTime")), _parse(f.get("peakTime"))
        if not f.get("classType") or b is None or p is None:
            continue
        e = _parse(f.get("endTime"))
        out.append({"class": f["classType"], "begin": _ms(b), "peak": _ms(p), "end": _ms(e) if e else None, "region": f.get("activeRegionNum")})
    return out


def activity(when: datetime | None = None) -> dict[str, Any]:
    """What the Sun is doing now (or, with `when`, around then: CMEs and flares from the archive, no live X-ray graph)."""
    now = datetime.now(timezone.utc)
    live = when is None or when > now - timedelta(hours=6)
    out: dict[str, Any] = {"live": live, "credit": CREDIT, "time": _ms(now if live else when)}
    if live:
        end = now + timedelta(days=1)
        start = now - timedelta(days=6)
        out["errors"] = []
        try:
            out["cmes"] = _cached("cmes-live", DONKI_CACHE_S, lambda: _cmes(start, end), disk=True)
        except FetchError as e:
            out["cmes"] = []
            out["errors"].append(f"CMEs: {e}")
        try:
            out["flares"] = _cached("flares-live", ACTIVITY_CACHE_S, _flares_noaa)
        except FetchError as e:
            out["flares"] = []
            out["errors"].append(f"Flares: {e}")
        try:
            out["xray"] = _cached("xray", 60, _xray)
        except FetchError:
            out["xray"] = None
        try:
            out["regions"] = _cached("regions", 30 * 60, _regions)
        except FetchError:
            out["regions"] = []
        try:
            out["proton"] = _cached("proton", 300, _proton)
        except FetchError:
            out["proton"] = None
    else:
        assert when is not None
        day = when.strftime("%Y-%m-%d")
        start, end = when - timedelta(days=6), when + timedelta(days=1)
        out["errors"] = []
        try:
            out["cmes"] = _cached(f"cmes-{day}", 24 * 3600, lambda: _cmes(start, end), disk=True)
        except FetchError as e:
            out["cmes"] = []
            out["errors"].append(f"CMEs: {e}")
        try:
            out["flares"] = _cached(f"flares-{day}", 24 * 3600, lambda: _flares_donki(when - timedelta(days=3), when + timedelta(days=1)), disk=True)
        except FetchError as e:
            out["flares"] = []
            out["errors"].append(f"Flares: {e}")
        out["xray"] = None
        out["regions"] = []
        out["proton"] = None
    out["nasa_key"] = _nasa_key() != "DEMO_KEY"
    return out
