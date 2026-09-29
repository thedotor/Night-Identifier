"""Live earthquakes, volcano activity and satellite heat spots for the 3D Earth in Deep Space.

Sources (all free):

* Earthquakes: the USGS Earthquake Hazards Program's public GeoJSON feeds (earthquake.usgs.gov, no key). The last 30 days are
  loaded once, then the "past hour" feed is read every minute for new and revised events.
* Volcanoes: the position, country, type and last-eruption class of about 1,600 volcanoes from NOAA NCEI's volcano location
  database (its numbers are the Smithsonian Global Volcanism Program's), and what is happening now from
  - the Smithsonian / USGS Weekly Volcanic Activity Report (an RSS feed, updated every Thursday), and
  - the USGS Volcano Hazards Program's alert levels for US volcanoes (live).
* Heat spots: NASA FIRMS satellite thermal detections (VIIRS), worldwide, updated every few hours. FIRMS needs a free map key,
  saved in Settings; without one this source is simply off. A detection can be a lava lake, a vent or a wildfire.

The background loops start when the app first asks and stop themselves after IDLE_STOP_S with nothing asking.
"""

import calendar
import csv
import gzip
import html
import io
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from defusedxml.ElementTree import fromstring as safe_fromstring  # replies come from the LAN / the internet: no entity tricks

from app.config import settings
from app.services import app_settings, log_capture
from app.services.deepspace import USER_AGENT

logger = log_capture.get_logger("hazards")

QUAKE_MONTH = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson"
QUAKE_HOUR = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
QUAKE_DAY = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"
QUAKE_CREDIT = "Earthquakes: USGS Earthquake Hazards Program"
VOLCANO_CATALOGUE = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/volcanolocs"
WEEKLY_RSS = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml"
USGS_ELEVATED = "https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes"
VOLCANO_CREDIT = "Volcanoes: NOAA NCEI volcano locations, Smithsonian / USGS Weekly Volcanic Activity Report, USGS Volcano Hazards Program"
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_NRT/world/1"
HEAT_CREDIT = "Heat spots: NASA FIRMS (VIIRS)"

IDLE_STOP_S = 20 * 60
QUAKE_POLL_S = 60
QUAKE_DAY_REFRESH_S = 30 * 60
QUAKE_KEEP_S = 31 * 86400
VOLCANO_REFRESH_S = 30 * 60
CATALOGUE_MAX_AGE_S = 30 * 86400
HEAT_REFRESH_S = 30 * 60
HEAT_MAX = 120_000

QUAKE_FIELDS = ["id", "t", "lat", "lon", "depth_km", "mag", "tsunami"]
VOLCANO_FIELDS = ["vnum", "lat", "lon", "level"]
HEAT_FIELDS = ["lat", "lon", "frp", "t"]

LEVEL_WORDS = {0: "No unusual activity reported", 1: "Unrest or advisory", 2: "Watch: heightened activity", 3: "Erupting or warning"}
# NOAA's "last eruption" class letters (the same classes the Smithsonian uses)
LAST_ERUPTION = {
    "D1": "1964 or later", "D2": "1900 to 1963", "D3": "1800 to 1899", "D4": "1700 to 1799", "D5": "1500 to 1699", "D6": "AD 1 to 1499",
    "D7": "before AD 1 (Holocene)", "U": "unknown", "Q": "Quaternary, no known Holocene eruption",
}


def _dir() -> Path:
    d = settings.deepspace_dir / "hazards"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get(url: str, timeout: float = 60.0, max_bytes: int = 80 * 1024 * 1024) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(max_bytes)
        if resp.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return body


