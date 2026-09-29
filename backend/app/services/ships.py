"""Live ships (AIS) for the 3D Earth in Deep Space, like the aircraft layer.

Every large ship broadcasts its identity, position, speed and course over AIS. Two sources feed this module:

* Digitraffic (Finnish Transport Infrastructure Agency): free open AIS for the Baltic Sea and the Finnish coast. No sign-up,
  polled once a minute. It is what works out of the box.
* aisstream.io: worldwide AIS over a WebSocket, free with an API key the user pastes into Settings. Its coverage is the
  world's coastal receivers and some satellites, so open ocean is patchy. Used only when a key is saved.

Both start when the app first asks for ships and stop themselves after IDLE_STOP_S with no request, so nothing runs in the
background unless the ship layer is being looked at. Positions are kept in memory (a restart begins again, which takes a minute).
"""

import asyncio
import gzip
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from app.services import app_settings, log_capture
from app.services.deepspace import USER_AGENT

logger = log_capture.get_logger("ships")

DIGITRAFFIC_LOCATIONS = "https://meri.digitraffic.fi/api/ais/v1/locations"
DIGITRAFFIC_VESSELS = "https://meri.digitraffic.fi/api/ais/v1/vessels"
DIGITRAFFIC_CREDIT = "Baltic ships: Digitraffic / Fintraffic (CC BY 4.0)"
AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
AISSTREAM_CREDIT = "Worldwide ships: aisstream.io (AIS)"

IDLE_STOP_S = 15 * 60
POLL_S = 60
STATIC_REFRESH_S = 30 * 60
MOVING_MAX_AGE_S = 30 * 60  # a position older than this for a moving ship is dropped
MOORED_MAX_AGE_S = 3 * 3600
MAX_SHIPS = 250_000
FIELDS = ["mmsi", "lat", "lon", "sog_kn", "cog", "cat", "t"]

# Categories for the colours on the globe
CAT_OTHER, CAT_CARGO, CAT_TANKER, CAT_PASSENGER, CAT_FISHING, CAT_PLEASURE = 0, 1, 2, 3, 4, 5
CAT_NAMES = {CAT_OTHER: "Other", CAT_CARGO: "Cargo ship", CAT_TANKER: "Tanker", CAT_PASSENGER: "Passenger ship", CAT_FISHING: "Fishing vessel", CAT_PLEASURE: "Pleasure craft"}


def category(ship_type: int | None) -> int:
    """The app's six ship categories from an AIS ship-type number."""
    t = ship_type or 0
    if 70 <= t <= 79:
        return CAT_CARGO
    if 80 <= t <= 89:
        return CAT_TANKER
    if 60 <= t <= 69 or 40 <= t <= 49:
        return CAT_PASSENGER
    if t == 30:
        return CAT_FISHING
    if t in (36, 37):
        return CAT_PLEASURE
    return CAT_OTHER


TYPE_WORDS = {
    20: "Wing-in-ground craft", 30: "Fishing vessel", 31: "Tug (towing)", 32: "Tug (towing, large)", 33: "Dredger", 34: "Diving vessel", 35: "Naval vessel",
    36: "Sailing vessel", 37: "Pleasure craft", 50: "Pilot vessel", 51: "Search and rescue vessel", 52: "Tug", 53: "Port tender", 54: "Anti-pollution vessel",
    55: "Law enforcement vessel", 58: "Medical transport", 59: "Special craft",
}


def type_words(ship_type: int | None) -> str:
    t = ship_type or 0
    if t in TYPE_WORDS:
        return TYPE_WORDS[t]
    if 40 <= t <= 49:
        return "High-speed craft"
    if 60 <= t <= 69:
        return "Passenger ship"
    if 70 <= t <= 79:
        return "Cargo ship"
    if 80 <= t <= 89:
        return "Tanker"
    if 90 <= t <= 99:
        return "Other vessel"
    return "Vessel"


