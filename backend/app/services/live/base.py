"""Driver interface shared by every camera family (webcam, IP camera, astro camera...)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np


class CameraError(Exception):
    """The camera stopped delivering (unplugged, network lost, SDK error). The manager
    reacts by marking the camera lost and reconnecting."""


class DriverUnavailable(CameraError):
    """The driver's SDK / OS component is not installed. Shown to the user as a hint
    rather than a failure."""


@dataclass
class Frame:
    """One image from a camera. `data` is HxW (mono / raw bayer) or HxWx3 (BGR, as OpenCV
    uses), uint8 or uint16. `bit_depth` is the sensor's true depth (data is left-aligned
    to nothing: a 12-bit camera stores 0..4095 in uint16 and says bit_depth=12)."""

    data: np.ndarray
    bit_depth: int = 8
    bayer: str | None = None  # 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG' for un-debayered colour sensors
    timestamp: float = field(default_factory=time.time)
    exposure_s: float | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def height(self) -> int:
        return int(self.data.shape[0])

    @property
    def width(self) -> int:
        return int(self.data.shape[1])

    @property
    def max_value(self) -> int:
        return (1 << self.bit_depth) - 1


def control(
    name: str,
    label: str,
    kind: str,
    value: Any,
    *,
    min: float | None = None,
    max: float | None = None,
    step: float | None = None,
    unit: str = "",
    choices: list[str] | None = None,
    log: bool = False,
    group: str = "camera",
) -> dict[str, Any]:
    """Describe one adjustable setting. kind: 'range' | 'toggle' | 'choice' | 'action'."""
    return {
        "name": name,
        "label": label,
        "kind": kind,
        "value": value,
        "min": min,
        "max": max,
        "step": step,
        "unit": unit,
        "choices": choices,
        "log": log,
        "group": group,
    }


class CameraDriver:
    """Subclass per camera family. All methods are called from the camera's own capture
    thread (except `set_control`/`controls`, which the manager serialises with a lock)."""

    kind = ""
    is_astro = False

    def __init__(self, params: dict[str, Any]):
        self.params = params

    def open(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def read(self) -> Frame | None:
        """Block until the next frame. Return None for 'nothing yet' (the loop just calls
        again); raise CameraError when the camera is gone."""
        raise NotImplementedError

    def controls(self) -> list[dict[str, Any]]:
        return []

    def set_control(self, name: str, value: Any) -> None:
        raise CameraError(f"Unknown control {name}")

    def info(self) -> dict[str, Any]:
        return {}
