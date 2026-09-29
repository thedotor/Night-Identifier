"""Rocket launches for the Solar System view (see app.services.launches)."""

from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.services import launches
from app.services.deepspace import FetchError

router = APIRouter(prefix="/launches", tags=["launches"])


@router.get("/upcoming")
async def get_upcoming() -> dict[str, Any]:
    """Upcoming and recently completed orbital launches, soonest first."""
    try:
        return await run_in_threadpool(launches.upcoming)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
