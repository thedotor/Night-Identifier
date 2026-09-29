"""Canon EOS cameras (DSLR / mirrorless) over USB through Canon's EDSDK: live view, exposure (ISO,
shutter, aperture, compensation, metering), focus (lens nudge, autofocus, live-view zoom), image
settings (quality, white balance, picture style, drive mode), Bulb exposures, and full-quality
photos (RAW/JPEG) saved straight into the library.

Needs Canon's EDSDK, which cannot be bundled (nor shipped in the installer or the repository): apply for it at
Canon's developer site (free), then put the DLLs (EDSDK.dll, EdsImage.dll and the rest of the folder) in the
`edsdk` folder inside the app's data folder (Documents/Night Identifier/edsdk; it survives updates), or in
`backend/vendor/edsdk/` when running from source, or set the CANON_EDSDK_DIR environment variable to that folder.
Use the 64-bit build.

NOTE: written from the EDSDK's documented API and header constants; not yet exercised against the
SDK or a real camera. If a value is wrong, the Log page shows the SDK error code."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import math
import os
import sys
import time
from datetime import datetime, timezone
from ctypes import POINTER, byref, c_char, c_int32, c_uint32, c_uint64, c_void_p
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.services.live.base import CameraDriver, CameraError, DriverUnavailable, Frame, control

# ---- SDK constants (EDSDKTypes.h / EDSDKErrors.h) ---------------------------------------------
EDS_OK = 0
ERR_DEVICE_NOT_FOUND = 0x80
ERR_DEVICE_BUSY = 0x81
ERR_OBJECT_NOTREADY = 0xA102
ERR_TAKE_PICTURE_AF_NG = 0x8D01

PROP_BATTERY = 0x00000008
PROP_SAVE_TO = 0x0000000B
PROP_QUALITY = 0x00000100
PROP_WB = 0x00000106
PROP_COLOR_TEMP = 0x00000107
PROP_STYLE = 0x00000114
PROP_AE_MODE = 0x00000400
PROP_AF_MODE = 0x00000404
PROP_DATETIME = 0x00000006
PROP_FIRMWARE = 0x00000007
PROP_SERIAL = 0x00000015
PROP_COLOR_SPACE = 0x0000010D
PROP_WB_SHIFT = 0x00000108
PROP_DRIVE = 0x00000401
PROP_ISO = 0x00000402
PROP_METERING = 0x00000403
PROP_AV = 0x00000405
PROP_TV = 0x00000406
PROP_EXPCOMP = 0x00000407
PROP_SHOTS_LEFT = 0x0000040A
PROP_LENS = 0x0000040D
PROP_EVF_OUTPUT = 0x00000500
PROP_EVF_MODE = 0x00000501
PROP_EVF_ZOOM = 0x00000507
PROP_EVF_ZOOM_POS = 0x00000508
PROP_EVF_AF = 0x0000050E
PROP_EVF_ZOOM_RECT = 0x00000541
PROP_EVF_COORD = 0x00000540

EVENT_ALL_PROPERTY = 0x00000100
EVF_OUTPUT_PC = 2
SAVE_TO_HOST = 2
CMD_TAKE_PICTURE = 0x00000000
CMD_BULB_START = 0x00000002
CMD_BULB_END = 0x00000003
CMD_DO_EVF_AF = 0x00000102
CMD_DRIVE_LENS = 0x00000103
TV_BULB = 0x0C
AE_BULB = 4
EVENT_DIRITEM_REQUEST_TRANSFER = 0x00000208
EVENT_ALL_OBJECT = 0x00000200
CREATE_ALWAYS = 1
ACCESS_READ_WRITE = 2

# lens drive steps (kEdsEvfDriveLens_*): near / far, small / medium / large
_FOCUS_STEPS = {"Near 3": 0x03, "Near 2": 0x02, "Near 1": 0x01, "Far 1": 0x8001, "Far 2": 0x8002, "Far 3": 0x8003}
_ZOOMS = {"Fit": 1, "x5": 5, "x10": 10}
_PAN = {"Left": (-1, 0), "Up": (0, -1), "Down": (0, 1), "Right": (1, 0)}

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


_FRACTIONS = {0: "", 1: "1/8", 2: "1/4", 3: "1/3", 4: "1/2", 5: "2/3", 6: "3/4", 7: "7/8"}


def expcomp_label(code: int) -> str:
    """Exposure compensation: a signed byte in eighths of a stop (0x03 = +1/3, 0xF8 = -1)."""
    signed = (code & 0xFF) - 256 if code & 0x80 else code & 0xFF
    if signed == 0:
        return "0"
    whole, frac = divmod(abs(signed), 8)
    text = (str(whole) if whole or not frac else "") + (" " if whole and frac else "") + _FRACTIONS[frac]
    return ("+" if signed > 0 else "-") + text


_JPEG_SIZES = {0x00: "L", 0x01: "M", 0x02: "S", 0x0E: "S1", 0x0F: "S2", 0x10: "S3"}
_QUALITY_TYPES = {0x13: "fine JPEG", 0x12: "normal JPEG", 0x64: "RAW", 0x63: "cRAW"}


def quality_label(code: int) -> str:
    """Image quality is four bytes: [size1][type1][size2][type2], the second pair 0xFF0F when unused
    (0x0064ff0f = RAW, 0x00640013 = RAW + large fine JPEG, 0x0213ff0f = small fine JPEG)."""
    parts = []
    for size, kind in ((code >> 24 & 0xFF, code >> 16 & 0xFF), (code >> 8 & 0xFF, code & 0xFF)):
        if size == 0xFF and kind in (0x0F, 0xFF):
            continue
        name = _QUALITY_TYPES.get(kind, f"format 0x{kind:02X}")
        if kind in (0x64, 0x63):  # a RAW file: size 0 is the full size, others are M-RAW / S-RAW
            parts.append(name if size == 0 else f"{'M' if size == 1 else 'S'}{name}")
        else:
            parts.append(f"{_JPEG_SIZES.get(size, f'size 0x{size:02X}')} {name}")
    return " + ".join(parts) or f"0x{code:08X}"


_WHITE_BALANCE = {0: "Auto", 1: "Daylight", 2: "Cloudy", 3: "Tungsten", 4: "Fluorescent", 5: "Flash", 8: "Shade", 9: "Colour temperature"}
_METERING = {1: "Spot", 3: "Evaluative", 4: "Partial", 5: "Centre-weighted"}
_PICTURE_STYLE = {0x81: "Standard", 0x82: "Portrait", 0x83: "Landscape", 0x84: "Neutral", 0x85: "Faithful", 0x86: "Monochrome", 0x87: "Auto", 0x88: "Fine detail", 0x21: "User 1", 0x22: "User 2", 0x23: "User 3"}
_DRIVE = {0: "Single", 1: "Continuous (high)", 4: "Continuous (low)", 5: "Continuous (high speed)", 6: "Continuous (low speed)", 7: "Silent single", 0x10: "Self-timer 10 s", 0x11: "Self-timer 2 s"}
_EVF_AF = {0: "Quick", 1: "Live (1 point)", 2: "Live (face + tracking)", 3: "Live (multi)"}
_COLOR_SPACE = {1: "sRGB", 2: "Adobe RGB"}
_AF_MODE = {0: "One-shot AF", 1: "AI Servo AF", 2: "AI Focus AF", 3: "Manual focus (MF)"}
BUSY_RETRY_S = 3.0  # how long a setting waits for a camera that answers "busy" (mid-way through another change)
_AE_MODE = {19: "Creative Auto", 21: "Photo in movie", 22: "Scene Intelligent Auto", 0: "Program (P)", 1: "Shutter priority (Tv)", 2: "Aperture priority (Av)", 3: "Manual (M)", 4: "Bulb (B)", 5: "A-DEP", 6: "DEP", 7: "Custom (C)", 8: "Lock", 9: "Green", 20: "Movie", 0x1F: "Fv"}


def _table(table: dict[int, str]):
    return lambda code: table.get(code)


_LABELS = {
    PROP_ISO: iso_label,
    PROP_AV: av_label,
    PROP_TV: tv_label,
    PROP_EXPCOMP: expcomp_label,
    PROP_QUALITY: quality_label,
    PROP_WB: _table(_WHITE_BALANCE),
    PROP_METERING: _table(_METERING),
    PROP_STYLE: _table(_PICTURE_STYLE),
    PROP_DRIVE: _table(_DRIVE),
    PROP_COLOR_SPACE: _table(_COLOR_SPACE),
    PROP_EVF_AF: _table(_EVF_AF),
}

# (property, control name, label, group): the settings shown as drop-downs, in panel order
_CHOICES = [
    (PROP_ISO, "iso", "ISO", "exposure"),
    (PROP_TV, "shutter", "Shutter speed", "exposure"),
    (PROP_AV, "aperture", "Aperture", "exposure"),
    (PROP_EXPCOMP, "exp_comp", "Exposure compensation", "exposure"),
    (PROP_METERING, "metering", "Metering", "exposure"),
    (PROP_EVF_AF, "evf_af", "Autofocus mode", "focus"),
    (PROP_QUALITY, "quality", "Image quality", "image"),
    (PROP_WB, "white_balance", "White balance", "image"),
    (PROP_STYLE, "picture_style", "Picture style", "image"),
    (PROP_DRIVE, "drive", "Drive / self-timer", "image"),
    (PROP_COLOR_SPACE, "color_space", "Colour space", "image"),
]
_BY_NAME = {name: prop for prop, name, _label, _group in _CHOICES}
# camera-side changes worth re-reading the panel for (live view zoom position / rect change constantly, so they are not here)
_WATCHED = {p for p, *_ in _CHOICES} | {PROP_AE_MODE, PROP_AF_MODE, PROP_BATTERY, PROP_SHOTS_LEFT, PROP_LENS, PROP_EVF_ZOOM, PROP_COLOR_TEMP}


class _DeviceInfo(ctypes.Structure):
    _fields_ = [("szPortName", c_char * 256), ("szDeviceDescription", c_char * 256), ("deviceSubType", c_uint32), ("reserved", c_uint32)]


class _Capacity(ctypes.Structure):
    _fields_ = [("numberOfFreeClusters", c_int32), ("bytesPerSector", c_int32), ("reset", c_int32)]


class _DirItemInfo(ctypes.Structure):
    _fields_ = [("size", c_uint64), ("isFolder", c_int32), ("groupID", c_uint32), ("option", c_uint32), ("szFileName", c_char * 256), ("format", c_uint32), ("dateTime", c_uint32)]


class _EdsTime(ctypes.Structure):
    _fields_ = [("year", c_uint32), ("month", c_uint32), ("day", c_uint32), ("hour", c_uint32), ("minute", c_uint32), ("second", c_uint32), ("milliseconds", c_uint32)]


class _Point(ctypes.Structure):
    _fields_ = [("x", c_int32), ("y", c_int32)]


class _Size(ctypes.Structure):
    _fields_ = [("width", c_int32), ("height", c_int32)]


class _Rect(ctypes.Structure):
    _fields_ = [("x", c_int32), ("y", c_int32), ("width", c_int32), ("height", c_int32)]


class _PropDesc(ctypes.Structure):
    _fields_ = [("form", c_int32), ("access", c_int32), ("numElements", c_int32), ("propDesc", c_int32 * 128)]


def _find_dll() -> Path | None:
    candidates: list[Path] = []
    env = os.environ.get("CANON_EDSDK_DIR")
    if env:
        candidates.append(Path(env))
    candidates += [
        settings.data_dir / "edsdk",
        Path(__file__).resolve().parents[3] / "vendor" / "edsdk",
        Path.cwd() / "vendor" / "edsdk",
    ]
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
            f"Put its 64-bit DLLs in {settings.data_dir / 'edsdk'}, or set CANON_EDSDK_DIR to that folder."
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
        self._status: dict[int, str] = {}  # read-only readouts (mode, lens, battery, shots left)
        self._prop_handler: Any = None
        self._dirty = False  # the camera changed a setting itself (mode dial, card, battery...)
        self._refreshed_at = 0.0
        self._timers: list[tuple[float, Any]] = []  # (when, callback): AF release, end of a timed Bulb exposure
        self._bulb_on = False
        self._bulb_seconds = 30.0
        self._lv_paused = False  # live view switched off so a Bulb exposure could start
        self._zoom_pos_ok: bool | None = None  # can software move the magnified window? (the 90D says no)
        self._wb_shift: tuple[int, int] | None = None  # (blue-amber, green-magenta) when the camera lets us change it
        self._ident: dict[int, str] = {}  # firmware and serial number, read once

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

    def _retry_busy(self, call: Any) -> int:
        """Run an SDK call, and while the camera answers 'busy' (it is finishing another change, such as a zoom step) keep
        the event pump going and try again for a few seconds."""
        deadline = time.time() + BUSY_RETRY_S
        while True:
            err = call()
            if err != ERR_DEVICE_BUSY or time.time() > deadline:
                return int(err)
            self._pump()
            time.sleep(0.08)

    def _set_u32(self, prop: int, value: int) -> None:
        v = c_uint32(value)
        err = self._retry_busy(lambda: self.lib.EdsSetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(4), byref(v)))
        self._check(err, "changing a setting")

    def _get_struct(self, prop: int, kind: Any) -> Any | None:
        v = kind()
        if self.lib.EdsGetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(ctypes.sizeof(kind)), byref(v)) != EDS_OK:
            return None
        return v

    def _set_struct(self, prop: int, value: Any) -> None:
        err = self._retry_busy(lambda: self.lib.EdsSetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(ctypes.sizeof(value)), byref(value)))
        self._check(err, "changing a setting")

    def _get_text(self, prop: int) -> str | None:
        data_type, size = c_int32(), c_uint32()
        if self.lib.EdsGetPropertySize(self.cam, c_uint32(prop), c_int32(0), byref(data_type), byref(size)) != EDS_OK or size.value == 0:
            return None
        buf = ctypes.create_string_buffer(int(size.value))
        if self.lib.EdsGetPropertyData(self.cam, c_uint32(prop), c_int32(0), c_uint32(size.value), buf) != EDS_OK:
            return None
        return buf.value.decode("mbcs", "replace").strip() or None

    def _command(self, command: int, param: int, what: str) -> None:
        self._check(self._retry_busy(lambda: self.lib.EdsSendCommand(self.cam, c_uint32(command), c_int32(param))), what)

    def _later(self, seconds: float, callback: Any) -> None:
        self._timers.append((time.time() + seconds, callback))

    def _run_timers(self) -> None:
        now = time.time()
        due = [t for t in self._timers if t[0] <= now]
        self._timers = [t for t in self._timers if t[0] > now]
        for _when, callback in due:
            callback()

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
        prop_handler_type = ctypes.WINFUNCTYPE(c_uint32, c_uint32, c_uint32, c_uint32, c_void_p)
        self._prop_handler = prop_handler_type(self._on_property)
        # optional: without it the panel still refreshes after our own changes
        self.lib.EdsSetPropertyEventHandler(self.cam, c_uint32(EVENT_ALL_PROPERTY), self._prop_handler, None)
        # photos go to this computer, not just the memory card; tell the camera the computer has room
        self._set_u32(PROP_SAVE_TO, SAVE_TO_HOST)
        self.lib.EdsSetCapacity(self.cam, _Capacity(0x7FFFFFFF, 0x1000, 1))
        # start live view on the computer
        self._set_u32(PROP_EVF_MODE, 1)
        self._set_u32(PROP_EVF_OUTPUT, EVF_OUTPUT_PC)
        self._cur[PROP_EVF_ZOOM] = 1
        try:  # a camera left magnified by an earlier session starts from the whole picture
            self._set_u32(PROP_EVF_ZOOM, 1)
        except CameraError:
            pass
        self._refresh_settings()

    def close(self) -> None:
        if self.lib is None:
            return
        try:
            if self.cam:
                try:
                    if self._bulb_on:
                        self._bulb_stop()
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
        self._run_timers()
        if self._errors:
            raise CameraError(self._errors.pop(0))
        if self._lv_paused:  # live view is off while a Bulb exposure runs; keep pumping so the photo arrives
            time.sleep(0.05)
            return None
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
        """label -> code for the values the camera accepts right now (empty when the current mode locks the setting)."""
        desc = _PropDesc()
        if self.lib.EdsGetPropertyDesc(self.cam, c_uint32(prop), byref(desc)) != EDS_OK:
            return {}
        label = _LABELS[prop]
        out: dict[str, int] = {}
        for i in range(min(desc.numElements, 128)):
            code = int(desc.propDesc[i])
            text = label(code)
            if text is not None:
                out.setdefault(text, code)
        return out

    def _refresh_settings(self) -> None:
        for prop, *_rest in _CHOICES:
            self._codes[prop] = self._allowed(prop)
            cur = self._get_u32(prop)
            if cur is not None:
                self._cur[prop] = cur
        # (the live view magnification is not read back: the camera answers with the previous value for about a second after a
        # change, which put the drop-down back on the old choice. It is whatever was last set.)
        for prop in (PROP_AE_MODE, PROP_AF_MODE, PROP_COLOR_TEMP):
            cur = self._get_u32(prop)
            if cur is not None:
                self._cur[prop] = cur
        shift = self._get_struct(PROP_WB_SHIFT, _Point)
        desc = _PropDesc()
        settable = self.lib.EdsGetPropertyDesc(self.cam, c_uint32(PROP_WB_SHIFT), byref(desc)) == EDS_OK and desc.numElements > 0
        self._wb_shift = (int(shift.x), int(shift.y)) if shift is not None and settable else None
        status: dict[int, str] = {}
        mode = self._cur.get(PROP_AE_MODE)
        if mode is not None and mode != 0xFFFFFFFF:
            status[PROP_AE_MODE] = _AE_MODE.get(mode, f"mode {mode}")
        lens = self._get_text(PROP_LENS)
        if lens:
            status[PROP_LENS] = lens
        battery = self._get_u32(PROP_BATTERY)
        if battery is not None:
            status[PROP_BATTERY] = "on mains power" if battery == 0xFFFFFFFF else f"{battery}%"
        shots = self._get_u32(PROP_SHOTS_LEFT)
        if shots is not None and shots != 0xFFFFFFFF:
            status[PROP_SHOTS_LEFT] = str(shots)
        af = self._cur.get(PROP_AF_MODE)
        if af in _AF_MODE:
            status[PROP_AF_MODE] = _AF_MODE[af] + (" (slide the lens's AF/MF switch to AF to autofocus)" if af == 3 else "")
        clock = self._camera_clock()
        if clock:
            status[PROP_DATETIME] = clock
        if not self._ident:
            for prop in (PROP_FIRMWARE, PROP_SERIAL):
                text = self._get_text(prop)
                if text:
                    self._ident[prop] = text
        status.update(self._ident)
        self._status = status
        self._refreshed_at = time.time()
        self._dirty = False

    def _camera_clock(self) -> str | None:
        """The camera's clock and how far it is from this computer's (cameras have no time zone, so it may be set to UTC or to local time)."""
        raw = self._get_struct(PROP_DATETIME, _EdsTime)
        if raw is None or not raw.month or not raw.day:
            return None
        try:
            cam = datetime(raw.year, raw.month, raw.day, raw.hour, raw.minute, raw.second)
        except ValueError:
            return None
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
        now_local = datetime.now()
        diff_utc = (cam - now_utc).total_seconds()
        diff_local = (cam - now_local).total_seconds()
        diff, zone = (diff_utc, "UTC") if abs(diff_utc) <= abs(diff_local) else (diff_local, "local time")
        how = "in step with" if abs(diff) < 2 else f"{abs(diff):.0f} s {'ahead of' if diff > 0 else 'behind'}"
        return f"{cam:%H:%M:%S} ({how} this computer's {zone})"

    def _on_property(self, event: int, prop: int, _param: int, _ctx: Any) -> int:
        """SDK callback (runs inside our own event pump): note that the camera changed a setting."""
        if prop in _WATCHED:
            self._dirty = True
        return EDS_OK

    def busy(self) -> bool:
        return self._bulb_on

    def controls_changed(self) -> bool:
        if self._dirty and time.time() - self._refreshed_at > 0.4:
            self._refresh_settings()
            return True
        return False

    def _choice(self, prop: int) -> tuple[list[str], str] | None:
        options = dict(self._codes.get(prop) or {})
        if not options:
            return None  # in Auto / program modes the camera does not allow changing this
        cur = self._cur.get(prop)
        current = next((lbl for lbl, code in options.items() if code == cur), None)
        if current is None and cur is not None:
            text = _LABELS[prop](cur)
            if text is not None:
                options[text] = cur
                current = text
        return list(options), current or next(iter(options))

    def controls(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        def add_choices(group: str) -> None:
            for prop, name, label, g in _CHOICES:
                if g != group:
                    continue
                picked = self._choice(prop)
                if picked:
                    out.append(control(name, label, "choice", picked[1], choices=picked[0], group=group))

        add_choices("exposure")

        # focus: nudge the lens, autofocus, and magnify the live picture to judge stars
        add_choices("focus")
        out.append(control("focus_jog", "Focus slider (hold away from the middle; further = faster)", "jog", 0, min=-3, max=3, step=1, group="focus"))
        out.append(control("focus_nudge", "Focus (lens drive)", "buttons", None, choices=list(_FOCUS_STEPS), group="focus"))
        out.append(control("autofocus", "Autofocus now", "action", None, group="focus"))
        zoom = self._cur.get(PROP_EVF_ZOOM)
        zoom_label = next((lbl for lbl, code in _ZOOMS.items() if code == zoom), "Fit")
        out.append(control("evf_zoom", "Live view magnify", "choice", zoom_label, choices=list(_ZOOMS), group="focus"))
        if zoom_label != "Fit" and self._zoom_pos_ok:  # only cameras that let software move the window (the 90D does not)
            out.append(control("zoom_pan", "Move the magnified area", "buttons", None, choices=[*_PAN, "Centre"], group="focus"))

        add_choices("image")
        if self._cur.get(PROP_WB) == 9:  # colour temperature white balance
            kelvin = self._cur.get(PROP_COLOR_TEMP) or 5200
            out.append(control("color_temp", "Colour temperature", "range", kelvin, min=2500, max=10000, step=100, unit="K", group="image"))

        if self._wb_shift is not None:
            out.append(control("wb_shift_ab", "White balance shift, blue / amber", "range", self._wb_shift[0], min=-9, max=9, step=1, group="image"))
            out.append(control("wb_shift_gm", "White balance shift, green / magenta", "range", self._wb_shift[1], min=-9, max=9, step=1, group="image"))

        # photo: a normal shot, or a Bulb exposure (start / stop by hand, or for a set time)
        out.append(control("take_photo", "Take full-quality photo", "action", None, group="photo"))
        out.append(control("bulb_seconds", "Bulb exposure time", "range", self._bulb_seconds, min=1, max=3600, step=1, unit="s", log=True, group="photo"))
        if self._bulb_on:
            out.append(control("bulb_manual", "Bulb exposure running", "buttons", None, choices=["Stop"], group="photo"))
        else:
            out.append(control("bulb_timed", f"Take a {self._bulb_seconds:g} s Bulb exposure", "action", None, group="photo"))
            out.append(control("bulb_manual", "Bulb (hold open by hand)", "buttons", None, choices=["Start"], group="photo"))

        for prop, label in (
            (PROP_AE_MODE, "Mode dial"),
            (PROP_LENS, "Lens"),
            (PROP_AF_MODE, "Lens focus switch"),
            (PROP_BATTERY, "Battery"),
            (PROP_SHOTS_LEFT, "Shots left on card"),
            (PROP_DATETIME, "Camera clock"),
            (PROP_FIRMWARE, "Firmware"),
            (PROP_SERIAL, "Serial number"),
        ):
            if prop in self._status:
                out.append(control(f"status_{prop:x}", label, "info", self._status[prop], group="status"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        try:
            self._set_control(name, value)
        finally:
            if name != "focus_jog":  # (the jog repeats several times a second and changes no setting)
                self._dirty = True  # the camera may now offer different choices, or refused and needs re-reading

    def _set_control(self, name: str, value: Any) -> None:
        if name == "take_photo":
            if self._bulb_on:
                raise CameraError("A Bulb exposure is running: stop it first")
            self._command(CMD_TAKE_PICTURE, 0, "taking the photo")
        elif name == "bulb_seconds":
            self._bulb_seconds = max(1.0, min(3600.0, float(value)))
        elif name == "bulb_timed":
            self._bulb_start(self._bulb_seconds)
        elif name == "bulb_manual":
            if str(value) == "Stop":
                self._bulb_stop()
            else:
                self._bulb_start(None)
        elif name == "focus_jog":
            # the slider sends -3..3 while held (negative = nearer); the lens has only step commands, so it repeats them
            step = int(round(float(value)))
            if step:
                err = self.lib.EdsSendCommand(self.cam, c_uint32(CMD_DRIVE_LENS), c_int32((0x8000 if step > 0 else 0) | min(3, abs(step))))
                if err not in (EDS_OK, ERR_DEVICE_BUSY):  # busy just means the lens has not finished the last step
                    self._check(err, "moving the focus (the lens must be an autofocus lens with its switch on AF)")
        elif name == "focus_nudge":
            step = _FOCUS_STEPS.get(str(value))
            if step is None:
                raise CameraError(f"Unknown focus step '{value}'")
            self._command(CMD_DRIVE_LENS, step, "moving the focus (the lens must be an autofocus lens with its switch on AF)")
        elif name == "autofocus":
            self._command(CMD_DO_EVF_AF, 1, "focusing (the lens switch must be on AF)")
            self._later(1.5, self._release_af)
        elif name == "evf_zoom":
            code = _ZOOMS.get(str(value))
            if code is None:
                raise CameraError(f"Unknown magnification '{value}'")
            self._set_u32(PROP_EVF_ZOOM, code)
            self._cur[PROP_EVF_ZOOM] = code
            if code != 1:
                if self._zoom_pos_ok is None:  # does this body let software move the window? (asked once)
                    kind, size = c_int32(), c_uint32()
                    self._zoom_pos_ok = self.lib.EdsGetPropertySize(self.cam, c_uint32(PROP_EVF_ZOOM_POS), c_int32(0), byref(kind), byref(size)) == EDS_OK and size.value > 0
                if self._zoom_pos_ok:
                    try:  # start on the middle of the picture
                        self._pan_zoom(0, 0, centre=True)
                    except CameraError:
                        pass
        elif name == "zoom_pan":
            if str(value) == "Centre":
                self._pan_zoom(0, 0, centre=True)
            else:
                dx, dy = _PAN.get(str(value), (0, 0))
                self._pan_zoom(dx, dy)
        elif name in ("wb_shift_ab", "wb_shift_gm"):
            cur = self._wb_shift or (0, 0)
            v = max(-9, min(9, int(round(float(value)))))
            new = (v, cur[1]) if name == "wb_shift_ab" else (cur[0], v)
            self._set_struct(PROP_WB_SHIFT, _Point(*new))
            self._wb_shift = new
        elif name == "color_temp":
            kelvin = int(round(max(2500, min(10000, float(value))) / 100) * 100)
            self._set_u32(PROP_COLOR_TEMP, kelvin)
            self._cur[PROP_COLOR_TEMP] = kelvin
        elif name in _BY_NAME:
            prop = _BY_NAME[name]
            code = self._codes.get(prop, {}).get(str(value))
            if code is None:
                raise CameraError(f"'{value}' is not available in the camera's current mode")
            self._set_u32(prop, code)
            self._cur[prop] = code
        else:
            super().set_control(name, value)

    # ---- live view zoom, Bulb -----------------------------------------------------------
    def _pan_zoom(self, dx: int, dy: int, centre: bool = False) -> None:
        """Move the magnified window in live view (its top-left corner, in live view coordinates)."""
        coord = self._get_struct(PROP_EVF_COORD, _Size)
        rect = self._get_struct(PROP_EVF_ZOOM_RECT, _Rect)
        pos = self._get_struct(PROP_EVF_ZOOM_POS, _Point)
        if coord is None or pos is None:
            raise CameraError("This camera does not report where the magnified area is, so it cannot be moved")
        span_x = max(0, coord.width - (rect.width if rect else 0))
        span_y = max(0, coord.height - (rect.height if rect else 0))
        if centre:
            x, y = span_x // 2, span_y // 2
        else:
            step_x = max(1, (rect.width if rect else coord.width // 5) // 3)
            step_y = max(1, (rect.height if rect else coord.height // 5) // 3)
            x = min(span_x, max(0, pos.x + dx * step_x))
            y = min(span_y, max(0, pos.y + dy * step_y))
        self._set_struct(PROP_EVF_ZOOM_POS, _Point(x, y))

    def _bulb_start(self, seconds: float | None) -> None:
        if self._bulb_on:
            raise CameraError("A Bulb exposure is already running")
        tv = self._cur.get(PROP_TV)
        if tv != TV_BULB and self._cur.get(PROP_AE_MODE) != AE_BULB:
            bulb = self._codes.get(PROP_TV, {}).get("Bulb")
            if bulb is None:
                raise CameraError("Bulb is not available: turn the camera's mode dial to M (or B) and try again")
            self._set_u32(PROP_TV, bulb)
            self._cur[PROP_TV] = bulb
        err = self.lib.EdsSendCommand(self.cam, c_uint32(CMD_BULB_START), c_int32(0))
        if err != EDS_OK:
            # some bodies refuse Bulb while live view runs: switch live view off for the exposure
            self._set_u32(PROP_EVF_OUTPUT, 0)
            self._lv_paused = True
            try:
                self._command(CMD_BULB_START, 0, "starting the Bulb exposure (is the camera in M or B mode?)")
            except CameraError:
                self._lv_paused = False
                self._set_u32(PROP_EVF_OUTPUT, EVF_OUTPUT_PC)
                raise
        self._bulb_on = True
        if seconds:
            self._later(seconds, self._bulb_stop)

    def _bulb_stop(self) -> None:
        if not self._bulb_on:
            return
        self._timers = [t for t in self._timers if t[1] != self._bulb_stop]
        self._command(CMD_BULB_END, 0, "ending the Bulb exposure")  # if this fails the exposure counts as still open, so Stop can be tried again
        self._bulb_on = False
        if self._lv_paused:
            self._lv_paused = False
            try:
                self._set_u32(PROP_EVF_OUTPUT, EVF_OUTPUT_PC)
            except CameraError:
                pass
        self._dirty = True

    def _release_af(self) -> None:
        try:
            self._command(CMD_DO_EVF_AF, 0, "releasing autofocus")
        except CameraError:
            pass

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
