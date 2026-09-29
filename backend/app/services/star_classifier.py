"""GPU-trainable classifier distinguishing real stars from bright non-star
clutter (streetlights, illuminated foliage, moon halo fragments) that the
brightness-threshold detector in star_detection.py can't otherwise tell
apart -- confirmed repeatedly on real photos, where a saturated hedge patch
and a genuine star both read as flat, maximally-bright blobs.

Trains a small CNN on user-labeled example patches ("this candidate really
is a star" / "this is clutter"), following the same background-thread +
WebSocket-progress + DB-run-record pattern as app/services/trainer.py (the
object-detection trainer), just for a much smaller, simpler binary
classification model -- no need for anything YOLO-sized here.
"""

import datetime as dt
import threading
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models.image import Image
from app.models.star_classifier_run import StarClassifierRun, StarClassifierStatus
from app.models.star_label import StarLabel, StarLabelType
from app.services import events, log_capture
from app.services.gpu import detect_gpu
from app.services.image_processing import is_fits, is_raw, load_full_resolution

logger = log_capture.get_logger("star_classifier")

PATCH_SIZE = 24
MIN_LABELS_PER_CLASS = 15


def _model_path() -> Path:
    return settings.models_dir / "star_classifier" / "model.pt"


def has_trained_classifier() -> bool:
    return _model_path().exists()


def delete_trained_classifier() -> None:
    path = _model_path()
    if path.exists():
        path.unlink()


def resolve_device(device: str):  # noqa: ANN201
    import torch

    if device == "cpu":
        return torch.device("cpu")
    if device.startswith("cuda:"):
        return torch.device(device)
    gpu = detect_gpu()
    return torch.device("cuda:0") if gpu.available else torch.device("cpu")


def _load_full_luma(image: Image) -> np.ndarray | None:
    """Full-resolution single-channel array in the same [0, 1]-normalized
    space regardless of source, aligned with image.width/height (the
    coordinate space every label's x, y is stored in)."""
    path = Path(image.stored_path)
    if is_fits(path):
        try:
            return np.asarray(load_full_resolution(path).convert("L"), dtype=np.float32) / 255.0
        except Exception:  # noqa: BLE001
            return None
    if is_raw(path):
        try:
            import rawpy

            with rawpy.imread(str(path)) as raw:
                rgb16 = raw.postprocess(use_camera_wb=True, no_auto_bright=True, output_bps=16)
            return rgb16.max(axis=2).astype(np.float32) / 65535.0
        except Exception:  # noqa: BLE001
            return None

    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    return img.astype(np.float32) / 255.0


def crop_patch(luma: np.ndarray, x: float, y: float, size: int = PATCH_SIZE) -> np.ndarray | None:
    h, w = luma.shape[:2]
    half = size // 2
    x0, y0 = int(round(x)) - half, int(round(y)) - half
    x1, y1 = x0 + size, y0 + size
    if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
        return None
    return luma[y0:y1, x0:x1]


def _build_dataset(db: Session) -> tuple[np.ndarray, np.ndarray]:
    labels = list(db.scalars(select(StarLabel)))
    by_image: dict[int, list[StarLabel]] = defaultdict(list)
    for lbl in labels:
        by_image[lbl.image_id].append(lbl)

    patches: list[np.ndarray] = []
    targets: list[float] = []
    for image_id, lbls in by_image.items():
        image = db.get(Image, image_id)
        if image is None:
            continue
        luma = _load_full_luma(image)
        if luma is None:
            continue
        for lbl in lbls:
            patch = crop_patch(luma, lbl.x, lbl.y)
            if patch is None:
                continue
            patches.append(patch)
            targets.append(1.0 if lbl.label == StarLabelType.STAR else 0.0)

    return np.array(patches, dtype=np.float32), np.array(targets, dtype=np.float32)


