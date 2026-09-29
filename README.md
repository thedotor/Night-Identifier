<img width="50" height="50" alt="icon" src="https://github.com/user-attachments/assets/85326956-0a3d-4f40-b764-760afd71a1cd" />  **Night Identifier**

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

Night Identifier overlays real stars, constellations and deep-sky objects on your astrophotos, tracks a live camera feed, and renders a real-time 3D solar system — all running locally, with your own trainable object detector for sorting objects in the picture into folders underneath.

15k+ catalogue stars, live-projected
local backend, your own data
Real NASA / NOAA / USGS data feeds + API Keys 
Drop in a photo and the app plate-solves it against a real star catalogue, then draws constellations, asterisms, deep-sky objects and planets directly over your frame. Also supports manual aliment.

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**Download**

Get the Windows installer from the [latest release](https://github.com/thedotor/Night-Identifier/releases/latest). Download all three `Night-Identifier-Setup` files into one folder, then run `Night-Identifier-Setup.exe`.

> The installer isn't code-signed yet, so Windows SmartScreen may show a warning. Click **More info → Run anyway**. You can verify your download against `SHA256SUMS.txt` on the release page.

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**Dashboard** 

<img width="1918" height="1043" alt="dash 1" src="https://github.com/user-attachments/assets/b13ffaf5-dc9c-47f0-8940-89b34a165b41" /> 
                                             
<img width="1917" height="1041" alt="image" src="https://github.com/user-attachments/assets/ac550b2d-6a97-4664-867c-192861042adc" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**Sky Overlay**

Auto-align from EXIF (GPS, time, focal length) or pick reference stars by hand
Rectilinear and fisheye lens models, with distortion correction
Click any star or object in the overlay for its catalogue details
Constellation lines, artwork, asterisms, nebulae and galaxies as toggleable layers
Sky Overlay page with constellation lines and star labels aligned over a night sky photo
A multi-camera grid for whatever's plugged in or on the network — USB webcams, IP cameras, ASCII/ASCOM astro gear, ZWO cameras and Canon EDSDK bodies.


<img width="3836" height="2070" alt="overlay pic" src="https://github.com/user-attachments/assets/08c8d411-dc9a-43b2-8011-090ac2395ada" />


<img width="3836" height="2070" alt="new" src="https://github.com/user-attachments/assets/335cb25c-9bb1-41a8-8b29-b6d188a1f124" />

Focus assist, exposure and capture controls per camera
Built-in motion and meteor detection on the live feed
Live View page with a camera grid and layout controls, plus a red filter for preserving night vision

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**Solar System**

Explore the Solar System, in real time
A full 3D flythrough of the solar system built on real orbital mechanics — planets, moons, comets, dwarf planets and the Kuiper belt, all where they actually are right now.
Scrub from "inner planets" out to the cosmic web in one continuous zoom
Live comet and asteroid positions, with named approach highlights
Fly mode for a free-roam camera through the whole scene
Play, pause, reverse or jump the clock to any date
3D Solar System view showing planets, dwarf planets, orbits and named comets
Explore the Earth, lit by the "real" Sun
The same 3D engine, pointed at home: live cloud cover, real day/night shading, city lights, and a stack of overlays layered on top.

<img width="3838" height="2082" alt="solar" src="https://github.com/user-attachments/assets/bc1a83cc-d926-46be-8c03-eac8f4242118" />


----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**Earth**

Satellites, aircraft, ships and your own web traffic, Aurora, lightning, earthquakes and volcanic activity as hazard layers all plotted live
Live Sun imagery, solar wind and magnetic field lines
Sharp streamed imagery down to street level when you zoom in
3D Earth view at night showing city lights and the day/night terminator over Western Europe
Explore Deep-Sky Objects
A browsable catalogue of everything worth pointing a telescope at — planets, the Messier and NGC/IC catalogues, and bright stars — with imagery cached for offline use.

<img width="3832" height="2086" alt="Screenshot 2026-09-29 210634" src="https://github.com/user-attachments/assets/38c30989-bc1f-420f-8dd9-c4c81540d868" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

📅
**Sky Calendar**
Nights, moon phases, meteor showers, eclipses, occultations and satellite passes, computed from real astronomy for your location.

<img width="1918" height="1044" alt="Screenshot 2026-09-29 210758" src="https://github.com/user-attachments/assets/476dd9a5-5946-467d-8499-f57782d5fdd6" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

⚡
**Space weather & aurora**
NOAA aurora oval, Kp index, solar wind, CMEs and flares, plus IGRF-14 magnetic field lines around the planet.

<img width="3832" height="2082" alt="cme" src="https://github.com/user-attachments/assets/40b42337-e3bb-40a2-9002-ae12b9663835" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

🌀
**Hazards**
Live earthquakes, volcanic activity and wildfire heat spots from USGS, GVP and FIRMS, with optional notifications.

<img width="3832" height="2082" alt="haz" src="https://github.com/user-attachments/assets/0c533ce9-e437-49b5-8e1e-a4363eb3098a" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

✈
**Traffic**
Aircraft and ships tracked live over the 3D Earth, plus a private view of your own PC's outbound network connections.

<img width="3832" height="2085" alt="traffic" src="https://github.com/user-attachments/assets/3879ffe1-82fa-4bf4-afdf-9bab675074d6" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

🎯
**Object detector training**
Annotate photos by hand, queue GPU training runs, and browse results — Upload & Watch Folder, Annotate, Train, Object Library and Results Gallery all feed the same model.
Officially supports RTX 50-series (Blackwell) and remains backward-compatible with 40/30/20/10-series; falls back to CPU automatically if no compatible GPU is found.

<img width="3827" height="2068" alt="train" src="https://github.com/user-attachments/assets/63ececb7-e49f-4b3e-b733-33a36e5042aa" />

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

🔔
**Notifications & dashboard**
A fully customizable dashboard of drag-and-resize widgets, with alerts for the events you actually care about.

Built with
Electron
React + TypeScript
Three.js / WebGL
Python + FastAPI
Skyfield / SGP4
IGRF-14
NOAA
USGS
NASA / JPL
Night Identifier
A local-first desktop app — runs entirely on your own machine, with your own data.

----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**License**

Night Identifier is free software under the [GNU AGPL-3.0](LICENSE) (see also [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). You may use, modify and redistribute it, provided derived work is released under the same license with its source available. It builds on third-party libraries (including Ultralytics, also AGPL-3.0) and public data feeds that keep their own licenses and terms.
