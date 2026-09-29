"""Where this PC's internet connections go, for the "Web traffic" layer on the 3D Earth.

Windows keeps a table of the connections every program has open. `psutil` reads it (no packet capture, no driver, no
administrator rights), so this sees which remote addresses this PC is talking to and which program owns each
connection, but not what is said or how much: it is a picture of *where*, not of *what*. Connections that Windows does
not list with a remote address (for example most UDP/QUIC traffic) do not show up.

Privacy rules, all enforced here:
  * Off until the user switches it on; the switch is remembered.
  * Only public internet addresses are kept. LAN, loopback, link-local and other private addresses are dropped.
  * Each address is placed with the offline database in `geoip` - nothing is sent to anyone. Host names (reverse DNS)
    are looked up only when the user clicks for one destination, since that question goes to the PC's DNS server.
  * The live picture (with addresses) is kept in memory only and is forgotten when the layer is switched off.
  * The optional history (on by default while the layer is on) holds country, city and program name per hour - never an
    address, port or URL - for 7 days, encrypted with Windows DPAPI for this Windows user, and can be wiped at any time.
    Where DPAPI is not available no history is written at all.
"""

from __future__ import annotations

import collections
import json
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any

from app.config import settings
from app.services import app_settings, geoip, log_capture, secrets_at_rest

logger = log_capture.get_logger("traffic")

SAMPLE_S = 3.0  # how often the connection table is read
LINGER_S = 25.0  # a destination stays on the globe this long after its last connection closes
MAX_PLACES = 400
HISTORY_DAYS = 7
HISTORY_MAX_ROWS = 60_000
SAVE_EVERY_S = 120.0
_PURPOSE = "traffic-history"
_PROC_TTL_S = 60.0
_HOUR_S = 3600


class _Place:
    __slots__ = ("id", "lat", "lon", "city", "country", "cc", "ips", "ports", "procs", "n", "last_seen")

    def __init__(self, pid: str, geo: dict[str, Any]) -> None:
        self.id = pid
        self.lat = geo["lat"]
        self.lon = geo["lon"]
        self.city = geo["city"]
        self.country = geo["country"]
        self.cc = geo["cc"]
        self.ips: dict[str, collections.Counter[str]] = {}  # address -> program -> connections
        self.ports: dict[str, collections.Counter[tuple[int, str]]] = {}  # address -> (port, "TCP"/"UDP") -> connections
        self.procs: collections.Counter[str] = collections.Counter()
        self.n = 0
        self.last_seen = 0.0


def _normalise(ip: str) -> str:
    """An IPv4 address that arrived wrapped as IPv6 (::ffff:a.b.c.d) as plain IPv4."""
    if ip.startswith("::ffff:") and "." in ip:
        return ip[7:]
    return ip.split("%", 1)[0]  # drop an IPv6 zone id


