"""Satellite orbit data for the sky overlays: CelesTrak general-perturbation (GP) elements.

The frontend does the orbit maths (SGP4, via satellite.js); this module only downloads the
elements, trims them to what SGP4 needs, and caches them on disk so the overlays keep working
offline on the last download.

Elements come as JSON (OMM), not classic two-line text: catalogue numbers have passed 99999, which
the TLE format cannot hold.

CelesTrak asks clients to fetch a data set at most once every two hours, so a data set younger
than MIN_REFETCH_S is never fetched again, and a failed attempt is not repeated for
RETRY_AFTER_FAIL_S. Data older than STALE_AFTER_S is refreshed on the next request; if that fails
the old copy is served and flagged `stale`.

Groups (what the UI offers) map to bits in each row's last column:
  1 stations (ISS, Tiangong and what docks with them)   <- CelesTrak "stations"
  16 the International Space Station itself (NORAD 25544), on its own so it can be ticked alone
  2 bright / naked-eye                                   <- CelesTrak "visual"
  4 Starlink                                             <- name starts with STARLINK, from "active"
  8 every other active satellite                         <- "active"
"""

import json
import threading
import time
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _http_get

logger = log_capture.get_logger("satellites")

CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php"
CREDIT = "Orbital elements: CelesTrak (celestrak.org), computed with SGP4"

MIN_REFETCH_S = 2 * 3600
STALE_AFTER_S = 6 * 3600
RETRY_AFTER_FAIL_S = 10 * 60
RETRY_AFTER_LIMITED_S = 30 * 60  # CelesTrak said "not yet"; asking again sooner only annoys it
HTTP_TIMEOUT_S = 90

GROUP_BITS = {"stations": 1, "visual": 2, "starlink": 4, "active": 8, "iss": 16}
ISS_NORAD = 25544  # ZARYA, the ISS's main module: the ISS's own orbit (the other modules share it)
# Which CelesTrak data set each UI group needs (starlink and the rest of the active set share one).
DATASET_OF_GROUP = {"stations": "stations", "visual": "visual", "starlink": "active", "active": "active", "iss": "stations"}

FIELDS = [
    "norad", "name", "intl", "epoch", "mean_motion", "ecc", "incl", "raan",
    "argp", "mean_anomaly", "bstar", "ndot", "nddot", "revs", "elset", "flags",
]

_locks: dict[str, threading.Lock] = {}
_last_fail: dict[str, float] = {}
_last_error: dict[str, str] = {}  # why the latest download attempt failed, for the UI
_memory: dict[str, dict[str, Any]] = {}  # parsed cache files, so a request does not re-read megabytes


def _dir() -> Path:
    d = settings.deepspace_dir / "satellites"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(dataset: str) -> Path:
    return _dir() / f"{dataset}.json"


def _lock(dataset: str) -> threading.Lock:
    return _locks.setdefault(dataset, threading.Lock())


def _row(o: dict[str, Any], flags: int) -> list[Any] | None:
    """One CelesTrak OMM object -> the compact row the frontend rebuilds a satellite from."""
    try:
        return [
            int(o["NORAD_CAT_ID"]),
            str(o.get("OBJECT_NAME") or o["NORAD_CAT_ID"]).strip(),
            str(o.get("OBJECT_ID") or ""),
            str(o["EPOCH"]),
            float(o["MEAN_MOTION"]),
            float(o["ECCENTRICITY"]),
            float(o["INCLINATION"]),
            float(o["RA_OF_ASC_NODE"]),
            float(o["ARG_OF_PERICENTER"]),
            float(o["MEAN_ANOMALY"]),
            float(o.get("BSTAR") or 0.0),
            float(o.get("MEAN_MOTION_DOT") or 0.0),
            float(o.get("MEAN_MOTION_DDOT") or 0.0),
            int(o.get("REV_AT_EPOCH") or 0),
            int(o.get("ELEMENT_SET_NO") or 0),
            flags,
        ]
    except (KeyError, TypeError, ValueError):
        return None


def _fetch(dataset: str) -> list[list[Any]]:
    url = f"{CELESTRAK}?GROUP={dataset}&FORMAT=json"
    body, _ = _http_get(url, accept="application/json", timeout=HTTP_TIMEOUT_S)
    try:
        objs = json.loads(body)
    except ValueError as e:
        raise FetchError("CelesTrak sent something that is not JSON") from e
    if not isinstance(objs, list):
        # CelesTrak answers 200 with a text message when a group is unknown or it is rate-limiting.
        raise FetchError(str(objs)[:120])
    rows: list[list[Any]] = []
    for o in objs:
        if not isinstance(o, dict):
            continue
        base = GROUP_BITS[dataset] if dataset != "active" else 0
        r = _row(o, base)
        if r is None:
            continue
        if dataset == "active":
            r[-1] = GROUP_BITS["starlink"] if r[1].upper().startswith("STARLINK") else GROUP_BITS["active"]
        rows.append(r)
    if not rows:
        raise FetchError("CelesTrak returned no satellites")
    return rows


