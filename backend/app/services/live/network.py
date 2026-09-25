"""Network cameras: RTSP (security/IP cameras), MJPEG streams, and polled JPEG snapshot URLs."""

from __future__ import annotations

import os
import re
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

import cv2
import numpy as np

from app.services.live.base import CameraDriver, CameraError, Frame, control

# TCP is the reliable transport for RTSP on a home network (UDP drops packets and smears frames)
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

OPEN_TIMEOUT_MS = 8000
READ_TIMEOUT_MS = 8000


def with_credentials(url: str, username: str | None, password: str | None) -> str:
    """Put the login into the URL for OpenCV/FFmpeg. Only ever built inside the backend."""
    if not username:
        return url
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    netloc = f"{quote(username, safe='')}:{quote(password or '', safe='')}@{host}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def mask_url(url: str) -> str:
    """The URL with any embedded password hidden, for showing in the UI."""
    return re.sub(r"(//[^/:@]+):[^@/]*@", r"\1:••••@", url)


class StreamCamera(CameraDriver):
    """RTSP or MJPEG-over-HTTP, read by OpenCV's FFmpeg backend."""

    kind = "rtsp"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.cap: cv2.VideoCapture | None = None
        self._fails = 0

    def open(self) -> None:
        url = with_credentials(str(self.params.get("url", "")), self.params.get("username"), self.params.get("password"))
        if not url:
            raise CameraError("No stream URL set for this camera")
        cap = cv2.VideoCapture(
            url,
            cv2.CAP_FFMPEG,
            [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS, cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS],
        )
        if not cap.isOpened():
            cap.release()
            raise CameraError(f"Could not connect to {mask_url(url)}. Check the address, port, login and that the camera is on this network.")
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
            if self._fails > 3:
                raise CameraError("The stream stopped (camera off, network lost, or login rejected)")
            time.sleep(0.2)
            return None
        self._fails = 0
        return Frame(data=img, bit_depth=8)

    def info(self) -> dict[str, Any]:
        out: dict[str, Any] = {"model": self.params.get("name", "Network camera"), "bit_depth": 8}
        if self.cap is not None:
            out["sensor"] = f"{int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}"
        return out


class SnapshotCamera(CameraDriver):
    """A URL that returns one JPEG per request (many all-sky cameras and Pi cams)."""

    kind = "snapshot"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.interval = max(0.2, float(params.get("interval_s", 1.0)))
        self._opener: urllib.request.OpenerDirector | None = None
        self._last = 0.0
        self._fails = 0

    def open(self) -> None:
        url = str(self.params.get("url", ""))
        if not url:
            raise CameraError("No snapshot URL set for this camera")
        handlers: list[Any] = []
        user = self.params.get("username")
        if user:
            mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
            mgr.add_password(None, url, user, self.params.get("password") or "")
            handlers += [urllib.request.HTTPBasicAuthHandler(mgr), urllib.request.HTTPDigestAuthHandler(mgr)]
        self._opener = urllib.request.build_opener(*handlers)
        self._last = 0.0
        self._fetch()  # fail early so the user sees a clear error

    def close(self) -> None:
        self._opener = None

    def _fetch(self) -> np.ndarray:
        assert self._opener is not None
        try:
            with self._opener.open(str(self.params["url"]), timeout=8) as resp:
                raw = resp.read()
        except (urllib.error.URLError, OSError) as exc:
            raise CameraError(f"Could not fetch the snapshot: {exc}") from exc
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise CameraError("The URL did not return a JPEG/PNG image")
        return img

    def read(self) -> Frame | None:
        wait = self._last + self.interval - time.time()
        if wait > 0:
            time.sleep(min(wait, 0.25))
            if wait > 0.25:
                return None
        self._last = time.time()
        try:
            img = self._fetch()
        except CameraError:
            self._fails += 1
            if self._fails > 3:
                raise
            return None
        self._fails = 0
        return Frame(data=img, bit_depth=8)

    def controls(self) -> list[dict[str, Any]]:
        return [control("interval", "Refresh every", "range", self.interval, min=0.2, max=60, step=0.1, unit="s", log=True)]

    def set_control(self, name: str, value: Any) -> None:
        if name == "interval":
            self.interval = max(0.2, float(value))
        else:
            super().set_control(name, value)

    def info(self) -> dict[str, Any]:
        return {"model": self.params.get("name", "Snapshot camera"), "bit_depth": 8}
