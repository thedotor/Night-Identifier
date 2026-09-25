from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__
from app.services.gpu import detect_gpu

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    status: str = "ok"
    gpu_available: bool
    gpu_name: str | None
    version: str


@router.get("/health", response_model=HealthStatus)
def health() -> HealthStatus:
    gpu = detect_gpu()
    return HealthStatus(gpu_available=gpu.available, gpu_name=gpu.name, version=__version__)
