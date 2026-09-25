"""Canon EOS cameras (DSLR / mirrorless) over USB through Canon's EDSDK: live view, ISO / aperture /
shutter, and full-quality photos (RAW/JPEG) saved straight into the library.

Needs Canon's EDSDK, which cannot be bundled: apply for it at Canon's developer site (free), then
either put the DLLs (EDSDK.dll, EdsImage.dll and the rest of the folder) in `backend/vendor/edsdk/`,
or set the CANON_EDSDK_DIR environment variable to that folder. Use the 64-bit build.

NOTE: written from the EDSDK's documented API and header constants; not yet exercised against the
SDK or a real camera. If a value is wrong, the Log page shows the SDK error code."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import math
import os
import sys
import time
from ctypes import POINTER, byref, c_char, c_int32, c_uint32, c_uint64, c_void_p
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.services.live.base import CameraDriver, CameraError, DriverUnavailable, Frame, control

# ---- SDK constants (EDSDKTypes.h / EDSDKErrors.h) ---------------------------------------------
EDS_OK = 0
ERR_DEVICE_NOT_FOUND = 0x80
ERR_DEVICE_BUSY = 0x81
ERR_OBJECT_NOTREADY = 0xA102
ERR_TAKE_PICTURE_AF_NG = 0x8D01

PROP_SAVE_TO = 0x0000000B
PROP_ISO = 0x00000402
PROP_AV = 0x00000405
PROP_TV = 0x00000406
PROP_EVF_MODE = 0x00000501
PROP_EVF_OUTPUT = 0x00000500

EVF_OUTPUT_PC = 2
SAVE_TO_HOST = 2
CMD_TAKE_PICTURE = 0x00000000
EVENT_DIRITEM_REQUEST_TRANSFER = 0x00000208
EVENT_ALL_OBJECT = 0x00000200
CREATE_ALWAYS = 1
ACCESS_READ_WRITE = 2

_ERROR_HINTS = {
    ERR_DEVICE_NOT_FOUND: "the camera was not found (switched off, or the cable was unplugged)",
    ERR_DEVICE_BUSY: "the camera is busy (another program such as EOS Utility may be using it)",
    ERR_TAKE_PICTURE_AF_NG: "the camera could not focus, so it did not take the picture",
}

_STANDARD_ISO = [50, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800, 16000, 20000, 25600, 32000, 40000, 51200, 102400]
_STANDARD_AV = [1.0, 1.1, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.5, 4.0, 4.5, 5.0, 5.6, 6.3, 7.1, 8.0, 9.0, 10, 11, 13, 14, 16, 18, 20, 22, 25, 29, 32]
_STANDARD_TV = [30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 0.8, 0.6, 0.5, 0.4, 0.3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 13, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 1 / 60, 1 / 80, 1 / 100, 1 / 125, 1 / 160, 1 / 200, 1 / 250, 1 / 320, 1 / 400, 1 / 500, 1 / 640, 1 / 800, 1 / 1000, 1 / 1250, 1 / 1600, 1 / 2000, 1 / 2500, 1 / 3200, 1 / 4000, 1 / 5000, 1 / 6400, 1 / 8000]


def _nearest(value: float, table: list[float]) -> float:
    return min(table, key=lambda t: abs(math.log(t) - math.log(value)))


def iso_label(code: int) -> str:
    if code == 0:
        return "Auto"
    return str(int(_nearest(100.0 * 2 ** ((code - 0x48) / 8.0), _STANDARD_ISO)))


def av_label(code: int) -> str:
    f = _nearest(2 ** ((code - 0x08) / 16.0), _STANDARD_AV)
    return f"f/{f:g}"


def tv_label(code: int) -> str:
    if code == 0x0C:
        return "Bulb"
    s = _nearest(2 ** ((0x38 - code) / 8.0), _STANDARD_TV)
    return f'{s:g}"' if s >= 1 else f"1/{round(1 / s)}"


_LABELS = {PROP_ISO: iso_label, PROP_AV: av_label, PROP_TV: tv_label}


class _DeviceInfo(ctypes.Structure):
    _fields_ = [("szPortName", c_char * 256), ("szDeviceDescription", c_char * 256), ("deviceSubType", c_uint32), ("reserved", c_uint32)]


class _Capacity(ctypes.Structure):
    _fields_ = [("numberOfFreeClusters", c_int32), ("bytesPerSector", c_int32), ("reset", c_int32)]


class _DirItemInfo(ctypes.Structure):
    _fields_ = [("size", c_uint64), ("isFolder", c_int32), ("groupID", c_uint32), ("option", c_uint32), ("szFileName", c_char * 256), ("format", c_uint32), ("dateTime", c_uint32)]


class _PropDesc(ctypes.Structure):
    _fields_ = [("form", c_int32), ("access", c_int32), ("numElements", c_int32), ("propDesc", c_int32 * 128)]


def _find_dll() -> Path | None:
    candidates: list[Path] = []
    env = os.environ.get("CANON_EDSDK_DIR")
    if env:
        candidates.append(Path(env))
    candidates += [Path(__file__).resolve().parents[3] / "vendor" / "edsdk", Path.cwd() / "vendor" / "edsdk"]
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            candidates += [Path(base) / "Canon" / "EDSDK", Path(base) / "Canon Utilities" / "EOS Utility"]
    for folder in candidates:
        dll = folder / "EDSDK.dll"
        try:
            if dll.exists():
                return dll
        except OSError:
            continue
    return None


_sdk: Any = None


def _load() -> Any:
    """The loaded EDSDK library (once per process), or DriverUnavailable saying what is missing."""
    global _sdk
    if _sdk is not None:
        return _sdk
    if sys.platform != "win32":
        raise DriverUnavailable("Canon EDSDK support is only set up for Windows")
    dll = _find_dll()
    if dll is None:
        raise DriverUnavailable(
            "Canon's EDSDK was not found. It is a free download for developers from Canon (it cannot be bundled with the app). "
            "Put its 64-bit DLLs in backend/vendor/edsdk, or set CANON_EDSDK_DIR to that folder."
        )
    try:
        os.add_dll_directory(str(dll.parent))
        lib = ctypes.WinDLL(str(dll))
    except OSError as exc:
        raise DriverUnavailable(f"Could not load Canon's EDSDK ({exc}). Make sure it is the 64-bit version.") from exc
    for name in ("EdsInitializeSDK", "EdsTerminateSDK", "EdsGetEvent"):
        getattr(lib, name).restype = c_uint32
    _sdk = lib
    return lib


def available() -> tuple[bool, str]:
    try:
        _load()
        return True, "Canon EDSDK found."
    except DriverUnavailable as exc:
        return False, str(exc)


class CanonCamera(CameraDriver):
    kind = "canon"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.lib: Any = None
        self.cam = c_void_p()
        self.model = str(params.get("name", "Canon EOS"))
        self.output_dir = Path(params.get("photo_dir") or Path.home() / "Documents" / "Night Identifier" / "live" / "canon")
        self._new_files: list[Path] = []
        self._errors: list[str] = []
        self._handler: Any = None
        self._com = False
        self._sdk_up = False
        self._codes: dict[int, dict[str, int]] = {}  # prop -> label -> code
        self._cur: dict[int, int] = {}

    # ---- plumbing -----------------------------------------------------------------------
    def set_output_dir(self, folder: Path) -> None:
        self.output_dir = folder

    def _check(self, err: int, what: str) -> None:
        if err != EDS_OK:
            hint = _ERROR_HINTS.get(err)
            raise CameraError(f"Canon camera error while {what}: {hint or 'SDK error'} (code 0x{err:X})")

    def _pump(self) -> None:
        """EDSDK delivers events only to a thread that pumps them."""
        self.lib.EdsGetEvent()
        user32 = ctypes.windll.user32
        msg = ctypes.wintypes.MSG()
        while user32.PeekMessageW(byref(msg), None, 0, 0, 1):
            user32.TranslateMessage(byref(msg))
            user32.DispatchMessageW(byref(msg))

    def _get_u32(self, prop: int) -> int | None:
        v = c_uint32()
        if self.lib.EdsGetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(4), byref(v)) != EDS_OK:
            return None
        return int(v.value)

    def _set_u32(self, prop: int, value: int) -> None:
        v = c_uint32(value)
        self._check(self.lib.EdsSetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(4), byref(v)), "changing a setting")

    # ---- driver interface ---------------------------------------------------------------
    def open(self) -> None:
        self.lib = _load()
        ctypes.windll.ole32.CoInitializeEx(None, 2)  # the SDK wants a single-threaded apartment
        self._com = True
        self._check(self.lib.EdsInitializeSDK(), "starting the SDK")
        self._sdk_up = True

        listing = c_void_p()
        self._check(self.lib.EdsGetCameraList(byref(listing)), "listing cameras")
        try:
            count = c_uint32()
            self._check(self.lib.EdsGetChildCount(listing, byref(count)), "counting cameras")
            if count.value == 0:
                raise CameraError("No Canon camera found. Is it switched on, connected, and not open in EOS Utility?")
            index = min(int(self.params.get("index", 0)), count.value - 1)
            self._check(self.lib.EdsGetChildAtIndex(listing, c_int32(index), byref(self.cam)), "selecting the camera")
        finally:
            self.lib.EdsRelease(listing)

        info = _DeviceInfo()
        if self.lib.EdsGetDeviceInfo(self.cam, byref(info)) == EDS_OK:
            self.model = info.szDeviceDescription.decode("mbcs", "replace") or self.model
        self._check(self.lib.EdsOpenSession(self.cam), "opening the camera")

        self.output_dir.mkdir(parents=True, exist_ok=True)
        handler_type = ctypes.WINFUNCTYPE(c_uint32, c_uint32, c_void_p, c_void_p)
        self._handler = handler_type(self._on_object)
        self._check(self.lib.EdsSetObjectEventHandler(self.cam, c_uint32(EVENT_ALL_OBJECT), self._handler, None), "listening for photos")
        # photos go to this computer, not just the memory card; tell the camera the computer has room
        self._set_u32(PROP_SAVE_TO, SAVE_TO_HOST)
        self.lib.EdsSetCapacity(self.cam, _Capacity(0x7FFFFFFF, 0x1000, 1))
        # start live view on the computer
        self._set_u32(PROP_EVF_MODE, 1)
        self._set_u32(PROP_EVF_OUTPUT, EVF_OUTPUT_PC)
        self._refresh_settings()

    def close(self) -> None:
        if self.lib is None:
            return
        try:
            if self.cam:
                try:
                    self._set_u32(PROP_EVF_OUTPUT, 0)
                except CameraError:
                    pass
                self.lib.EdsCloseSession(self.cam)
                self.lib.EdsRelease(self.cam)
                self.cam = c_void_p()
        finally:
            if self._sdk_up:
                self.lib.EdsTerminateSDK()
                self._sdk_up = False
            if self._com:
                ctypes.windll.ole32.CoUninitialize()
                self._com = False

    def read(self) -> Frame | None:
        self._pump()
        if self._errors:
            raise CameraError(self._errors.pop(0))
        stream = c_void_p()
        evf = c_void_p()
        try:
            self._check(self.lib.EdsCreateMemoryStream(c_uint64(0), byref(stream)), "preparing live view")
            self._check(self.lib.EdsCreateEvfImageRef(stream, byref(evf)), "preparing live view")
            err = self.lib.EdsDownloadEvfImage(self.cam, evf)
            if err == ERR_OBJECT_NOTREADY:
                time.sleep(0.03)
                return None
            self._check(err, "reading live view")
            ptr = c_void_p()
            length = c_uint64()
            self._check(self.lib.EdsGetPointer(stream, byref(ptr)), "reading live view")
            self._check(self.lib.EdsGetLength(stream, byref(length)), "reading live view")
            raw = ctypes.string_at(ptr.value, int(length.value))
        finally:
            if evf:
                self.lib.EdsRelease(evf)
            if stream:
                self.lib.EdsRelease(stream)
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        return Frame(data=img, bit_depth=8, meta={})

    # ---- settings -----------------------------------------------------------------------
    def _allowed(self, prop: int) -> dict[str, int]:
        desc = _PropDesc()
        if self.lib.EdsGetPropertyDesc(self.cam, c_uint32(prop), byref(desc)) != EDS_OK:
            return {}
        label = _LABELS[prop]
        out: dict[str, int] = {}
        for i in range(min(desc.numElements, 128)):
            code = int(desc.propDesc[i])
            out.setdefault(label(code), code)
        return out

    def _refresh_settings(self) -> None:
        for prop in (PROP_ISO, PROP_AV, PROP_TV):
            self._codes[prop] = self._allowed(prop)
            cur = self._get_u32(prop)
            if cur is not None:
                self._cur[prop] = cur

    def controls(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        names = {PROP_ISO: ("iso", "ISO"), PROP_TV: ("shutter", "Shutter speed"), PROP_AV: ("aperture", "Aperture")}
        for prop, (name, label) in names.items():
            options = self._codes.get(prop) or {}
            if not options:
                continue  # in Auto / program modes the camera does not allow changing this
            cur_label = next((lbl for lbl, code in options.items() if code == self._cur.get(prop)), next(iter(options)))
            out.append(control(name, label, "choice", cur_label, choices=list(options)))
        out.append(control("take_photo", "Take full-quality photo", "action", None, group="photo"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        if name == "take_photo":
            self._check(self.lib.EdsSendCommand(self.cam, c_uint32(CMD_TAKE_PICTURE), c_int32(0)), "taking the photo")
            return
        prop = {"iso": PROP_ISO, "shutter": PROP_TV, "aperture": PROP_AV}.get(name)
        if prop is None:
            super().set_control(name, value)
            return
        code = self._codes.get(prop, {}).get(str(value))
        if code is None:
            raise CameraError(f"'{value}' is not available in the camera's current mode")
        self._set_u32(prop, code)
        self._cur[prop] = code

    # ---- photos -------------------------------------------------------------------------
    def _on_object(self, event: int, obj: Any, _ctx: Any) -> int:
        """SDK callback: the camera has a new picture for us to download."""
        if event == EVENT_DIRITEM_REQUEST_TRANSFER and obj:
            try:
                self._download(c_void_p(obj))
            except Exception as exc:  # noqa: BLE001 - never let an exception cross into the SDK
                self._errors.append(f"Could not download the photo: {exc}")
        return EDS_OK

    def _download(self, item: c_void_p) -> None:
        info = _DirItemInfo()
        self._check(self.lib.EdsGetDirectoryItemInfo(item, byref(info)), "reading the photo details")
        name = info.szFileName.decode("mbcs", "replace") or f"IMG_{int(time.time())}.CR2"
        path = self.output_dir / name
        n = 1
        while path.exists():
            n += 1
            path = self.output_dir / f"{Path(name).stem}_{n}{Path(name).suffix}"
        stream = c_void_p()
        self._check(self.lib.EdsCreateFileStream(str(path).encode("mbcs"), c_uint32(CREATE_ALWAYS), c_uint32(ACCESS_READ_WRITE), byref(stream)), "saving the photo")
        try:
            self._check(self.lib.EdsDownload(item, c_uint64(info.size), stream), "downloading the photo")
            self._check(self.lib.EdsDownloadComplete(item), "finishing the download")
        finally:
            self.lib.EdsRelease(stream)
            self.lib.EdsRelease(item)
        self._new_files.append(path)

    def take_new_files(self) -> list[Path]:
        files, self._new_files = self._new_files, []
        return files

    def info(self) -> dict[str, Any]:
        return {"model": self.model, "sensor": "live view", "bit_depth": 8, "stills": True}


def discover(connected_canon: list[str]) -> list[dict[str, Any]]:
    """One entry per Canon body Windows reports, if the SDK is installed. (No SDK call is made
    here: the SDK belongs to the camera's own thread.)"""
    ok, _note = available()
    if not ok:
        return []
    return [
        {"kind": "canon", "name": name, "note": "Canon EOS via Canon's SDK: live view and full-quality photos", "params": {"index": i, "name": name}}
        for i, name in enumerate(connected_canon)
    ]
