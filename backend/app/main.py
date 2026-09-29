import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from app import __version__
from app.config import settings
from app.db import init_db
from app.routers import (
    aircraft,
    annotations,
    aurora as aurora_router,
    dashboard,
    deepspace,
    health,
    images,
    lightning as lightning_router,
    live,
    location as location_router,
    logs,
    map as map_router,
    objects,
    results,
    satellites,
    settings_router,
    sky,
    sky_events as sky_events_router,
    space as space_router,
    sun as sun_router,
    blocked_areas,
    star_classifier,
    training,
    weather,
    flow as flow_router,
    ships as ships_router,
    hazards as hazards_router,
    traffic as traffic_router,
    neows as neows_router,
    launches as launches_router,
    aqi as aqi_router,
    ionosphere as ionosphere_router,
)
from app.services import app_settings, events, log_capture, tls
from app.services.api_guard import ApiTokenMiddleware
from app.services.lightning import collector as lightning_collector
from app.services.live.manager import manager as live_manager
from app.services.traffic import monitor as traffic_monitor, start_from_settings as start_traffic
from app.services.watcher import watcher

tls.install()

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
    lightning_collector.start(app_settings.get_lightning_enabled())
    start_traffic()
    yield
    logger.info("Backend shutting down")
    traffic_monitor.stop()
    lightning_collector.stop()
    live_manager.shutdown()
    watcher.stop()


app = FastAPI(title="Night Identifier Backend", version=__version__, lifespan=lifespan)

# Middleware added later wraps the earlier ones: CORS answers preflights first, then the host check
# (stops DNS rebinding: a hostile domain resolving to 127.0.0.1), then the per-launch token check.
app.add_middleware(ApiTokenMiddleware, token=settings.api_token)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
# The renderer is loaded from file:// (Origin "null") or a Vite dev server on localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
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
app.include_router(location_router.router)
app.include_router(satellites.router)
app.include_router(weather.router)
app.include_router(flow_router.router)
app.include_router(ships_router.router)
app.include_router(hazards_router.router)
app.include_router(aircraft.router)
app.include_router(lightning_router.router)
app.include_router(traffic_router.router)
app.include_router(aurora_router.router)
app.include_router(sun_router.router)
app.include_router(neows_router.router)
app.include_router(launches_router.router)
app.include_router(aqi_router.router)
app.include_router(ionosphere_router.router)
app.include_router(space_router.router)
app.include_router(sky_events_router.router)
