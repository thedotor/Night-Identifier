// Who made the data, images and software each part of the app is built on. Shown on the About page.
// Licences are stated only where the code or the source itself states one; the rest name the provider.

export interface Credit {
  /** what the app uses it for */
  what: string
  /** who provides it */
  source: string
  licence?: string
  url?: string
}

export interface CreditSection {
  id: string
  title: string
  summary: string
  credits: Credit[]
}

const NOAA_SWPC: Credit = {
  what: 'Aurora forecast, solar wind, Kp index, X-ray flares, sunspot regions',
  source: 'NOAA Space Weather Prediction Center',
  licence: 'Public domain',
  url: 'https://www.swpc.noaa.gov'
}
const NOAA_ENLIL: Credit = {
  what: 'Solar-wind model frames (a forecast model, not a measurement)',
  source: 'NOAA SWPC WSA-Enlil',
  url: 'https://www.swpc.noaa.gov/products/wsa-enlil-solar-wind-prediction'
}
const USGS_GEOMAG: Credit = {
  what: 'Live ground magnetometer readings',
  source: 'U.S. Geological Survey Geomagnetism Program',
  licence: 'Public domain',
  url: 'https://geomag.usgs.gov'
}
const KYOTO_DST: Credit = {
  what: 'Dst storm index',
  source: 'World Data Center for Geomagnetism, Kyoto, via NOAA SWPC',
  url: 'https://wdc.kugi.kyoto-u.ac.jp'
}
const HELIOVIEWER: Credit = {
  what: 'Live Sun images (SDO HMI and AIA, SOHO LASCO coronagraphs)',
  source: 'NASA Solar Dynamics Observatory and ESA/NASA SOHO, served by Helioviewer',
  url: 'https://helioviewer.org'
}
const DONKI: Credit = {
  what: 'Coronal mass ejections and their predicted arrival',
  source: 'NASA Community Coordinated Modeling Center, DONKI',
  url: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/'
}
const OPEN_METEO: Credit = {
  what: 'Weather and cloud forecasts for your location',
  source: 'Open-Meteo.com',
  url: 'https://open-meteo.com'
}
const CLOUDS: Credit = {
  what: 'Live cloud cover on the globe',
  source: 'clouds.matteason.co.uk, a composite of weather-satellite infrared images',
  url: 'https://clouds.matteason.co.uk'
}
const CELESTRAK: Credit = {
  what: 'Satellite and ISS orbital elements (propagated with SGP4)',
  source: 'CelesTrak',
  url: 'https://celestrak.org'
}
const LIGHTNING: Credit = {
  what: 'Live lightning strikes',
  source: 'Blitzortung.org contributors',
  licence: 'Private, non-commercial use',
  url: 'https://www.blitzortung.org'
}
const DBIP: Credit = {
  what: 'Places for the addresses in Web traffic (looked up on this PC, nothing is sent)',
  source: 'IP to City Lite by DB-IP.com',
  licence: 'CC BY 4.0',
  url: 'https://db-ip.com'
}
const QUAKES: Credit = {
  what: 'Earthquakes',
  source: 'USGS Earthquake Hazards Program',
  licence: 'Public domain',
  url: 'https://earthquake.usgs.gov'
}
const VOLCANOES: Credit = {
  what: 'Volcano locations and activity reports',
  source: 'NOAA NCEI volcano locations; Smithsonian / USGS Weekly Volcanic Activity Report; USGS Volcano Hazards Program',
  url: 'https://volcano.si.edu'
}
const FIRMS: Credit = {
  what: 'Satellite heat detections (needs a free key in Settings)',
  source: 'NASA FIRMS (VIIRS)',
  url: 'https://firms.modaps.eosdis.nasa.gov'
}
const AIRCRAFT_NEAR: Credit = {
  what: 'Aircraft near you',
  source: 'adsb.fi open data (ADS-B)',
  url: 'https://adsb.fi'
}
const AIRCRAFT_WORLD: Credit = {
  what: 'Aircraft worldwide',
  source: 'The OpenSky Network, anonymous ADS-B snapshot',
  url: 'https://opensky-network.org'
}
const SHIPS: Credit = {
  what: 'Baltic ships (AIS)',
  source: 'Digitraffic / Fintraffic',
  licence: 'CC BY 4.0',
  url: 'https://www.digitraffic.fi'
}
const SHIPS_WORLD: Credit = {
  what: 'Worldwide ships (AIS, needs a free key in Settings)',
  source: 'aisstream.io',
  url: 'https://aisstream.io'
}
const WIND: Credit = {
  what: 'Wind at four heights',
  source: 'NOAA GFS model (NOAA / NCEP), through the NOAA open-data programme on AWS',
  url: 'https://registry.opendata.aws/noaa-gfs-bdp-pds/'
}
const CURRENTS: Credit = {
  what: 'Ocean currents',
  source: 'HYCOM + NCODA global analysis and forecast, HYCOM Consortium',
  url: 'https://www.hycom.org'
}
const IGRF: Credit = {
  what: "Earth's magnetic field lines (IGRF-14 model)",
  source: 'International Association of Geomagnetism and Aeronomy, via NOAA NCEI',
  url: 'https://www.ngdc.noaa.gov/IAGA/vmod/igrf.html'
}
const ASTRONOMY_ENGINE: Credit = {
  what: 'Positions of the Sun, Moon and planets, rise and set times, eclipses, phases',
  source: 'astronomy-engine by Don Cross',
  licence: 'MIT',
  url: 'https://github.com/cosinekitty/astronomy'
}
const JPL_MOONS: Credit = {
  what: 'Moon orbits',
  source: 'NASA/JPL Horizons',
  url: 'https://ssd.jpl.nasa.gov/horizons/'
}
const JPL_SBDB: Credit = {
  what: 'Comet and asteroid orbits and close approaches',
  source: 'NASA/JPL Small-Body Database and Close Approach Data',
  url: 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html'
}
const CATALOGUE_STARS: Credit = {
  what: 'Stars to magnitude 6, star names, constellation lines',
  source: 'd3-celestial by Olaf Frohn (Hipparcos-derived)',
  licence: 'BSD 3-Clause',
  url: 'https://github.com/ofrohn/d3-celestial'
}
const OPENNGC: Credit = {
  what: 'Messier, NGC, IC and Caldwell objects: positions, sizes, types',
  source: 'OpenNGC by Mattia Verga and contributors',
  licence: 'CC BY-SA 4.0',
  url: 'https://github.com/mattiaverga/OpenNGC'
}
const SURVEYS: Credit = {
  what: 'Sky photographs of any patch of sky (DSS2, Pan-STARRS DR1, 2MASS)',
  source: 'STScI / ESO / Caltech (DSS2), PS1 Science Consortium, UMass / IPAC-Caltech / NASA / NSF (2MASS), through CDS Strasbourg hips2fits',
  licence: 'Free for education and research; credit required',
  url: 'https://alasky.cds.unistra.fr/hips-image-services/hips2fits'
}
const HIPPARCOS: Credit = {
  what: 'Star distances and motions for the 3D star cloud',
  source: 'Hipparcos (ESA 1997; van Leeuwen 2007 re-reduction), via VizieR / CDS',
  url: 'https://vizier.cds.unistra.fr'
}
const SIMBAD: Credit = {
  what: 'Distances and galaxy shapes',
  source: 'SIMBAD, CDS Strasbourg',
  url: 'https://simbad.cds.unistra.fr'
}
const EXOPLANETS: Credit = {
  what: 'Exoplanet host stars and planetary systems',
  source: 'NASA Exoplanet Archive',
  url: 'https://exoplanetarchive.ipac.caltech.edu'
}
const TWOMRS: Credit = {
  what: 'Positions and redshifts of the 43,000 galaxies in the cosmic web',
  source: '2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26), via VizieR / CDS',
  url: 'https://vizier.cds.unistra.fr'
}
const LOCAL_GROUP: Credit = {
  what: 'Local Group galaxies',
  source: 'McConnachie (2012), AJ 144, 4, via VizieR / CDS',
  url: 'https://vizier.cds.unistra.fr'
}
const PLANET_MAPS: Credit = {
  what: 'Planet and Moon surface maps',
  source: 'Solar System Scope',
  licence: 'CC BY 4.0',
  url: 'https://www.solarsystemscope.com/textures'
}
const BLUE_MARBLE: Credit = {
  what: 'Earth by day (Blue Marble) and by night (Black Marble)',
  source: 'NASA Earth Observatory, through NASA GIBS',
  url: 'https://earthdata.nasa.gov/gibs'
}
const SENTINEL: Credit = {
  what: 'Sharp close-up imagery when you zoom in on Earth',
  source: 'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2021)',
  licence: 'CC BY-NC-SA 4.0 (non-commercial)',
  url: 'https://s2maps.eu'
}
const NATURAL_EARTH: Credit = {
  what: 'City names and positions',
  source: 'Natural Earth',
  licence: 'Public domain',
  url: 'https://www.naturalearthdata.com'
}
const WIKIPEDIA: Credit = {
  what: 'Object descriptions and curated photographs',
  source: 'Wikipedia and Wikimedia Commons, each photograph credited to its author',
  licence: "Each photograph's own licence, shown beside it",
  url: 'https://commons.wikimedia.org'
}
const CONSTELLATION_ART: Credit = {
  what: 'Classical constellation illustrations (the lion, the hunter, the swan ...)',
  source: "Stellarium's \"modern\" sky culture",
  licence: 'Illustrations: Free Art License 1.3. Data: CC BY-SA 4.0',
  url: 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern'
}

