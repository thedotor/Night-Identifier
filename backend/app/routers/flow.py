"""Wind and sea currents for the 3D Earth (see app.services.flow)."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.services import flow
from app.services.deepspace import FetchError

router = APIRouter(prefix="/flow", tags=["flow"])


def _reply(data: bytes, meta: dict) -> Response:
    headers = {
        "X-Valid-Time": str(meta["valid"]),
        "X-Range": str(meta["range"]),
        "X-First-Time": str(meta["first"]),
        "X-Last-Time": str(meta["last"]),
        "X-Lon0": str(meta["lon0"]),
        "X-Credit": meta["credit"],
        "Access-Control-Expose-Headers": "X-Valid-Time, X-Range, X-First-Time, X-Last-Time, X-Lon0, X-Credit",
        "Cache-Control": "max-age=300",
    }
    return Response(content=data, media_type="image/png", headers=headers)


@router.get("/wind")
async def get_wind(level: str = Query("10m"), t: int | None = None) -> Response:
    """The wind picture (level: 10m, 850, 500 or 250) for the 3-hour step nearest `t` (ms since 1970; default now)."""
    if level not in flow.WIND_LEVELS:
        raise HTTPException(status_code=422, detail="unknown wind level")
    try:
        data, meta = await run_in_threadpool(flow.wind_frame, level, t)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="No wind data for that date") from e
    except (FetchError, ImportError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Could not get the wind: {e}") from e
    return _reply(data, meta)


@router.get("/currents")
async def get_currents(t: int | None = None) -> Response:
    """The surface-current picture for the hour nearest `t` (ms since 1970; default now)."""
    try:
        data, meta = await run_in_threadpool(flow.currents_frame, t)
    except LookupError as e:
        raise HTTPException(status_code=404, detail="No current data for that date") from e
    except (FetchError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Could not get the currents: {e}") from e
    return _reply(data, meta)
