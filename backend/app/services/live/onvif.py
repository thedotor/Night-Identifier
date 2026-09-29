"""ONVIF: finding IP cameras on the network and asking one for its RTSP stream addresses.

ONVIF is the standard most IP / security cameras speak for setup. It is used here only to *find* the
camera and learn its stream URL; the video itself is then read as ordinary RTSP (network.py).

* discover(): WS-Discovery, a UDP multicast "who is an ONVIF camera?" probe.
* streams(): asks the camera (SOAP over HTTP, with the standard WS-Security login) for its media
  profiles and the RTSP URI of each."""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import re
import socket
import struct
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import unquote, urlsplit

from defusedxml.ElementTree import fromstring as safe_fromstring  # replies come from the LAN / the internet: no entity tricks

from app.services.live.base import CameraError

WS_DISCOVERY = ("239.255.255.250", 3702)
NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "d": "http://schemas.xmlsoap.org/ws/2005/04/discovery",
    "a": "http://schemas.xmlsoap.org/ws/2004/08/addressing",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}

_PROBE = """<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:{mid}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>"""


def parse_probe_matches(data: bytes) -> list[dict[str, Any]]:
    """Cameras named in one WS-Discovery reply."""
    try:
        root = safe_fromstring(data)
    except ET.ParseError:
        return []
    out = []
    for match in root.iter(f"{{{NS['d']}}}ProbeMatch"):
        xaddrs = (match.findtext("d:XAddrs", "", NS) or "").split()
        scopes = (match.findtext("d:Scopes", "", NS) or "").split()
        http = next((x for x in xaddrs if x.startswith("http")), None)
        if not http:
            continue
        u = urlsplit(http)
        host = u.hostname or ""
        info = {s.rsplit("/", 2)[-2]: unquote(s.rsplit("/", 1)[-1]) for s in scopes if "onvif.org/" in s and s.count("/") >= 4}
        label = " ".join(x for x in (info.get("hardware"), info.get("name")) if x) or "IP camera"
        out.append(
            {
                "kind": "onvif",
                "name": f"{label} ({host})",
                "note": "IP camera found by ONVIF. Enter its login to connect.",
                "params": {"host": host, "port": u.port or 80},
            }
        )
    return out


def discover(timeout: float = 2.0) -> list[dict[str, Any]]:
    """ONVIF cameras that answer a multicast probe."""
    found: dict[str, dict[str, Any]] = {}
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, struct.pack("b", 2))
        sock.settimeout(0.5)
        sock.sendto(_PROBE.format(mid=uuid.uuid4()).encode(), WS_DISCOVERY)
    except OSError:
        return []
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, _addr = sock.recvfrom(65535)
        except socket.timeout:
            continue
        except OSError:
            break
        for cam in parse_probe_matches(data):
            found[cam["params"]["host"]] = cam
    sock.close()
    return list(found.values())


# ---- SOAP client ------------------------------------------------------------------------------


