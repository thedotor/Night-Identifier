"""Fisheye lens distortion correction, derived from the shot's own EXIF data.

Constellation matching used to fit a similarity
transform (rotation + uniform scale + translation), which implicitly
assumes a rectilinear (perspective) lens projection -- straight lines in
the sky stay straight-ish relative proportions on the sensor. A fisheye
lens instead uses roughly an *equidistant* projection (r = f * theta,
radius on the sensor proportional to angle from the optical axis, not its
tangent), which increasingly compresses the image toward the edges. Left
uncorrected, that compression measurably distorts the relative positions
of stars away from the frame center, which is one real source of the
position error the matcher has to tolerate.

This maps detected/clicked star pixel positions from the fisheye's actual
projection back to what a rectilinear lens would have produced at the same
focal length, so the matcher's flat-projection assumption holds much
better. Applies only when the shot's own EXIF identifies it as a known
fisheye lens; every other image is returned unchanged.
"""

import math
from dataclasses import dataclass
from pathlib import Path

from PIL import ExifTags
from PIL import Image as PILImage

# Sensor dimensions (width_mm, height_mm) for cameras seen in this app's
# supported RAW/JPEG library. Only needed for bodies actually paired with a
# known fisheye lens below -- extend as needed.
_SENSOR_MM: dict[str, tuple[float, float]] = {
    "Canon EOS 5D Mark III": (36.0, 24.0),
    "Canon EOS 600D": (22.3, 14.9),
    "SLT-A99V": (35.8, 23.8),
}


@dataclass
class FisheyeCorrection:
    k_px: float  # pixels per radian, from the lens's actual focal length + sensor + resolution
    cx: float
    cy: float


def _is_known_fisheye(make: str, model: str, lens_model: str) -> bool:
    lens_model = lens_model.strip()
    if "fisheye" in lens_model.lower():
        return True
    # Canon's only 15mm prime is the EF 15mm f/2.8 Fisheye -- EXIF just
    # reports the focal length "15mm" as the lens name, not the full name.
    if make.strip().lower() == "canon" and lens_model == "15mm":
        return True
    return False


def get_fisheye_correction(
    source_path: Path, image_width: int, image_height: int
) -> FisheyeCorrection | None:
    """Best-effort: returns None for anything not confidently identified as
    a known fisheye lens (including on any EXIF-read failure), so callers
    can treat that as "no correction needed" rather than a special case.
    """
    try:
        with PILImage.open(source_path) as img:
            exif = img.getexif()
            if not exif:
                return None
            make = str(exif.get(271, ""))
            model = str(exif.get(272, ""))
            exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
            lens_model = str(exif_ifd.get(42036, ""))
            focal_mm = exif_ifd.get(37386)
    except Exception:  # noqa: BLE001
        return None

    if not focal_mm or not _is_known_fisheye(make, model, lens_model):
        return None

    sensor_mm = _SENSOR_MM.get(model.strip())
    if sensor_mm is None:
        return None

    sensor_diag_mm = math.hypot(*sensor_mm)
    image_diag_px = math.hypot(image_width, image_height)
    px_per_mm = image_diag_px / sensor_diag_mm
    k_px = float(focal_mm) * px_per_mm

    return FisheyeCorrection(k_px=k_px, cx=image_width / 2.0, cy=image_height / 2.0)


# Radius grows without bound as the angle from the optical axis approaches
# 90 degrees under a rectilinear projection (tan -> infinity) -- a real
# fisheye's actual field of view can reach that at the frame edges, so cap
# how far a point is allowed to be pushed out to keep the correction finite
# and well-behaved instead of blowing up a handful of edge/corner stars.
_MAX_THETA = math.radians(80.0)


def correct_point(x: float, y: float, correction: FisheyeCorrection) -> tuple[float, float]:
    """Fisheye (as-shot) pixel position -> equivalent rectilinear position."""
    dx, dy = x - correction.cx, y - correction.cy
    r_fisheye = math.hypot(dx, dy)
    if r_fisheye < 1e-6:
        return x, y
    theta = min(r_fisheye / correction.k_px, _MAX_THETA)
    r_rectilinear = correction.k_px * math.tan(theta)
    scale = r_rectilinear / r_fisheye
    return correction.cx + dx * scale, correction.cy + dy * scale


def uncorrect_point(x: float, y: float, correction: FisheyeCorrection) -> tuple[float, float]:
    """Inverse of correct_point: rectilinear position -> fisheye (as-shot)
    pixel position, for projecting match overlays back onto the original
    (uncorrected) preview image the user actually sees."""
    dx, dy = x - correction.cx, y - correction.cy
    r_rectilinear = math.hypot(dx, dy)
    if r_rectilinear < 1e-6:
        return x, y
    theta = math.atan(r_rectilinear / correction.k_px)
    r_fisheye = correction.k_px * theta
    scale = r_fisheye / r_rectilinear
    return correction.cx + dx * scale, correction.cy + dy * scale
