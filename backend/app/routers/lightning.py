"""Live lightning strikes (see app.services.lightning)."""

from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.services import app_settings
from app.services.lightning import collector

router = APIRouter(prefix="/lightning", tags=["lightning"])


class CollectIn(BaseModel):
    enabled: bool


@router.get("/strikes")
def get_strikes(since: int = Query(default=0, ge=0), max_age_s: float = Query(default=600, ge=10, le=3600)) -> dict[str, Any]:
    """Strikes newer than sequence number `since` (0: all held) and at most `max_age_s` old, oldest first."""
    return collector.strikes(since, max_age_s)


@router.get("/status")
def get_status() -> dict[str, Any]:
    return collector.status()


@router.put("/collect")
def set_collect(payload: CollectIn) -> dict[str, Any]:
    """Switch the background collection of strikes on or off (remembered)."""
    app_settings.set_lightning_enabled(payload.enabled)
    collector.set_enabled(payload.enabled)
    return collector.status()
