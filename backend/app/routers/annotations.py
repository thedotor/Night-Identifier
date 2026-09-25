from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.annotation import Annotation, AnnotationSource, ShapeType
from app.models.image import Image

router = APIRouter(tags=["annotations"])


class AnnotationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    image_id: int
    object_type_id: int
    shape_type: ShapeType
    geometry: dict[str, Any]


class AnnotationCreate(BaseModel):
    object_type_id: int
    shape_type: ShapeType
    geometry: dict[str, Any]


class AnnotationUpdate(BaseModel):
    object_type_id: int | None = None
    geometry: dict[str, Any] | None = None


@router.get("/images/{image_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(image_id: int, db: Session = Depends(get_db)) -> list[Annotation]:
    # Manual labels only: model detections (Results Gallery) live separately
    # so they don't clutter the labeling workspace or get treated as ground truth.
    return list(
        db.scalars(
            select(Annotation).where(
                Annotation.image_id == image_id,
                Annotation.source == AnnotationSource.MANUAL,
                # Constellation labels belong to the Sky Overlay, not the object workspace.
                or_(Annotation.origin.is_(None), Annotation.origin != "sky_overlay"),
            )
        )
    )


@router.post("/images/{image_id}/annotations", response_model=AnnotationOut, status_code=201)
def create_annotation(
    image_id: int, payload: AnnotationCreate, db: Session = Depends(get_db)
) -> Annotation:
    if not db.get(Image, image_id):
        raise HTTPException(status_code=404, detail="Image not found")

    annotation = Annotation(
        image_id=image_id,
        object_type_id=payload.object_type_id,
        shape_type=payload.shape_type,
        geometry=payload.geometry,
        source=AnnotationSource.MANUAL,
    )
    db.add(annotation)
    db.commit()
    db.refresh(annotation)
    return annotation


@router.put("/annotations/{annotation_id}", response_model=AnnotationOut)
def update_annotation(
    annotation_id: int, payload: AnnotationUpdate, db: Session = Depends(get_db)
) -> Annotation:
    annotation = db.get(Annotation, annotation_id)
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")

    if payload.object_type_id is not None:
        annotation.object_type_id = payload.object_type_id
    if payload.geometry is not None:
        annotation.geometry = payload.geometry

    db.commit()
    db.refresh(annotation)
    return annotation


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: int, db: Session = Depends(get_db)) -> None:
    annotation = db.get(Annotation, annotation_id)
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")
    db.delete(annotation)
    db.commit()
