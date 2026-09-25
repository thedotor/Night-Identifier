import datetime as dt
import logging

from sqlalchemy import delete, func, select

from app.db import SessionLocal
from app.models.log_entry import LogEntry
from app.services import events

MAX_ENTRIES = 2000
_PRUNE_EVERY = 50
_write_count = 0


class DbLogHandler(logging.Handler):
    """Persists log records to SQLite and broadcasts them to the Log page's
    WebSocket. Never allowed to raise -- a logging failure must not crash
    whatever code triggered the log call.
    """

    def emit(self, record: logging.LogRecord) -> None:
        global _write_count
        try:
            message = self.format(record)
            db = SessionLocal()
            try:
                entry = LogEntry(
                    timestamp=dt.datetime.utcfromtimestamp(record.created),
                    level=record.levelname,
                    source=record.name,
                    message=message,
                )
                db.add(entry)
                db.commit()
                db.refresh(entry)
                events.emit_threadsafe(
                    "logs",
                    {
                        "id": entry.id,
                        "timestamp": entry.timestamp.isoformat(),
                        "level": entry.level,
                        "source": entry.source,
                        "message": entry.message,
                    },
                )
                _write_count += 1
                if _write_count % _PRUNE_EVERY == 0:
                    _prune(db)
            finally:
                db.close()
        except Exception:  # noqa: BLE001
            pass


def _prune(db) -> None:
    total = db.scalar(select(func.count()).select_from(LogEntry))
    if total is None or total <= MAX_ENTRIES:
        return
    cutoff_id = db.scalar(
        select(LogEntry.id).order_by(LogEntry.id.desc()).offset(MAX_ENTRIES).limit(1)
    )
    if cutoff_id is not None:
        db.execute(delete(LogEntry).where(LogEntry.id <= cutoff_id))
        db.commit()


def install() -> None:
    handler = DbLogHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.setLevel(logging.INFO)

    app_logger = logging.getLogger("app")
    app_logger.setLevel(logging.INFO)
    app_logger.addHandler(handler)

    # Surface uvicorn's own lifecycle/error logs too, but not every access log line.
    logging.getLogger("uvicorn.error").addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"app.{name}")