# Maritime Identification Digits (the first three digits of an MMSI) to a country
_MID_GROUPS = {
    "Albania": "201", "Andorra": "202", "Austria": "203", "Portugal": "204 263 255 204", "Belgium": "205", "Belarus": "206", "Bulgaria": "207", "Cyprus": "209 210 212",
    "Germany": "211 218", "Georgia": "213", "Moldova": "214", "Malta": "215 229 248 249 256", "Armenia": "216", "Denmark": "219 220", "Spain": "224 225",
    "France": "226 227 228", "Finland": "230", "Faroe Islands": "231", "United Kingdom": "232 233 234 235", "Gibraltar": "236", "Greece": "237 239 240 241",
    "Croatia": "238", "Morocco": "242", "Hungary": "243", "Netherlands": "244 245 246", "Italy": "247", "Ireland": "250", "Iceland": "251", "Luxembourg": "253",
    "Monaco": "254", "Norway": "257 258 259", "Poland": "261", "Montenegro": "262", "Romania": "264", "Sweden": "265 266", "Slovakia": "267", "Switzerland": "269",
    "Czechia": "270", "Turkey": "271", "Ukraine": "272", "Russia": "273", "North Macedonia": "274", "Latvia": "275", "Estonia": "276", "Lithuania": "277",
    "Slovenia": "278", "Serbia": "279", "Antigua and Barbuda": "304 305", "Bahamas": "308 309 311", "Bermuda": "310", "Belize": "312", "Barbados": "314",
    "Canada": "316", "Cayman Islands": "319", "Costa Rica": "321", "Cuba": "323", "Dominican Republic": "327", "Greenland": "331", "Jamaica": "339", "Mexico": "345",
    "United States": "303 338 366 367 368 369", "Panama": "351 352 353 354 355 356 357 370 371 372 373 374", "Saint Vincent": "375 376 377", "Trinidad and Tobago": "362",
    "Bahrain": "408", "Saudi Arabia": "403", "Bangladesh": "405", "China": "412 413 414", "Taiwan": "416", "Sri Lanka": "417", "India": "419", "Iran": "422",
    "Azerbaijan": "423", "Iraq": "425", "Israel": "428", "Japan": "431 432", "Kazakhstan": "436", "Jordan": "438", "South Korea": "440 441", "North Korea": "445",
    "Kuwait": "447", "Lebanon": "450", "Oman": "461", "Pakistan": "463", "Qatar": "466", "Syria": "468", "United Arab Emirates": "470 471", "Yemen": "473 475",
    "Hong Kong": "477", "Bosnia and Herzegovina": "478", "Australia": "503", "Myanmar": "506", "Brunei": "508", "New Zealand": "512", "Cambodia": "514 515",
    "Fiji": "520", "Indonesia": "525", "Kiribati": "529", "Laos": "531", "Malaysia": "533", "Marshall Islands": "538", "Philippines": "548", "Papua New Guinea": "553",
    "Singapore": "563 564 565 566", "Thailand": "567", "Vietnam": "574", "Vanuatu": "576 577", "South Africa": "601", "Angola": "603", "Algeria": "605",
    "Cape Verde": "617", "Ivory Coast": "619", "Egypt": "622", "Ethiopia": "624", "Eritrea": "625", "Gabon": "626", "Ghana": "627", "Kenya": "634", "Liberia": "636 637",
    "Libya": "642", "Mauritius": "645", "Madagascar": "647", "Mozambique": "650", "Mauritania": "654", "Nigeria": "657", "Namibia": "659", "Senegal": "663",
    "Seychelles": "664", "Somalia": "666", "Tanzania": "674 677", "Tunisia": "672", "Togo": "671", "Argentina": "701", "Brazil": "710", "Chile": "725", "Colombia": "730",
    "Ecuador": "735", "Guyana": "750", "Peru": "760", "Uruguay": "770", "Venezuela": "775",
}
_MID = {int(mid): country for country, mids in _MID_GROUPS.items() for mid in mids.split()}


