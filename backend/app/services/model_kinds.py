"""The app trains one detector: the object detector, from labels you draw in Annotate.

Model "kinds" are kept as a parameter so the trainer, exporter and inference code stay
generic, but only "objects" exists. Annotations with origin="sky_overlay" (labels an
earlier version generated from the Sky Overlay) are never used as training data.
"""

from pathlib import Path

from sqlalchemy import ColumnElement, or_

from app.config import settings
from app.models.annotation import Annotation, AnnotationSource

KIND_OBJECTS = "objects"
KINDS = (KIND_OBJECTS,)

SKY_OVERLAY_ORIGIN = "sky_overlay"


def check_kind(kind: str) -> str:
    if kind not in KINDS:
        raise ValueError(f"Unknown model kind: {kind!r} (expected one of {KINDS})")
    return kind


def object_type_kind(kind: str) -> str:
    """The ObjectType.kind value whose classes belong to this model."""
    check_kind(kind)
    return "object"


def model_dir(kind: str) -> Path:
    return settings.models_dir / check_kind(kind)


def label_conditions(kind: str) -> list[ColumnElement[bool]]:
    """WHERE clauses selecting the ground-truth labels this model trains on."""
    check_kind(kind)
    return [
        Annotation.source == AnnotationSource.MANUAL,
        or_(Annotation.origin.is_(None), Annotation.origin != SKY_OVERLAY_ORIGIN),
    ]
