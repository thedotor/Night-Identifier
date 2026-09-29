"""Deep Space: facts, descriptions and high-detail imagery for sky objects.

Everything comes from public archives on demand and is cached on disk, so each image is
downloaded once and the frontend only ever talks to this backend:

* descriptions and curated photos (with credit + licence): Wikipedia / Wikimedia Commons
* survey cut-outs of any patch of sky: DSS2 / PanSTARRS / 2MASS via CDS hips2fits

Network failures never raise out of `object_info`: it returns what it has plus `offline: True`,
and whatever was cached earlier keeps working with no connection. `start_pack` pre-downloads the
popular objects (Messier + Sun, Moon, planets) for fully offline use.
"""

import hashlib
import json
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture

logger = log_capture.get_logger("deepspace")

USER_AGENT = "NightIdentifier/0.1 (desktop sky-photo app; personal use)"
HTTP_TIMEOUT_S = 25
MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024

HIPS2FITS = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
WIKI_REST = "https://en.wikipedia.org/api/rest_v1"
WIKI_API = "https://en.wikipedia.org/w/api.php"

# Only these hosts can be fetched through /deepspace/media, so it is not an open proxy.
ALLOWED_MEDIA_HOSTS = {
    "upload.wikimedia.org",
    "thumb.wikimedia.org",
    "alasky.cds.unistra.fr",
    "alaskybis.cds.unistra.fr",
    "www.solarsystemscope.com",
}

# Planet maps for the 3D solar system (Solar System Scope, CC BY 4.0). key -> file name.
_TEXTURE_BASE = "https://www.solarsystemscope.com/textures/download/"
TEXTURE_FILES: dict[str, str] = {
    "sun": "2k_sun.jpg",
    "mercury": "2k_mercury.jpg",
    "venus": "2k_venus_surface.jpg",
    "earth": "2k_earth_daymap.jpg",
    "earth_night": "2k_earth_nightmap.jpg",
    "moon": "2k_moon.jpg",
    "mars": "2k_mars.jpg",
    "jupiter": "2k_jupiter.jpg",
    "saturn": "2k_saturn.jpg",
    "saturn_ring": "2k_saturn_ring_alpha.png",
    "uranus": "2k_uranus.jpg",
    "neptune": "2k_neptune.jpg",
}
TEXTURE_CREDIT = "Planet maps: Solar System Scope (solarsystemscope.com/textures), CC BY 4.0"


def texture_urls() -> dict[str, str]:
    return {k: f"/deepspace/media?url={urllib.parse.quote(_TEXTURE_BASE + f, safe='')}" for k, f in TEXTURE_FILES.items()}
# hips2fits has a second front door; use it if the first one is having trouble.
MIRRORS = {"alasky.cds.unistra.fr": "alaskybis.cds.unistra.fr"}

# key -> (hips id, credit line)
SURVEYS: dict[str, tuple[str, str]] = {
    "dss2": ("CDS/P/DSS2/color", "Digitized Sky Survey 2 (STScI / ESO / Caltech), via CDS Strasbourg"),
    "panstarrs": ("CDS/P/PanSTARRS/DR1/color-z-zg-g", "Pan-STARRS DR1 (PS1 Science Consortium), via CDS Strasbourg"),
    "2mass": ("CDS/P/2MASS/color", "2MASS (UMass / IPAC-Caltech / NASA / NSF), via CDS Strasbourg"),
}
SURVEY_LICENCE = "Free for education and research; credit required"

DSO_TYPES = {
    "G": "Galaxy",
    "GPair": "Galaxy pair",
    "GTrpl": "Galaxy triplet",
    "GGroup": "Galaxy group",
    "OCl": "Open cluster",
    "GCl": "Globular cluster",
    "Neb": "Nebula",
    "HII": "HII region (emission nebula)",
    "EmN": "Emission nebula",
    "RfN": "Reflection nebula",
    "SNR": "Supernova remnant",
    "DrkN": "Dark nebula",
    "PN": "Planetary nebula",
    "Cl+N": "Cluster with nebulosity",
    "*Ass": "Stellar association",
    "**": "Double star",
    "Other": "Deep-sky object",
}

