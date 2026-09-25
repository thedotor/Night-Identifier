"""Motion and meteor detection on a live camera.

Runs on its own thread, reading the newest frame whenever one arrives (so it never slows the camera),
and works on a small grey copy:

* motion mode: difference against a slowly-updated background; an event when enough of the picture
  changed. Good for security cameras and wildlife.
* meteor mode: only *brighter* changes count, and they must form a straight line. Stars are points
  and twinkle; a meteor, satellite or plane is a streak. Whole-frame changes (cloud, lightning, a
  torch) are ignored."""

from __future__ import annotations

import datetime as dt
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.services import events, log_capture
from app.services.live import capture, processing
from app.services.live.base import Frame

logger = log_capture.get_logger("live")

SMALL_WIDTH = 320
MAX_RATE_HZ = 15.0
PREROLL_S = 4.0
POSTROLL_S = 3.0
RING_MAX = 240
WARMUP_FRAMES = 8


class MotionDetector:
    def __init__(self, rt: Any, cfg: dict[str, Any]):
        self.rt = rt
        self.cfg = dict(cfg)
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"motion-{rt.id}", daemon=True)
        self.events = 0

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=5)

    # ---- analysis -----------------------------------------------------------------------
    @staticmethod
    def _small(frame: Frame) -> np.ndarray:
        data = frame.data
        if data.ndim == 3:
            data = data.mean(axis=2)
        h, w = data.shape[:2]
        scale = SMALL_WIDTH / w if w > SMALL_WIDTH else 1.0
        if scale < 1.0:
            data = cv2.resize(data.astype(np.float32), (SMALL_WIDTH, max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
        unit = data.astype(np.float32) / float(frame.max_value)
        return cv2.GaussianBlur(unit, (0, 0), 1.0)

    def _detect(self, small: np.ndarray, bg: np.ndarray) -> tuple[bool, float]:
        mode = self.cfg.get("mode", "motion")
        sens = float(self.cfg.get("sensitivity", 50))
        diff = small - bg
        noise = max(float(np.median(np.abs(diff))) * 1.4826, 1e-4)
        thr = (10.0 - 7.5 * sens / 100.0) * noise
        if mode == "meteor":
            mask = (diff > thr).astype(np.uint8)
            frac = float(mask.mean()) * 100.0
            if frac > 3.0 or frac == 0.0:  # a global brightness change is not a meteor
                return False, frac
            w = small.shape[1]
            lines = cv2.HoughLinesP(mask * 255, 1, np.pi / 180, threshold=12, minLineLength=max(12, int(0.10 * w)), maxLineGap=3)
            return lines is not None, frac
        mask = (np.abs(diff) > thr).astype(np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        frac = float(mask.mean()) * 100.0
        return frac >= float(self.cfg.get("min_area_pct", 0.05)), frac

    # ---- thread -------------------------------------------------------------------------
    def _run(self) -> None:
        rt = self.rt
        last_seq = -1
        last_proc = 0.0
        last_event = 0.0
        bg: np.ndarray | None = None
        seen = 0
        ring: deque[tuple[float, bytes]] = deque(maxlen=RING_MAX)
        pending: dict[str, Any] | None = None
        alpha = 0.10 if self.cfg.get("mode") == "meteor" else 0.03
        want_clip = bool(self.cfg.get("save_clip", True))
        while not self.stop_event.is_set():
            got = rt.wait_frame(last_seq, 1.0)
            if got is None:
                continue
            last_seq, frame = got
            now = time.time()
            if now - last_proc < 1.0 / MAX_RATE_HZ:
                continue
            last_proc = now
            try:
                if want_clip:
                    img = processing.to_display(frame, 640, processing.DEFAULT_STRETCH if rt.is_astro else None)
                    jpeg = processing.encode_jpeg(img, 70)
                    ring.append((now, jpeg))
                    while ring and now - ring[0][0] > PREROLL_S:
                        ring.popleft()
                    if pending is not None:
                        pending["frames"].append((now, jpeg))
                        if now >= pending["until"]:
                            threading.Thread(target=self._write_clip, args=(pending,), daemon=True).start()
                            pending = None

                small = self._small(frame)
                if bg is None or bg.shape != small.shape:
                    bg, seen = small.copy(), 0
                    continue
                seen += 1
                fired = False
                if seen > WARMUP_FRAMES:
                    fired, frac = self._detect(small, bg)
                    if fired and now - last_event >= float(self.cfg.get("cooldown_s", 10)):
                        last_event = now
                        clip = self._fire(frame, frac)
                        if want_clip and pending is None and clip is not None:
                            pending = {"path": clip, "frames": list(ring), "until": now + POSTROLL_S}
                bg = bg * (1.0 - alpha) + small * alpha
            except Exception:  # noqa: BLE001 - keep watching after a bad frame
                logger.exception("Motion detection failed on a frame")
                time.sleep(0.5)

    def _fire(self, frame: Frame, frac: float) -> Path | None:
        rt = self.rt
        kind = self.cfg.get("mode", "motion")
        when = dt.datetime.fromtimestamp(frame.timestamp)
        folder = capture.live_dir(rt, when) / "events"
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{capture.file_stem(rt, when)}_{kind}"
        saved: Path | None = None
        if self.cfg.get("save_frame", True):
            saved = folder / f"{stem}.jpg"
            capture.save_display_image(frame, saved, processing.DEFAULT_STRETCH if rt.is_astro else None, when)
        self.events += 1
        logger.info("%s detected on %s (%.2f%% of the frame)", kind.capitalize(), rt.cfg.get("name"), frac)
        events.emit_threadsafe(
            "live",
            {"type": "motion", "camera": rt.id, "name": rt.cfg.get("name"), "kind": kind, "file": str(saved) if saved else None, "changed_pct": round(frac, 2)},
        )
        return folder / f"{stem}.mp4"

    @staticmethod
    def _write_clip(job: dict[str, Any]) -> None:
        frames = job["frames"]
        if len(frames) < 2:
            return
        try:
            first = cv2.imdecode(np.frombuffer(frames[0][1], np.uint8), cv2.IMREAD_COLOR)
            h, w = first.shape[:2]
            span = max(frames[-1][0] - frames[0][0], 0.5)
            fps = float(min(30.0, max(2.0, len(frames) / span)))
            out = cv2.VideoWriter(str(job["path"]), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
            if not out.isOpened():
                return
            for _t, jpg in frames:
                img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    out.write(img if img.shape[:2] == (h, w) else cv2.resize(img, (w, h)))
            out.release()
        except Exception:  # noqa: BLE001
            logger.exception("Could not write the motion clip")
