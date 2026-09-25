"""USB / UVC webcams and anything else the OS exposes as a video device (via OpenCV)."""

from __future__ import annotations

import sys
import time
from typing import Any

import cv2

from app.services.live.base import CameraDriver, CameraError, Frame, control

_BACKEND = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY

RESOLUTIONS = ["640x480", "1280x720", "1920x1080"]

# (control name, label, OpenCV property, min, max, step)
_PROPS = [
    ("brightness", "Brightness", cv2.CAP_PROP_BRIGHTNESS, 0, 255, 1),
    ("contrast", "Contrast", cv2.CAP_PROP_CONTRAST, 0, 255, 1),
    ("saturation", "Saturation", cv2.CAP_PROP_SATURATION, 0, 255, 1),
    ("gain", "Gain", cv2.CAP_PROP_GAIN, 0, 255, 1),
]


class UvcCamera(CameraDriver):
    kind = "uvc"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.cap: cv2.VideoCapture | None = None
        self._fails = 0
        self._auto_exposure = True

    def open(self) -> None:
        index = int(self.params.get("index", 0))
        cap = cv2.VideoCapture(index, _BACKEND)
        if not cap.isOpened():
            cap.release()
            raise CameraError(f"Could not open camera {index}. Is it in use by another app, or blocked in Windows privacy settings?")
        # MJPG gives much higher frame rates than the default uncompressed formats
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        res = str(self.params.get("resolution", "1280x720"))
        try:
            w, h = (int(v) for v in res.split("x"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
        except ValueError:
            pass
        self.cap = cap
        self._fails = 0

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None

    def read(self) -> Frame | None:
        if self.cap is None:
            raise CameraError("Camera is closed")
        ok, img = self.cap.read()
        if not ok or img is None:
            self._fails += 1
            if self._fails > 20:
                raise CameraError("The camera stopped sending frames (unplugged or taken by another app)")
            time.sleep(0.05)
            return None
        self._fails = 0
        return Frame(data=img, bit_depth=8)

    def controls(self) -> list[dict[str, Any]]:
        if self.cap is None:
            return []
        out = [
            control(
                "resolution",
                "Resolution",
                "choice",
                f"{int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}",
                choices=RESOLUTIONS,
            )
        ]
        for name, label, prop, lo, hi, step in _PROPS:
            value = self.cap.get(prop)
            if value is None or value < 0:
                continue  # the driver does not expose this setting
            out.append(control(name, label, "range", float(value), min=lo, max=hi, step=step))
        exp = self.cap.get(cv2.CAP_PROP_EXPOSURE)
        if exp is not None and exp != 0.0:
            out.append(control("auto_exposure", "Auto exposure", "toggle", self._auto_exposure))
            out.append(control("exposure", "Exposure", "range", float(exp), min=-13, max=0, step=1, unit="EV (2^n s)"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        if self.cap is None:
            raise CameraError("Camera is closed")
        if name == "resolution":
            w, h = (int(v) for v in str(value).split("x"))
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
            self.params["resolution"] = str(value)
            return
        if name == "auto_exposure":
            self._auto_exposure = bool(value)
            # DirectShow: 0.75 = auto, 0.25 = manual
            self.cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75 if self._auto_exposure else 0.25)
            return
        if name == "exposure":
            self.cap.set(cv2.CAP_PROP_EXPOSURE, float(value))
            return
        for pname, _label, prop, *_ in _PROPS:
            if pname == name:
                self.cap.set(prop, float(value))
                return
        super().set_control(name, value)

    def info(self) -> dict[str, Any]:
        if self.cap is None:
            return {}
        return {
            "model": self.params.get("name", "USB camera"),
            "sensor": f"{int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}",
            "bit_depth": 8,
        }


def discover(busy_indices: set[int]) -> list[dict[str, Any]]:
    """Find video devices. Indices already in use by a running camera are reported without
    being opened (a second open would fail or steal the device)."""
    names: list[str] = []
    try:  # optional: gives real device names on Windows
        from pygrabber.dshow_graph import FilterGraph  # type: ignore

        names = list(FilterGraph().get_input_devices())
    except Exception:  # noqa: BLE001
        names = []

    found = []
    limit = max(len(names), 6)
    for i in range(limit):
        if i in busy_indices:
            continue
        if not names:  # no name list: probe by opening
            cap = cv2.VideoCapture(i, _BACKEND)
            ok = cap.isOpened()
            cap.release()
            if not ok:
                continue
        name = names[i] if i < len(names) else f"USB camera {i}"
        found.append({"kind": "uvc", "name": name, "params": {"index": i, "name": name, "resolution": "1280x720"}})
    return found
