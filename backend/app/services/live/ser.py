"""SER video files (the planetary-imaging format read by AutoStakkert!, PIPP, Siril, Registax).

Layout (SER v3): 178-byte header, then raw frames one after another, then an optional trailer with
one 64-bit UTC timestamp per frame."""

from __future__ import annotations

import datetime as dt
import struct
from pathlib import Path
from typing import BinaryIO

import numpy as np

COLOR_IDS = {None: 0, "RGGB": 8, "GRBG": 9, "GBRG": 10, "BGGR": 11}
COLOR_BGR = 101
_EPOCH = dt.datetime(1, 1, 1)


def _ticks(t: dt.datetime) -> int:
    """.NET-style ticks (100 ns) since 0001-01-01, as SER timestamps use."""
    d = t - _EPOCH
    return d.days * 864_000_000_000 + d.seconds * 10_000_000 + d.microseconds * 10


class SerWriter:
    HEADER = 178

    def __init__(self, path: Path, width: int, height: int, depth: int, bayer: str | None, colour: bool, instrument: str = "", observer: str = "Night Identifier"):
        self.path = path
        self.w, self.h = width, height
        self.colour = colour
        self.depth = 16 if depth > 8 else 8
        self.frames = 0
        self.stamps: list[int] = []
        self._f: BinaryIO = open(path, "wb")
        colour_id = COLOR_BGR if colour else COLOR_IDS.get((bayer or "").upper() or None, 0)
        self._colour_id = colour_id
        self._instrument = instrument
        self._observer = observer
        self._started = dt.datetime.now()
        self._started_utc = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        self._write_header()

    def _write_header(self) -> None:
        def pad(text: str) -> bytes:
            return text.encode("ascii", "replace")[:40].ljust(40, b"\0")

        f = self._f
        f.seek(0)
        f.write(b"LUCAM-RECORDER")
        f.write(struct.pack("<i", 0))  # LuID
        f.write(struct.pack("<i", self._colour_id))
        f.write(struct.pack("<i", 1))  # 16-bit data is little-endian
        f.write(struct.pack("<iii", self.w, self.h, self.depth))
        f.write(struct.pack("<i", self.frames))
        f.write(pad(self._observer) + pad(self._instrument) + pad(""))
        f.write(struct.pack("<qq", _ticks(self._started), _ticks(self._started_utc)))

    def write(self, data: np.ndarray) -> None:
        if data.shape[0] != self.h or data.shape[1] != self.w:
            raise ValueError("Frame size changed during recording")
        if self.depth == 16:
            arr = data.astype("<u2", copy=False)
        else:
            arr = data.astype(np.uint8, copy=False)
        self._f.write(np.ascontiguousarray(arr).tobytes())
        self.frames += 1
        self.stamps.append(_ticks(dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)))

    def close(self) -> None:
        f = self._f
        if f.closed:
            return
        f.seek(0, 2)
        f.write(struct.pack(f"<{len(self.stamps)}q", *self.stamps))
        self._write_header()  # now with the real frame count
        f.close()
