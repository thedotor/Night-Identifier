"""Deep Space beyond the solar system: real distances for the 3D star, galaxy and Local Group views.

* stars      ~38,000 Hipparcos stars with parallaxes and proper motions (everything within ~500 light-years
             plus the naked-eye stars farther out, and every star the constellation figures use), from VizieR I/239
* hosts      stars with confirmed planets, from the NASA Exoplanet Archive
* distances  distance to each catalogue deep-sky object: the median of SIMBAD's published
             measurements for it (objects SIMBAD has no distance for are simply absent)
* local group  McConnachie (2012), 102 galaxies in and around the Local Group, VizieR J/AJ/144/4

Each dataset is fetched once, cached on disk for 90 days and included in the offline pack. A dataset
that cannot be fetched (and has no cache) comes back with `offline: True` and nothing else breaks.
"""

import json
import math
import re
import time
import urllib.parse
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import numpy as np

from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _info_dir

logger = log_capture.get_logger("deepspace")

VIZIER = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
EXOPLANETS = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
SIMBAD = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
CACHE_MAX_AGE_S = 90 * 24 * 3600
TAP_TIMEOUT_S = 120
SIMBAD_CHUNK = 120

_CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "data" / "sky" / "catalogue.json"

CREDITS = {
    "stars3": "Star distances and motions: Hipparcos (ESA 1997; re-reduction by van Leeuwen 2007 for bright stars) via VizieR/CDS",
    "hosts": "Exoplanet hosts: NASA Exoplanet Archive",
    "systems": "Planetary systems: NASA Exoplanet Archive",
    "distances": "Distances: SIMBAD, CDS Strasbourg (median of published measurements)",
    "localgroup": "Local Group galaxies: McConnachie (2012), AJ 144, 4, via VizieR/CDS",
    "galaxies3": "Galaxy positions and redshifts: 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26) via VizieR/CDS",
    "galaxytypes": "Galaxy shapes: SIMBAD, CDS Strasbourg (morphological types)",
}


@lru_cache(maxsize=1)
def _catalogue() -> dict[str, Any]:
    return json.loads(_CATALOGUE_PATH.read_text(encoding="utf-8"))


