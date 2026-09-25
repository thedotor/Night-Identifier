import datetime as dt
import enum

from sqlalchemy import JSON, DateTime, Enum, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class StarClassifierStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED = "stopped"


class StarClassifierRun(Base):
    __tablename__ = "star_classifier_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[StarClassifierStatus] = mapped_column(
        Enum(StarClassifierStatus), default=StarClassifierStatus.PENDING
    )
    device: Mapped[str] = mapped_column(String(32), default="auto")
    epochs: Mapped[int] = mapped_column(Integer)
    current_epoch: Mapped[int] = mapped_column(Integer, default=0)
    label_count: Mapped[int] = mapped_column(Integer, default=0)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    error_message: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    model_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
