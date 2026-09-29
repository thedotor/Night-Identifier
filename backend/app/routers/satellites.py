"""Satellite orbit elements for the sky overlays (fetched from CelesTrak, cached on disk by
app.services.satellites). The orbit maths itself runs in the frontend."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.services import satellites

router = APIRouter(prefix="/satellites", tags=["satellites"])


@router.get("")
def get_satellites(groups: str = Query(default="stations,visual", description="comma list of iss, stations, visual, starlink, active")) -> dict[str, Any]:
    """Compact orbit elements for the union of the requested groups: {fields, rows, fetched_at, stale, missing, offline, credit}."""
    wanted = {g.strip() for g in groups.split(",") if g.strip()}
    bad = wanted - set(satellites.GROUP_BITS)
    if bad or not wanted:
        raise HTTPException(status_code=400, detail=f"Unknown satellite group: {', '.join(sorted(bad)) or '(none)'}")
    return satellites.rows_for(wanted)


@router.get("/status")
def get_status() -> dict[str, Any]:
    return satellites.status()


@router.post("/refresh")
def refresh() -> dict[str, Any]:
    """Download fresh elements now (data sets fetched under two hours ago are left alone)."""
    return satellites.refresh()


@router.delete("/cache")
def clear_cache() -> dict[str, Any]:
    satellites.clear()
    return satellites.status()
