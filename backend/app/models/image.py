import datetime as dt
import enum

from sqlalchemy import JSON, DateTime, Enum, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ImageStatus(str, enum.Enum):
    IMPORTED = "imported"
    ANNOTATED = "annotated"
    PROCESSED = "processed"


class ImageCategory(str, enum.Enum):
    """Which pool an image belongs to. LIBRARY images (Upload & Watch Folder,
    Results Gallery, Map, Constellations) are your general collection.
    TRAINING images are a separate pool added specifically to be labeled in
    Annotate and used as ground truth for training -- they don't show up in
    the general library, and library images don't show up in Annotate.
    """

    LIBRARY = "library"
    TRAINING = "training"


class Image(Base):
    __tablename__ = "images"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(512))
    stored_path: Mapped[str] = mapped_column(String(1024))
    preview_path: Mapped[str] = mapped_column(String(1024))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    file_size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[ImageStatus] = mapped_column(Enum(ImageStatus), default=ImageStatus.IMPORTED)
    category: Mapped[ImageCategory] = mapped_column(Enum(ImageCategory), default=ImageCategory.LIBRARY)
    # Polygons the user fenced off from every detector; see services/blocked_areas.py
    blocked_regions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # Extra per-object copies made when the photo was filed into folders (see services/folder_sort.py)
    sorted_paths: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
