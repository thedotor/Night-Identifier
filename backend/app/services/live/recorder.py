"""Video recording of a live camera to MP4 or SER, on its own writer thread so a slow disk never
stalls the camera."""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.services import events, log_capture
from app.services.live import processing
from app.services.live.base import Frame
from app.services.live.ser import SerWriter

logger = log_capture.get_logger("live")

QUEUE_FRAMES = 48


class Recorder:
    """Attach with `start()`; `stop()` finishes the file and returns a summary."""

    def __init__(self, rt: Any, path: Path, fmt: str, stretch: dict[str, Any] | None):
        self.rt = rt
        self.path = path
        self.fmt = fmt  # 'mp4' | 'ser'
        self.stretch = stretch
        self.q: queue.Queue[Frame | None] = queue.Queue(maxsize=QUEUE_FRAMES)
        self.thread = threading.Thread(target=self._run, name=f"rec-{rt.id}", daemon=True)
        self.dropped = 0
        self.written = 0
        self.started = time.time()
        self.error: str | None = None
        self._stopped = False

    def start(self) -> None:
        self.thread.start()
        self.rt.jobs["record"] = self
        self.rt.taps["record"] = self.push
        events.emit_threadsafe("live", {"type": "status", **self.rt.status()})

    def push(self, frame: Frame) -> None:  # called on the capture thread: must be quick
        try:
            self.q.put_nowait(frame)
        except queue.Full:
            self.dropped += 1

    def stop(self) -> dict[str, Any]:
        if not self._stopped:
            self._stopped = True
            self.rt.taps.pop("record", None)
            self.rt.jobs.pop("record", None)
            self.q.put(None)
            self.thread.join(timeout=20)
            events.emit_threadsafe("live", {"type": "status", **self.rt.status()})
        return {"file": str(self.path), "frames": self.written, "dropped": self.dropped, "seconds": round(time.time() - self.started, 1), "error": self.error}

    def _run(self) -> None:
        writer: Any = None
        ser: SerWriter | None = None
        size: tuple[int, int] | None = None
        try:
            while True:
                frame = self.q.get()
                if frame is None:
                    break
                if self.fmt == "ser":
                    if ser is None:
                        colour = frame.data.ndim == 3
                        ser = SerWriter(self.path, frame.width, frame.height, frame.bit_depth, frame.bayer, colour, instrument=str(self.rt.cfg.get("name", "")))
                    ser.write(frame.data)
                    self.written += 1
                else:
                    img = processing.to_display(frame, None, self.stretch)
                    if img.ndim == 2:
                        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
                    if writer is None:
                        size = (img.shape[1], img.shape[0])
                        fps = float(min(60.0, max(1.0, round(self.rt.fps or 10.0))))
                        writer = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
                        if not writer.isOpened():
                            raise RuntimeError("This computer cannot write MP4 video (no encoder). Try SER or use snapshots.")
                    elif (img.shape[1], img.shape[0]) != size:
                        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
                    writer.write(np.ascontiguousarray(img))
                    self.written += 1
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc)
            logger.exception("Recording failed")
            self.rt.taps.pop("record", None)
            self.rt.jobs.pop("record", None)
        finally:
            if writer is not None:
                writer.release()
            if ser is not None:
                ser.close()