def _load_cache(dataset: str) -> dict[str, Any] | None:
    p = _path(dataset)
    cached = _memory.get(dataset)
    if cached is not None and cached.get("mtime") == (p.stat().st_mtime if p.is_file() else None):
        return cached
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not data.get("rows"):
            return None
        data["mtime"] = p.stat().st_mtime
        _memory[dataset] = data
        return data
    except (OSError, ValueError):
        return None


def _store(dataset: str, rows: list[list[Any]]) -> dict[str, Any]:
    data = {"fetched_at": time.time(), "rows": rows}
    p = _path(dataset)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)
    data["mtime"] = p.stat().st_mtime
    _memory[dataset] = data
    return data


def dataset(name: str, refresh: bool = False) -> tuple[dict[str, Any] | None, bool]:
    """The cached data set, downloading it first when missing or stale. Second value is True when
    the copy returned is older than STALE_AFTER_S (a refresh was due and could not be done)."""
    with _lock(name):
        cached = _load_cache(name)
        now = time.time()
        age = now - cached["fetched_at"] if cached else float("inf")
        due = age > (MIN_REFETCH_S if refresh else STALE_AFTER_S)
        wait = RETRY_AFTER_LIMITED_S if "403" in _last_error.get(name, "") else RETRY_AFTER_FAIL_S
        if due and now - _last_fail.get(name, 0.0) > wait:
            try:
                cached = _store(name, _fetch(name))
                age = 0.0
                _last_fail.pop(name, None)
                _last_error.pop(name, None)
                logger.info("Satellites: downloaded %d %s objects from CelesTrak", len(cached["rows"]), name)
            except (FetchError, LookupError) as e:
                _last_fail[name] = now
                _last_error[name] = (
                    "CelesTrak only allows each data set to be downloaded once per 2 hours (it updates that often); try again later (HTTP 403)"
                    if "403" in str(e)
                    else str(e) or "download failed"
                )
                logger.info("Satellites: could not refresh %s (%s)", name, e)
        return cached, cached is not None and age > STALE_AFTER_S


def rows_for(groups: set[str]) -> dict[str, Any]:
    """Compact rows for the union of the requested groups (see FIELDS for the columns)."""
    mask = 0
    for g in groups:
        mask |= GROUP_BITS[g]
    merged: dict[int, list[Any]] = {}
    fetched: list[float] = []
    stale = False
    missing: list[str] = []
    errors: dict[str, str] = {}
    for name in sorted({DATASET_OF_GROUP[g] for g in groups}):
        data, is_stale = dataset(name)
        if name in _last_error:
            errors[name] = _last_error[name]
        if data is None:
            missing.append(name)
            continue
        stale = stale or is_stale
        fetched.append(data["fetched_at"])
        for r in data["rows"]:
            flags = r[-1] | (GROUP_BITS["iss"] if name == "stations" and r[0] == ISS_NORAD else 0)  # also for caches written before the ISS had its own flag
            if not flags & mask:
                continue
            have = merged.get(r[0])
            if have is None:
                merged[r[0]] = [*r[:-1], flags]
            else:
                have[-1] |= flags
    return {
        "fields": FIELDS,
        "rows": list(merged.values()),
        "fetched_at": min(fetched) if fetched else None,
        "stale": stale,
        "missing": missing,
        "errors": errors,
        "offline": bool(missing) or stale,
        "credit": CREDIT,
    }


def status() -> dict[str, Any]:
    out: dict[str, Any] = {}
    now = time.time()
    for name in ("stations", "visual", "active"):
        data = _load_cache(name)
        p = _path(name)
        out[name] = (
            {"count": len(data["rows"]), "fetched_at": data["fetched_at"], "age_s": now - data["fetched_at"], "bytes": p.stat().st_size}
            if data
            else None
        )
    return {"datasets": out, "errors": dict(_last_error), "min_refetch_s": MIN_REFETCH_S, "stale_after_s": STALE_AFTER_S, "credit": CREDIT}


def refresh() -> dict[str, Any]:
    """Re-download every data set that has been downloaded before (and always the stations), except
    those fetched less than MIN_REFETCH_S ago. Returns per-data-set outcome."""
    result: dict[str, str] = {}
    for name in ("stations", "visual", "active"):
        have = _load_cache(name)
        if have is None and name != "stations":
            continue
        if have is not None and time.time() - have["fetched_at"] < MIN_REFETCH_S:
            result[name] = "recent"
            continue
        _last_fail.pop(name, None)
        before = have["fetched_at"] if have else 0
        data, _ = dataset(name, refresh=True)
        result[name] = "updated" if data is not None and data["fetched_at"] > before else "failed"
    return {"result": result, **status()}


def clear() -> None:
    for name in ("stations", "visual", "active"):
        _memory.pop(name, None)
        try:
            _path(name).unlink()
        except OSError:
            pass
