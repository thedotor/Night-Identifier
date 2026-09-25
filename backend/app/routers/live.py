import asyncio
import datetime as dt
import json
import time
from dataclasses import dataclass, field
from typing import Any

import cv2
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.services import events, log_capture
from app.services.star_detection import detect_stars_gray
from app.services.live import alpaca, canon, capture, devices, drivers, indi, onvif, processing, store, stream, uvc
from app.services.live.base import CameraError
from app.services.live.manager import manager
from app.services.live.recorder import Recorder
from app.services.live.sequence import SequenceJob

router = APIRouter(prefix="/live", tags=["live"])
logger = log_capture.get_logger("live")


class CameraIn(BaseModel):
    name: str
    kind: str
    params: dict[str, Any] = {}
    background: bool = False
    auto_reconnect: bool = True


class CameraPatch(BaseModel):
    name: str | None = None
    params: dict[str, Any] | None = None
    background: bool | None = None
    auto_reconnect: bool | None = None
    motion: dict[str, Any] | None = None


class ControlIn(BaseModel):
    value: Any = None


class SnapshotIn(BaseModel):
    stretch: dict[str, Any] | None = None


class CaptureIn(BaseModel):
    format: str = "fits"  # 'fits' | 'png' | 'jpg'
    to_library: bool = True
    stretch: dict[str, Any] | None = None


class RecordIn(BaseModel):
    format: str = "mp4"  # 'mp4' | 'ser'
    stretch: dict[str, Any] | None = None


class SequenceIn(BaseModel):
    count: int = 10
    interval_s: float = 5.0
    format: str = "fits"
    to_library: bool = False
    stretch: dict[str, Any] | None = None


def _camera_out(cfg: dict[str, Any]) -> dict[str, Any]:
    rt = manager.get(cfg["id"])
    return {**store.public(cfg), "status": rt.status() if rt else None}


def _runtime_or_404(camera_id: str):
    rt = manager.get(camera_id)
    if rt is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    return rt


@router.get("/kinds")
def kinds() -> list[dict[str, str]]:
    return drivers.known_kinds()


@router.get("/cameras")
def list_cameras() -> list[dict[str, Any]]:
    return [_camera_out(c) for c in store.list_cameras()]


@router.post("/cameras")
def add_camera(payload: CameraIn) -> dict[str, Any]:
    if payload.kind not in {k["kind"] for k in drivers.known_kinds()}:
        raise HTTPException(status_code=422, detail=f"Unknown camera type '{payload.kind}'")
    cfg = store.add_camera(payload.model_dump())
    return _camera_out(cfg)


@router.patch("/cameras/{camera_id}")
def patch_camera(camera_id: str, payload: CameraPatch) -> dict[str, Any]:
    changes = payload.model_dump(exclude_none=True)
    cfg = store.update_camera(camera_id, changes)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    rt = manager.get(camera_id)
    # connection settings only take effect on a fresh connection
    if rt and "params" in changes and rt.state != "stopped":
        manager.stop(camera_id)
        manager.start(camera_id)
    if "motion" in changes:
        manager.apply_motion(camera_id)
    return _camera_out(cfg)


@router.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: str) -> None:
    manager.forget(camera_id)
    if not store.remove_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera not found")


@router.post("/cameras/{camera_id}/start")
def start_camera(camera_id: str) -> dict[str, Any]:
    _runtime_or_404(camera_id)
    manager.start(camera_id)
    return _camera_out(store.get_camera(camera_id))  # type: ignore[arg-type]


@router.post("/cameras/{camera_id}/stop")
def stop_camera(camera_id: str) -> dict[str, Any]:
    _runtime_or_404(camera_id)
    manager.stop(camera_id)
    return _camera_out(store.get_camera(camera_id))  # type: ignore[arg-type]


@router.put("/cameras/{camera_id}/controls/{name}")
def set_control(camera_id: str, name: str, payload: ControlIn) -> dict[str, Any]:
    _runtime_or_404(camera_id)
    try:
        return manager.set_control(camera_id, name, payload.value)
    except CameraError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/folder")
def live_folder() -> dict[str, str]:
    """Where captures, recordings and motion events are saved."""
    folder = settings.data_dir / "live"
    folder.mkdir(parents=True, exist_ok=True)
    return {"path": str(folder)}


