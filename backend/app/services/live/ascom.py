"""ASCOM cameras through their Windows COM drivers (any brand with an ASCOM driver installed:
ZWO, QHY, Player One, Atik, SBIG, FLI, Moravian, ToupTek, Canon via the ASCOM DSLR driver, ...).

Needs the ASCOM Platform and the `pywin32` package. COM objects belong to the thread that created
them, so everything here runs on the camera's own capture thread (which is how the manager works)."""

from __future__ import annotations

import sys
from typing import Any

import numpy as np

from app.services.live.ascom_base import AscomCamera
from app.services.live.base import CameraError, DriverUnavailable

# Alpaca-style lower-case name -> COM property name
_PROPS = {
    "cameraxsize": "CameraXSize",
    "cameraysize": "CameraYSize",
    "maxadu": "MaxADU",
    "exposuremin": "ExposureMin",
    "exposuremax": "ExposureMax",
    "gainmin": "GainMin",
    "gainmax": "GainMax",
    "gain": "Gain",
    "maxbinx": "MaxBinX",
    "binx": "BinX",
    "biny": "BinY",
    "startx": "StartX",
    "starty": "StartY",
    "numx": "NumX",
    "numy": "NumY",
    "cansetccdtemperature": "CanSetCCDTemperature",
    "ccdtemperature": "CCDTemperature",
    "cooleron": "CoolerOn",
    "setccdtemperature": "SetCCDTemperature",
    "sensortype": "SensorType",
    "bayeroffsetx": "BayerOffsetX",
    "bayeroffsety": "BayerOffsetY",
    "imageready": "ImageReady",
}


class AscomComCamera(AscomCamera):
    kind = "ascom"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.progid = str(params.get("progid", ""))
        self.com: Any = None
        self._com_init = False

    def _connect(self) -> None:
        if sys.platform != "win32":
            raise DriverUnavailable("ASCOM drivers only exist on Windows")
        try:
            import pythoncom  # type: ignore
            import win32com.client  # type: ignore
        except ImportError as exc:
            raise DriverUnavailable("ASCOM support needs the 'pywin32' package (install it with: uv add pywin32 inside the backend folder)") from exc
        if not self.progid:
            raise CameraError("No ASCOM driver chosen for this camera")
        pythoncom.CoInitialize()
        self._com_init = True
        try:
            self.com = win32com.client.Dispatch(self.progid)
            self.com.Connected = True
        except Exception as exc:  # noqa: BLE001 - COM errors are varied
            raise CameraError(f"Could not start the ASCOM driver '{self.progid}': {exc}. Is the camera plugged in, and is it free (not open in another program)?") from exc

    def _disconnect(self) -> None:
        try:
            if self.com is not None:
                self.com.Connected = False
        finally:
            self.com = None
            if self._com_init:
                import pythoncom  # type: ignore

                pythoncom.CoUninitialize()
                self._com_init = False

    def _get(self, name: str) -> Any:
        return getattr(self.com, _PROPS[name])

    def _put(self, name: str, value: Any) -> None:
        setattr(self.com, _PROPS[name], value)

    def _start(self, duration: float, light: bool) -> None:
        self.com.StartExposure(duration, light)

    def _abort(self) -> None:
        if self.com is not None:
            self.com.AbortExposure()

    def _fetch(self) -> np.ndarray:
        # ImageArray arrives as nested tuples indexed [x][y]
        return np.asarray(self.com.ImageArray, dtype=np.int32).T


def discover() -> list[dict[str, Any]]:
    """ASCOM camera drivers registered on this PC (read from the registry; no camera is touched)."""
    if sys.platform != "win32":
        return []
    import winreg

    found: dict[str, str] = {}
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ASCOM\Camera Drivers", 0, winreg.KEY_READ | view) as root:
                i = 0
                while True:
                    try:
                        progid = winreg.EnumKey(root, i)
                    except OSError:
                        break
                    i += 1
                    if progid in found:
                        continue
                    try:
                        with winreg.OpenKey(root, progid) as k:
                            found[progid] = str(winreg.QueryValueEx(k, "")[0] or progid)
                    except OSError:
                        found[progid] = progid
        except OSError:
            continue
    out = []
    for progid, desc in sorted(found.items(), key=lambda kv: kv[1].lower()):
        out.append({"kind": "ascom", "name": desc, "note": f"ASCOM driver ({progid})", "params": {"progid": progid, "name": desc}})
    return out
