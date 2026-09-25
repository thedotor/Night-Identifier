import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import settings
from app.db import init_db
from app.routers import (
    annotations,
    dashboard,
    deepspace,
    health,
    images,
    live,
    logs,
    map as map_router,
    objects,
    results,
    settings_router,
    sky,
    blocked_areas,
    star_classifier,
    training,
)
from app.services import app_settings, events, log_capture
from app.services.live.manager import manager as live_manager
from app.services.watcher import watcher

logger = log_capture.get_logger("main")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.ensure_dirs()
    init_db()
    log_capture.install()
    events.bind_loop(asyncio.get_running_loop())
    logger.info("Backend started (version %s)", __version__)
    watcher.start(app_settings.get_watch_dir())
    live_manager.startup()
    yield
    logger.info("Backend shutting down")
    live_manager.shutdown()
    watcher.stop()


app = FastAPI(title="Night Identifier Backend", version=__version__, lifespan=lifespan)

# Renderer is loaded from file:// or a Vite dev server on localhost; both are
# treated as local, trusted callers of this loopback-only API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(dashboard.router)
app.include_router(objects.router)
app.include_router(images.router)
app.include_router(annotations.router)
app.include_router(training.router)
app.include_router(results.router)
app.include_router(map_router.router)
app.include_router(settings_router.router)
app.include_router(logs.router)
app.include_router(star_classifier.router)
app.include_router(sky.router)
app.include_router(deepspace.router)
app.include_router(blocked_areas.router)
app.include_router(live.router)
