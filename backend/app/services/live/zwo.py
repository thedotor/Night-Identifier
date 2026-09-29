"""ZWO ASI cameras through ZWO's own SDK (ASICamera2.dll) using the `zwoasi` package.

Needs: `pip install zwoasi` (uv add zwoasi) and ZWO's ASICamera2.dll. The DLL is looked for in the
`zwo` folder inside the app's data folder (Documents/Night Identifier/zwo; it survives updates), next
to the app, in the ZWO / ASCOM install folders, on PATH, or at the path in the ZWO_ASI_LIB environment
variable. (If you already have ZWO's ASCOM driver installed, choosing the camera under "ASCOM"
works too and needs none of this.)

NOTE: written against the SDK's documented behaviour; not yet exercised on real hardware."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from app.config import settings
from app.services.live.base import CameraDriver, CameraError, DriverUnavailable, Frame, control

_BAYER = {0: "RGGB", 1: "BGGR", 2: "GRBG", 3: "GBRG"}
_initialised = False


def _find_library() -> str | None:
    env = os.environ.get("ZWO_ASI_LIB")
    if env and Path(env).exists():
        return env
    names = ["ASICamera2.dll"] if sys.platform == "win32" else ["libASICamera2.so", "libASICamera2.dylib"]
    folders = [settings.data_dir / "zwo", Path(__file__).resolve().parents[3], Path.cwd()]
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramW6432")):
        if base:
            folders += [Path(base) / "ZWO Design", Path(base) / "ASCOM" / "Platform 6 Developer Components", Path(base) / "ZWO ASIStudio", Path(base) / "ZWO Design" / "ASI SDK" / "lib" / "x64"]
    folders += [Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for folder in folders:
        for name in names:
            candidate = folder / name
            try:
                if candidate.exists():
                    return str(candidate)
            except OSError:
                continue
    # one level down inside the ZWO folders (versioned sub-folders)
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base and (Path(base) / "ZWO Design").exists():
            for hit in (Path(base) / "ZWO Design").rglob(names[0]):
                return str(hit)
    return None


def _asi() -> Any:
    """The initialised zwoasi module, or DriverUnavailable with a message saying what is missing."""
    global _initialised
    try:
        import zwoasi as asi  # type: ignore
    except ImportError as exc:
        raise DriverUnavailable("ZWO support needs the 'zwoasi' package (uv add zwoasi in the backend folder). Alternatively use the camera's ASCOM driver.") from exc
    if not _initialised:
        lib = _find_library()
        if lib is None:
            raise DriverUnavailable(
                f"ZWO's ASICamera2.dll was not found. Put it in {settings.data_dir / 'zwo'}, install the ZWO ASI SDK / ASIStudio, "
                "or set the ZWO_ASI_LIB environment variable to its full path."
            )
        try:
            asi.init(lib)
        except Exception as exc:  # noqa: BLE001
            raise DriverUnavailable(f"Could not load the ZWO library: {exc}") from exc
        _initialised = True
    return asi


class ZwoCamera(CameraDriver):
    kind = "zwo"
    is_astro = True

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.asi: Any = None
        self.cam: Any = None
        self.props: dict[str, Any] = {}
        self.caps: dict[str, dict[str, Any]] = {}
        self.exposure = float(params.get("exposure_s", 0.2))
        self.binning = 1
        self.bayer: str | None = None
        self.depth = 16

    def open(self) -> None:
        asi = _asi()
        self.asi = asi
        count = asi.get_num_cameras()
        if count == 0:
            raise CameraError("No ZWO camera found. Is it plugged in (and not open in another program)?")
        idx = min(int(self.params.get("index", 0)), count - 1)
        try:
            self.cam = asi.Camera(idx)
            self.props = self.cam.get_camera_property()
            self.caps = self.cam.get_controls()
        except Exception as exc:  # noqa: BLE001
            raise CameraError(f"Could not open the ZWO camera: {exc}") from exc
        colour = bool(self.props.get("IsColorCam"))
        self.bayer = _BAYER.get(int(self.props.get("BayerPattern", 0))) if colour else None
        self.depth = 16
        self._apply_format()
        try:
            self.cam.set_control_value(asi.ASI_BANDWIDTHOVERLOAD, 80)  # USB bandwidth, percent
        except Exception:  # noqa: BLE001 - optional
            pass

    def _apply_format(self) -> None:
        asi = self.asi
        w, h = int(self.props["MaxWidth"]), int(self.props["MaxHeight"])
        b = self.binning
        self.cam.set_roi(start_x=0, start_y=0, width=w // b - (w // b) % 8, height=h // b - (h // b) % 2, bins=b, image_type=asi.ASI_IMG_RAW16)

    def close(self) -> None:
        if self.cam is not None:
            try:
                self.cam.close()
            except Exception:  # noqa: BLE001
                pass
            self.cam = None

    def read(self) -> Frame | None:
        if self.cam is None:
            raise CameraError("Camera is closed")
        asi = self.asi
        try:
            self.cam.set_control_value(asi.ASI_EXPOSURE, int(self.exposure * 1_000_000))
            img = self.cam.capture(initial_sleep=min(self.exposure, 0.5), poll=0.02)
        except Exception as exc:  # noqa: BLE001 - SDK errors mean the camera went away
            raise CameraError(f"ZWO camera error: {exc}") from exc
        data = np.asarray(img)
        if data.dtype != np.uint16:
            data = data.astype(np.uint16)
        meta: dict[str, Any] = {"binning": self.binning}
        try:
            meta["gain"] = float(self.cam.get_control_value(asi.ASI_GAIN)[0])
            meta["temperature"] = float(self.cam.get_control_value(asi.ASI_TEMPERATURE)[0]) / 10.0
        except Exception:  # noqa: BLE001
            pass
        return Frame(data=data, bit_depth=16, bayer=self.bayer if data.ndim == 2 else None, exposure_s=self.exposure, meta=meta)

    def _cap(self, name: str) -> dict[str, Any] | None:
        return self.caps.get(name)

    def _value(self, const: Any, default: float = 0.0) -> float:
        try:
            return float(self.cam.get_control_value(const)[0])
        except Exception:  # noqa: BLE001
            return default

    def controls(self) -> list[dict[str, Any]]:
        if self.cam is None:
            return []
        asi = self.asi
        exp_cap = self._cap("Exposure")
        exp_max = min(float(exp_cap["MaxValue"]) / 1e6, 600.0) if exp_cap else 600.0
        exp_min = max(float(exp_cap["MinValue"]) / 1e6, 0.00003) if exp_cap else 0.001
        out = [control("exposure", "Exposure", "range", self.exposure, min=exp_min, max=exp_max, step=0.001, unit="s", log=True)]
        gain = self._cap("Gain")
        if gain:
            out.append(control("gain", "Gain", "range", self._value(asi.ASI_GAIN), min=float(gain["MinValue"]), max=float(gain["MaxValue"]), step=1))
        offset = self._cap("Offset")
        if offset:
            out.append(control("offset", "Offset", "range", self._value(asi.ASI_OFFSET), min=float(offset["MinValue"]), max=float(offset["MaxValue"]), step=1))
        bins = [str(b) for b in self.props.get("SupportedBins", [1]) if b and b <= 4]
        if len(bins) > 1:
            out.append(control("binning", "Binning", "choice", str(self.binning), choices=bins))
        if self.props.get("IsCoolerCam"):
            out.append(control("cooler", "Cooler", "toggle", bool(self._value(asi.ASI_COOLER_ON)), group="cooling"))
            out.append(control("target_temp", "Target temperature", "range", self._value(asi.ASI_TARGET_TEMP, -10.0), min=-40, max=30, step=1, unit="°C", group="cooling"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        if self.cam is None:
            raise CameraError("Camera is closed")
        asi = self.asi
        try:
            if name == "exposure":
                self.exposure = float(value)
            elif name == "gain":
                self.cam.set_control_value(asi.ASI_GAIN, int(value))
            elif name == "offset":
                self.cam.set_control_value(asi.ASI_OFFSET, int(value))
            elif name == "binning":
                self.binning = int(value)
                self._apply_format()
            elif name == "cooler":
                self.cam.set_control_value(asi.ASI_COOLER_ON, 1 if value else 0)
            elif name == "target_temp":
                self.cam.set_control_value(asi.ASI_TARGET_TEMP, int(value))
            else:
                super().set_control(name, value)
        except CameraError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CameraError(f"The camera refused that setting: {exc}") from exc

    def info(self) -> dict[str, Any]:
        p = self.props
        return {"model": str(p.get("Name", "ZWO camera")), "sensor": f"{p.get('MaxWidth', '?')}x{p.get('MaxHeight', '?')}", "bit_depth": 16}


def discover() -> list[dict[str, Any]]:
    """Connected ZWO cameras (empty if the SDK is not installed)."""
    try:
        asi = _asi()
        names = asi.list_cameras()
    except Exception:  # noqa: BLE001
        return []
    return [{"kind": "zwo", "name": str(n), "note": "ZWO ASI camera (native SDK)", "params": {"index": i, "name": str(n)}} for i, n in enumerate(names)]