def _tag(found: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for f in found:
        f["tested"] = drivers.TESTED.get(f["kind"], "untested")
    return found


@router.get("/diagnostics")
async def diagnostics() -> list[dict[str, Any]]:
    return await run_in_threadpool(drivers.diagnostics)


class ProbeIn(BaseModel):
    kind: str
    host: str
    port: int | None = None


@router.post("/probe")
async def probe(payload: ProbeIn) -> list[dict[str, Any]]:
    """Cameras offered by a network server (Alpaca or INDI) at a given address."""
    if payload.kind == "alpaca":
        return _tag(await run_in_threadpool(alpaca.probe, payload.host, payload.port or alpaca.DEFAULT_PORT))
    if payload.kind == "indi":
        return _tag(await run_in_threadpool(indi.probe, payload.host, payload.port or indi.DEFAULT_PORT))
    raise HTTPException(status_code=422, detail="Only 'alpaca' and 'indi' servers can be probed")


class OnvifIn(BaseModel):
    host: str
    port: int | None = None
    username: str | None = None
    password: str | None = None


@router.post("/onvif")
async def onvif_streams(payload: OnvifIn) -> list[dict[str, Any]]:
    """Ask an ONVIF IP camera for its RTSP stream addresses (needs its login)."""
    try:
        return await run_in_threadpool(onvif.streams, payload.host.strip(), payload.port or 80, payload.username or None, payload.password or None)
    except CameraError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _safe(fn, *args) -> list[dict[str, Any]]:
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 - one broken driver must not hide the others
        logger.exception("Camera discovery failed in %s", getattr(fn, "__module__", fn))
        return []


@router.post("/discover")
async def discover() -> list[dict[str, Any]]:
    """Cameras that can be added right now: local video devices, ASCOM drivers, ZWO cameras, Alpaca
    servers on the network, plus the simulator for trying things out."""
    from app.services.live import ascom, zwo

    busy = manager.busy_uvc_indices()
    uvc_found, ascom_found, zwo_found, alpaca_found, onvif_found, stills_found = await asyncio.gather(
        run_in_threadpool(_safe, uvc.discover, busy),
        run_in_threadpool(_safe, ascom.discover),
        run_in_threadpool(_safe, zwo.discover),
        run_in_threadpool(_safe, alpaca.discover),
        run_in_threadpool(_safe, onvif.discover),
        run_in_threadpool(_safe, devices.stills_cameras),
    )
    saved = store.list_cameras()
    known_uvc = {int(c["params"].get("index", -1)) for c in saved if c["kind"] == "uvc"}
    saved_keys = {(c["kind"], json.dumps({k: v for k, v in c["params"].items() if k in ("progid", "host", "port", "device", "index")}, sort_keys=True)) for c in saved}

    def key(c: dict[str, Any]) -> tuple[str, str]:
        return c["kind"], json.dumps({k: v for k, v in c["params"].items() if k in ("progid", "host", "port", "device", "index")}, sort_keys=True)

    found = [f for f in uvc_found if f["params"]["index"] not in known_uvc]
    found += [f for f in zwo_found + ascom_found + alpaca_found if key(f) not in saved_keys]
    saved_hosts = {str(c["params"].get("url", "")).split("//")[-1].split("/")[0].split("@")[-1].split(":")[0] for c in saved if c["kind"] == "rtsp"}
    found += [f for f in onvif_found if f["params"]["host"] not in saved_hosts]
    found.append({"kind": "synthetic", "name": "Simulated star field", "params": {}})
    # Canon bodies become real, addable cameras when Canon's SDK is installed; otherwise they stay as an explanation
    canon_names = [r["name"].removesuffix(" is connected") for r in stills_found if r.get("maker") == "Canon"]
    canon_found = canon.discover(canon_names)
    saved_canon = sum(1 for c in saved if c["kind"] == "canon")
    canon_found = canon_found[saved_canon:]
    if canon_names and canon.available()[0]:
        stills_found = [r for r in stills_found if r.get("maker") != "Canon"]
    return _tag(found + canon_found) + stills_found


@router.post("/cameras/{camera_id}/snapshot")
def snapshot(camera_id: str, payload: SnapshotIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    rt = _runtime_or_404(camera_id)
    try:
        return capture.snapshot_to_library(rt, db, payload.stretch)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _running_or_409(camera_id: str):
    rt = _runtime_or_404(camera_id)
    if rt.state != "running":
        raise HTTPException(status_code=409, detail="The camera is not running")
    return rt


def _check_format(fmt: str, allowed: tuple[str, ...]) -> None:
    if fmt not in allowed:
        raise HTTPException(status_code=422, detail=f"Format must be one of: {', '.join(allowed)}")


@router.post("/cameras/{camera_id}/capture")
def capture_frame(camera_id: str, payload: CaptureIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """One frame at full quality: FITS keeps the sensor data, PNG/JPEG what you see."""
    rt = _running_or_409(camera_id)
    _check_format(payload.format, ("fits", "png", "jpg"))
    try:
        return capture.capture_to_library(rt, db, payload.format, payload.stretch, payload.to_library)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


MAX_ALIGN_STARS = 120


@router.get("/cameras/{camera_id}/stars")
def detected_stars(camera_id: str) -> dict[str, Any]:
    """Point sources in the newest frame, in the camera's own pixels (brightest first), with the
    frame's capture time. Feeds the star overlay's auto-align: the time is what lets the overlay
    turn with the sky from the moment this frame was taken."""
    rt = _running_or_409(camera_id)
    frame = rt.latest()
    if frame is None:
        raise HTTPException(status_code=409, detail="No frame yet: wait for the camera to start")
    img = processing.to_display(frame, 2200, processing.DEFAULT_STRETCH)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    found = detect_stars_gray(gray, max_stars=MAX_ALIGN_STARS, target_size=(frame.width, frame.height))
    return {
        "stars": [[round(x, 2), round(y, 2), round(b, 1)] for x, y, b in found],
        "width": frame.width,
        "height": frame.height,
        "timestamp": frame.timestamp,
    }


@router.post("/cameras/{camera_id}/record")
def start_recording(camera_id: str, payload: RecordIn) -> dict[str, Any]:
    rt = _running_or_409(camera_id)
    _check_format(payload.format, ("mp4", "ser"))
    if "record" in rt.jobs:
        raise HTTPException(status_code=409, detail="Already recording")
    frame = rt.latest()
    when = dt.datetime.now()
    path = capture.live_dir(rt, when) / f"{capture.file_stem(rt, when)}.{payload.format}"
    Recorder(rt, path, payload.format, payload.stretch).start()
    return {"file": str(path), "frame_hint": bool(frame)}


@router.post("/cameras/{camera_id}/record/stop")
def stop_recording(camera_id: str) -> dict[str, Any]:
    rt = _runtime_or_404(camera_id)
    job = rt.jobs.get("record")
    if job is None:
        raise HTTPException(status_code=409, detail="Not recording")
    return job.stop()


@router.post("/cameras/{camera_id}/sequence")
def start_sequence(camera_id: str, payload: SequenceIn) -> dict[str, Any]:
    rt = _running_or_409(camera_id)
    _check_format(payload.format, ("fits", "png", "jpg"))
    if "sequence" in rt.jobs:
        raise HTTPException(status_code=409, detail="A sequence is already running")
    if not 1 <= payload.count <= 100000:
        raise HTTPException(status_code=422, detail="Frame count must be between 1 and 100000")
    job = SequenceJob(rt, payload.count, payload.interval_s, payload.format, payload.to_library, payload.stretch)
    job.start()
    return {"folder": str(job.folder), "count": payload.count}


@router.post("/cameras/{camera_id}/sequence/stop")
def stop_sequence(camera_id: str) -> dict[str, Any]:
    rt = _runtime_or_404(camera_id)
    job = rt.jobs.get("sequence")
    if job is None:
        raise HTTPException(status_code=409, detail="No sequence is running")
    job.stop()
    return {"done": job.done}


@router.get("/cameras/{camera_id}/still.jpg")
async def still(camera_id: str, width: int = 1280) -> Response:
    rt = _runtime_or_404(camera_id)
    manager.viewer_join(camera_id)
    try:
        got = await asyncio.to_thread(rt.wait_frame, -1, 6.0)
    finally:
        manager.viewer_leave(camera_id)
    if got is None:
        raise HTTPException(status_code=503, detail=rt.error or "No frame available")
    _seq, frame = got
    img = await asyncio.to_thread(processing.to_display, frame, width, processing.DEFAULT_STRETCH if rt.is_astro else None)
    return Response(processing.encode_jpeg(img, 88), media_type="image/jpeg")


@router.get("/cameras/{camera_id}/stream")
async def mjpeg_stream(camera_id: str, width: int = 960, fps: float = 10.0) -> StreamingResponse:
    """Plain multipart MJPEG (works in an <img> tag, OBS, VLC...). The app itself uses the
    WebSocket instead, because browsers cap parallel connections per host."""
    rt = _runtime_or_404(camera_id)
    manager.viewer_join(camera_id)
    interval = 1.0 / max(fps, 0.5)

    async def gen():
        last = -1
        sent = 0.0
        try:
            while True:
                got = await asyncio.to_thread(rt.wait_frame, last, 2.0)
                if got is None:
                    continue
                last, frame = got
                wait = sent + interval - time.time()
                if wait > 0:
                    await asyncio.sleep(wait)
                img = await asyncio.to_thread(processing.to_display, frame, width, processing.DEFAULT_STRETCH if rt.is_astro else None)
                sent = time.time()
                jpeg = processing.encode_jpeg(img, 80)
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n"
        finally:
            manager.viewer_leave(camera_id)

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


# ---- WebSocket: frames for every visible tile over one connection ---------------------------


@dataclass
class _Sub:
    cam: str
    width: int | None
    fps: float
    stretch: dict[str, Any] | None
    hist: bool
    focus: bool
    ack: asyncio.Event = field(default_factory=asyncio.Event)
    new: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    last_seq: int = -1
    last_sent: float = 0.0


@router.websocket("/ws")
async def live_ws(websocket: WebSocket) -> None:
    """Client -> server (JSON text):
        {"op": "sub", "cam": id, "width": 480, "fps": 8, "stretch": {...}, "hist": bool, "focus": bool}
        {"op": "unsub", "cam": id}
        {"op": "ack", "cam": id}          (sent after each frame is drawn; the next frame waits for it)
    Server -> client: JSON status events, and binary frames (see services/live/stream.py)."""
    await websocket.accept()
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    subs: dict[str, _Sub] = {}
    ev_queue = events.subscribe("live")

    async def send_json(obj: dict[str, Any]) -> None:
        async with send_lock:
            await websocket.send_json(obj)

    async def pump_events() -> None:
        while True:
            await send_json(await ev_queue.get())

    async def run_sub(sub: _Sub, rt) -> None:
        # Every path through this loop must await something that really suspends: an
        # already-set Event returns at once, so a loop that only "continues" would starve the
        # whole server (this happened when a camera took a while to deliver its first frame).
        while True:
            try:
                await asyncio.wait_for(sub.ack.wait(), 3.0)  # a lost ack must not freeze the tile forever
            except asyncio.TimeoutError:
                pass
            if rt.frame is None or rt.seq <= sub.last_seq:
                sub.new.clear()
                if rt.frame is None or rt.seq <= sub.last_seq:  # re-check: a frame may have landed just now
                    try:
                        await asyncio.wait_for(sub.new.wait(), 1.0)
                    except asyncio.TimeoutError:
                        pass
                    continue
            wait = sub.last_sent + 1.0 / max(sub.fps, 0.5) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
            frame = rt.latest()
            seq = rt.seq
            if frame is None or seq <= sub.last_seq:
                await asyncio.sleep(0.02)
                continue
            try:
                payload = await asyncio.to_thread(
                    stream.render, rt, frame, seq, width=sub.width, stretch=sub.stretch, hist=sub.hist, focus=sub.focus
                )
            except Exception:  # noqa: BLE001 - a bad frame must not end the tile
                logger.exception("Could not render a frame for camera %s", sub.cam)
                sub.last_seq = seq
                await asyncio.sleep(0.05)
                continue
            sub.ack.clear()
            sub.last_seq = seq
            sub.last_sent = time.time()
            async with send_lock:
                await websocket.send_bytes(payload)

    def drop(cam: str) -> None:
        sub = subs.pop(cam, None)
        if sub is None:
            return
        if sub.task:
            sub.task.cancel()
        rt = manager.get(cam)
        if rt:
            rt.watchers[:] = [w for w in rt.watchers if w[1] is not sub.new]
        manager.viewer_leave(cam)

    pump = asyncio.create_task(pump_events())
    try:
        await send_json({"type": "hello", "cameras": manager.statuses()})
        while True:
            msg = await websocket.receive_json()
            op, cam = msg.get("op"), str(msg.get("cam", ""))
            if op == "sub":
                rt = manager.viewer_join(cam)
                if rt is None:
                    await send_json({"type": "error", "camera": cam, "error": "Camera not found"})
                    continue
                old = subs.get(cam)
                if old is not None:  # re-subscribing just changes the parameters
                    old.width = msg.get("width")
                    old.fps = float(msg.get("fps", 8))
                    old.stretch = msg.get("stretch")
                    old.hist = bool(msg.get("hist"))
                    old.focus = bool(msg.get("focus"))
                    manager.viewer_leave(cam)  # viewer_join above counted it twice
                    continue
                sub = _Sub(
                    cam=cam,
                    width=msg.get("width"),
                    fps=float(msg.get("fps", 8)),
                    stretch=msg.get("stretch"),
                    hist=bool(msg.get("hist")),
                    focus=bool(msg.get("focus")),
                )
                sub.ack.set()
                rt.watchers.append((loop, sub.new))
                sub.task = asyncio.create_task(run_sub(sub, rt))
                subs[cam] = sub
            elif op == "unsub":
                drop(cam)
            elif op == "ack":
                sub = subs.get(cam)
                if sub:
                    sub.ack.set()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        pump.cancel()
        for cam in list(subs):
            drop(cam)
        events.unsubscribe("live", ev_queue)
