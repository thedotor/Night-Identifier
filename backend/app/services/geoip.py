"""Offline IP address -> place and IP address -> network-owner lookups, from DB-IP's free "IP to City Lite" and
"IP to ASN Lite" databases (db-ip.com, CC BY 4.0).

Every lookup is answered on this PC from a database file, so the addresses you connect to never leave it. The app
ships one copy of each (app/data/geoip, fetched by scripts/fetch_geoip.py when the installer is built) and can
replace either with a newer monthly release, saved in the data folder, when asked (`update`/`asn_update`). The
newer of the two files (bundled vs downloaded) is used.

The data are city-level at best: a server's address says where the company that owns it registered it, and CDN and
cloud addresses often sit far from the site behind them. The ASN database says who *owns* the address block (e.g.
"Cloudflare, Inc.", "Amazon.com, Inc.") - useful context, not a claim about who is actually running a given service.
"""

from __future__ import annotations

import gzip
import ipaddress
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import date
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import settings
from app.services import log_capture

logger = log_capture.get_logger("geoip")

CREDIT = "IP geolocation by DB-IP.com (CC BY 4.0)"
DB_NAME = "dbip-city-lite.mmdb"
ASN_DB_NAME = "dbip-asn-lite.mmdb"
_HOST = "download.db-ip.com"
_MAX_DOWNLOAD = 400 * 1024 * 1024  # the real city file is about 60 MB compressed; the ASN one about 5 MB
_CACHE_MAX = 20_000


@dataclass
class _Db:
    """One DB-IP Lite database (city or ASN): where its files live, how to validate a downloaded copy, and its open reader/cache."""

    file_name: str
    url_slug: str  # e.g. "city-lite" in "dbip-city-lite-2026-09.mmdb.gz"
    type_check: str  # a substring expected in the database's own metadata.database_type
    test_ip: str  # an address every release must have a record for
    lock: threading.RLock = field(default_factory=threading.RLock)
    reader: Any = None
    reader_path: Path | None = None
    cache: dict[str, dict[str, Any] | None] = field(default_factory=dict)

    @property
    def bundled(self) -> Path:
        return Path(__file__).resolve().parent.parent / "data" / "geoip" / self.file_name

    def user_path(self) -> Path:
        return settings.data_dir / "geoip" / self.file_name


_CITY = _Db(DB_NAME, "city-lite", "City", "8.8.8.8")
_ASN = _Db(ASN_DB_NAME, "asn-lite", "ASN", "8.8.8.8")


def _epoch(path: Path) -> int:
    """When the database in this file was built (0 if it can't be read)."""
    import maxminddb

    try:
        with maxminddb.open_database(str(path)) as r:
            return int(r.metadata().build_epoch)
    except (OSError, ValueError, maxminddb.InvalidDatabaseError):
        return 0


def _pick(db: _Db) -> Path | None:
    """The database file to use: the downloaded one when it is newer than the bundled one."""
    have = [p for p in (db.user_path(), db.bundled) if p.is_file()]
    if not have:
        return None
    if len(have) == 1:
        return have[0]
    return max(have, key=_epoch)


def _open(db: _Db) -> Any:
    with db.lock:
        if db.reader is not None:
            return db.reader
        import maxminddb

        path = _pick(db)
        if path is None:
            return None
        try:
            db.reader = maxminddb.open_database(str(path))
            db.reader_path = path
        except (OSError, ValueError, maxminddb.InvalidDatabaseError) as e:
            logger.warning("Could not open the IP database %s: %s", path.name, e)
            return None
        return db.reader


def _close(db: _Db) -> None:
    with db.lock:
        if db.reader is not None:
            db.reader.close()
        db.reader = None
        db.reader_path = None
        db.cache.clear()


