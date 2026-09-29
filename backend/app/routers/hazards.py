"""Live earthquakes, volcanoes and satellite heat spots for the 3D Earth (see app.services.hazards)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.services import app_settings
from app.services.hazards import hazards

router = APIRouter(prefix="/hazards", tags=["hazards"])


class KeyIn(BaseModel):
    key: str = ""


@router.get("/quakes")
async def get_quakes(min_mag: float = Query(1.0, ge=-2, le=10), hours: float = Query(720.0, gt=0, le=744)) -> dict[str, Any]:
    """Earthquakes (rows of [id, time_ms, lat, lon, depth_km, magnitude, tsunami]) at or above `min_mag` in the last `hours`, newest first."""
    return await run_in_threadpool(hazards.quakes, min_mag, hours)


@router.get("/quakes/recent")
async def get_recent_quakes(min_mag: float = Query(4.5, ge=-2, le=10), hours: float = Query(24.0, gt=0, le=744), limit: int = Query(60, ge=1, le=300), by: str = Query("time")) -> dict[str, Any]:
    """The newest (by=time) or biggest (by=mag) earthquakes with their place names."""
    return await run_in_threadpool(hazards.recent_quakes, min_mag, hours, limit, "mag" if by == "mag" else "time")


@router.get("/quake/{quake_id}")
def get_quake(quake_id: str) -> dict[str, Any]:
    q = hazards.quake(quake_id)
    if q is None:
        raise HTTPException(status_code=404, detail="no such earthquake")
    return q


@router.get("/volcanoes")
async def get_volcanoes() -> dict[str, Any]:
    """About 1,600 volcanoes (rows of [number, lat, lon, activity level 0 to 3]) and the details of those with activity now."""
    return await run_in_threadpool(hazards.volcanoes)


@router.get("/volcano/{vnum}")
def get_volcano(vnum: int) -> dict[str, Any]:
    v = hazards.volcano(vnum)
    if v is None:
        raise HTTPException(status_code=404, detail="no such volcano")
    return v


@router.get("/heat")
async def get_heat() -> dict[str, Any]:
    """NASA FIRMS heat detections of the last day (rows of [lat, lon, power_MW, time_s]); empty without a FIRMS key."""
    return await run_in_threadpool(hazards.heat)


@router.get("/status")
def get_status() -> dict[str, Any]:
    return {"has_firms_key": bool(app_settings.get_firms_key()), "sources": hazards.status}


@router.put("/firms-key")
def put_firms_key(payload: KeyIn) -> dict[str, Any]:
    """Save (or clear, with an empty key) the free NASA FIRMS map key."""
    key = payload.key.strip()
    if key and not (16 <= len(key) <= 64 and key.isalnum()):
        raise HTTPException(status_code=422, detail="that does not look like a FIRMS map key")
    app_settings.set_firms_key(key)
    return {"has_firms_key": bool(key)}
