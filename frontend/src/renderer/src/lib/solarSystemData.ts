// What the solar-system view draws: sizes, colours and the moons that are placed by simple
// circular orbits. Planet, Pluto, Moon and Galilean-moon positions come from astronomy-engine
// (solarSystemEphemeris.ts); dwarf planets, asteroids and comets from JPL orbital elements.

export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' | 'comet' | 'nebula' | 'cluster' | 'galaxy' | 'constellation'

export const KM_PER_AU = 149_597_870.7
export const AU_LIGHT_MINUTES = 8.316746

export interface BodyDef {
  id: string
  name: string
  kind: BodyKind
  radiusKm: number
  color: string
  /** astronomy-engine body name, for the bodies it can place */
  astro?: string
  /** where a texture lives in /deepspace/textures */
  texture?: string
  /** orbital period in days, for the facts panel (planets/dwarfs get it from elements) */
  periodDays?: number
}

export const SUN: BodyDef = { id: 'sun', name: 'Sun', kind: 'star', radiusKm: 695_700, color: '#fde047', astro: 'Sun', texture: 'sun' }

export const PLANETS: BodyDef[] = [
  { id: 'mercury', name: 'Mercury', kind: 'planet', radiusKm: 2439.7, color: '#b8b1a8', astro: 'Mercury', texture: 'mercury', periodDays: 87.97 },
  { id: 'venus', name: 'Venus', kind: 'planet', radiusKm: 6051.8, color: '#e8cda2', astro: 'Venus', texture: 'venus', periodDays: 224.7 },
  { id: 'earth', name: 'Earth', kind: 'planet', radiusKm: 6371, color: '#4f9bff', astro: 'Earth', texture: 'earth', periodDays: 365.256 },
  { id: 'mars', name: 'Mars', kind: 'planet', radiusKm: 3389.5, color: '#d9694a', astro: 'Mars', texture: 'mars', periodDays: 686.98 },
  { id: 'jupiter', name: 'Jupiter', kind: 'planet', radiusKm: 69_911, color: '#e0b98a', astro: 'Jupiter', texture: 'jupiter', periodDays: 4332.59 },
  { id: 'saturn', name: 'Saturn', kind: 'planet', radiusKm: 58_232, color: '#e8d59a', astro: 'Saturn', texture: 'saturn', periodDays: 10_759.2 },
  { id: 'uranus', name: 'Uranus', kind: 'planet', radiusKm: 25_362, color: '#9fe3e8', astro: 'Uranus', texture: 'uranus', periodDays: 30_688.5 },
  { id: 'neptune', name: 'Neptune', kind: 'planet', radiusKm: 24_622, color: '#5b7bff', astro: 'Neptune', texture: 'neptune', periodDays: 60_182 }
]

export const PLUTO: BodyDef = { id: 'pluto', name: 'Pluto', kind: 'dwarf', radiusKm: 1188.3, color: '#c9b39a', astro: 'Pluto', periodDays: 90_560 }

/** Saturn's rings, in planet radii (D ring edge to the outer edge of the A ring's neighbourhood). */
export const SATURN_RING = { inner: 1.239, outer: 2.27 }

export interface MoonDef extends BodyDef {
  parent: string
  /** which astronomy-engine model places it; anything else is a circular orbit */
  engine?: 'moon' | 'io' | 'europa' | 'ganymede' | 'callisto'
  /** circular orbits only: radius (km), period (days, negative = retrograde) and phase at J2000 (deg) */
  aKm?: number
  phase0?: number
}

