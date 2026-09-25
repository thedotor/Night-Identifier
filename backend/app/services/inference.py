import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image as PILImage

from app.config import settings
from app.models.image import Image
from app.services.blocked_areas import in_any_region
from app.services.ml_setup import configure_ultralytics
from app.services.model_kinds import KINDS, model_dir

CONFIDENCE_THRESHOLD = 0.25


class NoModelError(Exception):
    pass


@dataclass
class Detection:
    object_type_id: int
    confidence: float
    geometry: dict  # rect geometry in original-image pixel coordinates


def load_model(kind: str = "objects"):
    current_dir = model_dir(kind)
    weights_path = current_dir / "best.pt"
    classes_path = current_dir / "classes.json"
    if not weights_path.exists() or not classes_path.exists():
        raise NoModelError(f"No trained {kind} model is available. Train a model first.")

    configure_ultralytics()
    from ultralytics import YOLO

    from app.services.trainer import resolve_device

    model = YOLO(str(weights_path))
    class_map = {entry["class_index"]: entry["object_type_id"] for entry in json.loads(classes_path.read_text())}
    # Ultralytics' predict() does not reliably infer the device from a loaded
    # checkpoint on its own -- observed producing silently empty/garbage
    # results when device is left unspecified. Always resolve and pass it.
    device = resolve_device("auto")
    return model, class_map, device


def load_available_models() -> list[tuple[str, object, dict[int, int], str]]:
    """Every trained detector we have, as (kind, model, class_map, device). May be empty."""
    loaded = []
    for kind in KINDS:
        try:
            model, class_map, device = load_model(kind)
        except NoModelError:
            continue
        loaded.append((kind, model, class_map, device))
    return loaded


def predict_image(model, class_map: dict[int, int], image: Image, device: str) -> list[Detection]:
    preview_path = Path(image.preview_path)
    with PILImage.open(preview_path) as im:
        preview_w, preview_h = im.size
    scale_x = preview_w / image.width
    scale_y = preview_h / image.height

    results = model.predict(
        source=str(preview_path), conf=CONFIDENCE_THRESHOLD, device=device, verbose=False
    )
    if not results:
        return []

    detections: list[Detection] = []
    boxes = results[0].boxes
    if boxes is None:
        return []

    for box in boxes:
        cls_idx = int(box.cls.item())
        object_type_id = class_map.get(cls_idx)
        if object_type_id is None:
            continue
        confidence = float(box.conf.item())
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
        # Scale from preview-pixel space (what we ran inference on) back to
        # original-image pixel space (the coordinate system annotations use).
        x1, x2 = x1 / scale_x, x2 / scale_x
        y1, y2 = y1 / scale_y, y2 / scale_y
        # Drop anything centred in an area the user blocked (lights, trees, reflections).
        if in_any_region((x1 + x2) / 2, (y1 + y2) / 2, image.blocked_regions):
            continue
        detections.append(
            Detection(
                object_type_id=object_type_id,
                confidence=confidence,
                geometry={"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
            )
        )
    return detections
