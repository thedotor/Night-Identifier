Night Identifier
Sky Overlay
Live View
Solar System
Earth
All features
Tech
Windows desktop app
Point a camera at the sky.
Know exactly what you're looking at.
Night Identifier overlays real stars, constellations and deep-sky objects on your astrophotos, tracks a live camera feed, and renders a real-time 3D solar system — all running locally, with your own trainable object detector underneath.

See the feature breakdown
What it's built with
Night Identifier dashboard showing status widgets, live web traffic, and a lightning map
18
working pages, sidebar to settings
15k+
catalogue stars, live-projected
100%
local backend, your own data
Real
NASA / NOAA / USGS data feeds
Identify
Sky Overlay
Drop in a photo and the app plate-solves it against a real star catalogue, then draws constellations, asterisms, deep-sky objects and planets directly over your frame.

Dashboard 
<img width="3832" height="2066" alt="das" src="https://github.com/user-attachments/assets/746bcf1f-41b3-4f4b-afee-98b448fd65bb" />
<img width="3834" height="2066" alt="image" src="https://github.com/user-attachments/assets/8e9b40b2-fd3d-412c-b68e-271906b57934" />

Auto-align from EXIF (GPS, time, focal length) or pick reference stars by hand
Rectilinear and fisheye lens models, with distortion correction
Click any star or object in the overlay for its catalogue details
Constellation lines, artwork, asterisms, nebulae and galaxies as toggleable layers
Sky Overlay page with constellation lines and star labels aligned over a night sky photo
Capture
Live View
A multi-camera grid for whatever's plugged in or on the network — USB webcams, IP cameras, ASCII/ASCOM astro gear, ZWO cameras and Canon EDSDK bodies.

<img width="3832" height="2070" alt="image overlay" src="https://github.com/user-attachments/assets/33d8ba14-57bc-46dc-95e2-fad7286d423b" />

Auto, 1/2/3-column layouts, plus a red filter for preserving night vision
Focus assist, exposure and capture controls per camera
Built-in motion and meteor detection on the live feed
One click sends a frame straight into the training pipeline
Live View page with a camera grid and layout controls
Explore
Solar System, in real time
A full 3D flythrough of the solar system built on real orbital mechanics — planets, moons, comets, dwarf planets and the Kuiper belt, all where they actually are right now.

<img width="3834" height="2072" alt="overlay" src="https://github.com/user-attachments/assets/6112071a-c7a6-4071-be1a-48f30dbab4f1" />

Scrub from "inner planets" out to the cosmic web in one continuous zoom
Live comet and asteroid positions, with named approach highlights
Fly mode for a free-roam camera through the whole scene
Play, pause, reverse or jump the clock to any date
3D Solar System view showing planets, dwarf planets, orbits and named comets
Explore
Earth, lit by the real Sun
The same 3D engine, pointed at home: live cloud cover, real day/night shading, city lights, and a stack of overlays layered on top.

<img width="3832" height="2070" alt="earth" src="https://github.com/user-attachments/assets/a3daae9c-386d-4635-b535-3e25f57dbd80" />


Satellites, aircraft, ships and your own web traffic, all plotted live
Aurora, lightning, earthquakes and volcanic activity as hazard layers
Live Sun imagery, solar wind and magnetic field lines
Sharp streamed imagery down to street level when you zoom in
3D Earth view at night showing city lights and the day/night terminator over Western Europe
Explore
Deep-Sky Objects
A browsable catalogue of everything worth pointing a telescope at — planets, the Messier and NGC/IC catalogues, and bright stars — with imagery cached for offline use.

<img width="3834" height="2070" alt="earth toggle" src="https://github.com/user-attachments/assets/a87f73d8-61d7-4373-a078-36d4b447c64c" />

Search by name or catalogue number
Jump here straight from an object picked in Sky Overlay
Images are downloaded once and kept locally afterwards
Deep-Sky Objects browser listing planets, stars and NGC/IC catalogue entries
Organize
Map
Every photo with GPS EXIF plots itself on a map automatically, alongside places you've saved by hand — a quick way to see where a session actually happened.

Geotagged imports show up with zero setup
Add and name your own observing spots
Shared location model with the rest of the app (calendar, dashboard, overlays)
Map page showing a world map ready to plot geotagged photo locations
There's more underneath
The rest of the sidebar, in brief.

📅
Sky Calendar
Nights, moon phases, meteor showers, eclipses, occultations and satellite passes, computed from real astronomy for your location.

<img width="3839" height="2073" alt="sky calendar" src="https://github.com/user-attachments/assets/c0b1e330-6995-4556-8c4b-a34751315e66" />

⚡
Space weather & aurora
NOAA aurora oval, Kp index, solar wind, CMEs and flares, plus IGRF-14 magnetic field lines around the planet.

<img width="3834" height="2070" alt="sun" src="https://github.com/user-attachments/assets/1e534906-8707-42b1-98d4-bd77ef1584f0" />

🌀
Hazards
Live earthquakes, volcanic activity and wildfire heat spots from USGS, GVP and FIRMS, with optional notifications.

<img width="3827" height="2073" alt="hazards" src="https://github.com/user-attachments/assets/1e0f4181-7196-482d-92e9-ecfcf06b5583" />


✈
Traffic
Aircraft and ships tracked live over the 3D Earth, plus a private view of your own PC's outbound network connections.

<img width="3832" height="2070" alt="traffic" src="https://github.com/user-attachments/assets/5af21658-8326-4e44-b537-e70485c39690" />


🎯
Object detector training
Annotate photos by hand, queue GPU training runs, and browse results — Upload & Watch Folder, Annotate, Train, Object Library and Results Gallery all feed the same model.

<img width="3836" height="2070" alt="tranning" src="https://github.com/user-attachments/assets/48a280fb-3488-4017-b424-65669b3fd6c0" />


🔔
Notifications & dashboard
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