def is_public(ip: str) -> bool:
    """A routable internet address: not private, loopback, link-local, multicast, reserved or shared (CGNAT) space."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # is_global alone lets multicast through
    return addr.is_global and not (addr.is_multicast or addr.is_reserved or addr.is_unspecified or addr.is_loopback or addr.is_link_local)


def lookup(ip: str) -> dict[str, Any] | None:
    """{lat, lon, city, country, cc} for a public address, or None when the database has no place for it."""
    if not is_public(ip):
        return None
    db = _CITY
    with db.lock:
        if ip in db.cache:
            return db.cache[ip]
        reader = _open(db)
        if reader is None:
            return None
        try:
            rec = reader.get(ip)
        except (ValueError, OSError):
            rec = None
        out: dict[str, Any] | None = None
        if isinstance(rec, dict):
            loc = rec.get("location") or {}
            lat, lon = loc.get("latitude"), loc.get("longitude")
            country = rec.get("country") or {}
            city = rec.get("city") or {}
            if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and abs(lat) <= 90 and abs(lon) <= 180:
                out = {
                    "lat": round(float(lat), 3),
                    "lon": round(float(lon), 3),
                    "city": str((city.get("names") or {}).get("en") or ""),
                    "country": str((country.get("names") or {}).get("en") or ""),
                    "cc": str(country.get("iso_code") or ""),
                }
        if len(db.cache) >= _CACHE_MAX:
            db.cache.clear()
        db.cache[ip] = out
        return out


def asn_lookup(ip: str) -> dict[str, Any] | None:
    """{asn, org} (the network number and its owner's name) for a public address, or None if not available."""
    if not is_public(ip):
        return None
    db = _ASN
    with db.lock:
        if ip in db.cache:
            return db.cache[ip]
        reader = _open(db)
        if reader is None:
            return None
        try:
            rec = reader.get(ip)
        except (ValueError, OSError):
            rec = None
        out: dict[str, Any] | None = None
        if isinstance(rec, dict) and rec.get("autonomous_system_organization"):
            out = {"asn": rec.get("autonomous_system_number"), "org": str(rec["autonomous_system_organization"])}
        if len(db.cache) >= _CACHE_MAX:
            db.cache.clear()
        db.cache[ip] = out
        return out


def _info(db: _Db) -> dict[str, Any]:
    reader = _open(db)
    if reader is None or db.reader_path is None:
        return {"available": False, "credit": CREDIT}
    meta = reader.metadata()
    return {
        "available": True,
        "built": date.fromtimestamp(int(meta.build_epoch)).isoformat(),
        "downloaded": db.reader_path == db.user_path(),
        "credit": CREDIT,
    }


def info() -> dict[str, Any]:
    """Which city database is in use and how old it is."""
    return _info(_CITY)


def asn_info() -> dict[str, Any]:
    """Which ASN (network owner) database is in use and how old it is."""
    return _info(_ASN)


def _release_urls(db: _Db) -> list[str]:
    """This month's file, then last month's (the new release appears a few days into the month)."""
    today = date.today()
    months = [(today.year, today.month)]
    months.append((today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1))
    return [f"https://{_HOST}/free/dbip-{db.url_slug}-{y}-{m:02d}.mmdb.gz" for y, m in months]


def _download_latest(db: _Db, target: Path, before_replace: Callable[[], None] | None = None) -> dict[str, Any]:
    """Download the newest release of `db` to `target` (checked: it must open and be the right kind of database).

    `before_replace` runs just before the finished file is moved into place (to let go of an open copy).
    """
    import maxminddb

    target.parent.mkdir(parents=True, exist_ok=True)
    last_error = "no release found"
    for url in _release_urls(db):
        tmp_gz = tmp_db = None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "night-identifier"})
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310  # nosec B310 - the URL is built from a fixed https host
                if resp.status != 200:
                    continue
                with tempfile.NamedTemporaryFile(delete=False, suffix=".gz", dir=target.parent) as f:
                    tmp_gz = Path(f.name)
                    size = 0
                    while chunk := resp.read(1 << 20):
                        size += len(chunk)
                        if size > _MAX_DOWNLOAD:
                            raise ValueError("download too large")
                        f.write(chunk)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mmdb", dir=target.parent) as f:
                tmp_db = Path(f.name)
                with gzip.open(tmp_gz, "rb") as src:
                    shutil.copyfileobj(src, f)
            with maxminddb.open_database(str(tmp_db)) as r:
                meta = r.metadata()
                if db.type_check not in meta.database_type or not r.get(db.test_ip):
                    raise ValueError(f"unexpected database ({meta.database_type})")
                built = date.fromtimestamp(int(meta.build_epoch)).isoformat()
            if before_replace is not None:
                before_replace()
            tmp_db.replace(target)
            tmp_db = None
            return {"built": built, "url": url}
        except urllib.error.HTTPError as e:
            last_error = f"{url.rsplit('/', 1)[-1]}: HTTP {e.code}"
        except (urllib.error.URLError, OSError, ValueError, EOFError, maxminddb.InvalidDatabaseError) as e:
            last_error = f"{url.rsplit('/', 1)[-1]}: {e}"
        finally:
            for p in (tmp_gz, tmp_db):
                if p is not None:
                    p.unlink(missing_ok=True)
    raise RuntimeError(last_error)


def download_latest(target: Path, before_replace: Callable[[], None] | None = None) -> dict[str, Any]:
    """Download the newest DB-IP Lite city database to `target` (used by scripts/fetch_geoip.py at build time)."""
    return _download_latest(_CITY, target, before_replace)


def download_latest_asn(target: Path, before_replace: Callable[[], None] | None = None) -> dict[str, Any]:
    """Download the newest DB-IP Lite ASN database to `target` (used by scripts/fetch_geoip.py at build time)."""
    return _download_latest(_ASN, target, before_replace)


def update() -> dict[str, Any]:
    """Fetch the newest city database release into the data folder and start using it."""
    try:
        _download_latest(_CITY, _CITY.user_path(), before_replace=lambda: _close(_CITY))  # Windows cannot replace a file that is open
    finally:
        _close(_CITY)  # reopen (the newer of the two files) on the next lookup
    return info()


def asn_update() -> dict[str, Any]:
    """Fetch the newest ASN (network owner) database release into the data folder and start using it."""
    try:
        _download_latest(_ASN, _ASN.user_path(), before_replace=lambda: _close(_ASN))
    finally:
        _close(_ASN)
    return asn_info()
