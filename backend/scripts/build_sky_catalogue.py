"""Build the static sky catalogue used by the full-sky overlay.

Stars (magnitude <= 6, RA/Dec J2000) and bright-star names come from
d3-celestial (BSD 3-Clause, Hipparcos-derived). Deep-sky objects come from
OpenNGC (CC BY-SA 4.0): every Messier object, NGC/IC objects brighter than
DSO_MAG_LIMIT, and every nebula that is large (NEBULA_MIN_SIZE_ARCMIN) or has a common
name -- most emission nebulae have no magnitude at all, so a brightness cut alone drops
the Horsehead, Flame, Rosette ... Constellation and asterism figures are NOT stored here -- they
are assembled at request time from app/data/constellations.py and asterisms.py.

Output: backend/app/data/sky/catalogue.json
  {"stars": [ra, dec, mag, ra, dec, mag, ...],      # decimal degrees, RA 0..360
   "star_names": {"<star index>": "Sirius", ...},   # magnitude <= NAMED_MAG_LIMIT
   "dsos": [{"id","name","type","ra","dec","mag","maj","min","pa"}, ...]}

Run once (needs network): python scripts/build_sky_catalogue.py
"""

import csv
import io
import json
import urllib.request
from pathlib import Path

RAW = "https://raw.githubusercontent.com"
STARS_URL = f"{RAW}/ofrohn/d3-celestial/master/data/stars.6.json"
STARNAMES_URL = f"{RAW}/ofrohn/d3-celestial/master/data/starnames.json"
NGC_URL = f"{RAW}/mattiaverga/OpenNGC/master/database_files/NGC.csv"
ADDENDUM_URL = f"{RAW}/mattiaverga/OpenNGC/master/database_files/addendum.csv"  # Barnard, Caldwell ...

NAMED_MAG_LIMIT = 3.0
DSO_MAG_LIMIT = 10.0
NEBULA_TYPES = {"Cl+N", "PN", "Neb", "HII", "EmN", "RfN", "SNR", "DrkN"}
NEBULA_MIN_SIZE_ARCMIN = 8.0
# OpenNGC's names are wrong or missing for a few well-known objects.
NAME_OVERRIDES = {
    "IC 434": "",  # OpenNGC calls it the Flame Nebula; that is NGC 2024 (IC 434 is the Horsehead's backdrop)
    "NGC 2024": "Flame Nebula",
    "IC 1805": "Heart Nebula",
    "IC 1848": "Soul Nebula",
    "IC 1396": "Elephant's Trunk Nebula",
    "NGC 281": "Pacman Nebula",
    "NGC 7380": "Wizard Nebula",
}
# OpenNGC types worth drawing (galaxies, clusters, nebulae, ...); stars,
# duplicate/nonexistent entries and "other" are skipped unless Messier.
DSO_TYPES = {"G", "GPair", "GTrpl", "GGroup", "GCl", "OCl", "Cl+N", "PN", "Neb", "HII", "EmN", "RfN", "SNR", "DrkN"}

OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "sky" / "catalogue.json"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def hms_to_deg(text: str) -> float:
    h, m, s = (float(p) for p in text.split(":"))
    return (h + m / 60 + s / 3600) * 15.0


def dms_to_deg(text: str) -> float:
    sign = -1.0 if text.startswith("-") else 1.0
    d, m, s = (float(p) for p in text.lstrip("+-").split(":"))
    return sign * (d + m / 60 + s / 3600)


def num(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def dso_id(row: dict, is_addendum: bool) -> str:
    messier = row["M"].strip()
    if messier:
        return f"M{int(messier)}"
    name = row["Name"]
    if is_addendum:  # B033 -> "B 33", C099 -> "C 99" (Caldwell)
        return f"{name[0]} {int(name[1:])}" if name[1:].isdigit() else name
    return name.replace("NGC0", "NGC").replace("NGC", "NGC ").replace("IC0", "IC").replace("IC", "IC ").replace("  ", " ").strip()


def read_row(row: dict, is_addendum: bool) -> dict | None:
    """One OpenNGC row as a catalogue entry, or None if it isn't worth drawing."""
    if not row["RA"] or not row["Dec"]:
        return None
    messier = row["M"].strip()
    mag = num(row["V-Mag"]) if row["V-Mag"] else num(row["B-Mag"])
    size = num(row["MajAx"]) or 0.0
    common = (row["Common names"].split(",")[0] or "") if row["Common names"] else ""
    ident = dso_id(row, is_addendum)
    is_nebula = row["Type"] in NEBULA_TYPES
    keep = (
        bool(messier)
        or (row["Type"] in DSO_TYPES and mag is not None and mag <= DSO_MAG_LIMIT)
        or (is_nebula and (size >= NEBULA_MIN_SIZE_ARCMIN or bool(common)))
        or (is_addendum and bool(common) and row["Type"] in DSO_TYPES | {"*Ass"})
    )
    if not keep:
        return None
    return {
        "id": ident,
        "name": NAME_OVERRIDES.get(ident, common),
        "type": row["Type"],
        "ra": round(hms_to_deg(row["RA"]), 4),
        "dec": round(dms_to_deg(row["Dec"]), 4),
        "mag": mag,
        "maj": num(row["MajAx"]),
        "min": num(row["MinAx"]),
        "pa": num(row["PosAng"]),
    }


def main() -> None:
    names = json.loads(fetch(STARNAMES_URL))
    features = json.loads(fetch(STARS_URL))["features"]

    stars: list[float] = []
    star_names: dict[str, str] = {}
    for i, f in enumerate(features):
        ra, dec = f["geometry"]["coordinates"]
        mag = f["properties"]["mag"]
        stars += [round(ra % 360.0, 4), round(dec, 4), round(float(mag), 2)]
        name = (names.get(str(f["id"])) or {}).get("name")
        if name and float(mag) <= NAMED_MAG_LIMIT:
            star_names[str(i)] = name

    dsos = []
    seen: set[str] = set()
    for url, is_addendum in ((NGC_URL, False), (ADDENDUM_URL, True)):
        for row in csv.DictReader(io.StringIO(fetch(url).decode("utf-8")), delimiter=";"):
            dso = read_row(row, is_addendum)
            if dso and dso["id"] not in seen:
                seen.add(dso["id"])
                dsos.append(dso)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"stars": stars, "star_names": star_names, "dsos": dsos}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(stars) // 3} stars, {len(star_names)} named, {len(dsos)} DSOs -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
