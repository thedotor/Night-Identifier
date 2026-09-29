"""World precipitation radar/satellite composite (RainViewer, api.rainviewer.com). Free, keyless, a new frame
about every 10 minutes.

Coverage is real weather radar plus satellite-based infill where there is no radar network: it looks patchy
over oceans and much of Africa, South America and Asia, not because of a bug here but because that is what is
actually measured or estimated right now. A composite is stitched once per frame and reused until the next
one is published (RainViewer publishes a new past frame every 10 minutes).
"""

import io
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _http_get

logger = log_capture.get_logger("rainviewer")

CATALOG_URL = "https://api.rainviewer.com/public/weather-maps.json"
CREDIT = "Precipitation radar/satellite composite: RainViewer (rainviewer.com). Coverage follows real radar networks: patchy over oceans and some regions."
TILE = 256
ZOOM = 3
COLOR = 2  # RainViewer's "Universal Blue" palette
OPTIONS = "1_1"  # smoothed, snow shown separately
CATALOG_CACHE_S = 300.0

_lock = threading.Lock()
_catalog_mem: tuple[float, dict[str, Any]] | None = None
_build_lock = threading.Lock()


def _dir() -> Path:
    d = settings.deepspace_dir / "rainviewer"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _catalog() -> dict[str, Any]:
    global _catalog_mem
    with _lock:
        if _catalog_mem and time.time() - _catalog_mem[0] < CATALOG_CACHE_S:
            return _catalog_mem[1]
    raw = _get_json(CATALOG_URL, timeout=20)
    if not isinstance(raw, dict) or not (raw.get("radar") or {}).get("past"):
        with _lock:
            if _catalog_mem:
                return _catalog_mem[1]
        raise FetchError("no radar frames listed")
    with _lock:
        _catalog_mem = (time.time(), raw)
    return raw


def _mercator_to_equirect(im: Image.Image, out_height: int) -> Image.Image:
    """RainViewer's tiles (like any standard web map) are Web Mercator, which stretches high latitudes: row `r` of the
    stitched square is NOT latitude `r`. The Earth sphere here expects a plate-carree (equirectangular) image, so
    remap each output row to the Mercator row it actually corresponds to. Mercator is undefined beyond about
    +-85.05 degrees, so the polar caps of the output are left transparent."""
    width, src_height = im.size
    out = Image.new("RGBA", (width, out_height), (0, 0, 0, 0))
    for r in range(out_height):
        lat_deg = 90.0 - (r + 0.5) / out_height * 180.0
        lat_rad = math.radians(lat_deg)
        y_frac = 0.5 - math.log(math.tan(math.pi / 4 + lat_rad / 2)) / (2 * math.pi)
        if not (0.0 <= y_frac <= 1.0):
            continue
        src_row = min(src_height - 1, max(0, int(y_frac * src_height)))
        out.paste(im.crop((0, src_row, width, src_row + 1)), (0, r))
    return out


def _tile(host: str, path: str, x: int, y: int) -> Image.Image:
    url = f"{host}{path}/{TILE}/{ZOOM}/{x}/{y}/{COLOR}/{OPTIONS}.png"
    try:
        body, _ = _http_get(url, accept="image/png", attempts=2, timeout=20)
    except LookupError:
        return Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    return Image.open(io.BytesIO(body)).convert("RGBA")


def build_rain_map() -> Path:
    """The cached whole-world radar composite for the latest frame, stitching it first if needed."""
    cat = _catalog()
    frame = cat["radar"]["past"][-1]
    path = _dir() / f"rain_{frame['time']}.png"
    if path.is_file():
        return path
    with _build_lock:
        if path.is_file():
            return path
        n = 1 << ZOOM
        started = time.time()
        canvas = Image.new("RGBA", (n * TILE, n * TILE), (0, 0, 0, 0))
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                jobs = {(x, y): pool.submit(_tile, cat["host"], frame["path"], x, y) for x in range(n) for y in range(n)}
                for (x, y), fut in jobs.items():
                    tile = fut.result()
                    canvas.paste(tile, (x * TILE, y * TILE), tile)
        except (FetchError, OSError) as e:
            raise FetchError(f"could not download the rain map ({e})") from e
        canvas = _mercator_to_equirect(canvas, canvas.height // 2)
        tmp = path.with_suffix(".part")
        canvas.save(tmp, format="PNG", optimize=True)
        tmp.replace(path)
        for old in _dir().glob("rain_*.png"):  # keep only the current frame on disk
            if old != path:
                try:
                    old.unlink()
                except OSError:
                    pass
        logger.info("Rain map: %dx%d stitched in %.1f s (%d KB)", canvas.width, canvas.height, time.time() - started, path.stat().st_size // 1024)
        return path


def rain_info() -> dict[str, Any]:
    frame = _catalog()["radar"]["past"][-1]
    return {"time_ms": frame["time"] * 1000, "credit": CREDIT}
