"""Live weather: the world's cloud picture for the 3D Earth, and a forecast for one place.

Both come from free public services and are cached on disk, so the app keeps working (on the last
download) when the connection drops.

* Clouds: clouds.matteason.co.uk publishes a global cloud map built from weather-satellite infrared
  images, refreshed about every three hours. One 4096x2048 greyscale picture (bright = cloud), in the
  same equirectangular layout as the Earth map.
* Forecast: Open-Meteo (open-meteo.com, no key needed, free for non-commercial use).
"""

import json
import threading
import time
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture
from app.services.deepspace import FetchError, _get_json, _http_get

logger = log_capture.get_logger("weather")

CLOUD_URL = "https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg"
CLOUD_CREDIT = "Live clouds: clouds.matteason.co.uk, a composite of weather-satellite infrared images"
CLOUD_REFETCH_S = 90 * 60  # the source updates every ~3 hours
CLOUD_RETRY_S = 10 * 60

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_CREDIT = "Weather: Open-Meteo.com"
FORECAST_CACHE_S = 10 * 60

_cloud_lock = threading.Lock()
_cloud_last_fail = 0.0
_cloud_error: str | None = None
_forecasts: dict[tuple[float, float], tuple[float, dict[str, Any]]] = {}


def _dir() -> Path:
    d = settings.deepspace_dir / "weather"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta() -> dict[str, Any] | None:
    try:
        return json.loads((_dir() / "clouds.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def clouds_path() -> Path:
    """The cloud picture on disk, downloading a fresh one first when the copy is older than ~90 minutes.
    An old copy is served when the download fails; FetchError only when there has never been one."""
    global _cloud_last_fail, _cloud_error
    path = _dir() / "clouds.jpg"
    with _cloud_lock:
        meta = _meta()
        age = time.time() - meta["fetched_at"] if meta and path.is_file() else float("inf")
        if age > CLOUD_REFETCH_S and time.time() - _cloud_last_fail > CLOUD_RETRY_S:
            try:
                body, ctype = _http_get(CLOUD_URL, accept="image/jpeg")
                if ctype != "image/jpeg" or len(body) < 100_000:
                    raise FetchError("the cloud service sent something that is not a cloud picture")
                tmp = path.with_suffix(".part")
                tmp.write_bytes(body)
                tmp.replace(path)
                (_dir() / "clouds.json").write_text(json.dumps({"fetched_at": time.time()}), encoding="utf-8")
                _cloud_error = None
                logger.info("Weather: downloaded a fresh cloud map (%d KB)", len(body) // 1024)
            except (FetchError, LookupError) as e:
                _cloud_last_fail = time.time()
                _cloud_error = str(e) or "download failed"
                logger.info("Weather: could not refresh the cloud map (%s)", e)
        if not path.is_file():
            raise FetchError(_cloud_error or "no cloud map available yet")
        return path


def clouds_info() -> dict[str, Any]:
    meta = _meta()
    fetched = meta["fetched_at"] if meta else None
    return {
        "available": fetched is not None,
        "fetched_at": fetched,
        "age_s": time.time() - fetched if fetched else None,
        "stale": fetched is not None and time.time() - fetched > 4 * 3600,
        "error": _cloud_error,
        "credit": CLOUD_CREDIT,
    }


def forecast(lat: float, lon: float) -> dict[str, Any]:
    """Conditions now and the next 36 hours at a place: cloud cover, rain chance, temperature, visibility."""
    key = (round(lat, 1), round(lon, 1))
    hit = _forecasts.get(key)
    if hit and time.time() - hit[0] < FORECAST_CACHE_S:
        return hit[1]
    query = (
        f"{FORECAST_URL}?latitude={key[0]}&longitude={key[1]}&timezone=UTC&forecast_days=3&wind_speed_unit=kmh"
        "&current=temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,precipitation,weather_code,is_day"
        "&hourly=cloud_cover,precipitation_probability,temperature_2m,visibility"
    )
    try:
        raw = _get_json(query, timeout=25)
    except FetchError:
        if hit:  # offline: the last answer is better than none
            return {**hit[1], "stale": True}
        raise
    if not isinstance(raw, dict) or "current" not in raw or "hourly" not in raw:
        raise FetchError("the weather service sent an unexpected answer")
    hourly = raw["hourly"]
    now = time.strftime("%Y-%m-%dT%H:00", time.gmtime())
    start = next((i for i, t in enumerate(hourly["time"]) if t >= now), 0)
    end = start + 36
    out = {
        "lat": raw.get("latitude", key[0]),
        "lon": raw.get("longitude", key[1]),
        "elevation_m": raw.get("elevation"),
        "current": raw["current"],
        "hourly": {k: v[start:end] for k, v in hourly.items()},
        "stale": False,
        "credit": FORECAST_CREDIT,
    }
    _forecasts[key] = (time.time(), out)
    return out
