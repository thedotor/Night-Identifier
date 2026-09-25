import datetime as dt
import struct
from pathlib import Path

from PIL import ExifTags
from PIL import Image as PILImage

RAW_EXTENSIONS = {".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw"}
FITS_EXTENSIONS = {".fit", ".fits", ".fts"}
MAX_PREVIEW_DIMENSION = 2200


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXTENSIONS


def is_fits(path: Path) -> bool:
    return path.suffix.lower() in FITS_EXTENSIONS


def _load_fits(path: Path) -> PILImage.Image:
    """A FITS frame as a viewable 8-bit image: debayered if it is a colour sensor's raw data and
    auto-stretched (raw astro data is linear, so unstretched it would look black)."""
    import cv2
    import numpy as np

    from app.services import fits_io
    from app.services.live import processing
    from app.services.live.base import Frame

    data, header = fits_io.read_fits(path)
    if data.dtype != np.uint16 and data.dtype != np.uint8:
        lo, hi = float(np.nanmin(data)), float(np.nanmax(data))
        data = ((np.nan_to_num(data) - lo) / max(hi - lo, 1e-9) * 65535.0).astype(np.uint16)
    bits = 16 if data.dtype == np.uint16 else 8
    if bits == 16:
        peak = int(data.max())
        for depth in (10, 12, 14, 16):  # a 12-bit camera stores 0..4095 in a 16-bit field
            if peak < (1 << depth):
                bits = depth
                break
    bayer = str(header.get("BAYERPAT", "")).strip().upper() or None
    frame = Frame(data=data, bit_depth=bits, bayer=bayer if data.ndim == 2 else None)
    img = processing.to_display(frame, None, {"mode": "auto"})
    if img.ndim == 3:
        return PILImage.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    return PILImage.fromarray(img).convert("RGB")


def load_full_resolution(path: Path) -> PILImage.Image:
    """Decode any supported format (including camera RAW and FITS) to a PIL image."""
    if is_fits(path):
        return _load_fits(path)
    if is_raw(path):
        import rawpy

        with rawpy.imread(str(path)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, no_auto_bright=False)
        return PILImage.fromarray(rgb)

    img = PILImage.open(path)
    img.load()
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    return img


def generate_preview(source_path: Path, preview_path: Path) -> tuple[int, int]:
    """Decode source_path and write a browser-displayable JPEG preview.

    Returns the *original* (full-resolution) width/height, since that's the
    coordinate space annotations are stored in.
    """
    img = load_full_resolution(source_path)
    original_size = img.size

    preview = img.copy()
    preview.thumbnail((MAX_PREVIEW_DIMENSION, MAX_PREVIEW_DIMENSION), PILImage.LANCZOS)
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    if preview.mode != "RGB":
        preview = preview.convert("RGB")
    preview.save(preview_path, "JPEG", quality=90)

    return original_size


def _gps_to_decimal(dms, ref: str | None) -> float | None:
    if not dms or not ref:
        return None
    try:
        degrees, minutes, seconds = (float(v) for v in dms)
    except (TypeError, ValueError):
        return None
    value = degrees + minutes / 60 + seconds / 3600
    if value != value:  # a zero-denominator rational
        return None
    return -value if ref in ("S", "W") else value


def extract_metadata(source_path: Path) -> dict:
    """Best-effort EXIF extraction: GPS coordinates and capture time.

    Many camera RAW formats (CR2, NEF, DNG, ...) are TIFF-structured and
    carry ordinary EXIF tags even though Pillow can't decode their pixel
    data, so this is worth trying regardless of format -- any failure just
    means no metadata, not a failed import.
    """
    result: dict = {}
    if is_fits(source_path):
        return _fits_metadata(source_path)
    if is_raw(source_path):
        # Pillow can't identify some RAW containers (Sony ARW, ...) even though
        # they are TIFF-structured, which would silently drop their GPS/time.
        result = _tiff_metadata(source_path)
        if "latitude" in result:
            return result
    try:
        with PILImage.open(source_path) as img:
            exif = img.getexif()
            if not exif:
                return result

            exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
            date_str = exif_ifd.get(36867) or exif.get(306)  # DateTimeOriginal / DateTime
            if date_str:
                try:
                    result["captured_at"] = dt.datetime.strptime(str(date_str), "%Y:%m:%d %H:%M:%S")
                except ValueError:
                    pass

            gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
            if gps_ifd:
                lat = _gps_to_decimal(gps_ifd.get(2), gps_ifd.get(1))
                lon = _gps_to_decimal(gps_ifd.get(4), gps_ifd.get(3))
                # Many cameras write zeroed GPS tags when GPS was enabled but
                # never got a satellite fix (e.g. indoors). (0, 0) is open
                # ocean off West Africa -- for this app it's always a missing
                # fix, never a real photo location, so treat it as absent.
                if lat is not None and lon is not None and (lat != 0.0 or lon != 0.0):
                    result["latitude"] = lat
                    result["longitude"] = lon
    except Exception:  # noqa: BLE001
        pass
    return result


