from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.log_entry import LogEntry
from app.services import events

router = APIRouter(prefix="/logs", tags=["logs"])


class LogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    timestamp: str
    level: str
    source: str
    message: str

    @staticmethod
    def from_orm_entry(entry: LogEntry) -> "LogEntryOut":
        return LogEntryOut(
            id=entry.id,
            timestamp=entry.timestamp.isoformat(),
            level=entry.level,
            source=entry.source,
            message=entry.message,
        )


@router.get("", response_model=list[LogEntryOut])
def list_logs(
    level: str | None = Query(default=None),
    limit: int = Query(default=300, le=2000),
    db: Session = Depends(get_db),
) -> list[LogEntryOut]:
    stmt = select(LogEntry).order_by(LogEntry.id.desc()).limit(limit)
    if level:
        stmt = stmt.where(LogEntry.level == level.upper())
    entries = list(db.scalars(stmt))
    entries.reverse()
    return [LogEntryOut.from_orm_entry(e) for e in entries]


@router.websocket("/ws")
async def logs_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = events.subscribe("logs")
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe("logs", queue)