class Monitor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._enabled = False
        self._history_on = True
        self._places: dict[str, _Place] = {}
        self._procs: dict[int, tuple[float, str]] = {}
        self._hist: dict[tuple[int, str, str, str, str], int] = {}  # (hour, cc, country, city, program) -> samples seen
        self._hist_dirty = False
        self._hist_saved_at = 0.0
        self._hist_loaded = False
        self._updated = 0.0
        self._error: str | None = None
        self._samples = 0
        self._dns = ThreadPoolExecutor(max_workers=2, thread_name_prefix="traffic-dns")
        self._hosts: dict[str, str] = {}

    # ---- control ----------------------------------------------------------------------
    def start(self, enabled: bool = False, history: bool = True) -> None:
        self._history_on = history
        self._enabled = enabled
        if enabled:
            self._load_history()
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="traffic", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._save_history(force=True)

    def set_enabled(self, enabled: bool) -> None:
        if enabled == self._enabled:
            return
        self._enabled = enabled
        if enabled:
            self._load_history()
            self.start(True, self._history_on)
        else:
            self._forget_live()
            self._save_history(force=True)

    def set_history(self, on: bool) -> None:
        self._history_on = on
        if on:
            self._load_history()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _forget_live(self) -> None:
        with self._lock:
            self._places.clear()
            self._procs.clear()
            self._hosts.clear()
            self._updated = 0.0
            self._error = None

    # ---- sampling ---------------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.is_set():
            if self._enabled:
                try:
                    self._sample()
                    self._error = None
                except Exception as e:  # noqa: BLE001 - reading the table must never take the backend down
                    self._error = f"{type(e).__name__}: {str(e)[:100]}"
                    logger.info("Web traffic: %s", self._error)
                self._save_history()
                self._stop.wait(SAMPLE_S)
            else:
                self._stop.wait(1.0)

    def _program(self, pid: int | None) -> str:
        if not pid:
            return "System"
        now = time.monotonic()
        hit = self._procs.get(pid)
        if hit and now - hit[0] < _PROC_TTL_S:
            return hit[1]
        import psutil

        try:
            name = psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            name = "Unknown"
        if len(self._procs) > 2000:
            self._procs.clear()
        self._procs[pid] = (now, name)
        return name

    def _sample(self) -> None:
        import psutil

        now = time.time()
        seen: dict[str, dict[str, collections.Counter[str]]] = {}  # place id -> address -> program -> connections
        seen_ports: dict[str, dict[str, collections.Counter[tuple[int, str]]]] = {}  # place id -> address -> (port, proto) -> connections
        geos: dict[str, dict[str, Any]] = {}
        for c in psutil.net_connections(kind="inet"):
            if c.status != psutil.CONN_ESTABLISHED or not c.raddr:
                continue
            ip = _normalise(c.raddr.ip)
            if not geoip.is_public(ip):
                continue
            geo = geoip.lookup(ip)
            if geo is None:
                continue
            pid = f"{geo['lat']:.2f},{geo['lon']:.2f}"
            geos.setdefault(pid, geo)
            seen.setdefault(pid, {}).setdefault(ip, collections.Counter())[self._program(c.pid)] += 1
            proto = "UDP" if c.type == socket.SOCK_DGRAM else "TCP"
            seen_ports.setdefault(pid, {}).setdefault(ip, collections.Counter())[(c.raddr.port, proto)] += 1

        hour = int(now // _HOUR_S) * _HOUR_S
        with self._lock:
            for place in self._places.values():
                place.n = 0
                place.procs = collections.Counter()
            for pid, by_ip in seen.items():
                place = self._places.get(pid)
                if place is None:
                    if len(self._places) >= MAX_PLACES:
                        continue
                    place = self._places[pid] = _Place(pid, geos[pid])
                place.ips = by_ip
                place.ports = seen_ports.get(pid, {})
                for counter in by_ip.values():
                    place.procs.update(counter)
                place.n = sum(place.procs.values())
                place.last_seen = now
                if self._history_on and secrets_at_rest.available():
                    for program in place.procs:
                        key = (hour, place.cc, place.country, place.city, program)
                        self._hist[key] = self._hist.get(key, 0) + 1
                        self._hist_dirty = True
            for pid in [p for p, pl in self._places.items() if now - pl.last_seen > LINGER_S]:
                del self._places[pid]
            self._updated = now
            self._samples += 1

    # ---- live views -------------------------------------------------------------------
    def live(self) -> dict[str, Any]:
        """The current picture: destinations (no addresses), and tallies by country and program."""
        now = time.time()
        with self._lock:
            places = sorted(self._places.values(), key=lambda p: (-p.n, p.id))
            rows = [
                {
                    "id": p.id,
                    "lat": p.lat,
                    "lon": p.lon,
                    "city": p.city,
                    "country": p.country,
                    "cc": p.cc,
                    "n": p.n,
                    "procs": [[name, n] for name, n in p.procs.most_common(6)],
                    "age_s": round(now - p.last_seen, 1),
                }
                for p in places
            ]
            countries: dict[str, dict[str, Any]] = {}
            programs: dict[str, dict[str, Any]] = {}
            for p in places:
                if p.n == 0:
                    continue
                c = countries.setdefault(p.cc or p.country, {"cc": p.cc, "country": p.country, "n": 0, "places": 0})
                c["n"] += p.n
                c["places"] += 1
                for name, n in p.procs.items():
                    e = programs.setdefault(name, {"name": name, "n": 0, "countries": set()})
                    e["n"] += n
                    e["countries"].add(p.cc or p.country)
            total = sum(p.n for p in places)
        return {
            "enabled": self._enabled,
            "updated_ms": int(self._updated * 1000),
            "connections": total,
            "places": rows,
            "countries": sorted(countries.values(), key=lambda c: -c["n"]),
            "programs": sorted(({"name": e["name"], "n": e["n"], "countries": len(e["countries"])} for e in programs.values()), key=lambda e: -e["n"]),
            "error": self._error,
            "credit": geoip.CREDIT,
        }

    def detail(self, place_id: str) -> dict[str, Any] | None:
        """One destination with its addresses (shown only when the user expands it)."""
        with self._lock:
            p = self._places.get(place_id)
            if p is None:
                return None
            addresses = []
            for ip, c in sorted(p.ips.items(), key=lambda kv: -sum(kv[1].values()))[:30]:
                ports = p.ports.get(ip, collections.Counter())
                asn = geoip.asn_lookup(ip)
                addresses.append(
                    {
                        "ip": ip,
                        "programs": [[name, n] for name, n in c.most_common()],
                        "ports": [[port, proto, n] for (port, proto), n in ports.most_common()],
                        "host": self._hosts.get(ip),
                        "asn": asn["asn"] if asn else None,
                        "org": asn["org"] if asn else None,
                    }
                )
            return {"id": p.id, "city": p.city, "country": p.country, "cc": p.cc, "addresses": addresses}

    def hostname(self, place_id: str, ip: str) -> str | None:
        """The reverse-DNS name of one address at a destination. Only addresses this monitor is tracking are looked up; the
        question goes to this PC's DNS server, which is why it is asked for only when the user clicks."""
        with self._lock:
            p = self._places.get(place_id)
            if p is None or ip not in p.ips:
                return None
            if ip in self._hosts:
                return self._hosts[ip] or None
        try:
            name = self._dns.submit(lambda: socket.gethostbyaddr(ip)[0]).result(timeout=4)
        except (FutureTimeout, OSError, ValueError):
            name = ""
        with self._lock:
            self._hosts[ip] = name
        return name or None

    # ---- history ----------------------------------------------------------------------
    def _history_file(self):
        return settings.data_dir / "traffic_history.bin"

    def _prune(self, now: float | None = None) -> None:
        cutoff = int((now or time.time()) // _HOUR_S) * _HOUR_S - HISTORY_DAYS * 24 * _HOUR_S
        for k in [k for k in self._hist if k[0] < cutoff]:
            del self._hist[k]
        if len(self._hist) > HISTORY_MAX_ROWS:
            for k in sorted(self._hist, key=lambda k: k[0])[: len(self._hist) - HISTORY_MAX_ROWS]:
                del self._hist[k]

    def _load_history(self) -> None:
        if self._hist_loaded:
            return
        self._hist_loaded = True
        path = self._history_file()
        if not path.is_file():
            return
        try:
            raw = secrets_at_rest.unprotect_bytes(path.read_bytes(), _PURPOSE)
            rows = json.loads(raw.decode("utf-8"))["rows"] if raw else []
        except (OSError, ValueError, KeyError):
            rows = []
        with self._lock:
            for r in rows:
                try:
                    key = (int(r[0]), str(r[1]), str(r[2]), str(r[3]), str(r[4]))
                    self._hist[key] = self._hist.get(key, 0) + int(r[5])
                except (IndexError, TypeError, ValueError):
                    continue
            self._prune()

    def _save_history(self, force: bool = False) -> None:
        now = time.time()
        if not self._hist_dirty and not force:
            return
        if not force and now - self._hist_saved_at < SAVE_EVERY_S:
            return
        if not secrets_at_rest.available():
            return
        with self._lock:
            if not self._hist_loaded:
                return
            self._prune(now)
            rows = [[*k, v] for k, v in self._hist.items()]
            self._hist_dirty = False
        self._hist_saved_at = now
        if not rows and not self._history_file().is_file():
            return
        blob = secrets_at_rest.protect_bytes(json.dumps({"v": 1, "rows": rows}, separators=(",", ":")).encode("utf-8"), _PURPOSE)
        if blob is None:
            return
        try:
            settings.ensure_dirs()
            tmp = self._history_file().with_suffix(".tmp")
            tmp.write_bytes(blob)
            tmp.replace(self._history_file())
        except OSError as e:
            logger.info("Web traffic: could not save history: %s", e)

    def history(self, days: int = HISTORY_DAYS) -> dict[str, Any]:
        """The kept history, added up by country, by program and by day (minutes of connection, roughly)."""
        self._load_history()
        now = time.time()
        cutoff = int(now // _HOUR_S) * _HOUR_S - max(1, min(days, HISTORY_DAYS)) * 24 * _HOUR_S
        countries: dict[str, dict[str, Any]] = {}
        programs: dict[str, dict[str, Any]] = {}
        daily: dict[str, int] = collections.defaultdict(int)
        rows = 0
        with self._lock:
            for (hour, cc, country, city, program), seen in self._hist.items():
                if hour < cutoff:
                    continue
                rows += 1
                c = countries.setdefault(cc or country, {"cc": cc, "country": country, "seen": 0, "cities": collections.Counter()})
                c["seen"] += seen
                if city:
                    c["cities"][city] += seen
                p = programs.setdefault(program, {"name": program, "seen": 0, "countries": collections.Counter()})
                p["seen"] += seen
                p["countries"][cc or country] += seen
                daily[time.strftime("%Y-%m-%d", time.localtime(hour))] += seen
        to_min = lambda s: round(s * SAMPLE_S / 60, 1)  # noqa: E731
        return {
            "days": days,
            "keeping": self._history_on and secrets_at_rest.available(),
            "encrypted": secrets_at_rest.available(),
            "rows": rows,
            "countries": sorted(
                ({"cc": c["cc"], "country": c["country"], "minutes": to_min(c["seen"]), "cities": [n for n, _ in c["cities"].most_common(5)]} for c in countries.values()),
                key=lambda c: -c["minutes"],
            ),
            "programs": sorted(
                ({"name": p["name"], "minutes": to_min(p["seen"]), "countries": len(p["countries"])} for p in programs.values()),
                key=lambda p: -p["minutes"],
            ),
            "daily": [{"day": d, "minutes": to_min(s)} for d, s in sorted(daily.items())],
        }

    def clear_history(self) -> None:
        with self._lock:
            self._hist.clear()
            self._hist_dirty = False
        try:
            self._history_file().unlink(missing_ok=True)
            self._history_file().with_suffix(".tmp").unlink(missing_ok=True)
        except OSError:
            pass

    # ---- status -----------------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "history": self._history_on,
            "history_available": secrets_at_rest.available(),
            "running": self._thread is not None and self._thread.is_alive(),
            "samples": self._samples,
            "error": self._error,
            "database": geoip.info(),
            "credit": geoip.CREDIT,
        }


monitor = Monitor()


def start_from_settings() -> None:
    monitor.start(app_settings.get_traffic_enabled(), app_settings.get_traffic_history())
