"""Aurora and space weather for the 3D Earth, the dashboard and the alerts (see app.services.aurora)."""

from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.services import aurora
from app.services.deepspace import FetchError

router = APIRouter(prefix="/aurora", tags=["aurora"])


@router.get("/grid")
async def get_grid() -> dict[str, Any]:
    """NOAA OVATION aurora chance, 360 x 181 bytes (longitude 0..359, latitude -90..90, percent), base64."""
    try:
        return await run_in_threadpool(aurora.grid)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/space-weather")
async def get_space_weather() -> dict[str, Any]:
    """Kp now and forecast, solar wind and Bz over the last 3 hours, and hemispheric power."""
    try:
        return await run_in_threadpool(aurora.space_weather)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
