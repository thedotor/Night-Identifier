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
