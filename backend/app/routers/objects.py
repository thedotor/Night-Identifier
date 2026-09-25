from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models.object_type import ObjectType
from app.services.image_processing import generate_preview

router = APIRouter(prefix="/objects", tags=["objects"])


class ObjectTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    kind: str = "object"
    reference_image_path: str | None


class ObjectTypeCreate(BaseModel):
    name: str
    description: str = ""


class ReferenceImageRequest(BaseModel):
    path: str


class ObjectTypeUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


@router.get("", response_model=list[ObjectTypeOut])
def list_object_types(kind: str = "object", db: Session = Depends(get_db)) -> list[ObjectType]:
    """kind: "object" (default -- what Annotate and the Object Library work with),
    or "all" (includes classes left over from the removed constellation detector)."""
    query = select(ObjectType).order_by(ObjectType.name)
    if kind != "all":
        query = query.where(ObjectType.kind == kind)
    return list(db.scalars(query))


@router.post("", response_model=ObjectTypeOut, status_code=201)
def create_object_type(payload: ObjectTypeCreate, db: Session = Depends(get_db)) -> ObjectType:
    existing = db.scalar(select(ObjectType).where(ObjectType.name == payload.name))
    if existing:
        raise HTTPException(status_code=409, detail="An object type with this name already exists")
    obj = ObjectType(name=payload.name, description=payload.description)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{object_id}", response_model=ObjectTypeOut)
def update_object_type(
    object_id: int, payload: ObjectTypeUpdate, db: Session = Depends(get_db)
) -> ObjectType:
    obj = db.get(ObjectType, object_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Object type not found")

    if payload.name is not None and payload.name.strip() and payload.name != obj.name:
        existing = db.scalar(select(ObjectType).where(ObjectType.name == payload.name))
        if existing:
            raise HTTPException(status_code=409, detail="An object type with this name already exists")
        obj.name = payload.name.strip()

    if payload.description is not None:
        obj.description = payload.description

    db.commit()
    db.refresh(obj)
    return obj


@router.put("/{object_id}/reference-image", response_model=ObjectTypeOut)
def set_reference_image(
    object_id: int, payload: ReferenceImageRequest, db: Session = Depends(get_db)
) -> ObjectType:
    obj = db.get(ObjectType, object_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Object type not found")

    src = Path(payload.path)
    if not src.exists():
        raise HTTPException(status_code=400, detail="File not found")

    settings.ensure_dirs()
    dest = settings.reference_images_dir / f"{object_id}.jpg"
    try:
        generate_preview(src, dest)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read image: {exc}") from exc

    obj.reference_image_path = str(dest)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("/{object_id}/reference-image")
def get_reference_image(object_id: int, db: Session = Depends(get_db)) -> FileResponse:
    obj = db.get(ObjectType, object_id)
    if not obj or not obj.reference_image_path or not Path(obj.reference_image_path).exists():
        raise HTTPException(status_code=404, detail="No reference image set")
    return FileResponse(obj.reference_image_path, media_type="image/jpeg")


@router.delete("/{object_id}", status_code=204)
def delete_object_type(object_id: int, db: Session = Depends(get_db)) -> None:
    obj = db.get(ObjectType, object_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Object type not found")
    if obj.reference_image_path:
        Path(obj.reference_image_path).unlink(missing_ok=True)
    db.delete(obj)
    db.commit()
