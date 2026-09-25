"""Shooting-context priors for constellation identification, read from EXIF.

A geometric matcher only sees a bag of 2D
points. Everything the photo's own metadata says about *what could possibly
be in frame* narrows the search and removes coincidental matches:

- Optics: focal length (+ sensor size) gives the field of view, hence roughly
  how many pixels one degree of sky spans. Any candidate match implying a
  wildly different scale is impossible for this lens.
- Time + location: when and where the photo was taken says which
  constellations were above the horizon. Where only a hemisphere is known
  (user-supplied), a conservative latitude is assumed.

Every field is optional and best-effort -- anything missing simply drops out
of the filtering rather than failing the scan.
"""

import datetime as dt
import math
from dataclasses import dataclass, field
from pathlib import Path

from PIL import ExifTags
from PIL import Image as PILImage

from app.data.constellations import ConstellationDef

# Diagonal of a full-frame (35mm) sensor; the reference for "35mm equivalent".
_FULL_FRAME_DIAG_MM = math.hypot(36.0, 24.0)

# Sensor sizes for bodies whose EXIF lacks FocalLengthIn35mmFilm and
# FocalPlaneResolution tags. Same table lens_correction.py needs for fisheyes.
SENSOR_MM: dict[str, tuple[float, float]] = {
    "Canon EOS 5D Mark III": (36.0, 24.0),
    "Canon EOS 600D": (22.3, 14.9),
    "SLT-A99V": (35.8, 23.8),
}

# Hemisphere-only fallback latitude. Near the equator every constellation is
# eventually visible, so a hemisphere alone carries little information. 35
# is a compromise: it drops the deep-opposite-pole shapes (Dorado, Octans,
# Apus... seen from the north) while still allowing a mid-latitude observer's
# usual sky. Observers nearer the equator should enter their latitude.
ASSUMED_LATITUDE_FOR_HEMISPHERE = 35.0

# A star counts as "above the horizon" down to this altitude (refraction,
# terrain-free horizons, and a large field of view all argue for slack).
HORIZON_MARGIN_DEG = -5.0
# With no UTC offset and no GPS clock the timezone is guessed from longitude,
# which can be a couple of hours off (= ~30 degrees of sky rotation).
ESTIMATED_TIME_HORIZON_MARGIN_DEG = -20.0


@dataclass
class Optics:
    focal_mm: float | None = None
    focal_35mm: float | None = None
    lens_model: str | None = None
    camera_model: str | None = None
    aperture: float | None = None
    # Pixels per degree of sky at the optical axis, for the image's actual
    # pixel dimensions. None when the focal length/sensor can't be resolved.
    px_per_degree: float | None = None
    diagonal_fov_deg: float | None = None
    # Angle from the axis to the farthest image corner; drives how much the
    # local scale can grow toward the edges of a rectilinear wide-angle shot.
    half_diagonal_deg: float | None = None


@dataclass
class CaptureTime:
    utc: dt.datetime | None = None
    local: dt.datetime | None = None  # camera-clock time, timezone unknown
    # "gps" (UTC stamp), "offset" (EXIF OffsetTime), "longitude" (guessed
    # timezone from GPS position) or None
    source: str | None = None


@dataclass
class SkyContext:
    optics: Optics = field(default_factory=Optics)
    time: CaptureTime = field(default_factory=CaptureTime)
    latitude: float | None = None
    longitude: float | None = None
    hemisphere: str | None = None  # "N"/"S", from GPS or user override
    # True when only a hemisphere is known (latitude is then left unset)
    latitude_assumed: bool = False
    notes: list[str] = field(default_factory=list)


def _ratio(value) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return v if v > 0 else None


