from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.annotation import Annotation, AnnotationSource
from app.models.image import Image, ImageCategory, ImageStatus
from app.models.object_type import ObjectType
from app.models.training_run import TrainingRun, TrainingStatus

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
def dashboard_stats(db: Session = Depends(get_db)) -> dict:
    def count(stmt) -> int:
        return db.scalar(stmt) or 0

    library = Image.category == ImageCategory.LIBRARY
    training = Image.category == ImageCategory.TRAINING
    manual = Annotation.source == AnnotationSource.MANUAL
    model = Annotation.source == AnnotationSource.MODEL

    return {
        "library_images": count(select(func.count()).select_from(Image).where(library)),
        "training_images": count(select(func.count()).select_from(Image).where(training)),
        "processed_images": count(
            select(func.count()).select_from(Image).where(library, Image.status == ImageStatus.PROCESSED)
        ),
        "geotagged_images": count(
            select(func.count()).select_from(Image).where(Image.latitude.is_not(None))
        ),
        "storage_bytes": count(select(func.coalesce(func.sum(Image.file_size_bytes), 0))),
        "object_types": count(select(func.count()).select_from(ObjectType).where(ObjectType.kind == "object")),
        "manual_annotations": count(select(func.count()).select_from(Annotation).where(manual)),
        "detections": count(select(func.count()).select_from(Annotation).where(model)),
        "training_runs": count(select(func.count()).select_from(TrainingRun)),
        "completed_training_runs": count(
            select(func.count())
            .select_from(TrainingRun)
            .where(TrainingRun.status == TrainingStatus.COMPLETED)
        ),
    }


@router.get("/disk")
def disk_space() -> dict:
    """Free space on the drive(s) the app writes to: the data folder (library, previews, models, Live View captures) and, if it is on a different drive, the watch folder."""
    import shutil
    from pathlib import Path

    from app.config import settings
    from app.services import app_settings

    places: list[tuple[str, Path]] = [("Library and captures", settings.data_dir), ("Watch folder", app_settings.get_watch_dir())]
    out: list[dict] = []
    seen: set[str] = set()
    for label, path in places:
        target = path if path.exists() else next((p for p in path.parents if p.exists()), None)
        if target is None:
            continue
        try:
            usage = shutil.disk_usage(target)
        except OSError:
            continue
        drive = target.resolve().anchor or str(target)
        if drive in seen:
            continue
        seen.add(drive)
        out.append({"label": label, "path": str(path), "drive": drive, "free_bytes": usage.free, "total_bytes": usage.total})
    return {"drives": out}
