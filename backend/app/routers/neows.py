"""Near-Earth asteroid close approaches for the Solar System view (see app.services.neows)."""

from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.services import neows
from app.services.deepspace import FetchError

router = APIRouter(prefix="/neows", tags=["neows"])


@router.get("/close-approaches")
async def get_close_approaches() -> dict[str, Any]:
    """Asteroids passing near Earth in the coming week, soonest first."""
    try:
        return await run_in_threadpool(neows.close_approaches)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
