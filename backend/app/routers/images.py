from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.annotation import Annotation, AnnotationSource
from app.models.image import Image, ImageCategory, ImageStatus
from app.services import app_settings, events
from app.services.folder_sort import remove_linked_copies
from app.services.image_import import ImportOutcome, import_paths
from app.services.watcher import watcher

router = APIRouter(prefix="/images", tags=["images"])


class ImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    width: int
    height: int
    file_size_bytes: int
    status: ImageStatus
    category: ImageCategory
    latitude: float | None = None
    longitude: float | None = None


class ImportRequest(BaseModel):
    paths: list[str]
    category: ImageCategory = ImageCategory.LIBRARY
    move: bool = False


class ImportResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    imported: list[ImageOut]
    skipped: list[str]


class WatchFolderOut(BaseModel):
    watch_dir: str
    watching: bool


class WatchFolderIn(BaseModel):
    path: str


@router.get("", response_model=list[ImageOut])
def list_images(
    category: ImageCategory = ImageCategory.LIBRARY, db: Session = Depends(get_db)
) -> list[Image]:
    return list(
        db.scalars(
            select(Image).where(Image.category == category).order_by(Image.created_at.desc())
        )
    )


@router.get("/stats")
def image_stats(
    category: ImageCategory = ImageCategory.TRAINING, db: Session = Depends(get_db)
) -> dict:
    total = len(list(db.scalars(select(Image).where(Image.category == category))))
    annotated_ids = set(
        db.scalars(
            select(Annotation.image_id).where(Annotation.source == AnnotationSource.MANUAL).distinct()
        )
    )
    return {"total": total, "pending": total - len(annotated_ids)}


@router.post("/import", response_model=ImportResult)
def import_images(payload: ImportRequest, db: Session = Depends(get_db)) -> ImportOutcome:
    return import_paths(payload.paths, db, category=payload.category, move=payload.move)


@router.get("/{image_id}/preview")
def get_preview(image_id: int, db: Session = Depends(get_db)) -> FileResponse:
    image = db.get(Image, image_id)
    if not image or not Path(image.preview_path).exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(image.preview_path, media_type="image/jpeg")


@router.get("/{image_id}/properties")
def get_properties(image_id: int, db: Session = Depends(get_db)) -> dict:
    image = db.get(Image, image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    return {
        "filename": image.filename,
        "width": image.width,
        "height": image.height,
        "file_size_bytes": image.file_size_bytes,
        "stored_path": image.stored_path,
        "status": image.status.value,
        "created_at": image.created_at.isoformat(),
    }


@router.delete("/{image_id}", status_code=204)
def delete_image(image_id: int, db: Session = Depends(get_db)) -> None:
    image = db.get(Image, image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    remove_linked_copies(image)
    Path(image.stored_path).unlink(missing_ok=True)
    Path(image.preview_path).unlink(missing_ok=True)
    db.delete(image)
    db.commit()


@router.get("/watch-folder", response_model=WatchFolderOut)
def get_watch_folder() -> WatchFolderOut:
    return WatchFolderOut(watch_dir=str(app_settings.get_watch_dir()), watching=watcher.is_running)


@router.put("/watch-folder", response_model=WatchFolderOut)
def set_watch_folder(payload: WatchFolderIn) -> WatchFolderOut:
    new_dir = Path(payload.path)
    new_dir.mkdir(parents=True, exist_ok=True)
    app_settings.set_watch_dir(new_dir)
    watcher.start(new_dir)
    return WatchFolderOut(watch_dir=str(new_dir), watching=watcher.is_running)


@router.websocket("/ws")
async def images_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = events.subscribe("images")
    try:
        await websocket.send_json(
            {
                "type": "watch_status",
                "watching": watcher.is_running,
                "watch_dir": str(watcher.watch_dir) if watcher.watch_dir else None,
            }
        )
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("images", queue)
