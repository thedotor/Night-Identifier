"""Wind and sea currents for the 3D Earth in Deep Space.

Both come from free public sources that need no sign-up. Each frame is turned into a small PNG "velocity
picture" (equirectangular, row 0 = north) that the renderer samples to move its particles:

* R = eastward speed, G = northward speed, both mapped from [-range, +range] m/s onto 0..255
* B = 255 where there is data, 0 where there is none (currents have no data on land)

Sources:

* Wind: NOAA's GFS weather model, 1 degree, from the NOAA open-data bucket on AWS. Each file has a text
  index beside it, so only the two fields wanted (east and north wind at one level) are downloaded, about
  150 KB. The fields are GRIB2 and are decoded with ecCodes. Analyses and forecasts every 3 hours, up to
  16 days ahead. Levels: 10 m above ground, and 850, 500 and 250 hPa (about 1.5, 5.5 and 10 km: the jet stream).
* Currents: HYCOM + NCODA global 1/12 degree analysis and forecast (HYCOM Consortium), surface velocity,
  hourly from about 9 days back to about 6 days ahead, read from its THREDDS OPeNDAP server with a stride
  so a whole-globe frame is about 2 MB. A model of the currents (with satellite and buoy data assimilated), not
  a live buoy feed.
"""

import io
import re
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from app.config import settings
from app.services import log_capture
from app.services.deepspace import USER_AGENT, FetchError

logger = log_capture.get_logger("flow")

GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
GFS_CREDIT = "Wind: NOAA GFS model (NOAA / NCEP), via the NOAA open-data programme on AWS"
# level id -> (name in GFS's index, strongest speed the picture can hold in m/s)
WIND_LEVELS: dict[str, tuple[str, float]] = {
    "10m": ("10 m above ground", 50.0),
    "850": ("850 mb", 60.0),
    "500": ("500 mb", 80.0),
    "250": ("250 mb", 120.0),
}
GFS_STEP_H = 3
GFS_MAX_FORECAST_H = 240  # the app shows about 10 days ahead
GFS_LAG_H = 5  # a cycle is complete on the bucket about 4.5 hours after its time
WIND_PAST_H = 24

HYCOM_URL = "https://tds.hycom.org/thredds/dodsC/GLBy0.08/latest"
HYCOM_CREDIT = "Currents: HYCOM + NCODA global analysis and forecast (HYCOM Consortium)"
HYCOM_STRIDE = 8
CURRENT_RANGE = 3.0
CURRENT_W, CURRENT_H = 720, 360
HYCOM_FILL = -1000.0  # the file's fill value is -30000

HOUR_MS = 3_600_000
HTTP_TIMEOUT_S = 90

_lock = threading.Lock()
_axis: dict[str, Any] = {"at": 0.0}
_cycle_hint: dict[str, Any] = {"at": 0.0, "ms": 0}


