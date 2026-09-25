"""A fake astro camera: a 16-bit star field that reacts to exposure, gain, binning and focus.

It exists so the whole Live View pipeline (streaming, histogram, focus score, capture, FITS,
recording, motion/meteor detection) can be exercised and tested without any hardware, and it is
also a handy demo. `inject` triggers a meteor streak or a moving blob on demand."""

from __future__ import annotations

import time
from typing import Any

import cv2
import numpy as np

from app.services.live.base import CameraDriver, Frame, control

BIT_DEPTH = 16


class SyntheticCamera(CameraDriver):
    kind = "synthetic"
    is_astro = True

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.w = int(params.get("width", 960))
        self.h = int(params.get("height", 640))
        self.n_stars = int(params.get("stars", 320))
        self.exposure_ms = float(params.get("exposure_ms", 100.0))
        self.gain = float(params.get("gain", 100.0))
        self.binning = 1
        self.focus = float(params.get("focus", 50.0))
        self.temp_target = 0.0
        self.cooler = False
        self._rng = np.random.default_rng(int(params.get("seed", 7)))
        self._delta: np.ndarray | None = None
        self._psf_cache: dict[float, np.ndarray] = {}
        self._pending: list[str] = []
        self._event: dict[str, Any] | None = None
        self._last = 0.0
        self._t0 = time.time()

    def open(self) -> None:
        h, w = self.h, self.w
        delta = np.zeros((h, w), np.float32)
        xs = self._rng.integers(4, w - 4, self.n_stars)
        ys = self._rng.integers(4, h - 4, self.n_stars)
        # power-law brightness: a few bright stars, many faint ones
        flux = (self._rng.pareto(1.6, self.n_stars) + 1.0) * 9000.0
        np.add.at(delta, (ys, xs), flux.astype(np.float32))
        self._delta = delta
        self._t0 = time.time()

    def close(self) -> None:
        self._psf_cache.clear()

    def _stars(self) -> np.ndarray:
        sigma = round(1.3 + 5.5 * abs(self.focus - 50.0) / 50.0, 1)
        if sigma not in self._psf_cache:
            if len(self._psf_cache) > 40:
                self._psf_cache.clear()
            self._psf_cache[sigma] = cv2.GaussianBlur(self._delta, (0, 0), sigma)
        return self._psf_cache[sigma]

    def read(self) -> Frame | None:
        period = max(self.exposure_ms / 1000.0, 1 / 20)
        wait = self._last + period - time.time()
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()
        exp_s = self.exposure_ms / 1000.0

        gain_k = 10 ** (self.gain / 200.0)  # gain 0..300 -> 1x..~31x
        img = self._stars() * (exp_s * gain_k)
        sky = 300.0 + 700.0 * exp_s * gain_k * 0.4
        # a slow sky gradient so the histogram is not a single spike
        yy = np.linspace(0, 1, self.h, dtype=np.float32)[:, None]
        img = img + sky * (1.0 + 0.25 * yy)
        img = img + self._rng.normal(0, 18 + 6 * gain_k**0.5, img.shape).astype(np.float32)

        self._apply_event(img)
        if self.binning > 1:
            b = self.binning
            hh, ww = (self.h // b) * b, (self.w // b) * b
            img = img[:hh, :ww].reshape(hh // b, b, ww // b, b).sum(axis=(1, 3))
        out = np.clip(img, 0, 65535).astype(np.uint16)
        return Frame(
            data=out,
            bit_depth=BIT_DEPTH,
            timestamp=time.time(),
            exposure_s=exp_s,
            meta={"gain": self.gain, "binning": self.binning, "temperature": self._temperature()},
        )

    def _temperature(self) -> float:
        ambient = 18.0
        if not self.cooler:
            return ambient
        # ease towards the target over ~20 s
        k = min((time.time() - self._t0) / 20.0, 1.0)
        return ambient + (self.temp_target - ambient) * k

    def _apply_event(self, img: np.ndarray) -> None:
        if self._pending and self._event is None:
            kind = self._pending.pop(0)
            if kind == "meteor":
                y0, y1 = self._rng.integers(60, self.h - 60, 2)
                self._event = {"kind": "meteor", "left": 3, "p0": (60, int(y0)), "p1": (self.w - 80, int(y1))}
            else:
                self._event = {"kind": "motion", "left": 12, "x": 100.0, "y": float(self.h // 2)}
        ev = self._event
        if not ev:
            return
        if ev["kind"] == "meteor":
            cv2.line(img, ev["p0"], ev["p1"], 12000.0 * (1 + 0.2 * ev["left"]), 2)
        else:
            x, y = int(ev["x"]), int(ev["y"])
            cv2.circle(img, (x, y), 22, 9000.0, -1)
            ev["x"] += 26.0
        ev["left"] -= 1
        if ev["left"] <= 0:
            self._event = None

    def controls(self) -> list[dict[str, Any]]:
        return [
            control("exposure", "Exposure", "range", self.exposure_ms, min=1, max=5000, step=1, unit="ms", log=True),
            control("gain", "Gain", "range", self.gain, min=0, max=300, step=1),
            control("binning", "Binning", "choice", str(self.binning), choices=["1", "2"]),
            control("focus", "Focus (simulated)", "range", self.focus, min=0, max=100, step=0.5, group="simulation"),
            control("cooler", "Cooler", "toggle", self.cooler, group="cooling"),
            control("target_temp", "Target temperature", "range", self.temp_target, min=-30, max=20, step=1, unit="°C", group="cooling"),
            control("meteor", "Inject meteor", "action", None, group="simulation"),
            control("motion", "Inject moving object", "action", None, group="simulation"),
        ]

    def set_control(self, name: str, value: Any) -> None:
        if name == "exposure":
            self.exposure_ms = float(value)
        elif name == "gain":
            self.gain = float(value)
        elif name == "binning":
            self.binning = int(value)
        elif name == "focus":
            self.focus = float(value)
        elif name == "cooler":
            self.cooler = bool(value)
            self._t0 = time.time()
        elif name == "target_temp":
            self.temp_target = float(value)
            self._t0 = time.time()
        elif name in ("meteor", "motion"):
            self._pending.append(name)
        else:
            super().set_control(name, value)

    def info(self) -> dict[str, Any]:
        return {"model": "Synthetic star field", "sensor": f"{self.w}x{self.h}", "bit_depth": BIT_DEPTH}
