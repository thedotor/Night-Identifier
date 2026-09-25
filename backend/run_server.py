"""Entry point for the packaged (PyInstaller) backend.

In development the backend is started with `uvicorn app.main:app --reload` instead; this file only
exists so the frozen build has something to run.
"""

import multiprocessing
import shutil
import sys
from pathlib import Path


def _seed_bundled_weights() -> None:
    """Copy the bundled YOLO base weights into the app's cache so the first training run doesn't
    need to download them."""
    from app.config import settings
    from app.services.trainer import BASE_MODEL_NAME

    bundled = Path(getattr(sys, "_MEIPASS", ".")) / BASE_MODEL_NAME
    dest = settings.data_dir / "ml_cache" / "weights" / BASE_MODEL_NAME
    if bundled.exists() and not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundled, dest)


def main() -> None:
    import uvicorn

    from app.config import settings
    from app.main import app

    _seed_bundled_weights()
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    # Must run before anything heavy is imported: training's DataLoader workers re-launch this exe.
    multiprocessing.freeze_support()
    main()
