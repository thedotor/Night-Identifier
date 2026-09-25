"""Saving frames from a live camera to disk and into the image library."""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Any

import cv2
from PIL import Image as PILImage
from sqlalchemy.orm import Session

from app.config import settings
from app.models.image import ImageCategory
from app.services import fits_io
from app.services.image_import import import_paths
from app.services.live import processing
from app.services.live.base import Frame
from app.services.live.manager import CameraRuntime


def live_dir(rt: CameraRuntime, when: dt.datetime | None = None) -> Path:
    """<data dir>/live/<camera name>/<date>/ (created)."""
    when = when or dt.datetime.now()
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str(rt.cfg.get("name", "camera"))).strip("_") or "camera"
    d = settings.data_dir / "live" / safe / when.strftime("%Y-%m-%d")
    d.mkdir(parents=True, exist_ok=True)
    return d


def file_stem(rt: CameraRuntime, when: dt.datetime | None = None) -> str:
    when = when or dt.datetime.now()
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str(rt.cfg.get("name", "camera"))).strip("_") or "camera"
    return f"{safe}_{when.strftime('%Y%m%d_%H%M%S')}"


def save_display_image(frame: Frame, path: Path, stretch: dict[str, Any] | None, when: dt.datetime) -> Path:
    """8-bit image of what the viewer sees (stretch applied) as PNG/JPEG, with the capture time in
    EXIF so the Sky Overlay and the library know when it was taken."""
    img = processing.to_display(frame, None, stretch)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB) if img.ndim == 3 else img
    pil = PILImage.fromarray(rgb)
    exif = PILImage.Exif()
    exif[306] = when.strftime("%Y:%m:%d %H:%M:%S")  # DateTime
    exif[36867] = when.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeOriginal (Exif IFD)
    if path.suffix.lower() in (".jpg", ".jpeg"):
        pil.save(path, "JPEG", quality=95, exif=exif)
    else:
        pil.save(path, "PNG", exif=exif)
    return path


def snapshot_to_library(rt: CameraRuntime, db: Session, stretch: dict[str, Any] | None) -> dict[str, Any]:
    frame = rt.latest()
    if frame is None:
        raise ValueError("No frame yet: wait for the camera to start")
    if stretch is None and rt.is_astro:
        stretch = processing.DEFAULT_STRETCH
    when = dt.datetime.fromtimestamp(frame.timestamp)
    ext = ".png" if rt.is_astro else ".jpg"
    path = live_dir(rt, when) / f"{file_stem(rt, when)}{ext}"
    save_display_image(frame, path, stretch, when)
    outcome = import_paths([str(path)], db)
    if not outcome.imported:
        raise ValueError("The library could not read the saved snapshot")
    image = outcome.imported[0]
    return {"image_id": image.id, "filename": image.filename, "saved_to": str(path)}


def fits_header(rt: CameraRuntime, frame: Frame) -> dict[str, Any]:
    """Standard-ish keywords so stacking / calibration software knows what this frame is."""
    utc = dt.datetime.fromtimestamp(frame.timestamp, dt.timezone.utc).replace(tzinfo=None)
    meta = frame.meta
    header: dict[str, Any] = {
        "DATE-OBS": utc.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3],
        "EXPTIME": round(frame.exposure_s, 6) if frame.exposure_s else None,
        "INSTRUME": str(rt.info.get("model") or rt.cfg.get("name", ""))[:60],
        "CAMERA": str(rt.cfg.get("name", ""))[:60],
        "GAIN": meta.get("gain"),
        "XBINNING": meta.get("binning"),
        "YBINNING": meta.get("binning"),
        "CCD-TEMP": meta.get("temperature"),
        "BAYERPAT": frame.bayer if frame.data.ndim == 2 else None,
        "BITDEPTH": frame.bit_depth,
        "SWCREATE": "Night Identifier Live View",
    }
    return header


def save_frame(rt: CameraRuntime, frame: Frame, folder: Path, fmt: str, stretch: dict[str, Any] | None, stem: str | None = None) -> Path:
    """Write one frame in 'fits' (full data), 'png' or 'jpg' (what you see) into `folder`."""
    when = dt.datetime.fromtimestamp(frame.timestamp)
    folder.mkdir(parents=True, exist_ok=True)
    base = stem or file_stem(rt, when)
    if fmt == "fits":
        path = folder / f"{base}.fits"
        n = 1
        while path.exists():
            n += 1
            path = folder / f"{base}_{n}.fits"
        fits_io.write_fits(path, frame.data, fits_header(rt, frame))
        return path
    ext = ".png" if fmt == "png" else ".jpg"
    path = folder / f"{base}{ext}"
    n = 1
    while path.exists():
        n += 1
        path = folder / f"{base}_{n}{ext}"
    if stretch is None and rt.is_astro:
        stretch = processing.DEFAULT_STRETCH
    return save_display_image(frame, path, stretch, when)


def import_files(paths: list[Path], db: Session) -> int:
    outcome = import_paths([str(p) for p in paths], db)
    return len(outcome.imported)


def capture_to_library(rt: CameraRuntime, db: Session, fmt: str, stretch: dict[str, Any] | None, to_library: bool) -> dict[str, Any]:
    """One frame in the chosen format; optionally also added to the library."""
    frame = rt.latest()
    if frame is None:
        raise ValueError("No frame yet: wait for the camera to start")
    when = dt.datetime.fromtimestamp(frame.timestamp)
    path = save_frame(rt, frame, live_dir(rt, when), fmt, stretch)
    out: dict[str, Any] = {"saved_to": str(path), "filename": path.name}
    if to_library:
        outcome = import_paths([str(path)], db)
        if not outcome.imported:
            raise ValueError("The library could not read the saved file")
        out["image_id"] = outcome.imported[0].id
    return out