def _security_header(user: str, password: str, offset: dt.timedelta) -> str:
    nonce = os.urandom(16)
    created = (dt.datetime.now(dt.timezone.utc) + offset).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    # ONVIF's WS-UsernameToken mandates SHA-1 here
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + password.encode(), usedforsecurity=False).digest()).decode()
    return (
        '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
        f'<UsernameToken><Username>{_esc(user)}</Username>'
        '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f"{digest}</Password>"
        '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f'{base64.b64encode(nonce).decode()}</Nonce>'
        '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        f"{created}</Created></UsernameToken></Security></s:Header>"
    )


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _call(url: str, body: str, user: str | None = None, password: str | None = None, offset: dt.timedelta = dt.timedelta(0)) -> ET.Element:
    header = _security_header(user, password or "", offset) if user else ""
    envelope = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
        f"{header}<s:Body>{body}</s:Body></s:Envelope>"
    )
    req = urllib.request.Request(url, data=envelope.encode(), headers={"Content-Type": "application/soap+xml; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            raise CameraError("The camera rejected the login. Check the username and password (ONVIF often needs a separate ONVIF user).") from exc
        raise CameraError(f"The camera answered with an error ({exc.code})") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise CameraError(f"Could not reach the camera at {url}: {exc}") from exc
    try:
        root = safe_fromstring(data)
    except ET.ParseError as exc:
        raise CameraError("The camera sent a reply that is not ONVIF") from exc
    fault = root.find(".//s:Fault", NS)
    if fault is not None:
        reason = "".join(fault.itertext()).strip()
        if re.search(r"auth|sender not authorized", reason, re.I):
            raise CameraError("The camera rejected the login. Check the username and password.")
        raise CameraError(f"The camera reported an error: {reason[:160]}")
    return root


def _clock_offset(device_url: str) -> dt.timedelta:
    """Cameras reject logins whose timestamp is far from their own clock, so match it."""
    try:
        root = _call(device_url, "<tds:GetSystemDateAndTime/>")
        t = root.find(".//tt:UTCDateTime", NS)
        if t is None:
            return dt.timedelta(0)
        d, tm = t.find("tt:Date", NS), t.find("tt:Time", NS)
        cam = dt.datetime(
            int(d.findtext("tt:Year", "1970", NS)), int(d.findtext("tt:Month", "1", NS)), int(d.findtext("tt:Day", "1", NS)),
            int(tm.findtext("tt:Hour", "0", NS)), int(tm.findtext("tt:Minute", "0", NS)), int(tm.findtext("tt:Second", "0", NS)),
            tzinfo=dt.timezone.utc,
        )
        return cam - dt.datetime.now(dt.timezone.utc)
    except (CameraError, AttributeError, ValueError):
        return dt.timedelta(0)


def streams(host: str, port: int = 80, user: str | None = None, password: str | None = None) -> list[dict[str, Any]]:
    """The camera's video profiles, each with its RTSP address: [{name, uri, width, height, encoding}]."""
    device_url = f"http://{host}:{port}/onvif/device_service"
    offset = _clock_offset(device_url)
    caps = _call(device_url, "<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>", user, password, offset)
    media_url = caps.findtext(".//tt:Media/tt:XAddr", None, NS) or f"http://{host}:{port}/onvif/media_service"
    # cameras often report their internal address; use the one we actually reached
    mu = urlsplit(media_url)
    if mu.hostname != host:
        media_url = f"http://{host}:{mu.port or port}{mu.path}"
    profiles = _call(media_url, "<trt:GetProfiles/>", user, password, offset)
    out = []
    for p in profiles.iter(f"{{{NS['trt']}}}Profiles"):
        token = p.get("token")
        if not token:
            continue
        if p.find("tt:VideoEncoderConfiguration", NS) is None:
            continue  # audio-only or metadata profile
        uri_reply = _call(
            media_url,
            "<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>"
            f"<trt:ProfileToken>{_esc(token)}</trt:ProfileToken></trt:GetStreamUri>",
            user,
            password,
            offset,
        )
        uri = uri_reply.findtext(".//tt:Uri", None, NS)
        if not uri:
            continue
        res = p.find("tt:VideoEncoderConfiguration/tt:Resolution", NS)
        # the address may name the camera's internal IP; keep the path but use the host we reached
        su = urlsplit(uri)
        if su.hostname and su.hostname != host:
            uri = uri.replace(su.hostname, host, 1)
        out.append(
            {
                "name": p.findtext("tt:Name", token, NS),
                "uri": uri,
                "width": int(res.findtext("tt:Width", "0", NS)) if res is not None else 0,
                "height": int(res.findtext("tt:Height", "0", NS)) if res is not None else 0,
                "encoding": p.findtext("tt:VideoEncoderConfiguration/tt:Encoding", "", NS),
            }
        )
    if not out:
        raise CameraError("The camera did not offer any video streams")
    return out
