from pathlib import Path

import cv2
import numpy as np

from app.services.image_processing import is_raw

MAX_STARS = 60
MIN_BLOB_AREA = 1
MAX_BLOB_AREA = 400
# A saturated/bright star's halo or diffraction spikes routinely fragment
# into several separate connected components under simple thresholding.
# Left alone, that turns one real star into a tight cluster of a dozen
# near-duplicate "stars" a few pixels apart -- confirmed on a real
# astrophotograph, where a blown-out star produced 13 spurious points inside
# a ~50x20px patch. Their tiny mutual separations create degenerate,
# essentially-random micro-triangles that satisfy the scale-invariant
# triangle-signature check for almost any constellation shape by coincidence,
# so they must be merged before matching, not just before display.
DEDUP_RADIUS_PX = 22

# Target working resolution for blob detection, matching the JPEG preview's
# own cap (image_processing.MAX_PREVIEW_DIMENSION) so DEDUP_RADIUS_PX,
# MIN/MAX_BLOB_AREA etc. stay calibrated at one consistent pixel scale
# regardless of which path produced the candidates.
_WORK_DIMENSION = 2200


def detect_stars(
    preview_path: Path,
    max_stars: int = MAX_STARS,
    target_size: tuple[int, int] | None = None,
    source_path: Path | None = None,
) -> list[tuple[float, float, float]]:
    """Detect bright point sources (stars) in an image via simple thresholding
    + connected-component blob detection -- adequate for star fields, which
    are small bright dots on a dark background (unlike general photometry,
    we don't need PSF fitting for this app's pattern-matching purpose).

    When source_path is a camera RAW file, detection instead runs on the RAW
    sensor data itself (see _detect_stars_raw) rather than the JPEG preview.
    The preview is only an 8-bit, already-clipped rendering of what the
    sensor actually captured, and that clipping is exactly what made a real
    star indistinguishable from a saturated foreground light on a real
    photo: both just read as flat white. The RAW file's much wider dynamic
    range (12-14 bit) preserves that distinction. Falls back to the JPEG
    preview when there's no RAW file (already-compressed JPEG/PNG/TIFF
    sources have no extra headroom to recover this way).

    Detection runs on a (possibly downscaled) working image, but annotations
    and the frontend canvas both work in the original full-resolution pixel
    space. target_size=(orig_width, orig_height) rescales the returned
    coordinates into that space so points land where the stars actually are.

    Returns (x, y, brightness) tuples, brightest first.
    """
    if source_path is not None and is_raw(source_path):
        result = _detect_stars_raw(source_path, max_stars=max_stars, target_size=target_size)
        if result is not None:
            return result

    img = cv2.imread(str(preview_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    return detect_stars_gray(img, max_stars=max_stars, target_size=target_size)


def detect_stars_gray(
    img: np.ndarray,
    max_stars: int = MAX_STARS,
    target_size: tuple[int, int] | None = None,
) -> list[tuple[float, float, float]]:
    """detect_stars for an 8-bit grayscale array (e.g. a live camera frame) instead of a file.
    target_size=(width, height) rescales the returned coordinates to that pixel space."""
    median = float(np.median(img))
    std = float(np.std(img))
    threshold = min(250.0, median + max(15.0, 3.5 * std))
    _, binary = cv2.threshold(img, threshold, 255, cv2.THRESH_BINARY)

    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    scale_x, scale_y = 1.0, 1.0
    if target_size is not None:
        preview_h, preview_w = img.shape[:2]
        target_w, target_h = target_size
        if preview_w > 0 and preview_h > 0:
            scale_x = target_w / preview_w
            scale_y = target_h / preview_h

    candidates: list[tuple[float, float, float]] = []
    for i in range(1, num_labels):  # label 0 is background
        area = stats[i, cv2.CC_STAT_AREA]
        if area < MIN_BLOB_AREA or area > MAX_BLOB_AREA:
            continue
        cx, cy = centroids[i]
        brightness = float(img[labels == i].sum())
        candidates.append((float(cx), float(cy), brightness))

    candidates.sort(key=lambda c: -c[2])

    deduped: list[tuple[float, float, float]] = []
    for cx, cy, brightness in candidates:
        if any(
            (cx - kx) ** 2 + (cy - ky) ** 2 < DEDUP_RADIUS_PX**2 for kx, ky, _ in deduped
        ):
            continue
        deduped.append((cx, cy, brightness))

    return [(cx * scale_x, cy * scale_y, b) for cx, cy, b in deduped[:max_stars]]


def _block_reduce(img: np.ndarray, factor: int, reducer: str) -> np.ndarray:
    """Downsample by factor x factor blocks using either 'max' (so a small
    bright point isn't averaged away -- a plain resize would blur a single
    saturated star pixel into a dim smear indistinguishable from noise) or
    'mean' (for color, where preserving one channel's peak pixel over
    another's would bias the color reading). Crops to a clean multiple of
    factor first so every caller downsampling the same source image ends up
    with identically-shaped, aligned outputs."""
    if factor <= 1:
        return img
    h, w = img.shape[:2]
    h_crop, w_crop = (h // factor) * factor, (w // factor) * factor
    cropped = img[:h_crop, :w_crop]
    if cropped.ndim == 2:
        reshaped = cropped.reshape(h_crop // factor, factor, w_crop // factor, factor)
        axis = (1, 3)
    else:
        c = cropped.shape[2]
        reshaped = cropped.reshape(h_crop // factor, factor, w_crop // factor, factor, c)
        axis = (1, 3)
    return reshaped.max(axis=axis) if reducer == "max" else reshaped.mean(axis=axis)


def _classify_candidates_raw(
    candidates: list[tuple[float, float, float, int, float]], rgb16: np.ndarray, factor: int
) -> np.ndarray | None:
    """Score each candidate's likelihood of being a real star using the
    trained classifier, if one exists (app/services/star_classifier.py).
    Patches are cropped from the full-resolution RAW data (mapping each
    candidate's downsampled centroid back up by `factor`) so inference sees
    the same resolution/detail the classifier was trained on. Returns None
    -- not just an empty array -- when no model is trained yet, so callers
    can tell "no opinion" apart from "scored everything at 0"."""
    from app.services.star_classifier import PATCH_SIZE, crop_patch, get_inference_model, predict_star_probabilities

    model = get_inference_model()
    if model is None or not candidates:
        return None

    full_luma = rgb16.max(axis=2).astype(np.float32) / 65535.0
    patches = []
    valid_idx = []
    for i, (cx, cy, *_rest) in enumerate(candidates):
        patch = crop_patch(full_luma, cx * factor, cy * factor, PATCH_SIZE)
        if patch is None:
            continue
        patches.append(patch)
        valid_idx.append(i)

    if not patches:
        return None

    probs = predict_star_probabilities(model, np.array(patches, dtype=np.float32))
    scores = np.zeros(len(candidates), dtype=np.float32)
    for idx, prob in zip(valid_idx, probs):
        scores[idx] = prob
    return scores


def _detect_stars_raw(
    source_path: Path, max_stars: int, target_size: tuple[int, int] | None
) -> list[tuple[float, float, float]] | None:
    try:
        import rawpy

        with rawpy.imread(str(source_path)) as raw:
            # no_auto_bright: the default auto-exposure boost pushes
            # brightness up until it starts clipping, which defeats the
            # whole point of working in RAW -- we want the sensor's actual
            # unclipped values.
            rgb16 = raw.postprocess(use_camera_wb=True, no_auto_bright=True, output_bps=16)
    except Exception:  # noqa: BLE001
        return None

    full_h, full_w = rgb16.shape[:2]
    factor = max(1, round(max(full_h, full_w) / _WORK_DIMENSION))
    luma = _block_reduce(rgb16.max(axis=2), factor, "max")
    rgb_small = _block_reduce(rgb16, factor, "mean")

    median = float(np.median(luma))
    std = float(np.std(luma))
    threshold = min(65000.0, median + max(3000.0, 3.5 * std))
    _, binary = cv2.threshold(luma, threshold, 65535, cv2.THRESH_BINARY)
    binary = binary.astype(np.uint8)
    kernel = np.ones((2, 2), np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    work_h, work_w = luma.shape[:2]
    scale_x, scale_y = full_w / work_w, full_h / work_h
    if target_size is not None:
        target_w, target_h = target_size
        scale_x, scale_y = target_w / work_w, target_h / work_h

    candidates: list[tuple[float, float, float, int, float]] = []  # x, y, peak, area, blueness
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < MIN_BLOB_AREA or area > MAX_BLOB_AREA * 6:
            # RAW blobs run larger than the JPEG-preview cap since nothing's
            # been through lossy compression to shrink saturated regions.
            continue
        mask = labels == i
        peak = float(luma[mask].max())
        cx, cy = centroids[i]
        if rgb_small.shape[:2] == luma.shape[:2]:
            mean_rgb = rgb_small[mask].reshape(-1, 3).mean(axis=0)
            blueness = float(mean_rgb[2] - mean_rgb[0])
        else:
            blueness = 0.0
        candidates.append((float(cx), float(cy), peak, int(area), blueness))

    star_probs = _classify_candidates_raw(candidates, rgb16, factor)

    # Rank by the trained classifier's star-probability when one is
    # available (it learns real shape/halo patterns from user-confirmed
    # examples that these hand-picked features can only approximate);
    # otherwise fall back to: peak brightness first (not summed brightness
    # -- a large, saturated foreground patch sums to far more total signal
    # than a small genuine star even when neither is brighter than the
    # other per pixel, which is exactly what let foreground clutter crowd
    # out real stars under the old JPEG-preview detector), smaller area as
    # a tiebreak favoring the more point-like candidate, and a bluer color
    # as a soft further tiebreak (real stars skew blue-white in this app's
    # photos; artificial lights skew warm) -- soft because real stars span
    # the full color range (e.g. Betelgeuse is genuinely red), so this must
    # never be a hard filter.
    if star_probs is not None:
        order = sorted(range(len(candidates)), key=lambda i: -star_probs[i])
    else:
        order = sorted(range(len(candidates)), key=lambda i: (-candidates[i][2], candidates[i][3], -candidates[i][4]))
    candidates = [candidates[i] for i in order]

    deduped: list[tuple[float, float, float]] = []
    for cx, cy, _peak, _area, _blueness in candidates:
        if any((cx - kx) ** 2 + (cy - ky) ** 2 < DEDUP_RADIUS_PX**2 for kx, ky, _ in deduped):
            continue
        deduped.append((cx, cy, _peak))

    return [(cx * scale_x, cy * scale_y, b) for cx, cy, b in deduped[:max_stars]]