def flag_of(mmsi: int) -> str:
    return _MID.get(mmsi // 1_000_000, "") if mmsi >= 200_000_000 else ""


def _http_json(url: str, timeout: float = 40.0) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read(60 * 1024 * 1024)
        if resp.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return json.loads(body)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


class Feed:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ships: dict[int, dict[str, Any]] = {}
        self._static: dict[int, dict[str, Any]] = {}
        self._last_request = 0.0
        self._digi_thread: threading.Thread | None = None
        self._ais_thread: threading.Thread | None = None
        self._ais_key = ""
        self._stop_ais = threading.Event()
        self.status: dict[str, Any] = {
            "digitraffic": {"ok": None, "ships": 0, "error": None, "at": None},
            "aisstream": {"connected": False, "messages": 0, "error": None, "at": None},
        }

    # ---------------------------------------------------------------- lifecycle

    def _idle(self) -> bool:
        return time.time() - self._last_request > IDLE_STOP_S

    def touch(self) -> None:
        """Called on every request: makes sure the feeds are running."""
        self._last_request = time.time()
        with self._lock:
            if self._digi_thread is None or not self._digi_thread.is_alive():
                self._digi_thread = threading.Thread(target=self._run_digitraffic, name="ships-digitraffic", daemon=True)
                self._digi_thread.start()
            key = app_settings.get_aisstream_key()
            if key and key != self._ais_key and self._ais_thread is not None:
                self._stop_ais.set()  # a new key: restart the connection with it
                self._ais_thread = None
            if key and (self._ais_thread is None or not self._ais_thread.is_alive()):
                self._ais_key = key
                self._stop_ais = threading.Event()
                self._ais_thread = threading.Thread(target=self._run_aisstream, args=(key, self._stop_ais), name="ships-aisstream", daemon=True)
                self._ais_thread.start()
            if not key and self._ais_thread is not None:
                self._stop_ais.set()
                self._ais_thread = None
                self._ais_key = ""
                self.status["aisstream"].update(connected=False, error=None)

    # ---------------------------------------------------------------- data

    def _put(self, mmsi: int, lat: float, lon: float, sog: float | None, cog: float | None, hdg: float | None, t: float, src: str) -> None:
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0) or mmsi <= 0:
            return
        with self._lock:
            s = self._ships.get(mmsi)
            if s is None:
                if len(self._ships) >= MAX_SHIPS:
                    return
                s = self._ships[mmsi] = {}
            s.update(lat=lat, lon=lon, sog=sog if sog is not None and sog < 102 else 0.0, cog=cog if cog is not None and cog < 360 else None,
                     hdg=hdg if hdg is not None and hdg < 360 else None, t=t, src=src)

    def _put_static(self, mmsi: int, **kw: Any) -> None:
        clean = {k: v for k, v in kw.items() if v not in (None, "", 0)}
        if not clean:
            return
        with self._lock:
            self._static.setdefault(mmsi, {}).update(clean)

    def _prune(self) -> None:
        now = time.time()
        with self._lock:
            for m in [m for m, s in self._ships.items() if now - s["t"] > (MOORED_MAX_AGE_S if (s["sog"] or 0) < 0.5 else MOVING_MAX_AGE_S)]:
                del self._ships[m]

    # ---------------------------------------------------------------- Digitraffic (Baltic, no key)

    def _run_digitraffic(self) -> None:
        meta_at = 0.0
        while not self._idle():
            st = self.status["digitraffic"]
            try:
                data = _http_json(DIGITRAFFIC_LOCATIONS)
                n = 0
                for f in data.get("features", []):
                    p = f.get("properties", {})
                    c = f.get("geometry", {}).get("coordinates")
                    if not c or len(c) < 2:
                        continue
                    t = (p.get("timestampExternal") or 0) / 1000 or time.time()
                    self._put(int(f.get("mmsi") or p.get("mmsi") or 0), float(c[1]), float(c[0]), _num(p.get("sog")), _num(p.get("cog")), _num(p.get("heading")), t, "digitraffic")
                    n += 1
                st.update(ok=True, ships=n, error=None, at=time.time())
                if time.time() - meta_at > STATIC_REFRESH_S:
                    for v in _http_json(DIGITRAFFIC_VESSELS, timeout=90):
                        a, b, c, d = (v.get(k) or 0 for k in ("referencePointA", "referencePointB", "referencePointC", "referencePointD"))
                        self._put_static(int(v["mmsi"]), name=(v.get("name") or "").strip(), type=v.get("shipType"), dest=(v.get("destination") or "").strip(),
                                         length=a + b, beam=c + d, imo=v.get("imo"), callsign=(v.get("callSign") or "").strip(), draught=(v.get("draught") or 0) / 10)
                    meta_at = time.time()
                self._prune()
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError, KeyError) as e:
                st.update(ok=False, error=str(getattr(e, "reason", e))[:120], at=time.time())
                logger.info("Ships: Digitraffic failed (%s)", e)
            for _ in range(POLL_S):
                if self._idle():
                    return
                time.sleep(1)

    # ---------------------------------------------------------------- aisstream.io (worldwide, with a key)

    def _run_aisstream(self, key: str, stop: threading.Event) -> None:
        try:
            asyncio.run(self._ais_main(key, stop))
        except Exception as e:  # noqa: BLE001 - a background collector must never take the app down
            logger.info("Ships: aisstream loop ended (%s)", e)
            self.status["aisstream"].update(connected=False, error=str(e)[:120])

    async def _ais_main(self, key: str, stop: threading.Event) -> None:
        import websockets

        st = self.status["aisstream"]
        pause = 3.0
        last_prune = time.time()
        while not stop.is_set() and not self._idle():
            try:
                async with websockets.connect(AISSTREAM_URL, open_timeout=15, max_size=2**21) as ws:
                    await ws.send(json.dumps({
                        "APIKey": key,
                        "BoundingBoxes": [[[-90, -180], [90, 180]]],
                        "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
                    }))
                    st.update(connected=True, error=None)
                    pause = 3.0
                    while not stop.is_set() and not self._idle():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=5)
                        except asyncio.TimeoutError:
                            continue
                        msg = json.loads(raw)
                        if "error" in msg:
                            st.update(connected=False, error=str(msg["error"])[:120])
                            return
                        self._on_ais(msg)
                        st["messages"] += 1
                        st["at"] = time.time()
                        if time.time() - last_prune > 60:
                            last_prune = time.time()
                            self._prune()
            except Exception as e:  # noqa: BLE001
                text = str(e)
                if st["messages"] == 0 and ("close frame" in text or "1008" in text or "403" in text or "401" in text):
                    text = "aisstream.io refused the connection: check that the API key is right"
                st.update(connected=False, error=text[:120])
                logger.info("Ships: aisstream connection lost (%s)", e)
            if stop.is_set():
                break
            await asyncio.sleep(min(pause, 60.0))
            pause *= 2
        st["connected"] = False

    def _on_ais(self, msg: dict[str, Any]) -> None:
        kind = msg.get("MessageType")
        meta = msg.get("MetaData") or {}
        body = (msg.get("Message") or {}).get(kind) or {}
        mmsi = int(meta.get("MMSI") or body.get("UserID") or 0)
        if not mmsi:
            return
        if kind in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
            lat, lon = _num(meta.get("latitude") if meta.get("latitude") is not None else body.get("Latitude")), _num(meta.get("longitude") if meta.get("longitude") is not None else body.get("Longitude"))
            if lat is None or lon is None:
                return
            self._put(mmsi, lat, lon, _num(body.get("Sog")), _num(body.get("Cog")), _num(body.get("TrueHeading")), time.time(), "aisstream")
            name = (meta.get("ShipName") or "").strip()
            if name:
                self._put_static(mmsi, name=name)
            if kind == "ExtendedClassBPositionReport":
                self._put_static(mmsi, type=body.get("Type"))
        elif kind == "ShipStaticData":
            dim = body.get("Dimension") or {}
            self._put_static(mmsi, name=(body.get("Name") or meta.get("ShipName") or "").strip(), type=body.get("Type"), dest=(body.get("Destination") or "").strip(),
                             length=(dim.get("A") or 0) + (dim.get("B") or 0), beam=(dim.get("C") or 0) + (dim.get("D") or 0), imo=body.get("ImoNumber"),
                             callsign=(body.get("CallSign") or "").strip(), draught=body.get("MaximumStaticDraught"))
        elif kind == "StaticDataReport":
            a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
            dim = b.get("Dimension") or {}
            self._put_static(mmsi, name=(a.get("Name") or meta.get("ShipName") or "").strip(), type=b.get("ShipType"), callsign=(b.get("CallSign") or "").strip(),
                             length=(dim.get("A") or 0) + (dim.get("B") or 0), beam=(dim.get("C") or 0) + (dim.get("D") or 0))

    # ---------------------------------------------------------------- what the app asks for

    def world(self) -> dict[str, Any]:
        self.touch()
        with self._lock:
            ships = list(self._ships.items())
            static = self._static
            rows = []
            for mmsi, s in ships:
                cat = category((static.get(mmsi) or {}).get("type"))
                course = s["hdg"] if s["hdg"] is not None and (s["sog"] or 0) < 1.0 else (s["cog"] if s["cog"] is not None else (s["hdg"] or 0))
                rows.append([mmsi, round(s["lat"], 5), round(s["lon"], 5), round(s["sog"] or 0, 1), round(course, 0), cat, int(s["t"])])
        return {
            "fields": FIELDS,
            "rows": rows,
            "fetched_at": time.time(),
            "has_key": bool(app_settings.get_aisstream_key()),
            "sources": {"digitraffic": self.status["digitraffic"], "aisstream": self.status["aisstream"]},
            "credit": DIGITRAFFIC_CREDIT + (" · " + AISSTREAM_CREDIT if app_settings.get_aisstream_key() else ""),
        }

    def ship(self, mmsi: int) -> dict[str, Any] | None:
        with self._lock:
            s = self._ships.get(mmsi)
            st = dict(self._static.get(mmsi) or {})
            if s is None and not st:
                return None
            pos = dict(s) if s else {}
        t = st.get("type")
        return {
            "mmsi": mmsi,
            "name": st.get("name") or "",
            "type_words": type_words(t) if t else "Vessel",
            "cat": category(t),
            "flag": flag_of(mmsi),
            "destination": st.get("dest") or "",
            "length_m": st.get("length") or None,
            "beam_m": st.get("beam") or None,
            "draught_m": st.get("draught") or None,
            "imo": st.get("imo") or None,
            "callsign": st.get("callsign") or "",
            "lat": pos.get("lat"),
            "lon": pos.get("lon"),
            "sog_kn": pos.get("sog"),
            "cog": pos.get("cog"),
            "heading": pos.get("hdg"),
            "t": pos.get("t"),
        }

    def search(self, q: str, limit: int = 20) -> list[dict[str, Any]]:
        self.touch()
        q = q.strip().lower()
        if len(q) < 3:
            return []
        out: list[dict[str, Any]] = []
        with self._lock:
            for mmsi, st in self._static.items():
                s = self._ships.get(mmsi)
                if s is None:
                    continue
                if q in (st.get("name") or "").lower() or q in str(mmsi):
                    out.append({"mmsi": mmsi, "name": st.get("name") or str(mmsi), "cat": category(st.get("type")), "lat": s["lat"], "lon": s["lon"]})
                    if len(out) >= limit:
                        break
            if len(out) < limit and q.isdigit():
                for mmsi, s in self._ships.items():
                    if q in str(mmsi) and not any(o["mmsi"] == mmsi for o in out):
                        out.append({"mmsi": mmsi, "name": str(mmsi), "cat": category(None), "lat": s["lat"], "lon": s["lon"]})
                        if len(out) >= limit:
                            break
        return out


feed = Feed()