class Hazards:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._threads: dict[str, threading.Thread] = {}
        # earthquakes: id -> {t, lat, lon, depth, mag, tsunami, place, url, mag_type, sig, alert, felt}
        self._quakes: dict[str, dict[str, Any]] = {}
        self._quake_updated: float | None = None
        # volcanoes
        self._catalogue: list[dict[str, Any]] = []
        self._vol_status: dict[int, dict[str, Any]] = {}
        self._vol_updated: float | None = None
        # heat
        self._heat: list[list[float]] = []
        self._heat_updated: float | None = None
        self.status: dict[str, Any] = {
            "quakes": {"ok": None, "count": 0, "error": None, "at": None},
            "volcanoes": {"ok": None, "count": 0, "error": None, "at": None},
            "heat": {"ok": None, "count": 0, "error": None, "at": None, "has_key": False},
        }

    # ---------------------------------------------------------------- lifecycle

    def _idle(self) -> bool:
        return time.time() - self._last_request > IDLE_STOP_S

    def touch(self, which: str) -> None:
        """Called on every request: the loop for `which` runs while it is being asked for."""
        self._last_request = time.time()
        target = {"quakes": self._run_quakes, "volcanoes": self._run_volcanoes, "heat": self._run_heat}[which]
        with self._lock:
            t = self._threads.get(which)
            if t is None or not t.is_alive():
                t = threading.Thread(target=target, name=f"hazards-{which}", daemon=True)
                self._threads[which] = t
                t.start()

    def _sleep(self, seconds: float) -> bool:
        """Sleep in small steps; False when the loop should end (nobody is asking any more)."""
        for _ in range(int(seconds)):
            if self._idle():
                return False
            time.sleep(1)
        return not self._idle()

    # ---------------------------------------------------------------- earthquakes

    def _merge_quakes(self, data: dict[str, Any]) -> int:
        n = 0
        for f in data.get("features", []):
            p = f.get("properties") or {}
            g = (f.get("geometry") or {}).get("coordinates") or []
            if len(g) < 3 or p.get("mag") is None or p.get("time") is None:
                continue
            if p.get("type") not in (None, "earthquake"):
                continue  # blasts, quarry events, ice quakes…
            if p.get("status") == "deleted":
                self._quakes.pop(f.get("id", ""), None)
                continue
            self._quakes[f["id"]] = {
                "t": int(p["time"]), "lat": float(g[1]), "lon": float(g[0]), "depth": float(g[2]), "mag": float(p["mag"]), "tsunami": int(p.get("tsunami") or 0),
                "place": p.get("place") or "", "url": p.get("url") or "", "mag_type": p.get("magType") or "", "sig": p.get("sig"), "alert": p.get("alert"), "felt": p.get("felt"),
            }
            n += 1
        return n

    def _prune_quakes(self) -> None:
        cutoff = (time.time() - QUAKE_KEEP_S) * 1000
        for k in [k for k, q in self._quakes.items() if q["t"] < cutoff]:
            del self._quakes[k]

    def _run_quakes(self) -> None:
        st = self.status["quakes"]
        cache = _dir() / "quakes_month.json"
        loaded_day = 0.0
        try:
            # a recent copy on disk saves the 7 MB download after a restart
            if cache.is_file() and time.time() - cache.stat().st_mtime < 15 * 60:
                with self._lock:
                    self._merge_quakes(json.loads(cache.read_text(encoding="utf-8")))
            else:
                body = _get(QUAKE_MONTH, timeout=120)
                cache.write_bytes(body)
                with self._lock:
                    self._merge_quakes(json.loads(body))
            self._quake_updated = time.time()
            loaded_day = time.time()
            st.update(ok=True, count=len(self._quakes), error=None, at=time.time())
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
            st.update(ok=False, error=str(getattr(e, "reason", e))[:120], at=time.time())
            logger.info("Hazards: could not load the month of earthquakes (%s)", e)
        while self._sleep(QUAKE_POLL_S):
            try:
                url = QUAKE_DAY if time.time() - loaded_day > QUAKE_DAY_REFRESH_S else QUAKE_HOUR
                data = json.loads(_get(url, timeout=40))
                with self._lock:
                    self._merge_quakes(data)
                    self._prune_quakes()
                if url == QUAKE_DAY:
                    loaded_day = time.time()
                self._quake_updated = time.time()
                st.update(ok=True, count=len(self._quakes), error=None, at=time.time())
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
                st.update(ok=False, error=str(getattr(e, "reason", e))[:120], at=time.time())

    def quakes(self, min_mag: float = 1.0, hours: float = 720.0) -> dict[str, Any]:
        self.touch("quakes")
        cutoff = (time.time() - hours * 3600) * 1000
        with self._lock:
            rows = [[k, q["t"], round(q["lat"], 3), round(q["lon"], 3), round(q["depth"], 1), q["mag"], q["tsunami"]] for k, q in self._quakes.items() if q["mag"] >= min_mag and q["t"] >= cutoff]
        rows.sort(key=lambda r: r[1], reverse=True)
        return {"fields": QUAKE_FIELDS, "rows": rows[:40_000], "updated_at": self._quake_updated, "status": self.status["quakes"], "credit": QUAKE_CREDIT}

    def recent_quakes(self, min_mag: float, hours: float, limit: int = 60, by: str = "time") -> dict[str, Any]:
        """The newest (or, with by="mag", the biggest) earthquakes with their place names, for the dashboard list."""
        self.touch("quakes")
        cutoff = (time.time() - hours * 3600) * 1000
        with self._lock:
            items = [{"id": k, **q} for k, q in self._quakes.items() if q["mag"] >= min_mag and q["t"] >= cutoff]
            total = len(items)
        items.sort(key=(lambda q: -q["mag"]) if by == "mag" else (lambda q: -q["t"]))
        keep = ("id", "t", "lat", "lon", "depth", "mag", "tsunami", "place", "alert", "felt")
        return {"quakes": [{k: q[k] for k in keep} for q in items[:limit]], "total": total, "updated_at": self._quake_updated, "status": self.status["quakes"], "credit": QUAKE_CREDIT}

    def quake(self, quake_id: str) -> dict[str, Any] | None:
        with self._lock:
            q = self._quakes.get(quake_id)
            return {"id": quake_id, **q} if q else None

    # ---------------------------------------------------------------- volcanoes

    def _load_catalogue(self) -> list[dict[str, Any]]:
        cache = _dir() / "volcano_catalogue.json"
        if cache.is_file() and time.time() - cache.stat().st_mtime < CATALOGUE_MAX_AGE_S:
            try:
                return json.loads(cache.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        items: list[dict[str, Any]] = []
        page, pages = 1, 1
        while page <= pages:
            d = json.loads(_get(f"{VOLCANO_CATALOGUE}?page={page}", timeout=40))
            pages = int(d.get("totalPages") or 1)
            for v in d.get("items", []):
                if v.get("latitude") is None or v.get("longitude") is None or not v.get("newNum"):
                    continue
                items.append({"vnum": int(v["newNum"]), "name": v.get("name") or "", "country": v.get("country") or "", "lat": float(v["latitude"]), "lon": float(v["longitude"]),
                              "elevation": v.get("elevation"), "type": v.get("morphology") or "", "last": v.get("timeErupt") or ""})
            page += 1
        if len(items) < 500:
            raise ValueError("the volcano list came back short")
        cache.write_text(json.dumps(items, separators=(",", ":")), encoding="utf-8")
        return items

    @staticmethod
    def _parse_weekly(body: bytes) -> dict[int, dict[str, Any]]:
        out: dict[int, dict[str, Any]] = {}
        root = safe_fromstring(body.decode("cp1252", "replace").replace("encoding=\"ISO-8859-1\"", "").encode("utf-8"))
        for item in root.iter("item"):
            title = item.findtext("title") or ""
            guid = item.findtext("guid") or ""
            m = re.search(r"vn_(\d+)", guid)
            if not m:
                continue
            parts = title.split(" - ")
            category = parts[-1].strip() if len(parts) >= 3 else ""
            report = parts[1].replace("Report for ", "").strip() if len(parts) >= 3 else ""
            text = html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(item.findtext("description") or "")))
            out[int(m.group(1))] = {
                "category": category, "report": report, "summary": re.sub(r"\s+", " ", text).strip(),
                "level": 3 if "Eruptive" in category else 1,
            }
        return out

    def _load_volcano_status(self) -> dict[int, dict[str, Any]]:
        status: dict[int, dict[str, Any]] = {}
        try:
            for vnum, s in self._parse_weekly(_get(WEEKLY_RSS, timeout=40)).items():
                status[vnum] = {**s, "weekly": True}
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ET.ParseError) as e:
            logger.info("Hazards: could not read the weekly volcano report (%s)", e)
        try:
            for v in json.loads(_get(USGS_ELEVATED, timeout=40)):
                if not v.get("vnum"):
                    continue
                code = str(v.get("color_code") or "").upper()
                lvl = {"YELLOW": 1, "ORANGE": 2, "RED": 3}.get(code, 0)
                if lvl == 0:
                    continue
                cur = status.setdefault(int(v["vnum"]), {"level": 0})
                cur.update(usgs_color=code, usgs_level=str(v.get("alert_level") or ""), usgs_observatory=v.get("obs_fullname") or "", usgs_url=v.get("notice_url") or "",
                           usgs_sent=v.get("sent_unixtime"))
                cur["level"] = max(cur.get("level", 0), lvl)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
            logger.info("Hazards: could not read the USGS volcano alerts (%s)", e)
        return status

    def _run_volcanoes(self) -> None:
        st = self.status["volcanoes"]
        while True:
            try:
                if not self._catalogue:
                    self._catalogue = self._load_catalogue()
                status = self._load_volcano_status()
                with self._lock:
                    self._vol_status = status
                self._vol_updated = time.time()
                st.update(ok=True, count=len(self._catalogue), error=None, at=time.time())
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
                st.update(ok=False, error=str(getattr(e, "reason", e))[:120], at=time.time())
                logger.info("Hazards: volcano data failed (%s)", e)
            if not self._sleep(VOLCANO_REFRESH_S if st["ok"] else 60):
                return

    def volcanoes(self) -> dict[str, Any]:
        self.touch("volcanoes")
        with self._lock:
            cat, status = list(self._catalogue), dict(self._vol_status)
        rows = [[v["vnum"], round(v["lat"], 3), round(v["lon"], 3), (status.get(v["vnum"]) or {}).get("level", 0)] for v in cat]
        active = []
        by_vnum = {v["vnum"]: v for v in cat}
        for vnum, s in status.items():
            v = by_vnum.get(vnum)
            if v:
                active.append({"vnum": vnum, "name": v["name"], "country": v["country"], "lat": v["lat"], "lon": v["lon"], "level": s.get("level", 0), "category": s.get("category", ""),
                               "usgs_color": s.get("usgs_color", ""), "usgs_level": s.get("usgs_level", ""), "summary": (s.get("summary") or "")[:400]})
        active.sort(key=lambda a: (-a["level"], a["name"]))
        return {"fields": VOLCANO_FIELDS, "rows": rows, "active": active, "updated_at": self._vol_updated, "status": self.status["volcanoes"], "credit": VOLCANO_CREDIT}

    def volcano(self, vnum: int) -> dict[str, Any] | None:
        with self._lock:
            v = next((x for x in self._catalogue if x["vnum"] == vnum), None)
            s = self._vol_status.get(vnum) or {}
            heat = list(self._heat)
        if v is None:
            return None
        near = 0
        for h in heat:
            if abs(h[0] - v["lat"]) < 0.06 and abs(h[1] - v["lon"]) < 0.06 / max(0.2, math.cos(math.radians(v["lat"]))) and _km(v["lat"], v["lon"], h[0], h[1]) <= 5:
                near += 1
        return {
            **v, "level": s.get("level", 0), "level_words": LEVEL_WORDS.get(s.get("level", 0), ""), "last_eruption": LAST_ERUPTION.get(v["last"], v["last"] or "unknown"),
            "category": s.get("category", ""), "report": s.get("report", ""), "summary": s.get("summary", ""), "usgs_color": s.get("usgs_color", ""), "usgs_level": s.get("usgs_level", ""),
            "usgs_observatory": s.get("usgs_observatory", ""), "usgs_url": s.get("usgs_url", ""), "heat_within_5km": near if heat else None,
            "url": f"https://volcano.si.edu/volcano.cfm?vn={vnum}",
        }

    # ---------------------------------------------------------------- heat spots (NASA FIRMS)

    @staticmethod
    def _parse_heat(text: str) -> list[list[float]]:
        """FIRMS VIIRS CSV rows as [lat, lon, fire radiative power (MW), time (s since 1970)]; low-confidence detections are left out."""
        out: list[list[float]] = []
        for r in csv.DictReader(io.StringIO(text)):
            try:
                if (r.get("confidence") or "n").strip().lower() in ("l", "low"):
                    continue
                hhmm = (r.get("acq_time") or "0000").zfill(4)
                t = calendar.timegm(time.strptime(f"{r['acq_date']} {hhmm}", "%Y-%m-%d %H%M"))
                out.append([round(float(r["latitude"]), 3), round(float(r["longitude"]), 3), round(float(r.get("frp") or 0), 1), int(t)])
            except (KeyError, ValueError):
                continue
        return out

    def _run_heat(self) -> None:
        st = self.status["heat"]
        while True:
            key = app_settings.get_firms_key()
            st["has_key"] = bool(key)
            if key:
                try:
                    text = _get(FIRMS_URL.format(key=urllib.parse.quote(key)), timeout=120).decode("utf-8", "replace")
                    if "latitude" not in text[:200]:
                        raise ValueError(text.strip()[:100] or "FIRMS sent an unexpected answer")
                    rows = self._parse_heat(text)
                    rows.sort(key=lambda r: -r[2])
                    with self._lock:
                        self._heat = rows[:HEAT_MAX]
                    self._heat_updated = time.time()
                    st.update(ok=True, count=len(rows), error=None, at=time.time())
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as e:
                    st.update(ok=False, error=str(getattr(e, "reason", e))[:120], at=time.time())
                    logger.info("Hazards: FIRMS failed (%s)", e)
            else:
                with self._lock:
                    self._heat = []
                st.update(ok=None, count=0, error=None)
            if not self._sleep(HEAT_REFRESH_S if key and st["ok"] else 60):
                return

    def heat(self) -> dict[str, Any]:
        self.touch("heat")
        with self._lock:
            rows = list(self._heat)
        return {"fields": HEAT_FIELDS, "rows": rows, "updated_at": self._heat_updated, "status": self.status["heat"], "has_key": bool(app_settings.get_firms_key()), "credit": HEAT_CREDIT}


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


hazards = Hazards()
