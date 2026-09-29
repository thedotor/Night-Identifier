"""Live lightning strikes from the Blitzortung network (blitzortung.org).

Blitzortung is a volunteer network of small lightning receivers whose reports are combined into one stream
of located strikes. Its public web map reads that stream over a WebSocket; this module does the same from the
backend (so the renderer never talks to the internet), keeps the last hour of strikes in memory, and serves
them incrementally to the app.

The data are for private, non-commercial use, and the app says where they come from. Coverage is best over
Europe, North America, Australia and Japan and thinner over oceans and parts of Africa: it counts strikes
the network heard, not every strike that happened.

The feed is unofficial, so everything here fails soft: a server that does not answer (some have certificate
trouble from time to time) is skipped for the next, a dropped connection is retried with a growing pause, and
the strikes already collected stay available.

The stream's messages are text compressed with a small LZW-style scheme; `decode` undoes it.
"""

import asyncio
import collections
import json
import threading
import time
from typing import Any

from app.services import log_capture

logger = log_capture.get_logger("lightning")

SERVERS = ["ws1", "ws7", "ws8", "ws2", "ws3"]
ORIGIN = "https://www.blitzortung.org"
CREDIT = "Lightning: Blitzortung.org contributors (blitzortung.org), private non-commercial use"
HISTORY_S = 3600
MAX_ROWS = 300_000
SILENCE_RECONNECT_S = 60  # a connection that has said nothing for this long is dropped and remade
FIELDS = ["seq", "t_ms", "lat", "lon", "polarity", "stations", "accuracy_m"]


def decode(text: str) -> str:
    """Blitzortung's message compression (LZW over characters: codes above 255 refer to earlier phrases)."""
    if not text:
        return text
    table: dict[int, str] = {}
    chars = list(text)
    cur = chars[0]
    old = cur
    out = [cur]
    code = 256
    for ch in chars[1:]:
        c = ord(ch)
        phrase = ch if c < 256 else (table.get(c) or (old + cur))
        out.append(phrase)
        cur = phrase[0]
        table[code] = old + cur
        code += 1
        old = phrase
    return "".join(out)


class Collector:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: collections.deque[tuple[int, int, float, float, int, int, int]] = collections.deque()
        self._seq = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._enabled = True
        self._server: str | None = None
        self._connected_at: float | None = None
        self._last_msg_at: float | None = None
        self._error: str | None = None
        self._received = 0
        self._good = 0  # index in SERVERS of the last one that worked

    # ---- control ----------------------------------------------------------------------
    def start(self, enabled: bool = True) -> None:
        self._enabled = enabled
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="lightning", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        if enabled:
            self.start(True)

    @property
    def enabled(self) -> bool:
        return self._enabled

    # ---- the buffer -------------------------------------------------------------------
    def add(self, strike: dict[str, Any], received_at: float | None = None) -> None:
        now = received_at if received_at is not None else time.time()
        try:
            t_ms = int(float(strike["time"]) / 1e6)
            lat = float(strike["lat"])
            lon = float(strike["lon"])
        except (KeyError, TypeError, ValueError):
            return
        if abs(lat) > 90 or abs(lon) > 180:
            return
        if not (now * 1000 - HISTORY_S * 1000 < t_ms < now * 1000 + 60_000):
            t_ms = int(now * 1000)  # a clock that is wrong somewhere: date it by when it arrived
        sig = strike.get("sig")
        row = (0, t_ms, round(lat, 4), round(lon, 4), int(strike.get("pol") or 0), len(sig) if isinstance(sig, list) else 0, int(strike.get("mds") or 0))
        with self._lock:
            self._seq += 1
            self._rows.append((self._seq, *row[1:]))
            cutoff = now * 1000 - HISTORY_S * 1000
            while self._rows and (self._rows[0][1] < cutoff or len(self._rows) > MAX_ROWS):
                self._rows.popleft()
            self._received += 1
            self._last_msg_at = now

    def strikes(self, since: int = 0, max_age_s: float = 600.0, limit: int = 80_000) -> dict[str, Any]:
        """Strikes newer than sequence number `since` and no older than `max_age_s`, oldest first (see FIELDS)."""
        cutoff = (time.time() - min(max_age_s, HISTORY_S)) * 1000
        out: list[list[Any]] = []
        with self._lock:
            latest = self._seq
            for r in reversed(self._rows):
                if r[0] <= since or r[1] < cutoff or len(out) >= limit:
                    break
                out.append(list(r))
        out.reverse()
        return {"fields": FIELDS, "rows": out, "seq": latest, "credit": CREDIT}

    def status(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            n60 = n300 = 0
            for r in reversed(self._rows):
                age = now - r[1] / 1000
                if age > 300:
                    break
                n300 += 1
                if age <= 60:
                    n60 += 1
            held = len(self._rows)
            last = self._rows[-1][1] / 1000 if self._rows else None
        return {
            "enabled": self._enabled,
            "connected": self._connected_at is not None and self._last_msg_at is not None and now - self._last_msg_at < SILENCE_RECONNECT_S,
            "server": self._server,
            "per_minute": n60,
            "per_minute_5m": round(n300 / 5.0, 1),
            "held": held,
            "seq": self._seq,
            "last_strike_age_s": None if last is None else round(now - last, 1),
            "error": self._error,
            "credit": CREDIT,
        }

    # ---- the connection ---------------------------------------------------------------
    def _run(self) -> None:
        try:
            asyncio.run(self._main())
        except Exception:  # noqa: BLE001 - the collector must never take the backend down
            logger.exception("Lightning collector stopped")

    async def _main(self) -> None:
        import websockets  # imported here: only the collector needs it

        pause = 2.0
        attempt = 0
        while not self._stop.is_set():
            if not self._enabled:
                self._connected_at = None
                await asyncio.sleep(1.0)
                continue
            host = SERVERS[(self._good + attempt) % len(SERVERS)]
            try:
                async with websockets.connect(f"wss://{host}.blitzortung.org/", origin=ORIGIN, open_timeout=12, max_size=2**20) as ws:
                    await ws.send(json.dumps({"a": 111}))
                    self._server = host
                    self._connected_at = time.time()
                    self._error = None
                    self._good = (self._good + attempt) % len(SERVERS)
                    attempt = 0
                    pause = 2.0
                    logger.info("Lightning: connected to %s", host)
                    last_heard = time.time()
                    while not self._stop.is_set() and self._enabled:
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=5)
                        except asyncio.TimeoutError:
                            if time.time() - last_heard > SILENCE_RECONNECT_S:
                                raise ConnectionError("no strikes for a minute") from None
                            continue
                        last_heard = time.time()
                        try:
                            strike = json.loads(decode(msg if isinstance(msg, str) else msg.decode("utf-8", "replace")))
                        except ValueError:
                            continue
                        if isinstance(strike, dict):
                            self.add(strike)
            except Exception as e:  # noqa: BLE001 - network, certificate and protocol trouble all mean "try the next server"
                self._connected_at = None
                self._error = f"{host}: {type(e).__name__}" + (f" ({str(e)[:80]})" if str(e) else "")
                logger.info("Lightning: %s", self._error)
                attempt += 1
                await asyncio.sleep(min(pause, 60.0))
                pause = min(pause * 1.6, 60.0) if attempt >= len(SERVERS) else pause
            else:
                self._connected_at = None


collector = Collector()
