import random
import shutil
from dataclasses import dataclass
from pathlib import Path

import yaml
from PIL import Image as PILImage
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models.annotation import Annotation
from app.models.image import Image, ImageCategory
from app.models.object_type import ObjectType
from app.services.model_kinds import label_conditions, object_type_kind


class DatasetTooSmallError(Exception):
    pass


@dataclass
class ExportedDataset:
    yaml_path: Path
    image_count: int
    class_count: int
    class_names: list[str]
    class_object_type_ids: list[int]


def _bbox_from_geometry(shape_type: str, geometry: dict) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box (x_min, y_min, x_max, y_max) in source-image
    pixel coordinates, for any shape type. YOLO detection trains on boxes, so
    ellipses and polygons are reduced to their bounding box.
    """
    if shape_type == "rect":
        x, y, w, h = geometry["x"], geometry["y"], geometry["width"], geometry["height"]
        return x, y, x + w, y + h
    if shape_type == "ellipse":
        cx, cy, rx, ry = geometry["cx"], geometry["cy"], geometry["rx"], geometry["ry"]
        return cx - rx, cy - ry, cx + rx, cy + ry
    if shape_type == "polygon":
        points = geometry["points"]
        xs = points[0::2]
        ys = points[1::2]
        return min(xs), min(ys), max(xs), max(ys)
    raise ValueError(f"Unknown shape_type: {shape_type}")


def export_dataset(run_id: int, db: Session, kind: str = "objects") -> ExportedDataset:
    """Write a YOLO dataset for one model kind: only that kind's classes and only its labels."""
    object_types = list(
        db.scalars(
            select(ObjectType).where(ObjectType.kind == object_type_kind(kind)).order_by(ObjectType.id)
        )
    )
    if not object_types:
        raise DatasetTooSmallError("Add at least one object type before training.")
    class_index = {ot.id: i for i, ot in enumerate(object_types)}

    images_with_annotations = list(
        db.scalars(
            select(Image)
            .join(Annotation, Annotation.image_id == Image.id)
            .where(*label_conditions(kind), Image.category == ImageCategory.TRAINING)
            .distinct()
        )
    )
    if len(images_with_annotations) < 2:
        raise DatasetTooSmallError("Label at least 2 images before training.")

    dataset_dir = settings.data_dir / "datasets" / f"run_{run_id}"
    if dataset_dir.exists():
        shutil.rmtree(dataset_dir)
    for split in ("train", "val"):
        (dataset_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (dataset_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    shuffled = images_with_annotations[:]
    random.Random(42).shuffle(shuffled)
    val_count = max(1, round(len(shuffled) * 0.15))
    val_ids = {img.id for img in shuffled[:val_count]}

    for image in images_with_annotations:
        split = "val" if image.id in val_ids else "train"
        preview_path = Path(image.preview_path)
        with PILImage.open(preview_path) as im:
            preview_w, preview_h = im.size
        scale_x = preview_w / image.width
        scale_y = preview_h / image.height

        dest_image = dataset_dir / "images" / split / f"{image.id}.jpg"
        shutil.copy2(preview_path, dest_image)

        annotations = list(
            db.scalars(
                select(Annotation).where(Annotation.image_id == image.id, *label_conditions(kind))
            )
        )
        lines = []
        for ann in annotations:
            if ann.object_type_id not in class_index:
                continue
            x_min, y_min, x_max, y_max = _bbox_from_geometry(ann.shape_type.value, ann.geometry)
            x_min, x_max = x_min * scale_x, x_max * scale_x
            y_min, y_max = y_min * scale_y, y_max * scale_y
            x_min, x_max = max(0.0, x_min), min(preview_w, x_max)
            y_min, y_max = max(0.0, y_min), min(preview_h, y_max)

            box_w = x_max - x_min
            box_h = y_max - y_min
            if box_w <= 1 or box_h <= 1:
                continue

            cx = (x_min + box_w / 2) / preview_w
            cy = (y_min + box_h / 2) / preview_h
            nw = box_w / preview_w
            nh = box_h / preview_h
            cls = class_index[ann.object_type_id]
            lines.append(f"{cls} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        label_path = dataset_dir / "labels" / split / f"{image.id}.txt"
        label_path.write_text("\n".join(lines))

    yaml_path = dataset_dir / "dataset.yaml"
    yaml_path.write_text(
        yaml.safe_dump(
            {
                "path": str(dataset_dir),
                "train": "images/train",
                "val": "images/val",
                "names": {i: ot.name for i, ot in enumerate(object_types)},
            }
        )
    )

    return ExportedDataset(
        yaml_path=yaml_path,
        image_count=len(images_with_annotations),
        class_count=len(object_types),
        class_names=[ot.name for ot in object_types],
        class_object_type_ids=[ot.id for ot in object_types],
    )
