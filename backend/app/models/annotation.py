import datetime as dt
import enum

from sqlalchemy import JSON, DateTime, Enum, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ShapeType(str, enum.Enum):
    RECT = "rect"
    ELLIPSE = "ellipse"
    POLYGON = "polygon"


class AnnotationSource(str, enum.Enum):
    MANUAL = "manual"
    MODEL = "model"


class Annotation(Base):
    """A single labeled shape on an image, in original-image pixel coordinates.

    geometry shape by type:
      rect:    {"x": number, "y": number, "width": number, "height": number}
      ellipse: {"cx": number, "cy": number, "rx": number, "ry": number}
      polygon: {"points": [number, ...]}  # flat [x0, y0, x1, y1, ...]

    source distinguishes hand-drawn labels (used as training ground truth)
    from model-generated detections (Results Gallery output) so retraining
    never accidentally trains on the model's own predictions.
    """

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    object_type_id: Mapped[int] = mapped_column(ForeignKey("object_types.id", ondelete="CASCADE"))
    shape_type: Mapped[ShapeType] = mapped_column(Enum(ShapeType))
    geometry: Mapped[dict] = mapped_column(JSON)
    source: Mapped[AnnotationSource] = mapped_column(Enum(AnnotationSource), default=AnnotationSource.MANUAL)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Set when a feature generated this label rather than a person drawing it
    # (e.g. "sky_overlay"), so it can be re-generated without touching hand-drawn ones.
    origin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