def _tiff_ifd(f, endian: str, offset: int) -> dict[int, tuple[int, int, bytes]]:
    """One TIFF IFD as {tag: (type, count, raw 4-byte value/offset field)}."""
    f.seek(offset)
    (n,) = struct.unpack(endian + "H", f.read(2))
    entries = {}
    for raw in struct.iter_unpack(endian + "HHI4s", f.read(12 * min(n, 512))):
        entries[raw[0]] = (raw[1], raw[2], raw[3])
    return entries


def _tiff_values(f, endian: str, entry: tuple[int, int, bytes]) -> list | str | None:
    """Decode an ASCII (2), SHORT (3), LONG (4) or RATIONAL (5) entry."""
    typ, count, field = entry
    size = {2: 1, 3: 2, 4: 4, 5: 8}.get(typ)
    if size is None or count == 0 or count > 64:
        return None
    total = size * count
    if total <= 4:
        data = field[:total]
    else:
        f.seek(struct.unpack(endian + "I", field)[0])
        data = f.read(total)
    if len(data) < total:
        return None
    if typ == 2:
        return data.split(b"\0")[0].decode("ascii", "replace")
    if typ == 5:
        pairs = struct.unpack(endian + "II" * count, data)
        return [pairs[i] / pairs[i + 1] if pairs[i + 1] else float("nan") for i in range(0, len(pairs), 2)]
    return list(struct.unpack(endian + {3: "H", 4: "I"}[typ] * count, data))


def _tiff_metadata(source_path: Path) -> dict:
    """Capture time + GPS read straight from a TIFF-structured file's IFDs
    (no pixel decoding), for RAW containers Pillow refuses to open."""
    result: dict = {}
    try:
        with open(source_path, "rb") as f:
            head = f.read(8)
            endian = {b"II": "<", b"MM": ">"}.get(head[:2])
            if endian is None or struct.unpack(endian + "H", head[2:4])[0] != 42:
                return result
            ifd0 = _tiff_ifd(f, endian, struct.unpack(endian + "I", head[4:8])[0])

            def sub_ifd(tag: int) -> dict:
                entry = ifd0.get(tag)
                if not entry:
                    return {}
                return _tiff_ifd(f, endian, struct.unpack(endian + "I", entry[2])[0])

            exif_ifd = sub_ifd(0x8769)
            date = _tiff_values(f, endian, exif_ifd[0x9003]) if 0x9003 in exif_ifd else None
            if not date and 0x0132 in ifd0:
                date = _tiff_values(f, endian, ifd0[0x0132])
            if isinstance(date, str):
                try:
                    result["captured_at"] = dt.datetime.strptime(date, "%Y:%m:%d %H:%M:%S")
                except ValueError:
                    pass

            gps = sub_ifd(0x8825)
            if all(t in gps for t in (1, 2, 3, 4)):
                lat = _gps_to_decimal(_tiff_values(f, endian, gps[2]), _tiff_values(f, endian, gps[1]))
                lon = _gps_to_decimal(_tiff_values(f, endian, gps[4]), _tiff_values(f, endian, gps[3]))
                if lat is not None and lon is not None and (lat != 0.0 or lon != 0.0):
                    result["latitude"], result["longitude"] = lat, lon
    except Exception:  # noqa: BLE001 - metadata is best effort
        pass
    return result


def _fits_metadata(source_path: Path) -> dict:
    from app.services import fits_io

    result: dict = {}
    try:
        header = fits_io.read_header(source_path)
        when = fits_io.date_obs_local(header)
        if when:
            result["captured_at"] = when
        lat, lon = header.get("SITELAT"), header.get("SITELONG")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat != 0 or lon != 0):
            result["latitude"], result["longitude"] = float(lat), float(lon)
    except Exception:  # noqa: BLE001 - metadata is best effort
        pass
    return result