def _read_exif(source_path: Path) -> tuple[dict, dict, dict]:
    """(main IFD, Exif IFD, GPS IFD) or three empty dicts."""
    try:
        with PILImage.open(source_path) as img:
            exif = img.getexif()
            if not exif:
                return {}, {}, {}
            return (
                dict(exif),
                dict(exif.get_ifd(ExifTags.IFD.Exif)),
                dict(exif.get_ifd(ExifTags.IFD.GPSInfo)),
            )
    except Exception:  # noqa: BLE001
        return {}, {}, {}


def _sensor_from_focal_plane(exif_ifd: dict, image_w: int, image_h: int) -> tuple[float, float] | None:
    """Sensor size in mm from FocalPlane{X,Y}Resolution + the sensor's pixel
    count (PixelX/YDimension). Unit 2=inch, 3=cm, 4=mm, 5=um."""
    xres = _ratio(exif_ifd.get(41486))
    yres = _ratio(exif_ifd.get(41487))
    unit = exif_ifd.get(41488, 2)
    mm_per_unit = {2: 25.4, 3: 10.0, 4: 1.0, 5: 0.001}.get(unit)
    if not xres or not yres or mm_per_unit is None:
        return None
    px_w = _ratio(exif_ifd.get(40962)) or image_w
    px_h = _ratio(exif_ifd.get(40963)) or image_h
    return px_w / xres * mm_per_unit, px_h / yres * mm_per_unit


def read_optics(source_path: Path, image_w: int, image_h: int) -> Optics:
    main, exif_ifd, _gps = _read_exif(source_path)
    optics = Optics()
    if not exif_ifd and not main:
        return optics

    optics.camera_model = str(main.get(272, "")).strip() or None
    lens = str(exif_ifd.get(42036, "")).strip()
    optics.lens_model = lens or None
    optics.aperture = _ratio(exif_ifd.get(33437))
    optics.focal_mm = _ratio(exif_ifd.get(37386))
    f35 = _ratio(exif_ifd.get(41989))  # FocalLengthIn35mmFilm; 0 means unknown

    # Cropped/rotated-aspect files make any FOV derived from sensor size
    # wrong, since the true frame is only part of the sensor. Detect the
    # cheap-to-detect case (aspect mismatch with the sensor's recorded pixel
    # grid); uniform crops that keep the aspect ratio can't be detected.
    px_w = _ratio(exif_ifd.get(40962))
    px_h = _ratio(exif_ifd.get(40963))
    if px_w and px_h and image_w > 0 and image_h > 0:
        exif_aspect = max(px_w, px_h) / min(px_w, px_h)
        actual_aspect = max(image_w, image_h) / min(image_w, image_h)
        if abs(exif_aspect - actual_aspect) / exif_aspect > 0.03:
            return optics  # focal_mm etc. still reported, but no FOV

    if f35 is None and optics.focal_mm:
        sensor = _sensor_from_focal_plane(exif_ifd, image_w, image_h)
        if sensor is None and optics.camera_model:
            sensor = SENSOR_MM.get(optics.camera_model)
        if sensor:
            f35 = optics.focal_mm * _FULL_FRAME_DIAG_MM / math.hypot(*sensor)
    optics.focal_35mm = f35

    if f35 and image_w > 0 and image_h > 0:
        diag_px = math.hypot(image_w, image_h)
        f_px = f35 * diag_px / _FULL_FRAME_DIAG_MM
        optics.px_per_degree = f_px * math.pi / 180.0
        half = math.atan(_FULL_FRAME_DIAG_MM / (2.0 * f35))
        optics.half_diagonal_deg = math.degrees(half)
        optics.diagonal_fov_deg = 2.0 * optics.half_diagonal_deg
    return optics


