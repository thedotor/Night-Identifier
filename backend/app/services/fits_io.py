"""Minimal FITS reader/writer (no astropy needed): single image HDU, 8/16-bit integer or float data,
mono or 3-plane colour. Enough for camera captures and for previewing them in the library."""

from __future__ import annotations

import datetime as dt
import io
from pathlib import Path
from typing import Any

import numpy as np

BLOCK = 2880
CARD = 80

_READ_DTYPES = {8: ">u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}


def _card(key: str, value: Any = None, comment: str = "") -> str:
    if key in ("COMMENT", "HISTORY", "END") or value is None:
        return f"{key:<8}{'' if value is None else ' ' + str(value)}"[:CARD].ljust(CARD)
    if isinstance(value, bool):
        body = f"{'T' if value else 'F':>20}"
    elif isinstance(value, int):
        body = f"{value:>20d}"
    elif isinstance(value, float):
        body = f"{value:>20.10g}"
        if "." not in body and "e" not in body.lower():
            body = f"{value:>20.1f}"
    else:
        text = str(value).replace("'", "''")
        body = f"'{text:<8}'"
    card = f"{key:<8}= {body}"
    if comment:
        card += f" / {comment}"
    return card[:CARD].ljust(CARD)


def write_fits(path: Path, data: np.ndarray, header: dict[str, Any] | None = None) -> None:
    """Write `data` (HxW mono, or HxWx3 BGR colour; uint8 or uint16) as a FITS file. Rows are stored
    bottom-up, as FITS readers expect, so the image opens the right way up."""
    if data.dtype not in (np.uint8, np.uint16):
        raise ValueError("FITS export supports 8-bit and 16-bit data")
    if data.ndim == 3:
        planes = np.ascontiguousarray(np.flipud(data[:, :, ::-1]).transpose(2, 0, 1))  # BGR -> RGB planes
        axes = [planes.shape[2], planes.shape[1], planes.shape[0]]
    else:
        planes = np.ascontiguousarray(np.flipud(data))
        axes = [planes.shape[1], planes.shape[0]]

    cards = [_card("SIMPLE", True, "conforms to FITS standard")]
    if data.dtype == np.uint16:
        cards.append(_card("BITPIX", 16))
    else:
        cards.append(_card("BITPIX", 8))
    cards.append(_card("NAXIS", len(axes)))
    for i, n in enumerate(axes, start=1):
        cards.append(_card(f"NAXIS{i}", int(n)))
    if data.dtype == np.uint16:
        cards.append(_card("BZERO", 32768, "offset for unsigned 16-bit data"))
        cards.append(_card("BSCALE", 1))
    for key, value in (header or {}).items():
        if value is None:
            continue
        cards.append(_card(key[:8].upper(), value))
    cards.append(_card("END"))
    head = "".join(cards).encode("ascii", "replace")
    head += b" " * (-len(head) % BLOCK)

    if data.dtype == np.uint16:
        raw = (planes.astype(np.int32) - 32768).astype(">i2").tobytes()
    else:
        raw = planes.tobytes()
    raw += b"\0" * (-len(raw) % BLOCK)
    Path(path).write_bytes(head + raw)


def _parse_value(text: str) -> Any:
    text = text.strip()
    if text.startswith("'"):
        end = text.rfind("'")
        return text[1:end].replace("''", "'").rstrip()
    text = text.split("/")[0].strip()
    if text in ("T", "F"):
        return text == "T"
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text.replace("D", "E"))
    except ValueError:
        return text


def _parse_header(f: Any) -> dict[str, Any]:
    """Read header blocks from an open binary file, leaving it positioned at the data."""
    header: dict[str, Any] = {}
    while True:
        block = f.read(BLOCK)
        if not block:
            raise ValueError("FITS header is truncated")
        for i in range(0, len(block), CARD):
            card = block[i : i + CARD].decode("ascii", "replace")
            key = card[:8].strip()
            if key == "END":
                return header
            if card[8:10] == "= " and key:
                header[key] = _parse_value(card[10:])


def read_header(path: Path) -> dict[str, Any]:
    """Only the primary header (cheap; used for capture time and location on import)."""
    with open(path, "rb") as f:
        return _parse_header(f)


def _read_stream(f: Any) -> tuple[np.ndarray, dict[str, Any]]:
    header = _parse_header(f)
    naxis = int(header.get("NAXIS", 0))
    bitpix = int(header.get("BITPIX", 16))
    if naxis < 2 or bitpix not in _READ_DTYPES:
        raise ValueError("Unsupported FITS layout")
    dims = [int(header[f"NAXIS{i}"]) for i in range(1, naxis + 1)]
    count = int(np.prod(dims))
    raw = np.frombuffer(f.read(count * abs(bitpix) // 8), dtype=_READ_DTYPES[bitpix])
    if raw.size < count:
        raise ValueError("FITS data is truncated")
    arr = raw.reshape(dims[::-1])  # NAXIS1 is the fastest axis
    bzero = float(header.get("BZERO", 0.0))
    bscale = float(header.get("BSCALE", 1.0))
    if bitpix == 16 and bzero == 32768.0 and bscale == 1.0:
        arr = (arr.astype(np.int32) + 32768).astype(np.uint16)
    elif bzero != 0.0 or bscale != 1.0 or bitpix < 0:
        arr = arr.astype(np.float32) * bscale + bzero
    else:
        arr = arr.astype(arr.dtype.newbyteorder("="))
    if arr.ndim == 3:
        # planes (3,H,W) RGB -> HxWx3 BGR; keep the first three planes
        arr = np.ascontiguousarray(arr[:3].transpose(1, 2, 0)[:, :, ::-1])
    elif arr.ndim > 3:
        arr = arr.reshape(-1, *arr.shape[-2:])[0]
    if str(header.get("ROWORDER", "")).upper() != "TOP-DOWN":
        arr = np.ascontiguousarray(np.flipud(arr))
    return arr, header


def read_fits(path: Path) -> tuple[np.ndarray, dict[str, Any]]:
    """Return (data, header). Data is HxW or HxWx3 (BGR, like OpenCV) as stored (scaled by BSCALE/BZERO,
    unsigned 16-bit kept as uint16), top row first."""
    with open(path, "rb") as f:
        return _read_stream(f)


def read_fits_bytes(buf: bytes) -> tuple[np.ndarray, dict[str, Any]]:
    """Same as read_fits for a FITS file already in memory (e.g. an INDI BLOB)."""
    return _read_stream(io.BytesIO(buf))


def date_obs_local(header: dict[str, Any]) -> dt.datetime | None:
    """DATE-OBS is UTC by the FITS standard; the library stores naive local time like EXIF."""
    raw = header.get("DATE-OBS")
    if not raw:
        return None
    text = str(raw).strip().rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            utc = dt.datetime.strptime(text, fmt).replace(tzinfo=dt.timezone.utc)
            return utc.astimezone().replace(tzinfo=None)
        except ValueError:
            continue
    return None
