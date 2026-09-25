import datetime as dt

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ObjectType(Base):
    """A trainable object class (e.g. 'Orion Nebula', 'Satellite', 'Meteor')."""

    __tablename__ = "object_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(1000), default="")
    # "object" (hand-labelled in Annotate) or "constellation" (from the Sky Overlay);
    # each trained model only sees classes of its own kind.
    kind: Mapped[str] = mapped_column(String(16), default="object")
    reference_image_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
