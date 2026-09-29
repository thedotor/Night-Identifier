"""Owns every running camera: one capture thread each, the latest frame, reconnect, viewers.

The thread model is deliberately simple. Each camera has one thread that opens the driver,
loops on `driver.read()`, and stores only the *latest* frame. Consumers (WebSocket viewers,
recorders, the motion detector) never queue frames; they wait for "a newer frame than the one
I last saw", so a slow consumer skips frames instead of piling them up."""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from concurrent.futures import Future
from typing import Any, Callable

from app.services import events, log_capture
from app.services.live import drivers, store
from app.services.live.base import CameraDriver, CameraError, DriverUnavailable, Frame

logger = log_capture.get_logger("live")

IDLE_STOP_S = 20.0  # a camera nobody watches (and not marked background) is released after this
RECONNECT_MAX_S = 15.0
STATUS_EVERY_S = 2.0


class CameraRuntime:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.id: str = cfg["id"]
        self.state = "stopped"  # stopped | connecting | running | lost | error | unavailable
        self.error: str | None = None
        self.frame: Frame | None = None
        self.seq = 0
        self.fps = 0.0
        self.controls: list[dict[str, Any]] = []
        self.info: dict[str, Any] = {}
        self.is_astro = False
        self.cond = threading.Condition()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.viewers = 0
        self.idle_since: float | None = None
        self.busy = False  # the driver is mid-exposure: keep it running with no viewers
        self.pending: queue.Queue[tuple[str, Any, Future]] = queue.Queue()
        self.taps: dict[str, Callable[[Frame], None]] = {}  # called with every frame on the capture thread
        self.jobs: dict[str, Any] = {}  # running recorder / sequence / motion detector, by name
        self.metrics_lock = threading.Lock()
        self.metrics: dict[str, Any] = {"ts": 0.0}
        self._t_last = 0.0
        # asyncio events set (thread-safely) on every new frame, so WebSocket viewers sleep
        # instead of parking a worker thread each
        self.watchers: list[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = []

    # ---- consumers ----------------------------------------------------------------------
    def wait_frame(self, after_seq: int, timeout: float) -> tuple[int, Frame] | None:
        with self.cond:
            if not self.cond.wait_for(lambda: self.seq > after_seq or self.stop_event.is_set(), timeout):
                return None
            if self.frame is None or self.seq <= after_seq:
                return None
            return self.seq, self.frame

    def latest(self) -> Frame | None:
        with self.cond:
            return self.frame

    def status(self) -> dict[str, Any]:
        f = self.frame
        return {
            "id": self.id,
            "state": self.state,
            "error": self.error,
            "fps": round(self.fps, 1),
            "width": f.width if f is not None else None,
            "height": f.height if f is not None else None,
            "bit_depth": f.bit_depth if f is not None else None,
            "viewers": self.viewers,
            "astro": self.is_astro,
            "info": self.info,
            "recording": "record" in self.jobs,
            "sequence": "sequence" in self.jobs,
            "detecting": "motion" in self.jobs,
            "controls": self.controls,
        }

    # ---- producer side ------------------------------------------------------------------
    def _publish(self, frame: Frame) -> None:
        now = time.time()
        if self._t_last:
            inst = 1.0 / max(now - self._t_last, 1e-3)
            self.fps = inst if self.fps == 0 else self.fps * 0.8 + inst * 0.2
        self._t_last = now
        with self.cond:
            self.frame = frame
            self.seq += 1
            self.cond.notify_all()
        for loop, ev in list(self.watchers):
            try:
                loop.call_soon_threadsafe(ev.set)
            except RuntimeError:  # that loop has closed
                pass
        for name, tap in list(self.taps.items()):
            try:
                tap(frame)
            except Exception:  # noqa: BLE001
                logger.exception("Live tap '%s' failed on camera %s; removing it", name, self.id)
                self.taps.pop(name, None)


class LiveManager:
    def __init__(self) -> None:
        self._runtimes: dict[str, CameraRuntime] = {}
        self._lock = threading.RLock()
        self._reaper: threading.Thread | None = None
        self._stopping = threading.Event()

    # ---- lifecycle ----------------------------------------------------------------------
    def startup(self) -> None:
        self._stopping.clear()
        for cfg in store.list_cameras():
            rt = self._runtime(cfg["id"])
            if rt and (cfg.get("background") or cfg.get("motion", {}).get("enabled")):
                self.start(cfg["id"])
        self._reaper = threading.Thread(target=self._reap_loop, name="live-reaper", daemon=True)
        self._reaper.start()

    def shutdown(self) -> None:
        self._stopping.set()
        runtimes = list(self._runtimes.values())
        # signal everything first, then wait once for all of them, so nine cameras do not
        # cost nine separate timeouts when the app closes
        for rt in runtimes:
            rt.stop_event.set()
            with rt.cond:
                rt.cond.notify_all()
        deadline = time.time() + 8.0
        for rt in runtimes:
            self._stop_jobs(rt)
            t = rt.thread
            if t is not None and t.is_alive():
                t.join(timeout=max(0.1, deadline - time.time()))
            rt.thread = None
            rt.state = "stopped"

    def _reap_loop(self) -> None:
        while not self._stopping.wait(2.0):
            now = time.time()
            for rt in list(self._runtimes.values()):
                if rt.state == "stopped" or rt.viewers > 0 or self._wants_background(rt):
                    rt.idle_since = None
                    continue
                if rt.idle_since is None:
                    rt.idle_since = now
                elif now - rt.idle_since > IDLE_STOP_S:
                    logger.info("Releasing idle camera %s", rt.cfg.get("name"))
                    self.stop(rt.id)

    @staticmethod
    def _wants_background(rt: CameraRuntime) -> bool:
        return bool(rt.cfg.get("background")) or bool(rt.jobs) or rt.busy

    # ---- runtime registry ---------------------------------------------------------------
    def _runtime(self, camera_id: str) -> CameraRuntime | None:
        with self._lock:
            rt = self._runtimes.get(camera_id)
            cfg = store.get_camera(camera_id)
            if cfg is None:
                if rt:
                    self._runtimes.pop(camera_id, None)
                return None
            if rt is None:
                rt = CameraRuntime(cfg)
                self._runtimes[camera_id] = rt
            else:
                rt.cfg = cfg
            return rt

    def get(self, camera_id: str) -> CameraRuntime | None:
        return self._runtime(camera_id)

    def statuses(self) -> dict[str, dict[str, Any]]:
        out = {}
        for cfg in store.list_cameras():
            rt = self._runtime(cfg["id"])
            if rt:
                out[cfg["id"]] = rt.status()
        return out

    def busy_uvc_indices(self) -> set[int]:
        out: set[int] = set()
        for rt in self._runtimes.values():
            if rt.cfg.get("kind") == "uvc" and rt.state in ("running", "connecting", "lost"):
                out.add(int(rt.cfg.get("params", {}).get("index", -1)))
        return out

    # ---- start / stop -------------------------------------------------------------------
    def start(self, camera_id: str) -> bool:
        rt = self._runtime(camera_id)
        if rt is None:
            return False
        with self._lock:
            if rt.thread is not None and rt.thread.is_alive():
                return True
            rt.stop_event.clear()
            rt.state = "connecting"
            rt.error = None
            rt.idle_since = None
            rt.thread = threading.Thread(target=self._run, args=(rt,), name=f"live-{camera_id}", daemon=True)
            rt.thread.start()
        if rt.cfg.get("motion", {}).get("enabled") and "motion" not in rt.jobs:
            self.apply_motion(camera_id)
        self._emit(rt)
        return True

    def stop(self, camera_id: str) -> None:
        rt = self._runtimes.get(camera_id)
        if rt is None:
            return
        rt.stop_event.set()
        with rt.cond:
            rt.cond.notify_all()
        t = rt.thread
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=6.0)
        rt.thread = None
        self._stop_jobs(rt)
        rt.state = "stopped"
        rt.fps = 0.0
        rt.controls = []
        self._emit(rt)

    @staticmethod
    def _stop_jobs(rt: CameraRuntime) -> None:
        for job in list(rt.jobs.values()):
            try:
                job.stop()
            except Exception:  # noqa: BLE001
                logger.exception("Could not stop a live job cleanly")
        rt.jobs.clear()
        rt.taps.clear()

    def apply_motion(self, camera_id: str) -> None:
        """(Re)start or stop the motion/meteor detector to match the camera's saved settings."""
        rt = self._runtime(camera_id)
        if rt is None:
            return
        old = rt.jobs.pop("motion", None)
        if old is not None:
            old.stop()
        settings_ = rt.cfg.get("motion", {})
        if settings_.get("enabled"):
            from app.services.live.motion import MotionDetector

            det = MotionDetector(rt, settings_)
            rt.jobs["motion"] = det
            det.start()
            if rt.state in ("stopped", "unavailable") or rt.thread is None or not rt.thread.is_alive():
                self.start(camera_id)
        self._emit(rt)

    def forget(self, camera_id: str) -> None:
        self.stop(camera_id)
        with self._lock:
            self._runtimes.pop(camera_id, None)

    # ---- viewers ------------------------------------------------------------------------
    def viewer_join(self, camera_id: str) -> CameraRuntime | None:
        rt = self._runtime(camera_id)
        if rt is None:
            return None
        rt.viewers += 1
        rt.idle_since = None
        if rt.state in ("stopped", "unavailable") or rt.thread is None or not rt.thread.is_alive():
            self.start(camera_id)
        return rt

    def viewer_leave(self, camera_id: str) -> None:
        rt = self._runtimes.get(camera_id)
        if rt is not None:
            rt.viewers = max(0, rt.viewers - 1)

    # ---- controls (applied by the capture thread, between reads) ------------------------
    def set_control(self, camera_id: str, name: str, value: Any, timeout: float = 3.0) -> dict[str, Any]:
        rt = self._runtime(camera_id)
        if rt is None or rt.state == "stopped":
            raise CameraError("Camera is not running")
        fut: Future = Future()
        rt.pending.put((name, value, fut))
        try:
            fut.result(timeout=timeout)
            return {"applied": True}
        except TimeoutError:
            return {"applied": False, "queued": True}  # a long exposure is in progress; it will apply after

    # ---- capture thread -----------------------------------------------------------------
    def _emit(self, rt: CameraRuntime, extra: dict[str, Any] | None = None) -> None:
        events.emit_threadsafe("live", {"type": "status", **rt.status(), **(extra or {})})

    def _run(self, rt: CameraRuntime) -> None:
        backoff = 1.0
        was_running = False
        while not rt.stop_event.is_set():
            driver: CameraDriver | None = None
            try:
                rt.state = "connecting"
                self._emit(rt)
                cfg = rt.cfg
                driver = drivers.make_driver(cfg["kind"], dict(cfg.get("params", {})))
                if hasattr(driver, "set_output_dir"):
                    from app.services.live import capture

                    driver.set_output_dir(capture.live_dir(rt) / "photos")
                driver.open()
                rt.is_astro = driver.is_astro
                rt.info = driver.info()
                rt.controls = driver.controls()
                rt.state, rt.error = "running", None
                rt.fps, rt._t_last = 0.0, 0.0
                self._emit(rt)
                if was_running:
                    events.emit_threadsafe("live", {"type": "reconnected", "camera": rt.id, "name": cfg.get("name")})
                was_running = True
                backoff = 1.0
                last_emit = time.time()
                while not rt.stop_event.is_set():
                    self._apply_pending(rt, driver)
                    frame = driver.read()
                    if hasattr(driver, "take_new_files"):
                        self._photos(rt, driver.take_new_files())
                    rt.busy = driver.busy()
                    if driver.controls_changed():
                        rt.controls = driver.controls()
                        self._emit(rt)
                    if frame is not None:
                        rt._publish(frame)
                        if time.time() - last_emit > STATUS_EVERY_S:  # keeps fps / size current in the UI
                            last_emit = time.time()
                            self._emit(rt)
            except DriverUnavailable as exc:
                rt.state, rt.error = "unavailable", str(exc)
                self._emit(rt)
                return
            except Exception as exc:  # noqa: BLE001 - any driver failure means "lost"; keep the message
                if not isinstance(exc, CameraError):
                    logger.exception("Camera %s crashed", rt.cfg.get("name"))
                rt.error = str(exc) or exc.__class__.__name__
                rt.state = "lost" if was_running else "error"
                self._emit(rt)
                if was_running:
                    events.emit_threadsafe("live", {"type": "lost", "camera": rt.id, "name": rt.cfg.get("name"), "error": rt.error})
            finally:
                rt.busy = False
                if driver is not None:
                    try:
                        driver.close()
                    except Exception:  # noqa: BLE001
                        pass
            if rt.stop_event.is_set():
                break
            if not rt.cfg.get("auto_reconnect", True):
                return
            if rt.stop_event.wait(backoff):
                break
            backoff = min(backoff * 2, RECONNECT_MAX_S)

    def _photos(self, rt: CameraRuntime, files: list[Any]) -> None:
        """Full-quality photos the camera delivered (Canon): add them to the library and announce them."""
        if not files:
            return
        from app.db import SessionLocal
        from app.services.live import capture

        for path in files:
            image_id = None
            db = SessionLocal()
            try:
                from app.services.image_import import import_paths

                outcome = import_paths([str(path)], db)
                if outcome.imported:
                    image_id = outcome.imported[0].id
            except Exception:  # noqa: BLE001
                logger.exception("Could not add %s to the library", path)
            finally:
                db.close()
            events.emit_threadsafe("live", {"type": "photo", "camera": rt.id, "name": rt.cfg.get("name"), "file": str(path), "image_id": image_id})

    def _apply_pending(self, rt: CameraRuntime, driver: CameraDriver) -> None:
        changed = False
        while True:
            try:
                name, value, fut = rt.pending.get_nowait()
            except queue.Empty:
                break
            try:
                driver.set_control(name, value)
                fut.set_result(True)
                changed = True
            except Exception as exc:  # noqa: BLE001
                fut.set_exception(exc)
                changed = True  # the camera may still have changed something: show its real state, not the old one
        if changed:
            rt.controls = driver.controls()
            self._emit(rt)


manager = LiveManager()
