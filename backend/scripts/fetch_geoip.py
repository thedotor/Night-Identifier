"""Download the DB-IP Lite databases the installer bundles: the city database (app/data/geoip/dbip-city-lite.mmdb)
and the ASN/network-owner database (app/data/geoip/dbip-asn-lite.mmdb).

The city file is about 125 MB and the ASN file about 5 MB, so neither is kept in git. Run this (or just build the
installer, which runs it when a file is missing) from the backend folder:  uv run python scripts/fetch_geoip.py
The data are (c) DB-IP.com, licensed CC BY 4.0: the app credits them in the Earth page and About.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.geoip import ASN_DB_NAME, DB_NAME, download_latest, download_latest_asn  # noqa: E402

geoip_dir = Path(__file__).resolve().parent.parent / "app" / "data" / "geoip"

city_target = geoip_dir / DB_NAME
got_city = download_latest(city_target)
print(f"Saved {city_target} (database built {got_city['built']})")

asn_target = geoip_dir / ASN_DB_NAME
got_asn = download_latest_asn(asn_target)
print(f"Saved {asn_target} (database built {got_asn['built']})")
