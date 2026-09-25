import contextlib
import datetime as dt
import json
import os
import shutil
import threading
from pathlib import Path

from app.config import settings
from app.db import SessionLocal
from app.models.training_run import TrainingRun, TrainingStatus
from app.services import events, log_capture
from app.services.dataset_export import DatasetTooSmallError, export_dataset
from app.services.gpu import detect_gpu
from app.services.model_kinds import KINDS, model_dir
from app.services.ml_setup import configure_ultralytics

logger = log_capture.get_logger("trainer")

BASE_MODEL_NAME = "yolov8n.pt"


@contextlib.contextmanager
def _cwd_in_ml_cache():
    """Ultralytics' one-time AMP-capability check downloads a small reference
    model to a path resolved relative to the process's current working
    directory, ignoring the weights_dir setting configure_ultralytics() sets.
    Scope cwd to our managed cache dir for the duration of training so that
    stray download lands there instead of the app's source tree.
    """
    ml_dir = settings.data_dir / "ml_cache"
    ml_dir.mkdir(parents=True, exist_ok=True)
    original = os.getcwd()
    os.chdir(ml_dir)
    try:
        yield
    finally:
        os.chdir(original)


def resolve_device(device: str) -> str:
    """Map our device selector ('auto' | 'cpu' | 'cuda:N') to what Ultralytics expects."""
    if device == "cpu":
        return "cpu"
    if device.startswith("cuda:"):
        return device.split(":", 1)[1]
    # 'auto'
    gpu = detect_gpu()
    return "0" if gpu.available else "cpu"


def _safe_metrics(raw: dict | None) -> dict:
    if not raw:
        return {}
    out = {}
    for k, v in raw.items():
        try:
            out[k] = float(v)
        except (TypeError, ValueError):
            continue
    return out


