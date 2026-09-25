from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.image import Image
from app.models.star_classifier_run import StarClassifierRun, StarClassifierStatus
from app.models.star_label import StarLabel, StarLabelType
from app.services import events
from app.services.star_classifier import (
    MIN_LABELS_PER_CLASS,
    classifier_manager,
    delete_trained_classifier,
    has_trained_classifier,
)
from app.services.star_detection import detect_stars

router = APIRouter(prefix="/star-classifier", tags=["star-classifier"])

CANDIDATE_LABELING_CAP = 300


class CandidateOut(BaseModel):
    x: float
    y: float
    brightness: float


class LabelOut(BaseModel):
    id: int
    x: float
    y: float
    label: StarLabelType


class LabelsIn(BaseModel):
    labels: list[tuple[float, float, StarLabelType]]  # (x, y, label), full replace for the image


class SummaryOut(BaseModel):
    star_count: int
    not_star_count: int
    min_per_class: int
    ready_to_train: bool
    has_model: bool


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: StarClassifierStatus
    device: str
    epochs: int
    current_epoch: int
    label_count: int
    metrics: dict[str, Any]
    error_message: str | None
    model_path: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None

    @staticmethod
    def from_orm_run(run: StarClassifierRun) -> "RunOut":
        return RunOut(
            id=run.id,
            status=run.status,
            device=run.device,
            epochs=run.epochs,
            current_epoch=run.current_epoch,
            label_count=run.label_count,
            metrics=run.metrics or {},
            error_message=run.error_message,
            model_path=run.model_path,
            created_at=run.created_at.isoformat(),
            started_at=run.started_at.isoformat() if run.started_at else None,
            finished_at=run.finished_at.isoformat() if run.finished_at else None,
        )


class StartTrainingRequest(BaseModel):
    epochs: int = 30
    device: str = "auto"


@router.get("/candidates/{image_id}", response_model=list[CandidateOut])
def get_candidates(image_id: int, db: Session = Depends(get_db)) -> list[CandidateOut]:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    stars = detect_stars(
        Path(image.preview_path),
        max_stars=CANDIDATE_LABELING_CAP,
        target_size=(image.width, image.height),
        source_path=Path(image.stored_path),
    )
    return [CandidateOut(x=x, y=y, brightness=b) for x, y, b in stars]


@router.get("/labels/{image_id}", response_model=list[LabelOut])
def get_labels(image_id: int, db: Session = Depends(get_db)) -> list[LabelOut]:
    labels = list(db.scalars(select(StarLabel).where(StarLabel.image_id == image_id)))
    return [LabelOut(id=lbl.id, x=lbl.x, y=lbl.y, label=lbl.label) for lbl in labels]


@router.put("/labels/{image_id}", response_model=list[LabelOut])
def set_labels(image_id: int, payload: LabelsIn, db: Session = Depends(get_db)) -> list[LabelOut]:
    image = db.get(Image, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found")
    db.execute(StarLabel.__table__.delete().where(StarLabel.image_id == image_id))
    created = []
    for x, y, label in payload.labels:
        row = StarLabel(image_id=image_id, x=x, y=y, label=label)
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
    return [LabelOut(id=r.id, x=r.x, y=r.y, label=r.label) for r in created]


@router.get("/summary", response_model=SummaryOut)
def summary(db: Session = Depends(get_db)) -> SummaryOut:
    star_count = len(list(db.scalars(select(StarLabel).where(StarLabel.label == StarLabelType.STAR))))
    not_star_count = len(
        list(db.scalars(select(StarLabel).where(StarLabel.label == StarLabelType.NOT_STAR)))
    )
    return SummaryOut(
        star_count=star_count,
        not_star_count=not_star_count,
        min_per_class=MIN_LABELS_PER_CLASS,
        ready_to_train=star_count >= MIN_LABELS_PER_CLASS and not_star_count >= MIN_LABELS_PER_CLASS,
        has_model=has_trained_classifier(),
    )


@router.get("/status")
def status(db: Session = Depends(get_db)) -> dict:
    current_id = classifier_manager.current_run_id
    latest = db.scalar(select(StarClassifierRun).order_by(StarClassifierRun.created_at.desc()))
    return {
        "is_running": classifier_manager.is_running,
        "current_run_id": current_id,
        "latest_run": RunOut.from_orm_run(latest) if latest else None,
        "has_model": has_trained_classifier(),
    }


@router.post("/train", response_model=RunOut, status_code=201)
def start_training(payload: StartTrainingRequest, db: Session = Depends(get_db)) -> RunOut:
    if classifier_manager.is_running:
        raise HTTPException(status_code=409, detail="A star-classifier training run is already in progress")

    run = StarClassifierRun(status=StarClassifierStatus.PENDING, device=payload.device, epochs=payload.epochs)
    db.add(run)
    db.commit()
    db.refresh(run)

    try:
        classifier_manager.start(run.id, payload.epochs, payload.device)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return RunOut.from_orm_run(run)


@router.post("/stop", status_code=202)
def stop_training() -> dict:
    if not classifier_manager.is_running:
        raise HTTPException(status_code=409, detail="No star-classifier training run is in progress")
    classifier_manager.stop()
    return {"stopping": True}


@router.delete("/model", status_code=204)
def delete_model() -> None:
    if classifier_manager.is_running:
        raise HTTPException(status_code=409, detail="Stop the current training run first")
    delete_trained_classifier()


@router.websocket("/ws")
async def star_classifier_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = events.subscribe("star_classifier")
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("star_classifier", queue)
