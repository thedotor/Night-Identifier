"""High-resolution Earth maps and the world's cities, for the 3D Earth.

* Maps: NASA GIBS (Global Imagery Browse Services) serves the Earth as a pyramid of 512-pixel tiles: at level L a tile
  spans 288/2^L degrees, so level 3 is 10x5 tiles (5120x2560 for the whole globe) and level 4 is 20x10 tiles
  (10240x5120). The tiles are fetched in parallel, stitched into one
  equirectangular picture and cached on disk (a few MB each, built once). Day = Blue Marble (natural colour,
  with shaded relief and sea-floor depth); night = NASA Black Marble (VIIRS city lights). Both are NASA imagery
  and free to use with credit.
* Cities: Natural Earth's "populated places" (public domain), reduced to name, country, position, population.
"""

import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _http_get

logger = log_capture.get_logger("earthmaps")

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best"
LAYERS = {
    "day": ("BlueMarble_ShadedRelief_Bathymetry", "jpeg"),
    "night": ("VIIRS_Black_Marble", "png"),
}
TILE = 512
MAP_CREDIT = "Earth imagery: NASA Blue Marble and Black Marble (NASA Earth Observatory / GIBS)"
LEVELS = (3, 4)  # 5120x2560 and 10240x5120

# Sharp close-up imagery: Sentinel-2 cloudless (a cloud-free mosaic of a year of 10 m satellite pictures), as 256 px web-map tiles
TILE_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg"
TILE_CREDIT = "Close-up imagery: Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2021), CC BY-NC-SA 4.0"
TILE_MAX_Z = 14

CITIES_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson"
CITIES_CREDIT = "Cities: Natural Earth (public domain)"

_build_lock = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_errors: dict[str, str] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "earthmaps"
    d.mkdir(parents=True, exist_ok=True)
    return d


def map_path(kind: str, level: int) -> Path:
    return _dir() / f"{kind}_L{level}.jpg"


def _tile(layer: str, ext: str, tile_matrix_set: str, level: int, row: int, col: int) -> Image.Image:
    url = f"{GIBS}/{layer}/default/{tile_matrix_set}/{level}/{row}/{col}.{ext}"
    try:
        body, _ = _http_get(url, accept="image/*", attempts=3, timeout=40)
    except LookupError:  # a tile that does not exist (all sea, all dark): leave it black
        return Image.new("RGB", (TILE, TILE))
    return Image.open(io.BytesIO(body)).convert("RGB")


def _build(cache_key: str, layer: str, ext: str, tile_matrix_set: str, level: int, cols: int, rows: int, quality: int, max_age_s: float | None = None) -> Path:
    """A cached whole-Earth picture stitched from a GIBS tile pyramid. `max_age_s`: rebuild once the cached file is this old (None: build once, keep forever - for the Blue/Black Marble reference maps)."""
    path = _dir() / f"{cache_key}.jpg"
    if path.is_file() and (max_age_s is None or time.time() - path.stat().st_mtime < max_age_s):
        return path
    with _locks.setdefault(cache_key, threading.Lock()):
        if path.is_file() and (max_age_s is None or time.time() - path.stat().st_mtime < max_age_s):
            return path
        started = time.time()
        canvas = Image.new("RGB", (cols * TILE, rows * TILE))
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                jobs = {(r, c): pool.submit(_tile, layer, ext, tile_matrix_set, level, r, c) for r in range(rows) for c in range(cols)}
                for (r, c), fut in jobs.items():
                    canvas.paste(fut.result(), (c * TILE, r * TILE))
        except (FetchError, OSError) as e:
            _errors[cache_key] = str(e) or "download failed"
            if path.is_file():  # serve the stale copy rather than nothing
                return path
            raise FetchError(f"could not download the map ({e})") from e
        _errors.pop(cache_key, None)
        tmp = path.with_suffix(".part")
        canvas.save(tmp, format="JPEG", quality=quality, optimize=True)
        tmp.replace(path)
        logger.info("Map %s: %dx%d stitched in %.1f s (%d KB)", cache_key, canvas.width, canvas.height, time.time() - started, path.stat().st_size // 1024)
        return path


def build_map(kind: str, level: int) -> Path:
    """The cached whole-Earth picture for `kind` ('day' or 'night') at a pyramid level, stitching it first if needed."""
    if kind not in LAYERS or level not in LEVELS:
        raise FetchError("unknown map")
    layer, ext = LAYERS[kind]
    cols, rows = int(1.25 * 2**level), int(0.625 * 2**level)
    return _build(f"{kind}_L{level}", layer, ext, "500m", level, cols, rows, 90 if kind == "day" else 92)


# A coarse global science layer, changing over hours to days rather than the Blue/Black Marble's "representative" imagery.
SCIENCE_LAYERS: dict[str, dict[str, Any]] = {
    # OMPS (Suomi NPP) daily global total-column ozone, GIBS's own colour scale (Dobson units), refreshed a few times a day.
    "ozone": {"layer": "OMPS_Ozone_Total_Column", "ext": "png", "tile_matrix_set": "2km", "level": 2, "cols": 5, "rows": 3, "max_age_s": 4 * 3600}
}
SCIENCE_CREDIT = {"ozone": "Ozone: NASA OMPS Total Column Ozone (NASA Earth Observatory / GIBS)"}


def build_science_map(kind: str) -> Path:
    cfg = SCIENCE_LAYERS.get(kind)
    if not cfg:
        raise FetchError("unknown map")
    return _build(f"science_{kind}", cfg["layer"], cfg["ext"], cfg["tile_matrix_set"], cfg["level"], cfg["cols"], cfg["rows"], 88, cfg["max_age_s"])


# ---------- cities ----------


def tile(z: int, x: int, y: int) -> Path:
    """One close-up imagery tile (web-map numbering), fetched on first use and kept on disk. LookupError: no such tile."""
    n = 1 << z if 0 <= z <= TILE_MAX_Z else 0
    if not (0 <= x < n and 0 <= y < n):
        raise LookupError("no such tile")
    path = _dir() / "tiles" / str(z) / str(x) / f"{y}.jpg"
    if path.exists():
        return path
    body, _ = _http_get(TILE_URL.format(z=z, x=x, y=y), accept="image/jpeg", attempts=2, timeout=25)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{threading.get_ident()}.part")
    tmp.write_bytes(body)
    tmp.replace(path)
    return path


def _cities_path() -> Path:
    return _dir() / "cities.json"


def cities() -> dict[str, Any]:
    """Populated places, biggest first: rows of [name, country, latitude, longitude, population, is_capital]."""
    path = _cities_path()
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    with _build_lock:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
        body, _ = _http_get(CITIES_URL, accept="application/json", attempts=3, timeout=90)
        try:
            features = json.loads(body)["features"]
        except (ValueError, KeyError) as e:
            raise FetchError("the city list is not readable") from e
        rows: list[list[Any]] = []
        for f in features:
            p = f.get("properties", {})
            try:
                pop = int(max(p.get("pop_max") or 0, p.get("pop_min") or 0))
                rows.append([str(p["name"]), str(p.get("adm0name") or ""), round(float(p["latitude"]), 3), round(float(p["longitude"]), 3), pop, 1 if (p.get("adm0cap") or 0) else 0])
            except (KeyError, TypeError, ValueError):
                continue
        rows.sort(key=lambda r: (-r[4], r[0]))
        out = {"fields": ["name", "country", "lat", "lon", "population", "capital"], "rows": rows, "credit": CITIES_CREDIT}
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
        logger.info("Cities: %d places cached", len(rows))
        return out