export const CREDIT_SECTIONS: CreditSection[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    summary: 'The cards that watch the sky, the Sun and the Earth for you.',
    credits: [
      OPEN_METEO,
      CELESTRAK,
      NOAA_SWPC,
      USGS_GEOMAG,
      KYOTO_DST,
      NOAA_ENLIL,
      HELIOVIEWER,
      DONKI,
      LIGHTNING,
      QUAKES,
      VOLCANOES,
      FIRMS,
      { ...JPL_SBDB, what: 'Comets and close-approaching asteroids in the events cards' },
      ASTRONOMY_ENGINE
    ]
  },
  {
    id: 'live',
    title: 'Live View',
    summary: 'Cameras and the star overlay drawn on top of their feeds.',
    credits: [
      {
        what: 'Canon EOS camera control',
        source: "Canon's EDSDK, which you download from Canon yourself; it is not bundled",
        url: 'https://developers.canon-europe.com/developers/s/'
      },
      {
        what: 'IP camera discovery and control',
        source: 'ONVIF open standard',
        url: 'https://www.onvif.org'
      },
      CATALOGUE_STARS,
      OPENNGC,
      CELESTRAK,
      AIRCRAFT_NEAR,
      AIRCRAFT_WORLD,
      ASTRONOMY_ENGINE
    ]
  },
  {
    id: 'sky-overlay',
    title: 'Sky Overlay',
    summary: 'A photograph laid over the sky with stars, objects, constellations and satellites.',
    credits: [CATALOGUE_STARS, OPENNGC, CONSTELLATION_ART, SURVEYS, CELESTRAK, AIRCRAFT_NEAR, AIRCRAFT_WORLD, ASTRONOMY_ENGINE, JPL_MOONS]
  },
  {
    id: 'solar-system',
    title: 'Solar System',
    summary: 'The 3D scene: planets, moons, satellites, stars, galaxies and everything happening on and around the Earth.',
    credits: [
      ASTRONOMY_ENGINE,
      JPL_MOONS,
      JPL_SBDB,
      PLANET_MAPS,
      CELESTRAK,
      HIPPARCOS,
      EXOPLANETS,
      SIMBAD,
      LOCAL_GROUP,
      TWOMRS,
      CATALOGUE_STARS,
      HELIOVIEWER,
      DONKI,
      NOAA_SWPC,
      NOAA_ENLIL,
      IGRF,
      USGS_GEOMAG,
      WIND,
      CURRENTS,
      CLOUDS,
      LIGHTNING,
      QUAKES,
      VOLCANOES,
      FIRMS,
      AIRCRAFT_NEAR,
      AIRCRAFT_WORLD,
      SHIPS,
      SHIPS_WORLD,
      NATURAL_EARTH
    ]
  },
  {
    id: 'earth',
    title: 'Earth',
    summary: 'The globe on its own, with the same live layers.',
    credits: [BLUE_MARBLE, SENTINEL, NATURAL_EARTH, CLOUDS, WIND, CURRENTS, NOAA_SWPC, LIGHTNING, DBIP, QUAKES, VOLCANOES, FIRMS, AIRCRAFT_NEAR, AIRCRAFT_WORLD, SHIPS, CELESTRAK]
  },
  {
    id: 'deep-sky',
    title: 'Deep-Sky Objects',
    summary: 'The object browser: descriptions, photographs and facts.',
    credits: [OPENNGC, WIKIPEDIA, SURVEYS, SIMBAD, HIPPARCOS]
  },
  {
    id: 'calendar',
    title: 'Sky Calendar',
    summary: 'What is worth going out for, tonight and over the coming weeks.',
    credits: [ASTRONOMY_ENGINE, JPL_SBDB, OPEN_METEO, NOAA_SWPC]
  },
  {
    id: 'identify',
    title: 'Annotate, Train, Results and Star Classifier',
    summary: 'Teaching the app to spot objects in your photographs.',
    credits: [
      {
        what: 'Object detection models and training',
        source: 'Ultralytics YOLOv8',
        licence: 'AGPL-3.0',
        url: 'https://github.com/ultralytics/ultralytics'
      },
      {
        what: 'Deep-learning framework',
        source: 'PyTorch',
        licence: 'BSD-style',
        url: 'https://pytorch.org'
      },
      {
        what: 'Reference stars for constellation matching',
        source: CATALOGUE_STARS.source,
        licence: CATALOGUE_STARS.licence,
        url: CATALOGUE_STARS.url
      }
    ]
  },
  {
    id: 'upload',
    title: 'Upload and Watch Folder',
    summary: 'Importing photographs, including camera RAW files.',
    credits: [
      { what: 'RAW file decoding', source: 'LibRaw, through rawpy', url: 'https://www.libraw.org' },
      { what: 'Image handling', source: 'Pillow and OpenCV', url: 'https://python-pillow.org' },
      { what: 'Watching a folder for new files', source: 'watchdog', licence: 'Apache-2.0', url: 'https://github.com/gorakhargosh/watchdog' }
    ]
  },
  {
    id: 'map',
    title: 'Map',
    summary: 'Where your geotagged photographs were taken.',
    credits: [
      {
        what: 'Map tiles and data',
        source: '© OpenStreetMap contributors',
        licence: 'ODbL',
        url: 'https://www.openstreetmap.org/copyright'
      },
      { what: 'Map display', source: 'Leaflet', licence: 'BSD-2-Clause', url: 'https://leafletjs.com' }
    ]
  }
]