# Sun, Moon, planets: (Wikipedia title, mean diameter, orbital period, distance note)
BODIES: dict[str, tuple[str, str, str, str]] = {
    "sun": ("Sun", "1,392,700 km", "~230 million years around the galaxy", "149.6 million km from Earth (1 AU)"),
    "moon": ("Moon", "3,474 km", "27.3 days around Earth", "384,400 km from Earth"),
    "mercury": ("Mercury (planet)", "4,879 km", "88 days", "0.39 AU from the Sun"),
    "venus": ("Venus", "12,104 km", "224.7 days", "0.72 AU from the Sun"),
    "earth": ("Earth", "12,742 km", "365.25 days", "149.6 million km from the Sun (1 AU)"),
    "mars": ("Mars", "6,779 km", "687 days", "1.52 AU from the Sun"),
    "jupiter": ("Jupiter", "139,820 km", "11.86 years", "5.20 AU from the Sun"),
    "saturn": ("Saturn", "116,460 km", "29.46 years", "9.54 AU from the Sun"),
    "uranus": ("Uranus", "50,724 km", "84.0 years", "19.19 AU from the Sun"),
    "neptune": ("Neptune", "49,244 km", "164.8 years", "30.07 AU from the Sun"),
}

_CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "data" / "sky" / "catalogue.json"


class FetchError(Exception):
    """A network problem (offline, timeout, server error). Not a plain 'no such page'."""


# ---------- cache ----------


def _media_dir() -> Path:
    d = settings.deepspace_dir / "media"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _info_dir() -> Path:
    d = settings.deepspace_dir / "info"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_bytes() -> int:
    root = settings.deepspace_dir
    if not root.exists():
        return 0
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def clear_cache() -> None:
    root = settings.deepspace_dir
    for sub in ("media", "info"):
        shutil.rmtree(root / sub, ignore_errors=True)


# ---------- HTTP ----------


def _http_get_once(url: str, accept: str | None, timeout: float = HTTP_TIMEOUT_S, headers: dict[str, str] | None = None) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **({"Accept": accept} if accept else {}), **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(MAX_DOWNLOAD_BYTES + 1)
        if len(body) > MAX_DOWNLOAD_BYTES:
            raise FetchError("response too large")
        return body, resp.headers.get_content_type()


