"""Orbits of the small bodies drawn in the Deep Space solar-system view.

Everything comes from JPL's Small-Body Database and is cached on disk for a month, so the view
works offline once it has been opened (or the offline pack downloaded). Elements are normalised to
what the renderer needs: semi-major axis `a` (AU), eccentricity `e`, inclination `i`, node `om`,
argument of perihelion `w` (degrees, ecliptic J2000), perihelion time `tp` (Julian date) and
period `per` (days). JPL publishes them to only ~3-4 significant figures, which is far finer than a
picture of a solar system needs but not enough for pointing a telescope.

The planets, Pluto and the big moons are NOT here: the frontend computes those itself.
"""

import json
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _info_dir

logger = log_capture.get_logger("deepspace")

SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
SBDB_QUERY = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
CACHE_MAX_AGE_S = 30 * 24 * 3600

# (kind, SBDB designation, display name). Numbers rather than names so each lookup is unambiguous.
NOTABLE: list[tuple[str, str, str]] = [
    ("dwarf", "1", "Ceres"),
    ("dwarf", "136199", "Eris"),
    ("dwarf", "136108", "Haumea"),
    ("dwarf", "136472", "Makemake"),
    ("dwarf", "225088", "Gonggong"),
    ("dwarf", "90377", "Sedna"),
    ("dwarf", "50000", "Quaoar"),
    ("dwarf", "90482", "Orcus"),
    ("asteroid", "4", "Vesta"),
    ("asteroid", "2", "Pallas"),
    ("asteroid", "3", "Juno"),
    ("asteroid", "10", "Hygiea"),
    ("asteroid", "16", "Psyche"),
    ("asteroid", "433", "Eros"),
    ("asteroid", "99942", "Apophis"),
    ("asteroid", "101955", "Bennu"),
    ("asteroid", "162173", "Ryugu"),
    ("asteroid", "25143", "Itokawa"),
    ("comet", "1P", "Halley"),
    ("comet", "2P", "Encke"),
    ("comet", "67P", "67P/Churyumov-Gerasimenko"),
    ("comet", "109P", "Swift-Tuttle"),
    ("comet", "12P", "Pons-Brooks"),
    ("comet", "55P", "Tempel-Tuttle"),
    ("comet", "21P", "Giacobini-Zinner"),
    ("comet", "46P", "Wirtanen"),
    ("comet", "81P", "Wild 2"),
    ("comet", "19P", "Borrelly"),
    ("comet", "103P", "Hartley 2"),
    ("comet", "17P", "Holmes"),
    ("comet", "C/1995 O1", "Hale-Bopp"),
    ("comet", "C/2020 F3", "NEOWISE"),
    # Meteor-shower parent bodies not already covered above (Perseids/109P, Leonids/55P, Eta Aquariids
    # + Orionids/1P, Draconids/21P, and both Taurids/2P are already in the list): see meteorStreamData.ts
    # on the frontend for which shower maps to which of these.
    ("asteroid", "3200", "Phaethon"),
    ("asteroid", "2003 EH1", "2003 EH1"),
    ("comet", "8P", "Tuttle"),
    ("comet", "96P", "Machholz"),
    ("comet", "C/1861 G1", "Thatcher"),
]

# Population clouds: (key, SBDB class, how many). "First N numbered" is as good a sample as any
# for showing where a belt sits.
CLOUDS: list[tuple[str, str, int]] = [("belt", "MBA", 2500), ("trojans", "TJN", 700), ("kuiper", "TNO", 1200)]


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def _elements(kind: str, name: str, des: str) -> dict[str, Any] | None:
    data = _get_json(f"{SBDB}?{urllib.parse.urlencode({'sstr': des, 'phys-par': 1})}")
    if not data or "orbit" not in data:
        return None
    el = {e["name"]: _num(e.get("value")) for e in data["orbit"]["elements"]}
    a, e, i, om, w, tp, per = (el.get(k) for k in ("a", "e", "i", "om", "w", "tp", "per"))
    if None in (a, e, i, om, w, tp, per) or e >= 1 or per <= 0:
        return None  # parabolic / hyperbolic: no closed orbit to draw
    diameter = next((_num(p.get("value")) for p in data.get("phys_par", []) if p.get("name") == "diameter"), None)
    return {
        "id": des.lower().replace("/", "").replace(" ", ""),
        "name": name,
        "full_name": data["object"].get("fullname", name),
        "kind": kind,
        "a": a,
        "e": e,
        "i": i,
        "om": om,
        "w": w,
        "tp": tp,
        "per": per,
        "diameter_km": diameter,
    }


def _cloud(sb_class: str, limit: int) -> list[list[float]]:
    query = urllib.parse.urlencode({"fields": "a,e,i,om,w,tp,per", "sb-kind": "a", "sb-class": sb_class, "limit": limit})
    data = _get_json(f"{SBDB_QUERY}?{query}")
    rows: list[list[float]] = []
    for r in (data or {}).get("data", []):
        v = [_num(x) for x in r]
        if None in v or v[1] >= 1 or v[6] <= 0:
            continue
        rows.append([round(x, 5) for x in v])  # a, e, i, om, w, tp, per
    return rows


def _fetch() -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=3) as pool:
        notable = list(pool.map(lambda t: _safe(lambda: _elements(t[0], t[2], t[1])), NOTABLE))
        clouds = list(pool.map(lambda c: _safe(lambda: _cloud(c[1], c[2])) or [], CLOUDS))
    bodies = [b for b in notable if b]
    if not bodies:
        raise FetchError("JPL returned no bodies")
    return {
        "fetched_at": time.time(),
        "bodies": bodies,
        "clouds": {key: rows for (key, _c, _n), rows in zip(CLOUDS, clouds)},
        "credit": "Orbital elements: NASA/JPL Small-Body Database",
    }


def _safe(fn):  # type: ignore[no-untyped-def]
    """One failed lookup should not lose the other 40: log it and move on."""
    try:
        return fn()
    except (FetchError, LookupError) as e:
        logger.info("Deep Space: SBDB lookup failed (%s)", e)
        return None


def orbit_data() -> dict[str, Any]:
    """Cached small-body orbits; refreshed monthly. `offline` is set when nothing (not even a stale
    cache) could be loaded."""
    cache = _info_dir() / "orbits.json"
    stale: dict[str, Any] | None = None
    if cache.is_file():
        try:
            stale = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - stale.get("fetched_at", 0) < CACHE_MAX_AGE_S:
                return {**stale, "offline": False}
        except (OSError, ValueError):
            stale = None
    try:
        fresh = _fetch()
    except FetchError as e:
        logger.info("Deep Space: could not refresh orbits (%s)", e)
        if stale is not None:
            return {**stale, "offline": False, "stale": True}
        return {"bodies": [], "clouds": {}, "credit": "", "offline": True}
    cache.write_text(json.dumps(fresh), encoding="utf-8")
    return {**fresh, "offline": False}
