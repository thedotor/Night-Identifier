import datetime as dt
import enum

from sqlalchemy import DateTime, Enum, Float, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class StarLabelType(str, enum.Enum):
    STAR = "star"
    NOT_STAR = "not_star"


class StarLabel(Base):
    """A user-confirmed label on one detected candidate point ('this really
    is a star' / 'this is a light, not a star'), across any image. Training
    data for the optional GPU-trained star classifier -- see
    app/services/star_classifier.py."""

    __tablename__ = "star_labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"))
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    label: Mapped[StarLabelType] = mapped_column(Enum(StarLabelType))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
