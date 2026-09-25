"""INDI cameras over the network (StellarMate, a Raspberry Pi running indiserver, KStars/Ekos hosts).

A small, self-contained INDI client: XML over TCP (port 7624). Exposures are taken with
CCD_EXPOSURE and the picture comes back as a FITS BLOB. Note: ZWO's ASIAir speaks its own private
protocol, not INDI, so it cannot be used here."""

from __future__ import annotations

import base64
import socket
import time
import xml.etree.ElementTree as ET
import zlib
from typing import Any

import numpy as np

from app.services import fits_io
from app.services.live.base import CameraDriver, CameraError, Frame, control

DEFAULT_PORT = 7624


class IndiConnection:
    """Blocking INDI session: send XML, pump the socket, keep the latest property values."""

    def __init__(self, host: str, port: int):
        try:
            self.sock = socket.create_connection((host, port), timeout=6)
        except OSError as exc:
            raise CameraError(f"Could not connect to the INDI server at {host}:{port}: {exc}") from exc
        self.parser = ET.XMLPullParser(events=("start", "end"))
        self.parser.feed(b"<stream>")
        self.depth = 0
        self.props: dict[tuple[str, str], dict[str, Any]] = {}
        self.blob: dict[str, Any] | None = None
        self.messages: list[str] = []

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, xml: str) -> None:
        try:
            self.sock.sendall(xml.encode("utf-8"))
        except OSError as exc:
            raise CameraError(f"The INDI connection was lost: {exc}") from exc

    def pump(self, timeout: float) -> bool:
        """Read what has arrived (waiting up to `timeout`), update state. False if nothing came."""
        self.sock.settimeout(max(timeout, 0.01))
        try:
            data = self.sock.recv(1 << 20)
        except socket.timeout:
            return False
        except OSError as exc:
            raise CameraError(f"The INDI connection was lost: {exc}") from exc
        if not data:
            raise CameraError("The INDI server closed the connection")
        self.parser.feed(data)
        for event, elem in self.parser.read_events():
            if event == "start":
                self.depth += 1
            else:
                self.depth -= 1
                if self.depth == 1:  # a complete top-level message
                    self._handle(elem)
                    elem.clear()
        return True

    def wait_for(self, cond, timeout: float) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            self.pump(min(0.5, end - time.time()))
        return cond()

    # ---- message handling ---------------------------------------------------------------
    def _handle(self, e: ET.Element) -> None:
        tag = e.tag
        dev, name = e.get("device", ""), e.get("name", "")
        if tag == "message":
            self.messages.append(e.get("message", ""))
            self.messages = self.messages[-20:]
        elif tag == "delProperty":
            self.props.pop((dev, name), None)
        elif tag.startswith("def") or tag.startswith("set"):
            kind = tag[3:-6].lower()  # defNumberVector -> number
            prop = self.props.setdefault((dev, name), {"kind": kind, "values": {}, "limits": {}, "state": "Idle"})
            prop["state"] = e.get("state", prop["state"])
            for child in e:
                cname = child.get("name", "")
                text = (child.text or "").strip()
                if kind == "number":
                    try:
                        prop["values"][cname] = float(text)
                    except ValueError:
                        continue
                    if tag.startswith("def"):
                        try:
                            prop["limits"][cname] = (float(child.get("min", 0)), float(child.get("max", 0)), float(child.get("step", 0) or 0))
                        except ValueError:
                            pass
                elif kind == "switch":
                    prop["values"][cname] = text == "On"
                elif kind == "text":
                    prop["values"][cname] = text
                elif kind == "blob" and tag.startswith("set"):
                    self.blob = {"device": dev, "name": name, "format": child.get("format", ""), "data": text}
        # anything else (defLight etc.) is ignored

    # ---- helpers ------------------------------------------------------------------------
    def value(self, dev: str, name: str, elem: str, default: Any = None) -> Any:
        return self.props.get((dev, name), {}).get("values", {}).get(elem, default)

    def limits(self, dev: str, name: str, elem: str) -> tuple[float, float, float] | None:
        return self.props.get((dev, name), {}).get("limits", {}).get(elem)

    def camera_devices(self) -> list[str]:
        """Devices that are cameras: their DRIVER_INFO interface has the CCD bit (2), or they already
        show camera properties (a device only defines CCD_EXPOSURE once it is connected)."""
        found: list[str] = []
        for (dev, name), prop in self.props.items():
            if name == "DRIVER_INFO":
                try:
                    if int(str(prop["values"].get("DRIVER_INTERFACE", "0")).strip() or 0) & 2:
                        found.append(dev)
                except ValueError:
                    pass
            elif name in ("CCD_EXPOSURE", "CCD_INFO") and dev not in found:
                found.append(dev)
        return sorted(set(found))

    def has(self, dev: str, name: str) -> bool:
        return (dev, name) in self.props

    def set_number(self, dev: str, name: str, values: dict[str, float]) -> None:
        body = "".join(f'<oneNumber name="{k}">{v}</oneNumber>' for k, v in values.items())
        self.send(f'<newNumberVector device="{dev}" name="{name}">{body}</newNumberVector>')

    def set_switch(self, dev: str, name: str, on: str) -> None:
        self.send(f'<newSwitchVector device="{dev}" name="{name}"><oneSwitch name="{on}">On</oneSwitch></newSwitchVector>')


