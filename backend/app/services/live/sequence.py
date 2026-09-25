"""Timelapse / capture sequences: N frames, one every `interval_s` seconds, saved to a folder
(and optionally added to the library afterwards)."""

from __future__ import annotations

import datetime as dt
import threading
import time
from pathlib import Path
from typing import Any

from app.db import SessionLocal
from app.services import events, log_capture
from app.services.live import capture

logger = log_capture.get_logger("live")


class SequenceJob:
    def __init__(self, rt: Any, count: int, interval_s: float, fmt: str, to_library: bool, stretch: dict[str, Any] | None):
        self.rt = rt
        self.count = max(1, int(count))
        self.interval = max(0.0, float(interval_s))
        self.fmt = fmt
        self.to_library = to_library
        self.stretch = stretch
        self.done = 0
        self.folder: Path | None = None
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"seq-{rt.id}", daemon=True)

    def start(self) -> None:
        when = dt.datetime.now()
        self.folder = capture.live_dir(self.rt, when) / f"{capture.file_stem(self.rt, when)}_sequence"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.rt.jobs["sequence"] = self
        self.thread.start()
        events.emit_threadsafe("live", {"type": "status", **self.rt.status()})

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout=15)

    def _emit_progress(self) -> None:
        events.emit_threadsafe("live", {"type": "progress", "camera": self.rt.id, "kind": "sequence", "done": self.done, "total": self.count})

    def _run(self) -> None:
        rt = self.rt
        saved: list[Path] = []
        t0 = time.time()
        try:
            self._emit_progress()
            for i in range(self.count):
                if self.stop_event.wait(max(0.0, t0 + i * self.interval - time.time())):
                    break
                # a frame that starts after now, not the one already on screen
                exposure = (rt.latest().exposure_s or 0.0) if rt.latest() else 0.0
                got = rt.wait_frame(rt.seq, max(10.0, exposure * 3 + 5))
                if got is None:
                    if self.stop_event.is_set():
                        break
                    continue
                _seq, frame = got
                saved.append(capture.save_frame(rt, frame, self.folder, self.fmt, self.stretch, stem=f"frame_{i + 1:04d}"))
                self.done += 1
                self._emit_progress()
        except Exception:  # noqa: BLE001
            logger.exception("Capture sequence failed")
        finally:
            rt.jobs.pop("sequence", None)
            imported = 0
            if self.to_library and saved:
                db = SessionLocal()
                try:
                    imported = capture.import_files(saved, db)
                except Exception:  # noqa: BLE001
                    logger.exception("Could not add the sequence to the library")
                finally:
                    db.close()
            events.emit_threadsafe(
                "live",
                {"type": "sequence_done", "camera": rt.id, "name": rt.cfg.get("name"), "frames": self.done, "imported": imported, "folder": str(self.folder), "stopped_early": self.done < self.count},
            )
            events.emit_threadsafe("live", {"type": "status", **rt.status()})