def _dir() -> Path:
    d = settings.deepspace_dir / "flow"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prune(prefix: str, keep: int) -> None:
    files = sorted(_dir().glob(f"{prefix}_*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError:
            pass


def _get(url: str, byte_range: tuple[int, int | None] | None = None, timeout: float = HTTP_TIMEOUT_S) -> bytes:
    """The body of a URL (or a byte range of it). LookupError on 404, FetchError on network trouble."""
    headers = {"User-Agent": USER_AGENT}
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{'' if byte_range[1] is None else byte_range[1]}"
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as resp:
                return resp.read(40 * 1024 * 1024)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):  # the bucket answers 403 for a key that does not exist
                raise LookupError(url) from e
            last = FetchError(f"HTTP {e.code} from {urllib.parse.urlsplit(url).netloc}")
            if e.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = FetchError(str(getattr(e, "reason", e)))
        time.sleep(1.0 * (attempt + 1))
    raise last if last is not None else FetchError("request failed")


def _png(u: np.ndarray, v: np.ndarray, valid: np.ndarray | None, vmax: float) -> bytes:
    """Pack east/north speeds (m/s, north row first) into the velocity picture."""

    def enc(a: np.ndarray) -> np.ndarray:
        return np.clip((np.nan_to_num(a) / vmax * 0.5 + 0.5) * 255.0 + 0.5, 0, 255).astype(np.uint8)

    ok = np.full(u.shape, 255, np.uint8) if valid is None else np.where(valid, 255, 0).astype(np.uint8)
    img = Image.fromarray(np.dstack([enc(u), enc(v), ok]), "RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------- wind


def _cycle_url(cycle_ms: int, fhour: int) -> str:
    t = time.gmtime(cycle_ms / 1000)
    return f"{GFS_BASE}/gfs.{time.strftime('%Y%m%d', t)}/{time.strftime('%H', t)}/atmos/gfs.t{time.strftime('%H', t)}z.pgrb2.1p00.f{fhour:03d}"


def _wind_grid(cycle_ms: int, fhour: int, level_name: str) -> tuple[np.ndarray, np.ndarray]:
    """East and north wind (m/s) on GFS's 1 degree grid, 181 rows from 90N to 90S by 360 columns from 0E."""
    import eccodes

    base = _cycle_url(cycle_ms, fhour)
    idx = _get(base + ".idx", timeout=30).decode("ascii", "replace").splitlines()
    rows = [ln.split(":") for ln in idx if ln]
    spans: dict[str, tuple[int, int | None]] = {}
    for i, r in enumerate(rows):
        if len(r) > 4 and r[3] in ("UGRD", "VGRD") and r[4] == level_name:
            start = int(r[1])
            end = int(rows[i + 1][1]) - 1 if i + 1 < len(rows) else None
            spans[r[3]] = (start, end)
    if len(spans) != 2:
        raise LookupError("the wind fields are not in that file")
    out: dict[str, np.ndarray] = {}
    for name, span in spans.items():
        body = _get(base, byte_range=span)
        handle = eccodes.codes_new_from_message(body)
        try:
            ni, nj = int(eccodes.codes_get(handle, "Ni")), int(eccodes.codes_get(handle, "Nj"))
            vals = np.asarray(eccodes.codes_get_values(handle), dtype=np.float32).reshape(nj, ni)
            if int(eccodes.codes_get(handle, "jScansPositively")):
                vals = vals[::-1]
        finally:
            eccodes.codes_release(handle)
        out[name] = vals
    return out["UGRD"], out["VGRD"]


def _latest_cycle(now_ms: int) -> int:
    """The newest GFS cycle (ms) that is complete on the bucket."""
    with _lock:
        if time.time() - _cycle_hint["at"] < 20 * 60 and _cycle_hint["ms"]:
            return int(_cycle_hint["ms"])
    six = 6 * HOUR_MS
    cycle = (now_ms - GFS_LAG_H * HOUR_MS) // six * six
    for _ in range(6):
        try:
            _get(_cycle_url(cycle, 0) + ".idx", timeout=20)
            with _lock:
                _cycle_hint.update(at=time.time(), ms=cycle)
            return cycle
        except LookupError:
            cycle -= six
    raise FetchError("no recent GFS run was found")


def wind_range_ms(now_ms: int | None = None) -> tuple[int, int]:
    now = int(time.time() * 1000) if now_ms is None else now_ms
    return now - WIND_PAST_H * HOUR_MS, now + GFS_MAX_FORECAST_H * HOUR_MS


def wind_frame(level: str, t_ms: int | None = None) -> tuple[bytes, dict[str, Any]]:
    """The wind picture for the 3-hour step nearest `t_ms` (default now). LookupError when that time is out of range."""
    if level not in WIND_LEVELS:
        raise LookupError("unknown wind level")
    level_name, vmax = WIND_LEVELS[level]
    now = int(time.time() * 1000)
    t = now if t_ms is None else t_ms
    lo, hi = wind_range_ms(now)
    if not lo <= t <= hi:
        raise LookupError("outside the wind data's dates")
    step = GFS_STEP_H * HOUR_MS
    valid = round(t / step) * step
    latest = _latest_cycle(now)
    # the newest run that has this time: the latest run, or an older one for a time before it
    cycle = latest if valid >= latest else valid // (6 * HOUR_MS) * (6 * HOUR_MS)
    fhour = int((valid - cycle) // HOUR_MS)
    if fhour > GFS_MAX_FORECAST_H:
        raise LookupError("outside the wind data's dates")
    name = f"wind{level}_{cycle // HOUR_MS}_{fhour:03d}"
    path = _dir() / f"{name}.png"
    if not path.is_file():
        u, v = _wind_grid(cycle, fhour, level_name)
        path.write_bytes(_png(u, v, None, vmax))
        _prune(f"wind{level}", 12)
        logger.info("Flow: wind %s for %s (run %s +%dh)", level, time.strftime("%Y-%m-%d %H:%M", time.gmtime(valid / 1000)), time.strftime("%d %H", time.gmtime(cycle / 1000)), fhour)
    return path.read_bytes(), {"valid": valid, "range": vmax, "first": lo, "last": hi, "credit": GFS_CREDIT, "lon0": 0.0}


# ---------------------------------------------------------------- currents


def _dap_floats(body: bytes) -> list[np.ndarray]:
    """The arrays in a DAP2 binary response (a Grid: the array, then its map vectors), in order."""
    marker = body.index(b"\nData:\n") + len(b"\nData:\n")
    header = body[:marker].decode("ascii", "replace")
    kinds = re.findall(r"(Float32|Float64)\s+\w+\[", header)
    pos = marker
    out: list[np.ndarray] = []
    for kind in kinds:
        n, n2 = struct.unpack(">II", body[pos : pos + 8])
        if n != n2:
            raise FetchError("could not read the current data")
        pos += 8
        width = 4 if kind == "Float32" else 8
        out.append(np.frombuffer(body[pos : pos + n * width], dtype=">f4" if width == 4 else ">f8").astype(np.float64))
        pos += n * width
    return out


def _hycom_time_axis() -> tuple[int, np.ndarray]:
    """The hourly time axis of the currents: (epoch ms of hour 0, hours array). Refreshed every 30 minutes."""
    with _lock:
        if time.time() - _axis["at"] < 30 * 60 and "hours" in _axis:
            return _axis["origin"], _axis["hours"]
    das = _get(HYCOM_URL + ".das", timeout=40).decode("utf-8", "replace")
    m = re.search(r"time1 \{.*?String units \"hours since (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)", das, re.S)
    if not m:
        raise FetchError("could not read the current data's time axis")
    y, mo, d, h, mi, s = (int(g) for g in m.groups())
    import calendar

    origin = calendar.timegm((y, mo, d, h, mi, s)) * 1000
    raw = _get(HYCOM_URL + ".ascii?time1", timeout=40).decode("ascii", "replace")
    if "\ntime1[" not in raw:
        raise FetchError("could not read the current data's time axis")
    body = raw.split("\ntime1[", 1)[1].split("\n", 1)[1]
    hours = np.array([float(x) for x in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", body.split("\n\n")[0])])
    with _lock:
        _axis.update(at=time.time(), origin=origin, hours=hours)
    return origin, hours


def currents_range_ms() -> tuple[int, int]:
    origin, hours = _hycom_time_axis()
    return int(origin + hours[0] * HOUR_MS), int(origin + hours[-1] * HOUR_MS)


def _hycom_component(var: str, index: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One surface velocity component, strided: (values [lat][lon] in m/s with NaN for land, lat axis, lon axis)."""
    s = HYCOM_STRIDE
    q = f"{var}[{index}:1:{index}][0:{s}:4250][0:{s}:4499]"
    body = _get(HYCOM_URL + ".dods?" + urllib.parse.quote(q, safe=":"), timeout=180)
    arrays = _dap_floats(body)
    if len(arrays) < 4:
        raise FetchError("the current data came back incomplete")
    lat, lon = arrays[2], arrays[3]
    vals = arrays[0].reshape(len(lat), len(lon))
    vals = np.where(vals < HYCOM_FILL, np.nan, vals)
    return vals, lat, lon


def currents_frame(t_ms: int | None = None) -> tuple[bytes, dict[str, Any]]:
    """The surface-current picture for the hour nearest `t_ms` (default now). LookupError when out of range."""
    now = int(time.time() * 1000)
    t = now if t_ms is None else t_ms
    origin, hours = _hycom_time_axis()
    lo, hi = int(origin + hours[0] * HOUR_MS), int(origin + hours[-1] * HOUR_MS)
    if not lo <= t <= hi:
        raise LookupError("outside the current data's dates")
    index = int(np.abs(origin + hours * HOUR_MS - t).argmin())
    valid = int(origin + hours[index] * HOUR_MS)
    name = f"currents_{valid // HOUR_MS}"
    path = _dir() / f"{name}.png"
    if not path.is_file():
        u, lat, lon = _hycom_component("ssu", index)
        v, _, _ = _hycom_component("ssv", index)
        # resample (nearest) onto a whole-globe grid: 0.5 degree cells, north row first, longitude from -180
        glat = 90.0 - (np.arange(CURRENT_H) + 0.5) * (180.0 / CURRENT_H)
        glon = -180.0 + (np.arange(CURRENT_W) + 0.5) * (360.0 / CURRENT_W)
        lon = np.where(lon > 180.0, lon - 360.0, lon)
        order = np.argsort(lon)
        lon, u, v = lon[order], u[:, order], v[:, order]
        ri = np.clip(np.round((glat - lat[0]) / (lat[1] - lat[0])).astype(int), 0, len(lat) - 1)
        ci = np.clip(np.searchsorted(lon, glon), 1, len(lon) - 1)
        ci = np.where(np.abs(lon[ci - 1] - glon) < np.abs(lon[ci] - glon), ci - 1, ci)
        gu, gv = u[np.ix_(ri, ci)], v[np.ix_(ri, ci)]
        inside = (glat >= lat[0] - 0.4) & (glat <= lat[-1] + 0.4)
        valid_mask = np.isfinite(gu) & np.isfinite(gv) & inside[:, None]
        path.write_bytes(_png(gu, gv, valid_mask, CURRENT_RANGE))
        _prune("currents", 8)
        logger.info("Flow: currents for %s", time.strftime("%Y-%m-%d %H:%M", time.gmtime(valid / 1000)))
    return path.read_bytes(), {"valid": valid, "range": CURRENT_RANGE, "first": lo, "last": hi, "credit": HYCOM_CREDIT, "lon0": -180.0}

