"""Comets, asteroid close approaches and the cloud outlook for the sky-events calendar (see app.services.sky_events)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from app.services import sky_events
from app.services.deepspace import FetchError

router = APIRouter(prefix="/events", tags=["events"])


def _fail(e: Exception) -> HTTPException:
    return HTTPException(status_code=502, detail=str(e))


@router.get("/comets")
async def get_comets() -> dict[str, Any]:
    try:
        return await run_in_threadpool(sky_events.comets)
    except FetchError as e:
        raise _fail(e) from e


@router.get("/asteroids")
async def get_asteroids() -> dict[str, Any]:
    try:
        return await run_in_threadpool(sky_events.asteroids)
    except FetchError as e:
        raise _fail(e) from e


@router.get("/outlook")
async def get_outlook(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)) -> dict[str, Any]:
    try:
        return await run_in_threadpool(sky_events.outlook, lat, lon)
    except FetchError as e:
        raise _fail(e) from e
