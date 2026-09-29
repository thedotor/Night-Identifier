# Security and privacy notes

Night Identifier runs entirely on your PC. There is no account, no telemetry and no server of ours.

## How the app is put together

- The window is Electron (sandboxed, context-isolated, no Node in the page). It starts a local Python
  backend on `127.0.0.1:8765`.
- Every request the app's windows make to that backend carries a random per-launch token; the backend
  refuses anything without it and refuses foreign `Host` headers. Web pages you have open in a browser
  can't use the local API. (In development, `npm run dev:backend` runs without the token check.)
- Links open in your default browser only when they are `http`/`https`. The app can only ask Windows to
  open folders and image files, never programs.
- Camera passwords (and stream URLs that contain a login) are encrypted on disk with Windows DPAPI, so they
  can only be read by your Windows account on this PC. If you copy your data folder to another PC or user,
  re-enter the camera passwords there.
- Photos, the database, trained models and caches stay in your data folder (default `Documents\Night Identifier`).
- API keys you paste in Settings (NASA, aisstream.io, FIRMS) are encrypted the same way and are never sent
  back to the app window.

## Where the app connects to (all outbound, all optional features)

Only when the matching page/feature is used. Requests carry no personal data beyond what the request needs
(for example, your latitude/longitude if you set "Your location" for weather and pass predictions).

| Purpose | Hosts |
| --- | --- |
| Deep-sky, stars, images | alasky.cds.unistra.fr, simbad/vizier/tapvizier.cds.unistra.fr, upload/thumb.wikimedia.org, commons.wikimedia.org, en.wikipedia.org, exoplanetarchive.ipac.caltech.edu, www.solarsystemscope.com |
| Solar system, comets, asteroids | ssd.jpl.nasa.gov, ssd-api.jpl.nasa.gov |
| Satellites | celestrak.org |
| Space weather, Sun | services.swpc.noaa.gov, www.swpc.noaa.gov, api.helioviewer.org, helioviewer.org, api.nasa.gov, kauai.ccmc.gsfc.nasa.gov, wdc.kugi.kyoto-u.ac.jp |
| Earth, weather, clouds | api.open-meteo.com, noaa-gfs-bdp-pds.s3.amazonaws.com, clouds.matteason.co.uk, gibs.earthdata.nasa.gov, tiles.maps.eox.at / s2maps.eu, registry.opendata.aws, tds.hycom.org, www.ngdc.noaa.gov, geomag.usgs.gov |
| Quakes, volcanoes, fires | earthquake.usgs.gov, volcanoes.usgs.gov, volcano.si.edu, firms.modaps.eosdis.nasa.gov |
| Aircraft, ships, lightning | opensky-network.org, adsb.fi / opendata.adsb.fi, meri.digitraffic.fi, stream.aisstream.io, www.blitzortung.org (and its servers) |
| Web traffic (only when you click *Update IP database*) | download.db-ip.com (the monthly DB-IP Lite file; no addresses are sent) |
| Map tiles (in the window) | *.tile.openstreetmap.org |

**Web traffic layer.** Off until you switch it on. It reads Windows' own table of open connections (psutil; no packet capture, no driver, no
administrator rights), keeps only public internet addresses, and places them with a database on the PC (DB-IP Lite), so no address is sent
to anyone. What it shows live stays in memory. The optional history (country, city and program name per hour; never an address, port or
URL) lasts 7 days, is encrypted with Windows DPAPI for your account (nothing is written where DPAPI is unavailable), and *Clear history*
deletes it. The one lookup that does send an address out is the *Look up name* button on a destination: it asks this PC's DNS server for
that single address's host name, and only for an address the monitor is currently tracking.

Live View talks to cameras on your own network (RTSP/HTTP/ONVIF, Alpaca/ASCOM) and to a Canon camera over USB.

## Verifying a download

Each release ships `SHA256SUMS.txt`. Compare with `Get-FileHash <file> -Algorithm SHA256` in PowerShell.
If the installer is code-signed, right-click the file, Properties, Digital Signatures.

## Reporting a problem

Open an issue on the project's GitHub page, or contact the author directly for anything sensitive.
