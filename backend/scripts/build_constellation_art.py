"""Fetch classical constellation artwork + star anchors for the overlay feature.

Source: Stellarium's "modern" sky culture (https://github.com/Stellarium/stellarium,
skycultures/modern). Illustrations are under the Free Art License 1.3
(http://artlibre.org/licence/lal/en/); see backend/app/data/art/LICENSE.txt.
Anchor star positions (Hipparcos IDs) are resolved to RA/Dec using the
d3-celestial star catalogue. Output: backend/app/data/art/<abbr>.png and
art_anchors.json ({abbr: {size, anchors: [{x, y, ra, dec}]}}), the input to
services/sky_art.py.

Run once (needs network): python scripts/build_constellation_art.py
"""

import json
import urllib.request
from pathlib import Path

RAW = "https://raw.githubusercontent.com"
INDEX_URL = f"{RAW}/Stellarium/stellarium/master/skycultures/modern/index.json"
ART_BASE = f"{RAW}/Stellarium/stellarium/master/skycultures/modern/"
STARS_URL = f"{RAW}/ofrohn/d3-celestial/master/data/stars.8.json"

OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "art"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = json.loads(fetch(INDEX_URL))
    stars = {
        f["id"]: f["geometry"]["coordinates"]
        for f in json.loads(fetch(STARS_URL))["features"]
    }

    result: dict[str, dict] = {}
    for con in index["constellations"]:
        image = con.get("image")
        if not image:
            continue
        abbr = con["id"].split()[-1]
        anchors = []
        for a in image["anchors"]:
            coords = stars.get(a["hip"])
            if coords is None:
                continue
            anchors.append(
                {"x": a["pos"][0], "y": a["pos"][1], "ra": coords[0], "dec": coords[1]}
            )
        if len(anchors) < 3:
            print(f"skip {abbr}: only {len(anchors)} resolvable anchors")
            continue
        (OUT / f"{abbr}.png").write_bytes(fetch(ART_BASE + image["file"]))
        result[abbr] = {"size": image["size"], "anchors": anchors}
        print("ok", abbr)

    (OUT / "art_anchors.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"{len(result)} constellations with art")


if __name__ == "__main__":
    main()