def _build_model():  # noqa: ANN201
    import torch.nn as nn

    reduced = PATCH_SIZE // 4

    class StarNet(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.conv1 = nn.Conv2d(1, 8, 3, padding=1)
            self.conv2 = nn.Conv2d(8, 16, 3, padding=1)
            self.pool = nn.MaxPool2d(2)
            self.fc1 = nn.Linear(16 * reduced * reduced, 32)
            self.fc2 = nn.Linear(32, 1)

        def forward(self, x):  # noqa: ANN001, ANN201
            x = self.pool(nn.functional.relu(self.conv1(x)))
            x = self.pool(nn.functional.relu(self.conv2(x)))
            x = x.flatten(1)
            x = nn.functional.relu(self.fc1(x))
            return self.fc2(x)  # raw logit

    return StarNet()


class StarClassifierManager:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_flag = threading.Event()
        self._current_run_id: int | None = None
        self._lock = threading.Lock()

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def current_run_id(self) -> int | None:
        return self._current_run_id if self.is_running else None

    def start(self, run_id: int, epochs: int, device: str) -> None:
        with self._lock:
            if self.is_running:
                raise RuntimeError("A star-classifier training run is already in progress")
            self._stop_flag.clear()
            self._current_run_id = run_id
            self._thread = threading.Thread(target=self._run, args=(run_id, epochs, device), daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop_flag.set()

    def _run(self, run_id: int, epochs: int, device: str) -> None:
        import torch
        from torch.utils.data import DataLoader, TensorDataset

        db = SessionLocal()
        try:
            run = db.get(StarClassifierRun, run_id)
            if run is None:
                return

            patches, targets = _build_dataset(db)
            n_star = int(targets.sum())
            n_not = len(targets) - n_star
            if n_star < MIN_LABELS_PER_CLASS or n_not < MIN_LABELS_PER_CLASS:
                msg = (
                    f"Need at least {MIN_LABELS_PER_CLASS} labeled examples of each class "
                    f"(have {n_star} star, {n_not} not-star)."
                )
                logger.warning("Star classifier run #%s failed to start: %s", run_id, msg)
                run.status = StarClassifierStatus.FAILED
                run.error_message = msg
                db.commit()
                events.emit_threadsafe(
                    "star_classifier", {"type": "status", "run_id": run_id, "status": "failed", "error": msg}
                )
                return

            torch_device = resolve_device(device)
            run.status = StarClassifierStatus.RUNNING
            run.started_at = dt.datetime.utcnow()
            run.label_count = len(targets)
            db.commit()
            events.emit_threadsafe(
                "star_classifier",
                {
                    "type": "status",
                    "run_id": run_id,
                    "status": "running",
                    "label_count": len(targets),
                    "device": str(torch_device),
                },
            )

            rng = np.random.default_rng(0)
            order = rng.permutation(len(targets))
            split = max(1, int(len(order) * 0.8))
            train_idx, val_idx = order[:split], order[split:]
            if len(val_idx) == 0:
                val_idx = train_idx

            x_all = torch.from_numpy(patches).unsqueeze(1)  # (N, 1, H, W)
            y_all = torch.from_numpy(targets).unsqueeze(1)  # (N, 1)

            train_ds = TensorDataset(x_all[train_idx], y_all[train_idx])
            val_ds = TensorDataset(x_all[val_idx], y_all[val_idx])
            train_loader = DataLoader(train_ds, batch_size=32, shuffle=True)
            val_loader = DataLoader(val_ds, batch_size=64)

            model = _build_model().to(torch_device)
            optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
            loss_fn = torch.nn.BCEWithLogitsLoss()

            best_val_acc = -1.0
            best_state = None

            for epoch in range(1, epochs + 1):
                if self._stop_flag.is_set():
                    break
                model.train()
                train_loss = 0.0
                for xb, yb in train_loader:
                    xb, yb = xb.to(torch_device), yb.to(torch_device)
                    optimizer.zero_grad()
                    out = model(xb)
                    loss = loss_fn(out, yb)
                    loss.backward()
                    optimizer.step()
                    train_loss += float(loss) * len(xb)
                train_loss /= len(train_ds)

                model.eval()
                correct = 0
                with torch.no_grad():
                    for xb, yb in val_loader:
                        xb, yb = xb.to(torch_device), yb.to(torch_device)
                        pred = (torch.sigmoid(model(xb)) > 0.5).float()
                        correct += int((pred == yb).sum())
                val_acc = correct / len(val_ds)
                if val_acc >= best_val_acc:
                    best_val_acc = val_acc
                    best_state = {k: v.clone().cpu() for k, v in model.state_dict().items()}

                metrics = {"train_loss": round(train_loss, 4), "val_accuracy": round(val_acc, 4)}
                run = db.get(StarClassifierRun, run_id)
                run.current_epoch = epoch
                run.metrics = metrics
                db.commit()
                events.emit_threadsafe(
                    "star_classifier",
                    {"type": "epoch", "run_id": run_id, "epoch": epoch, "total_epochs": epochs, "metrics": metrics},
                )

            run = db.get(StarClassifierRun, run_id)
            if self._stop_flag.is_set():
                run.status = StarClassifierStatus.STOPPED
                run.finished_at = dt.datetime.utcnow()
                db.commit()
                events.emit_threadsafe("star_classifier", {"type": "status", "run_id": run_id, "status": "stopped"})
                return

            model_path = _model_path()
            model_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save(best_state, model_path)

            run.status = StarClassifierStatus.COMPLETED
            run.model_path = str(model_path)
            run.finished_at = dt.datetime.utcnow()
            db.commit()
            logger.info("Star classifier run #%s completed, val_accuracy=%.3f", run_id, best_val_acc)
            events.emit_threadsafe(
                "star_classifier",
                {"type": "status", "run_id": run_id, "status": "completed", "model_path": str(model_path)},
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Star classifier run #%s failed: %s", run_id, exc)
            run = db.get(StarClassifierRun, run_id)
            if run:
                run.status = StarClassifierStatus.FAILED
                run.error_message = str(exc)[:2000]
                run.finished_at = dt.datetime.utcnow()
                db.commit()
            events.emit_threadsafe(
                "star_classifier", {"type": "status", "run_id": run_id, "status": "failed", "error": str(exc)[:500]}
            )
        finally:
            db.close()
            with self._lock:
                self._current_run_id = None


classifier_manager = StarClassifierManager()

_inference_model = None
_inference_model_mtime: float | None = None


def get_inference_model():  # noqa: ANN201
    """Lazily load (and hot-reload on retrain) the trained classifier for
    use during detection. Returns None if no model has been trained yet."""
    global _inference_model, _inference_model_mtime
    path = _model_path()
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    if _inference_model is not None and _inference_model_mtime == mtime:
        return _inference_model

    import torch

    model = _build_model()
    model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    model.eval()
    _inference_model = model
    _inference_model_mtime = mtime
    return model


def predict_star_probabilities(model, patches: np.ndarray) -> np.ndarray:  # noqa: ANN001
    """patches: (N, PATCH_SIZE, PATCH_SIZE) float32 in [0, 1]. Returns (N,)
    probabilities that each patch is a real star."""
    import torch

    if len(patches) == 0:
        return np.zeros(0, dtype=np.float32)
    with torch.no_grad():
        x = torch.from_numpy(patches).unsqueeze(1)
        probs = torch.sigmoid(model(x)).squeeze(1).numpy()
    return probs
