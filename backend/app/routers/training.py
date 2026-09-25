from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.annotation import Annotation, AnnotationSource
from app.models.image import Image, ImageCategory
from app.models.object_type import ObjectType
from app.models.training_run import TrainingRun, TrainingStatus
from app.services import events
from app.services.gpu import GpuDevice, detect_gpu
from app.services.model_kinds import KINDS, label_conditions, object_type_kind
from app.services.trainer import delete_current_model, has_current_model, trainer

router = APIRouter(prefix="/training", tags=["training"])


class TrainingRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    status: TrainingStatus
    device: str
    epochs: int
    batch_size: int
    workers: int
    current_epoch: int
    image_count: int
    class_count: int
    metrics: dict[str, Any]
    error_message: str | None
    model_path: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None

    @staticmethod
    def from_orm_run(run: TrainingRun) -> "TrainingRunOut":
        return TrainingRunOut(
            id=run.id,
            kind=run.kind or "objects",
            status=run.status,
            device=run.device,
            epochs=run.epochs,
            batch_size=run.batch_size,
            workers=run.workers,
            current_epoch=run.current_epoch,
            image_count=run.image_count,
            class_count=run.class_count,
            metrics=run.metrics or {},
            error_message=run.error_message,
            model_path=run.model_path,
            created_at=run.created_at.isoformat(),
            started_at=run.started_at.isoformat() if run.started_at else None,
            finished_at=run.finished_at.isoformat() if run.finished_at else None,
        )


class StartTrainingRequest(BaseModel):
    epochs: int = 50
    batch_size: int = 16
    workers: int = 4
    device: str = "auto"
    kind: str = "objects"


class ReadinessOut(BaseModel):
    ready: bool
    object_type_count: int
    annotated_image_count: int
    message: str | None


class DeviceListOut(BaseModel):
    available: bool
    devices: list[GpuDevice]


@router.get("/devices", response_model=DeviceListOut)
def list_devices() -> DeviceListOut:
    gpu = detect_gpu()
    return DeviceListOut(available=gpu.available, devices=gpu.devices)


def _valid_kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {list(KINDS)}")
    return kind


@router.get("/readiness", response_model=ReadinessOut)
def readiness(kind: str = "objects", db: Session = Depends(get_db)) -> ReadinessOut:
    _valid_kind(kind)
    object_type_count = len(
        list(db.scalars(select(ObjectType).where(ObjectType.kind == object_type_kind(kind))))
    )
    annotated_image_count = len(
        list(
            db.scalars(
                select(Image)
                .join(Annotation, Annotation.image_id == Image.id)
                .where(*label_conditions(kind), Image.category == ImageCategory.TRAINING)
                .distinct()
            )
        )
    )
    if object_type_count == 0:
        return ReadinessOut(
            ready=False,
            object_type_count=0,
            annotated_image_count=annotated_image_count,
            message="Add at least one object type in the Object Library first.",
        )
    if annotated_image_count < 2:
        return ReadinessOut(
            ready=False,
            object_type_count=object_type_count,
            annotated_image_count=annotated_image_count,
            message="Label at least 2 images in Annotate before training.",
        )
    return ReadinessOut(
        ready=True,
        object_type_count=object_type_count,
        annotated_image_count=annotated_image_count,
        message=None,
    )


@router.get("/status")
def status(kind: str = "objects", db: Session = Depends(get_db)) -> dict:
    _valid_kind(kind)
    latest = db.scalar(
        select(TrainingRun).where(TrainingRun.kind == kind).order_by(TrainingRun.created_at.desc())
    )
    # Only one run at a time (they share the GPU); say which model is busy.
    return {
        "is_running": trainer.is_running and trainer.current_kind == kind,
        "running_kind": trainer.current_kind,
        "current_run_id": trainer.current_run_id if trainer.current_kind == kind else None,
        "latest_run": TrainingRunOut.from_orm_run(latest) if latest else None,
        "has_model": has_current_model(kind),
    }


@router.get("/runs", response_model=list[TrainingRunOut])
def list_runs(kind: str | None = None, db: Session = Depends(get_db)) -> list[TrainingRunOut]:
    query = select(TrainingRun).order_by(TrainingRun.created_at.desc())
    if kind is not None:
        query = query.where(TrainingRun.kind == _valid_kind(kind))
    runs = list(db.scalars(query))
    return [TrainingRunOut.from_orm_run(r) for r in runs]


@router.post("/start", response_model=TrainingRunOut, status_code=201)
def start_training(payload: StartTrainingRequest, db: Session = Depends(get_db)) -> TrainingRunOut:
    _valid_kind(payload.kind)
    if trainer.is_running:
        raise HTTPException(status_code=409, detail="A model is already training. Wait for it to finish or stop it.")

    run = TrainingRun(
        kind=payload.kind,
        status=TrainingStatus.PENDING,
        device=payload.device,
        epochs=payload.epochs,
        batch_size=payload.batch_size,
        workers=payload.workers,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    try:
        trainer.start(run.id, payload.epochs, payload.batch_size, payload.workers, payload.device, payload.kind)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return TrainingRunOut.from_orm_run(run)


@router.post("/stop", status_code=202)
def stop_training() -> dict:
    if not trainer.is_running:
        raise HTTPException(status_code=409, detail="No training run is in progress")
    trainer.stop()
    return {"stopping": True}


@router.delete("/model", status_code=204)
def delete_model(kind: str = "objects") -> None:
    _valid_kind(kind)
    if trainer.is_running:
        raise HTTPException(status_code=409, detail="Stop the current training run first")
    delete_current_model(kind)


@router.websocket("/ws")
async def training_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = events.subscribe("training")
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("training", queue)
