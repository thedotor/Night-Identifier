"""Spotting stills cameras (DSLR / mirrorless) plugged in over USB.

These speak PTP, not the webcam (UVC) protocol, so Windows never offers them as video devices and
the webcam discovery can't list them. Rather than leave the user wondering why a connected Canon
is missing, discovery reports them as an information row explaining what to do."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

# USB vendor ids of camera makers
_MAKERS = {"04A9": "Canon", "04B0": "Nikon", "054C": "Sony", "04CB": "Fujifilm", "07B4": "Olympus / OM System", "04DA": "Panasonic", "0A17": "Pentax / Ricoh"}

_SCRIPT = (
    "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | "
    "Where-Object { $_.InstanceId -like 'USB*VID_*' } | "
    "Select-Object FriendlyName, Class, InstanceId | ConvertTo-Json -Compress"
)


def stills_cameras() -> list[dict[str, Any]]:
    """Information rows (kind 'info') for stills cameras Windows currently sees."""
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _SCRIPT],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.strip()
        devices = json.loads(out) if out else []
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    if isinstance(devices, dict):
        devices = [devices]
    found: dict[str, dict[str, Any]] = {}
    for d in devices:
        iid = str(d.get("InstanceId", "")).upper()
        vid = iid.split("VID_")[1][:4] if "VID_" in iid else ""
        maker = _MAKERS.get(vid)
        if not maker:
            continue
        name = str(d.get("FriendlyName") or f"{maker} camera")
        found[iid.split("\\")[1] if "\\" in iid else iid] = {
            "kind": "info",
            "name": f"{name} is connected",
            "note": (
                f"This {maker} is a stills camera, not a webcam, so it cannot be listed as a video device. "
                f"To use it here, either install {maker}'s webcam software (for Canon: the free EOS Webcam Utility) so it appears "
                "as a USB / webcam"
                + (", or install Canon's developer SDK for full-quality live view and photos (see Settings, Live View cameras)." if maker == "Canon" else ".")
            ),
            "maker": maker,
            "params": {},
        }
    return list(found.values())
