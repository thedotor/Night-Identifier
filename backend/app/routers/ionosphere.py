"""Global ionospheric TEC for the 3D Earth (see app.services.ionosphere)."""

from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.services import ionosphere
from app.services.deepspace import FetchError

router = APIRouter(prefix="/ionosphere", tags=["ionosphere"])


@router.get("/grid")
async def get_grid() -> dict[str, Any]:
    """Global total electron content, hour-matched to now on a recent (about 5 days old) day, as a byte grid (base64)."""
    try:
        return await run_in_threadpool(ionosphere.grid)
    except FetchError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
