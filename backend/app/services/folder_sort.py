"""Files identified images into one folder per detected object.

    <data_dir>/sorted/<Object name>/<photo>

The photo itself is *moved* there (Image.stored_path follows it), into the folder of the
object the model was most confident about. A photo with several objects also gets a
linked copy in each of the other objects' folders (hard link when the disk allows it, so
no extra space; a real copy otherwise), tracked in Image.sorted_paths so they can be
replaced on a re-run or removed with the photo. Photos where nothing was detected go to
sorted/_unsorted.
"""

import hashlib
import os
import re
import shutil
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models.annotation import Annotation, AnnotationSource
from app.models.image import Image
from app.models.object_type import ObjectType
from app.services import log_capture

logger = log_capture.get_logger("sorting")

UNSORTED_FOLDER_NAME = "_unsorted"


def sorted_root() -> Path:
    return settings.data_dir / "sorted"


def _safe_folder_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", name).strip().rstrip(".")
    return cleaned or "unnamed"


def _inside_sorted(path: Path) -> bool:
    try:
        path.resolve().relative_to(sorted_root().resolve())
    except ValueError:
        return False
    return True


def _same_content(a: Path, b: Path) -> bool:
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        digests = []
        for path in (a, b):
            h = hashlib.blake2b()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            digests.append(h.digest())
        return digests[0] == digests[1]
    except OSError:
        return False


def _claimed(path: Path, db: Session) -> bool:
    """Is this file one the app is tracking (a photo's stored file or one of its linked copies)?"""
    target = os.path.normcase(os.path.abspath(path))
    for stored, extras in db.execute(select(Image.stored_path, Image.sorted_paths)):
        for known in [stored, *(extras or [])]:
            if os.path.normcase(os.path.abspath(known)) == target:
                return True
    return False


def _target_path(folder: Path, image: Image, src: Path, db: Session) -> Path:
    """Where the photo goes in this folder: its own filename if that's free. Two different
    photos can share a camera filename, so a taken name gets the image id appended -- unless
    the file there is an untracked, byte-identical copy (left by older versions, which copied
    photos here instead of moving them), which is simply replaced."""
    dest = folder / image.filename
    if not dest.exists():
        return dest
    if not _claimed(dest, db) and _same_content(src, dest):
        dest.unlink()
        return dest
    return folder / f"{Path(image.filename).stem}_{image.id}{Path(image.filename).suffix}"


def _remove_if_empty(folder: Path) -> None:
    try:
        if folder != sorted_root() and _inside_sorted(folder):
            folder.rmdir()  # only succeeds when empty
    except OSError:
        pass


def _link_or_copy(src: Path, dest: Path) -> None:
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


def folder_names(scores: dict[int, float], db: Session) -> list[str]:
    """Folder names for the detected object types, most confident first (no duplicates)."""
    if not scores:
        return [UNSORTED_FOLDER_NAME]
    types = {ot.id: ot for ot in db.scalars(select(ObjectType).where(ObjectType.id.in_(scores)))}
    names: list[str] = []
    for type_id in sorted(scores, key=lambda t: -scores[t]):
        if type_id in types:
            name = _safe_folder_name(types[type_id].name)
            if name not in names:
                names.append(name)
    return names or [UNSORTED_FOLDER_NAME]


def sort_image(image: Image, scores: dict[int, float], db: Session) -> bool:
    """scores: {object_type_id: best confidence} for what was found in the photo.
    Returns True if the photo is now filed in its object folder(s)."""
    src = Path(image.stored_path)
    if not src.exists():
        return False

    names = folder_names(scores, db)
    root = sorted_root()

    # Drop the linked copies from an earlier sort; they're rebuilt below.
    for old in image.sorted_paths or []:
        p = Path(old)
        if _inside_sorted(p) and p != src:
            p.unlink(missing_ok=True)
            _remove_if_empty(p.parent)

    primary_dir = root / names[0]
    try:
        primary_dir.mkdir(parents=True, exist_ok=True)
        if src.parent.resolve() != primary_dir.resolve():
            dest = _target_path(primary_dir, image, src, db)
            old_dir = src.parent
            shutil.move(str(src), str(dest))
            image.stored_path = str(dest)
            if _inside_sorted(old_dir):
                _remove_if_empty(old_dir)
            src = dest
    except OSError as exc:
        logger.warning("Could not move %s into %s: %s", image.filename, primary_dir, exc)
        return False

    extras: list[str] = []
    for name in names[1:]:
        folder = root / name
        try:
            folder.mkdir(parents=True, exist_ok=True)
            dest = _target_path(folder, image, src, db)
            _link_or_copy(src, dest)
            extras.append(str(dest))
        except OSError as exc:
            logger.warning("Could not link %s into %s: %s", image.filename, folder, exc)
    image.sorted_paths = extras
    db.commit()
    return True


def model_scores(image: Image, db: Session) -> dict[int, float]:
    """Best confidence per object type among the model's saved detections for this photo."""
    scores: dict[int, float] = {}
    rows = db.scalars(
        select(Annotation).where(Annotation.image_id == image.id, Annotation.source == AnnotationSource.MODEL)
    )
    for ann in rows:
        scores[ann.object_type_id] = max(scores.get(ann.object_type_id, 0.0), ann.confidence or 0.0)
    return scores


def remove_linked_copies(image: Image) -> None:
    """Delete the extra per-object copies of a photo (used when the photo is deleted)."""
    for old in image.sorted_paths or []:
        p = Path(old)
        if _inside_sorted(p):
            p.unlink(missing_ok=True)
            _remove_if_empty(p.parent)
