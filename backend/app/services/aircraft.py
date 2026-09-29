"""Live aircraft positions (ADS-B), for the sky overlay in Live View and for the 3D Earth.

Two free public services, no account needed:

* Near a place (Live View): adsb.fi's open data API, every aircraft within a radius. It asks clients to
  make at most one request a second, so requests are spaced and answers shared for a few seconds.
* The whole world (Deep Space): OpenSky Network's anonymous "all states" snapshot. Anonymous use gets a
  small daily allowance (400 credits, this call costs 4), so a snapshot is kept for MIN_WORLD_REFETCH_S,
  written to disk (a restart does not spend another) and, when OpenSky says "too many requests", the
  last snapshot is served until it allows more.

Both are cached and both fail soft: with no connection the last answer is used.

Every aircraft also gets a `kind` (what the filter chips group by: airliner, business jet, small plane, helicopter,
military, cargo, glider/balloon/drone, unknown) and a `shape` (which icon draws it), worked out by classify() from the
type code, the ADS-B emitter category, the military flag and the callsign. adsb.fi reports all of those. OpenSky
reports only the category, so for the world snapshot the type, registration and military flag come from a community
database (tar1090-db) downloaded once in the background and kept as a small SQLite file next to the snapshot.
"""

import gzip
import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import USER_AGENT, FetchError, _http_get

logger = log_capture.get_logger("aircraft")

NEARBY_URL = "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}"
NEARBY_CREDIT = "Aircraft: adsb.fi open data (ADS-B)"
NEARBY_CACHE_S = 4.0
NEARBY_MIN_GAP_S = 1.1
MAX_RADIUS_NM = 250

WORLD_URL = "https://opensky-network.org/api/states/all?extended=1"
WORLD_CREDIT = "Aircraft: OpenSky Network (opensky-network.org), anonymous ADS-B snapshot"
MIN_WORLD_REFETCH_S = 5 * 60
DEFAULT_BACKOFF_S = 15 * 60

KT_TO_MS = 0.514444
FT_TO_M = 0.3048
FPM_TO_MS = 0.00508

FIELDS = ["hex", "callsign", "lat", "lon", "alt_m", "speed_ms", "track", "vrate_ms", "type", "reg", "t", "kind", "shape"]
_WORLD_RAW_FIELDS = FIELDS[:11] + ["cat"]  # the stored snapshot: the ADS-B category is kept until the row is classified on the way out

TYPES_DB_URL = "https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz"
TYPES_DB_CREDIT = "Aircraft types: tar1090-db (github.com/wiedehopf/tar1090-db)"
TYPES_DB_MAX_AGE_S = 30 * 24 * 3600
_TYPES_PATH = Path(__file__).resolve().parent.parent / "data" / "aircraft" / "types.json"

_lock = threading.Lock()
_last_request = 0.0
_nearby_cache: dict[tuple[float, float, int], tuple[float, dict[str, Any]]] = {}

