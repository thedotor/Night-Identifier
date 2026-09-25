"""Real positions for the moons of Saturn, Uranus, Neptune and Pluto, from JPL Horizons.

astronomy-engine places the Moon and Jupiter's four big moons; everything else was drawn on a
circular orbit at an illustrative phase. Horizons publishes osculating orbital elements for every
moon relative to its planet, in the ecliptic J2000 frame the 3D scene uses. This fetches those over
1990-2060 at a spacing chosen so that each moon's fast precession has barely moved between rows
(inner moons: a couple of days; Iapetus: two months), and the frontend advances from the nearest
row. Outside that window, or before the data has loaded, the circular model is still used.

Cached for a year: these are published ephemerides, not measurements that change.
"""

import json
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.services import log_capture
from app.services.deepspace import FetchError, _http_get, _info_dir

logger = log_capture.get_logger("deepspace")

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
START = "1990-01-01"
STOP = "2060-01-01"
CACHE_MAX_AGE_S = 365 * 24 * 3600
CREDIT = "Moon positions: NASA/JPL Horizons"

# id -> (Horizons body id, planet's Horizons centre, step in days)
MOONS: dict[str, tuple[str, str, float]] = {
    "mimas": ("601", "500@699", 2),
    "enceladus": ("602", "500@699", 2),
    "tethys": ("603", "500@699", 3),
    "dione": ("604", "500@699", 4),
    "rhea": ("605", "500@699", 6),
    "titan": ("606", "500@699", 30),
    "iapetus": ("608", "500@699", 60),
    "miranda": ("705", "500@799", 2),
    "ariel": ("701", "500@799", 4),
    "umbriel": ("702", "500@799", 6),
    "titania": ("703", "500@799", 15),
    "oberon": ("704", "500@799", 20),
    "triton": ("801", "500@899", 15),
    "charon": ("901", "500@999", 5),
}


def _quote(v: str) -> str:
    return f"'{v}'"


def _fetch_moon(moon_id: str) -> dict[str, Any]:
    body, centre, step = MOONS[moon_id]
    params = {
        "format": "json",
        "COMMAND": _quote(body),
        "OBJ_DATA": _quote("NO"),
        "MAKE_EPHEM": _quote("YES"),
        "EPHEM_TYPE": _quote("ELEMENTS"),
        "CENTER": _quote(centre),
        "START_TIME": _quote(START),
        "STOP_TIME": _quote(STOP),
        "STEP_SIZE": _quote(f"{step:g}d"),
        "REF_PLANE": _quote("ECLIPTIC"),
        "REF_SYSTEM": _quote("ICRF"),
        "OUT_UNITS": _quote("AU-D"),
        "CSV_FORMAT": _quote("YES"),
    }
    raw, _ = _http_get(f"{HORIZONS}?{urllib.parse.urlencode(params)}", accept="application/json", timeout=180)
    text = json.loads(raw).get("result", "")
    if "$$SOE" not in text:
        raise FetchError(f"Horizons returned no ephemeris for {moon_id}")
    rows: list[list[float]] = []
    jd0: float | None = None
    for line in text.split("$$SOE", 1)[1].split("$$EOE", 1)[0].strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 12:
            continue
        try:
            jd = float(f[0])
            ec, inc, om, w, n, ma, a = float(f[2]), float(f[4]), float(f[5]), float(f[6]), float(f[8]), float(f[9]), float(f[11])
        except ValueError:
            continue
        if jd0 is None:
            jd0 = jd
        rows.append([round(ec, 7), round(inc, 5), round(om, 5), round(w, 5), round(n, 6), round(ma, 5), round(a, 10)])
    if not rows or jd0 is None:
        raise FetchError(f"no rows parsed for {moon_id}")
    return {"jd0": jd0, "step": step, "rows": rows}


def moon_elements() -> dict[str, Any]:
    """Element tables for every moon: {moons: {id: {jd0, step, rows: [[ec, i, om, w, n, ma, a]...]}}}.
    Rows are osculating elements (degrees, AU, degrees per day) in the ecliptic J2000 frame, relative to
    the planet. `offline: True` when nothing was cached and Horizons could not be reached."""
    cache = _info_dir() / "moon_elements.json"
    if cache.is_file():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - data.get("fetched_at", 0) < CACHE_MAX_AGE_S and data.get("moons"):
                return {**data, "offline": False}
        except (OSError, ValueError):
            pass
    moons: dict[str, Any] = {}

    def one(mid: str) -> None:
        try:
            moons[mid] = _fetch_moon(mid)
        except (FetchError, LookupError, ValueError) as e:
            logger.info("Deep Space: Horizons failed for %s (%s)", mid, e)

    with ThreadPoolExecutor(max_workers=2) as pool:  # Horizons is a shared public service: be gentle
        list(pool.map(one, MOONS))
    if len(moons) < len(MOONS) // 2:
        return {"moons": {}, "credit": CREDIT, "offline": True}
    data = {"fetched_at": time.time(), "moons": moons, "credit": CREDIT}
    cache.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return {**data, "offline": False}
