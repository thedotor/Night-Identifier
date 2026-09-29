# Night Identifier

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
backend (PyInstaller, including PyTorch/CUDA) and the Electron app into a standalone setup,
`frontend/release/Night-Identifier-Setup.exe`, which runs on a PC without Python, Node or this folder.
The payload is several GB (mostly CUDA libraries), so the installer is split across
`Night-Identifier-Setup.exe` plus `Night-Identifier-Setup-1.bin`, `-2.bin`, ...: keep them in the same folder.
It is built with [Inno Setup](https://jrsoftware.org/isinfo.php) (NSIS can't exceed 2 GB); the script installs it
per-user on first use.

- **Run it again after any change.** Installing the new setup over an existing install upgrades it in place
  (per-user, under `%LOCALAPPDATA%\Programs`, no admin prompt). Your data in `Documents\Night Identifier`
  is never touched.
- The slow part is the backend. It is rebuilt only when `backend/app`, `backend/vendor`, `pyproject.toml`,
  `uv.lock`, the spec, `run_server.py` or `yolov8n.pt` changed; frontend-only changes skip it.
  Pass `-ForceBackend` to rebuild it anyway.
- Backend packaging lives in `backend/night-identifier-backend.spec` + `backend/run_server.py`; the app
  folder config is `frontend/electron-builder.yml` and the installer is `installer/night-identifier.iss`. If a new backend feature imports something dynamically or needs a
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
| Canon EOS (DSLR / mirrorless) | Canon EDSDK: live view, ISO / aperture / shutter / exposure compensation / metering, focus (a slider, lens nudge buttons, autofocus, x5 / x10 magnify with a movable window), image quality, white balance, picture style, drive mode, Bulb exposures (timed or by hand), camera status, full-quality photos into the library | Canon's developer SDK (free, cannot be bundled): put its 64-bit DLLs in `Documents\Night Identifier\edsdk` (or `backend/vendor/edsdk/` from source), or set `CANON_EDSDK_DIR` |
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

## Satellites

Real-time satellites in **Sky Overlay** (photos), **Live View** (single view → *Sky* tab → *Satellites*) and the
**Deep Space** 3D view. Groups: the ISS on its own (its own tick box), all space stations & docked craft, bright / naked-eye,
Starlink, every other active satellite. The layer is
off until switched on; each satellite is a dot (hollow and faint in Earth's shadow), bright ones are named, with a
trail before and after it, and only what is above the horizon is drawn. Click one for its card: distance, altitude,
speed, sunlit or not, and its passes over your location for the next 24 hours ("visible" = sunlit while the Sun is more
than 6° below the horizon). The card's *Follow in 3D* opens the Deep Space view and keeps the camera with it.

- Orbit data: CelesTrak general-perturbation elements (JSON, because catalogue numbers already exceed 99999 and the
  classic two-line format cannot hold them). The backend (`services/satellites.py`, `routers/satellites.py`) downloads
  and caches them in `<data dir>/deepspace_cache/satellites/`; it never fetches a set less than 2 hours after the last
  fetch (CelesTrak's rule; it answers HTTP 403 otherwise) and refreshes after 6 hours. Offline, the last download keeps
  working. Settings → *Satellite orbit data* shows what is cached and refreshes it. Elements more than 30 days from the
  moment shown are not used (orbits change too fast), and the panel says so.
- Positions are computed in the app with SGP4 (`satellite.js`, imported through `lib/satelliteJs.ts` because the package
  entry drags in a WebAssembly build the renderer bundle cannot hold). `lib/satellites.ts` has the maths: look angles
  for a site (including the satellite's parallax), sunlit test, a fast tracker that only re-propagates what is near the
  sky, trails, passes, and the conversion to the 3D scene's frame.
- Location: satellites need where you stand (unlike the stars). It is the latitude/longitude already in the overlay
  panel (EXIF GPS for photos).
- Sky Overlay: *Photo time* (where they were when the photo was taken), *Live now*, or *Scrub* and *Play* the clock
  around the photo. The photo does not turn, so satellites move over it.
- Live View: the camera's picture lags the computer's clock (network cameras, USB buffering), and a satellite moves
  up to a degree a second, so *Camera delay* (saved per camera) shifts the satellites back in time to match the picture.
  Single view only, like the star overlay.
- Deep Space: satellites follow the scene's own clock and speed (there is a *Real time* speed). The Earth's orientation
  there now comes from sidereal time and precession rather than the IAU model, which was 0.7° (75 km) off in 2026.
- Dashboard → *Your sky*: an ISS card with its own *Track the ISS* tick box (off = nothing downloaded): a world map with
  the day/night line, where the ISS is now and its path (last 45 min, next 90 min), altitude, speed, sunlit or not, and
  your next passes. It uses the location saved from the other pages (or type one in at the top of *Your sky*).
- **Live View always shows the ISS** (*Always show the ISS*, on by default, in the Satellites block, independent of
  *Show satellites*): above the horizon it is a normal marker; under it, a dashed hollow marker where the camera would
  have to look (with its track, "ISS 34° below the horizon"); out of the picture, an arrow on the nearest edge and how
  far from the middle of the picture it is. Needs the star overlay on and a location.
- **ISS orbit on the Earth** (Deep Space, *ISS orbit* tick box, on by default): the ring it flies (one revolution from the
  scene's time), its track over the ground (last 45 min, next 90) and where it is now. Zoom in to the Earth to see it.
- **Aircraft.** Live View: *Aircraft* block in the Sky tab, arrows pointing the way each plane is heading, flight number
  and flight level for the 30 nearest, within about 280 km of the camera, refreshed every 5 s (adsb.fi open data; moved
  along their tracks in between). Deep Space: *Aircraft* tick box puts every plane that reports its position (about
  12,000) on the globe (OpenSky Network anonymous snapshot, refreshed every 5 min; anonymous use has a small daily
  allowance, so a snapshot is kept on disk and, if OpenSky says no, the last one is shown); click one for its flight
  number, type, height, speed and heading. Planes are real time, so they fade out when the scene's date is not now.
  Backend: `services/aircraft.py`, `routers/aircraft.py`; maths and the sky frame in `lib/aircraft.ts`
  (`scripts/aircraft.check.ts`).
- **Sharp close-up imagery:** below about 2,000 km the globe's picture is replaced, patch by patch, by real Sentinel-2
  cloudless satellite tiles (a cloud-free mosaic, up to about 40 m per pixel) of the right detail for the distance,
  streamed through the backend (`/deepspace/earth-tile/{z}/{x}/{y}`, cached on disk under the Deep Space folder). The
  whole-Earth picture stays underneath until a tile arrives; the night side keeps the Black Marble city lights. The
  camera can come down to 40 km above the ground, the wheel then works on the height above the ground (not the distance
  from the centre) and dragging moves the ground under the cursor. Code: `earthDetail.ts` and `layoutDetail` in
  `solarSystemEngine.ts`. Imagery: EOX IT Services GmbH, contains modified Copernicus Sentinel data 2021, CC BY-NC-SA 4.0
  (non-commercial use). Needs the internet for tiles not yet cached.
- **The Earth in Deep Space, close up:** the globe uses NASA's Blue Marble (natural colour with shaded relief and sea-floor
  depth) and Black Marble (city lights) at 5120 px (Medium) or 10240 px (High; Low keeps the 2048 px map). The backend
  (`services/earthmaps.py`) fetches NASA GIBS's 512 px tiles in parallel and stitches them once (about 10 s), then caches
  the result, so the first view of a new size takes a moment and the 2K map shows until the sharp one arrives. Night
  side: the real Black Marble lights, only where the real Sun is down. *City names*: the world's ~7,300 populated places
  (Natural Earth, public domain) appear as you descend: the biggest first, smaller ones as you get closer, never
  overlapping (at most 60 at once). Aircraft are drawn as little planes pointing the way each is heading.
- **Real-time lighting:** opened on its own, Deep Space runs on the real clock (*● Live*; *Go live* returns to it after
  you have scrubbed or sped time up), so the day/night line, the sunrise and sunset glow on the ground and atmosphere, the
  ocean's glint, the night-side city lights and the clouds are where they are right now, and move as the Earth turns.
  *Sun overhead: lat, lon* shows the sub-solar point. Opened from a photo or a satellite it starts paused at that moment
  as before. The *Reverse* button becomes *Forward* while time runs backwards (and starts backwards playback when paused).
- **Lightning (live, worldwide).** The backend (`services/lightning.py`) keeps a WebSocket open to the Blitzortung volunteer
  lightning network whenever the app is open (a few KB/s; switch it off in Settings → Lightning), decodes the stream,
  falls back between servers, and holds the last hour of strikes in memory (`/lightning/strikes?since=<seq>`,
  `/lightning/status`). Deep Space: *⚡ Lightning* tick box (on by default): every strike pops as a bright flash and fades
  from white through yellow and orange to dark red as it ages, and a heat map shows where lightning is most frequent.
  *Auto* shows the heat map from far away and the flashes as you come closer (or force Flashes / Heat map / Both); the
  slider sets how long a strike stays (1-60 min, default 10) and the heat map's period. Click a flash for its time,
  position, how many receivers heard it and its distance from your saved location. A chip shows strikes per minute
  worldwide, how many are on the globe, and the nearest storm to your saved location (distance, direction, how long
  ago). A soft thunder sound (made in the app, no sound files) plays for a strike within 50 km of that location (mute
  button next to the slider). Dashboard: a *Lightning* widget (add it from *Customize*) with the rate, the nearest storm
  and a map of the last 15 minutes. Like the aircraft and clouds, strikes are real time and fade out when the scene's date
  is not now. Data: Blitzortung.org contributors, private non-commercial use; it counts strikes the network heard, so
  coverage is thinner over oceans and parts of Africa. The feed is unofficial and could change or go away.
  Maths in `lib/lightning.ts` (`scripts/lightning.check.ts`); the globe layer is `components/deepspace/lightningLayer.ts`.
- **Web traffic (where this PC's connections go).** Off until you switch it on (*🌐 Web traffic* in the Earth menu, or *Turn on*
  on the Dashboard's *Your web traffic* card; one switch, kept by the backend). `services/traffic.py` reads Windows' table of open
  connections with psutil every 3 s (no packet capture, driver or admin rights), keeps public addresses only, and places each with
  the offline DB-IP Lite city database (`services/geoip.py`; bundled, git-ignored, fetched by `backend/scripts/fetch_geoip.py`, which
  the installer build runs when it is missing; *Update IP database* downloads the newest monthly file into the data folder). No
  address is sent to anyone. The globe draws glowing dots at each destination and arcs from your saved location (`deepspace/trafficLayer.ts`); click a dot for
  the country, city and programs, then *Show addresses* and *Look up name* (reverse DNS for that one address: the only step that asks a
  server). The live view is in memory only. The history (`/traffic/history`) keeps country, city and program name per hour for 7 days,
  encrypted with Windows DPAPI (`secrets_at_rest.protect_bytes`); *Clear history* deletes it. It sees TCP connections Windows lists
  with a remote address (most UDP/QUIC traffic has none), where a server is registered rather than where it is, and not how much
  data moves. Endpoints: `/traffic/status`, `/traffic/enabled`, `/traffic/live`, `/traffic/place/{id}`, `/traffic/history`,
  `/traffic/database/update`. Data: IP geolocation by DB-IP.com (CC BY 4.0).
- **Hiding what is behind a planet.** In Deep Space the names and markers of stars, comets and moons are HTML/sprites drawn over the
  3D scene, so they showed through the Earth; `hideBehindSolids` in the engine now tests each against the planets, moons and Sun
  (a ray-sphere check) and hides or fades it at the limb.
- Not done: matching streaks in a photo to satellites, and brightness (magnitude) estimates.
- Checks: `node --import ./scripts/ts-resolve.mjs scripts/satellites.check.ts` compares against an independent
  implementation (Python skyfield + JPL DE421 in `scripts/satellites.reference.json`): look angles within 0.002°,
  passes within seconds, the 3D placement over the right spot on the ground within 0.001°.

## Aurora and space weather

Live aurora (the northern and southern lights) from **NOAA's Space Weather Prediction Center** (public domain), through
the backend (`services/aurora.py`, `/aurora/grid`, `/aurora/space-weather`; cached, the last answer is kept offline).

- **Data.** The *OVATION Aurora* model: the chance (0-100%) of visible aurora at every degree of longitude and latitude,
  both poles, published every 5 minutes and valid roughly half an hour to an hour ahead, driven by the solar wind measured
  at L1. It is a model of where aurora is likely, **not a camera view**: cloud, moonlight and light pollution decide what
  you would see, and the app says so wherever it shows the numbers. Also the planetary **Kp** index (observed, estimated and
  NOAA's 3-day forecast) with the G1-G5 storm scale, the **solar wind** (speed, density, field strength, Bz) for the last
  3 hours, and the aurora's **hemispheric power** in GW.
- **Deep Space.** *🌌 Aurora* tick box (on by default): a shimmering glow over each pole that turns into standing 3D
  curtains (a ribbon following the strongest part of the oval, rising from about 95 km to 250 km, with moving vertical rays)
  as you fly close. The part of the oval in sunlight is dimmed to a faint ghost, since aurora cannot be seen in daylight.
  Green with pink and violet where it is strong. A chip gives the peak chance, Kp and *your* chance with a plain-words
  verdict (which way to look, and whether it is dark enough). Like the aircraft, clouds and lightning it fades out when the
  scene's date is not now. (`components/deepspace/auroraLayer.ts`.)
- **Dashboard, two widgets** (*Aurora and space weather* section; add them from *Customize* if you customised your layout):
  *Aurora* (your chance, two polar maps with the night side shaded and you marked, how far south / north the oval reaches,
  Kp, power) and *Space weather* (Kp now and its meaning, the last day and the forecast as bars, the solar wind numbers,
  a 3-hour graph of speed and Bz, and whether Bz is southward: the sign to watch).
- **Alerts** (Notifications, Sky group, both on by default): *Aurora at your location* (the chance passes 20% and the Sun is
  more than 12 degrees down) and *Geomagnetic storm* (Kp 5 or more). Each fires once, then only again after it has dropped
  away and come back, at least 3 hours later. Maths and words in `lib/aurora.ts` (`scripts/aurora.check.ts`).

## Magnetic field and solar wind (Deep Space)

*🧲 Field & wind* in the Deep Space toolbar (on by default; the ▾ beside it chooses what to show). Backend: `services/heliosphere.py`,
`/space/dst`, `/space/stations`, `/space/enlil/*`; maths in `lib/geomag.ts`, `lib/magnetosphere.ts`, `lib/windMarkers.ts`
(`scripts/geomag.check.ts` compares the field with an independent implementation to 0.0000 nT across 192 points; `scripts/magnetosphere.check.ts`).

- **The field.** The real **IGRF-14** model (degree 13, IAGA, public data) computed for the scene's date, in `lib/igrfCoeffs.ts`: no network needed, valid
  around 2020 to 2030 (the lines fade out beyond). *Field lines* are traced through the model from the ground out to a few Earth radii and back, and bent the
  way the wind bends them (squashed on the Sun side, stretched into a tail on the night side): **that distortion is schematic**, not a model of the tail. In a
  storm (Dst, Kp, southward Bz) they shake and turn from blue to orange. *Surface map*: the real field strength (22 to 67 microtesla: watch the South Atlantic
  Anomaly) or compass declination on the globe, with contour lines. *Magnetopause and bow shock*: sized from the live wind (Shue 1998, Farris and Russell 1994):
  typical shapes for these conditions, not measurements of where the boundaries are this minute.
- **Real ground data.** The **USGS** publishes 1-minute readings from 13 observatories (Alaska, the continental US, Hawaii, Guam, Puerto Rico): dots on the globe
  coloured by how much the field moved in the last hour (high latitudes move most). The network is **US-centred**, and the app says so. **Dst** (the storm ring
  current index, NOAA / Kyoto) and Kp drive the storm look.
- **The solar wind.** *Stream to Earth*: particles from the Sun to the Earth at the speed and density measured at **L1** (DSCOVR, 1.5 million km sunward), sped up
  about 6,000 times (a crossing takes a minute here, days in reality). *Arriving gusts, shocks and CMEs*: markers where a CME (NASA DONKI), a high-speed stream
  (NOAA's Enlil forecast at Earth) or a shock the L1 spacecraft has just seen would be now, with the arrival time. *Flow map*: **NOAA's WSA-Enlil model picture**
  (speed or density, hourly for about a week, out to 1.7 AU) laid flat in the plane of the planets and turned so the picture's Earth lies on the real Earth: a
  forecast **model and a 2D slice**, not a measurement; outside the days NOAA covers it is hidden and the panel says so.
- **Dashboard:** *Magnetic field and solar wind* (wind, Bz, magnetopause, Dst graph, a bar per magnetometer) and *Solar wind forecast* (the Enlil picture and
  the wind at Earth for the coming week). **Alerts (Sky, on by default):** *Southward Bz* (below -10 nT for 15 minutes), *Solar wind shock* (seen at L1, about an hour
  before Earth) and *Magnetic storm under way* (Dst -50). Forecast storms, CMEs and fast streams also appear in the calendar.

## Sky calendar

*Sky Calendar* in the sidebar (and three Dashboard cards in a *Sky calendar* section): everything that happens in **your** sky (saved location), computed here.
Files: `lib/eventsSky.ts` (Moon, planets, showers, eclipses, seasons), `lib/eventsOccult.ts`, `lib/eventsSmall.ts` (comets, asteroids), `lib/eventsSpace.ts` (aurora,
CMEs, satellite passes), `lib/eventScore.ts`, `lib/eventIcs.ts`, `lib/skyCalendar.ts`, `scripts/events.check.ts` (real dates: the 3 Mar 2026 total lunar eclipse,
the 2 Aug 2027 eclipse total from Luxor and 42% from London, the oppositions, solstices, Geminids...). Backend: `services/sky_events.py` (`/events/comets`, `/events/asteroids`, `/events/outlook`).

- **Views.** *Tonight* (how good the night is, the dark hours, the Moon, the planets up, the events), *This week* (the next seven nights), *Coming up* (a year, by
  month) and *Month* (a grid with the Moon phases and event icons; click a day). Filters by kind, and *Only what I can see*.
- **What is in it.** Moon phases, supermoons, the Moon near planets; planet oppositions, greatest elongations, planets close together, the brightest Venus; meteor
  showers (peak from the Sun's longitude, the radiant's height and the Moon at your place, an expected rate); solar and lunar eclipses (how much you would see,
  the Sun's height); lunar **occultations** of planets and bright stars for your exact spot (disappearance and reappearance times, which edge); visible ISS and
  Tiangong passes (10 days ahead); comets predicted to be brighter than magnitude 11 (**predicted from catalogue numbers, which are often wrong**), asteroids passing
  within 20 Moon distances; forecast aurora storms, CME arrivals and fast wind (NOAA, NASA); equinoxes, solstices, perihelion, the earliest and latest sunsets, the
  days astronomical darkness ends and returns.
- **Ratings.** Each event gets Good / Fair / Poor (0 to 100) at its best moment from the darkness, the Moon, how high it is and the **cloud forecast** (Open-Meteo,
  10 days); beyond that it says there is no forecast and uses the Moon and darkness only. It is a guide, not a promise.
- **Each event** has *Show in 3D* (Deep Space at that time, on the body), *Add to my calendar (.ics)* and *Remind me*; *Export shown events (.ics)* saves the filtered
  list for Google, Outlook or Apple Calendar (a file, not a live subscription).
- **Alert** *Sky event reminders* (Sky group, on by default): a few hours before (3 by default) an eclipse, shower, occultation, planet event, comet or aurora
  forecast that suits your sky (score 45+), and before any event you marked *Remind me*.
- Times are shown in this computer's time zone; nights use the place's solar day.

## The live Sun

The Deep Space Sun is a real picture of the Sun, with what it is doing, through the backend (`services/sun.py`,
`/sun/image`, `/sun/activity`, `/sun/settings`; cached in memory and on disk, the last answer is kept offline).

- **Surface.** A *Live Sun* tick box (on by default) wraps a real photograph of the Sun's Earth-facing side onto the 3D
  Sun: NASA's Solar Dynamics Observatory (SDO) through Helioviewer, switchable between visible light (sunspots), extreme
  ultraviolet 193 / 304 / 171 Å (the hot corona, prominences, the quiet corona) and the magnetic field. The picture is
  mapped exactly as the camera at Earth saw it (orthographic, solar north up, correct for the Earth-Sun distance and the
  Sun's tilt: `lib/sun.ts`, P and B0 checked against Meeus in `scripts/sun.check.ts`). **The far side of the Sun is not
  observed from Earth**, so it shows a dimmed mirror of the near side. The visible-light picture can be a few hours old;
  the panel says when each picture was taken. *View from Earth* flies to the Sun and looks at it the way SDO and SOHO do.
- **Corona and streamers.** The SOHO LASCO C2 (about 2.3 to 6 solar radii) and C3 (about 4 to 30) coronagraph pictures,
  turned into light on flat sheets that turn to face the camera wherever it is. This is an approximation: they are only
  exactly right seen from Earth.
- **CMEs.** NASA's DONKI catalogue of coronal mass ejections, each as a translucent bubble travelling outward along its
  measured direction (longitude / latitude, half-angle) at its measured speed (constant, from where it passed 21.5 solar
  radii), with a label; orange ones head for Earth and carry the predicted arrival (NASA's ENLIL model when it ran, else a
  rough constant-speed estimate, and the panel says which). Arrival times can be off by half a day.
- **Sunspot groups.** NOAA's numbered regions (AR numbers), labelled on the surface when you are close, drifting west
  about 13.2 degrees a day. **Flares:** the GOES X-ray level and flare list in the Sun panel.
- **History.** Move the scene's date and the pictures, CMEs and flares follow (the pictures are fetched for that date, at
  most one request per kind every 5 seconds while the date is moving). There is no live X-ray graph or sunspot list for
  past dates.
- **Dashboard:** *The Sun now* (a live picture, the 6-hour X-ray graph, the strongest flare of the last day) and *Solar
  storms and sunspots* (recent CMEs, any heading for Earth, sunspot groups with their flare chances), in a new *The Sun*
  section. **Alerts (Sky group, both on by default):** *Strong solar flare* (M5 or stronger, adjustable, announced once
  per flare, only if it peaked within the hour) and *CME heading for Earth* (once per CME, with the predicted arrival).
- **NASA key.** DONKI's shared demo key allows 30 requests an hour; the app asks at most once an hour. A free personal key
  from api.nasa.gov can be saved in Settings → The Sun.

## Fly-through and your location in Deep Space

- **Fly mode** (*Fly (F)* button or the F key): the mouse steers (the pointer is captured; if the system refuses, hold the
  left button and drag), **W A S D** move, **Space** up, **Ctrl** down, **Q / E** roll, **Shift** boosts, the **mouse wheel**
  scales the speed, **Esc** (or F) leaves and puts you in orbit around the nearest body. The speed follows how far you are
  from the nearest surface (about 60% of that height per second), so it crosses the solar system in seconds and creeps when
  it comes down to a planet; you cannot pass through a planet or the Sun (you stop at the surface, or the Sun's glowing outer
  layer). A readout shows the nearest body, your height, speed and multiplier. Maths in `lib/fly.ts` (`scripts/fly.check.ts`).
- **My location:** a pulsing green dot on the Earth at your saved location (the same one the Dashboard, Sky Overlay and
  Live View use), with a name label as you come close. *Set...* takes latitude and longitude as decimal degrees (west and
  south negative, or add W / S; degrees-minutes-seconds and a pasted "51.5074, -0.1278" also work) and *Fly there* dives to it.

## Notifications

Notifications page (Settings tab and History tab). **Types**, grouped Work / Live View / Sky / System, each with its own
on/off, an *Options* panel (delivery overrides: pop-up, Windows notification and sound each "like the general setting",
always or never; and that type's thresholds) and a *Send a test*:

| Type | When | Default |
| --- | --- | --- |
| Model training, star classifier, results processing, image import, watch folder | as before | as before |
| Live View | motion / meteor, photo, camera lost or back, sequence done | on |
| Camera health | Canon battery low (default 20%), card nearly full (100 shots left), mode dial not on M/B during a capture sequence | on |
| ISS pass | the ISS is about to pass your saved location: minutes ahead (10), minimum height (20°), only passes you could see | off |
| Lightning near you | a strike within a distance of your saved location (25 / 50 / 100 / 250 km), then quiet for 30 min | on |
| Storm approaching | lightning within 150 km whose centre has moved closer (at least 15 km/h) between two 10-minute looks | on |
| Clear night ahead | once a day, 1 hour before sunset, when the forecast for the dark hours averages 30% cloud or less; includes the Moon | off |
| Aurora at your location | the forecast chance over your location passes 20% (adjustable) and it is dark; again only after it has dropped and come back, 3 h later | on |
| Geomagnetic storm | Kp reaches 5 (adjustable), same repeat rule | on |
| Strong solar flare | a flare of M5 or stronger (adjustable) has peaked within the last hour | on |
| CME heading for Earth | NASA's catalogue has a coronal mass ejection with a predicted Earth arrival (announced once, with the time) | on |
| Data out of date | satellite orbit data older than 7 days, or the live cloud map failing to refresh (at most once a day each) | off |
| Disk space low | under 10 GB free on the drive the library and Live View captures use (once a day) | on |

The sky alerts need your saved location (Dashboard) and the app running; the lightning ones need lightning collection
on (Settings → Lightning); the page says so next to a type that cannot work. **Quiet hours** (a start and end time, may
run past midnight) silence everything, pop-ups and sound alike; nothing is lost, it all goes to the **History** (the
last 200, unread ones counted on the sidebar's bell). **Click to open:** clicking a pop-up, or a Windows notification, or
a History row takes you to the right page (ISS and clear night: Dashboard, lightning: the globe, camera: Live View...).
The decisions are pure functions in `notifications/alertLogic.ts` (`scripts/alerts.check.ts`); the background checks are
`notifications/AlertWatchers.tsx`; `/dashboard/disk` reports free space.

## Dashboard, weather and the Earth

- **Dashboard layout:** the default is five titled sections (Status, Tonight's sky, Space and storms, Cameras and
  library, Training) whose rows add up to four columns, so there are no gaps or ragged edges; the section titles are
  widgets too (movable, removable, and in the *Add a widget* tray under *Layout*). Someone whose saved layout was exactly
  an earlier default is moved to this one automatically; anyone who rearranged theirs keeps it (*Reset layout* gives the new
  default). The Storage card also shows free space on the drive, and the ISS card puts its map above the details when
  its widget is narrow.
- **Customizable dashboard:** *Customize* (top right) turns on edit mode: drag any widget to a new place (or use the
  ‹ › buttons), resize it by dragging the **corner handle** (sideways snaps to 1-4 columns, up and down sets a height;
  double-click the handle for the height the content needs), or use the 1-4 buttons, remove it (✕), and add any hidden
  widget back from the *Add a widget* tray.
  *Reset layout* restores the original. The layout is remembered per computer (`localStorage`, key
  `night-identifier:dashboard-layout`). Widgets are defined in `components/dashboard/widgets.tsx`: add one there and it
  appears in the tray.
- **Your sky** (Dashboard): the ISS card above, *Tonight* (sunset, when it is fully dark, how much of that is Moon-free,
  Moon phase / rise / set), *Planets now* (altitude, direction, rise times), *Weather* (conditions and the next 12 hours
  of cloud cover, from Open-Meteo through the backend, cached 10 min) and *Cameras*. Sun, Moon and planets come from
  astronomy-engine (`lib/skyTonight.ts`).
- **Deep Space, the Earth in real time:** the Sun's light is the real Sun for the scene's date (day/night line, sunset
  glow on the atmosphere, the ocean's glint), the night side shows the world's city lights, and *Live clouds* lays the
  real cloud cover (a weather-satellite infrared composite from clouds.matteason.co.uk, refreshed about every 3 hours;
  the backend caches it, `services/weather.py`) on the globe. They are today's clouds, so they fade out when the scene's
  date is more than a day from now. The poles have no data in that composite, so clouds fade out above 74° latitude.

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
node --import ./scripts/ts-resolve.mjs scripts/satellites.check.ts   # satellites vs. skyfield
```

Not included: constellation-boundary regions (no boundary data in the catalogue yet) and a trained
star detector (the classical detector feeds the solver).

## Status

This is an early scaffold: the app shell, navigation, theming, and backend connectivity are
wired and verified end-to-end. Most feature pages (Annotate, Train, Results Gallery,
Map, Upload & Watch Folder, Object Library) are placeholders pending
implementation. `torch`/`ultralytics` are intentionally not yet in `backend/pyproject.toml` —
they'll be added when the Train page is built, with GPU/CPU-aware install selection.