def _tap(base: str, adql: str, **extra: str) -> Any:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql, **extra}
    data = _get_json(f"{base}?{urllib.parse.urlencode(params)}", timeout=TAP_TIMEOUT_S)
    if data is None:
        raise FetchError("query not found")
    return data


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _cached(name: str, fetch: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Cached dataset, refreshed every 90 days; falls back to a stale copy, then to `offline`."""
    cache = _info_dir() / f"galaxy_{name}.json"
    stale: dict[str, Any] | None = None
    if cache.is_file():
        try:
            stale = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - stale.get("fetched_at", 0) < CACHE_MAX_AGE_S:
                return {**stale, "offline": False}
        except (OSError, ValueError):
            stale = None
    try:
        fresh = {**fetch(), "fetched_at": time.time(), "credit": CREDITS[name]}
    except FetchError as e:
        logger.info("Deep Space: could not fetch %s (%s)", name, e)
        if stale is not None:
            return {**stale, "offline": False, "stale": True}
        return {"credit": CREDITS[name], "offline": True}
    cache.write_text(json.dumps(fresh, separators=(",", ":")), encoding="utf-8")
    return {**fresh, "offline": False}


# ---------- stars ----------


def _match_points(
    qra: np.ndarray, qdec: np.ndarray, qmag: np.ndarray, ra: np.ndarray, dec: np.ndarray, mag: np.ndarray, tol_deg: float, dmag: float
) -> np.ndarray:
    """For each query point, the index of the nearest row within `tol_deg` and `dmag` magnitudes, or -1."""
    out = np.full(len(qra), -1, dtype=np.int64)
    cos_c = np.cos(np.radians(dec))
    for lo in range(0, len(qra), 1500):
        hi = min(lo + 1500, len(qra))
        dra = (qra[lo:hi, None] - ra[None, :] + 180.0) % 360.0 - 180.0
        dde = qdec[lo:hi, None] - dec[None, :]
        d2 = (dra * cos_c[None, :]) ** 2 + dde**2
        d2 = np.where(np.abs(qmag[lo:hi, None] - mag[None, :]) < dmag, d2, np.inf)
        best = np.argmin(d2, axis=1)
        ok = d2[np.arange(hi - lo), best] < tol_deg**2
        out[lo:hi] = np.where(ok, best, -1)
    return out


def _match_catalogue(ra: np.ndarray, dec: np.ndarray, vmag: np.ndarray) -> np.ndarray:
    """Index of the app's own catalogue star each Hipparcos row is, or -1. The catalogue drives the
    star names, so 3D stars must carry the same identity."""
    raw = np.asarray(_catalogue()["stars"], dtype=np.float64).reshape(-1, 3)
    return _match_points(ra, dec, vmag, raw[:, 0], raw[:, 1], raw[:, 2], 0.06, 0.8)  # 0.06 deg: Hipparcos epoch vs J2000 motion


_STAR_COLUMNS = 'HIP, RAICRS, DEICRS, Plx, Vmag, "B-V", pmRA, pmDE, e_Plx'


def _star_rows(where: str) -> tuple[list[list[float]], list[int]]:
    """Rows of [ra, dec, plx, vmag, b-v, pmra, pmde, e_plx] and the parallel list of Hipparcos numbers."""
    rows = _tap(VIZIER, f'SELECT {_STAR_COLUMNS} FROM "I/239/hip_main" WHERE {where}').get("data", [])
    out: list[list[float]] = []
    hips: list[int] = []
    for r in rows:
        if None in (r[0], r[1], r[2], r[4]):
            continue
        plx = float(r[3])
        out.append([float(r[1]), float(r[2]), plx, float(r[4]), float(r[5]) if r[5] is not None else 0.6, float(r[6] or 0.0), float(r[7] or 0.0), float(r[8]) if r[8] is not None else abs(plx) * 0.5])
        hips.append(int(r[0]))
    return out, hips


def _hip2() -> dict[int, tuple[float, float, float, float]]:
    """The Hipparcos re-reduction (van Leeuwen 2007): for bright stars its parallaxes are about four times
    as precise as the original catalogue's, which is what decides where a constellation's stars really are."""
    rows = _tap(VIZIER, 'SELECT HIP, Plx, e_Plx, pmRA, pmDE FROM "I/311/hip2" WHERE Hpmag <= 6.8').get("data", [])
    return {int(h): (float(p), float(e), float(a or 0.0), float(d or 0.0)) for h, p, e, a, d in rows if None not in (h, p, e)}


def _improve(rows: list[list[float]], hips: list[int], hip2: dict[int, tuple[float, float, float, float]]) -> None:
    for r, h in zip(rows, hips):
        better = hip2.get(h)
        if better is not None:
            r[2], r[7], r[5], r[6] = better[0], better[1], better[2], better[3]


def _figures():  # type: ignore[no-untyped-def]
    from app.data.asterisms import ASTERISMS
    from app.data.constellations import CONSTELLATIONS

    return [(c, kind) for shapes, kind in ((CONSTELLATIONS, "constellation"), (ASTERISMS, "asterism")) for c in shapes]


def _fetch_stars() -> dict[str, Any]:
    base, base_hips = _star_rows("(Plx >= 6.5 AND Plx/e_Plx >= 5) OR (Vmag <= 6 AND Plx >= 0.5 AND Plx/e_Plx >= 2)")
    if len(base) < 1000:
        raise FetchError("too few stars returned")
    hip2 = _hip2()
    _improve(base, base_hips, hip2)
    # Naked-eye stars whose parallax is too uncertain for the sample above are still what the
    # constellation figures are made of: get them too, and keep only those a figure uses.
    extra, extra_hips = _star_rows("Vmag <= 6.5")
    _improve(extra, extra_hips, hip2)
    seen = {(round(r[0], 3), round(r[1], 3)) for r in base}
    extra = [r for r in extra if (round(r[0], 3), round(r[1], 3)) not in seen]
    allrows = np.array(base + extra, dtype=np.float64)

    figures = _figures()
    fs = [(fi, si, s) for fi, (c, _k) in enumerate(figures) for si, s in enumerate(c.stars)]
    qra = np.array([s.ra_deg % 360.0 for _fi, _si, s in fs])
    qde = np.array([s.dec_deg for _fi, _si, s in fs])
    qmg = np.array([s.mag for _fi, _si, s in fs])
    hit = _match_points(qra, qde, qmg, allrows[:, 0], allrows[:, 1], allrows[:, 3], 0.08, 1.0)
    used_extra = {int(h) for h in hit if h >= len(base)}
    keep = list(range(len(base))) + sorted(used_extra)
    remap = {old: new for new, old in enumerate(keep)}
    a = allrows[keep]

    idx = _match_catalogue(a[:, 0], a[:, 1], a[:, 3])
    names = _catalogue()["star_names"]
    named = [[i, names[str(int(c))], int(c)] for i, c in enumerate(idx) if c >= 0 and str(int(c)) in names]
    stars = [
        [round(r[0], 4), round(r[1], 4), round(r[2], 2), round(r[3], 2), round(r[4], 2), int(c), round(r[5], 1), round(r[6], 1), round(r[7], 2)]
        for r, c in zip(a.tolist(), idx.tolist())
    ]
    rows_of: dict[int, list[int]] = {}
    for (fi, si, _s), h in zip(fs, hit.tolist()):
        rows_of.setdefault(fi, []).append(remap.get(int(h), -1) if h >= 0 else -1)
    out_figs = [
        {"abbr": c.abbr, "name": c.name, "kind": kind, "rows": rows_of.get(fi, []), "lines": [[x, y] for x, y in c.lines]}
        for fi, (c, kind) in enumerate(figures)
    ]
    return {"stars": stars, "named": named, "figures": out_figs}


def stars() -> dict[str, Any]:
    return _cached("stars3", _fetch_stars)


# ---------- exoplanet hosts ----------


def _fetch_hosts() -> dict[str, Any]:
    # Every parameter set, not only the default one: a star's distance may only appear in another.
    query = "select distinct hostname,ra,dec,sy_dist,sy_plx,sy_pnum,sy_vmag from ps"
    data = _get_json(f"{EXOPLANETS}?{urllib.parse.urlencode({'query': query, 'format': 'json'})}", timeout=TAP_TIMEOUT_S)
    if not data:
        raise FetchError("no exoplanet hosts returned")
    by_host: dict[str, list[Any]] = {}
    unknown: dict[str, list[Any]] = {}
    for h in data:
        ra, dec = _num(h.get("ra")), _num(h.get("dec"))
        if ra is None or dec is None:
            continue
        name = h["hostname"]
        d = _num(h.get("sy_dist"))
        if d is None or d <= 0:
            plx = _num(h.get("sy_plx"))
            d = 1000.0 / plx if plx and plx > 0.05 else None
        row = [round(ra, 4), round(dec, 4), None, int(h.get("sy_pnum") or 1), _num(h.get("sy_vmag")), name]
        if d is not None and d > 0:
            if name not in by_host:  # one row per star
                by_host[name] = row
                row[2] = round(d, 2)
        else:
            unknown.setdefault(name, row)
    # The archive has no distance at all for about a hundred hosts (TRAPPIST-1 among them): SIMBAD usually has a parallax.
    todo = [n for n in unknown if n not in by_host]
    for lo in range(0, len(todo), SIMBAD_CHUNK):
        chunk = todo[lo : lo + SIMBAD_CHUNK]
        quoted = ",".join("'" + n.replace("'", "''") + "'" for n in chunk)
        adql = f"SELECT i.id, b.plx_value FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE i.id IN ({quoted}) AND b.plx_value > 0.05"
        try:
            for ident, plx in _tap(SIMBAD, adql).get("data", []):
                key = next((n for n in chunk if n.lower() == " ".join(str(ident).split()).lower()), None)
                if key and key in unknown and key not in by_host and plx:
                    row = unknown[key]
                    row[2] = round(1000.0 / float(plx), 2)
                    by_host[key] = row
        except FetchError as e:
            logger.info("Deep Space: SIMBAD parallax lookup failed (%s)", e)
    return {"hosts": list(by_host.values())}


def hosts() -> dict[str, Any]:
    return _cached("hosts", _fetch_hosts)


# ---------- planetary systems ----------


def _fetch_systems() -> dict[str, Any]:
    query = (
        "select pl_name,hostname,pl_orbsmax,pl_orbeccen,pl_orbper,pl_rade,pl_bmasse,disc_year,discoverymethod,st_rad,st_mass,st_teff "
        "from ps where default_flag=1"
    )
    data = _get_json(f"{EXOPLANETS}?{urllib.parse.urlencode({'query': query, 'format': 'json'})}", timeout=TAP_TIMEOUT_S)
    if not data:
        raise FetchError("no planets returned")
    systems: dict[str, dict[str, Any]] = {}
    for r in data:
        host = r.get("hostname")
        per = _num(r.get("pl_orbper"))
        mass = _num(r.get("st_mass"))
        a = _num(r.get("pl_orbsmax"))
        if a is None and per and mass:
            a = (mass * (per / 365.25) ** 2) ** (1.0 / 3.0)  # Kepler's third law, a in AU
        if not host or not a or a <= 0:
            continue
        sys_ = systems.setdefault(host, {"star": [_num(r.get("st_rad")), mass, _num(r.get("st_teff"))], "planets": []})
        if sys_["star"][0] is None:
            sys_["star"][0] = _num(r.get("st_rad"))
        if sys_["star"][2] is None:
            sys_["star"][2] = _num(r.get("st_teff"))
        e = _num(r.get("pl_orbeccen"))
        sys_["planets"].append(
            [
                r["pl_name"],
                round(a, 6),
                round(min(max(e or 0.0, 0.0), 0.95), 3),
                round(per, 4) if per else None,
                _num(r.get("pl_rade")),
                _num(r.get("pl_bmasse")),
                r.get("disc_year"),
                r.get("discoverymethod"),
            ]
        )
    return {"systems": systems}


def systems() -> dict[str, Any]:
    return _cached("systems", _fetch_systems)


# ---------- deep-sky object distances ----------

_TO_PC = {"pc": 1.0, "kpc": 1e3, "mpc": 1e6, "gpc": 1e9}


def _simbad_id(dso_id: str) -> str | None:
    m = re.fullmatch(r"M\s*0*(\d+)", dso_id.strip())
    if m:
        return f"M {int(m.group(1))}"
    m = re.fullmatch(r"(NGC|IC)\s*0*(\d+)(\w*)", dso_id.strip())
    if m:
        return f"{m.group(1)} {int(m.group(2))}{m.group(3)}"
    return None


def _fetch_distances() -> dict[str, Any]:
    by_simbad: dict[str, str] = {}
    for d in _catalogue()["dsos"]:
        sid = _simbad_id(d["id"])
        if sid:
            by_simbad[sid] = d["id"]
    ids = list(by_simbad)
    samples: dict[str, list[float]] = {}
    for lo in range(0, len(ids), SIMBAD_CHUNK):
        chunk = ids[lo : lo + SIMBAD_CHUNK]
        quoted = ",".join("'" + i.replace("'", "''") + "'" for i in chunk)
        adql = (
            "SELECT i.id, d.dist, d.unit FROM ident AS i JOIN basic AS b ON b.oid = i.oidref "
            f"JOIN mesDistance AS d ON d.oidref = b.oid WHERE i.id IN ({quoted})"
        )
        for sid, dist, unit in _tap(SIMBAD, adql).get("data", []):
            v = _num(dist)
            f = _TO_PC.get(str(unit).strip().lower())
            if v is None or f is None or v <= 0:
                continue
            samples.setdefault(" ".join(str(sid).split()), []).append(v * f)
    out: dict[str, Any] = {}
    for sid, vals in samples.items():
        key = by_simbad.get(sid)
        if key:
            vals.sort()
            out[key] = {"d_pc": float(np.median(vals)), "n": len(vals), "lo": vals[0], "hi": vals[-1]}
    if not out:
        raise FetchError("SIMBAD returned no distances")
    return {"distances": out}


def distances() -> dict[str, Any]:
    return _cached("distances", _fetch_distances)


# ---------- Local Group ----------


def _fetch_local_group() -> dict[str, Any]:
    adql = 'SELECT "Name", "SubG", "MType", "RAJ2000", "DEJ2000", "D", "Vmag", "R1", "PA", "Ell" FROM "J/AJ/144/4/catalog" WHERE "D" IS NOT NULL'
    galaxies = []
    for name, sub, mtype, ra, dec, d, vmag, r1, pa, ell in _tap(VIZIER, adql).get("data", []):
        if None in (ra, dec, d):
            continue
        galaxies.append(
            {
                "name": str(name).strip(),
                "group": str(sub).strip(),
                "type": str(mtype).strip(),
                "ra": round(ra, 4),
                "dec": round(dec, 4),
                "d_kpc": round(d, 3),
                "vmag": _num(vmag),
                "rh_arcmin": _num(r1),
                "pa": _num(pa),
                "ell": _num(ell),
            }
        )
    if not galaxies:
        raise FetchError("no Local Group galaxies returned")
    return {"galaxies": galaxies}


def local_group() -> dict[str, Any]:
    return _cached("localgroup", _fetch_local_group)


# ---------- galaxies beyond the Local Group ----------

_2MRS = '"J/ApJS/199/26/table3"'


def _t_code(raw: Any) -> tuple[int, int]:
    """(RC3 morphological type T, bar flag) from 2MRS's type field, e.g. ' 3A2s' -> (3, 0), '-2B_P' -> (-2, 1).
    T is -5..-1 for ellipticals and lenticulars, 0..9 for spirals (Sa to Sm), 10 for irregulars; 99 when unknown."""
    text = str(raw or "")
    try:
        t = int(text[:2])
    except ValueError:
        return 99, 0
    if t >= 98 or t < -6:
        return 99, 0
    return t, 1 if text[2:3] in ("B", "X") else 0


def _fetch_galaxies3d() -> dict[str, Any]:
    adql = f'SELECT "RAJ2000", "DEJ2000", "Ktmag", "cz", "Riso", "b/a", "type" FROM {_2MRS} WHERE "cz" IS NOT NULL AND "Ktmag" IS NOT NULL'
    rows: list[list[float | int]] = []
    for ra, dec, kt, cz, riso, ba, typ in _tap(VIZIER, adql).get("data", []):
        if None in (ra, dec, kt, cz):
            continue
        t, bar = _t_code(typ)
        r, b = _num(riso), _num(ba)
        # ra, dec (deg), heliocentric velocity (km/s), total K magnitude, log10 of the isophotal radius in arcsec (-1: none),
        # axis ratio b/a (-1: none), RC3 type T (99: unknown), bar flag
        rows.append([round(ra, 5), round(dec, 5), int(cz), round(kt, 2), round(r, 2) if r is not None else -1, round(b, 2) if b is not None else -1, t, bar])
    if len(rows) < 1000:
        raise FetchError("the galaxy survey came back nearly empty")
    return {"columns": ["ra", "dec", "cz", "kt", "logr", "ba", "t", "bar"], "rows": rows}


def galaxies3d() -> dict[str, Any]:
    return _cached("galaxies3", _fetch_galaxies3d)


def _fetch_galaxy_types() -> dict[str, Any]:
    by_simbad: dict[str, str] = {}
    for d in _catalogue()["dsos"]:
        sid = _simbad_id(d["id"])
        if sid:
            by_simbad[sid] = d["id"]
    ids = list(by_simbad)
    out: dict[str, str] = {}
    for lo in range(0, len(ids), SIMBAD_CHUNK):
        chunk = ids[lo : lo + SIMBAD_CHUNK]
        quoted = ",".join("'" + i.replace("'", "''") + "'" for i in chunk)
        adql = f"SELECT i.id, b.morph_type FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE i.id IN ({quoted}) AND b.morph_type IS NOT NULL"
        for sid, morph in _tap(SIMBAD, adql).get("data", []):
            key = by_simbad.get(" ".join(str(sid).split()))
            if key and str(morph).strip():
                out[key] = str(morph).strip()
    if not out:
        raise FetchError("SIMBAD returned no galaxy types")
    return {"types": out}


def galaxy_types() -> dict[str, Any]:
    return _cached("galaxytypes", _fetch_galaxy_types)


def fetch_all() -> bool:
    """Everything, for the offline pack. True if every dataset is available."""
    return all(not fn()["offline"] for fn in (stars, hosts, systems, distances, local_group, galaxies3d, galaxy_types))
