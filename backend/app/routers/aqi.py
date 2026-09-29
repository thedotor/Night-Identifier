"""Air quality stations for the 3D Earth (see app.services.aqi). Needs a free OpenAQ key."""

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.services import app_settings
from app.services.aqi import stations as aqi_stations
from app.services.deepspace import FetchError

router = APIRouter(prefix="/aqi", tags=["aqi"])


class KeyIn(BaseModel):
    key: str = ""


@router.get("/status")
def get_status() -> dict[str, Any]:
    return {"has_openaq_key": bool(app_settings.get_openaq_key())}


@router.put("/openaq-key")
def put_openaq_key(payload: KeyIn) -> dict[str, Any]:
    """Save (or clear, with an empty key) the free OpenAQ API key. Required: the air quality layer shows nothing without one."""
    key = payload.key.strip()
    if key and not (10 <= len(key) <= 100):
        raise HTTPException(status_code=422, detail="that does not look like an OpenAQ key")
    app_settings.set_openaq_key(key)
    return {"has_openaq_key": bool(key)}


@router.get("/stations")
async def get_stations() -> dict[str, Any]:
    try:
        return await run_in_threadpool(aqi_stations)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
