"""Full-sky overlay: static catalogue, EXIF-derived camera/observer defaults
and per-image saved alignment. The projection/alignment maths itself runs in
the frontend (lib/skyMath.ts) so dragging the overlay stays interactive."""

import datetime as dt
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.data.asterisms import ASTERISMS
from app.data.constellations import CONSTELLATIONS
from app.db import get_db
from app.models.image import Image
from app.models.sky_alignment import SkyAlignment
from app.services.lens_correction import get_fisheye_correction
from app.services.blocked_areas import in_any_region
from app.services.sky_art import art_anchors, art_path
from app.services.star_detection import detect_stars
from app.services.sky_context import _FULL_FRAME_DIAG_MM, _read_exif, build_sky_context

router = APIRouter(prefix="/sky", tags=["sky"])

_CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "data" / "sky" / "catalogue.json"


@lru_cache(maxsize=1)
def _catalogue() -> dict[str, Any]:
    raw = json.loads(_CATALOGUE_PATH.read_text(encoding="utf-8"))
    figures = []
    for shapes, kind in ((CONSTELLATIONS, "constellation"), (ASTERISMS, "asterism")):
        for c in shapes:
            figures.append(
                {
                    "abbr": c.abbr,
                    "name": c.name,
                    "kind": kind,
                    "stars": [
                        {"ra": round(s.ra_deg % 360.0, 4), "dec": s.dec_deg, "mag": s.mag, "name": s.name}
                        for s in c.stars
                    ],
                    "lines": [[a, b] for a, b in c.lines],
                }
            )
    return {**raw, "figures": figures, "art": art_anchors()}


@router.get("/catalogue")
def get_catalogue() -> dict[str, Any]:
    """Everything drawable, RA/Dec in decimal degrees (J2000)."""
    return _catalogue()


@router.get("/art/{abbr}")
def get_art(abbr: str) -> FileResponse:
    """The illustration for one constellation."""
    path = art_path(abbr)
    if path is None:
        raise HTTPException(status_code=404, detail="No artwork for this constellation")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


class ObserverInit(BaseModel):
    latitude: float | None = None
    longitude: float | None = None
    # Best-known UTC time at the middle of the exposure (ISO 8601, no zone),
    # and how trustworthy it is: "gps" | "offset" | "longitude" | None.
    utc: str | None = None
    time_source: str | None = None
    local: str | None = None
    exposure_s: float | None = None


class SkyInitOut(BaseModel):
    width: int
    height: int
    projection: str  # "rectilinear" | "equidistant"
    fov_h_deg: float | None = None  # horizontal field of view across the image width
    focal_mm: float | None = None
    focal_35mm: float | None = None
    lens_model: str | None = None
    camera_model: str | None = None
    observer: ObserverInit


def _fov_h(projection: str, focal_35mm: float | None, width: int, height: int) -> float | None:
    if not focal_35mm or width <= 0 or height <= 0:
        return None
    f_px = focal_35mm * math.hypot(width, height) / _FULL_FRAME_DIAG_MM
    half = (width / 2.0) / f_px
    rad = 2.0 * (math.atan(half) if projection == "rectilinear" else half)
    return min(math.degrees(rad), 359.0)


@router.get("/{image_id}/init", response_model=SkyInitOut)
def get_init(image_id: int, db: Session = Depends(get_db)) -> SkyInitOut:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    path = Path(image.stored_path)
    ctx = build_sky_context(path, image.width, image.height, image.latitude, image.longitude, image.captured_at)
    fisheye = get_fisheye_correction(path, image.width, image.height)
    projection = "equidistant" if fisheye else "rectilinear"

    _main, exif_ifd, _gps = _read_exif(path)
    try:
        exposure = float(exif_ifd.get(33434)) if exif_ifd.get(33434) else None  # ExposureTime
    except (TypeError, ValueError, ZeroDivisionError):
        exposure = None

    # Sidereal motion is ~15 arcsec/s, so a long exposure is best represented
    # at its midpoint, not shutter-open.
    utc = ctx.time.utc
    if utc is not None and exposure:
        utc = utc + dt.timedelta(seconds=exposure / 2.0)

    return SkyInitOut(
        width=image.width,
        height=image.height,
        projection=projection,
        fov_h_deg=_fov_h(projection, ctx.optics.focal_35mm, image.width, image.height),
        focal_mm=ctx.optics.focal_mm,
        focal_35mm=ctx.optics.focal_35mm,
        lens_model=ctx.optics.lens_model,
        camera_model=ctx.optics.camera_model,
        observer=ObserverInit(
            latitude=ctx.latitude,
            longitude=ctx.longitude,
            utc=utc.isoformat() if utc else None,
            time_source=ctx.time.source,
            local=ctx.time.local.isoformat() if ctx.time.local else None,
            exposure_s=exposure,
        ),
    )


MAX_ALIGN_STARS = 120


@router.get("/{image_id}/stars")
def get_detected_stars(image_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Point sources found in the photo, in full-resolution image pixels, brightest first.
    Feeds auto-alignment and the star hints shown while point-picking. No lens
    remapping here: the camera model in the frontend already accounts for the lens."""
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    found = detect_stars(
        Path(image.preview_path),
        max_stars=MAX_ALIGN_STARS,
        target_size=(image.width, image.height),
        source_path=Path(image.stored_path),
    )
    blocked = image.blocked_regions or []
    kept = [(x, y, b) for x, y, b in found if not in_any_region(x, y, blocked)]
    return {"stars": [[round(x, 2), round(y, 2), round(b, 1)] for x, y, b in kept]}


class AlignmentIO(BaseModel):
    camera: dict | None = None
    pairs: list | None = None
    observer: dict | None = None
    layers: dict | None = None


@router.get("/{image_id}/alignment", response_model=AlignmentIO)
def get_alignment(image_id: int, db: Session = Depends(get_db)) -> AlignmentIO:
    row = db.get(SkyAlignment, image_id)
    if row is None:
        return AlignmentIO()
    return AlignmentIO(camera=row.camera, pairs=row.pairs, observer=row.observer, layers=row.layers)


@router.put("/{image_id}/alignment", response_model=AlignmentIO)
def put_alignment(image_id: int, payload: AlignmentIO, db: Session = Depends(get_db)) -> AlignmentIO:
    if db.get(Image, image_id) is None:
        raise HTTPException(status_code=404, detail="Image not found")
    row = db.get(SkyAlignment, image_id)
    if row is None:
        row = SkyAlignment(image_id=image_id)
        db.add(row)
    row.camera, row.pairs, row.observer, row.layers = (
        payload.camera,
        payload.pairs,
        payload.observer,
        payload.layers,
    )
    row.updated_at = dt.datetime.utcnow()
    db.commit()
    return payload
