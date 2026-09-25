"""Turning a camera frame into the bytes a viewer receives.

Wire format for one frame on the Live View WebSocket (binary message):
    4 bytes  big-endian length N of the header
    N bytes  UTF-8 JSON header (camera, seq, sizes, fps, optional histogram / focus)
    rest     JPEG image"""

from __future__ import annotations

import json
import struct
import time
from typing import Any

from app.services.live import processing
from app.services.live.base import Frame
from app.services.live.manager import CameraRuntime

FOCUS_EVERY_S = 0.5


def _focus(rt: CameraRuntime, frame: Frame, seq: int) -> dict[str, Any] | None:
    """Focus metrics are shared between viewers and refreshed at most twice a second."""
    with rt.metrics_lock:
        m = rt.metrics
        if m.get("seq") == seq or time.time() - m.get("ts", 0.0) < FOCUS_EVERY_S:
            return m.get("focus")
    value = processing.focus_metrics(frame)
    with rt.metrics_lock:
        rt.metrics = {"ts": time.time(), "seq": seq, "focus": value}
    return value


def render(
    rt: CameraRuntime,
    frame: Frame,
    seq: int,
    *,
    width: int | None,
    quality: int = 78,
    stretch: dict[str, Any] | None = None,
    hist: bool = False,
    focus: bool = False,
) -> bytes:
    if stretch is None and rt.is_astro:
        stretch = processing.DEFAULT_STRETCH
    img = processing.to_display(frame, width, stretch)
    jpeg = processing.encode_jpeg(img, quality)
    header: dict[str, Any] = {
        "cam": rt.id,
        "seq": seq,
        "ts": frame.timestamp,
        "w": int(img.shape[1]),
        "h": int(img.shape[0]),
        "sw": frame.width,
        "sh": frame.height,
        "bits": frame.bit_depth,
        "fps": round(rt.fps, 1),
        "exp": frame.exposure_s,
    }
    if frame.meta.get("temperature") is not None:
        header["temp"] = round(float(frame.meta["temperature"]), 1)
    if hist:
        header["hist"] = processing.histogram(frame)
    if focus:
        header["focus"] = _focus(rt, frame, seq)
    hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(hb)) + hb + jpeg
