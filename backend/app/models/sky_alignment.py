import datetime as dt

from sqlalchemy import JSON, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class SkyAlignment(Base):
    """Saved state of the full-sky overlay for one image: the camera model
    (pointing, roll, field of view, projection, distortion), the star pairs
    the user picked, the observer (location/time) and layer toggles. Opaque
    JSON -- the frontend (lib/skyMath.ts) owns the shapes."""

    __tablename__ = "sky_alignments"

    image_id: Mapped[int] = mapped_column(
        ForeignKey("images.id", ondelete="CASCADE"), primary_key=True
    )
    camera: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    pairs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    observer: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    layers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
