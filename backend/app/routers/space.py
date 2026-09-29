"""The Earth's magnetic environment and the solar wind flow (see app.services.heliosphere)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from app.services import heliosphere
from app.services.deepspace import FetchError

router = APIRouter(prefix="/space", tags=["space"])


def _fail(e: Exception) -> HTTPException:
    return HTTPException(status_code=502, detail=str(e))


@router.get("/dst")
async def get_dst() -> dict[str, Any]:
    """Dst (storm-time disturbance) hourly for the last week, and NOAA's hour-ahead estimate."""
    try:
        return await run_in_threadpool(heliosphere.dst)
    except FetchError as e:
        raise _fail(e) from e


@router.get("/stations")
async def get_stations() -> dict[str, Any]:
    """Live readings from the USGS ground magnetometers (US territory only)."""
    try:
        return await run_in_threadpool(heliosphere.stations)
    except FetchError as e:
        raise _fail(e) from e


@router.get("/enlil/frames")
async def get_enlil_frames() -> dict[str, Any]:
    try:
        frames = await run_in_threadpool(heliosphere.enlil_frames)
    except FetchError as e:
        raise _fail(e) from e
    return {"first": frames[0]["t"], "last": frames[-1]["t"], "count": len(frames), "credit": heliosphere.CREDIT_ENLIL}


@router.get("/enlil/image")
async def get_enlil_image(panel: str = Query("density"), t: int | None = None) -> Response:
    """The Enlil picture (panel: density or velocity), cropped to the circle, for the frame nearest `t` (ms since 1970; default now)."""
    if panel not in heliosphere.ENLIL_PANELS:
        raise HTTPException(status_code=422, detail="unknown panel")
    try:
        data, frame, first, last = await run_in_threadpool(heliosphere.enlil_image, panel, t)
    except (FetchError, LookupError) as e:
        raise _fail(e) from e
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "X-Frame-Time": str(frame),
            "X-First-Frame": str(first),
            "X-Last-Frame": str(last),
            "X-Au-Fraction": f"{heliosphere.ENLIL_AU_PX / heliosphere.ENLIL_RADIUS_PX:.5f}",
            "Access-Control-Expose-Headers": "X-Frame-Time, X-First-Frame, X-Last-Frame, X-Au-Fraction",
            "Cache-Control": "max-age=600",
        },
    )


@router.get("/enlil/earth")
async def get_enlil_earth() -> dict[str, Any]:
    """NOAA's WSA-Enlil forecast of the wind at Earth, hourly for about a week."""
    try:
        return await run_in_threadpool(heliosphere.enlil_earth)
    except FetchError as e:
        raise _fail(e) from e
