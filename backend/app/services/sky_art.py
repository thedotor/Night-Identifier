"""Classical constellation artwork (lion, hunter, swan ...) for the Sky Overlay.

Each illustration comes with 3+ anchor stars: art pixel <-> sky (RA, Dec), from
scripts/build_constellation_art.py. The frontend uses the anchors to lay the picture onto
the sky and draws it through the same camera as everything else.
"""

import json
from pathlib import Path

ART_DIR = Path(__file__).resolve().parent.parent / "data" / "art"

try:
    _ART: dict[str, dict] = json.loads((ART_DIR / "art_anchors.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    _ART = {}


def art_path(abbr: str) -> Path | None:
    """Image file for abbr, only for abbreviations present in the anchor table
    (so arbitrary request paths can never reach the filesystem)."""
    if abbr not in _ART:
        return None
    path = ART_DIR / f"{abbr}.png"
    return path if path.is_file() else None


def art_anchors() -> dict[str, dict]:
    """{abbr: {size: [w, h], anchors: [{x, y, ra, dec}]}} for every constellation with a picture."""
    return {abbr: info for abbr, info in _ART.items() if art_path(abbr) is not None}
