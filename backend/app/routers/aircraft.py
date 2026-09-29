"""Live aircraft for the sky overlay and the 3D Earth (see app.services.aircraft)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from app.services import aircraft
from app.services.deepspace import FetchError

router = APIRouter(prefix="/aircraft", tags=["aircraft"])


@router.get("/nearby")
async def get_nearby(
    lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), radius_nm: int = Query(default=150, ge=5, le=aircraft.MAX_RADIUS_NM)
) -> dict[str, Any]:
    try:
        return await run_in_threadpool(aircraft.nearby, lat, lon, radius_nm)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/world")
async def get_world() -> dict[str, Any]:
    try:
        return await run_in_threadpool(aircraft.world)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