export interface Library {
  name: string
  what: string
  licence: string
  url: string
}

export const LIBRARIES: Library[] = [
  { name: 'Electron', what: 'Desktop shell', licence: 'MIT', url: 'https://www.electronjs.org' },
  { name: 'React', what: 'User interface', licence: 'MIT', url: 'https://react.dev' },
  { name: 'three.js', what: '3D graphics', licence: 'MIT', url: 'https://threejs.org' },
  { name: 'Konva', what: '2D canvas drawing', licence: 'MIT', url: 'https://konvajs.org' },
  { name: 'Leaflet', what: 'Maps', licence: 'BSD-2-Clause', url: 'https://leafletjs.com' },
  { name: 'astronomy-engine', what: 'Astronomical calculations', licence: 'MIT', url: 'https://github.com/cosinekitty/astronomy' },
  { name: 'satellite.js', what: 'Satellite orbit propagation (SGP4)', licence: 'MIT', url: 'https://github.com/shashwatak/satellite-js' },
  { name: 'Tailwind CSS', what: 'Styling', licence: 'MIT', url: 'https://tailwindcss.com' },
  { name: 'FastAPI', what: 'Local backend', licence: 'MIT', url: 'https://fastapi.tiangolo.com' },
  { name: 'SQLAlchemy', what: 'Database', licence: 'MIT', url: 'https://www.sqlalchemy.org' },
  { name: 'NumPy', what: 'Numerical arrays', licence: 'BSD-3-Clause', url: 'https://numpy.org' },
  { name: 'ecCodes', what: 'Reading the wind forecast files', licence: 'Apache-2.0', url: 'https://github.com/ecmwf/eccodes' },
  { name: 'Ultralytics YOLOv8', what: 'Object detection', licence: 'AGPL-3.0', url: 'https://github.com/ultralytics/ultralytics' },
  { name: 'PyTorch', what: 'Deep learning', licence: 'BSD-style', url: 'https://pytorch.org' }
]

/** Methods and models the app implements itself, from published papers and references. */
export const METHODS: { what: string; ref: string }[] = [
  { what: 'Magnetopause shape', ref: 'Shue et al. (1998), J. Geophys. Res. 103, 17691' },
  { what: 'Bow shock shape', ref: 'Farris and Russell (1994), J. Geophys. Res. 99, 17681' },
  { what: "Sun's tilt and rotation angle (P, B0)", ref: 'Meeus, Astronomical Algorithms' },
  { what: "Earth's magnetic field", ref: 'IGRF-14, International Association of Geomagnetism and Aeronomy' },
  { what: 'Satellite propagation', ref: 'SGP4, Vallado et al., Revisiting Spacetrack Report #3' }
]
