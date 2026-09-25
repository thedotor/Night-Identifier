"""Which driver handles which camera `kind`, and how to find cameras to offer in "Add camera"."""

from __future__ import annotations

import importlib
from typing import Any

from app.services.live.base import CameraDriver, DriverUnavailable

# kind -> (module, class). Imported lazily so a missing SDK only affects its own kind.
_DRIVERS: dict[str, tuple[str, str]] = {
    "synthetic": ("app.services.live.synthetic", "SyntheticCamera"),
    "uvc": ("app.services.live.uvc", "UvcCamera"),
    "rtsp": ("app.services.live.network", "StreamCamera"),
    "mjpeg": ("app.services.live.network", "StreamCamera"),
    "snapshot": ("app.services.live.network", "SnapshotCamera"),
    "alpaca": ("app.services.live.alpaca", "AlpacaCamera"),
    "ascom": ("app.services.live.ascom", "AscomComCamera"),
    "indi": ("app.services.live.indi", "IndiCamera"),
    "zwo": ("app.services.live.zwo", "ZwoCamera"),
    "canon": ("app.services.live.canon", "CanonCamera"),
}

KIND_LABELS = {
    "synthetic": "Simulated star field",
    "uvc": "USB / webcam",
    "rtsp": "Network camera (RTSP)",
    "mjpeg": "Network camera (MJPEG stream)",
    "snapshot": "Network camera (JPEG snapshot URL)",
    "alpaca": "Astro camera (ASCOM Alpaca, network)",
    "ascom": "Astro camera (ASCOM driver on this PC)",
    "indi": "Astro camera (INDI server, network)",
    "zwo": "ZWO ASI camera (native SDK)",
    "canon": "Canon EOS camera (Canon SDK)",
}

# How far each driver has been proven. "hardware" = exercised on real devices; "simulated" = exercised
# against a stand-in that speaks the same protocol; "untested" = written to the documented API only.
TESTED = {
    "synthetic": "simulated",
    "uvc": "untested",
    "rtsp": "untested",
    "mjpeg": "simulated",
    "snapshot": "simulated",
    "alpaca": "simulated",
    "ascom": "untested",
    "indi": "simulated",
    "zwo": "untested",
    "onvif": "simulated",
    "canon": "untested",
}


def register(kind: str, module: str, cls: str, label: str) -> None:
    _DRIVERS[kind] = (module, cls)
    KIND_LABELS[kind] = label


def make_driver(kind: str, params: dict[str, Any]) -> CameraDriver:
    entry = _DRIVERS.get(kind)
    if entry is None:
        raise DriverUnavailable(f"Unknown camera type '{kind}'")
    module, cls = entry
    try:
        mod = importlib.import_module(module)
    except ImportError as exc:
        raise DriverUnavailable(f"The {KIND_LABELS.get(kind, kind)} driver needs a component that is not installed: {exc}") from exc
    return getattr(mod, cls)(params)


def known_kinds() -> list[dict[str, str]]:
    return [{"kind": k, "label": KIND_LABELS.get(k, k), "tested": TESTED.get(k, "untested")} for k in _DRIVERS]


def diagnostics() -> list[dict[str, Any]]:
    """Per camera type: can it work on this PC right now, and if not, what is missing."""
    import sys

    out: list[dict[str, Any]] = []
    for kind in _DRIVERS:
        ok, note = True, ""
        if kind == "ascom":
            if sys.platform != "win32":
                ok, note = False, "ASCOM drivers exist only on Windows."
            else:
                try:
                    import win32com.client  # noqa: F401  # type: ignore
                except ImportError:
                    ok, note = False, "Needs the 'pywin32' package (uv add pywin32 in the backend folder) and the ASCOM Platform."
        elif kind == "zwo":
            try:
                from app.services.live import zwo

                zwo._asi()
                note = "SDK found."
            except Exception as exc:  # noqa: BLE001
                ok, note = False, str(exc)
        elif kind == "canon":
            from app.services.live import canon

            ok, note = canon.available()
        elif kind == "uvc":
            note = "Uses the camera drivers Windows already has."
        out.append({"kind": kind, "label": KIND_LABELS.get(kind, kind), "available": ok, "note": note, "tested": TESTED.get(kind, "untested")})
    return out