class TrainingManager:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_flag = threading.Event()
        self._current_run_id: int | None = None
        self._current_kind: str | None = None
        self._lock = threading.Lock()

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def current_run_id(self) -> int | None:
        return self._current_run_id if self.is_running else None

    @property
    def current_kind(self) -> str | None:
        return self._current_kind if self.is_running else None

    def start(self, run_id: int, epochs: int, batch_size: int, workers: int, device: str, kind: str = "objects") -> None:
        with self._lock:
            if self.is_running:
                raise RuntimeError("A training run is already in progress")
            self._stop_flag.clear()
            self._current_run_id = run_id
            self._current_kind = kind
            self._thread = threading.Thread(
                target=self._run,
                args=(run_id, epochs, batch_size, workers, device),
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_flag.set()

    def _run(self, run_id: int, epochs: int, batch_size: int, workers: int, device: str) -> None:
        configure_ultralytics()
        from ultralytics import YOLO

        logger.info("Training run #%s starting (epochs=%s, batch=%s, device=%s)", run_id, epochs, batch_size, device)
        db = SessionLocal()
        try:
            run = db.get(TrainingRun, run_id)
            if run is None:
                return
            kind = run.kind or "objects"

            try:
                dataset = export_dataset(run_id, db, kind)
            except DatasetTooSmallError as exc:
                logger.warning("Training run #%s failed to start: %s", run_id, exc)
                run.status = TrainingStatus.FAILED
                run.error_message = str(exc)
                db.commit()
                events.emit_threadsafe(
                    "training",
                    {"type": "status", "run_id": run_id, "kind": kind, "status": "failed", "error": str(exc)},
                )
                return

            run.status = TrainingStatus.RUNNING
            run.started_at = dt.datetime.utcnow()
            run.image_count = dataset.image_count
            run.class_count = dataset.class_count
            db.commit()
            events.emit_threadsafe(
                "training",
                {
                    "type": "status",
                    "run_id": run_id, "kind": kind,
                    "status": "running",
                    "image_count": dataset.image_count,
                    "class_count": dataset.class_count,
                },
            )

            resolved_device = resolve_device(device)
            base_model_path = settings.data_dir / "ml_cache" / "weights" / BASE_MODEL_NAME
            base_model_path.parent.mkdir(parents=True, exist_ok=True)
            model = YOLO(str(base_model_path))

            stop_flag = self._stop_flag

            def on_fit_epoch_end(trainer) -> None:  # noqa: ANN001
                epoch = getattr(trainer, "epoch", 0) + 1
                metrics = _safe_metrics(getattr(trainer, "metrics", None))
                epoch_db = SessionLocal()
                try:
                    r = epoch_db.get(TrainingRun, run_id)
                    if r:
                        r.current_epoch = epoch
                        r.metrics = metrics
                        epoch_db.commit()
                finally:
                    epoch_db.close()
                events.emit_threadsafe(
                    "training",
                    {
                        "type": "epoch",
                        "run_id": run_id, "kind": kind,
                        "epoch": epoch,
                        "total_epochs": epochs,
                        "metrics": metrics,
                    },
                )
                if stop_flag.is_set():
                    trainer.stop = True

            model.add_callback("on_fit_epoch_end", on_fit_epoch_end)

            run_name = f"run_{run_id}"
            try:
                with _cwd_in_ml_cache():
                    model.train(
                        data=str(dataset.yaml_path),
                        epochs=epochs,
                        batch=batch_size,
                        workers=workers,
                        device=resolved_device,
                        project=str(settings.data_dir / "ml_cache" / "runs"),
                        name=run_name,
                        exist_ok=True,
                        verbose=False,
                        plots=False,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.error("Training run #%s failed: %s", run_id, exc)
                run = db.get(TrainingRun, run_id)
                run.status = TrainingStatus.FAILED
                run.error_message = str(exc)[:2000]
                run.finished_at = dt.datetime.utcnow()
                db.commit()
                events.emit_threadsafe(
                    "training",
                    {"type": "status", "run_id": run_id, "kind": kind, "status": "failed", "error": str(exc)[:500]},
                )
                return

            run = db.get(TrainingRun, run_id)
            weights_dir = settings.data_dir / "ml_cache" / "runs" / run_name / "weights"
            best = weights_dir / "best.pt"

            if stop_flag.is_set() and run.current_epoch < epochs:
                logger.info("Training run #%s stopped by user at epoch %s", run_id, run.current_epoch)
                run.status = TrainingStatus.STOPPED
                run.finished_at = dt.datetime.utcnow()
                db.commit()
                events.emit_threadsafe("training", {"type": "status", "run_id": run_id, "kind": kind, "status": "stopped"})
                return

            if best.exists():
                current_dir = model_dir(kind)
                current_dir.mkdir(parents=True, exist_ok=True)
                dest = current_dir / "best.pt"
                shutil.copy2(best, dest)
                class_map = [
                    {"class_index": i, "object_type_id": oid, "name": name}
                    for i, (oid, name) in enumerate(
                        zip(dataset.class_object_type_ids, dataset.class_names)
                    )
                ]
                (current_dir / "classes.json").write_text(json.dumps(class_map, indent=2))
                run.model_path = str(dest)

            run.status = TrainingStatus.COMPLETED
            run.finished_at = dt.datetime.utcnow()
            db.commit()
            logger.info("Training run #%s completed", run_id)
            events.emit_threadsafe(
                "training",
                {
                    "type": "status",
                    "run_id": run_id, "kind": kind,
                    "status": "completed",
                    "model_path": run.model_path,
                },
            )
        finally:
            db.close()
            with self._lock:
                self._current_run_id = None


def delete_current_model(kind: str = "objects") -> None:
    current_dir = model_dir(kind)
    if current_dir.exists():
        shutil.rmtree(current_dir)


def has_current_model(kind: str = "objects") -> bool:
    return (model_dir(kind) / "best.pt").exists()


def available_model_kinds() -> list[str]:
    return [k for k in KINDS if has_current_model(k)]


trainer = TrainingManager()
