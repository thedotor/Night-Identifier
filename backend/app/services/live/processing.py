"""Pixel work for Live View: debayer, stretch, histogram, focus metrics, JPEG encode.

Everything here works on numpy arrays and is safe to call from any thread."""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from app.services.live.base import Frame

_BAYER_CODES = {
    "RGGB": cv2.COLOR_BAYER_BG2BGR,  # OpenCV names the pattern by the pixel at (1,1)
    "BGGR": cv2.COLOR_BAYER_RG2BGR,
    "GRBG": cv2.COLOR_BAYER_GB2BGR,
    "GBRG": cv2.COLOR_BAYER_GR2BGR,
}

DEFAULT_STRETCH: dict[str, Any] = {"mode": "auto", "black": 0.0, "white": 1.0, "mid": 0.5}


def debayer(frame: Frame) -> np.ndarray:
    """Colour image (BGR) for a raw-bayer frame; other frames are returned unchanged."""
    if frame.bayer and frame.data.ndim == 2:
        code = _BAYER_CODES.get(frame.bayer.upper())
        if code is not None:
            return cv2.cvtColor(frame.data, code)
    return frame.data


def _resize_to_width(img: np.ndarray, width: int | None) -> np.ndarray:
    if not width or img.shape[1] <= width:
        return img
    scale = width / img.shape[1]
    return cv2.resize(img, (width, max(1, round(img.shape[0] * scale))), interpolation=cv2.INTER_AREA)


def _mtf(m: float, x: np.ndarray) -> np.ndarray:
    """Midtones transfer function (PixInsight's): maps 0->0, m->0.5, 1->1."""
    return ((m - 1.0) * x) / (((2.0 * m - 1.0) * x) - m)


def _luma(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else img.mean(axis=2)


def stretch_params(unit: np.ndarray, target: float = 0.25, clip: float = -2.8) -> tuple[float, float]:
    """Auto-stretch black point and midtones balance for a 0..1 float image."""
    luma = _luma(unit)
    sample = luma[:: max(1, luma.shape[0] // 256), :: max(1, luma.shape[1] // 256)]
    med = float(np.median(sample))
    mad = float(np.median(np.abs(sample - med))) * 1.4826
    black = float(np.clip(med + clip * mad, 0.0, 1.0))
    med_shifted = max(med - black, 1e-6)
    if med_shifted >= 1.0:
        return black, 0.5
    m = float(_mtf(target, np.array(med_shifted)))
    return black, float(np.clip(m, 1e-4, 0.9999))


def to_display(frame: Frame, width: int | None = None, stretch: dict[str, Any] | None = None) -> np.ndarray:
    """An 8-bit BGR/gray image ready to JPEG-encode, at most `width` wide, stretched."""
    # No explicit choice: webcams and IP cameras arrive display-ready (8-bit); deep-sky sensors
    # need the auto-stretch or the picture looks black.
    spec = stretch or ({"mode": "auto"} if frame.bit_depth > 8 else {"mode": "off"})
    img = _resize_to_width(debayer(frame), width)
    mode = spec.get("mode", "auto")
    unit = img.astype(np.float32) / float(frame.max_value)
    if mode == "off":
        out = unit
    elif mode == "manual":
        b = float(spec.get("black", 0.0))
        w = max(float(spec.get("white", 1.0)), b + 1e-4)
        mid = float(np.clip(spec.get("mid", 0.5), 0.01, 0.99))
        out = np.clip((unit - b) / (w - b), 0.0, 1.0)
        if abs(mid - 0.5) > 1e-3:
            out = _mtf(mid, out)
    else:
        # 8-bit sources that already look right (webcams) are left alone if they are well exposed
        black, mid = stretch_params(unit)
        out = np.clip((unit - black) / max(1.0 - black, 1e-6), 0.0, 1.0)
        out = _mtf(mid, out)
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)


def histogram(frame: Frame, bins: int = 128) -> dict[str, Any]:
    """Luminance histogram of the raw data (not the stretched image) plus clip statistics."""
    luma = _luma(_resize_to_width(debayer(frame), 640)).astype(np.float32) / float(frame.max_value)
    counts, _ = np.histogram(luma, bins=bins, range=(0.0, 1.0))
    total = max(int(counts.sum()), 1)
    return {
        "bins": (counts / counts.max()).round(4).tolist() if counts.max() else [0] * bins,
        "median": round(float(np.median(luma)), 5),
        "max": round(float(luma.max()), 5),
        "clipped": round(float((luma >= 0.995).sum()) / luma.size * 100.0, 3),
        "black": round(float((luma <= 0.0).sum()) / total * 100.0, 3),
    }


def focus_metrics(frame: Frame) -> dict[str, Any]:
    """Star-based FWHM (pixels) when stars are present, otherwise just a sharpness score."""
    gray = _luma(debayer(frame)).astype(np.float32)
    h, w = gray.shape
    # central crop keeps the cost bounded on large sensors
    cy, cx = h // 2, w // 2
    half = 512
    gray = gray[max(0, cy - half) : cy + half, max(0, cx - half) : cx + half]
    unit = gray / float(frame.max_value)
    small = cv2.resize(unit, (unit.shape[1] // 2 or 1, unit.shape[0] // 2 or 1), interpolation=cv2.INTER_AREA)
    lap = float(cv2.Laplacian(small, cv2.CV_32F).var())
    sharp = round(lap * 1e4, 3)

    # A light blur lifts faint and defocused stars above the noise; its width is removed again
    # from the measured spread so the FWHM is not inflated.
    blur = 1.5
    smooth = cv2.GaussianBlur(unit, (0, 0), blur)
    bg = float(np.median(smooth))
    sigma = float(np.median(np.abs(smooth - bg))) * 1.4826
    if sigma <= 0:
        return {"fwhm": None, "stars": 0, "sharp": sharp}
    mask = (smooth > bg + 4.0 * sigma).astype(np.uint8)
    n, _labels, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cands = []
    ph, pw = unit.shape
    r = 16
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < 3 or area > 3000:
            continue
        x, y = cents[i]
        if x < r + 1 or y < r + 1 or x > pw - r - 2 or y > ph - r - 2:
            continue
        peak = float(smooth[int(y), int(x)])
        if unit[int(y), int(x)] >= 0.97:  # saturated cores measure too wide
            continue
        cands.append((peak, x, y))
    cands.sort(reverse=True)
    fwhms = []
    gy, gx = np.mgrid[-r : r + 1, -r : r + 1]
    for _peak, x, y in cands[:30]:
        xi, yi = int(round(x)), int(round(y))
        patch = smooth[yi - r : yi + r + 1, xi - r : xi + r + 1] - bg
        patch = np.where(patch > 2.0 * sigma, patch, 0.0)
        flux = float(patch.sum())
        if flux <= 0:
            continue
        mx = float((patch * gx).sum() / flux)
        my = float((patch * gy).sum() / flux)
        var = float((patch * ((gx - mx) ** 2 + (gy - my) ** 2)).sum() / flux) / 2.0 - blur * blur
        if var > 0:
            fwhms.append(2.3548 * np.sqrt(var))
    if not fwhms:
        return {"fwhm": None, "stars": len(cands), "sharp": sharp}
    return {"fwhm": round(float(np.median(fwhms)), 2), "stars": len(cands), "sharp": sharp}


def encode_jpeg(img: np.ndarray, quality: int = 80) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes()
