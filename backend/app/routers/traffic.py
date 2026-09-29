"""Where this PC's web traffic goes (see app.services.traffic). Everything here is local: nothing is sent to a third party."""

import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services import app_settings, geoip
from app.services.traffic import monitor

router = APIRouter(prefix="/traffic", tags=["traffic"])

_PLACE_ID = re.compile(r"^-?\d{1,3}\.\d{2},-?\d{1,3}\.\d{2}$")


class EnabledIn(BaseModel):
    enabled: bool


class HistoryIn(BaseModel):
    keep: bool


class HostIn(BaseModel):
    ip: str


def _place(place_id: str) -> str:
    if not _PLACE_ID.match(place_id):
        raise HTTPException(status_code=400, detail="Bad destination id")
    return place_id


@router.get("/status")
def get_status() -> dict[str, Any]:
    return monitor.status()


@router.put("/enabled")
def set_enabled(payload: EnabledIn) -> dict[str, Any]:
    """Switch reading the connection table on or off (remembered). Switching off forgets the live picture."""
    app_settings.set_traffic_enabled(payload.enabled)
    monitor.set_enabled(payload.enabled)
    return monitor.status()


@router.get("/live")
def get_live() -> dict[str, Any]:
    """Destinations right now (no addresses), with tallies by country and program."""
    return monitor.live()


@router.get("/place/{place_id}")
def get_place(place_id: str) -> dict[str, Any]:
    """One destination with its addresses, for when the user expands it."""
    found = monitor.detail(_place(place_id))
    if found is None:
        raise HTTPException(status_code=404, detail="That destination is no longer connected")
    return found


@router.post("/place/{place_id}/host")
def look_up_host(place_id: str, payload: HostIn) -> dict[str, Any]:
    """Reverse-DNS name of one tracked address. The lookup goes to this PC's DNS server, so it happens only on request."""
    return {"ip": payload.ip, "host": monitor.hostname(_place(place_id), payload.ip)}


@router.get("/history")
def get_history(days: int = Query(default=7, ge=1, le=7)) -> dict[str, Any]:
    return monitor.history(days)


@router.put("/history/keep")
def set_history(payload: HistoryIn) -> dict[str, Any]:
    """Keep (or stop adding to) the 7-day encrypted history. Existing history stays until it is cleared or expires."""
    app_settings.set_traffic_history(payload.keep)
    monitor.set_history(payload.keep)
    return monitor.status()


@router.delete("/history")
def clear_history() -> dict[str, Any]:
    monitor.clear_history()
    return monitor.history()


@router.get("/database/status")
def get_database_status() -> dict[str, Any]:
    """Which city and network-owner databases are in use and how old they are."""
    return {"city": geoip.info(), "asn": geoip.asn_info()}


@router.post("/database/update")
def update_database() -> dict[str, Any]:
    """Download the newest DB-IP Lite city database into the data folder."""
    try:
        return geoip.update()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Could not download the IP database: {e}") from e


@router.post("/database/update-asn")
def update_asn_database() -> dict[str, Any]:
    """Download the newest DB-IP Lite ASN (network-owner) database into the data folder."""
    try:
        return geoip.asn_update()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Could not download the network-owner database: {e}") from e
