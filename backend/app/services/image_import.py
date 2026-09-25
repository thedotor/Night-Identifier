import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import settings
from app.models.image import Image, ImageCategory, ImageStatus
from app.services import events
from app.services.image_processing import extract_metadata, generate_preview

SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".tif",
    ".tiff",
    ".cr2",
    ".cr3",
    ".nef",
    ".arw",
    ".dng",
    ".raf",
    ".orf",
    ".rw2",
    ".pef",
    ".srw",
    ".fit",
    ".fits",
    ".fts",
}


@dataclass
class ImportOutcome:
    imported: list[Image] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def image_to_dict(image: Image) -> dict:
    """Plain-dict serialization for contexts that aren't a FastAPI response
    (e.g. WebSocket broadcasts from the watch-folder scanner)."""
    return {
        "id": image.id,
        "filename": image.filename,
        "width": image.width,
        "height": image.height,
        "file_size_bytes": image.file_size_bytes,
        "status": image.status.value,
        "category": image.category.value,
    }


def import_paths(
    paths: list[str],
    db: Session,
    category: ImageCategory = ImageCategory.LIBRARY,
    move: bool = False,
) -> ImportOutcome:
    """Copy (or move) each source file into the managed image library, generate
    a preview, and create an Image row. Shared by the manual "Add images" flow
    and the watch-folder scanner so both go through identical validation/decoding.

    category separates the general library (Upload & Watch Folder, Results
    Gallery, Map, Constellations) from the training pool (Annotate) -- they
    intentionally don't overlap.

    move=True removes the original file from its source location after a
    successful import instead of leaving a copy behind.
    """
    settings.ensure_dirs()
    outcome = ImportOutcome()
    total = len(paths)

    events.emit_threadsafe("images", {"type": "import_start", "total": total})

    for i, raw_path in enumerate(paths):
        src = Path(raw_path)
        status_kind = "imported"

        if not src.exists() or src.suffix.lower() not in SUPPORTED_EXTENSIONS:
            outcome.skipped.append(raw_path)
            status_kind = "skipped"
        else:
            stored_name = f"{uuid.uuid4().hex}{src.suffix.lower()}"
            stored_path = settings.images_dir / stored_name
            preview_path = settings.previews_dir / f"{stored_name}.jpg"

            try:
                if move:
                    shutil.move(str(src), stored_path)
                else:
                    shutil.copy2(src, stored_path)
                width, height = generate_preview(stored_path, preview_path)
            except Exception:
                outcome.skipped.append(raw_path)
                stored_path.unlink(missing_ok=True)
                preview_path.unlink(missing_ok=True)
                status_kind = "skipped"
            else:
                metadata = extract_metadata(stored_path)

                image = Image(
                    filename=src.name,
                    stored_path=str(stored_path),
                    preview_path=str(preview_path),
                    width=width,
                    height=height,
                    file_size_bytes=stored_path.stat().st_size,
                    latitude=metadata.get("latitude"),
                    longitude=metadata.get("longitude"),
                    captured_at=metadata.get("captured_at"),
                    status=ImageStatus.IMPORTED,
                    category=category,
                )
                db.add(image)
                outcome.imported.append(image)

        events.emit_threadsafe(
            "images",
            {
                "type": "import_progress",
                "processed": i + 1,
                "total": total,
                "filename": src.name,
                "status": status_kind,
            },
        )

    db.commit()
    for image in outcome.imported:
        db.refresh(image)

    return outcome
