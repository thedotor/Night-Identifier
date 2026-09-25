from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.annotation import Annotation, AnnotationSource, ShapeType
from app.models.image import Image, ImageStatus
from app.models.object_type import ObjectType
from app.services.folder_sort import sort_image
from app.services.inference import Detection, predict_image
from app.services.model_kinds import object_type_kind


def process_image(
    image: Image,
    db: Session,
    model,
    class_map: dict[int, int],
    device: str,
    sort: bool = True,
    kind: str = "objects",
) -> list[Detection]:
    """Run detection on one image, persist the results as model-sourced
    annotations (replacing any previous model detections for it), and
    optionally file it into its per-object folders (see folder_sort)."""
    detections = predict_image(model, class_map, image, device)

    # Replace this detector's earlier results.
    own_types = select(ObjectType.id).where(ObjectType.kind == object_type_kind(kind))
    db.execute(
        delete(Annotation).where(
            Annotation.image_id == image.id,
            Annotation.source == AnnotationSource.MODEL,
            Annotation.object_type_id.in_(own_types),
        )
    )
    for det in detections:
        db.add(
            Annotation(
                image_id=image.id,
                object_type_id=det.object_type_id,
                shape_type=ShapeType.RECT,
                geometry=det.geometry,
                source=AnnotationSource.MODEL,
                confidence=det.confidence,
            )
        )
    image.status = ImageStatus.PROCESSED
    db.commit()

    if sort:
        scores: dict[int, float] = {}
        for det in detections:
            scores[det.object_type_id] = max(scores.get(det.object_type_id, 0.0), det.confidence)
        sort_image(image, scores, db)

    return detections
