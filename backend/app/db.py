import enum
from collections.abc import Generator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def make_engine():
    settings.ensure_dirs()
    engine = create_engine(
        f"sqlite:///{settings.db_path}", connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _add_missing_columns() -> set[tuple[str, str]]:
    """Best-effort dev-time migration: add columns that exist on the model but
    not yet on an existing local SQLite DB, so schema growth during this
    project's early build-out doesn't force deleting your local database.
    Not a substitute for real migrations once the schema stabilizes.
    """
    inspector = inspect(engine)
    added: set[tuple[str, str]] = set()
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {col["name"] for col in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                default_sql = _column_default_sql(column)
                added.add((table.name, column.name))
                conn.execute(
                    text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" DEFAULT {default_sql}')
                )
                if table.name == "images" and column.name == "category":
                    # This column postdates the library/training split. Images
                    # that already have a manual annotation were clearly being
                    # used for training -- defaulting them to "library" would
                    # silently strand that work outside Annotate and make it
                    # ineligible for the next training run.
                    conn.execute(
                        text(
                            "UPDATE images SET category = 'TRAINING' WHERE id IN "
                            "(SELECT DISTINCT image_id FROM annotations WHERE source = 'MANUAL')"
                        )
                    )
    return added


def _backfill_kinds(added: set[tuple[str, str]]) -> None:
    """Object types that already carry Sky Overlay labels are constellation classes."""
    if ("object_types", "kind") not in added:
        return
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE object_types SET kind = 'constellation' WHERE id IN "
                "(SELECT DISTINCT object_type_id FROM annotations WHERE origin = 'sky_overlay')"
            )
        )
    return


def _backfill_blocked_regions(added: set[tuple[str, str]]) -> None:
    """Areas blocked on the Constellations page used to live on its result row."""
    if ("images", "blocked_regions") not in added or not inspect(engine).has_table("constellation_results"):
        return
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE images SET blocked_regions = (SELECT ignore_regions FROM constellation_results "
                "WHERE constellation_results.image_id = images.id) "
                "WHERE id IN (SELECT image_id FROM constellation_results WHERE ignore_regions IS NOT NULL)"
            )
        )


def _column_default_sql(column) -> str:
    """Best-effort SQL literal for a newly-added column's default, preferring
    the model's own declared default over a bare 0/NULL so existing rows end
    up with a value the ORM can actually deserialize (e.g. enum columns)."""
    if column.default is not None and getattr(column.default, "is_scalar", False):
        value = column.default.arg
        if isinstance(value, enum.Enum):
            # SQLAlchemy's Enum type stores/reads the member *name*
            # (e.g. "LIBRARY"), not `.value` ("library") -- confirmed by every
            # enum column this app already had before this helper existed.
            # Using `.value` here would write data the ORM can't read back.
            return f"'{value.name}'"
        if isinstance(value, str):
            return f"'{value}'"
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float)):
            return str(value)
    try:
        return "0" if column.type.python_type in (int, float) else "NULL"
    except NotImplementedError:
        return "NULL"


def init_db() -> None:
    from app.models import (  # noqa: F401
        annotation,
        image,
        sky_alignment,
        log_entry,
        object_type,
        star_classifier_run,
        star_label,
        training_run,
    )

    Base.metadata.create_all(bind=engine)
    added = _add_missing_columns()
    _backfill_kinds(added)
    _backfill_blocked_regions(added)
    _migrate_legacy_model_dir()


def _migrate_legacy_model_dir() -> None:
    """Before there were two models, the one trained model lived in models/current."""
    legacy = settings.models_dir / "current"
    target = settings.models_dir / "objects"
    if legacy.exists() and not target.exists():
        legacy.rename(target)