// Circular-orbit phases are illustrative: the orbits are the right size, period and plane, but a
// moon is not necessarily where the real one is on the given date. Moon and Galilean moons are exact.
export const MOONS: MoonDef[] = [
  { id: 'moon', name: 'Moon', kind: 'moon', parent: 'earth', engine: 'moon', radiusKm: 1737.4, color: '#c8c8c8', astro: 'Moon', texture: 'moon', periodDays: 27.32 },
  { id: 'io', name: 'Io', kind: 'moon', parent: 'jupiter', engine: 'io', radiusKm: 1821.6, color: '#f0d878', periodDays: 1.769 },
  { id: 'europa', name: 'Europa', kind: 'moon', parent: 'jupiter', engine: 'europa', radiusKm: 1560.8, color: '#d8cfc0', periodDays: 3.551 },
  { id: 'ganymede', name: 'Ganymede', kind: 'moon', parent: 'jupiter', engine: 'ganymede', radiusKm: 2634.1, color: '#b0a596', periodDays: 7.155 },
  { id: 'callisto', name: 'Callisto', kind: 'moon', parent: 'jupiter', engine: 'callisto', radiusKm: 2410.3, color: '#7d7468', periodDays: 16.689 },
  { id: 'mimas', name: 'Mimas', kind: 'moon', parent: 'saturn', aKm: 185_539, periodDays: 0.942, phase0: 40, radiusKm: 198.2, color: '#c8c8c8' },
  { id: 'enceladus', name: 'Enceladus', kind: 'moon', parent: 'saturn', aKm: 237_948, periodDays: 1.37, phase0: 130, radiusKm: 252.1, color: '#f4f8ff' },
  { id: 'tethys', name: 'Tethys', kind: 'moon', parent: 'saturn', aKm: 294_619, periodDays: 1.888, phase0: 220, radiusKm: 531.1, color: '#e0e0e0' },
  { id: 'dione', name: 'Dione', kind: 'moon', parent: 'saturn', aKm: 377_396, periodDays: 2.737, phase0: 310, radiusKm: 561.4, color: '#d0d0d0' },
  { id: 'rhea', name: 'Rhea', kind: 'moon', parent: 'saturn', aKm: 527_108, periodDays: 4.518, phase0: 75, radiusKm: 763.8, color: '#cfcfcf' },
  { id: 'titan', name: 'Titan', kind: 'moon', parent: 'saturn', aKm: 1_221_870, periodDays: 15.945, phase0: 160, radiusKm: 2574.7, color: '#e0a04a' },
  { id: 'iapetus', name: 'Iapetus', kind: 'moon', parent: 'saturn', aKm: 3_560_820, periodDays: 79.33, phase0: 250, radiusKm: 734.5, color: '#9a8f80' },
  { id: 'miranda', name: 'Miranda', kind: 'moon', parent: 'uranus', aKm: 129_390, periodDays: 1.413, phase0: 20, radiusKm: 235.8, color: '#c0c0c0' },
  { id: 'ariel', name: 'Ariel', kind: 'moon', parent: 'uranus', aKm: 190_900, periodDays: 2.52, phase0: 110, radiusKm: 578.9, color: '#bdbdbd' },
  { id: 'umbriel', name: 'Umbriel', kind: 'moon', parent: 'uranus', aKm: 266_000, periodDays: 4.144, phase0: 200, radiusKm: 584.7, color: '#8a8a8a' },
  { id: 'titania', name: 'Titania', kind: 'moon', parent: 'uranus', aKm: 436_300, periodDays: 8.706, phase0: 290, radiusKm: 788.4, color: '#b0aaa4' },
  { id: 'oberon', name: 'Oberon', kind: 'moon', parent: 'uranus', aKm: 583_520, periodDays: 13.463, phase0: 65, radiusKm: 761.4, color: '#a09890' },
  { id: 'triton', name: 'Triton', kind: 'moon', parent: 'neptune', aKm: 354_759, periodDays: -5.877, phase0: 100, radiusKm: 1353.4, color: '#dcd0cc' },
  { id: 'charon', name: 'Charon', kind: 'moon', parent: 'pluto', aKm: 19_591, periodDays: 6.387, phase0: 0, radiusKm: 606, color: '#a89c94' }
]

/** Radius (km) to draw a body of unknown size at. Small bodies are dots anyway. */
export const DEFAULT_MINOR_RADIUS_KM = 8

export const KIND_LABEL: Record<BodyKind, string> = {
  star: 'Star',
  planet: 'Planet',
  dwarf: 'Dwarf planet',
  moon: 'Moon',
  asteroid: 'Asteroid',
  comet: 'Comet',
  nebula: 'Nebula',
  cluster: 'Star cluster',
  galaxy: 'Galaxy',
  constellation: 'Constellation'
}

/** Orbit data as served by /deepspace/orbits. */
export interface SmallBodyElements {
  id: string
  name: string
  full_name: string
  kind: 'dwarf' | 'asteroid' | 'comet'
  a: number
  e: number
  i: number
  om: number
  w: number
  tp: number
  per: number
  diameter_km: number | null
}

export interface OrbitData {
  bodies: SmallBodyElements[]
  /** rows of [a, e, i, om, w, tp, per] */
  clouds: Record<string, number[][]>
  credit: string
  offline: boolean
}

export interface MoonElementsData {
  /** per moon id: rows of [ec, i, om, w, n (deg/day), ma, a (AU)] every `step` days from `jd0` */
  moons: Record<string, { jd0: number; step: number; rows: number[][] }>
  credit: string
  offline: boolean
}

export interface TextureData {
  urls: Record<string, string>
  credit: string
}

// ---------- beyond the solar system (served by /deepspace/stars3d, hosts, distances, localgroup) ----------

interface Sourced {
  credit: string
  /** true when the archive could not be reached and nothing was cached */
  offline: boolean
}

export interface FigureData {
  abbr: string
  name: string
  kind: 'constellation' | 'asterism'
  /** the 3D row of each figure star (-1 when it has no measured distance) */
  rows: number[]
  /** pairs of indices into `rows` */
  lines: [number, number][]
}

export interface StarsData extends Sourced {
  /** rows of [ra, dec, parallax_mas, vmag, b-v, catalogue_index (-1 if not in the app's catalogue), pmRA*, pmDec (mas/yr), e_parallax] */
  stars: number[][]
  /** [row in stars, name, catalogue_index] for each star that has a name */
  named: [number, string, number][]
  figures?: FigureData[]
}

export interface HostsData extends Sourced {
  /** rows of [ra, dec, distance_pc, planets, vmag, name] */
  hosts: (number | string | null)[][]
}

/** Known planets of one host star. */
export interface StarSystem {
  /** [radius (Sun = 1), mass (Sun = 1), effective temperature (K)], any may be null */
  star: (number | null)[]
  /** rows of [name, a (AU), e, period (days), radius (Earth = 1), mass (Earth = 1), discovery year, method] */
  planets: (string | number | null)[][]
}

export interface SystemsData extends Sourced {
  systems: Record<string, StarSystem>
}

export interface DistanceMeasure {
  d_pc: number
  n: number
  lo: number
  hi: number
}

export interface DistancesData extends Sourced {
  /** keyed by the catalogue's own deep-sky object id */
  distances: Record<string, DistanceMeasure>
}

export interface LocalGroupGalaxy {
  name: string
  group: string
  type: string
  ra: number
  dec: number
  d_kpc: number
  vmag: number | null
  rh_arcmin: number | null
  pa: number | null
  ell: number | null
}

export interface LocalGroupData extends Sourced {
  galaxies: LocalGroupGalaxy[]
}
