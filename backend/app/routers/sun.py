"""The live Sun for the 3D Solar System, the dashboard and the alerts (see app.services.sun)."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.services import app_settings, sun
from app.services.deepspace import FetchError

router = APIRouter(prefix="/sun", tags=["sun"])


def _when(date: str | None) -> datetime | None:
    if not date:
        return None
    dt = sun._parse(date)
    if dt is None:
        raise HTTPException(status_code=422, detail="bad date")
    return dt


@router.get("/image")
async def get_image(kind: str = Query("visual"), date: str | None = None) -> Response:
    """A picture of the Sun (kind: visual, magnetogram, euv, euv304, euv171, c2, c3), latest or near `date`. The X-Image-Time header says when it was taken."""
    if kind not in sun.KINDS:
        raise HTTPException(status_code=422, detail="unknown kind")
    when = _when(date)
    try:
        data, taken = await run_in_threadpool(sun.image, kind, when)
    except (FetchError, LookupError) as e:
        raise HTTPException(status_code=502, detail=f"could not get the solar picture ({e})") from e
    return Response(content=data, media_type="image/jpeg", headers={"X-Image-Time": taken, "Access-Control-Expose-Headers": "X-Image-Time", "Cache-Control": "max-age=300"})


@router.get("/activity")
async def get_activity(date: str | None = None) -> dict[str, Any]:
    """X-ray flux, proton flux, flares, sunspot groups and CMEs (with Earth arrival) for now, or for the days before `date`."""
    when = _when(date)
    try:
        return await run_in_threadpool(sun.activity, when)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


class SunSettings(BaseModel):
    nasa_api_key: str = ""


@router.get("/settings")
async def get_settings() -> dict[str, Any]:
    return {"has_nasa_api_key": bool(app_settings.get_nasa_api_key())}


@router.put("/settings")
async def put_settings(payload: SunSettings) -> dict[str, Any]:
    key = payload.nasa_api_key.strip()
    if key and (len(key) > 80 or not key.replace("-", "").replace("_", "").isalnum()):
        raise HTTPException(status_code=422, detail="that does not look like a NASA API key")
    app_settings.set_nasa_api_key(key)
    sun._mem.clear()
    return {"has_nasa_api_key": bool(key)}
