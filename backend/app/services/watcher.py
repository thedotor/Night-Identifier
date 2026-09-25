import shutil
import threading
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from app.db import SessionLocal
from app.services import events, log_capture
from app.services.auto_process import process_image
from app.services.image_import import SUPPORTED_EXTENSIONS, image_to_dict, import_paths
from app.services.inference import load_available_models

logger = log_capture.get_logger("watcher")

DEBOUNCE_SECONDS = 1.5
IMPORTED_SUBDIR = "_imported"


class _DebouncedHandler(FileSystemEventHandler):
    """Camera/export software often writes a file progressively. We wait until
    a file's size has stopped changing for DEBOUNCE_SECONDS before importing,
    re-checking as many times as needed while it's still growing.
    """

    def __init__(self) -> None:
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def _is_supported(self, path: str) -> bool:
        return Path(path).suffix.lower() in SUPPORTED_EXTENSIONS

    def _schedule(self, path: str) -> None:
        with self._lock:
            existing = self._timers.get(path)
            if existing:
                existing.cancel()
            timer = threading.Timer(DEBOUNCE_SECONDS, self._check_stable, args=(path,))
            self._timers[path] = timer
            timer.daemon = True
            timer.start()

    def _check_stable(self, path: str) -> None:
        p = Path(path)
        with self._lock:
            self._timers.pop(path, None)
        if not p.exists():
            return
        size_before = p.stat().st_size
        # Re-check after another debounce window to confirm the write finished.
        still_growing_timer = threading.Timer(DEBOUNCE_SECONDS, self._confirm_stable, args=(path, size_before))
        still_growing_timer.daemon = True
        with self._lock:
            self._timers[path] = still_growing_timer
        still_growing_timer.start()

    def _confirm_stable(self, path: str, size_before: int) -> None:
        with self._lock:
            self._timers.pop(path, None)
        p = Path(path)
        if not p.exists():
            return
        if p.stat().st_size != size_before:
            self._schedule(path)  # still being written; wait again
            return
        self._import_one(path)

    def _import_one(self, path: str) -> None:
        db = SessionLocal()
        try:
            outcome = import_paths([path], db)
            if outcome.imported:
                image = outcome.imported[0]
                logger.info("Watch folder: imported %s", image.filename)
                events.emit_threadsafe("images", {"type": "imported", "image": image_to_dict(image)})
                _move_to_imported(Path(path))
                self._auto_detect_and_sort(image, db)
            else:
                logger.warning("Watch folder: could not import %s", Path(path).name)
                events.emit_threadsafe(
                    "images",
                    {"type": "skipped", "filename": Path(path).name, "reason": "unreadable or unsupported"},
                )
        finally:
            db.close()

    def _auto_detect_and_sort(self, image, db) -> None:  # noqa: ANN001
        """If a trained model is available, run it on the freshly-imported
        image immediately and sort a copy into per-object-type folders.
        Best-effort: any failure here must not affect the import itself.
        """
        try:
            models = load_available_models()
            if not models:
                return
            detections = []
            for kind, model, class_map, device in models:
                detections += process_image(image, db, model, class_map, device, kind=kind)
            logger.info("Auto-sorted %s (%d detection(s))", image.filename, len(detections))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Auto-detect failed for %s: %s", image.filename, exc)

    def on_created(self, event) -> None:  # noqa: ANN001
        if event.is_directory or not self._is_supported(event.src_path):
            return
        if IMPORTED_SUBDIR in Path(event.src_path).parts:
            return
        events.emit_threadsafe("images", {"type": "scanning", "filename": Path(event.src_path).name})
        self._schedule(event.src_path)

    def on_modified(self, event) -> None:  # noqa: ANN001
        if event.is_directory or not self._is_supported(event.src_path):
            return
        if IMPORTED_SUBDIR in Path(event.src_path).parts:
            return
        self._schedule(event.src_path)


def _move_to_imported(path: Path) -> None:
    dest_dir = path.parent / IMPORTED_SUBDIR
    dest_dir.mkdir(exist_ok=True)
    try:
        shutil.move(str(path), str(dest_dir / path.name))
    except OSError:
        pass  # leave the original in place if it can't be moved (e.g. permissions)


class FolderWatcher:
    def __init__(self) -> None:
        self._observer: Observer | None = None
        self._watch_dir: Path | None = None

    @property
    def watch_dir(self) -> Path | None:
        return self._watch_dir

    @property
    def is_running(self) -> bool:
        return self._observer is not None and self._observer.is_alive()

    def start(self, watch_dir: Path) -> None:
        self.stop()
        watch_dir.mkdir(parents=True, exist_ok=True)
        observer = Observer()
        observer.schedule(_DebouncedHandler(), str(watch_dir), recursive=False)
        observer.start()
        self._observer = observer
        self._watch_dir = watch_dir
        logger.info("Now watching %s", watch_dir)
        events.emit_threadsafe(
            "images", {"type": "watch_status", "watching": True, "watch_dir": str(watch_dir)}
        )

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5)
            self._observer = None
            events.emit_threadsafe("images", {"type": "watch_status", "watching": False, "watch_dir": None})


watcher = FolderWatcher()