def _http_get(url: str, accept: str | None = None, attempts: int = 3, timeout: float = HTTP_TIMEOUT_S, headers: dict[str, str] | None = None) -> tuple[bytes, str]:
    """Body and Content-Type. Raises FetchError on network trouble, LookupError on HTTP 404.
    Rate limits (429), server hiccups and dropped connections are retried with a short backoff."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return _http_get_once(url, accept, timeout, headers)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise LookupError(url) from e
            last = FetchError(f"HTTP {e.code} from {urllib.parse.urlsplit(url).netloc}")
            if e.code not in (429, 500, 502, 503, 504):
                break
            try:
                delay = min(8.0, float(e.headers.get("Retry-After", "")))
            except ValueError:
                delay = 1.5 * (attempt + 1)
        except FetchError as e:
            raise e
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            last = FetchError(str(getattr(e, "reason", e)))
            delay = 1.0 * (attempt + 1)
        if attempt < attempts - 1:
            time.sleep(delay)
    raise last if last is not None else FetchError("request failed")


def _get_json(url: str, timeout: float = HTTP_TIMEOUT_S, headers: dict[str, str] | None = None) -> Any | None:
    """Parsed JSON, or None for a 404 (page does not exist)."""
    try:
        body, _ = _http_get(url, accept="application/json", timeout=timeout, headers=headers)
    except LookupError:
        return None
    try:
        return json.loads(body)
    except ValueError as e:
        raise FetchError("bad JSON") from e


_EXT_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}
_TYPE_BY_EXT = {v: k for k, v in _EXT_BY_TYPE.items()}


def media_type(path: Path) -> str:
    return _TYPE_BY_EXT.get(path.suffix, "application/octet-stream")


def _check_media_url(url: str) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_MEDIA_HOSTS:
        raise ValueError("URL host is not allowed")


def media_path(url: str) -> Path:
    """Local copy of an allowed remote image, downloading it the first time."""
    _check_media_url(url)
    stem = hashlib.sha1(url.encode(), usedforsecurity=False).hexdigest()  # a cache file name, not a security use
    existing = next(iter(_media_dir().glob(f"{stem}.*")), None)
    if existing is not None and existing.suffix in _TYPE_BY_EXT:
        return existing
    host = urllib.parse.urlsplit(url).hostname or ""
    try:
        try:
            body, ctype = _http_get(url, accept="image/*")
        except FetchError:
            if host not in MIRRORS:
                raise
            body, ctype = _http_get(url.replace(host, MIRRORS[host], 1), accept="image/*")
    except LookupError as e:
        raise FetchError("image not found") from e
    ext = _EXT_BY_TYPE.get(ctype)
    if ext is None:
        raise FetchError(f"unexpected content type {ctype}")
    path = _media_dir() / f"{stem}{ext}"
    tmp = path.with_suffix(".part")
    tmp.write_bytes(body)
    tmp.replace(path)
    return path


# ---------- survey cut-outs ----------


def cutout_url(ra: float, dec: float, fov_deg: float, width: int, height: int, survey: str) -> str:
    """hips2fits URL for a north-up tangent-plane cut-out, parameters normalised so that
    nearby requests share a cache entry."""
    hips, _credit = SURVEYS[survey]
    query = {
        "hips": hips,
        "width": int(width),
        "height": int(height),
        "fov": f"{fov_deg:.4f}",
        "projection": "TAN",
        "coordsys": "icrs",
        "rotation_angle": "0.0",
        "ra": f"{ra % 360.0:.4f}",
        "dec": f"{max(-90.0, min(90.0, dec)):.4f}",
        "format": "jpg",
    }
    return f"{HIPS2FITS}?{urllib.parse.urlencode(query)}"


def cutout_path(ra: float, dec: float, fov_deg: float, width: int, height: int, survey: str) -> Path:
    return media_path(cutout_url(ra, dec, fov_deg, width, height, survey))


# ---------- catalogue lookups ----------


@lru_cache(maxsize=1)
def _catalogue() -> dict[str, Any]:
    return json.loads(_CATALOGUE_PATH.read_text(encoding="utf-8"))


def _fmt_ra(deg: float) -> str:
    h = (deg % 360.0) / 15.0
    hh = int(h)
    mm = int((h - hh) * 60)
    ss = ((h - hh) * 60 - mm) * 60
    return f"{hh:02d}h {mm:02d}m {ss:04.1f}s"


def _fmt_dec(deg: float) -> str:
    sign = "-" if deg < 0 else "+"
    a = abs(deg)
    d = int(a)
    m = int((a - d) * 60)
    s = ((a - d) * 60 - m) * 60
    return f"{sign}{d:02d}° {m:02d}′ {s:02.0f}″"


def _dso_wiki_titles(dso: dict[str, Any]) -> list[str]:
    titles: list[str] = []
    ident = dso["id"].strip()
    m = re.fullmatch(r"M\s*0*(\d+)", ident)
    if m:
        titles.append(f"Messier {int(m.group(1))}")
    else:
        m = re.fullmatch(r"(NGC|IC)\s*0*(\d+)\w*", ident)
        if m:
            titles.append(f"{m.group(1)} {int(m.group(2))}")
    if dso.get("name"):
        titles.append(dso["name"])
    return titles


def _pretty_id(ident: str) -> str:
    m = re.fullmatch(r"(NGC|IC)\s*0*(\d+)(\w*)", ident.strip())
    return f"{m.group(1)} {int(m.group(2))}{m.group(3)}" if m else ident.strip()


def _lookup(kind: str, key: str) -> dict[str, Any] | None:
    """Everything known locally about an object: title, facts, position and Wikipedia titles."""
    cat = _catalogue()
    if kind == "dso":
        dso = next((d for d in cat["dsos"] if d["id"].strip().lower() == key.strip().lower()), None)
        if dso is None:
            return None
        facts = [
            ("Type", DSO_TYPES.get(dso["type"], dso["type"])),
            ("Designation", _pretty_id(dso["id"])),
        ]
        if dso.get("mag") is not None:
            facts.append(("Magnitude", f"{dso['mag']:.1f}"))
        maj, mn = dso.get("maj"), dso.get("min")
        if maj:
            facts.append(("Apparent size", f"{maj:.1f}′ × {mn:.1f}′" if mn else f"{maj:.1f}′"))
        facts += [("Right ascension", _fmt_ra(dso["ra"])), ("Declination", _fmt_dec(dso["dec"]))]
        size_deg = max(maj or 0.0, mn or 0.0) / 60.0
        return {
            "title": dso["name"] or _pretty_id(dso["id"]),
            "subtitle": f"{_pretty_id(dso['id'])} · {DSO_TYPES.get(dso['type'], dso['type'])}",
            "ra": dso["ra"],
            "dec": dso["dec"],
            "size_deg": size_deg,
            "facts": facts,
            "wiki": _dso_wiki_titles(dso),
        }
    if kind == "star":
        try:
            i = int(key)
            ra, dec, mag = cat["stars"][3 * i], cat["stars"][3 * i + 1], cat["stars"][3 * i + 2]
        except (ValueError, IndexError):
            return None
        name = cat["star_names"].get(str(i))
        return {
            "title": name or "Star",
            "subtitle": f"Star · magnitude {mag:.1f}",
            "ra": ra,
            "dec": dec,
            "size_deg": 0.0,
            "facts": [("Magnitude", f"{mag:.2f}"), ("Right ascension", _fmt_ra(ra)), ("Declination", _fmt_dec(dec))],
            "wiki": [name] if name else [],
        }
    if kind == "body":
        info = BODIES.get(key.lower())
        if info is None:
            return None
        wiki, diameter, period, distance = info
        b = key.lower()
        return {
            "title": key.capitalize(),
            "subtitle": "Star (the Sun)" if b == "sun" else ("Moon" if b == "moon" else "Planet"),
            "ra": None,
            "dec": None,
            "size_deg": 0.0,
            "facts": [("Diameter", diameter), ("Orbital period", period), ("Distance", distance)],
            "wiki": [wiki],
        }
    return None


# ---------- Wikipedia / Commons ----------


def _strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def _wiki_summary(titles: list[str]) -> dict[str, Any] | None:
    for title in titles:
        data = _get_json(f"{WIKI_REST}/page/summary/{urllib.parse.quote(title.replace(' ', '_'), safe='')}")
        if data and data.get("type") == "standard" and data.get("extract"):
            return data
    return None


def _commons_images(page_title: str, limit: int = 5) -> list[dict[str, Any]]:
    """Photos on a Wikipedia page, with credit and licence, best first."""
    listing = _get_json(f"{WIKI_REST}/page/media-list/{urllib.parse.quote(page_title.replace(' ', '_'), safe='')}")
    if not listing:
        return []
    items = [i for i in listing.get("items", []) if i.get("type") == "image" and i.get("title", "").lower().endswith((".jpg", ".jpeg", ".png"))]
    items.sort(key=lambda i: not i.get("leadImage"))
    files = [i["title"] for i in items][:16]
    if not files:
        return []
    query = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "prop": "imageinfo",
            "iiprop": "url|size|extmetadata",
            "iiurlwidth": 1280,
            "titles": "|".join(files),
        }
    )
    data = _get_json(f"{WIKI_API}?{query}")
    pages = (data or {}).get("query", {}).get("pages", {})
    by_title = {p.get("title"): p for p in pages.values() if p.get("imageinfo")}
    out: list[dict[str, Any]] = []
    for f in files:
        page = by_title.get(f)
        if page is None:
            continue
        info = page["imageinfo"][0]
        if info.get("width", 0) < 600 or info.get("height", 0) < 400:
            continue  # icons, logos, thin strips
        meta = info.get("extmetadata", {})
        artist = _strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown author"
        licence = _strip_html(meta.get("LicenseShortName", {}).get("value", "")) or "See source page"
        caption = _strip_html(meta.get("ImageDescription", {}).get("value", ""))
        out.append(
            {
                "url": info.get("thumburl") or info["url"],
                "credit": f"{artist} / Wikimedia Commons",
                "license": licence,
                "source_url": info.get("descriptionurl"),
                "caption": caption[:240],
                "kind": "photo",
            }
        )
        if len(out) >= limit:
            break
    return out


# ---------- object info ----------


def _image_entry(img: dict[str, Any]) -> dict[str, Any]:
    entry = dict(img)
    entry["src"] = f"/deepspace/media?url={urllib.parse.quote(img['url'], safe='')}"
    return entry


def object_info(kind: str, key: str) -> dict[str, Any] | None:
    """Facts, description and images for one object; None if the object is unknown."""
    base = _lookup(kind, key)
    if base is None:
        return None
    cache_file = _info_dir() / f"{kind}_{re.sub(r'[^A-Za-z0-9_-]', '_', key)}.json"
    if cache_file.is_file():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass

    description: str | None = None
    description_url: str | None = None
    photos: list[dict[str, Any]] = []
    offline = False
    try:
        summary = _wiki_summary(base["wiki"])
        if summary:
            description = summary["extract"]
            description_url = (summary.get("content_urls") or {}).get("desktop", {}).get("page")
            photos = _commons_images(summary.get("title") or base["wiki"][0])
    except FetchError as e:
        offline = True
        logger.info("Deep Space: could not reach Wikipedia (%s)", e)

    images = list(photos)
    if base["ra"] is not None:
        # Fields below ~0.2 degrees are blank in DSS, and a huge nebula needs room around it.
        fov = max(0.25, min(20.0, base["size_deg"] * 2.4))
        images.append(
            {
                "url": cutout_url(base["ra"], base["dec"], fov, 900, 900, "dss2"),
                "credit": SURVEYS["dss2"][1],
                "license": SURVEY_LICENCE,
                "source_url": "https://alasky.cds.unistra.fr/",
                "caption": f"Sky survey view, {fov:.2f}° across, north up",
                "kind": "survey",
            }
        )

    result = {
        "kind": kind,
        "key": key,
        "title": base["title"],
        "subtitle": base["subtitle"],
        "facts": [{"label": a, "value": b} for a, b in base["facts"]],
        "description": description,
        "description_url": description_url,
        "images": [_image_entry(i) for i in images],
        "offline": offline,
    }
    if not offline:  # never cache a result that is missing content only because there was no network
        cache_file.write_text(json.dumps(result), encoding="utf-8")
    return result


# ---------- offline pack ----------

_pack_lock = threading.Lock()
_pack: dict[str, Any] = {"running": False, "total": 0, "done": 0, "failed": 0, "current": None}


def pack_targets() -> list[tuple[str, str]]:
    cat = _catalogue()
    targets = [("body", b) for b in BODIES]
    targets += [("dso", d["id"]) for d in cat["dsos"] if re.fullmatch(r"M\s*\d+", d["id"].strip())]
    return targets


def pack_status() -> dict[str, Any]:
    with _pack_lock:
        return {**_pack, "cache_bytes": cache_bytes()}


def _fetch_one(kind: str, key: str) -> None:
    with _pack_lock:
        _pack["current"] = key
    ok = False
    try:
        info = object_info(kind, key)
        if info is not None and not info["offline"]:
            for img in info["images"]:
                media_path(img["url"])
            ok = True
    except (FetchError, ValueError, OSError) as e:
        logger.info("Deep Space pack: %s failed (%s)", key, e)
    with _pack_lock:
        _pack["done"] += 1
        if not ok:
            _pack["failed"] += 1


def _fetch_solar_system() -> None:
    """Orbits, star/galaxy distances and planet maps for the 3D views, counted as one pack step."""
    from app.services import galaxy, moons, orbits  # local import: they import this module

    with _pack_lock:
        _pack["current"] = "solar system"
    ok = False
    try:
        ok = not orbits.orbit_data()["offline"] and galaxy.fetch_all() and not moons.moon_elements()["offline"]
        for f in TEXTURE_FILES.values():
            media_path(_TEXTURE_BASE + f)
    except (FetchError, ValueError, OSError) as e:
        ok = False
        logger.info("Deep Space pack: solar system failed (%s)", e)
    with _pack_lock:
        _pack["done"] += 1
        if not ok:
            _pack["failed"] += 1


def _run_pack(targets: list[tuple[str, str]]) -> None:
    started = time.time()
    try:
        _fetch_solar_system()
        with ThreadPoolExecutor(max_workers=2) as pool:  # gentle: Wikipedia rate-limits bursts
            list(pool.map(lambda t: _fetch_one(*t), targets))
    finally:
        with _pack_lock:
            _pack["running"] = False
            _pack["current"] = None
        logger.info("Deep Space pack finished in %.0fs (%d failed)", time.time() - started, _pack["failed"])


def start_pack() -> bool:
    """Start the offline download; False if one is already running."""
    with _pack_lock:
        if _pack["running"]:
            return False
        targets = pack_targets()
        _pack.update(running=True, total=len(targets) + 1, done=0, failed=0, current=None)  # +1: solar system
    threading.Thread(target=_run_pack, args=(targets,), name="deepspace-pack", daemon=True).start()
    return True