_world_lock = threading.Lock()
_world_mem: dict[str, Any] | None = None
_world_blocked_until = 0.0
_world_error: str | None = None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def nearby(lat: float, lon: float, radius_nm: int) -> dict[str, Any]:
    """Airborne aircraft within `radius_nm` of a point: rows in FIELDS order (positions dated `t`, epoch seconds)."""
    global _last_request
    radius_nm = max(5, min(MAX_RADIUS_NM, int(radius_nm)))
    key = (round(lat, 2), round(lon, 2), radius_nm)
    with _lock:
        hit = _nearby_cache.get(key)
        if hit and time.time() - hit[0] < NEARBY_CACHE_S:
            return hit[1]
        wait = NEARBY_MIN_GAP_S - (time.time() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.time()
        try:
            body, _ = _http_get(NEARBY_URL.format(lat=key[0], lon=key[1], dist=radius_nm), accept="application/json", attempts=1, timeout=12)
            raw = json.loads(body)
        except (FetchError, LookupError, ValueError) as e:
            if hit:  # offline or throttled: the last answer, marked
                return {**hit[1], "stale": True}
            raise FetchError(f"the aircraft service is not answering ({e})") from e
        now = _num(raw.get("now")) or time.time()
        if now > 1e11:  # some feeds give milliseconds
            now /= 1000.0
        seen: list[tuple[dict[str, Any], float, float, float]] = []
        for a in raw.get("aircraft") or []:
            alt = a.get("alt_geom") if _num(a.get("alt_geom")) is not None else a.get("alt_baro")
            la, lo = _num(a.get("lat")), _num(a.get("lon"))
            if la is None or lo is None or a.get("alt_baro") == "ground" or _num(alt) is None:
                continue
            seen.append((a, la, lo, float(alt)))
        # a few aircraft come without a type: the downloaded database may know them
        known = lookup_hexes([str(a.get("hex", "")) for a, *_ in seen if not a.get("t")])
        rows: list[list[Any]] = []
        for a, la, lo, alt in seen:
            hexcode = str(a.get("hex", ""))
            callsign = str(a.get("flight") or "").strip()
            type_code, reg = str(a.get("t") or ""), str(a.get("r") or "")
            flags = a.get("dbFlags")
            military = bool(flags & 1) if isinstance(flags, int) else False
            if not type_code and hexcode.upper() in known:
                type_code, db_reg, db_mil = known[hexcode.upper()]
                reg, military = reg or db_reg, military or db_mil
            kind, shape = classify(type_code, str(a.get("category") or ""), military or _us_military_hex(hexcode), callsign)
            rows.append(
                [
                    hexcode,
                    callsign,
                    round(la, 5),
                    round(lo, 5),
                    round(alt * FT_TO_M, 1),
                    round((_num(a.get("gs")) or 0.0) * KT_TO_MS, 1),
                    round(_num(a.get("track")) or 0.0, 1),
                    round((_num(a.get("baro_rate")) or _num(a.get("geom_rate")) or 0.0) * FPM_TO_MS, 2),
                    type_code,
                    reg,
                    round(now - (_num(a.get("seen_pos")) or 0.0), 1),
                    kind,
                    shape,
                ]
            )
        _ensure_types_db()
        out = {"fields": FIELDS, "rows": rows, "fetched_at": time.time(), "stale": False, "credit": NEARBY_CREDIT}
        _nearby_cache[key] = (time.time(), out)
        if len(_nearby_cache) > 40:
            for k in sorted(_nearby_cache, key=lambda k: _nearby_cache[k][0])[:20]:
                _nearby_cache.pop(k, None)
        return out


# ---------- what kind of aircraft ----------

# The filter chips (`kind`) and the icons (`shape`). A military helicopter is kind "mil" but drawn as a helicopter.
FIGHTERS = frozenset(
    "F16 F15 F18 F18H F18S FA18 F14 F22 F35 F117 F5 F4 A10 A4 A37 EUFI RFAL TORN HAWK T38 L39 M346 MG29 SU27 SU30 SU34 SU35 SU57 JAS39 MIR2 MIRA HARR".split()
)
BUSINESS_JETS = frozenset(
    """C25A C25B C25C C25M C510 C525 C550 C560 C56X C650 C680 C68A C700 C750 CL30 CL35 CL60 GLF2 GLF3 GLF4 GLF5 GLF6 G150 G200 G280 GALX
    GLEX GL5T GL6T GL7T FA10 FA20 FA50 FA5X FA6X FA7X FA8X F900 F2TH LJ23 LJ24 LJ25 LJ28 LJ31 LJ35 LJ40 LJ45 LJ55 LJ60 LJ70 LJ75 E50P E55P
    H25A H25B H25C HDJT PRM1 ASTR WW24 BE40 SBR1 PC24 SF50 EA50 MU30 SJ30 FJ10""".split()
)
CARGO_TYPES = frozenset("B77L A3ST A337 A124 A225 IL76 MD11 B74F B74S".split())
# ICAO airline designators of freight airlines: a callsign is the designator plus a number ("FDX1234").
CARGO_AIRLINES = frozenset(
    """FDX UPS DHL DHK BOX GTI ABX ATN CLX CKS PAC TAY SQC CAO CSS GEC BCS NCA MPH TNT CJT SRR ICL LCO ADB ABW AJT CKK KZR SWN PTN MTN
    AZG NPT SOO GSJ CLU RUN BOI VDA CFE PST WGN TSO ASY""".split()
)
# ADS-B emitter categories: A1 light, A2 small, A3 large, A4 high-vortex large, A5 heavy, A6 high performance, A7 rotorcraft,
# B1 glider, B2 lighter than air, B3 parachutist, B4 ultralight, B6 UAV, B7 space vehicle.
_OPENSKY_CATEGORY = {2: "A1", 3: "A2", 4: "A3", 5: "A4", 6: "A5", 7: "A6", 8: "A7", 9: "B1", 10: "B2", 11: "B3", 12: "B4", 14: "B6", 15: "B7"}

_types_cache: dict[str, str] | None = None


def _types() -> dict[str, str]:
    global _types_cache
    if _types_cache is None:
        try:
            _types_cache = json.loads(_TYPES_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Aircraft: the bundled type table is missing")
            _types_cache = {}
    return _types_cache


def _us_military_hex(hexcode: str) -> bool:
    """US military aircraft have ICAO addresses in AE0000-AFFFFF."""
    h = hexcode.upper()
    return len(h) == 6 and h[:2] in ("AE", "AF")


def classify(type_code: str, category: str, military: bool, callsign: str) -> tuple[str, str]:
    """(kind, shape) for one aircraft. `category` is the ADS-B emitter category ("A3"), or "" when unknown."""
    code = type_code.upper()
    info = _types().get(code, "").split()
    klass = info[0] if info else ""
    wtc = info[1] if len(info) > 1 else ""
    family, engines, engine = (klass + "   ")[:3]

    if family in "HGRT" or category == "A7":
        airframe = "heli"
    elif family in "BDP" or code == "GLID" or (family == "L" and engines == "0") or category in ("B1", "B2", "B3", "B6", "B7"):
        airframe = "drone"
    elif family in "LSA":  # landplane, seaplane, amphibian (not the "-" and vehicle entries)
        airframe = "jet" if engine == "J" else "prop"
    elif category in ("A3", "A4", "A5"):  # no type: the category is the only clue
        airframe = "jet"
    elif category in ("A1", "B4"):
        airframe = "prop"
    else:
        airframe = "unknown"

    light_jet = code in BUSINESS_JETS or wtc == "L" or engines == "1"
    if military:
        fighter = airframe == "jet" and (code in FIGHTERS or category == "A6" or engines == "1")
        return "mil", "fighter" if fighter else ("biz" if airframe == "jet" and light_jet else airframe)
    if airframe == "jet":
        if light_jet:
            return "biz", "biz"
        cs = callsign.strip().upper()
        if code in CARGO_TYPES or (len(cs) > 3 and cs[:3] in CARGO_AIRLINES and cs[3].isdigit()):
            return "cargo", "jet"
        return "jet", "jet"
    return {"heli": "heli", "drone": "drone", "prop": "prop"}.get(airframe, "unknown"), airframe


# ---------- hex -> type database (for the world snapshot) ----------

_db_lock = threading.Lock()
_db_building = False
_db_retry_after = 0.0


def _db_path() -> Path:
    d = settings.deepspace_dir / "aircraft"
    d.mkdir(parents=True, exist_ok=True)
    return d / "types.sqlite"


def _build_types_db() -> None:
    global _db_building, _db_retry_after
    try:
        body, _ = _http_get(TYPES_DB_URL, attempts=2, timeout=120)
        text = gzip.decompress(body).decode("utf-8", errors="replace")
        rows = []
        for line in text.splitlines():
            f = line.split(";")
            if len(f) < 4 or len(f[0]) != 6:
                continue
            military = f[3][:1] == "1"
            if f[2] or military:
                rows.append((f[0].upper(), f[2], f[1], 1 if military else 0))
        tmp = _db_path().with_suffix(".tmp")
        tmp.unlink(missing_ok=True)
        con = sqlite3.connect(tmp)
        try:
            con.execute("CREATE TABLE aircraft (hex TEXT PRIMARY KEY, type TEXT, reg TEXT, mil INTEGER) WITHOUT ROWID")
            con.executemany("INSERT OR REPLACE INTO aircraft VALUES (?,?,?,?)", rows)
            con.commit()
        finally:
            con.close()
        tmp.replace(_db_path())
        logger.info("Aircraft: type database ready (%d aircraft)", len(rows))
    except (FetchError, LookupError, OSError, sqlite3.Error, EOFError, ValueError) as e:
        _db_retry_after = time.time() + 3600
        logger.info("Aircraft: could not download the type database (%s); trying again in an hour", e)
    finally:
        _db_building = False


def _ensure_types_db() -> None:
    """Start the download in the background when there is no database yet or it is a month old."""
    global _db_building
    with _db_lock:
        if _db_building or time.time() < _db_retry_after:
            return
        try:
            fresh = time.time() - _db_path().stat().st_mtime < TYPES_DB_MAX_AGE_S
        except OSError:
            fresh = False
        if fresh:
            return
        _db_building = True
    threading.Thread(target=_build_types_db, name="aircraft-types-db", daemon=True).start()


def lookup_hexes(hexes: list[str]) -> dict[str, tuple[str, str, bool]]:
    """{HEX: (type, registration, military)} for the addresses the database knows; {} while it is not there yet."""
    wanted = sorted({h.upper() for h in hexes if h})
    if not wanted or not _db_path().exists():
        return {}
    out: dict[str, tuple[str, str, bool]] = {}
    try:
        con = sqlite3.connect(f"file:{_db_path().as_posix()}?mode=ro", uri=True)
        try:
            for i in range(0, len(wanted), 500):
                chunk = wanted[i : i + 500]
                q = "SELECT hex, type, reg, mil FROM aircraft WHERE hex IN (%s)" % ",".join("?" * len(chunk))
                for h, t, r, m in con.execute(q, chunk):
                    out[h] = (t or "", r or "", bool(m))
        finally:
            con.close()
    except sqlite3.Error as e:
        logger.info("Aircraft: type database not readable (%s)", e)
    return out


# ---------- the whole world ----------


class _Limited(Exception):
    def __init__(self, wait_s: float):
        super().__init__(f"rate limited for {int(wait_s)} s")
        self.wait_s = wait_s


def _world_path() -> Path:
    d = settings.deepspace_dir / "aircraft"
    d.mkdir(parents=True, exist_ok=True)
    return d / "world.json"


def _load_world() -> dict[str, Any] | None:
    global _world_mem
    if _world_mem is not None:
        return _world_mem
    try:
        _world_mem = json.loads(_world_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _world_mem = None
    return _world_mem


def _fetch_world() -> dict[str, Any]:
    req = urllib.request.Request(WORLD_URL, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            raw = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                wait = float(e.headers.get("X-Rate-Limit-Retry-After-Seconds", ""))
            except ValueError:
                wait = DEFAULT_BACKOFF_S
            raise _Limited(min(max(wait, 60.0), 24 * 3600.0)) from e
        raise FetchError(f"HTTP {e.code} from opensky-network.org") from e
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise FetchError(str(getattr(e, "reason", e)) or "no connection") from e
    rows: list[list[Any]] = []
    for s in raw.get("states") or []:
        # icao24, callsign, country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, track, vrate, sensors, geo_alt,
        # squawk, spi, position_source, category
        if len(s) < 14 or s[8] or s[5] is None or s[6] is None:
            continue
        alt = s[13] if s[13] is not None else s[7]
        if alt is None:
            continue
        rows.append(
            [
                s[0],
                (s[1] or "").strip(),
                round(s[6], 3),
                round(s[5], 3),
                round(alt, 0),
                round(s[9] or 0.0, 0),
                round(s[10] or 0.0, 0),
                round(s[11] or 0.0, 1),
                "",
                "",
                s[3] or raw.get("time") or time.time(),
                _OPENSKY_CATEGORY.get(s[17], "") if len(s) > 17 and isinstance(s[17], int) else "",
            ]
        )
    if not rows:
        raise FetchError("OpenSky returned no aircraft")
    return {"fields": _WORLD_RAW_FIELDS, "rows": rows, "fetched_at": time.time(), "credit": WORLD_CREDIT}


_world_out: tuple[float, bool, list[list[Any]]] | None = None


def _world_rows(snap: dict[str, Any]) -> tuple[list[list[Any]], bool]:
    """The snapshot's rows with type, registration, kind and shape filled in (from the hex database as far as it is there)."""
    global _world_out
    ready = _db_path().exists()
    if _world_out and _world_out[0] == snap["fetched_at"] and _world_out[1] == ready:
        return _world_out[2], ready
    fields = snap["fields"]
    ci = fields.index("cat") if "cat" in fields else -1
    known = lookup_hexes([str(r[0]) for r in snap["rows"]])
    rows: list[list[Any]] = []
    for r in snap["rows"]:
        hexcode = str(r[0])
        type_code, reg, military = known.get(hexcode.upper(), ("", "", False))
        kind, shape = classify(type_code, str(r[ci]) if ci >= 0 else "", military or _us_military_hex(hexcode), str(r[1]))
        rows.append([*r[:8], type_code, reg, r[10], kind, shape])
    _world_out = (snap["fetched_at"], ready, rows)
    return rows, ready


def world() -> dict[str, Any]:
    """Every airborne aircraft OpenSky can see, refreshed at most every five minutes."""
    global _world_mem, _world_blocked_until, _world_error
    with _world_lock:
        have = _load_world()
        age = time.time() - have["fetched_at"] if have else float("inf")
        if age > MIN_WORLD_REFETCH_S and time.time() >= _world_blocked_until:
            try:
                have = _fetch_world()
                _world_mem = have
                tmp = _world_path().with_suffix(".tmp")
                tmp.write_text(json.dumps(have, separators=(",", ":")), encoding="utf-8")
                tmp.replace(_world_path())
                _world_error = None
                logger.info("Aircraft: downloaded %d aircraft from OpenSky", len(have["rows"]))
            except _Limited as e:
                _world_blocked_until = time.time() + e.wait_s
                _world_error = f"OpenSky's free allowance is used up; more in {int(e.wait_s // 60)} min"
                logger.info("Aircraft: OpenSky rate limit (%s)", e)
            except FetchError as e:
                _world_blocked_until = time.time() + 60
                _world_error = str(e) or "download failed"
                logger.info("Aircraft: could not refresh the world snapshot (%s)", e)
        if have is None:
            raise FetchError(_world_error or "no aircraft data yet")
        _ensure_types_db()
        rows, types_ready = _world_rows(have)
        return {
            "fields": FIELDS,
            "rows": rows,
            "fetched_at": have["fetched_at"],
            "credit": have["credit"] + ("; " + TYPES_DB_CREDIT if types_ready else ""),
            "types_ready": types_ready,
            "stale": time.time() - have["fetched_at"] > 2 * MIN_WORLD_REFETCH_S,
            "error": _world_error,
        }
