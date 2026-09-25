"""ASCOM Alpaca cameras: the ASCOM camera API over plain HTTP, so it works from any machine
(NINA / ASCOM Remote / Alpaca simulators / many camera vendors' own Alpaca servers)."""

from __future__ import annotations

import json
import socket
import struct
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import numpy as np

from app.services.live.ascom_base import AscomCamera
from app.services.live.base import CameraError

DISCOVERY_PORT = 32227
DEFAULT_PORT = 11111
_CLIENT_ID = 4711

# ImageBytes element types (Alpaca API reference)
_ELEMENT_DTYPES = {1: "<i2", 2: "<i4", 3: "<f8", 4: "<f4", 5: "<u8", 6: "u1", 7: "<i2", 8: "<u2"}


def _request(base: str, method: str, path: str, params: dict[str, Any] | None = None, accept: str | None = None, timeout: float = 15.0) -> tuple[bytes, str]:
    url = f"{base}{path}"
    data = None
    query = {"ClientID": _CLIENT_ID, "ClientTransactionID": 1, **(params or {})}
    if method == "GET":
        url += "?" + urllib.parse.urlencode(query)
    else:
        data = urllib.parse.urlencode(query).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if accept:
        req.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except (urllib.error.URLError, OSError) as exc:
        raise CameraError(f"Could not reach the Alpaca server at {base}: {exc}") from exc


def _json(body: bytes) -> Any:
    try:
        msg = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise CameraError("The Alpaca server sent an unreadable reply") from exc
    if int(msg.get("ErrorNumber", 0)) != 0:
        raise CameraError(str(msg.get("ErrorMessage") or f"Alpaca error {msg['ErrorNumber']}"))
    return msg.get("Value")


def parse_imagebytes(body: bytes) -> np.ndarray:
    """Alpaca ImageBytes -> HxW array. The wire order is [x][y] (y fastest), so it is transposed."""
    if len(body) < 44:
        raise CameraError("The image reply from the camera is too short")
    (_ver, err, _cid, _sid, start, _elem, tx_type, rank, d1, d2, d3) = struct.unpack("<11i", body[:44])
    if err != 0:
        raise CameraError(body[start:].decode("utf-8", "replace") or f"Alpaca error {err}")
    dtype = _ELEMENT_DTYPES.get(tx_type)
    if dtype is None:
        raise CameraError(f"Unsupported image element type {tx_type}")
    arr = np.frombuffer(body, dtype=dtype, offset=start)
    if rank == 2:
        return np.ascontiguousarray(arr[: d1 * d2].reshape(d1, d2).T)
    if rank == 3:
        return np.ascontiguousarray(arr[: d1 * d2 * d3].reshape(d1, d2, d3).transpose(1, 0, 2)[:, :, ::-1])
    raise CameraError(f"Unsupported image rank {rank}")


class AlpacaCamera(AscomCamera):
    kind = "alpaca"

    def __init__(self, params: dict[str, Any]):
        super().__init__(params)
        host = str(params.get("host", "127.0.0.1")).strip()
        port = int(params.get("port") or DEFAULT_PORT)
        self.device = int(params.get("device", 0))
        self.base = f"http://{host}:{port}/api/v1/camera/{self.device}"

    def _connect(self) -> None:
        _request(self.base, "PUT", "/connected", {"Connected": "true"})
        # some servers need a moment before properties are readable
        _json(_request(self.base, "GET", "/connected")[0])

    def _disconnect(self) -> None:
        _request(self.base, "PUT", "/connected", {"Connected": "false"}, timeout=5)

    def _get(self, name: str) -> Any:
        return _json(_request(self.base, "GET", f"/{name}")[0])

    def _put(self, name: str, value: Any) -> None:
        key = {"binx": "BinX", "biny": "BinY", "startx": "StartX", "starty": "StartY", "numx": "NumX", "numy": "NumY", "gain": "Gain", "cooleron": "CoolerOn", "setccdtemperature": "SetCCDTemperature"}[name]
        val = str(value).lower() if isinstance(value, bool) else value
        _json(_request(self.base, "PUT", f"/{name}", {key: val})[0])

    def _start(self, duration: float, light: bool) -> None:
        _json(_request(self.base, "PUT", "/startexposure", {"Duration": duration, "Light": "true" if light else "false"})[0])

    def _abort(self) -> None:
        _request(self.base, "PUT", "/abortexposure", timeout=5)

    def _fetch(self) -> np.ndarray:
        body, ctype = _request(self.base, "GET", "/imagearray", accept="application/imagebytes", timeout=60)
        if "imagebytes" in ctype.lower():
            return parse_imagebytes(body)
        value = _json(body)  # server without ImageBytes: nested JSON lists [x][y]
        return np.asarray(value, dtype=np.int32).T


def discover(timeout: float = 1.5) -> list[dict[str, Any]]:
    """Alpaca servers announce themselves to a UDP broadcast; ask each for its cameras."""
    servers: set[tuple[str, int]] = {("127.0.0.1", DEFAULT_PORT)}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(timeout)
        sock.sendto(b"alpacadiscovery1", ("255.255.255.255", DISCOVERY_PORT))
        import time as _t

        end = _t.time() + timeout
        while _t.time() < end:
            try:
                data, addr = sock.recvfrom(1024)
                servers.add((addr[0], int(json.loads(data.decode()).get("AlpacaPort", DEFAULT_PORT))))
            except socket.timeout:
                break
            except (ValueError, OSError):
                continue
        sock.close()
    except OSError:
        pass
    found: list[dict[str, Any]] = []
    for host, port in sorted(servers):
        found.extend(probe(host, port, timeout=2.0))
    return found


def probe(host: str, port: int = DEFAULT_PORT, timeout: float = 4.0) -> list[dict[str, Any]]:
    """Cameras offered by the Alpaca server at host:port (empty if none / unreachable)."""
    base = f"http://{host}:{port}"
    try:
        devices = _json(_request(base, "GET", "/management/v1/configureddevices", timeout=timeout)[0]) or []
    except CameraError:
        return []
    out = []
    for d in devices:
        if str(d.get("DeviceType", "")).lower() == "camera":
            name = str(d.get("DeviceName") or "Alpaca camera")
            out.append(
                {
                    "kind": "alpaca",
                    "name": name,
                    "note": f"Alpaca camera at {host}:{port}",
                    "params": {"host": host, "port": port, "device": int(d.get("DeviceNumber", 0)), "name": name},
                }
            )
    return out
