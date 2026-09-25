from dataclasses import dataclass, field
from functools import lru_cache


@dataclass
class GpuDevice:
    index: int
    name: str


@dataclass
class GpuInfo:
    available: bool
    name: str | None
    device_count: int
    devices: list[GpuDevice] = field(default_factory=list)


@lru_cache(maxsize=1)
def detect_gpu() -> GpuInfo:
    """Detect NVIDIA GPU availability via torch, if installed.

    torch/CUDA are heavy dependencies pulled in for the Train page; if for
    some reason they're missing this degrades to CPU-only and the UI shows
    'CPU only' instead of failing.
    """
    try:
        import torch  # type: ignore
    except ImportError:
        return GpuInfo(available=False, name=None, device_count=0)

    if not torch.cuda.is_available():
        return GpuInfo(available=False, name=None, device_count=0)

    count = torch.cuda.device_count()
    devices = [GpuDevice(index=i, name=torch.cuda.get_device_name(i)) for i in range(count)]
    name = devices[0].name if devices else None
    return GpuInfo(available=True, name=name, device_count=count, devices=devices)
