import threading

from sqlalchemy import select

from app.db import SessionLocal
from app.models.image import Image, ImageCategory
from app.services import events, log_capture
from app.services.auto_process import process_image
from app.services.inference import load_available_models

logger = log_capture.get_logger("results")


class ResultsRunner:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_flag = threading.Event()

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, image_ids: list[int] | None = None) -> None:
        if self.is_running:
            raise RuntimeError("Detection is already running")
        self._stop_flag.clear()
        self._thread = threading.Thread(target=self._run, args=(image_ids,), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_flag.set()

    def _run(self, image_ids: list[int] | None) -> None:
        db = SessionLocal()
        try:
            models = load_available_models()
            if not models:
                msg = "No trained model is available. Train a model first."
                logger.warning("Detection run could not start: %s", msg)
                events.emit_threadsafe("results", {"type": "error", "error": msg})
                return

            if image_ids is None:
                # Default to the general library, not the training pool --
                # running detection on your own labeled ground truth isn't
                # useful and would blur the two pools together.
                targets = list(db.scalars(select(Image).where(Image.category == ImageCategory.LIBRARY)))
            else:
                targets = list(db.scalars(select(Image).where(Image.id.in_(image_ids))))

            total = len(targets)
            logger.info("Detection run starting over %s image(s)", total)
            events.emit_threadsafe("results", {"type": "start", "total": total})

            for i, image in enumerate(targets):
                if self._stop_flag.is_set():
                    events.emit_threadsafe(
                        "results", {"type": "stopped", "processed": i, "total": total}
                    )
                    return

                try:
                    detections = []
                    for kind, model, class_map, device in models:
                        detections += process_image(image, db, model, class_map, device, kind=kind)
                except Exception as exc:  # noqa: BLE001
                    events.emit_threadsafe(
                        "results",
                        {"type": "image_error", "filename": image.filename, "error": str(exc)[:300]},
                    )
                    continue

                events.emit_threadsafe(
                    "results",
                    {
                        "type": "progress",
                        "processed": i + 1,
                        "total": total,
                        "filename": image.filename,
                        "detection_count": len(detections),
                    },
                )

            logger.info("Detection run completed over %s image(s)", total)
            events.emit_threadsafe("results", {"type": "completed", "processed": total, "total": total})
        finally:
            db.close()


results_runner = ResultsRunner()