def probe(host: str, port: int = DEFAULT_PORT, timeout: float = 4.0) -> list[dict[str, Any]]:
    """Camera devices on an INDI server (those that define CCD_EXPOSURE)."""
    try:
        conn = IndiConnection(host, port)
    except CameraError:
        return []
    try:
        conn.send('<getProperties version="1.7"/>')
        end = time.time() + timeout
        while time.time() < end:
            try:
                conn.pump(0.4)
            except CameraError:
                break
        names = conn.camera_devices()
        return [
            {"kind": "indi", "name": d, "note": f"INDI camera at {host}:{port}", "params": {"host": host, "port": port, "device": d, "name": d}}
            for d in names
        ]
    finally:
        conn.close()


class IndiCamera(CameraDriver):
    kind = "indi"
    is_astro = True

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        self.conn: IndiConnection | None = None
        self.dev = str(params.get("device", ""))
        self.exposure = float(params.get("exposure_s", 1.0))
        self.exp_limits = (0.001, 600.0)
        self.gain_limits: tuple[float, float] | None = None
        self.max_bin = 1
        self.binning = 1
        self.has_cooler = False
        self.model = str(params.get("name") or self.dev or "INDI camera")

    def open(self) -> None:
        host, port = str(self.params.get("host", "")), int(self.params.get("port") or DEFAULT_PORT)
        conn = IndiConnection(host, port)
        self.conn = conn
        conn.send('<getProperties version="1.7"/>')
        if not self.dev:
            conn.wait_for(lambda: bool(conn.camera_devices()), 6)
            cams = conn.camera_devices()
            if not cams:
                raise CameraError("No camera was found on that INDI server")
            self.dev = cams[0]
        dev = self.dev
        conn.wait_for(lambda: conn.has(dev, "CONNECTION"), 8)
        if not conn.has(dev, "CONNECTION"):
            raise CameraError(f"The INDI server has no device called '{dev}'")
        if not conn.value(dev, "CONNECTION", "CONNECT", False):
            conn.set_switch(dev, "CONNECTION", "CONNECT")
        if not conn.wait_for(lambda: conn.has(dev, "CCD_EXPOSURE"), 20):
            raise CameraError(f"'{dev}' did not come online. Is the camera powered and plugged into the INDI computer?")
        # pictures must come to us, as FITS
        conn.send(f'<enableBLOB device="{dev}">Also</enableBLOB>')
        if conn.has(dev, "UPLOAD_MODE"):
            conn.set_switch(dev, "UPLOAD_MODE", "UPLOAD_CLIENT")
        if conn.has(dev, "CCD_TRANSFER_FORMAT"):
            conn.set_switch(dev, "CCD_TRANSFER_FORMAT", "FORMAT_FITS")
        conn.pump(0.3)
        lim = conn.limits(dev, "CCD_EXPOSURE", "CCD_EXPOSURE_VALUE")
        if lim:
            self.exp_limits = (max(lim[0], 0.0005), lim[1] or 600.0)
        self.exposure = min(max(self.exposure, self.exp_limits[0]), self.exp_limits[1])
        g = conn.limits(dev, "CCD_GAIN", "GAIN")
        if g and g[1] > g[0]:
            self.gain_limits = (g[0], g[1])
        b = conn.limits(dev, "CCD_BINNING", "HOR_BIN")
        if b:
            self.max_bin = max(1, int(b[1]))
        self.has_cooler = conn.has(dev, "CCD_COOLER") and conn.has(dev, "CCD_TEMPERATURE")

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None

    def read(self) -> Frame | None:
        conn = self.conn
        if conn is None:
            raise CameraError("Camera is closed")
        conn.blob = None
        conn.set_number(self.dev, "CCD_EXPOSURE", {"CCD_EXPOSURE_VALUE": self.exposure})
        if not conn.wait_for(lambda: conn.blob is not None, self.exposure + 60):
            raise CameraError("The INDI camera did not send a picture in time" + (f" ({conn.messages[-1]})" if conn.messages else ""))
        blob = conn.blob or {}
        raw = base64.b64decode(blob["data"])
        fmt = str(blob.get("format", "")).lower()
        if fmt.endswith(".z"):
            raw = zlib.decompress(raw)
            fmt = fmt[:-2]
        if "fit" not in fmt:
            raise CameraError(f"The INDI camera sent '{fmt or 'an unknown format'}'. Set its transfer format to FITS in the INDI control panel.")
        try:
            data, header = fits_io.read_fits_bytes(raw)
        except ValueError as exc:
            raise CameraError(f"The INDI picture could not be read: {exc}") from exc
        bayer = str(header.get("BAYERPAT", "")).strip().upper() or None
        depth = 8 if data.dtype == np.uint8 else 16
        meta: dict[str, Any] = {"binning": self.binning}
        temp = conn.value(self.dev, "CCD_TEMPERATURE", "CCD_TEMPERATURE_VALUE")
        if temp is not None:
            meta["temperature"] = temp
        gain = conn.value(self.dev, "CCD_GAIN", "GAIN")
        if gain is not None:
            meta["gain"] = gain
        return Frame(data=data, bit_depth=depth, bayer=bayer if data.ndim == 2 else None, exposure_s=self.exposure, meta=meta)

    def controls(self) -> list[dict[str, Any]]:
        conn = self.conn
        out = [control("exposure", "Exposure", "range", self.exposure, min=self.exp_limits[0], max=min(self.exp_limits[1], 600.0), step=0.001, unit="s", log=True)]
        if conn is None:
            return out
        if self.gain_limits:
            out.append(control("gain", "Gain", "range", conn.value(self.dev, "CCD_GAIN", "GAIN", self.gain_limits[0]), min=self.gain_limits[0], max=self.gain_limits[1], step=1))
        if self.max_bin > 1:
            out.append(control("binning", "Binning", "choice", str(self.binning), choices=[str(b) for b in range(1, min(self.max_bin, 4) + 1)]))
        if self.has_cooler:
            out.append(control("cooler", "Cooler", "toggle", bool(conn.value(self.dev, "CCD_COOLER", "COOLER_ON", False)), group="cooling"))
            out.append(control("target_temp", "Target temperature", "range", conn.value(self.dev, "CCD_TEMPERATURE", "CCD_TEMPERATURE_VALUE", 0.0), min=-40, max=30, step=1, unit="°C", group="cooling"))
        return out

    def set_control(self, name: str, value: Any) -> None:
        conn = self.conn
        if conn is None:
            raise CameraError("Camera is closed")
        if name == "exposure":
            self.exposure = min(max(float(value), self.exp_limits[0]), self.exp_limits[1])
        elif name == "gain" and self.gain_limits:
            conn.set_number(self.dev, "CCD_GAIN", {"GAIN": float(value)})
        elif name == "binning":
            self.binning = int(value)
            conn.set_number(self.dev, "CCD_BINNING", {"HOR_BIN": self.binning, "VER_BIN": self.binning})
        elif name == "cooler" and self.has_cooler:
            conn.set_switch(self.dev, "CCD_COOLER", "COOLER_ON" if value else "COOLER_OFF")
        elif name == "target_temp" and self.has_cooler:
            conn.set_number(self.dev, "CCD_TEMPERATURE", {"CCD_TEMPERATURE_VALUE": float(value)})
        else:
            super().set_control(name, value)
        conn.pump(0.05)

    def info(self) -> dict[str, Any]:
        conn = self.conn
        sensor = ""
        if conn is not None:
            w = conn.value(self.dev, "CCD_INFO", "CCD_MAX_X")
            h = conn.value(self.dev, "CCD_INFO", "CCD_MAX_Y")
            if w and h:
                sensor = f"{int(w)}x{int(h)}"
        return {"model": self.model, "sensor": sensor, "bit_depth": 16}
