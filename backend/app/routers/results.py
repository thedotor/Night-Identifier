from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.annotation import Annotation, AnnotationSource, ShapeType
from app.models.image import Image, ImageCategory, ImageStatus
from app.routers.images import ImageOut
from app.services import events
from app.services.folder_sort import model_scores, sort_image
from app.services.model_kinds import KINDS
from app.services.results_runner import results_runner
from app.services.trainer import available_model_kinds, has_current_model

router = APIRouter(prefix="/results", tags=["results"])


class DetectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    object_type_id: int
    shape_type: ShapeType
    geometry: dict[str, Any]
    confidence: float | None


class ResultImageOut(BaseModel):
    image: ImageOut
    detections: list[DetectionOut]


class RunRequest(BaseModel):
    image_ids: list[int] | None = None


class StatusOut(BaseModel):
    is_running: bool
    has_model: bool  # at least one trained model
    models: dict[str, bool]
    total_images: int
    processed_images: int


@router.get("/status", response_model=StatusOut)
def get_status(db: Session = Depends(get_db)) -> StatusOut:
    total = len(list(db.scalars(select(Image).where(Image.category == ImageCategory.LIBRARY))))
    processed = len(
        list(
            db.scalars(
                select(Image).where(
                    Image.category == ImageCategory.LIBRARY, Image.status == ImageStatus.PROCESSED
                )
            )
        )
    )
    return StatusOut(
        is_running=results_runner.is_running,
        has_model=bool(available_model_kinds()),
        models={k: has_current_model(k) for k in KINDS},
        total_images=total,
        processed_images=processed,
    )


@router.post("/run", status_code=202)
def run_detection(payload: RunRequest) -> dict:
    if not available_model_kinds():
        raise HTTPException(status_code=409, detail="No trained model is available yet")
    try:
        results_runner.start(payload.image_ids)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"started": True}


@router.post("/organise")
def organise(db: Session = Depends(get_db)) -> dict:
    """File every already-identified photo into its object folder (new detections do this
    automatically; this catches the ones identified before that existed)."""
    images = list(
        db.scalars(
            select(Image).where(Image.category == ImageCategory.LIBRARY, Image.status == ImageStatus.PROCESSED)
        )
    )
    sorted_count = sum(1 for image in images if sort_image(image, model_scores(image, db), db))
    return {"sorted": sorted_count, "total": len(images)}


@router.post("/stop", status_code=202)
def stop_detection() -> dict:
    if not results_runner.is_running:
        raise HTTPException(status_code=409, detail="Detection is not running")
    results_runner.stop()
    return {"stopping": True}


@router.get("/images", response_model=list[ResultImageOut])
def list_results(db: Session = Depends(get_db)) -> list[ResultImageOut]:
    images = list(
        db.scalars(
            select(Image)
            .where(Image.category == ImageCategory.LIBRARY, Image.status == ImageStatus.PROCESSED)
            .order_by(Image.created_at.desc())
        )
    )
    out = []
    for image in images:
        detections = list(
            db.scalars(
                select(Annotation).where(
                    Annotation.image_id == image.id, Annotation.source == AnnotationSource.MODEL
                )
            )
        )
        out.append(ResultImageOut(image=ImageOut.model_validate(image), detections=detections))
    return out


@router.websocket("/ws")
async def results_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = events.subscribe("results")
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("results", queue)
