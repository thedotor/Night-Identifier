# Night Sky Object Identifier

Windows desktop app for identifying objects in night-sky astrophotography images: a trainable
custom object-detection model, a full labeling/annotation workspace, GPU-accelerated training,
and a management UI around it.

## Stack

- **Frontend**: Electron + React + TypeScript, built with `electron-vite`, styled with Tailwind.
  Lives in [frontend/](frontend/).
- **Backend**: Python (FastAPI) local server on `127.0.0.1:8765`, owns SQLite storage, image
  decoding (incl. RAW/CR2 via `rawpy`), and will own PyTorch/CUDA training. Lives in
  [backend/](backend/).

The two talk over local HTTP/WebSocket; Electron's main process starts the backend as a child
process in packaged builds (in dev, run it separately — see below).

## Prerequisites

- Node.js 20+ and npm
- Python 3.12 (the backend is pinned to 3.12 because PyTorch/CUDA wheels aren't yet available for
  newer Pythons). Managed via [uv](https://docs.astral.sh/uv/): `uv python install 3.12`
- `uv` for the backend's virtualenv/dependency management

## Setup

```bash
# from the repo root
npm install              # root tooling (concurrently)
cd frontend && npm install
cd ../backend && uv sync
```

## Run (development)

From the repo root:

```bash
npm run dev
```

This starts the FastAPI backend (`uvicorn --reload` on port 8765) and the Electron/Vite frontend
together, opening the app window once both are ready.

## Build the installer

Double-click **`Build Installer.bat`** (or `powershell -File scripts/build-installer.ps1`). It bundles the
backend (PyInstaller, including PyTorch/CUDA) and the Electron app into one standalone setup,
`frontend/release/Night-Identifier-Setup.exe`, which runs on a PC without Python, Node or this folder.

- **Run it again after any change.** Installing the new setup over an existing install upgrades it in place
  (per-user, under `%LOCALAPPDATA%\Programs`, no admin prompt). Your data in `Documents\Night Identifier`
  is never touched.
- The slow part is the backend. It is rebuilt only when `backend/app`, `backend/vendor`, `pyproject.toml`,
  `uv.lock`, the spec, `run_server.py` or `yolov8n.pt` changed; frontend-only changes skip it.
  Pass `-ForceBackend` to rebuild it anyway.
- Backend packaging lives in `backend/night-identifier-backend.spec` + `backend/run_server.py`; the installer
  config is `frontend/electron-builder.yml`. If a new backend feature imports something dynamically or needs a
  data file at runtime, add it to the spec.
- The installed app starts its own backend on port 8765, so close `npm run dev` first.

## Project layout

```
frontend/
  src/main/        Electron main process (window, backend process lifecycle, IPC)
  src/preload/      contextBridge API exposed to the renderer
  src/renderer/src/
    pages/          One file per app page (Dashboard, Annotate, Train, ...)
    components/      Sidebar, TitleBar, SplashScreen, shared UI
    theme/           Dark/Light/Red night-vision/Custom theme system (CSS vars)
    lib/api.ts       Typed fetch client for the backend

backend/
  app/
    routers/        One router per feature area (health, objects, images, training, ...)
    models/         SQLAlchemy models
    services/       GPU detection, etc.
    main.py          FastAPI app wiring
    config.py        Settings (default data dir: ~/Documents/Night Identifier)
    db.py            SQLite engine/session
```

## Sky Overlay

The **Sky Overlay** page draws the real sky (stars, constellation figures and their classical artwork,
asterisms, ~660 deep-sky objects split into nebulae / galaxies / clusters, the Sun, Moon and planets,
horizon) over a photo. Each of these is a switch under *Layers*. The overlay is never a pasted image: catalogue directions are pushed
through a camera model every frame, so moving, rotating and scaling it are edits to that model.

- `lib/skyMath.ts` — camera/lens model (rectilinear, stereographic, equidistant, equisolid, orthographic
  + radial distortion), time/precession/alt-az transforms, Levenberg–Marquardt solver.
- `lib/skyRender.ts`, `components/sky/SkyOverlayCanvas.tsx` — vector renderer and interaction
  (drag = move, wheel = scale, Shift+drag or ↻ handle = rotate, Ctrl+wheel / Space+drag = zoom / pan the view).
- Manual alignment: *Pick stars*, click a star in the photo, choose its catalogue match, *Fit camera*.
- `lib/plateSolve.ts` (+ worker) — *Auto-align*: blind quad-hash plate solving on the sphere, so it
  works for fisheye too. EXIF field of view narrows the search; GPS/time are optional.
- Backend: `GET /sky/catalogue`, `/sky/{id}/init` (EXIF lens/time), `/sky/{id}/stars` (detected stars),
  `GET/PUT /sky/{id}/alignment` (saved per image).

- `lib/skyEphemeris.ts` — Sun, Moon and planets at the photo's time (JPL approximate elements; the
  Moon is shifted for the observer's position). Constellation artwork is placed from anchor stars in
  `backend/app/data/art` (`services/sky_art.py`) and warped through the camera like everything else.
- Nebulae come from OpenNGC: every large or named nebula is kept even without a magnitude
  (`backend/scripts/build_sky_catalogue.py` rebuilds `data/sky/catalogue.json`).

## Live View

**Live View** shows live video from webcams, IP cameras and astronomy cameras, in a grid (up to 16 tiles) or one
camera at a time with framing and focusing tools. The backend opens every camera (so feeds keep running, recording
and watching for motion when you leave the page); frames reach the page over **one** WebSocket
(`/live/ws`), each frame sent only after the previous one is acknowledged, so a slow viewer drops frames
instead of building a backlog. Code: `backend/app/services/live/`, `backend/app/routers/live.py`,
`frontend/src/renderer/src/pages/LiveView.tsx`, `components/live/`.

| Camera type | How | Extra software |
|---|---|---|
| USB / webcam | OpenCV (DirectShow) | none (`uv pip install pygrabber` for real device names) |
| IP / security camera | ONVIF finds the stream, then RTSP | none |
| MJPEG stream / JPEG snapshot URL | HTTP | none |
| Astro camera on the network | ASCOM Alpaca, or INDI (StellarMate, Pi) | an Alpaca / INDI server |
| Astro camera on this PC | ASCOM COM driver (any brand: ZWO, QHY, Player One, Atik...) | ASCOM Platform + `uv add pywin32` |
| ZWO ASI (native) | ZWO SDK via `zwoasi` | `uv add zwoasi` + `ASICamera2.dll` (or set `ZWO_ASI_LIB`) |
| Canon EOS (DSLR / mirrorless) | Canon EDSDK: live view, ISO / aperture / shutter, full-quality photos into the library | Canon's developer SDK (free, cannot be bundled): put its 64-bit DLLs in `backend/vendor/edsdk/` or set `CANON_EDSDK_DIR` |
| Simulated star field | built in | none (handy for trying the page) |

Tools on the single view: histogram and auto/manual stretch, focus score (FWHM) with history and a magnifier,
guides (crosshair, thirds, grid, framing box), camera controls (exposure, gain, binning, cooling), and a red
filter (automatic in the Red night-vision theme). Capture: snapshot into the library, single frame as FITS/PNG/JPEG,
MP4 or SER recording, timelapse/sequence, and motion or meteor detection with notifications. Files go to
`<data dir>/live/<camera>/<date>/`. The library now accepts FITS (`.fit/.fits/.fts`) and previews them stretched.

**Star overlay** (single view → *Sky* tab, or the ★ button): draws the catalogue's stars, constellations, planets and
deep-sky objects over the live picture and keeps them on the stars as the sky turns. Align it automatically (finds the
stars in the newest frame and plate-solves them, no location needed) or by hand (drag / scroll / Shift+drag, aim by
altitude/azimuth, or click stars and *Fit camera*), then **Lock** it: the mouse stops moving the overlay, but it keeps
following the sky in real time and the alignment is remembered per camera. For a fixed camera the turn is just the
Earth's rotation about the pole from the moment of alignment (`lib/liveSky.ts`); tick *Camera is on a star tracker* if
the stars hold still in your picture. Latitude/longitude are optional (horizon, alt/az aiming, Moon position). Single
view only (not the grid). Checks: `scripts/liveSky.check.ts`.

Settings → *Live View cameras* shows which types can work on this computer and what is missing. Each type is
labelled by how far it has been proven; ASCOM, ZWO, Canon and (real) USB/RTSP cameras have not yet been tried on hardware.
A DSLR is a stills camera, not a webcam: without the SDK, Canon's free EOS Webcam Utility makes it appear as a USB webcam.

## Object detector

The **Train** page trains one detector, from the boxes you draw in **Annotate**. Detection in Results
Gallery and the watch folder then files each identified photo into its own folder,
`<data dir>/sorted/<object name>/` (photos with nothing detected go to `_unsorted`). The photo is moved
there (the app follows it); a photo with several objects also gets a linked copy in each other object's
folder. *Results Gallery → Sort into folders* files photos identified earlier.

Numerical checks (no test runner needed):

```bash
cd frontend
node --import ./scripts/ts-resolve.mjs scripts/skyMath.check.ts     # projections, transforms, solver
node --import ./scripts/ts-resolve.mjs scripts/plateSolve.check.ts  # blind solve vs. ground truth
node --import ./scripts/ts-resolve.mjs scripts/ephemeris.check.ts    # Sun/Moon/planets vs. astropy
node --import ./scripts/ts-resolve.mjs scripts/liveSky.check.ts      # star overlay follows the sky (Live View)
```

Not included: constellation-boundary regions (no boundary data in the catalogue yet) and a trained
star detector (the classical detector feeds the solver).

## Status

This is an early scaffold: the app shell, navigation, theming, and backend connectivity are
wired and verified end-to-end. Most feature pages (Annotate, Train, Results Gallery,
Map, Upload & Watch Folder, Object Library) are placeholders pending
implementation. `torch`/`ultralytics` are intentionally not yet in `backend/pyproject.toml` —
they'll be added when the Train page is built, with GPU/CPU-aware install selection.
