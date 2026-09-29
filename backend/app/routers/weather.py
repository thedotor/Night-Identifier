"""Live weather for the dashboard and the 3D Earth (see app.services.weather)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.services import rainviewer, weather
from app.services.deepspace import FetchError

router = APIRouter(prefix="/weather", tags=["weather"])


@router.get("")
def get_forecast(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180)) -> dict[str, Any]:
    try:
        return weather.forecast(lat, lon)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Could not get the weather: {e}") from e


@router.get("/clouds")
def get_clouds() -> FileResponse:
    """The world cloud picture (equirectangular, 4096x2048 greyscale, bright = cloud)."""
    try:
        path = weather.clouds_path()
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Could not get the cloud map: {e}") from e
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})


@router.get("/clouds/info")
def get_clouds_info() -> dict[str, Any]:
    return weather.clouds_info()


@router.get("/rain")
def get_rain() -> FileResponse:
    """The world precipitation radar/satellite composite (equirectangular PNG, transparent where there is no rain)."""
    try:
        path = rainviewer.build_rain_map()
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Could not get the rain map: {e}") from e
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@router.get("/rain/info")
def get_rain_info() -> dict[str, Any]:
    try:
        return rainviewer.rain_info()
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Could not get the rain map info: {e}") from e
