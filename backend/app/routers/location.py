"""Where this computer is, roughly, from its internet address (an optional setting: the app never asks unless the user chose "Internet").

The lookup goes through the backend so the app's web pages keep a short list of places they may talk to. Only the request itself reveals the
public IP address to the lookup service (ipwho.is, free, no account); the address is not stored or returned.
"""

import json
import time
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.services import log_capture

router = APIRouter(prefix="/location", tags=["location"])
logger = log_capture.get_logger("location")

SERVICE = "https://ipwho.is/?fields=success,message,city,region,country,latitude,longitude"
CREDIT = "Approximate place from your internet address: ipwho.is"


def _lookup() -> dict[str, Any]:
    req = urllib.request.Request(SERVICE, headers={"User-Agent": "NightIdentifier/1.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read(65536).decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Could not reach the location service ({getattr(e, 'reason', e)})") from e
    if not data.get("success"):
        raise HTTPException(status_code=502, detail=str(data.get("message") or "The location service gave no answer"))
    try:
        lat, lon = float(data["latitude"]), float(data["longitude"])
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=502, detail="The location service gave no coordinates") from e
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(status_code=502, detail="The location service gave impossible coordinates")
    logger.info("Internet location: %s, %s", data.get("city") or "?", data.get("country") or "?")
    return {
        "latitude": round(lat, 4),
        "longitude": round(lon, 4),
        "city": str(data.get("city") or ""),
        "region": str(data.get("region") or ""),
        "country": str(data.get("country") or ""),
        "looked_up_at": time.time(),
        "credit": CREDIT,
    }


@router.post("/lookup")
async def lookup() -> dict[str, Any]:
    """Look the place up now (city-level accuracy: typically within a few tens of kilometres)."""
    return await run_in_threadpool(_lookup)
