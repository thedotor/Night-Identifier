import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import _default_data_dir, set_data_dir_pointer, settings
from app.db import engine
from app.services import log_capture
from app.services.watcher import watcher

router = APIRouter(prefix="/settings", tags=["settings"])
logger = log_capture.get_logger("settings")


class DataDirOut(BaseModel):
    path: str
    default_path: str


class DataDirIn(BaseModel):
    path: str


class DataDirMoveResult(BaseModel):
    path: str
    restart_required: bool


@router.get("/data-dir", response_model=DataDirOut)
def get_data_dir() -> DataDirOut:
    return DataDirOut(path=str(settings.data_dir), default_path=str(_default_data_dir()))


@router.put("/data-dir", response_model=DataDirMoveResult)
def set_data_dir(payload: DataDirIn) -> DataDirMoveResult:
    old_dir = settings.data_dir
    new_dir = Path(payload.path)

    if new_dir.resolve() == old_dir.resolve():
        raise HTTPException(status_code=400, detail="That's already the current location")

    try:
        new_dir.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Can't create that location: {exc}") from exc

    if new_dir.exists() and any(new_dir.iterdir()):
        raise HTTPException(status_code=400, detail="Target folder must be empty or not exist")

    logger.info("Moving data folder from %s to %s", old_dir, new_dir)
    watcher.stop()
    engine.dispose()

    try:
        if new_dir.exists():
            new_dir.rmdir()  # empty; shutil.move needs the destination to not exist
        if old_dir.exists():
            shutil.move(str(old_dir), str(new_dir))
        else:
            new_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # Best-effort: try to keep serving from the old location if the move failed partway.
        watcher.start(old_dir / "watch")
        raise HTTPException(status_code=500, detail=f"Move failed: {exc}") from exc

    set_data_dir_pointer(new_dir)
    logger.info("Data folder moved. Restart required to finish switching over.")

    return DataDirMoveResult(path=str(new_dir), restart_required=True)
