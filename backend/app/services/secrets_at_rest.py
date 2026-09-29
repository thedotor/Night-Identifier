"""Encrypts camera logins in the saved config with Windows DPAPI (tied to the signed-in Windows user).

A stored value looks like "dpapi:<base64>". Anything else is treated as plain text (files written by
older versions), and gets encrypted the next time the file is saved. Where DPAPI isn't available the
value is stored as it was given. If a value can't be decrypted (the data folder was copied to another
PC or user account), it reads back as empty and the login has to be typed in again.
"""

from __future__ import annotations

import base64
import ctypes
import sys
from ctypes import POINTER, byref, c_void_p, c_wchar_p
from ctypes import wintypes

PREFIX = "dpapi:"
_ENTROPY = b"night-identifier/camera-login"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_Blob, ctypes.Array]:
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, POINTER(ctypes.c_char))), buf


def available() -> bool:
    return sys.platform == "win32"


def _call(fn_name: str, data: bytes, entropy: bytes = _ENTROPY, label: str = "Night Identifier camera login") -> bytes | None:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, _keep = _blob(data)
    ent, _keep2 = _blob(entropy)
    out = _Blob()
    fn = getattr(crypt32, fn_name)
    description = c_wchar_p(label) if fn_name == "CryptProtectData" else None
    ok = fn(byref(src), description, byref(ent), None, None, 0, byref(out))
    if not ok:
        return None
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(c_void_p(ctypes.cast(out.pbData, c_void_p).value))


def protect_bytes(data: bytes, purpose: str) -> bytes | None:
    """`data` encrypted for this Windows user, or None where DPAPI is unavailable or fails. `purpose` keys the encryption
    (a blob made for one purpose cannot be opened as another)."""
    if not available():
        return None
    return _call("CryptProtectData", data, b"night-identifier/" + purpose.encode(), "Night Identifier " + purpose)


def unprotect_bytes(blob: bytes, purpose: str) -> bytes | None:
    """The plain bytes of `protect_bytes` output, or None if it cannot be opened (another PC or user, or damaged)."""
    if not available():
        return None
    try:
        return _call("CryptUnprotectData", blob, b"night-identifier/" + purpose.encode())
    except OSError:
        return None


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt(value: str) -> str:
    """The value as stored on disk. Empty and already-encrypted values are left as they are."""
    if not value or is_encrypted(value) or not available():
        return value
    blob = _call("CryptProtectData", value.encode("utf-8"))
    return PREFIX + base64.b64encode(blob).decode("ascii") if blob is not None else value


def decrypt(value: str) -> str:
    """The plain text of a stored value ('' when it can't be decrypted on this PC/account)."""
    if not is_encrypted(value):
        return value
    if not available():
        return ""
    try:
        blob = _call("CryptUnprotectData", base64.b64decode(value[len(PREFIX):]))
    except (ValueError, OSError):
        return ""
    return blob.decode("utf-8", errors="replace") if blob is not None else ""
