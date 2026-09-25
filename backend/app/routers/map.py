from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends

from app.db import get_db
from app.models.image import Image, ImageCategory

router = APIRouter(prefix="/map", tags=["map"])


class MapImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    latitude: float
    longitude: float
    captured_at: str | None

    @staticmethod
    def from_image(image: Image) -> "MapImageOut":
        return MapImageOut(
            id=image.id,
            filename=image.filename,
            latitude=image.latitude,
            longitude=image.longitude,
            captured_at=image.captured_at.isoformat() if image.captured_at else None,
        )


@router.get("/images", response_model=list[MapImageOut])
def list_geotagged_images(db: Session = Depends(get_db)) -> list[MapImageOut]:
    images = list(
        db.scalars(
            select(Image).where(
                Image.category == ImageCategory.LIBRARY,
                Image.latitude.is_not(None),
                Image.longitude.is_not(None),
            )
        )
    )
    return [MapImageOut.from_image(img) for img in images]
