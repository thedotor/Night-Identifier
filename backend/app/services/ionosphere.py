"""Global ionospheric total electron content (TEC), from CODE's (Center for Orbit Determination in Europe,
University of Bern) daily Global Ionosphere Maps, in IONEX format.

This is the same underlying product NASA/JPL's CDDIS mirrors, but CDDIS needs an Earthdata login; CODE's own
S3-backed mirror at aiub.unibe.ch does not need any account, so that is used instead. The trade-off: this is
CODE's "final" combined solution, published about 5 days after the fact (not a live nowcast) - the map shown
is one representative recent day's data, hour-matched to the current UTC hour so at least the day/night TEC
bulge sits roughly where it should, not a real-time picture of today's ionosphere.

TEC drives GPS and HF radio propagation error: it rises with sunlight and solar activity and falls at night.
"""

import base64
import gzip
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.deepspace import FetchError, _http_get

BASE = "https://zhw-b.s3.cloud.switch.ch/aiub/CODE"
CREDIT = "Ionosphere (global TEC): CODE, Center for Orbit Determination in Europe, University of Bern (aiub.unibe.ch)."
CACHE_S = 4 * 3600.0
LAG_DAYS = range(4, 12)  # CODE's final GIM is usually published ~5 days after the fact
TECU_SCALE = 2  # byte = round(tecu * TECU_SCALE), clamped to 0..255 (so up to 127.5 TECU)

_mem: dict[str, tuple[float, Any]] = {}


def _fetch_ionex_text(day: datetime) -> str:
    year = day.year
    doy = day.timetuple().tm_yday
    url = f"{BASE}/{year}/COD0OPSFIN_{year}{doy:03d}0000_01D_01H_GIM.INX.gz"
    body, _ = _http_get(url, accept="application/gzip", attempts=2, timeout=40)
    return gzip.decompress(body).decode("ascii", errors="replace")


def _parse_ionex(text: str) -> dict[str, Any]:
    """{'lat1', 'dlat', 'lon1', 'dlon', 'n_lat', 'n_lon', 'maps': {hour: [[TECU,...] per lon, ...] per lat, north to south}}."""
    lines = text.splitlines()
    lat1 = lat2 = dlat = lon1 = lon2 = dlon = exponent = None
    header_end = 0
    for i, line in enumerate(lines):
        head = line[:60]
        if "LAT1 / LAT2 / DLAT" in line:
            lat1, lat2, dlat = (float(x) for x in head.split()[:3])
        elif "LON1 / LON2 / DLON" in line:
            lon1, lon2, dlon = (float(x) for x in head.split()[:3])
        elif "EXPONENT" in line:
            exponent = int(head.split()[0])
        elif "END OF HEADER" in line:
            header_end = i + 1
            break
    if lat1 is None or lon1 is None or exponent is None or dlat == 0 or dlon == 0:
        raise FetchError("IONEX header is missing the grid definition")
    n_lat = round((lat2 - lat1) / dlat) + 1
    n_lon = round((lon2 - lon1) / dlon) + 1
    scale = 10.0**exponent

    maps: dict[int, list[list[float]]] = {}
    i = header_end
    n = len(lines)
    while i < n:
        line = lines[i]
        if "START OF TEC MAP" in line:
            hour: int | None = None
            grid: list[list[float]] = []
            i += 1
            while i < n and "END OF TEC MAP" not in lines[i]:
                if "EPOCH OF CURRENT MAP" in lines[i]:
                    hour = int(lines[i][:60].split()[3])
                elif "LAT/LON1/LON2/DLON/H" in lines[i]:
                    # this row's header packs "<lat><lon1><lon2><dlon><h>" with no guaranteed spaces (e.g. "87.5-180.0"): fixed columns, not split()
                    row: list[float] = []
                    i += 1
                    while len(row) < n_lon and i < n:
                        row.extend(int(v) * scale for v in lines[i].split())
                        i += 1
                    grid.append(row)
                    continue
                i += 1
            if hour is not None and len(grid) == n_lat:
                maps[hour] = grid
        i += 1
    if not maps:
        raise FetchError("no TEC maps found in the IONEX file")
    return {"lat1": lat1, "dlat": dlat, "lon1": lon1, "dlon": dlon, "n_lat": n_lat, "n_lon": n_lon, "maps": maps}


def _find_recent_day() -> tuple[dict[str, Any], str]:
    now = datetime.now(timezone.utc)
    last_err: Exception | None = None
    for lag in LAG_DAYS:
        day = now - timedelta(days=lag)
        try:
            text = _fetch_ionex_text(day)
        except LookupError:
            continue
        except FetchError as e:
            last_err = e
            continue
        return _parse_ionex(text), day.strftime("%Y-%m-%d")
    raise last_err or FetchError("no recent CODE ionosphere map was found")


def _to_byte_grid(parsed: dict[str, Any], hour: int) -> dict[str, Any]:
    """Reorders CODE's north-to-south, -180..180 grid into south-to-north, 0..360-east columns (matching the aurora
    grid's convention, so the frontend shader can use the identical lon/lat -> uv formula), as a flat byte array."""
    maps = parsed["maps"]
    grid = maps.get(hour) or maps.get(min(maps, key=lambda h: abs(h - hour)))
    n_lat, n_lon = parsed["n_lat"], parsed["n_lon"]
    zero_lon_idx = round((0 - parsed["lon1"]) / parsed["dlon"])
    width = n_lon - 1  # the last column duplicates the first (a full 360 deg wrap)
    height = n_lat
    out = bytearray(width * height)
    rows_south_to_north = list(reversed(grid))  # CODE stores north (lat1) first; south-to-north matches the aurora convention
    for r, row in enumerate(rows_south_to_north):
        reordered = row[zero_lon_idx:] + row[1:zero_lon_idx]
        for c in range(width):
            out[r * width + c] = max(0, min(255, round(reordered[c] * TECU_SCALE)))
    return {"width": width, "height": height}, bytes(out)


def grid() -> dict[str, Any]:
    now = time.time()
    hit = _mem.get("day")
    if not hit or now - hit[0] > CACHE_S:
        try:
            parsed, day = _find_recent_day()
            hit = (now, {"parsed": parsed, "day": day})
            _mem["day"] = hit
        except FetchError:
            if not hit:
                raise
    parsed, day = hit[1]["parsed"], hit[1]["day"]
    hour = datetime.now(timezone.utc).hour
    dims, raw = _to_byte_grid(parsed, hour)
    return {
        "width": dims["width"],
        "height": dims["height"],
        "data": base64.b64encode(raw).decode("ascii"),
        "tecu_scale": TECU_SCALE,
        "day": day,
        "hour": hour,
        "credit": CREDIT,
    }
