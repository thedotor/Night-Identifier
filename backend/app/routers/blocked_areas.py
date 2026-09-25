from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.image import Image

router = APIRouter(tags=["blocked-areas"])


class BlockedAreas(BaseModel):
    regions: list[list[list[float]]]  # polygons: [[x, y], ...], 3+ points, image pixels


@router.get("/images/{image_id}/blocked-areas", response_model=BlockedAreas)
def get_blocked_areas(image_id: int, db: Session = Depends(get_db)) -> BlockedAreas:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return BlockedAreas(regions=image.blocked_regions or [])


@router.put("/images/{image_id}/blocked-areas", response_model=BlockedAreas)
def set_blocked_areas(image_id: int, payload: BlockedAreas, db: Session = Depends(get_db)) -> BlockedAreas:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    if any(len(region) < 3 for region in payload.regions):
        raise HTTPException(status_code=400, detail="each region needs at least 3 points")
    image.blocked_regions = payload.regions
    db.commit()
    return BlockedAreas(regions=image.blocked_regions)
