"""Shared logic for ASCOM cameras. ASCOM defines one camera model (StartExposure / ImageReady /
ImageArray plus gain, binning, cooling) that is reachable two ways: locally as a Windows COM driver
(`ascom.py`) or over the network as REST ("Alpaca", `alpaca.py`). Subclasses only supply the
transport: `_get`, `_put`, `_start`, `_ready`, `_fetch`, `_abort`."""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np

from app.services.live.base import CameraDriver, CameraError, Frame, control

# SensorType 1 = colour with the offsets below; 2 = RGGB
_BAYER = {(0, 0): "RGGB", (1, 0): "GRBG", (0, 1): "GBRG", (1, 1): "BGGR"}


class AscomCamera(CameraDriver):
    is_astro = True

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.w = self.h = 0
        self.max_adu = 65535
        self.bit_depth = 16
        self.exp_min, self.exp_max = 0.001, 3600.0
        self.exposure = float(params.get("exposure_s", 0.5))
        self.gain: float | None = None
        self.gain_range: tuple[float, float] | None = None
        self.max_bin = 1
        self.binning = 1
        self.can_cool = False
        self.cooler = False
        self.target = 0.0
        self.bayer: str | None = None
        self.model = str(params.get("name", "ASCOM camera"))

    # ---- transport (override) -----------------------------------------------------------
    def _connect(self) -> None:
        raise NotImplementedError

    def _disconnect(self) -> None:
        pass

    def _get(self, name: str) -> Any:
        raise NotImplementedError

    def _put(self, name: str, value: Any) -> None:
        raise NotImplementedError

    def _start(self, duration: float, light: bool) -> None:
        raise NotImplementedError

    def _ready(self) -> bool:
        return bool(self._get("imageready"))

    def _fetch(self) -> np.ndarray:
        raise NotImplementedError

    def _abort(self) -> None:
        pass

    # ---- driver interface ---------------------------------------------------------------
    def _opt(self, name: str) -> Any:
        try:
            return self._get(name)
        except CameraError:
            return None
        except Exception:  # noqa: BLE001 - optional property: many cameras do not implement all of them
            return None

    def open(self) -> None:
        self._connect()
        try:
            self.w, self.h = int(self._get("cameraxsize")), int(self._get("cameraysize"))
        except Exception as exc:  # noqa: BLE001
            raise CameraError(f"The camera did not answer: {exc}") from exc
        self.max_adu = int(self._opt("maxadu") or 65535)
        self.bit_depth = 8 if self.max_adu <= 255 else max(9, min(16, math.ceil(math.log2(self.max_adu + 1))))
        self.exp_min = float(self._opt("exposuremin") or 0.001)
        self.exp_max = float(self._opt("exposuremax") or 3600.0)
        self.exposure = min(max(self.exposure, self.exp_min), self.exp_max)
        gmin, gmax = self._opt("gainmin"), self._opt("gainmax")
        if gmin is not None and gmax is not None and gmax > gmin:
            self.gain_range = (float(gmin), float(gmax))
            g = self._opt("gain")
            self.gain = float(g) if g is not None else float(gmin)
        self.max_bin = int(self._opt("maxbinx") or 1)
        self.can_cool = bool(self._opt("cansetccdtemperature"))
        if self.can_cool:
            self.cooler = bool(self._opt("cooleron"))
            t = self._opt("setccdtemperature")
            self.target = float(t) if t is not None else -10.0
        sensor = self._opt("sensortype")
        if sensor in (1, 2):
            ox = int(self._opt("bayeroffsetx") or 0) if sensor == 1 else 0
            oy = int(self._opt("bayeroffsety") or 0) if sensor == 1 else 0
            self.bayer = _BAYER.get((ox % 2, oy % 2), "RGGB")
        self._reset_roi()

    def _reset_roi(self) -> None:
        b = self.binning
        for prop, val in (("binx", b), ("biny", b), ("startx", 0), ("starty", 0), ("numx", self.w // b), ("numy", self.h // b)):
            self._put(prop, val)

    def close(self) -> None:
        try:
            self._abort()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._disconnect()
        except Exception:  # noqa: BLE001
            pass

    def read(self) -> Frame | None:
        duration = self.exposure
        self._start(duration, True)
        deadline = time.time() + duration + 45.0
        while not self._ready():
            if time.time() > deadline:
                raise CameraError("The exposure never finished. Is the camera still connected?")
            time.sleep(0.03 if duration < 1 else 0.1)
        img = np.asarray(self._fetch())
        top = int(img.max()) if img.size else 0
        if self.bit_depth <= 8 and top <= 255:
            data = img.astype(np.uint8)
            depth = 8
        else:
            data = np.clip(img, 0, 65535).astype(np.uint16)
            depth = self.bit_depth
        meta: dict[str, Any] = {"gain": self.gain, "binning": self.binning}
        temp = self._opt("ccdtemperature") if self.can_cool else None
        if temp is not None:
            meta["temperature"] = float(temp)
        return Frame(data=data, bit_depth=depth, bayer=self.bayer, exposure_s=duration, meta=meta)

    def controls(self) -> list[dict[str, Any]]:
        out = [control("exposure", "Exposure", "range", self.exposure, min=self.exp_min, max=min(self.exp_max, 600.0), step=0.001, unit="s", log=True)]
        if self.gain_range:
            lo, hi = self.gain_range
            out.append(control("gain", "Gain", "range", self.gain, min=lo, max=hi, step=1))
        if self.max_bin > 1:
            out.append(control("binning", "Binning", "choice", str(self.binning), choices=[str(b) for b in range(1, min(self.max_bin, 4) + 1)]))
        if self.can_cool:
            out.append(control("cooler", "Cooler", "toggle", self.cooler, group="cooling"))
            out.append(control("target_temp", "Target temperature", "range", self.target, min=-40, max=30, step=1, unit="°C", group="cooling"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        if name == "exposure":
            self.exposure = min(max(float(value), self.exp_min), self.exp_max)
        elif name == "gain" and self.gain_range:
            self.gain = float(value)
            self._put("gain", int(round(self.gain)))
        elif name == "binning":
            self.binning = int(value)
            self._reset_roi()
        elif name == "cooler" and self.can_cool:
            self.cooler = bool(value)
            self._put("cooleron", self.cooler)
        elif name == "target_temp" and self.can_cool:
            self.target = float(value)
            self._put("setccdtemperature", self.target)
        else:
            super().set_control(name, value)

    def info(self) -> dict[str, Any]:
        return {"model": self.model, "sensor": f"{self.w}x{self.h}", "bit_depth": self.bit_depth}
