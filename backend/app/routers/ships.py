"""Live ships for the 3D Earth (see app.services.ships)."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.services import app_settings, ships

router = APIRouter(prefix="/ships", tags=["ships"])


class KeyIn(BaseModel):
    key: str = ""


@router.get("/world")
async def get_world() -> dict[str, Any]:
    """Every ship with a recent position: rows of [mmsi, lat, lon, speed_kn, course, category, time]."""
    return await run_in_threadpool(ships.feed.world)


@router.get("/search")
async def search(q: str = Query(min_length=1, max_length=60)) -> list[dict[str, Any]]:
    """Ships whose name or MMSI contains the text (at least 3 characters)."""
    return await run_in_threadpool(ships.feed.search, q)


@router.get("/ship/{mmsi}")
async def get_ship(mmsi: int) -> dict[str, Any]:
    info = await run_in_threadpool(ships.feed.ship, mmsi)
    if info is None:
        raise HTTPException(status_code=404, detail="no such ship")
    return info


@router.get("/status")
def get_status() -> dict[str, Any]:
    return {"has_key": bool(app_settings.get_aisstream_key()), "sources": ships.feed.status}


@router.put("/key")
def put_key(payload: KeyIn) -> dict[str, Any]:
    """Save (or clear, with an empty key) the free aisstream.io API key that turns on worldwide coverage."""
    key = payload.key.strip()
    if key and not (16 <= len(key) <= 80 and key.replace("-", "").isalnum()):
        raise HTTPException(status_code=422, detail="that does not look like an aisstream.io API key")
    app_settings.set_aisstream_key(key)
    return {"has_key": bool(key)}
