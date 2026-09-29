The offline IP-address -> place database for the "Web traffic" layer goes here as dbip-city-lite.mmdb
(DB-IP "IP to City Lite", CC BY 4.0, https://db-ip.com). It is about 125 MB, so it is git-ignored.

The offline IP-address -> network-owner database (who an address belongs to, e.g. "Cloudflare, Inc.") goes here
as dbip-asn-lite.mmdb (DB-IP "IP to ASN Lite", CC BY 4.0). It is about 5 MB, also git-ignored.

Run  uv run python scripts/fetch_geoip.py  in the backend folder to download both. The installer build does this
by itself. Either can also be refreshed later from Settings, without rebuilding the app.