def scale_bounds(optics: Optics, is_fisheye_corrected: bool) -> tuple[float, float] | None:
    """Allowed range of the matcher's |w| (image pixels per degree of
    constellation-plane distance), or None if the lens isn't known.

    Centre scale is px_per_degree; a rectilinear lens stretches the sky by up
    to 1/cos^2(theta) toward the corners, and the equirectangular
    constellation plane adds its own distortion for large figures, so the
    upper bound grows with the field of view. The lower side allows for
    focal-length rounding and mild cropping.
    """
    if not optics.px_per_degree:
        return None
    s0 = optics.px_per_degree
    half = math.radians(min(optics.half_diagonal_deg or 0.0, 70.0))
    edge_stretch = 1.0 if is_fisheye_corrected else 1.0 / math.cos(half) ** 2
    return s0 * 0.6, s0 * max(1.6, edge_stretch * 1.25)


def _parse_exif_datetime(text) -> dt.datetime | None:
    try:
        return dt.datetime.strptime(str(text).strip(), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _parse_offset(text) -> dt.timedelta | None:
    """'+02:00' / '-05:30' -> timedelta."""
    s = str(text).strip()
    if len(s) < 5 or s[0] not in "+-":
        return None
    try:
        hours, minutes = int(s[1:3]), int(s[4:6])
    except ValueError:
        return None
    delta = dt.timedelta(hours=hours, minutes=minutes)
    return -delta if s[0] == "-" else delta


def read_capture_time(
    source_path: Path,
    fallback_local: dt.datetime | None = None,
    longitude: float | None = None,
) -> CaptureTime:
    """Best available UTC capture time, most to least trustworthy:
    GPS clock stamp (already UTC) > EXIF local time + OffsetTimeOriginal >
    EXIF local time + timezone guessed from longitude."""
    main, exif_ifd, gps = _read_exif(source_path)

    date_stamp, time_stamp = gps.get(29), gps.get(7)
    if date_stamp and time_stamp:
        try:
            h, m, s = (float(v) for v in time_stamp)
            day = dt.datetime.strptime(str(date_stamp).strip(), "%Y:%m:%d")
            return CaptureTime(
                utc=day + dt.timedelta(hours=h, minutes=m, seconds=s), source="gps"
            )
        except (TypeError, ValueError):
            pass

    local = _parse_exif_datetime(exif_ifd.get(36867) or main.get(306)) or fallback_local
    if local is None:
        return CaptureTime()

    offset = _parse_offset(exif_ifd.get(36881) or exif_ifd.get(36880) or "")
    if offset is not None:
        return CaptureTime(utc=local - offset, local=local, source="offset")
    if longitude is not None:
        return CaptureTime(
            utc=local - dt.timedelta(hours=round(longitude / 15.0)),
            local=local,
            source="longitude",
        )
    return CaptureTime(local=local)


# --- Astronomy -------------------------------------------------------------


def _local_sidereal_deg(utc: dt.datetime, longitude_deg: float) -> float:
    """Local mean sidereal time in degrees (accurate to ~a second, ample here)."""
    jd = (utc - dt.datetime(2000, 1, 1, 12)).total_seconds() / 86400.0
    gmst = 280.46061837 + 360.98564736629 * jd
    return (gmst + longitude_deg) % 360.0


def _altitude_deg(ra: float, dec: float, lst: float, lat: float) -> float:
    ha = math.radians(lst - ra)
    d, phi = math.radians(dec), math.radians(lat)
    s = math.sin(d) * math.sin(phi) + math.cos(d) * math.cos(phi) * math.cos(ha)
    return math.degrees(math.asin(max(-1.0, min(1.0, s))))


def _hemisphere_of(latitude: float | None) -> str | None:
    if latitude is None:
        return None
    return "N" if latitude >= 0 else "S"


def possibly_visible(
    shapes: list[ConstellationDef],
    ctx: SkyContext,
    min_stars_needed: int,
    min_fraction: float = 0.0,
) -> tuple[set[str], str]:
    """Abbreviations of shapes that could have been in view, plus a note
    describing which prior was applied. Everything is kept when the context
    supports no filtering.

    A shape can only be matched if at least min_fraction of its stars (and at
    least min_stars_needed) were findable, so it must have that many stars
    above the horizon -- not merely a handful of them.
    """

    def needed(c: ConstellationDef) -> int:
        return min(len(c.stars), max(min_stars_needed, math.ceil(min_fraction * len(c.stars))))

    # Time-of-night filter: needs an actual latitude (GPS or user-entered),
    # not one merely assumed from a hemisphere, since the horizon test is
    # sensitive to latitude. Without a longitude the camera's local clock time
    # stands in for UTC: local sidereal time then errs by (longitude - 15 x
    # timezone) <= ~7.5 degrees, plus up to 15 more for daylight saving --
    # within the wide estimated-time margin.
    if ctx.latitude is not None and not ctx.latitude_assumed:
        when = None
        if ctx.longitude is not None and ctx.time.utc is not None:
            when, lon = ctx.time.utc, ctx.longitude
            margin = (
                HORIZON_MARGIN_DEG if ctx.time.source in ("gps", "offset")
                else ESTIMATED_TIME_HORIZON_MARGIN_DEG
            )
            tag = f"{ctx.time.source} time"
        elif ctx.time.local is not None:
            when, lon = ctx.time.local, 0.0
            margin = ESTIMATED_TIME_HORIZON_MARGIN_DEG
            tag = "camera clock time"
        if when is not None:
            lst = _local_sidereal_deg(when, lon)
            keep = {
                c.abbr
                for c in shapes
                if sum(_altitude_deg(s.ra_deg, s.dec_deg, lst, ctx.latitude) > margin for s in c.stars)
                >= needed(c)
            }
            return keep, f"above-horizon filter (lat {ctx.latitude:.1f}, {tag})"

    lat = ctx.latitude
    if lat is None and ctx.hemisphere in ("N", "S"):
        lat = ASSUMED_LATITUDE_FOR_HEMISPHERE * (1 if ctx.hemisphere == "N" else -1)
    if lat is not None:
        # Never-visible test only: a star with dec below -(90-|lat|) (north)
        # or above (90-|lat|) (south) never rises.
        keep = {
            c.abbr
            for c in shapes
            if sum(
                (s.dec_deg > lat - 90.0 - 3.0) if lat >= 0 else (s.dec_deg < lat + 90.0 + 3.0)
                for s in c.stars
            )
            >= needed(c)
        }
        label = (
            f"latitude {lat:.0f}"
            if ctx.latitude is not None and not ctx.latitude_assumed
            else ("northern hemisphere" if lat >= 0 else "southern hemisphere")
        )
        return keep, f"never-rises filter ({label})"

    return {c.abbr for c in shapes}, "no location/time available"


def build_sky_context(
    source_path: Path,
    image_w: int,
    image_h: int,
    latitude: float | None,
    longitude: float | None,
    captured_at: dt.datetime | None,
    hemisphere_override: str | None = None,
    latitude_override: float | None = None,
) -> SkyContext:
    ctx = SkyContext(latitude=latitude, longitude=longitude)
    ctx.optics = read_optics(source_path, image_w, image_h)
    ctx.time = read_capture_time(source_path, fallback_local=captured_at, longitude=longitude)
    ctx.hemisphere = _hemisphere_of(latitude)

    # Explicit user input beats GPS (which may be a bad fix): drop the GPS
    # position so it can't contradict it.
    if latitude_override is not None:
        ctx.latitude, ctx.longitude = latitude_override, None
        ctx.hemisphere = _hemisphere_of(latitude_override)
        ctx.notes.append("user latitude replaced GPS position")
    elif hemisphere_override in ("N", "S"):
        if latitude is not None and _hemisphere_of(latitude) != hemisphere_override:
            ctx.latitude, ctx.longitude = None, None
            ctx.notes.append("hemisphere override replaced GPS position")
        ctx.hemisphere = hemisphere_override
    if ctx.latitude is None and ctx.hemisphere in ("N", "S"):
        ctx.latitude_assumed = True  # possibly_visible derives the assumed value
    return ctx
