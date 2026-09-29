// The 3D solar system: a three.js scene of the Sun, planets, moons, dwarf planets, asteroids,
// comets and belts, at true scale and true positions for any date.
//
// Scale: the scene is in AU and spans 1e-9 (a small asteroid) to 1e3 (Sedna), far beyond what
// float32 can hold around one point. Two things keep it precise:
//   * every position is kept in float64 (`Entity.pos`); each frame the scene is drawn relative to
//     the focused body ("floating origin"), so what is on screen is always close to (0,0,0);
//   * the depth buffer is logarithmic.
// Bodies too small to see at the current zoom are drawn as fixed-size dots.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { keplerPosition, makeCloud, orbitPoints, perihelion, aphelion, solveKepler, type ElementCloud, type Elements, type Vec3 } from '@renderer/lib/kepler'
import {
  AU_LIGHT_MINUTES,
  DEFAULT_MINOR_RADIUS_KM,
  KIND_LABEL,
  KM_PER_AU,
  MOONS,
  PLANETS,
  PLUTO,
  SATURN_RING,
  SUN,
  type BodyDef,
  type BodyKind,
  type MoonDef,
  type DistancesData,
  type HostsData,
  type LocalGroupData,
  type MoonElementsData,
  type OrbitData,
  type SmallBodyElements,
  type StarsData,
  type StarSystem,
  type SystemsData
} from '@renderer/lib/solarSystemData'
import { bodyFrame, helioPosition, julianDate, moonIsReal, moonOffset, moonOrbit, planetOrbit, registerMoonTables, type BodyFrame } from '@renderer/lib/solarSystemEphemeris'
import { dsoGroup, type Catalogue, type Dso } from '@renderer/lib/skyCatalogue'
import { deepspaceCutoutUrl } from '@renderer/lib/api'
import { nadirBlend, type LiftView } from '@renderer/lib/skyLift'
import { advance as advanceAircraft, type Aircraft } from '@renderer/lib/aircraft'
import { kindInfo, SHAPE_ORDER, SHAPE_PATHS, type AircraftKind } from '@renderer/lib/aircraftIcons'
import type { Strike } from '@renderer/lib/lightning'
import { LightningLayer, type LightningMode, type PickedStrike } from './lightningLayer'
import { TrafficLayer } from './trafficLayer'
import type { TrafficPlace } from '@renderer/lib/traffic'
import { FlowParticles } from './flowLayer'
import { ShipLayer, makeShipIcon } from './shipLayer'
import { AqiLayer, HeatLayer, LaunchLayer, QuakeLayer, VolcanoLayer } from './hazardLayers'
import type { Launch } from '@renderer/lib/launches'
import type { AqiStation } from '@renderer/lib/aqi'
import { EarthDetail, FULL_DAYLIGHT_GAIN, FULL_DAYLIGHT_RAMP } from './earthDetail'
import type { HeatSpot, Quake, QuakeHit, Volcano, VolcanoHit } from '@renderer/lib/hazards'
import { advanceShip, type Ship, type ShipHit } from '@renderer/lib/ships'
import { GalaxyModel } from './galaxyModel'
import { GalaxyCatalogue, type GalaxyRow } from './galaxyCatalogue'
import { cosTilt, designation, guessShape, hashSeed, modelAxes, morphName, parseMorph, thicknessOf, type GalaxyShape } from '@renderer/lib/galaxyMorph'
import type { Galaxies3dData, GalaxyTypesData } from '@renderer/lib/solarSystemData'
import { speedMax, WIND_TIME_SCALE, type FlowGrid, type FlowKind, type WindLevel } from '@renderer/lib/flow'
import { AuroraLayer } from './auroraLayer'
import { SunLayer, type SunLayerFlags } from './sunLayer'
import { MeteorRadiantLayer, type RadiantHit } from './meteorLayer'
import { MeteorStreamLayer } from './meteorStreamLayer'
import { SHOWER_PARENT } from './meteorStreamData'
import { EclipseShadowLayer } from './eclipseLayer'
import { RadiationBeltLayer } from './radiationBeltLayer'
import { IonosphereLayer } from './ionosphereLayer'
import type { IonosphereGrid } from '@renderer/lib/ionosphere'
import { decimalYear } from '@renderer/lib/geomag'
import type { Shower } from '@renderer/lib/eventsSky'
import { MagnetoLayer, type MagnetoFlags, type StationRow } from './magnetoLayer'
import { WindLayer, type WindFlags, type WindMarker, type WindNow } from './windLayer'
import { magnetosphereFromWind, tailStretch } from '@renderer/lib/magnetosphere'
import type { Cme, Flare, Region, SurfaceKind } from '@renderer/lib/sun'
import { MAX_FLY_AU, flySpeed, moveWithoutTunnelling, nearestBody, pushOut, stopRadius, wheelMultiplier, type Body as FlyBody, type Vec3 as FlyVec } from '@renderer/lib/fly'
import type { AuroraGrid } from '@renderer/lib/aurora'
import { colorOf, eciPosition, globalState, isBright, shadowOf, sunEciAU, temeToEcliptic, type SatGlobal, type SatRecord } from '@renderer/lib/satellites'
import { getQualitySetting, planFor, probeGpuName, type QualityPlan } from '@renderer/lib/graphicsQuality'
import { earthMapTexture, wantedEarthLevel } from '@renderer/lib/earthPreload'
import { AU_PER_KPC, AU_PER_LY, AU_PER_PC, GALACTIC_CENTRE_AU, GALACTIC_NORTH_ECLIPTIC, HIPPARCOS_EPOCH_OFFSET_YR, absoluteMagnitude, effectiveParallax, parallaxCapped, parallaxToAU, positionAU, starColour } from '@renderer/lib/galaxyMath'
import { MILKY_WAY_GLOW_OPACITY, MILKY_WAY_OPACITY, buildBackdrop, buildHosts, buildMilkyWay, buildStarCloud, ramp, ringTexture, scaleAlphas, starMotion, starRadiusAU, type HostCloud, type MilkyWayCloud, type StarCloud, type Tier } from './universeLayers'

const DAY_MS = 86_400_000
const M_PER_AU = 1.495978707e11
const MAX_DATE_MS = 8e15 // JavaScript dates stop at +-8.64e15 ms (about 273,000 years)
/** Planet positions (astronomy-engine, JPL elements) are good for about +-2000 years of J2000, then fade out. */
const SOLAR_OK_YEARS = 2000
const SOLAR_FADE_YEARS = 2000
const GROUND_RADIUS_AU = 60_000 / M_PER_AU // the flat ground under a camera standing on the Earth
const GROUND_FADE_M: [number, number] = [5_000, 40_000]
const EARTH_MESH_MIN_ALT_M = 1_500 // below this the ground disc stands in for the (faceted) globe
const DEG = Math.PI / 180
/** How close the camera may come to the Earth (km above the ground). */
const EARTH_MIN_ALT_KM = 40
/** How close to the camera's direction a place on the Earth must be to count as on the near side: a little inside the horizon, but never so far in that nothing qualifies when the camera is low. */
const nearSide = (distR: number): number => 1 / distR + Math.min(0.02, (1 - 1 / distR) * 0.5)
/** "Full daylight" on the Earth: how bright the ground is made where the Sun is not shining (like the day side), and how far past the terminator that fades. */


/** seconds for the sharp Earth map to fade in over the small one, and for Full daylight to fade in or out */
const HI_MAP_FADE_S = 1.6
const FULL_DAYLIGHT_FADE_S = 0.9
const smooth01 = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
const MOON_VISIBLE_AU = 0.15 // moons show when the camera is this close to their planet
const PLANET_ORBIT_STALE_DAYS = 5 * 365
const MOON_ORBIT_STALE_DAYS = 30
const FLIGHT_MS = 1600
const CLICK_SLOP_PX = 5
const MARKER_SCALE = 0.014
const MARKER_HIDE_PX = 5 // a body bigger than this on screen no longer needs its dot
const TIME_CALLBACK_MS = 100
/** Bodies Deep Space has an image-and-text page for (the backend's BODIES table). */
const DETAIL_IDS = new Set(['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'earth'])
/** Which labels win when they collide: lower is kept. */
const LABEL_RANK: Record<BodyKind, number> = { star: 0, galaxy: 1, planet: 1, constellation: 2, nebula: 2, cluster: 2, dwarf: 2, moon: 2, asteroid: 3, comet: 3 }
const FIGURE_DIM = [0.2, 0.3, 0.5] as const
const FIGURE_BRIGHT = [0.6, 0.85, 1.0] as const
const FAR_MARKER_SCALE = 0.011
const HALO_MARKER_HIDE_PX = 6
const HALO_MIN_PX = 0.6
const MAX_VIEW_AU = 3e14
const PROXIMITY_FULL_AU = 1e4 // whatever the zoom, anything this close to the camera is drawn
const BILLBOARD_PX = 1024
const DSO_TYPE_LABEL: Record<string, string> = {
  G: 'Galaxy', GPair: 'Galaxy pair', GTrpl: 'Galaxy triplet', GGroup: 'Galaxy group', OCl: 'Open cluster', GCl: 'Globular cluster',
  Neb: 'Nebula', HII: 'Emission nebula (HII region)', EmN: 'Emission nebula', RfN: 'Reflection nebula', SNR: 'Supernova remnant',
  DrkN: 'Dark nebula', PN: 'Planetary nebula', 'Cl+N': 'Cluster with nebulosity', '*Ass': 'Stellar association', '**': 'Double star', Other: 'Deep-sky object'
}
const KIND_COLOUR: Partial<Record<BodyKind, string>> = { nebula: '#f472b6', cluster: '#c4b5fd', galaxy: '#4ade80' }
const HOME_DIRECTION = new THREE.Vector3(0.35, -1, 0.7).normalize()

export interface Layers {
  orbits: boolean
  labels: boolean
  moons: boolean
  minor: boolean // dwarf planets, asteroids, comets
  belts: boolean
  streams: boolean // meteoroid debris streams along shower parent-body orbits
  stars: boolean // the 3D star cloud and named stars
  hosts: boolean // stars with confirmed planets
  deepsky: boolean // nebulae and clusters at their true distance
  galaxies: boolean // the Milky Way, the Local Group and galaxies beyond
  constellations: boolean // constellation figures drawn between the stars at their true depths
}

export const DEFAULT_LAYERS: Layers = { orbits: true, labels: true, moons: true, minor: true, belts: true, streams: true, stars: true, hosts: false, deepsky: true, galaxies: true, constellations: true }

export interface FocusOptions {
  /** camera distance from the body, AU */
  distance?: number
  /** view from this direction (ecliptic, from the body towards the camera) */
  direction?: Vec3
  /** jump there without the flight (used to put the view back where it was left) */
  instant?: boolean
}

/** What the engine knows about something outside the solar system. */
interface FarInfo {
  facts: { label: string; value: string }[]
  note: string | null
  detail: { kind: 'dso' | 'star'; key: string } | null
  defaultDist: number
  minDist: number
  direction?: Vec3
  /** survey cut-out to show as a picture of the object when you fly up to it */
  cutout: { ra: number; dec: number; fovDeg: number } | null
  halo: THREE.Sprite | null
  /** glow strength when it is on screen (default 0.5) */
  haloOpacity?: number
  /** a galaxy: what it is shaped like, for its 3D model when you fly close (built on demand) */
  galaxy?: GalaxyInfo
}

interface GalaxyInfo {
  shape: GalaxyShape
  /** the model's axes in the scene frame: seen from the Sun it has the galaxy's real tilt and position angle */
  axes: { x: Vec3; y: Vec3; z: Vec3 }
  /** where it came from, so the shape can be worked out again when better data (its morphological type) arrives */
  src: { ra: number; dec: number; ba: number; paDeg: number; morph: string | null; key: string }
  /** the row in the galaxy catalogue cloud this one was made from, if any */
  catRow?: number
}

export interface BodyInfo {
  id: string
  name: string
  kind: BodyKind
  facts: { label: string; value: string }[]
  note: string | null
  /** the Deep Space page with photos and a description, when there is one */
  detail: { kind: 'body' | 'dso' | 'star'; key: string } | null
}

export interface ListItem {
  id: string
  name: string
  kind: BodyKind
  parent: string | null
  tier: Tier
}

export interface EngineCallbacks {
  onSelect?: (id: string) => void
  /** simulation time changed while playing (throttled) */
  onTime?: (ms: number) => void
  /** the camera moved: distance from the centre of view (AU), and what that is centred on */
  onView?: (v: { distanceAU: number; focusId: string }) => void
  /** a flight to a body has finished */
  onArrive?: (id: string) => void
  /** a satellite was clicked (its NORAD number), or the click missed them all (null) */
  onSatelliteSelect?: (norad: number | null) => void
  /** the camera stopped following a satellite by itself (its orbit data ran out) */
  onSatelliteLost?: () => void
  /** the live cloud layer changed state */
  onWeather?: (s: WeatherStatus) => void
  /** an aircraft was clicked (null: the click missed them all) */
  onAircraftSelect?: (a: AircraftInfo | null) => void
  /** where on the Earth the Sun is straight overhead (about once a second) */
  onSun?: (s: { latDeg: number; lonDeg: number }) => void
  /** a lightning strike was clicked (null: the click missed them all) */
  onStrikeSelect?: (s: PickedStrike | null) => void
  /** a web traffic destination was clicked (its id; null: the click missed them all) */
  onTrafficSelect?: (id: string | null) => void
  /** a ship was clicked (null: the click missed them all) */
  onShipSelect?: (s: ShipHit | null) => void
  /** the camera stopped following a ship by itself (it dropped out of the data) */
  onShipLost?: () => void
  /** an earthquake or a volcano was clicked (null: the click missed them all) */
  onQuakeSelect?: (q: QuakeHit | null) => void
  onVolcanoSelect?: (v: VolcanoHit | null) => void
  /** a CME bubble was clicked (null: the click missed them all) */
  onCmeSelect?: (c: Cme | null) => void
  /** a solar flare's marker on the Sun was clicked (null: the click missed them all) */
  onFlareSelect?: (f: Flare | null) => void
  /** a meteor shower's radiant was clicked (null: the click missed them all) */
  onMeteorSelect?: (r: RadiantHit | null) => void
  /** a rocket launch pad marker was clicked (null: the click missed them all) */
  onLaunchSelect?: (l: Launch | null) => void
  /** an air quality station was clicked (null: the click missed them all) */
  onAqiSelect?: (a: AqiStation | null) => void
  /** the Earth was clicked while wind or currents are showing: where (null: the readout should close) */
  onEarthPick?: (p: { latDeg: number; lonDeg: number } | null) => void
  /** fly mode: what the camera is doing (about 8 times a second), or null when fly mode ends */
  onFly?: (s: FlyHud | null) => void
  /** the camera started or stopped following the observer's place (it stops by itself when you drag the view or go elsewhere) */
  onHomeFollow?: (on: boolean) => void
  /** the green location dot was clicked */
  onHomeClick?: () => void
  /** a town or city was clicked (null: the click missed them all) */
  onTownSelect?: (t: TownHit | null) => void
  /** one of the user's own places was clicked (its id) */
  onPlaceSelect?: (id: string) => void
  /** while picking a spot for a new place: where on the Earth was clicked */
  onPlacePick?: (p: { latDeg: number; lonDeg: number }) => void
}

export interface TownHit {
  name: string
  country: string
  region: string
  population: number
  latDeg: number
  lonDeg: number
  capital: boolean
}

export interface PlaceMark {
  id: string
  name: string
  lat: number
  lon: number
}

/** The fly-through readout. */
export interface FlyHud {
  /** the nearest body's name */
  name: string
  /** camera above that body's surface, AU */
  heightAU: number
  /** current speed, AU per second */
  speedAUps: number
  /** the wheel's speed multiplier */
  mul: number
  boost: boolean
  /** pointer lock is on (the mouse steers); otherwise hold the left button and drag */
  locked: boolean
  /** the camera is resting against a surface */
  touching: boolean
}

/** An aircraft picked on the globe, as it is at the moment of the click. */
export interface AircraftInfo {
  hex: string
  callsign: string
  reg: string
  type: string
  latDeg: number
  lonDeg: number
  altM: number
  speedMs: number
  trackDeg: number
  vrateMs: number
  kind: AircraftKind
}

const MAX_CITY_LABELS = 90
interface CityLabel {
  obj: CSS2DObject
  el: HTMLDivElement
  idx: number
}
const ORBIT_RING_POINTS = 240
const GROUND_TRACK_POINTS = 180
const GROUND_TRACK_PAST_MIN = 45
const GROUND_TRACK_FUTURE_MIN = 90

/** State of the live cloud layer on the Earth. */
export interface WeatherStatus {
  state: 'off' | 'loading' | 'live' | 'error'
  /** when the cloud picture was downloaded (ms since 1970) */
  fetchedAt?: number
  message?: string
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** A camera standing on (or rising above) the Earth, seen from a photo's viewpoint. */
export interface SurfaceState {
  /** unit vector from the Earth's centre up through the observer, ecliptic J2000 */
  zenith: Vec3
  /** where the photo looks (ecliptic J2000), its roll and scale */
  view: LiftView
  altitudeM: number
}

/** The satellites drawn around the Earth: one point each, in the Earth's frame (ecliptic J2000 axes, AU from its centre). */
interface SatCloud {
  records: SatRecord[]
  index: Map<number, number>
  points: THREE.Points
  pos: Float32Array
  col: Float32Array
  base: Float32Array
  alive: Uint8Array
  /** when the positions were last computed, and how long that took: sets how often to redo it */
  at: number
  cost: number
}

interface Entity {
  def: BodyDef
  group: THREE.Group
  /** heliocentric position, ecliptic J2000, AU (float64) */
  pos: Vec3
  radiusAU: number
  parent: Entity | null
  mesh: THREE.Mesh
  marker: THREE.Sprite
  label: CSS2DObject
  moon: MoonDef | null
  elements: Elements | null
  fullName: string
  orbit: THREE.Line | null
  orbitEpochMs: number
  tail: THREE.Line | null
  rot: BodyFrame | null
  ring: THREE.Mesh | null
  tier: Tier
  /** true for things placed once (stars, galaxies) rather than computed for a date */
  fixed: boolean
  far: FarInfo | null
  /** last opacity written to the label, to avoid touching the DOM every frame */
  alpha: number
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const len3 = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function fmtDistance(au: number): string {
  if (au < 0.01) return `${Math.round(au * KM_PER_AU).toLocaleString()} km`
  return `${au.toFixed(au < 10 ? 3 : 2)} AU (${(au * AU_LIGHT_MINUTES).toFixed(au * AU_LIGHT_MINUTES < 100 ? 1 : 0)} light-min)`
}
function fmtPeriod(days: number): string {
  if (days < 2) return `${(days * 24).toFixed(1)} hours`
  if (days < 800) return `${days.toFixed(days < 100 ? 1 : 0)} days`
  const y = days / 365.25
  return y < 1000 ? `${y.toFixed(y < 10 ? 2 : 1)} years` : `${Math.round(y).toLocaleString()} years`
}
function fmtFar(au: number): string {
  const ly = au / AU_PER_LY
  if (ly < 1) return fmtDistance(au)
  if (ly < 1000) return `${ly.toFixed(ly < 10 ? 2 : 1)} light-years`
  if (ly < 1e6) return `${Math.round(ly).toLocaleString()} light-years`
  return `${(ly / 1e6).toFixed(ly < 1e7 ? 2 : 1)} million light-years`
}
const fmtLy = (ly: number): string => (ly < 1000 ? `${ly.toPrecision(2)} light-years` : ly < 1e6 ? `${Math.round(ly).toLocaleString()} light-years` : `${(ly / 1e6).toFixed(2)} million light-years`)
const rgbHex = (c: Vec3): string => `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`
const angularSep = (a: Vec3, b: Vec3): number => {
  const la = len3(a)
  const lb = len3(b)
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb || 1))))
}
const fmtKm = (km: number): string => (km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`)

function softDot(hard: number): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(hard, 'rgba(255,255,255,0.95)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

/** One planet of a flown-into exoplanet system. */
interface PlanetSim {
  a: number
  e: number
  perDays: number
  phase0: number
  p: Vec3 // orbit-plane axes (unit): towards periapsis, and 90 degrees on
  q: Vec3
  mesh: THREE.Mesh
  radiusAU: number
  marker: THREE.Sprite
  label: CSS2DObject
}

const hashUnit = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 100000) / 100000
}

/** Rough colour of a star's light from its temperature. */
function teffColour(t: number): number {
  const stops: [number, [number, number, number]][] = [[2500, [1, 0.5, 0.35]], [3500, [1, 0.62, 0.42]], [5000, [1, 0.8, 0.55]], [6000, [1, 0.93, 0.8]], [7500, [1, 1, 0.96]], [10000, [0.82, 0.89, 1]]]
  if (t <= stops[0][0]) return new THREE.Color(...stops[0][1]).getHex()
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (t - t0) / (t1 - t0)
      return new THREE.Color(c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k).getHex()
    }
  return new THREE.Color(...stops[stops.length - 1][1]).getHex()
}

const planetColour = (radiusEarth: number | null): string => (radiusEarth === null ? '#9aa0aa' : radiusEarth < 1.7 ? '#b08968' : radiusEarth < 4 ? '#7a9cc6' : radiusEarth < 10 ? '#5b8bd6' : '#d9a86c')

export class SolarSystemEngine {
  private readonly container: HTMLElement
  private readonly cb: EngineCallbacks
  private readonly renderer: THREE.WebGLRenderer
  private readonly labels: CSS2DRenderer
  /** the opacity declutterLabels last wrote to each label (it folds in bodies standing in front) */
  private readonly labelShown = new WeakMap<Entity, number>()
  /** how visible each entity was last frame past the solid bodies in front of it (1 = clear view) */
  private readonly behind = new WeakMap<Entity, number>()
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 1e-7, 2e15)
  private readonly controls: OrbitControls
  private readonly loader = new THREE.TextureLoader()
  private readonly dot = softDot(0.55)
  private readonly glow = softDot(0)
  private readonly entities = new Map<string, Entity>()
  private readonly orderedEntities: Entity[] = []
  private readonly smallGroup = new THREE.Group() // everything from /deepspace/orbits
  private readonly stars = new THREE.Group() // the directional backdrop (see rebuildBackdrop)
  private catalogue: Catalogue | null = null
  private excluded = new Set<number>()
  private nearCloud: StarCloud | null = null
  private hostCloud: HostCloud | null = null
  private mwCloud: MilkyWayCloud | null = null
  private ring: THREE.CanvasTexture | null = null
  private readonly orphanMesh = new THREE.Mesh() // stands in for `mesh` on things that are only markers
  private readonly starGeo = new THREE.SphereGeometry(1, 24, 12)
  private readonly plan: QualityPlan
  private starBase: Float64Array = new Float64Array(0) // every 3D star's position at epoch 1991.25 (float64)
  private starVel: Float64Array = new Float64Array(0) // and velocity (AU per year)
  private starRow = new Map<Entity, number>() // named-star entity -> its row
  private constel: { lines: THREE.LineSegments; rows: Int32Array; ranges: Map<string, [number, number]> } | null = null
  private figures: { abbr: string; entity: Entity; rows: number[] }[] = []
  private highlighted: string | null = null
  private systems: Record<string, StarSystem> | null = null
  private activeSystem: { host: string; group: THREE.Group; planets: PlanetSim[] } | null = null
  private years = 26.7 // simulated years since J2000
  private mode: 'orbit' | 'surface' | 'fly' = 'orbit'
  private surface: SurfaceState | null = null
  private ground: THREE.Mesh | null = null
  private billboard: { sprite: THREE.Sprite; owner: string; width: number } | null = null
  private readonly billboardTextures = new Map<string, THREE.Texture>()
  private lastViewCb = 0
  private lastViewD = NaN
  private lastViewFocus = ''
  private readonly clouds: { points: THREE.Points; cloud: ElementCloud; buffer: Float32Array }[] = []
  private readonly worldLines: THREE.Object3D[] = [] // built in absolute AU; shifted by -origin each frame
  private textures: Record<string, string> = {}
  private layers: Layers = { ...DEFAULT_LAYERS }
  private dateMs = Date.now()
  private playing = false
  private speedDaysPerSec = 1
  private focusId = 'sun'
  private flight: { start: number; dur: number; fromOrigin: Vec3; fromDist: number; toDist: number; fromDir: THREE.Vector3; toDir: THREE.Vector3 } | null = null
  private origin: Vec3 = [0, 0, 0]
  private dirty = true
  private raf = 0
  private lastFrame = 0
  private lastTimeCb = 0
  private cloudJd = NaN
  private down: { x: number; y: number; id: string | null } | null = null
  private readonly tmpV = new THREE.Vector3()
  private readonly tmpV2 = new THREE.Vector3()
  private readonly tmpV3 = new THREE.Vector3()
  private readonly tmpM = new THREE.Matrix4()
  private readonly tmpQ = new THREE.Quaternion()
  private readonly ro: ResizeObserver
  private disposed = false
  private sats: SatCloud | null = null
  private satFollow: number | null = null // row of the satellite the camera follows
  private satSelected: number | null = null // NORAD number of the picked satellite
  private satMarker: THREE.Sprite | null = null
  private satLabel: CSS2DObject | null = null
  private satOpacity = 0
  // The Earth's real-time lighting and weather: where the Sun is (in scene axes, and in camera axes for the globe's night
  // side), and the live cloud shell.
  private readonly sunWorld = { value: new THREE.Vector3(1, 0, 0) }
  /** 1 when the Earth is shown fully lit, with no night side (eased towards `earthFullTarget`, so switching it is a fade) */
  private readonly earthFull = { value: 0 }
  private earthFullTarget = 0
  private earthFullSet = false
  /** the sharp day and night maps, cross-faded in over the small ones as they arrive (`earthHiDay` / `earthHiNight` go 0 to 1) */
  private readonly earthMapHi = { value: null as THREE.Texture | null }
  private readonly earthNightMapHi = { value: null as THREE.Texture | null }
  private readonly earthHiDay = { value: 0 }
  private readonly earthHiNight = { value: 0 }
  private pendingHi: { day: THREE.Texture | null; night: THREE.Texture | null } = { day: null, night: null }
  private lastFadeAt = 0
  private readonly sunView = { value: new THREE.Vector3(1, 0, 0) }
  private earthNightReady = false
  private cloudMesh: THREE.Mesh | null = null
  /** Clouds, aurora and aircraft live here instead of on the Earth's mesh: a sibling that turns with the globe but,
   * unlike the mesh itself, is never hidden when standing at ground level (or they would vanish along with it). */
  private skySurface: THREE.Group | null = null
  private cloudsOn = false
  private cloudTimer: number | null = null
  private cloudLoading = false
  private ozoneMesh: THREE.Mesh | null = null
  private ozoneOn = false
  private ozoneTimer: number | null = null
  private ozoneLoading = false
  private rainMesh: THREE.Mesh | null = null
  private rainOn = false
  private rainTimer: number | null = null
  private rainLoading = false
  private ionosphere: IonosphereLayer | null = null
  // A satellite's orbit drawn around the Earth (the ISS): the ring in space, its track over the ground, and where it is now.
  private trace: {
    rec: SatRecord
    ring: THREE.Line
    ground: THREE.Line
    marker: THREE.Sprite
    label: CSS2DObject
    dateMs: number
    valid: boolean
  } | null = null
  // Aircraft on the globe: one point each, in the Earth's own frame (so they turn with it).
  private planes: { rows: Aircraft[]; points: THREE.Points; pos: Float32Array; dirs: Float32Array; vis: Float32Array; at: number } | null = null
  private planeUniforms = { uSize: { value: 14 }, uOpacity: { value: 0 }, uAspect: { value: 1 }, uTex: { value: null as THREE.Texture | null } }
  /** kinds of aircraft switched off in the filter */
  private planeHidden: ReadonlySet<string> = new Set()
  private planeIcon: THREE.CanvasTexture | null = null
  private earthHiResAsked = false
  // City names: dots for every city big enough for the height you are at, and a small pool of name labels placed where they do not overlap.
  private cities: {
    names: string[]
    countries: string[]
    regions: string[]
    /** the list has the towns and villages of the world (GeoNames), so names go on down to the smallest */
    townMode: boolean
    unit: Float32Array
    pop: Float32Array
    capital: Uint8Array
    n: number
    points: THREE.Points
    pool: CityLabel[]
    at: number
    key: string
  } | null = null
  private citiesOn = true
  private townSelected = false
  // The user's own named places, drawn as cyan marks with their names
  private myPlaces: { list: PlaceMark[]; unit: Float32Array; points: THREE.Points; labels: { obj: CSS2DObject; el: HTMLDivElement }[] } | null = null
  private placePicking = false
  private lightning: LightningLayer | null = null
  private traffic: TrafficLayer | null = null
  private trafficOn = false
  private trafficSelected = false
  private trafficPlaces: readonly TrafficPlace[] = []
  private trafficHome: { latDeg: number; lonDeg: number } | null = null
  private ships: ShipLayer | null = null
  private quakes: QuakeLayer | null = null
  private detail: EarthDetail | null = null
  private volcanoes: VolcanoLayer | null = null
  private heat: HeatLayer | null = null
  private launches: LaunchLayer | null = null
  private launchSel: string | null = null
  private aqi: AqiLayer | null = null
  private aqiSel: number | null = null
  private quakeOptions = { minMag: 2.5, hours: 24 }
  private volcanoShowAll = true
  private hazardSel: { kind: 'quake' | 'volcano'; key: string | number } | null = null
  private hazardMarker: THREE.Sprite | null = null
  private hazardLabel: CSS2DObject | null = null
  private hazardLabelText = ''
  private hazardDrawnAt = 0
  private shipIcon: THREE.CanvasTexture | null = null
  private shipSelected: number | null = null // MMSI
  private shipFollow: number | null = null // MMSI of the ship the camera follows
  private shipMarker: THREE.Sprite | null = null
  private shipLabel: CSS2DObject | null = null
  private shipLabelText = ''
  private shipDrawnAt = 0
  private gxRows: GalaxyRow[] = []
  private gxCat: GalaxyCatalogue | null = null
  private gxTypes: Record<string, string> = {}
  private readonly gxModels = new Map<string, { model: GalaxyModel; used: number }>()
  private readonly gxDemand: string[] = [] // the catalogue galaxies you have flown to, oldest first
  private gxPhoto = 0 // how much the survey photo of the focused galaxy is showing (0..1)
  private flow: Record<FlowKind, FlowParticles | null> = { wind: null, currents: null }
  private flowOn: Record<FlowKind, boolean> = { wind: false, currents: false }
  private flowLastAt = 0
  private flowDrawnAt = 0
  private readonly flowDir = new THREE.Vector3()
  private flowMarker: THREE.Sprite | null = null
  private lightningOn = false
  private lightningWindow = 10
  private lightningMode: LightningMode = 'auto'
  private lightningDrawnAt = 0
  private strikeSelected = false
  // fly-through
  private readonly flyKeys = new Set<string>()
  private readonly flyQuat = new THREE.Quaternion()
  private readonly flyVel = new THREE.Vector3()
  private flyMul = 1
  private flyLook = { dx: 0, dy: 0 }
  private flyHudAt = 0
  private flyDragging = false
  // rolling the orbiting view (Q and E, as in fly mode; R levels it again)
  private readonly rollKeys = new Set<string>()
  private homePlace: { latDeg: number; lonDeg: number } | null = null
  private home: { unit: THREE.Vector3; dot: THREE.Points; halo: THREE.Points; label: CSS2DObject; el: HTMLDivElement } | null = null
  private homeDrawnAt = 0
  private homeFollow = false // the camera turns with the Earth so the observer's place stays in the middle
  private homeQ = new THREE.Quaternion() // the Earth's orientation when the camera was last turned with it
  private keepHomeFollow = false
  private magneto: MagnetoLayer | null = null
  private magnetoFlags: MagnetoFlags = { lines: true, map: false, mapKind: 'strength', surfaces: true, stations: true }
  private magnetoData: { wind: WindNow & { temperature?: number | null }; kp: number | null; dst: number | null; stations: StationRow[] } = { wind: { speed: null, density: null, bz: null, bt: null }, kp: null, dst: null, stations: [] }
  private magnetoDrawnAt = 0
  private windLayer: WindLayer | null = null
  private windFlags: WindFlags = { stream: true, markers: true, sheet: false }
  private windDrawnAt = 0
  private trafficDrawnAt = 0
  private sunLayer: SunLayer | null = null
  private sunGlow: THREE.Sprite | null = null
  private sunFlags: SunLayerFlags = { surface: true, corona: true, cmes: true, spots: true, flares: true }
  private aurora: AuroraLayer | null = null
  private auroraOn = false
  private auroraGrid: AuroraGrid | null = null
  private auroraDrawnAt = 0
  private sunReportedAt = 0
  private lastLiveDraw = 0
  private planeOpacity = 0
  private planeSelected: number | null = null
  private planeMarker: THREE.Sprite | null = null
  private planeLabel: CSS2DObject | null = null
  private cmeSel: string | null = null
  private flareSelected = false
  private meteors: MeteorRadiantLayer | null = null
  private meteorSel: string | null = null
  private meteorStream: MeteorStreamLayer | null = null
  private meteorStreamJd = NaN
  private meteorStreamShowers: Shower[] = []
  private eclipse: EclipseShadowLayer | null = null
  private eclipseWindow: { kind: 'solar' | 'lunar'; startMs: number; peakMs: number; endMs: number; magnitude: number } | null = null
  private belts: RadiationBeltLayer | null = null
  private beltsOn = false
  private electronFlux: number | null = null

  constructor(container: HTMLElement, cb: EngineCallbacks = {}) {
    this.container = container
    this.cb = cb
    this.plan = planFor(getQualitySetting(), probeGpuName()).plan
    this.renderer = new THREE.WebGLRenderer({ antialias: this.plan.antialias, logarithmicDepthBuffer: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.plan.pixelRatioCap))
    this.renderer.setClearColor(0x02030a)
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    this.labels = new CSS2DRenderer()
    // isolation: CSS2DRenderer gives each label a huge z-index; keep them below the page's own overlays
    this.labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;isolation:isolate'
    container.appendChild(this.labels.domElement)

    this.camera.up.set(0, 0, 1) // ecliptic north
    this.camera.position.copy(HOME_DIRECTION).multiplyScalar(14)
    this.controls = new OrbitControls(this.camera, container)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.rotateSpeed = 0.7
    this.controls.zoomSpeed = 1.3
    this.controls.enablePan = false // the view is always centred on the focused body
    this.controls.maxDistance = MAX_VIEW_AU
    this.controls.addEventListener('change', () => (this.dirty = true))

    this.scene.add(new THREE.AmbientLight(0x8090b0, 0.14))
    this.scene.add(this.stars)
    this.scene.add(this.smallGroup)

    this.buildBodies()
    this.buildMilkyWay()
    this.updatePositions()
    this.setFocusLimits('sun')
    // Shift + wheel zooms fast: the scale runs from kilometres to hundreds of millions of light-years.
    container.addEventListener('wheel', (e) => (this.controls.zoomSpeed = e.shiftKey ? 6 : 1.3), { capture: true, passive: true })
    // Near the Earth the wheel works on the height above the ground, not the distance from its centre (which would make the last few notches leap to the surface).
    container.addEventListener('wheel', this.onEarthWheel, { capture: true, passive: false })

    container.addEventListener('pointerdown', this.onDown)
    container.addEventListener('pointerup', this.onUp)
    container.addEventListener('pointermove', this.onMoveHome)
    window.addEventListener('keydown', this.onRollKey)
    window.addEventListener('keyup', this.onRollKey)
    window.addEventListener('blur', this.onRollBlur)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  // ---------- public API ----------

  setDate(ms: number): void {
    this.dateMs = Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms))
    this.updatePositions()
    this.updateSatellites(true)
    this.dirty = true
  }
  getDate(): number {
    return this.dateMs
  }
  setPlaying(on: boolean): void {
    this.playing = on
    this.lastFrame = performance.now()
  }
  /** simulated days per real second; negative runs time backwards */
  setSpeed(daysPerSec: number): void {
    this.speedDaysPerSec = daysPerSec
  }
  setLayers(layers: Layers): void {
    this.layers = { ...layers }
    this.dirty = true
  }
  /** Limit how far out the camera may go (AU). */
  setMaxDistanceAU(au: number): void {
    this.controls.maxDistance = au
  }
  getFocus(): string {
    return this.focusId
  }
  /** Where the orbiting camera is (null while flying or standing on the Earth), to put it back later with focusOn. */
  viewState(): { focus: string; distance: number; direction: Vec3; homeFollow: boolean; sat: number | null; satFollowing: boolean; ship: number | null } | null {
    if (this.mode !== 'orbit' || this.flight) return null
    const p = this.camera.position
    const d = p.length()
    const sat = this.satFollow !== null && this.sats ? this.sats.records[this.satFollow].norad : this.satSelected
    return d > 0
      ? { focus: this.focusId, distance: d, direction: [p.x / d, p.y / d, p.z / d], homeFollow: this.homeFollow, sat, satFollowing: this.satFollow !== null, ship: this.shipFollow }
      : null
  }

  /** Real moon positions (JPL Horizons element tables) in place of the illustrative circles. */
  setMoonTables(data: MoonElementsData | null): void {
    registerMoonTables(data && !data.offline ? data.moons : {})
    for (const e of this.orderedEntities) if (e.moon) e.orbitEpochMs = -Infinity // redraw orbit lines from the real path
    this.updatePositions()
    this.dirty = true
  }

  /** Planet maps by texture key (see /deepspace/textures). Bodies keep their plain colour until theirs loads. */
  setTextures(urls: Record<string, string>): void {
    this.textures = urls
    this.loader.setCrossOrigin('anonymous')
    for (const e of this.entities.values()) this.applyTexture(e)
  }

  /** The real sky behind the solar system, from the app's star catalogue. */
  setStars(cat: Catalogue): void {
    this.catalogue = cat
    this.rebuildBackdrop()
  }

  /** Directional stars, minus those the 3D cloud draws at their true positions. */
  private rebuildBackdrop(): void {
    if (!this.catalogue) return
    for (const c of [...this.stars.children]) {
      ;(c as THREE.Points).geometry.dispose()
      ;((c as THREE.Points).material as THREE.Material).dispose()
    }
    this.stars.clear()
    for (const c of buildBackdrop(this.catalogue, this.excluded).children) this.stars.add(c)
    this.dirty = true
  }

  /** Hipparcos stars with parallaxes: a cloud of true-3D dots, plus an entity for each named star. */
  setNearStars(data: StarsData | null): void {
    if (this.nearCloud) this.disposeCloud(this.nearCloud.points)
    this.nearCloud = null
    if (this.constel) {
      this.disposeCloud(this.constel.lines)
      this.constel = null
    }
    for (const e of [...this.orderedEntities]) if (e.def.id.startsWith('star:') || e.def.id.startsWith('con:')) this.removeEntity(e)
    this.starRow.clear()
    this.figures = []
    this.highlighted = null
    this.excluded = new Set()
    if (data && !data.offline && data.stars?.length) {
      this.nearCloud = buildStarCloud(data.stars.filter((r) => r[3] <= this.plan.maxStarVmag), this.renderer.getPixelRatio())
      this.scene.add(this.nearCloud.points)
      this.worldLines.push(this.nearCloud.points)
      for (const r of data.stars) if (r[5] >= 0) this.excluded.add(r[5])
      const motion = starMotion(data.stars)
      this.starBase = motion.base
      this.starVel = motion.vel
      this.buildConstellations(data)
      for (const [row, name, cat] of data.named) {
        const r = data.stars[row]
        const plx = effectiveParallax(r[2], r[8])
        const capped = parallaxCapped(r[2], r[8])
        const M = absoluteMagnitude(r[3], plx)
        const radius = starRadiusAU(M, r[4])
        const colour = starColour(r[4])
        const mu = Math.hypot(r[6] ?? 0, r[7] ?? 0) / 1000 // arcsec per year
        const ent = this.addFarEntity(
          { id: `star:${cat}`, name, kind: 'star', radiusKm: radius * KM_PER_AU, color: rgbHex(colour) },
          positionAU(r[0], r[1], parallaxToAU(plx)),
          'star',
          radius,
          {
            facts: [
              { label: 'Apparent magnitude', value: r[3].toFixed(2) },
              { label: 'Absolute magnitude', value: M.toFixed(2) },
              { label: 'Radius', value: `${(radius / 0.00465047).toFixed(radius / 0.00465047 < 10 ? 2 : 0)} × the Sun` },
              { label: 'Colour index (B−V)', value: r[4].toFixed(2) },
              { label: 'Proper motion', value: `${mu.toFixed(mu < 1 ? 3 : 2)}″ per year` },
              { label: 'Sideways speed', value: `${(4.74047 * mu * (1000 / plx)).toFixed(0)} km/s` }
            ],
            note: capped
              ? 'Hipparcos could not measure the distance to this star well, so it is drawn no farther than 3,300 light-years. The size is estimated from brightness and colour.'
              : 'Distance from the Hipparcos parallax. The size is estimated from brightness and colour.',
            detail: { kind: 'star', key: String(cat) },
            defaultDist: Math.max(radius * 14, 0.05),
            minDist: radius * 1.3,
            cutout: null,
            halo: null
          },
          colour
        )
        this.starRow.set(ent, row)
      }
    }
    this.updateStarMotion()
    this.rebuildBackdrop()
    this.dirty = true
  }

  /** Known planets of every host star, drawn on their orbits when you fly to the star. */
  setSystems(data: SystemsData | null): void {
    this.systems = data && !data.offline ? data.systems : null
    this.refreshHostFacts()
    if (this.focusId.startsWith('host:')) this.showSystem(this.focusId.slice(5))
  }

  private refreshHostFacts(): void {
    if (!this.systems) return
    for (const e of this.orderedEntities) {
      if (!e.def.id.startsWith('host:') || !e.far) continue
      const sys = this.systems[e.def.name]
      if (!sys) continue
      const shown = sys.planets.slice(0, 8)
      e.far.facts = [
        { label: 'Known planets', value: String(sys.planets.length) },
        ...shown.map((p) => ({
          label: String(p[0]).replace(`${e.def.name} `, ''),
          value: `${(p[1] as number) < 0.1 ? (p[1] as number).toFixed(3) : (p[1] as number).toFixed(2)} AU${p[3] ? ` · ${fmtPeriod(p[3] as number)}` : ''}${p[4] ? ` · ${(p[4] as number).toFixed(1)}× Earth` : ''}`
        })),
        ...(sys.planets.length > shown.length ? [{ label: '', value: `and ${sys.planets.length - shown.length} more` }] : [])
      ]
      e.far.note = 'Sizes and orbits are the archive\'s measurements. Where a planet\'s direction and phase are unknown they are drawn face-on at an arbitrary point on its orbit.'
    }
  }

  private showSystem(host: string | null): void {
    const cur = this.activeSystem
    if (cur) {
      if (cur.host === host) return
      cur.group.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose?.()
        ;(m.material as THREE.Material | undefined)?.dispose?.()
        if (o instanceof CSS2DObject) o.element.remove()
      })
      cur.group.removeFromParent()
      this.activeSystem = null
    }
    if (!host || !this.systems) return
    const sys = this.systems[host]
    const e = this.entities.get(`host:${host}`)
    if (!sys || !e) return
    const group = new THREE.Group()
    e.group.add(group)
    const radAU = (sys.star[0] ?? 1) * 0.00465047
    const starColourHex = teffColour(sys.star[2] ?? 5500)
    const star = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: starColourHex }))
    star.scale.setScalar(radAU)
    group.add(star)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: starColourHex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }))
    glow.scale.setScalar(radAU * 6)
    group.add(glow)
    group.add(new THREE.PointLight(0xfff4e0, 9, 500, 0)) // lights this system only

    // Planets orbit in the plane facing the Sun: the archive rarely knows the real orientation.
    const n = new THREE.Vector3(...e.pos).normalize()
    const u = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 0, 1))
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0)
    u.normalize()
    const v = new THREE.Vector3().crossVectors(n, u)
    const planets: PlanetSim[] = []
    for (const row of sys.planets) {
      const name = String(row[0])
      const a = row[1] as number
      const ecc = (row[2] as number) ?? 0
      const per = (row[3] as number | null) ?? 365.25 * Math.sqrt(a ** 3 / (sys.star[1] ?? 1))
      const radE = (row[4] as number | null) ?? null
      const omega = hashUnit(name + 'w') * Math.PI * 2
      const P = u.clone().multiplyScalar(Math.cos(omega)).addScaledVector(v, Math.sin(omega))
      const Q = new THREE.Vector3().crossVectors(n, P)
      const colour = planetColour(radE)
      const radiusAU = ((radE ?? 2) * 6371) / KM_PER_AU
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshStandardMaterial({ color: colour, roughness: 1 }))
      mesh.scale.setScalar(radiusAU)
      group.add(mesh)
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: colour, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
      marker.scale.setScalar(MARKER_SCALE * 0.7)
      marker.renderOrder = 10
      group.add(marker)
      const div = document.createElement('div')
      div.textContent = name.replace(`${host} `, '')
      div.style.cssText = 'padding-left:10px;font:11px/1.2 system-ui,sans-serif;color:#dfe8f5;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none'
      const label = new CSS2DObject(div)
      label.center.set(0, 0.5)
      group.add(label)
      // its orbit
      const pts: number[] = []
      for (let k = 0; k <= 128; k++) {
        const E = (k / 128) * Math.PI * 2
        const x = a * (Math.cos(E) - ecc)
        const y = a * Math.sqrt(1 - ecc * ecc) * Math.sin(E)
        pts.push(P.x * x + Q.x * y, P.y * x + Q.y * y, P.z * x + Q.z * y)
      }
      const lg = new THREE.BufferGeometry()
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.45, depthWrite: false }))
      line.frustumCulled = false
      group.add(line)
      planets.push({ a, e: ecc, perDays: per, phase0: hashUnit(name + 'm') * 360, p: [P.x, P.y, P.z], q: [Q.x, Q.y, Q.z], mesh, radiusAU, marker, label })
    }
    this.activeSystem = { host, group, planets }
    this.updateSystem()
    this.dirty = true
  }

  /** Put each planet of the flown-into system at its place on its orbit for the simulated date. */
  private updateSystem(): void {
    const s = this.activeSystem
    if (!s) return
    const days = (this.dateMs - Date.UTC(2000, 0, 1, 12)) / DAY_MS
    for (const p of s.planets) {
      const M = ((p.phase0 + (360 * days) / p.perDays) * Math.PI) / 180
      const E = solveKepler(M, p.e)
      const x = p.a * (Math.cos(E) - p.e)
      const y = p.a * Math.sqrt(1 - p.e * p.e) * Math.sin(E)
      const px = p.p[0] * x + p.q[0] * y
      const py = p.p[1] * x + p.q[1] * y
      const pz = p.p[2] * x + p.q[2] * y
      p.mesh.position.set(px, py, pz)
      p.marker.position.set(px, py, pz)
      p.label.position.set(px, py, pz)
    }
  }

  /** Stars with confirmed planets: a ring around each, plus the nearest as flyable entities. */
  setHosts(data: HostsData | null): void {
    if (this.hostCloud) this.disposeCloud(this.hostCloud.points)
    this.hostCloud = null
    for (const e of [...this.orderedEntities]) if (e.def.id.startsWith('host:')) this.removeEntity(e)
    if (!data || data.offline || !data.hosts?.length) return
    this.ring ??= ringTexture()
    this.hostCloud = buildHosts(data.hosts, this.ring)
    this.scene.add(this.hostCloud.points)
    this.worldLines.push(this.hostCloud.points)
    for (const h of data.hosts) {
      const dPc = h[2] as number
      const nPlanets = h[3] as number
      if (dPc > 15 && nPlanets < 3) continue // the nearest stars and the richest systems are flyable
      const name = String(h[5])
      const planets = h[3] as number
      this.addFarEntity(
        { id: `host:${name}`, name, kind: 'star', radiusKm: 0.0047 * KM_PER_AU, color: '#5eead4' },
        positionAU(h[0] as number, h[1] as number, dPc * AU_PER_PC),
        'star',
        0.0047,
        {
          facts: [
            { label: 'Known planets', value: String(planets) },
            ...(h[4] != null ? [{ label: 'Apparent magnitude', value: (h[4] as number).toFixed(2) }] : [])
          ],
          note: 'A star with confirmed planets (NASA Exoplanet Archive). Fly to it to see them on their orbits.',
          detail: null,
          defaultDist: 0.06,
          minDist: 0.0008,
          cutout: null,
          halo: null
        }
      )
    }
    this.refreshHostFacts()
    this.dirty = true
  }

  /** Nebulae, clusters and galaxies from the catalogue that have a measured distance. */
  setDeepSky(cat: Catalogue | null, data: DistancesData | null): void {
    for (const e of [...this.orderedEntities]) if (e.def.id.startsWith('dso:')) this.removeEntity(e)
    if (!cat || !data || data.offline || !data.distances) return
    for (const d of cat.dsos) {
      const m = data.distances[d.id]
      if (!m) continue
      // The catalogue has hundreds; flyable entities are the Messier objects, named ones and the brightest.
      if (!(/^M\s*\d+$/.test(d.id.trim()) || d.name || (d.mag ?? 99) <= 7.5)) continue
      this.addDso(d, m.d_pc, m.n, m.lo, m.hi)
    }
    this.dedupeLocalGroup()
    this.rebuildGalaxyCatalogue()
    this.dirty = true
  }

  /** A galaxy's shape from what the catalogues say (morphological type, apparent axis ratio, position angle); a guess where they are silent. */
  private makeGalaxy(key: string, ra: number, dec: number, ba: number, paDeg: number, morph: string | null): GalaxyInfo {
    const seed = hashSeed(key)
    const parsed = parseMorph(morph)
    const g = parsed ?? guessShape(ba, seed)
    const shape: GalaxyShape = { t: g.t, bar: g.bar, ba: ba > 0 ? Math.min(1, ba) : 1, paDeg, seed, guessed: !parsed }
    const axes = modelAxes(ra, dec, paDeg, cosTilt(shape.ba, thicknessOf(shape.t)))
    return { shape, axes, src: { ra, dec, ba, paDeg, morph, key } }
  }

  /** Morphological types (SIMBAD) for the catalogue galaxies: their models take the right shape. */
  setGalaxyTypes(data: GalaxyTypesData | null): void {
    this.gxTypes = data && !data.offline && data.types ? data.types : {}
    for (const e of this.orderedEntities) {
      const gal = e.far?.galaxy
      if (!gal || !e.def.id.startsWith('dso:')) continue
      const morph = this.gxTypes[gal.src.key] ?? null
      if (morph === gal.src.morph) continue
      e.far!.galaxy = this.makeGalaxy(gal.src.key, gal.src.ra, gal.src.dec, gal.src.ba, gal.src.paDeg, morph)
      const old = this.gxModels.get(e.def.id)
      if (old) {
        old.model.dispose()
        this.gxModels.delete(e.def.id)
      }
    }
    this.dirty = true
  }

  /** The real galaxies beyond the Local Group (2MASS Redshift Survey), drawn as points once you are out past about 100,000 light-years. */
  setGalaxyCatalogue(data: Galaxies3dData | null): void {
    this.gxRows =
      data && !data.offline && data.rows
        ? data.rows.map((r) => ({ ra: r[0], dec: r[1], cz: r[2], kt: r[3], logr: r[4], ba: r[5], t: r[6], bar: r[7] }))
        : []
    this.rebuildGalaxyCatalogue()
  }

  /** (Re)make the point cloud, leaving out galaxies that are already flyable ones (the catalogue's own, or the Local Group's) so none is drawn twice. */
  private rebuildGalaxyCatalogue(): void {
    if (this.gxCat) {
      this.gxCat.dispose()
      const i = this.worldLines.indexOf(this.gxCat.points)
      if (i >= 0) this.worldLines.splice(i, 1)
      this.gxCat = null
    }
    if (!this.gxRows.length) return
    const known = this.orderedEntities.filter((e) => e.def.kind === 'galaxy' && e.far && !e.def.id.startsWith('gx:')).map((e) => ({ dir: [e.pos[0] / len3(e.pos), e.pos[1] / len3(e.pos), e.pos[2] / len3(e.pos)] as Vec3, d: len3(e.pos) }))
    this.gxCat = new GalaxyCatalogue(this.gxRows, (ra, dec, au) => {
      const v = positionAU(ra, dec, 1)
      for (const k of known) if (v[0] * k.dir[0] + v[1] * k.dir[1] + v[2] * k.dir[2] > 0.99999 && Math.abs(Math.log(au / k.d)) < 0.7) return true
      return false
    })
    this.scene.add(this.gxCat.points)
    this.worldLines.push(this.gxCat.points)
    // the ones you have already flown to are their own entities: keep them out of the cloud
    for (const id of this.gxDemand) {
      const row = this.entities.get(id)?.far?.galaxy?.catRow
      const k = row === undefined ? -1 : this.gxCat.rowOf.indexOf(row)
      if (k >= 0) this.gxCat.hide(k, true)
    }
    this.dirty = true
  }

  /** Fly to a catalogue galaxy: it becomes a body of its own (with a label, a photo and a 3D model), and the camera goes there. */
  private selectCatalogueGalaxy(k: number): void {
    const cat = this.gxCat
    if (!cat) return
    const row = cat.rowOf[k]
    const r = cat.rows[row]
    const id = `gx:${row}`
    if (!this.entities.has(id)) {
      const distAU = cat.distAU[k]
      const radArc = r.logr > 0 ? Math.pow(10, r.logr) * 1.3 : 20 // the isophotal radius (out to a faint level), a little generously
      const sizeAU = Math.max(distAU * Math.tan((radArc / 3600) * DEG), 1e7)
      const name = designation(r.ra, r.dec)
      const ba = r.ba > 0 ? r.ba : 1
      const gal = this.makeGalaxy(id, r.ra, r.dec, ba, ((hashSeed(id) >>> 4) % 1800) / 10, r.t >= 98 ? null : String(r.t) + (r.bar ? 'B' : ''))
      gal.shape.bar = r.bar > 0 || gal.shape.bar
      gal.catRow = row
      const c = 299792.458
      this.addFarEntity(
        { id, name, kind: 'galaxy', radiusKm: sizeAU * KM_PER_AU, color: KIND_COLOUR.galaxy ?? '#4ade80' },
        [cat.pos[3 * k], cat.pos[3 * k + 1], cat.pos[3 * k + 2]],
        'ext',
        sizeAU,
        {
          facts: [
            { label: 'Classification', value: morphName(gal.shape) },
            { label: 'Real size', value: `~${fmtLy((2 * sizeAU) / AU_PER_LY)} across` },
            { label: 'Apparent size', value: `${((2 * radArc) / 60).toFixed(2)}′` },
            { label: 'Speed away (redshift)', value: `${r.cz.toLocaleString()} km/s (z = ${(r.cz / c).toFixed(4)})` },
            { label: 'Brightness (K band)', value: `magnitude ${r.kt.toFixed(1)}` }
          ],
          note: 'Position, redshift and brightness are from the 2MASS Redshift Survey. The distance is the speed away divided by the Hubble constant (70 km/s per Mpc), so it is rough for the nearer galaxies. The 3D model follows the real type, tilt and size; its individual stars are not real.',
          detail: null,
          defaultDist: sizeAU * 3.4,
          minDist: Math.max(sizeAU * 0.02, 1e6),
          cutout: { ra: r.ra, dec: r.dec, fovDeg: Math.max(0.03, Math.min(6, ((2 * radArc) / 3600) * 2.6)) },
          halo: null,
          haloOpacity: 0.3,
          galaxy: gal
        }
      )
      cat.hide(k, true)
      this.gxDemand.push(id)
      while (this.gxDemand.length > 30) {
        const old = this.gxDemand.shift()!
        const oe = this.entities.get(old)
        if (!oe || old === this.focusId) continue
        const kk = cat.rowOf.indexOf(oe.far?.galaxy?.catRow ?? -1)
        if (kk >= 0) cat.hide(kk, false)
        const m = this.gxModels.get(old)
        if (m) {
          m.model.dispose()
          this.gxModels.delete(old)
        }
        this.removeEntity(oe)
      }
    }
    this.select(id)
  }

  /** Show or hide each galaxy's 3D model by how close the camera is, building it the first time it is needed and keeping only a few. */
  private layoutGalaxyModels(cam: THREE.PerspectiveCamera, pxPerRad: number): void {
    const now = performance.now()
    for (const e of this.orderedEntities) {
      const gal = e.far?.galaxy
      if (!gal) continue
      const dist = Math.max(e.group.position.distanceTo(cam.position), 1e-12)
      const k = dist / e.radiusAU
      let a = this.layers.galaxies && e.group.visible ? 1 - ramp(k, 20, 60) : 0
      if (e.def.id === this.focusId) a *= 1 - 0.4 * this.gxPhoto
      let entry = this.gxModels.get(e.def.id)
      if (a <= 0.01) {
        if (entry) entry.model.group.visible = false
        continue
      }
      if (!entry) {
        const model = new GalaxyModel(gal.shape)
        model.group.scale.setScalar(e.radiusAU)
        this.tmpM.makeBasis(new THREE.Vector3(...gal.axes.x), new THREE.Vector3(...gal.axes.y), new THREE.Vector3(...gal.axes.z))
        model.group.quaternion.setFromRotationMatrix(this.tmpM)
        e.group.add(model.group)
        entry = { model, used: now }
        this.gxModels.set(e.def.id, entry)
        // keep only the nearest few: dispose the one used longest ago
        while (this.gxModels.size > 4) {
          let oldest: string | null = null
          let t = Infinity
          for (const [id, m] of this.gxModels) if (id !== e.def.id && m.used < t) (t = m.used), (oldest = id)
          if (!oldest) break
          this.gxModels.get(oldest)!.model.dispose()
          this.gxModels.delete(oldest)
        }
      }
      entry.used = now
      entry.model.update((e.radiusAU / dist) * pxPerRad, a)
      // the soft green glow that marks a galaxy from far away gives way to its stars
      const glow = e.far?.halo
      if (glow) glow.material.opacity *= 1 - 0.9 * a
    }
  }

  private addDso(d: Dso, dPc: number, n: number, lo: number, hi: number): void {
    const group = dsoGroup(d.type)
    const kind: BodyKind = group === 'galaxies' ? 'galaxy' : group === 'clusters' ? 'cluster' : 'nebula'
    const distAU = dPc * AU_PER_PC
    const majArc = d.maj ?? 3
    const sizeAU = Math.max(distAU * Math.tan(((majArc / 60) * DEG) / 2), 5e3)
    const tier: Tier = dPc > 1e5 ? 'ext' : 'dso'
    const name = d.name ? `${d.id} ${d.name}` : d.id
    this.addFarEntity(
      { id: `dso:${d.id}`, name, kind, radiusKm: sizeAU * KM_PER_AU, color: KIND_COLOUR[kind] ?? '#cccccc' },
      positionAU(d.ra, d.dec, distAU),
      tier,
      sizeAU,
      {
        facts: [
          { label: 'Classification', value: DSO_TYPE_LABEL[d.type] ?? d.type },
          ...(d.mag != null ? [{ label: 'Magnitude', value: d.mag.toFixed(1) }] : []),
          { label: 'Apparent size', value: d.min ? `${d.maj?.toFixed(1)}′ × ${d.min.toFixed(1)}′` : `${majArc.toFixed(1)}′` },
          { label: 'Real size', value: `~${fmtLy(((distAU * Math.tan(((majArc / 60) * DEG))) / AU_PER_LY))} across` },
          { label: 'Distance measurements', value: n > 1 ? `${n}, from ${fmtLy((lo * 3.26156))} to ${fmtLy((hi * 3.26156))}` : '1' }
        ],
        note: 'Distance is the median of the published measurements (SIMBAD), so it is only as good as they agree.',
        detail: { kind: 'dso', key: d.id },
        defaultDist: sizeAU * 3.4,
        minDist: Math.max(sizeAU * 0.02, 100),
        cutout: { ra: d.ra, dec: d.dec, fovDeg: Math.max(0.25, Math.min(20, (majArc / 60) * 2.4)) },
        halo: null,
        ...(kind === 'galaxy' ? { galaxy: this.makeGalaxy(`dso:${d.id}`, d.ra, d.dec, d.maj && d.min ? d.min / d.maj : 1, d.pa ?? ((hashSeed(d.id) >>> 4) % 1800) / 10, this.gxTypes[d.id] ?? null) } : {})
      }
    )
  }

  /** The Milky Way's satellites, Andromeda and the other galaxies of the Local Group. */
  setLocalGroup(data: LocalGroupData | null): void {
    for (const e of [...this.orderedEntities]) if (e.def.id.startsWith('lg:')) this.removeEntity(e)
    if (!data || data.offline || !data.galaxies?.length) return
    for (const g of data.galaxies) {
      const distAU = g.d_kpc * AU_PER_KPC
      const rh = g.rh_arcmin ?? 4
      const sizeAU = Math.max(distAU * Math.tan(((1.5 * rh) / 60) * DEG), 1e6)
      const groupName = g.group === 'MW' ? 'Milky Way satellite' : g.group === 'M31' ? 'Andromeda satellite' : 'Local Group / nearby field'
      this.addFarEntity(
        { id: `lg:${g.name}`, name: g.name, kind: 'galaxy', radiusKm: sizeAU * KM_PER_AU, color: KIND_COLOUR.galaxy ?? '#4ade80' },
        positionAU(g.ra, g.dec, distAU),
        g.d_kpc > 1500 ? 'ext' : 'lg',
        sizeAU,
        {
          facts: [
            { label: 'Classification', value: g.type && g.type !== '????' ? g.type : 'Dwarf galaxy' },
            { label: 'Group', value: groupName },
            ...(g.vmag != null ? [{ label: 'Apparent magnitude', value: g.vmag.toFixed(1) }] : []),
            ...(g.rh_arcmin != null ? [{ label: 'Half-light radius', value: `${g.rh_arcmin.toFixed(1)}′` }] : [])
          ],
          note: 'Distances from McConnachie (2012). Many of these are faint dwarf galaxies that are hard to see in a survey image.',
          detail: null,
          defaultDist: sizeAU * 3.4,
          minDist: Math.max(sizeAU * 0.02, 1000),
          cutout: { ra: g.ra, dec: g.dec, fovDeg: Math.max(0.25, Math.min(20, ((3 * rh) / 60) * 2.4)) },
          halo: null,
          haloOpacity: 0.28,
          galaxy: this.makeGalaxy(`lg:${g.name}`, g.ra, g.dec, g.ell != null ? Math.max(0.15, 1 - g.ell) : 1, g.pa ?? ((hashSeed(g.name) >>> 4) % 1800) / 10, g.type && g.type !== '????' ? g.type : 'dIrr')
        }
      )
    }
    this.dedupeLocalGroup()
    this.rebuildGalaxyCatalogue()
    this.dirty = true
  }

  /** A galaxy that is both in the catalogue and the Local Group table is one entity (the catalogue
   * one, which has photos), not two on top of each other. */
  private dedupeLocalGroup(): void {
    const dsos = this.orderedEntities.filter((e) => e.def.id.startsWith('dso:') && e.def.kind === 'galaxy')
    for (const lg of [...this.orderedEntities]) {
      if (!lg.def.id.startsWith('lg:')) continue
      const twin = dsos.find((d) => angularSep(d.pos, lg.pos) < 0.02 && Math.abs(Math.log(len3(d.pos) / len3(lg.pos))) < 0.5)
      if (twin) this.removeEntity(lg)
    }
  }

  /** Constellation figures between stars at their measured depths, from the 3D star rows. */
  private buildConstellations(data: StarsData): void {
    const pairs: number[] = []
    const ranges = new Map<string, [number, number]>()
    const figs: { abbr: string; name: string; rows: number[] }[] = []
    for (const f of data.figures ?? []) {
      const start = pairs.length
      for (const [a, b] of f.lines) {
        const ra = f.rows[a]
        const rb = f.rows[b]
        if (ra >= 0 && rb >= 0) pairs.push(ra, rb)
      }
      if (pairs.length > start) ranges.set(f.abbr, [start, pairs.length - start])
      const used = [...new Set(f.rows.filter((r) => r >= 0))]
      if (f.kind === 'constellation' && used.length >= 3 && pairs.length > start) figs.push({ abbr: f.abbr, name: f.name, rows: used })
    }
    if (!pairs.length) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * pairs.length), 3))
    const colour = new Float32Array(3 * pairs.length)
    for (let i = 0; i < pairs.length; i++) colour.set(FIGURE_BRIGHT.map((c, k) => c * 0.45 + FIGURE_DIM[k] * 0.1), 3 * i)
    g.setAttribute('color', new THREE.BufferAttribute(colour, 3))
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false }))
    lines.frustumCulled = false
    lines.renderOrder = -7
    this.scene.add(lines)
    this.worldLines.push(lines)
    this.constel = { lines, rows: Int32Array.from(pairs), ranges }
    this.paintFigures()

    // Each constellation is something to fly to: viewed from the side, its depth shows.
    for (const f of figs) {
      const c = this.figureCentroid(f.rows)
      const depths = f.rows.map((r) => Math.hypot(this.starBase[3 * r], this.starBase[3 * r + 1], this.starBase[3 * r + 2]) / AU_PER_LY)
      const extent = Math.max(...f.rows.map((r) => Math.hypot(this.starBase[3 * r] - c[0], this.starBase[3 * r + 1] - c[1], this.starBase[3 * r + 2] - c[2])), 1e5)
      const entity = this.addFarEntity(
        { id: `con:${f.abbr}`, name: f.name, kind: 'constellation', radiusKm: extent * KM_PER_AU, color: '#7aa2e0' },
        c,
        'star',
        extent,
        {
          facts: [
            { label: 'Stars in the figure', value: String(f.rows.length) },
            { label: 'Nearest star', value: fmtFar(Math.min(...depths) * AU_PER_LY) },
            { label: 'Farthest star', value: fmtFar(Math.max(...depths) * AU_PER_LY) },
            { label: 'Depth of the figure', value: `${fmtLy(Math.max(...depths) - Math.min(...depths))}` }
          ],
          note: 'The figure drawn between its stars at their measured distances. You are seeing it from the side, so how deep it really is shows. Distances are Hipparcos parallaxes; the faintest stars are the least certain.',
          detail: null,
          defaultDist: extent * 3.4,
          minDist: extent * 0.3,
          cutout: null,
          halo: null
        }
      )
      this.figures.push({ abbr: f.abbr, entity, rows: f.rows })
    }
  }

  private figureCentroid(rows: number[]): Vec3 {
    const y = this.years + HIPPARCOS_EPOCH_OFFSET_YR
    const c: Vec3 = [0, 0, 0]
    for (const r of rows) for (let k = 0; k < 3; k++) c[k] += this.starBase[3 * r + k] + this.starVel[3 * r + k] * y
    return [c[0] / rows.length, c[1] / rows.length, c[2] / rows.length]
  }

  /** Brighten one constellation's lines and dim the rest (null: all equal). */
  private highlightFigure(abbr: string | null): void {
    if (this.highlighted === abbr) return
    this.highlighted = abbr
    this.paintFigures()
  }

  private paintFigures(): void {
    const c = this.constel
    if (!c) return
    const attr = c.lines.geometry.attributes.color as THREE.BufferAttribute
    const hi = this.highlighted
    c.ranges.forEach(([start, count], abbr) => {
      const tone = hi === null ? [0.3, 0.42, 0.65] : abbr === hi ? FIGURE_BRIGHT : FIGURE_DIM
      for (let i = start; i < start + count; i++) attr.setXYZ(i, tone[0], tone[1], tone[2])
    })
    attr.needsUpdate = true
    ;(c.lines.material as THREE.LineBasicMaterial).opacity = hi === null ? 0.5 : 0.85
    this.dirty = true
  }

  /** Move every 3D star (dots, named stars, constellation ends) to where its proper motion has taken it. */
  private updateStarMotion(): void {
    const y = this.years + HIPPARCOS_EPOCH_OFFSET_YR
    if (this.nearCloud) this.nearCloud.material.uniforms.uYears.value = y
    const b = this.starBase
    const v = this.starVel
    for (const [e, row] of this.starRow) {
      e.pos = [b[3 * row] + v[3 * row] * y, b[3 * row + 1] + v[3 * row + 1] * y, b[3 * row + 2] + v[3 * row + 2] * y]
    }
    for (const f of this.figures) f.entity.pos = this.figureCentroid(f.rows)
    if (this.constel) {
      const attr = this.constel.lines.geometry.attributes.position as THREE.BufferAttribute
      const rows = this.constel.rows
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        attr.setXYZ(i, b[3 * r] + v[3 * r] * y, b[3 * r + 1] + v[3 * r + 1] * y, b[3 * r + 2] + v[3 * r + 2] * y)
      }
      attr.needsUpdate = true
    }
  }

  private disposeCloud(p: THREE.Points | THREE.LineSegments): void {
    this.scene.remove(p)
    p.geometry.dispose()
    ;(p.material as THREE.Material).dispose()
    const i = this.worldLines.indexOf(p)
    if (i >= 0) this.worldLines.splice(i, 1)
  }

  /** Dwarf planets, asteroids, comets and the belts, from JPL elements. Safe to call again. */
  setOrbits(data: OrbitData | null): void {
    for (const e of [...this.orderedEntities]) if (e.elements) this.removeEntity(e)
    for (const c of this.clouds) {
      c.points.geometry.dispose()
      ;(c.points.material as THREE.Material).dispose()
      this.smallGroup.remove(c.points)
    }
    this.clouds.length = 0
    if (!data) return

    for (const b of data.bodies) this.addSmallBody(b)
    const cloudStyle: Record<string, { color: number; size: number; opacity: number }> = {
      belt: { color: 0xb8a48a, size: 1.5, opacity: 0.6 },
      trojans: { color: 0xd8a070, size: 1.5, opacity: 0.6 },
      kuiper: { color: 0x7fa0c8, size: 1.5, opacity: 0.55 }
    }
    for (const [key, rows] of Object.entries(data.clouds)) {
      if (!rows.length) continue
      const style = cloudStyle[key] ?? cloudStyle.belt
      const cloud = makeCloud(rows)
      const buffer = new Float32Array(3 * cloud.count)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(buffer, 3))
      const points = new THREE.Points(g, new THREE.PointsMaterial({ size: style.size, sizeAttenuation: false, color: style.color, transparent: true, opacity: style.opacity, depthWrite: false }))
      ;(points.material as THREE.Material).userData.base = style.opacity
      points.frustumCulled = false
      this.smallGroup.add(points)
      this.worldLines.push(points)
      this.clouds.push({ points, cloud, buffer })
    }
    this.cloudJd = NaN
    this.refreshMeteorStreams()
    this.updatePositions()
    this.dirty = true
  }

  list(): ListItem[] {
    return this.orderedEntities.map((e) => ({ id: e.def.id, name: e.def.name, kind: e.def.kind, parent: e.parent?.def.id ?? null, tier: e.tier }))
  }

  /** Fly to a body and centre the view on it. A number is the camera's distance from it (AU). */
  focusOn(id: string, opts?: number | FocusOptions): void {
    const e = this.entities.get(id)
    if (!e) return
    if (this.mode === 'surface') this.leaveSurface()
    if (this.mode === 'fly') this.exitFly()
    const o: FocusOptions = typeof opts === 'number' ? { distance: opts } : (opts ?? {})
    if (!this.keepHomeFollow) this.dropHomeFollow()
    this.satFollow = null
    if (this.shipFollow !== null) {
      this.shipFollow = null
      this.camera.near = 1e-7
      this.camera.updateProjectionMatrix()
    }
    this.focusId = id
    this.setFocusLimits(id)
    const fromDist = this.camera.position.length()
    const toDist = o.distance ?? this.defaultDistance(e)
    const fromDir = this.camera.position.clone().normalize()
    this.highlightFigure(id.startsWith('con:') ? id.slice(4) : null)
    this.showSystem(id.startsWith('host:') ? id.slice(5) : null)
    // A constellation is best seen from the side (perpendicular to the line of sight), where its depth shows.
    let dirVec = o.direction ?? e.far?.direction
    if (!dirVec && id.startsWith('con:')) {
      const [x, y] = e.pos
      const n = Math.hypot(x, y) || 1
      dirVec = [-y / n, x / n, 0.25]
    }
    const toDir = dirVec ? new THREE.Vector3(...dirVec).normalize() : fromDir.clone()
    const decades = Math.abs(Math.log10(toDist / fromDist))
    this.flight = {
      start: performance.now(),
      dur: o.instant ? 1 : Math.min(4800, FLIGHT_MS + 260 * decades),
      fromOrigin: [...this.origin],
      fromDist,
      toDist,
      fromDir,
      toDir
    }
    this.controls.enabled = false
    this.updateBillboard(e)
    this.dirty = true
  }

  /** Put the camera on the Earth at the photo's viewpoint (or update it while it is there). */
  enterSurface(s: SurfaceState): void {
    if (this.mode !== 'surface') {
      this.dropHomeFollow()
      this.satFollow = null
      this.flight = null
      this.controls.enabled = false
      this.focusId = 'earth'
      this.mode = 'surface'
      if (!this.ground) {
        this.ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ color: 0x03050a, transparent: true }))
        this.ground.frustumCulled = false
        this.scene.add(this.ground)
      }
    }
    this.surface = s
    this.dirty = true
  }

  isSurface(): boolean {
    return this.mode === 'surface'
  }

  /** Rise into free orbit around the Earth from the current altitude, looking down. */
  leaveSurface(): void {
    if (this.mode !== 'surface' || !this.surface) return
    const earth = this.entities.get('earth')!
    const dist = earth.radiusAU + this.surface.altitudeM / M_PER_AU
    this.mode = 'orbit'
    this.focusId = 'earth'
    this.setFocusLimits('earth')
    this.controls.minDistance = earth.radiusAU + 300_000 / M_PER_AU // let you fall back to the ground from here
    this.camera.clearViewOffset()
    this.levelView()
    this.camera.fov = 50
    this.camera.near = 1e-7
    this.camera.updateProjectionMatrix()
    this.camera.position.set(...this.surface.zenith).multiplyScalar(dist)
    this.camera.lookAt(0, 0, 0)
    if (this.ground) this.ground.visible = false
    this.surface = null
    this.origin = [...earth.pos]
    this.controls.enabled = true
    this.controls.update()
    this.dirty = true
  }

  /** The camera, standing on the Earth: aimed like the photo near the ground, tilting to look down as it rises. */
  private applySurfaceCamera(): void {
    const s = this.surface!
    const earth = this.entities.get('earth')!
    const R = earth.radiusAU
    const alt = s.altitudeM / M_PER_AU
    this.origin = [earth.pos[0] + s.zenith[0] * R, earth.pos[1] + s.zenith[1] * R, earth.pos[2] + s.zenith[2] * R]
    const t = nadirBlend(s.altitudeM)
    const zen = new THREE.Vector3(...s.zenith)
    const fwd = new THREE.Vector3(...s.view.forward)
    const up = new THREE.Vector3(...s.view.up)
    const look = fwd.clone().lerp(zen.clone().negate(), t).normalize()
    // The picture's "up" gives way to ecliptic north, which is what the orbit controls use, so the
    // hand-over to free orbit doesn't roll the view.
    const north = new THREE.Vector3(0, 0, 1)
    north.addScaledVector(look, -north.dot(look))
    const upV = north.lengthSq() > 1e-6 ? up.clone().lerp(north.normalize(), t) : up.clone()
    upV.addScaledVector(look, -upV.dot(look)).normalize()
    this.camera.position.copy(zen).multiplyScalar(alt)
    this.camera.up.copy(upV)
    this.camera.lookAt(this.camera.position.clone().add(look))
    this.camera.fov = s.view.fovDeg + (50 - s.view.fovDeg) * t
    this.camera.near = Math.min(1e-7, Math.max(1e-11, alt * 0.02))
    // Off-centre projection: the photo's optical axis lands where the photo's centre is on screen.
    const W = this.container.clientWidth || 1
    const H = this.container.clientHeight || 1
    const px = W / 2 + (s.view.principal.x - W / 2) * (1 - t)
    const py = H / 2 + (s.view.principal.y - H / 2) * (1 - t)
    this.camera.setViewOffset(W, H, W / 2 - px, H / 2 - py, W, H)
    // The flat ground under the observer, fading out as the globe takes over.
    if (this.ground) {
      const g = this.ground
      g.visible = s.altitudeM < GROUND_FADE_M[1]
      g.scale.setScalar(GROUND_RADIUS_AU)
      g.position.set(0, 0, 0)
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), zen)
      const f = Math.min(1, Math.max(0, (s.altitudeM - GROUND_FADE_M[0]) / (GROUND_FADE_M[1] - GROUND_FADE_M[0])))
      ;(g.material as THREE.MeshBasicMaterial).opacity = 1 - f * f * (3 - 2 * f)
    }
  }

  /** The picture of a nebula or galaxy (a survey cut-out) shown when you fly up to it. */
  private updateBillboard(e: Entity): void {
    if (this.billboard && this.billboard.owner !== e.def.id) {
      this.scene.remove(this.billboard.sprite)
      this.billboard.sprite.material.dispose()
      this.billboard = null
    }
    const c = e.far?.cutout
    if (!c || this.billboard) return
    const distAU = len3(e.pos)
    const width = 2 * distAU * Math.tan((c.fovDeg * DEG) / 2)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }))
    sprite.scale.set(width, width, 1)
    sprite.renderOrder = 3
    sprite.visible = false
    e.group.add(sprite)
    this.billboard = { sprite, owner: e.def.id, width }
    const url = deepspaceCutoutUrl(c.ra, c.dec, c.fovDeg, BILLBOARD_PX)
    const cached = this.billboardTextures.get(url)
    const apply = (t: THREE.Texture): void => {
      if (this.disposed || this.billboard?.sprite !== sprite) return
      sprite.material.map = t
      sprite.material.needsUpdate = true
      sprite.visible = true
      this.dirty = true
    }
    if (cached) apply(cached)
    else {
      this.loader.setCrossOrigin('anonymous')
      this.loader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace
          this.billboardTextures.set(url, t)
          apply(t)
        },
        undefined,
        () => undefined // offline and not cached: the marker and halo stand in
      )
    }
  }

  describe(id: string): BodyInfo | null {
    const e = this.entities.get(id)
    if (!e) return null
    if (e.far) {
      const f = e.far
      const shape = f.galaxy && !e.def.id.startsWith('gx:') ? [{ label: 'Shape', value: morphName(f.galaxy.shape) }] : []
      const facts = [{ label: 'Type', value: KIND_LABEL[e.def.kind] }, { label: 'Distance from the Sun', value: fmtFar(len3(e.pos)) }, ...shape, ...f.facts]
      return { id, name: e.def.name, kind: e.def.kind, facts, note: f.note, detail: f.detail }
    }
    const earth = this.entities.get('earth')
    const facts: { label: string; value: string }[] = []
    const d = e.def
    const diameter = e.elements ? this.smallDiameter(e) : d.radiusKm * 2
    facts.push({ label: 'Type', value: KIND_LABEL[d.kind] })
    if (diameter !== null) facts.push({ label: 'Diameter', value: fmtKm(diameter) })
    if (e.parent) {
      const moon = e.moon!
      const r = moon.aKm ? fmtKm(moon.aKm) : fmtDistance(len3(sub3(e.pos, e.parent.pos)))
      facts.push({ label: `Distance from ${e.parent.def.name}`, value: moon.aKm ? `${r} (orbit radius)` : r })
    } else if (id !== 'sun') {
      facts.push({ label: 'Distance from the Sun', value: fmtDistance(len3(e.pos)) })
    }
    if (earth && id !== 'earth' && !e.parent) facts.push({ label: 'Distance from Earth', value: fmtDistance(len3(sub3(e.pos, earth.pos))) })
    if (e.elements) {
      facts.push({ label: 'Orbital period', value: fmtPeriod(e.elements.per) })
      facts.push({ label: 'Closest to Sun', value: `${perihelion(e.elements).toFixed(2)} AU` })
      facts.push({ label: 'Farthest from Sun', value: `${aphelion(e.elements).toFixed(1)} AU` })
      facts.push({ label: 'Orbit tilt', value: `${e.elements.i.toFixed(1)}°` })
    } else if (d.periodDays) {
      facts.push({ label: 'Orbital period', value: fmtPeriod(d.periodDays) })
    }
    let note: string | null = null
    if (e.moon && !e.moon.engine)
      note = moonIsReal(e.moon, new Date(this.dateMs))
        ? 'Position from JPL Horizons ephemerides.'
        : 'The orbit is the right size and period, but this moon is drawn at an illustrative point along it (real positions cover 1990 to 2060).'
    else if (e.elements && (d.kind === 'asteroid' || d.kind === 'comet')) note = 'Shown larger than true size when you zoom in. Orbit from JPL elements, accurate for a picture but not for aiming a telescope.'
    else if (e.elements) note = 'Orbit from JPL elements, accurate for a picture but not for aiming a telescope.'
    return { id, name: d.name, kind: d.kind, facts, note, detail: DETAIL_IDS.has(id) ? { kind: 'body', key: id } : null }
  }

  dispose(): void {
    this.disposed = true
    this.container.removeEventListener('wheel', this.onEarthWheel, { capture: true })
    this.detail?.dispose()
    if (this.cloudTimer !== null) window.clearInterval(this.cloudTimer)
    if (this.ozoneTimer !== null) window.clearInterval(this.ozoneTimer)
    if (this.rainTimer !== null) window.clearInterval(this.rainTimer)
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.container.removeEventListener('pointerdown', this.onDown)
    this.container.removeEventListener('pointerup', this.onUp)
    this.container.removeEventListener('pointermove', this.onMoveHome)
    window.removeEventListener('keydown', this.onRollKey)
    window.removeEventListener('keyup', this.onRollKey)
    window.removeEventListener('blur', this.onRollBlur)
    this.controls.dispose()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        ;(x as THREE.MeshStandardMaterial).map?.dispose()
        ;(x as THREE.MeshStandardMaterial).emissiveMap?.dispose()
        x.dispose()
      }
    })
    this.lightning?.dispose()
    this.traffic?.dispose()
    this.ships?.dispose()
    this.quakes?.dispose()
    this.volcanoes?.dispose()
    this.heat?.dispose()
    this.launches?.dispose()
    this.aqi?.dispose()
    this.shipIcon?.dispose()
    this.gxCat?.dispose()
    for (const m of this.gxModels.values()) m.model.dispose()
    this.gxModels.clear()
    this.flow.wind?.dispose()
    this.flow.currents?.dispose()
    this.flowMarker?.removeFromParent()
    this.aurora?.dispose()
    if (this.mode === 'fly') this.exitFly()
    this.magneto?.dispose()
    this.windLayer?.dispose()
    this.sunLayer?.dispose()
    this.meteors?.dispose()
    this.meteorStream?.dispose()
    this.eclipse?.dispose()
    this.belts?.dispose()
    this.ionosphere?.dispose()
    this.setMyPlaces(null)
    this.clearHome()
    this.dot.dispose()
    this.planeIcon?.dispose()
    this.glow.dispose()
    this.ring?.dispose()
    this.mwCloud?.glow.dispose()
    this.starGeo.dispose()
    this.ground?.geometry.dispose()
    ;(this.ground?.material as THREE.Material | undefined)?.dispose()
    for (const t of this.billboardTextures.values()) t.dispose()
    this.earthMapHi.value?.dispose()
    this.earthNightMapHi.value?.dispose()
    this.pendingHi.day?.dispose()
    this.pendingHi.night?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss() // give the graphics memory back now, not when the browser gets round to it
    this.renderer.domElement.remove()
    this.labels.domElement.remove()
  }

  // ---------- building the scene ----------

  private buildBodies(): void {
    const sun = this.addEntity(SUN, null, null, null)
    const light = new THREE.PointLight(0xfff4e0, 9, 5000, 0) // reaches 5,000 AU, not other stars' planets
    sun.group.add(light)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xffb455, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }))
    glow.scale.setScalar(sun.radiusAU * 16)
    glow.renderOrder = 5
    sun.group.add(glow)
    this.sunGlow = glow

    for (const p of PLANETS) this.addEntity(p, null, null, null)
    this.addEntity(PLUTO, null, null, null)
    for (const m of MOONS) this.addEntity(m, this.entities.get(m.parent)!, m, null)
    for (const e of this.orderedEntities) this.buildOrbitLine(e)
  }

  private addSmallBody(b: SmallBodyElements): void {
    const def: BodyDef = {
      id: b.id,
      name: b.name,
      kind: b.kind === 'dwarf' ? 'dwarf' : b.kind,
      radiusKm: (b.diameter_km ?? DEFAULT_MINOR_RADIUS_KM * 2) / 2,
      color: b.kind === 'comet' ? '#9fd8ff' : b.kind === 'dwarf' ? '#d9c4a8' : '#b8b0a4',
      periodDays: b.per
    }
    const e = this.addEntity(def, null, null, { a: b.a, e: b.e, i: b.i, om: b.om, w: b.w, tp: b.tp, per: b.per }, b.full_name)
    this.smallGroup.add(e.group)
    this.buildOrbitLine(e)
    if (b.kind === 'comet') {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
      e.tail = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xa8dcff, transparent: true, opacity: 0.7 }))
      e.tail.frustumCulled = false
      e.group.add(e.tail)
    }
  }

  private addEntity(def: BodyDef, parent: Entity | null, moon: MoonDef | null, elements: Elements | null, fullName?: string): Entity {
    const group = new THREE.Group()
    const radiusAU = def.radiusKm / KM_PER_AU
    const detail = def.id === 'earth' ? this.plan.earthSegments : def.kind === 'planet' || def.kind === 'star' ? [64, 32] : def.kind === 'moon' || def.kind === 'dwarf' ? [32, 16] : [16, 8]
    const geo = new THREE.SphereGeometry(1, detail[0], detail[1])
    geo.rotateX(Math.PI / 2) // poles along +z, the ecliptic north axis
    const mat: THREE.Material =
      def.kind === 'star' ? new THREE.MeshBasicMaterial({ color: 0xffd27a }) : new THREE.MeshStandardMaterial({ color: def.color, roughness: 1, metalness: 0 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.scale.setScalar(radiusAU)
    group.add(mesh)

    const { marker, label } = this.makeMarkerAndLabel(def, group, def.kind === 'moon' || def.kind === 'asteroid' ? MARKER_SCALE * 0.7 : MARKER_SCALE)
    this.scene.add(group)

    const e: Entity = {
      def,
      group,
      pos: [0, 0, 0],
      radiusAU,
      parent,
      mesh,
      marker,
      label,
      moon,
      elements,
      fullName: fullName ?? def.name,
      orbit: null,
      orbitEpochMs: NaN,
      tail: null,
      rot: null,
      ring: null,
      tier: 'solar',
      fixed: false,
      far: null,
      alpha: 1
    }
    this.entities.set(def.id, e)
    this.orderedEntities.push(e)
    if (def.id === 'saturn') this.buildRing(e)
    if (def.id === 'earth') {
      this.buildAtmosphere(e)
      this.buildClouds(e)
      this.buildOzone(e)
      this.buildRain(e)
    }
    this.applyTexture(e)
    return e
  }

  private makeMarkerAndLabel(def: BodyDef, group: THREE.Group, markerScale: number): { marker: THREE.Sprite; label: CSS2DObject } {
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: def.color, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
    marker.scale.setScalar(markerScale)
    marker.renderOrder = 10
    group.add(marker)

    const div = document.createElement('div')
    div.textContent = def.name
    div.style.cssText = `padding-left:11px;font:11px/1.2 system-ui,sans-serif;color:${def.kind === 'comet' ? '#bfe4ff' : '#e8ecf5'};text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:auto;cursor:pointer;user-select:none`
    div.dataset.ssId = def.id
    const label = new CSS2DObject(div)
    label.center.set(0, 0.5)
    group.add(label)
    return { marker, label }
  }

  /** Something outside the solar system, fixed in place: a star, nebula, cluster or galaxy. Stars get
   * a glowing ball at their true size; the rest a soft halo the size of the object. */
  private addFarEntity(def: BodyDef, pos: Vec3, tier: Tier, radiusAU: number, far: FarInfo, starColourRgb?: Vec3): Entity {
    const group = new THREE.Group()
    let mesh = this.orphanMesh
    if (starColourRgb) {
      mesh = new THREE.Mesh(this.starGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(...starColourRgb) }))
      mesh.scale.setScalar(radiusAU)
      group.add(mesh)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: new THREE.Color(...starColourRgb), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }))
      glow.scale.setScalar(radiusAU * 5)
      glow.renderOrder = 5
      group.add(glow)
    } else if (def.id !== 'milkyway' && def.kind !== 'constellation' && !def.id.startsWith('host:')) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: def.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 }))
      halo.scale.setScalar(radiusAU * 2.6)
      halo.renderOrder = 4
      group.add(halo)
      far.halo = halo
    }
    const { marker, label } = this.makeMarkerAndLabel(def, group, FAR_MARKER_SCALE)
    this.scene.add(group)
    const e: Entity = {
      def, group, pos: [...pos] as Vec3, radiusAU, parent: null, mesh, marker, label, moon: null, elements: null, fullName: def.name,
      orbit: null, orbitEpochMs: NaN, tail: null, rot: null, ring: null, tier, fixed: true, far, alpha: 1
    }
    this.entities.set(def.id, e)
    this.orderedEntities.push(e)
    return e
  }

  /** The galaxy itself: a label at its centre, and a schematic cloud of stars and arms. */
  private buildMilkyWay(): void {
    this.mwCloud = buildMilkyWay(this.plan.milkyWayPoints)
    this.scene.add(this.mwCloud.points)
    this.worldLines.push(this.mwCloud.points)
    this.addFarEntity(
      { id: 'milkyway', name: 'Milky Way', kind: 'galaxy', radiusKm: 15 * AU_PER_KPC * KM_PER_AU, color: '#c4b5fd' },
      GALACTIC_CENTRE_AU,
      'lg',
      15 * AU_PER_KPC,
      {
        facts: [
          { label: 'Classification', value: 'Barred spiral galaxy' },
          { label: 'Diameter', value: '~100,000 light-years' },
          { label: 'Stars', value: '100 to 400 billion' },
          { label: "Sun's distance from the centre", value: '~26,600 light-years' }
        ],
        note: 'The spiral arms are a schematic drawing on a simple model, not a survey. The Sun, nearby stars, clusters and neighbouring galaxies are at their measured places.',
        detail: null,
        defaultDist: 6e9,
        minDist: 5e6,
        direction: GALACTIC_NORTH_ECLIPTIC,
        cutout: null,
        halo: null
      }
    )
  }

  private removeEntity(e: Entity): void {
    if (this.billboard?.owner === e.def.id) {
      this.billboard.sprite.material.dispose()
      this.billboard = null
    }
    this.scene.remove(e.group)
    this.smallGroup.remove(e.group)
    e.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry !== this.starGeo) m.geometry?.dispose?.()
      ;(m.material as THREE.Material | undefined)?.dispose?.()
    })
    if (e.orbit) {
      e.orbit.geometry.dispose()
      ;(e.orbit.material as THREE.Material).dispose()
      this.scene.remove(e.orbit)
      const i = this.worldLines.indexOf(e.orbit)
      if (i >= 0) this.worldLines.splice(i, 1)
    }
    e.label.element.remove()
    this.entities.delete(e.def.id)
    this.orderedEntities.splice(this.orderedEntities.indexOf(e), 1)
  }

  /** The thin blue line at the limb. A shell just above the surface that glows where you look through it edge-on. */
  private buildAtmosphere(e: Entity): void {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: this.sunWorld, uFull: this.earthFull },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSun;
        uniform float uFull;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 n = normalize(vN);
          float rim = pow(1.0 - abs(dot(n, normalize(vV))), 3.2);
          float s = dot(n, normalize(uSun));
          float day = max(smoothstep(-0.30, 0.45, s), uFull); // the lit side glows, the night side barely does (unless the whole globe is shown in daylight)
          float dusk = exp(-pow(s / 0.22, 2.0));             // the sunrise / sunset band along the terminator
          vec3 col = mix(vec3(0.30, 0.55, 1.0), vec3(1.0, 0.50, 0.22), dusk * 0.75);
          gl_FragColor = vec4(col, clamp(rim * (0.06 + 0.94 * day), 0.0, 1.0) * 0.85);
        }`
    })
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.028, 96, 48), material)
    shell.frustumCulled = false
    shell.renderOrder = 6
    e.mesh.add(shell) // a child of the globe, so it scales with it and hides with it near the ground
  }

  /** The group clouds, aurora and aircraft are parented to: turns with the Earth like the globe mesh, but stays
   * up (as a child of the Earth's group, not its mesh) when standing on the ground hides the globe itself. */
  private ensureSkySurface(e: Entity): THREE.Group {
    if (!this.skySurface) {
      this.skySurface = new THREE.Group()
      e.group.add(this.skySurface)
    }
    return this.skySurface
  }

  /** A slightly larger, transparent globe for the live clouds (empty until a cloud picture arrives; a child of the Earth so it turns with it). */
  private buildClouds(e: Entity): void {
    const geo = new THREE.SphereGeometry(1.0055, 128, 64)
    geo.rotateX(Math.PI / 2)
    // double-sided: standing on the ground puts the camera inside this shell, looking up at its underside
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    // in full daylight the clouds over the night side are lit like the ones over the day side
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunView = this.sunView
      shader.uniforms.uFull = this.earthFull
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform float uFull;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * ${FULL_DAYLIGHT_GAIN} * uFull * (1.0 - smoothstep(0.0, ${FULL_DAYLIGHT_RAMP}, dot(normalize(vNormal), normalize(uSunView))));`
        )
    }
    mat.customProgramCacheKey = () => 'earth-clouds-full-daylight'
    const mesh = new THREE.Mesh(geo, mat)
    mesh.visible = false
    mesh.renderOrder = 4
    mesh.frustumCulled = false
    this.ensureSkySurface(e).add(mesh)
    this.cloudMesh = mesh
  }

  /** Show (or hide) the world's real clouds on the Earth: a satellite-built cloud map, refreshed every half hour while on. */
  setLiveClouds(on: boolean): void {
    this.cloudsOn = on
    if (this.cloudTimer !== null) window.clearInterval(this.cloudTimer)
    this.cloudTimer = null
    if (this.cloudMesh) this.cloudMesh.visible = on && !!(this.cloudMesh.material as THREE.MeshStandardMaterial).map
    this.dirty = true
    if (!on) {
      this.cb.onWeather?.({ state: 'off' })
      return
    }
    void this.loadClouds()
    this.cloudTimer = window.setInterval(() => void this.loadClouds(), 30 * 60_000)
  }

  private async loadClouds(): Promise<void> {
    const mesh = this.cloudMesh
    if (!mesh || this.cloudLoading) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    this.cloudLoading = true
    if (!mat.map) this.cb.onWeather?.({ state: 'loading' })
    try {
      const res = await fetch(`http://127.0.0.1:8765/weather/clouds?t=${Date.now()}`)
      if (!res.ok) throw new Error(res.status === 502 ? 'no connection to the cloud service' : `HTTP ${res.status}`)
      const bitmap = await createImageBitmap(await res.blob())
      const info = (await (await fetch('http://127.0.0.1:8765/weather/clouds/info')).json().catch(() => null)) as { fetched_at?: number } | null
      if (this.disposed || !this.cloudsOn) return bitmap.close()
      // greyscale infrared (bright = cloud) -> white with transparency, faded out where the composite has no real data (the poles)
      const w = this.plan.earthSegments[0] >= 144 ? 4096 : 2048
      const h = w / 2
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0, w, h)
      bitmap.close()
      const img = ctx.getImageData(0, 0, w, h)
      const d = img.data
      for (let y = 0; y < h; y++) {
        const polar = 1 - smooth(74, 86, Math.abs(90 - ((y + 0.5) / h) * 180))
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const a = smooth(0.4, 0.85, d[i] / 255) * polar
          d[i] = d[i + 1] = d[i + 2] = 255
          d[i + 3] = Math.round(a * 255)
        }
      }
      ctx.putImageData(img, 0, 0)
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.anisotropy = 4
      mat.map?.dispose()
      mat.map = tex
      mat.needsUpdate = true
      mesh.visible = true
      this.dirty = true
      this.cb.onWeather?.({ state: 'live', fetchedAt: (info?.fetched_at ?? Date.now() / 1000) * 1000 })
    } catch (err) {
      if (!mat.map) this.cb.onWeather?.({ state: 'error', message: err instanceof Error ? err.message : 'could not load the clouds' })
    } finally {
      this.cloudLoading = false
    }
  }

  private buildOzone(e: Entity): void {
    const geo = new THREE.SphereGeometry(1.006, 96, 48)
    geo.rotateX(Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.visible = false
    mesh.renderOrder = 4
    mesh.frustumCulled = false
    e.mesh.add(mesh)
    this.ozoneMesh = mesh
  }

  /** Show (or hide) NASA's global ozone map on the Earth, refreshed every 30 minutes while on (the backend itself only rebuilds it every few hours). */
  setOzoneLayer(on: boolean): void {
    this.ozoneOn = on
    if (this.ozoneTimer !== null) window.clearInterval(this.ozoneTimer)
    this.ozoneTimer = null
    if (this.ozoneMesh) this.ozoneMesh.visible = on && !!(this.ozoneMesh.material as THREE.MeshBasicMaterial).map
    this.dirty = true
    if (!on) return
    void this.loadOzone()
    this.ozoneTimer = window.setInterval(() => void this.loadOzone(), 30 * 60_000)
  }

  private async loadOzone(): Promise<void> {
    const mesh = this.ozoneMesh
    if (!mesh || this.ozoneLoading) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    this.ozoneLoading = true
    try {
      const res = await fetch(`http://127.0.0.1:8765/deepspace/science-map/ozone?t=${Date.now()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bitmap = await createImageBitmap(await res.blob())
      if (this.disposed || !this.ozoneOn) return bitmap.close()
      const tex = new THREE.Texture(bitmap)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.needsUpdate = true
      mat.map?.dispose()
      mat.map = tex
      mat.needsUpdate = true
      mesh.visible = true
      this.dirty = true
    } catch {
      // soft-fail: the layer just stays hidden or shows the last picture
    } finally {
      this.ozoneLoading = false
    }
  }

  private buildRain(e: Entity): void {
    const geo = new THREE.SphereGeometry(1.0057, 96, 48)
    geo.rotateX(Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.visible = false
    mesh.renderOrder = 4
    mesh.frustumCulled = false
    e.mesh.add(mesh)
    this.rainMesh = mesh
  }

  /** Show (or hide) the world's live precipitation radar/satellite composite (RainViewer), refreshed every 10 minutes while on. Coverage follows real radar networks, so it looks patchy over oceans and some regions. */
  setRainLayer(on: boolean): void {
    this.rainOn = on
    if (this.rainTimer !== null) window.clearInterval(this.rainTimer)
    this.rainTimer = null
    if (this.rainMesh) this.rainMesh.visible = on && !!(this.rainMesh.material as THREE.MeshBasicMaterial).map
    this.dirty = true
    if (!on) return
    void this.loadRain()
    this.rainTimer = window.setInterval(() => void this.loadRain(), 10 * 60_000)
  }

  private async loadRain(): Promise<void> {
    const mesh = this.rainMesh
    if (!mesh || this.rainLoading) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    this.rainLoading = true
    try {
      const res = await fetch(`http://127.0.0.1:8765/weather/rain?t=${Date.now()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bitmap = await createImageBitmap(await res.blob())
      if (this.disposed || !this.rainOn) return bitmap.close()
      const tex = new THREE.Texture(bitmap)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.needsUpdate = true
      mat.map?.dispose()
      mat.map = tex
      mat.needsUpdate = true
      mesh.visible = true
      this.dirty = true
    } catch {
      // soft-fail: the layer just stays hidden or shows the last frame
    } finally {
      this.rainLoading = false
    }
  }

  // ---------- an orbit around the Earth (the ISS) ----------

  /** Draw this satellite's orbit around the Earth: the ring it flies, its track on the ground (last 45 minutes, next 90) and where it is. null removes it. */
  setOrbitTrace(rec: SatRecord | null): void {
    if (this.trace) {
      const t = this.trace
      for (const o of [t.ring, t.ground, t.marker]) {
        o.removeFromParent()
        ;(o as THREE.Line).geometry?.dispose?.()
        ;((o as THREE.Line).material as THREE.Material).dispose()
      }
      t.label.removeFromParent()
      this.trace = null
    }
    const earth = this.entities.get('earth')
    this.dirty = true
    if (!rec || !earth) return
    const ringGeo = new THREE.BufferGeometry()
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_RING_POINTS + 1) * 3), 3))
    const ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0, depthWrite: false }))
    ring.frustumCulled = false
    ring.renderOrder = 5
    earth.group.add(ring)
    const groundGeo = new THREE.BufferGeometry()
    groundGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GROUND_TRACK_POINTS * 3), 3))
    const ground = new THREE.Line(groundGeo, new THREE.LineBasicMaterial({ color: 0xffa0a0, transparent: true, opacity: 0, depthWrite: false }))
    ground.frustumCulled = false
    ground.renderOrder = 5
    earth.mesh.add(ground) // its points are latitude / longitude on the globe, so it turns with it
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xff5c5c, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
    marker.scale.setScalar(0.018)
    marker.renderOrder = 12
    earth.group.add(marker)
    const div = document.createElement('div')
    div.textContent = 'ISS'
    div.style.cssText = 'padding-left:12px;font:bold 11px/1.2 system-ui,sans-serif;color:#ff8a8a;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none'
    const label = new CSS2DObject(div)
    marker.add(label)
    this.trace = { rec, ring, ground, marker, label, dateMs: NaN, valid: false }
    this.updateOrbitTrace(true)
  }

  /** Rebuild the orbit for the scene's time (the ring is one revolution from now; the ground track turns with the Earth). */
  private updateOrbitTrace(force = false): void {
    const tr = this.trace
    if (!tr) return
    if (!force && Math.abs(this.dateMs - tr.dateMs) < 15_000) return
    tr.dateMs = this.dateMs
    const conv = temeToEcliptic(julianDate(this.dateMs))
    const k = 1 / KM_PER_AU
    const noRad = (tr.rec.rec as unknown as { no?: number }).no
    const periodMs = (noRad && noRad > 0 ? (2 * Math.PI) / noRad : 92.9) * 60_000
    const ringPos = tr.ring.geometry.attributes.position as THREE.BufferAttribute
    let valid = true
    for (let i = 0; i <= ORBIT_RING_POINTS; i++) {
      const p = eciPosition(tr.rec, new Date(this.dateMs + (i / ORBIT_RING_POINTS) * periodMs))
      if (!p) {
        valid = false
        break
      }
      const v = conv(p) // one frame for the whole ring: an orbit is fixed against the stars, not the Earth
      ringPos.setXYZ(i, v[0] * k, v[1] * k, v[2] * k)
    }
    ringPos.needsUpdate = true
    const groundPos = tr.ground.geometry.attributes.position as THREE.BufferAttribute
    const R = (this.entities.get('earth')?.def.radiusKm ?? 6371) * 1
    for (let i = 0; i < GROUND_TRACK_POINTS && valid; i++) {
      const minutes = -GROUND_TRACK_PAST_MIN + (i / (GROUND_TRACK_POINTS - 1)) * (GROUND_TRACK_PAST_MIN + GROUND_TRACK_FUTURE_MIN)
      const g = globalState(tr.rec, new Date(this.dateMs + minutes * 60_000))
      if (!g) {
        valid = false
        break
      }
      const la = g.latDeg * DEG
      const lo = g.lonDeg * DEG
      const r = 1 + 60 / R // a little above the surface so the line does not sink into the globe
      groundPos.setXYZ(i, r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la))
    }
    groundPos.needsUpdate = true
    const now = valid ? eciPosition(tr.rec, new Date(this.dateMs)) : null
    if (now) {
      const v = conv(now)
      tr.marker.position.set(v[0] * k, v[1] * k, v[2] * k)
    } else valid = false
    tr.valid = valid
    this.dirty = true
  }

  private layoutTrace(cam: THREE.PerspectiveCamera): void {
    const tr = this.trace
    const earth = this.entities.get('earth')
    if (!tr || !earth) return
    // full strength within ~120,000 km of the Earth, gone by ~1.2 million km
    const a = tr.valid ? 1 - ramp(earth.group.position.distanceTo(cam.position), 8e-4, 8e-3) : 0
    ;(tr.ring.material as THREE.LineBasicMaterial).opacity = 0.9 * a
    ;(tr.ground.material as THREE.LineBasicMaterial).opacity = 0.85 * a
    tr.ring.visible = tr.ground.visible = tr.marker.visible = tr.label.visible = a > 0.02
  }

  // ---------- aurora ----------

  /** Show or hide the live aurora (NOAA OVATION) on the Earth. Needs a grid from setAuroraGrid. */
  setAurora(on: boolean): void {
    this.auroraOn = on
    if (this.aurora) this.aurora.visible = on
    this.ensureAurora()
    this.dirty = true
  }

  /** The newest aurora chance grid (every few minutes). */
  setAuroraGrid(grid: AuroraGrid): void {
    this.auroraGrid = grid
    if (this.aurora) this.aurora.setGrid(grid)
    else this.ensureAurora()
    this.dirty = true
  }

  private ensureAurora(): void {
    if (this.aurora || !this.auroraGrid) return
    const earth = this.entities.get('earth')
    if (!earth) return
    this.aurora = new AuroraLayer(this.ensureSkySurface(earth), this.auroraGrid, this.sunWorld)
    this.aurora.visible = this.auroraOn
  }

  private layoutAurora(cam: THREE.PerspectiveCamera): void {
    const layer = this.aurora
    const earth = this.entities.get('earth')
    if (!layer || !earth) return
    const alt = earth.group.position.distanceTo(cam.position) / earth.radiusAU - 1
    // the aurora is real-time: it only means something while the scene shows about now
    const minutes = Math.abs(this.dateMs - Date.now()) / 60_000
    const relevance = earth.mesh.visible ? 1 - ramp(minutes, 5, 60) : 0
    layer.update(alt, relevance)
  }

  // ---------- rolling the orbiting view ----------

  /** The orbit controls turn about the camera's "up" and cache it, so a new "up" has to be told to them. */
  private syncControlsUp(): void {
    const c = this.controls as unknown as { _quat?: THREE.Quaternion; _quatInverse?: THREE.Quaternion }
    if (!c._quat || !c._quatInverse) return
    c._quat.setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0))
    c._quatInverse.copy(c._quat).invert()
  }

  /** Ecliptic north up again. */
  private levelView(): void {
    this.camera.up.set(0, 0, 1)
    this.syncControlsUp()
  }

  /** Roll level in fly mode: keep the current heading, but pick "up" as close to ecliptic north as the geometry allows. */
  private levelFly(): void {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.flyQuat)
    const worldUp = new THREE.Vector3(0, 0, 1)
    const right = new THREE.Vector3().crossVectors(forward, worldUp)
    if (right.lengthSq() < 1e-8) return // looking almost straight along ecliptic north/south: roll isn't well-defined against this reference
    right.normalize()
    const up = new THREE.Vector3().crossVectors(right, forward).normalize()
    this.flyQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()))
  }

  /** Undo any roll picked up from Q/E. Orbit mode faces ecliptic north up again; fly mode keeps its heading but levels against the same reference. Does nothing mid-flight or outside orbit/fly. */
  resetRoll(): void {
    if (this.mode === 'fly') this.levelFly()
    else if (this.mode === 'orbit' && this.controls.enabled && !this.flight) this.levelView()
    else return
    this.dirty = true
  }

  private readonly onRollKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyQ' && e.code !== 'KeyE' && e.code !== 'KeyR') return
    if (e.type === 'keyup') return void this.rollKeys.delete(e.code)
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    if (e.ctrlKey || e.metaKey || e.altKey || this.mode !== 'orbit' || !this.controls.enabled || this.flight) return
    e.preventDefault()
    if (e.code === 'KeyR') {
      if (!e.repeat) this.resetRoll()
      return
    }
    this.rollKeys.add(e.code)
  }

  private readonly onRollBlur = (): void => {
    this.rollKeys.clear()
  }

  /** Q and E turn the picture about the line of sight (the same way and speed as in fly mode). Returns true when the view moved. */
  private stepRoll(dt: number): boolean {
    const roll = ((this.rollKeys.has('KeyQ') ? 1 : 0) - (this.rollKeys.has('KeyE') ? 1 : 0)) * 1.1 * dt
    if (!roll) return false
    const cam = this.camera
    const back = cam.getWorldDirection(new THREE.Vector3()).negate()
    // Turn the camera's own up (always square to the view, so this works right up to the poles) and make it the controls' up.
    cam.up.set(0, 1, 0).applyQuaternion(cam.quaternion).applyAxisAngle(back, roll).normalize()
    this.syncControlsUp()
    return true
  }

  // ---------- fly-through ----------

  isFly(): boolean {
    return this.mode === 'fly'
  }

  /** Free flight: W/A/S/D, Space and Ctrl to move, the mouse to steer, Q/E to roll, the wheel to change speed, Shift to boost. */
  enterFly(): boolean {
    if (this.mode === 'fly') return true
    if (this.mode === 'surface') this.leaveSurface()
    this.dropHomeFollow()
    this.satFollow = null
    this.flight = null
    this.mode = 'fly'
    this.controls.enabled = false
    this.camera.updateMatrixWorld()
    this.flyQuat.copy(this.camera.quaternion)
    this.flyVel.set(0, 0, 0)
    this.flyKeys.clear()
    this.flyLook = { dx: 0, dy: 0 }
    document.addEventListener('keydown', this.onFlyKey, true)
    document.addEventListener('keyup', this.onFlyKey, true)
    document.addEventListener('mousemove', this.onFlyMouse, true)
    document.addEventListener('pointerlockchange', this.onFlyLock)
    window.addEventListener('blur', this.onFlyBlur)
    this.container.addEventListener('wheel', this.onFlyWheel, { capture: true, passive: false })
    this.container.addEventListener('pointerdown', this.onFlyDown, true)
    window.addEventListener('pointerup', this.onFlyUp, true)
    try {
      const r = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
      r?.catch?.(() => undefined) // no pointer lock: the mouse steers while the left button is held
    } catch {
      /* same */
    }
    this.dirty = true
    return true
  }

  exitFly(): void {
    if (this.mode !== 'fly') return
    document.removeEventListener('keydown', this.onFlyKey, true)
    document.removeEventListener('keyup', this.onFlyKey, true)
    document.removeEventListener('mousemove', this.onFlyMouse, true)
    document.removeEventListener('pointerlockchange', this.onFlyLock)
    window.removeEventListener('blur', this.onFlyBlur)
    this.container.removeEventListener('wheel', this.onFlyWheel, true)
    this.container.removeEventListener('pointerdown', this.onFlyDown, true)
    window.removeEventListener('pointerup', this.onFlyUp, true)
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
    this.flyKeys.clear()
    this.flyDragging = false
    this.mode = 'orbit'
    this.setFocusLimits(this.focusId)
    this.camera.near = 1e-7
    this.camera.updateProjectionMatrix()
    this.controls.enabled = true
    this.controls.update() // the view turns to the nearest body, and orbiting it works as before
    this.cb.onFly?.(null)
    this.dirty = true
  }

  private readonly onFlyKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && !document.pointerLockElement) return
    const known = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']
    if (e.type === 'keydown' && e.code === 'Escape') return this.exitFly()
    if (!known.includes(e.code)) return
    e.preventDefault()
    if (e.type === 'keydown') this.flyKeys.add(e.code)
    else this.flyKeys.delete(e.code)
  }

  private readonly onFlyMouse = (e: MouseEvent): void => {
    if (document.pointerLockElement !== this.renderer.domElement && !this.flyDragging) return
    this.flyLook.dx += e.movementX
    this.flyLook.dy += e.movementY
  }

  private readonly onFlyDown = (e: PointerEvent): void => {
    if (document.pointerLockElement !== this.renderer.domElement && e.button === 0) this.flyDragging = true
  }
  private readonly onFlyUp = (): void => {
    this.flyDragging = false
  }

  private readonly onFlyLock = (): void => {
    // Escape (or anything else that releases the mouse) ends fly mode
    if (this.mode === 'fly' && document.pointerLockElement !== this.renderer.domElement) this.exitFly()
  }

  private readonly onFlyBlur = (): void => {
    this.flyKeys.clear()
  }

  private readonly onFlyWheel = (e: WheelEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    this.flyMul = wheelMultiplier(this.flyMul, e.deltaY)
    this.dirty = true
  }

  /** The bodies the camera can hit, with their real sizes. */
  private flyBodies(): FlyBody[] {
    const out: FlyBody[] = []
    for (const e of this.orderedEntities) {
      const k = e.def.kind
      if (e.far) {
        // out among the stars: the named stars are solid, and galaxies and nebulae are flown through (they only slow you as you come up to them),
        // so the speed follows whatever is nearest and you can cross the whole scene without racing past everything
        if (e.def.id.startsWith('con:')) continue
        if (k === 'star') out.push({ id: e.def.id, pos: e.pos, radius: e.radiusAU })
        else if (k === 'galaxy' || k === 'nebula' || k === 'cluster') out.push({ id: e.def.id, pos: e.pos, radius: e.radiusAU, soft: true })
        continue
      }
      if (e.fixed) continue
      if (k === 'star' || k === 'planet' || k === 'moon' || k === 'dwarf') out.push({ id: e.def.id, pos: e.pos, radius: e.radiusAU })
    }
    return out
  }

  private stepFly(dt: number, now: number): void {
    const cam = this.camera
    let focus = this.entities.get(this.focusId)!
    // steering: mouse to pitch and yaw, Q and E to roll (all about the camera's own axes, so there is no "up" to lose)
    const k = this.flyKeys
    const sens = 0.0022
    const roll = ((k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0)) * 1.1 * dt
    const q = new THREE.Quaternion()
    const ax = new THREE.Vector3()
    if (this.flyLook.dx || this.flyLook.dy || roll) {
      this.flyQuat.multiply(q.setFromAxisAngle(ax.set(0, 1, 0), -this.flyLook.dx * sens))
      this.flyQuat.multiply(q.setFromAxisAngle(ax.set(1, 0, 0), -this.flyLook.dy * sens))
      this.flyQuat.multiply(q.setFromAxisAngle(ax.set(0, 0, 1), roll))
      this.flyQuat.normalize()
      this.flyLook.dx = this.flyLook.dy = 0
    }

    const abs: FlyVec = [focus.pos[0] + cam.position.x, focus.pos[1] + cam.position.y, focus.pos[2] + cam.position.z]
    const bodies = this.flyBodies()
    const near = nearestBody(bodies, abs)
    const height = near?.height ?? len3(abs)
    const boost = k.has('ShiftLeft') || k.has('ShiftRight')
    const speed = flySpeed(height, this.flyMul, boost)

    // the wanted velocity in the camera's frame, then in the world; eased so starting and stopping are smooth
    const want = new THREE.Vector3(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      (k.has('Space') ? 1 : 0) - (k.has('ControlLeft') || k.has('ControlRight') ? 1 : 0),
      (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0)
    )
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(speed).applyQuaternion(this.flyQuat)
    this.flyVel.lerp(want, 1 - Math.exp(-dt / 0.12))
    if (want.lengthSq() === 0 && this.flyVel.length() < speed * 0.002) this.flyVel.set(0, 0, 0)

    let next = abs
    if (this.flyVel.lengthSq() > 0) next = moveWithoutTunnelling(abs, [this.flyVel.x * dt, this.flyVel.y * dt, this.flyVel.z * dt], bodies)
    // bodies move too (and a fast frame may have ended inside one): put the camera back on the surface
    let touching = false
    for (const b of bodies) {
      if (b.soft) continue
      const rel: FlyVec = [next[0] - b.pos[0], next[1] - b.pos[1], next[2] - b.pos[2]]
      if (pushOut(rel, b.radius)) {
        next = [b.pos[0] + rel[0], b.pos[1] + rel[1], b.pos[2] + rel[2]]
        touching = true
      } else if (Math.hypot(...rel) < stopRadius(b.radius) * 1.002) touching = true
    }
    // resting on a surface: the speed is what the camera really moved, not what it was asked to
    if (touching) this.flyVel.set((next[0] - abs[0]) / dt, (next[1] - abs[1]) / dt, (next[2] - abs[2]) / dt)
    const fromSun = len3(next)
    if (fromSun > MAX_FLY_AU) next = [next[0] * (MAX_FLY_AU / fromSun), next[1] * (MAX_FLY_AU / fromSun), next[2] * (MAX_FLY_AU / fromSun)]

    // the floating origin follows the nearest body (with some hysteresis, so two close bodies do not fight over it)
    const nearNow = nearestBody(bodies, next)
    if (nearNow && nearNow.id !== this.focusId) {
      const cur = bodies.find((b) => b.id === this.focusId)
      const curH = cur ? Math.max(0, len3([next[0] - cur.pos[0], next[1] - cur.pos[1], next[2] - cur.pos[2]]) - cur.radius) : Infinity
      if (nearNow.height < curH * 0.8) {
        this.focusId = nearNow.id
        focus = this.entities.get(this.focusId)!
      }
    }
    this.origin = [...focus.pos]
    cam.position.set(next[0] - focus.pos[0], next[1] - focus.pos[1], next[2] - focus.pos[2])
    cam.quaternion.copy(this.flyQuat)
    const h = nearNow?.height ?? height
    const wantNear = Math.min(1e-7, Math.max(1e-12, h * 0.05))
    if (Math.abs(Math.log(wantNear / cam.near)) > 0.1) {
      cam.near = wantNear
      cam.updateProjectionMatrix()
    }

    if (now - this.flyHudAt > 120) {
      this.flyHudAt = now
      const nb = nearNow ? this.entities.get(nearNow.id) : null
      this.cb.onFly?.({ name: nb?.fullName ?? '', heightAU: h, speedAUps: this.flyVel.length(), mul: this.flyMul, boost, locked: document.pointerLockElement === this.renderer.domElement, touching })
    }
  }

  // ---------- my location ----------

  /** Show the whole Earth in daylight: no night side, no city lights. Clouds, the ocean's sun glint, aurora and lightning are drawn as before. */
  setFullDaylight(on: boolean): void {
    this.earthFullTarget = on ? 1 : 0
    // the first call (the saved setting, at start-up) is instant; after that switching it fades
    if (!this.earthFullSet) {
      this.earthFullSet = true
      this.earthFull.value = this.earthFullTarget
    }
    // without the night-side picture (no connection) the night side is only the plain emissive glow: lift that too
    const earth = this.entities.get('earth')
    const m = earth?.mesh.material
    if (m instanceof THREE.MeshStandardMaterial && !this.earthNightReady && m.emissiveMap) m.emissive.set(on ? 0xc8ccd8 : 0x141a26)
    this.dirty = true
  }

  /** A green dot on the Earth at the observer's place (null: none). */
  setHome(p: { latDeg: number; lonDeg: number } | null): void {
    this.homePlace = p
    this.clearHome()
    if (!p) this.dropHomeFollow()
    const earth = this.entities.get('earth')
    if (!p || !earth) return
    const la = p.latDeg * DEG
    const lo = p.lonDeg * DEG
    const unit = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([unit.x * 1.002, unit.y * 1.002, unit.z * 1.002], 3))
    const halo = new THREE.Points(geo, new THREE.PointsMaterial({ size: 22, sizeAttenuation: false, color: 0x22e06a, map: this.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6, alphaTest: 0.01 }))
    const dot = new THREE.Points(geo, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0x22e06a, map: this.dot, transparent: true, depthWrite: false, opacity: 1, alphaTest: 0.01 }))
    for (const o of [halo, dot]) {
      o.frustumCulled = false
      o.renderOrder = 8
      earth.mesh.add(o)
    }
    const el = document.createElement('div')
    el.textContent = 'My location'
    el.style.cssText = 'padding:0 0 0 9px;font:11px/1.2 system-ui,sans-serif;color:#7dffa8;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none'
    const label = new CSS2DObject(el)
    label.center.set(-0.05, 1.5)
    label.position.copy(unit).multiplyScalar(1.002)
    earth.mesh.add(label)
    this.home = { unit, dot, halo, label, el }
    this.dirty = true
  }

  private clearHome(): void {
    const h = this.home
    if (!h) return
    for (const o of [h.dot, h.halo]) {
      o.removeFromParent()
      ;(o.material as THREE.Material).dispose()
    }
    h.dot.geometry.dispose()
    h.label.removeFromParent()
    h.el.remove()
    this.home = null
  }

  /** Fly to the observer's place, looking straight down at it from about `altitudeKm` up. */
  viewHome(altitudeKm = 2500, instant = false): void {
    const earth = this.entities.get('earth')
    const h = this.home
    if (!earth || !h) return
    earth.mesh.updateMatrixWorld()
    const dir = h.unit.clone().applyQuaternion(this.earthQuat(this.tmpQ) ? this.tmpQ : earth.mesh.quaternion)
    this.focusOn('earth', { distance: earth.radiusAU + altitudeKm / KM_PER_AU, direction: [dir.x, dir.y, dir.z], instant })
  }

  /** The Earth's orientation now, from its rotation data (its mesh only takes it on a drawn frame). */
  private earthQuat(out: THREE.Quaternion): boolean {
    const earth = this.entities.get('earth')
    if (!earth?.rot) return false
    out.setFromRotationMatrix(this.tmpM.makeBasis(new THREE.Vector3(...earth.rot.prime), new THREE.Vector3(...earth.rot.east), new THREE.Vector3(...earth.rot.north)))
    return true
  }

  /**
   * Fly to the observer's place and stay over it: the camera turns with the Earth, so the green dot stays in the
   * middle of the view while the planet rotates underneath. Zooming keeps it; dragging the view lets go.
   */
  followHome(on: boolean, restore?: { distanceAU: number }): void {
    if (!on) return this.dropHomeFollow()
    if (!this.home || !this.earthQuat(this.homeQ)) return
    const earth = this.entities.get('earth')!
    const here = restore ? restore.distanceAU : this.camera.position.length()
    const alt = restore || (this.focusId === 'earth' && this.mode === 'orbit') ? Math.max(EARTH_MIN_ALT_KM, (here - earth.radiusAU) * KM_PER_AU) : 2500
    this.keepHomeFollow = true
    this.viewHome(Math.min(alt, 2.5e6), !!restore)
    this.keepHomeFollow = false
    this.homeFollow = true
    this.cb.onHomeFollow?.(true)
  }

  isFollowingHome(): boolean {
    return this.homeFollow
  }

  private dropHomeFollow(): void {
    if (!this.homeFollow) return
    this.homeFollow = false
    this.cb.onHomeFollow?.(false)
  }

  /** Turn the camera by however far the Earth has turned since the last frame. */
  private stepHomeFollow(): boolean {
    const q = this.tmpQ
    if (!this.earthQuat(q)) return false
    // delta = now * inverse(before): the spin since the camera was last carried along
    const delta = q.clone().multiply(this.homeQ.clone().invert())
    this.homeQ.copy(q)
    if (delta.w > 1 - 1e-12) return false
    if (this.flight) this.flight.toDir.applyQuaternion(delta)
    else if (this.mode === 'orbit') this.camera.position.applyQuaternion(delta)
    return true
  }

  /** Is the green dot under this pixel? */
  private pickHome(px: number, py: number, width: number, height: number): boolean {
    const h = this.home
    const earth = this.entities.get('earth')
    if (!h || !earth || !h.dot.visible) return false
    const world = h.unit.clone().multiplyScalar(1.002).applyMatrix4(earth.mesh.matrixWorld)
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(this.camera.position)).normalize()
    const dist = earth.group.position.distanceTo(this.camera.position) / earth.radiusAU
    if (h.unit.dot(camLocal) < 1 / dist - 0.02) return false // on the far side
    const p = world.project(this.camera)
    if (p.z > 1) return false
    return Math.hypot((p.x * 0.5 + 0.5) * width - px, (0.5 - p.y * 0.5) * height - py) <= 14
  }

  private layoutHome(cam: THREE.PerspectiveCamera): void {
    const h = this.home
    const earth = this.entities.get('earth')
    if (!h || !earth) return
    const distR = earth.group.position.distanceTo(cam.position) / earth.radiusAU
    const fade = earth.mesh.visible ? 1 - ramp(distR - 1, 25, 60) : 0
    const on = fade > 0.02
    h.dot.visible = h.halo.visible = on
    ;(h.dot.material as THREE.PointsMaterial).opacity = fade
    // the halo breathes, so the dot is easy to find on a busy globe
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 450)
    ;(h.halo.material as THREE.PointsMaterial).opacity = 0.75 * fade * (0.45 + 0.55 * pulse)
    ;(h.halo.material as THREE.PointsMaterial).size = 18 + 10 * pulse
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(cam.position)).normalize()
    const facing = h.unit.dot(camLocal) > 1 / distR - 0.02
    h.label.visible = on && facing && distR - 1 < 8
    h.el.style.opacity = String(fade)
  }

  // ---------- the Earth's magnetic field and the solar wind ----------

  private ensureMagneto(): MagnetoLayer | null {
    if (this.magneto) return this.magneto
    const earth = this.entities.get('earth')
    if (!earth) return null
    this.magneto = new MagnetoLayer(earth.group, earth.mesh, earth.radiusAU, this.dot, this.glow)
    this.magneto.setFlags(this.magnetoFlags)
    if (this.magnetoData.stations.length) this.magneto.setStations(this.magnetoData.stations)
    return this.magneto
  }

  /** Which parts of the magnetic field are shown: field lines, the surface map (and which map), the magnetopause and bow shock, the ground stations. */
  setMagnetoFlags(f: MagnetoFlags): void {
    this.magnetoFlags = { ...f }
    if (f.lines || f.map || f.surfaces || f.stations) this.ensureMagneto()
    this.magneto?.setFlags(this.magnetoFlags)
    this.dirty = true
  }

  /** The live numbers that shape the field: the wind at L1, Kp, Dst and the magnetometer stations. */
  setMagnetoData(d: { wind: WindNow & { temperature?: number | null }; kp: number | null; dst: number | null; stations: StationRow[] }): void {
    const stationsChanged = d.stations !== this.magnetoData.stations
    this.magnetoData = d
    if (stationsChanged) this.magneto?.setStations(d.stations)
    this.windLayer?.setWind(d.wind)
    this.dirty = true
  }

  private layoutMagneto(cam: THREE.PerspectiveCamera): void {
    const layer = this.magneto
    const earth = this.entities.get('earth')
    if (!layer || !earth) return
    const camRe = earth.group.position.distanceTo(cam.position) / earth.radiusAU
    const live = 1 - ramp(Math.abs(this.dateMs - Date.now()) / 60_000, 5, 60)
    const d = this.magnetoData
    const bz = d.wind.bz ?? 0
    const dst = d.dst ?? 0
    const kp = d.kp ?? 0
    const disturbance = Math.min(1, Math.max(0, Math.max(-dst / 120, (kp - 3) / 5, (-bz - 5) / 15))) * live
    const mag = magnetosphereFromWind(live > 0.5 ? d.wind : {})
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(cam.position)).normalize()
    layer.update(
      { sunDir: this.sunWorld.value, earthQuat: earth.mesh.quaternion, magnetosphere: mag, disturbance, stretch: tailStretch(live * bz, live * kp), live, camRe, timeS: performance.now() / 1000 },
      this.dateMs
    )
    layer.updateStationLabels(camLocal, camRe, live)
  }

  private ensureWind(): WindLayer | null {
    if (this.windLayer) return this.windLayer
    const sun = this.entities.get('sun')
    if (!sun) return null
    this.windLayer = new WindLayer(sun.group, this.dot)
    this.windLayer.setFlags(this.windFlags)
    this.windLayer.setWind(this.magnetoData.wind)
    return this.windLayer
  }

  /** Which parts of the solar wind are shown: the particle stream, the arrival markers, NOAA's flow picture. */
  setWindFlags(f: WindFlags): void {
    this.windFlags = { ...f }
    if (f.stream || f.markers || f.sheet) this.ensureWind()
    this.windLayer?.setFlags(this.windFlags)
    this.dirty = true
  }

  /** What is on its way to Earth (CMEs, fast streams, shocks seen at L1). */
  setWindMarkers(list: WindMarker[]): void {
    this.ensureWind()?.setMarkers(list)
    this.dirty = true
  }

  /** NOAA's WSA-Enlil picture (null: none for this date). */
  setWindSheet(bitmap: ImageBitmap | null, auFraction = 0.5884): void {
    const layer = this.ensureWind()
    if (!layer) return bitmap?.close()
    if (bitmap) layer.setSheet(bitmap, auFraction)
    else layer.clearSheet()
    this.dirty = true
  }

  private layoutWind(cam: THREE.PerspectiveCamera): void {
    const layer = this.windLayer
    const sun = this.entities.get('sun')
    const earth = this.entities.get('earth')
    if (!layer || !sun || !earth) return
    const live = 1 - ramp(Math.abs(this.dateMs - Date.now()) / 60_000, 5, 60)
    const focus = this.entities.get(this.focusId)
    const bodyRatio = focus && this.focusId !== 'earth' ? focus.group.position.distanceTo(cam.position) / Math.max(focus.radiusAU, 1e-9) : Infinity
    cam.updateMatrixWorld()
    const earthView = earth.group.getWorldPosition(new THREE.Vector3()).applyMatrix4(cam.matrixWorldInverse)
    layer.update(earth.pos, this.dateMs, earth.group.position.distanceTo(cam.position), sun.group.position.distanceTo(cam.position), live, earthView, earth.radiusAU, bodyRatio)
  }

  // ---------- the live Sun ----------

  private ensureSun(): SunLayer | null {
    if (this.sunLayer) return this.sunLayer
    const sun = this.entities.get('sun')
    if (!sun) return null
    this.sunLayer = new SunLayer(sun.group, sun.radiusAU)
    this.sunLayer.setFlags(this.sunFlags)
    return this.sunLayer
  }

  /** Which parts of the live Sun are shown: the surface picture, the corona sheets, the CME bubbles and the sunspot labels. */
  setSunFlags(f: SunLayerFlags): void {
    this.sunFlags = { ...f }
    this.sunLayer?.setFlags(this.sunFlags)
    // the real corona replaces the drawn glow
    if (this.sunGlow) (this.sunGlow.material as THREE.SpriteMaterial).opacity = f.corona ? 0.22 : 0.85
    this.dirty = true
  }

  /** The surface picture (a real photograph of the Sun's Earth-facing side). */
  setSunSurface(kind: SurfaceKind, bitmap: ImageBitmap): void {
    this.ensureSun()?.setSurface(kind, bitmap)
    this.dirty = true
  }

  /** The SOHO coronagraph pictures. */
  setSunCorona(which: 'c2' | 'c3', bitmap: ImageBitmap): void {
    this.ensureSun()?.setCorona(which, bitmap)
    this.dirty = true
  }

  /** Coronal mass ejections, numbered sunspot groups, and solar flares. */
  setSunActivity(cmes: Cme[], regions: Region[], flares: Flare[] = []): void {
    this.ensureSun()?.setActivity(cmes, regions, flares)
    this.dirty = true
  }

  /** Which meteor showers are active right now, each with a rough current rate. */
  setMeteorShowers(rows: { shower: Shower; rateNow: number }[]): void {
    if (!this.meteors) {
      this.meteors = new MeteorRadiantLayer()
      this.scene.add(this.meteors.group)
    }
    this.meteors.setActive(rows)
    this.dirty = true
  }

  /** Which showers' debris streams to draw along their parent orbit (independent of any observer
   * location, unlike setMeteorShowers' radiants): whichever have their active date range covering the
   * scene's current date and a resolved parent body among data.bodies. Remembered and re-applied after
   * setOrbits, in case the orbit data (fetched separately, over the network) arrives afterwards. */
  setMeteorStreamShowers(showers: Shower[]): void {
    this.meteorStreamShowers = showers
    this.refreshMeteorStreams()
  }

  private refreshMeteorStreams(): void {
    if (!this.meteorStreamShowers.length) {
      this.meteorStream?.setActive([], () => null)
      return
    }
    if (!this.meteorStream) {
      this.meteorStream = new MeteorStreamLayer(this.smallGroup)
    }
    this.meteorStream.setActive(this.meteorStreamShowers, (code) => {
      const id = SHOWER_PARENT[code]
      return id ? (this.entities.get(id)?.elements ?? null) : null
    })
    this.meteorStreamJd = NaN // force the next updatePositions to place the new/changed streams
    this.dirty = true
  }

  /** The currently-relevant eclipse window (if any), used to place its shadow decal each frame. */
  setEclipseWindow(win: { kind: 'solar' | 'lunar'; startMs: number; peakMs: number; endMs: number; magnitude: number } | null): void {
    this.eclipseWindow = win
    if (!win) {
      this.eclipse?.hideSolar()
      this.eclipse?.hideLunar()
    }
    this.dirty = true
  }

  private ensureEclipse(): EclipseShadowLayer | null {
    if (this.eclipse) return this.eclipse
    const earth = this.entities.get('earth')
    const moon = this.entities.get('moon')
    if (!earth || !moon) return null
    this.eclipse = new EclipseShadowLayer(earth.mesh, moon.mesh)
    return this.eclipse
  }

  /** The Van Allen radiation belts: a schematic visual, tilted to the real geomagnetic dipole. */
  setRadiationBelts(on: boolean): void {
    this.beltsOn = on
    if (on && !this.belts) {
      const earth = this.entities.get('earth')
      if (earth) this.belts = new RadiationBeltLayer(earth.mesh)
    }
    this.belts?.setVisible(on)
    this.dirty = true
  }

  /** NOAA's live >=2 MeV electron flux at geostationary orbit, feeding the outer belt's brightness. */
  setElectronFlux(flux: number | null): void {
    this.electronFlux = flux
  }

  /** Global ionospheric TEC (CODE), a translucent shell above the Earth. */
  setIonosphereGrid(g: IonosphereGrid): void {
    const earth = this.entities.get('earth')
    if (!earth) return
    if (!this.ionosphere) this.ionosphere = new IonosphereLayer(earth.mesh)
    this.ionosphere.setGrid(g)
    this.dirty = true
  }

  setIonosphereVisible(on: boolean): void {
    this.ionosphere?.setVisible(on)
    this.dirty = true
  }

  /** Fly to the Sun and look at it from the Earth's side, the way SDO and SOHO see it (the corona sheets are exact from here). */
  viewSunFromEarth(radii = 7): void {
    const earth = this.entities.get('earth')
    if (!earth) return
    this.focusOn('sun', { distance: radii * (695_700 / KM_PER_AU), direction: [...earth.pos] })
  }

  /** The Sun and the Earth's orbit together, from a little above the plane of the planets: where the CMEs can be seen crossing to the Earth. */
  viewSunAndEarth(): void {
    const earth = this.entities.get('earth')
    if (!earth) return
    const side = new THREE.Vector3(0, 0, 1).cross(new THREE.Vector3(...earth.pos))
    if (side.lengthSq() < 1e-12) side.set(1, 0, 0)
    const dir = side.normalize().multiplyScalar(0.9).add(new THREE.Vector3(0, 0, 0.45))
    this.focusOn('sun', { distance: 2.4, direction: [dir.x, dir.y, dir.z] })
  }

  private layoutSun(cam: THREE.PerspectiveCamera): void {
    const layer = this.sunLayer
    const sun = this.entities.get('sun')
    const earth = this.entities.get('earth')
    if (!layer || !sun || !earth) return
    layer.group.visible = sun.group.position.distanceTo(cam.position) < 2000
    if (layer.group.visible) layer.update(cam, earth.pos, this.dateMs)
  }

  // ---------- lightning ----------

  private ensureLightning(): LightningLayer | null {
    if (this.lightning) return this.lightning
    const earth = this.entities.get('earth')
    if (!earth) return null
    const layer = new LightningLayer(earth.mesh, this.dot)
    layer.windowMin = this.lightningWindow
    layer.mode = this.lightningMode
    layer.visible = this.lightningOn
    this.lightning = layer
    return layer
  }

  /** Show or hide live lightning on the Earth. */
  setLightning(on: boolean): void {
    this.lightningOn = on
    const layer = on ? this.ensureLightning() : this.lightning
    if (layer) layer.visible = on
    if (!on && this.strikeSelected) {
      this.strikeSelected = false
      this.lightning?.deselect()
      this.cb.onStrikeSelect?.(null)
    }
    this.dirty = true
  }

  /** How long a strike stays on the globe (minutes) and whether the flashes, the heat map or both are drawn (auto: by how close you are). */
  setLightningOptions(o: { windowMin?: number; mode?: LightningMode }): void {
    if (o.windowMin !== undefined) this.lightningWindow = o.windowMin
    if (o.mode !== undefined) this.lightningMode = o.mode
    if (this.lightning) {
      this.lightning.windowMin = this.lightningWindow
      this.lightning.mode = this.lightningMode
    }
    this.dirty = true
  }

  /** New strikes from the feed (`reset`: empty the globe first). */
  addStrikes(rows: readonly Strike[], reset = false): void {
    const layer = this.ensureLightning()
    if (!layer) return
    if (reset) layer.clear()
    layer.add(rows)
    this.dirty = true
  }

  private layoutLightning(cam: THREE.PerspectiveCamera): void {
    const layer = this.lightning
    const earth = this.entities.get('earth')
    if (!layer || !earth) return
    const alt = earth.group.position.distanceTo(cam.position) / earth.radiusAU - 1
    // strikes are real-time: they only mean something while the scene shows about now
    const minutes = Math.abs(this.dateMs - Date.now()) / 60_000
    const relevance = earth.mesh.visible ? 1 - ramp(minutes, 5, 30) : 0
    if (layer.update(alt, relevance, this.renderer.getPixelRatio())) this.dirty = true // a flash is in progress
  }

  // ---------- web traffic ----------

  private ensureTraffic(): TrafficLayer | null {
    if (this.traffic) return this.traffic
    const earth = this.entities.get('earth')
    if (!earth) return null
    const layer = new TrafficLayer(earth.mesh)
    layer.visible = this.trafficOn
    this.traffic = layer
    this.refreshTraffic()
    return layer
  }

  private refreshTraffic(): void {
    this.traffic?.setData(this.trafficPlaces, this.trafficHome)
    this.dirty = true
  }

  /** Show or hide the arcs from your location to the places this PC's web traffic goes. */
  setTraffic(on: boolean): void {
    this.trafficOn = on
    const layer = on ? this.ensureTraffic() : this.traffic
    if (layer) layer.visible = on
    if (!on) {
      this.trafficPlaces = []
      this.traffic?.setData([], null)
      if (this.trafficSelected) {
        this.trafficSelected = false
        this.cb.onTrafficSelect?.(null)
      }
    }
    this.dirty = true
  }

  /** Where the arcs start: the observer's saved place (null: dots only). Independent of the green dot's switch. */
  setTrafficHome(p: { latDeg: number; lonDeg: number } | null): void {
    this.trafficHome = p
    this.refreshTraffic()
  }

  /** The destinations from the backend's latest reading. */
  setTrafficPlaces(places: readonly TrafficPlace[]): void {
    this.trafficPlaces = places
    if (this.trafficOn) this.ensureTraffic()
    this.refreshTraffic()
  }

  /** Ring one destination (null: none), for when it is picked from a list instead of the globe. */
  selectTraffic(id: string | null): void {
    this.trafficSelected = id !== null
    this.traffic?.select(id)
    this.dirty = true
  }

  private layoutTraffic(cam: THREE.PerspectiveCamera): void {
    const layer = this.traffic
    const earth = this.entities.get('earth')
    if (!layer || !earth) return
    // real time only: it means nothing on a scene dated far from now
    const minutes = Math.abs(this.dateMs - Date.now()) / 60_000
    const relevance = earth.mesh.visible ? 1 - ramp(minutes, 5, 30) : 0
    if (layer.update(relevance, this.renderer.getPixelRatio(), { x: this.container.clientWidth || 1, y: this.container.clientHeight || 1 })) this.dirty = true
  }

  // ---------- wind and sea currents ----------

  private ensureFlow(kind: FlowKind): FlowParticles | null {
    if (this.flow[kind]) return this.flow[kind]
    const earth = this.entities.get('earth')
    if (!earth) return null
    const layer = new FlowParticles(
      earth.mesh,
      kind === 'wind'
        ? { count: 9000, radius: 1.008, timeScale: 50_000, speedMax: speedMax('wind'), trail: 10, life: [1.8, 3.8], opacity: 0.95 }
        : { count: 8000, radius: 1.0035, timeScale: 800_000, speedMax: speedMax('currents'), trail: 10, life: [2.0, 4.0], opacity: 0.95 }
    )
    layer.visible = this.flowOn[kind]
    this.flow[kind] = layer
    return layer
  }

  /** Show or hide the moving wind or sea currents on the Earth. */
  setFlow(kind: FlowKind, on: boolean): void {
    this.flowOn[kind] = on
    const layer = on ? this.ensureFlow(kind) : this.flow[kind]
    if (layer) layer.visible = on
    if (!on && !this.flowOn.wind && !this.flowOn.currents) this.setFlowPick(null)
    this.dirty = true
  }

  /** The velocity picture to move the streaks along (null: none for this date). `level` sets the pace and the colour scale of the wind. */
  setFlowGrid(kind: FlowKind, grid: FlowGrid | null, level: WindLevel = '10m'): void {
    const layer = grid ? this.ensureFlow(kind) : this.flow[kind]
    if (!layer) return
    layer.setSpeedMax(speedMax(kind, level))
    layer.timeFactor = kind === 'wind' ? WIND_TIME_SCALE[level] : 1
    layer.setGrid(grid)
    this.dirty = true
  }

  /** A marker where the readout is (null: none). */
  setFlowPick(p: { latDeg: number; lonDeg: number } | null): void {
    const earth = this.entities.get('earth')
    if (!p || !earth) {
      if (this.flowMarker) this.flowMarker.visible = false
      this.dirty = true
      return
    }
    if (!this.flowMarker) {
      this.flowMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }))
      this.flowMarker.scale.setScalar(0.03)
      this.flowMarker.renderOrder = 12
      earth.mesh.add(this.flowMarker)
    }
    const la = p.latDeg * DEG
    const lo = p.lonDeg * DEG
    this.flowMarker.position.set(1.009 * Math.cos(la) * Math.cos(lo), 1.009 * Math.cos(la) * Math.sin(lo), 1.009 * Math.sin(la))
    this.flowMarker.visible = true
    this.dirty = true
  }

  private layoutFlow(cam: THREE.PerspectiveCamera, now: number): void {
    const wind = this.flow.wind
    const cur = this.flow.currents
    const earth = this.entities.get('earth')
    if (!earth || (!wind && !cur)) return
    const dt = this.flowLastAt ? Math.min(0.1, (now - this.flowLastAt) / 1000) : 0.016
    this.flowLastAt = now
    const local = earth.mesh.worldToLocal(this.tmpV.copy(cam.position))
    const camRe = local.length()
    this.flowDir.copy(local).normalize()
    const fade = earth.mesh.visible ? 1 - ramp(camRe, 25, 70) : 0
    wind?.update(dt, this.flowDir, camRe, fade)
    cur?.update(dt, this.flowDir, camRe, fade)
    if (this.flowMarker) this.flowMarker.visible = this.flowMarker.visible && fade > 0.02
  }

  /** Latitude and longitude of the point of the Earth under a pixel (null: the click missed the Earth). */
  private pickEarthLatLon(px: number, py: number, w: number, h: number): { latDeg: number; lonDeg: number } | null {
    const earth = this.entities.get('earth')
    if (!earth || !earth.mesh.visible) return null
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), this.camera)
    const hit = ray.ray.intersectSphere(new THREE.Sphere(earth.group.position.clone(), earth.radiusAU), new THREE.Vector3())
    if (!hit) return null
    const local = earth.mesh.worldToLocal(hit)
    const len = local.length() || 1
    return { latDeg: Math.asin(Math.max(-1, Math.min(1, local.z / len))) / DEG, lonDeg: Math.atan2(local.y, local.x) / DEG }
  }

  // ---------- ships ----------

  /** Show these ships on the Earth (null removes them). A new snapshot replaces the old one; the selected and followed ships are found again by MMSI. */
  setShips(rows: Ship[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows?.length || !earth) {
      this.ships?.dispose()
      this.ships = null
      if (this.shipSelected !== null) this.selectShip(null)
      if (this.shipFollow !== null) this.followShip(null)
      this.dirty = true
      return
    }
    if (!this.ships) {
      if (!this.shipIcon) this.shipIcon = makeShipIcon()
      this.ships = new ShipLayer(earth.mesh, this.shipIcon)
    }
    this.ships.setRows(rows)
    if (this.shipSelected !== null && !this.ships.index.has(this.shipSelected)) this.selectShip(null)
    if (this.shipFollow !== null && !this.ships.index.has(this.shipFollow)) {
      this.followShip(null)
      this.cb.onShipLost?.()
    }
    this.dirty = true
  }

  /** Categories (ids) of ships not to draw. */
  setShipHidden(hidden: Set<number>): void {
    this.ships?.setHidden(hidden)
    this.dirty = true
  }

  /** Ring one ship (null: none). `name` is the label next to it. */
  selectShip(mmsi: number | null, name?: string): void {
    this.shipSelected = mmsi
    this.shipLabelText = name ?? ''
    if (mmsi === null && this.shipMarker) this.shipMarker.visible = false
    this.dirty = true
  }

  setShipLabel(text: string): void {
    this.shipLabelText = text
    this.dirty = true
  }

  /** The ship's position now, in AU from the Sun (ecliptic): the Earth's centre plus the ship carried round by the Earth's spin. */
  private shipVector(): Vec3 | null {
    const earth = this.entities.get('earth')
    const layer = this.ships
    if (!earth || !layer || this.shipFollow === null || !earth.rot) return null
    const i = layer.index.get(this.shipFollow)
    if (i === undefined) return null
    const q = advanceShip(layer.rows[i], Date.now())
    const la = q.latDeg * DEG
    const lo = q.lonDeg * DEG
    const v = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).multiplyScalar(earth.radiusAU * 1.0012)
    this.tmpM.makeBasis(new THREE.Vector3(...earth.rot.prime), new THREE.Vector3(...earth.rot.east), new THREE.Vector3(...earth.rot.north))
    v.applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(this.tmpM))
    return [earth.pos[0] + v.x, earth.pos[1] + v.y, earth.pos[2] + v.z]
  }

  /** Fly to a ship and stay with it as it sails (null: fly back out to the whole Earth). */
  followShip(mmsi: number | null): void {
    if (mmsi === null) {
      if (this.shipFollow !== null) this.focusOn('earth') // clears the follow and flies out
      return
    }
    const earth = this.entities.get('earth')
    if (!this.ships?.index.has(mmsi) || !earth) return
    if (this.mode === 'surface') this.leaveSurface()
    if (this.mode === 'fly') this.exitFly()
    this.dropHomeFollow()
    this.satFollow = null
    this.shipFollow = mmsi
    this.focusId = 'earth'
    this.controls.minDistance = 3e-8 // about 4.5 km
    this.camera.near = 1e-9
    this.camera.updateProjectionMatrix()
    const v = this.shipVector()
    const radial = v ? new THREE.Vector3(v[0] - earth.pos[0], v[1] - earth.pos[1], v[2] - earth.pos[2]).normalize() : new THREE.Vector3(0, 0, 1)
    const side = new THREE.Vector3(0, 0, 1).cross(radial)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    const toDir = radial.clone().multiplyScalar(0.8).add(side.normalize().multiplyScalar(0.6)).normalize()
    const fromDir = this.camera.position.clone().normalize()
    const fromDist = this.camera.position.length()
    const toDist = 60 / KM_PER_AU
    this.flight = {
      start: performance.now(),
      dur: Math.min(4800, FLIGHT_MS + 260 * Math.abs(Math.log10(toDist / fromDist))),
      fromOrigin: [...this.origin],
      fromDist,
      toDist,
      fromDir,
      toDir
    }
    this.controls.enabled = false
    this.selectShip(mmsi)
    this.dirty = true
  }

  followedShip(): number | null {
    return this.shipFollow
  }

  private layoutShips(cam: THREE.PerspectiveCamera): void {
    const layer = this.ships
    const earth = this.entities.get('earth')
    if (!layer || !earth) return
    const hours = Math.abs(this.dateMs - Date.now()) / 3_600_000
    const dist = earth.group.position.distanceTo(cam.position)
    layer.layout(dist, earth.radiusAU, hours, this.renderer.getPixelRatio(), (this.container.clientWidth || 1) / (this.container.clientHeight || 1), ramp)
    if (layer.points.visible) layer.advance()
    const mmsi = this.shipSelected
    const i = mmsi === null ? undefined : layer.index.get(mmsi)
    const show = i !== undefined && layer.opacity > 0.05
    if (show && !this.shipMarker) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.55 }))
      m.scale.setScalar(0.045)
      m.renderOrder = 3
      const div = document.createElement('div')
      div.style.cssText = 'padding-left:14px;font:bold 11px/1.2 system-ui,sans-serif;color:#cfe8ff;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none'
      const label = new CSS2DObject(div)
      m.add(label)
      earth.mesh.add(m)
      this.shipMarker = m
      this.shipLabel = label
    }
    if (!this.shipMarker || !this.shipLabel) return
    this.shipMarker.visible = this.shipLabel.visible = show
    if (show && i !== undefined) {
      layer.local(i, this.shipMarker.position)
      const want = this.shipLabelText || String(mmsi)
      if (this.shipLabel.element.textContent !== want) this.shipLabel.element.textContent = want
    }
  }

  // ---------- earthquakes, volcanoes and heat spots ----------

  /** Show these earthquakes on the Earth (null removes them). The magnitude and age limits are set with setQuakeFilter. */
  setQuakes(rows: Quake[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows || !earth) {
      this.quakes?.dispose()
      this.quakes = null
      if (this.hazardSel?.kind === 'quake') this.selectHazard(null)
      this.dirty = true
      return
    }
    if (!this.quakes) {
      this.quakes = new QuakeLayer(earth.mesh)
      this.quakes.minMag = this.quakeOptions.minMag
      this.quakes.hours = this.quakeOptions.hours
    }
    this.quakes.setRows(rows)
    if (this.hazardSel?.kind === 'quake' && !rows.some((q) => q.id === this.hazardSel!.key)) this.selectHazard(null)
    this.dirty = true
  }

  setQuakeFilter(o: { minMag: number; hours: number }): void {
    this.quakeOptions = o
    if (this.quakes) {
      this.quakes.minMag = o.minMag
      this.quakes.hours = o.hours
    }
    this.dirty = true
  }

  setVolcanoes(rows: Volcano[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows || !earth) {
      this.volcanoes?.dispose()
      this.volcanoes = null
      if (this.hazardSel?.kind === 'volcano') this.selectHazard(null)
      this.dirty = true
      return
    }
    if (!this.volcanoes) {
      this.volcanoes = new VolcanoLayer(earth.mesh)
      this.volcanoes.showAll = this.volcanoShowAll
    }
    this.volcanoes.setRows(rows)
    this.dirty = true
  }

  /** true: every volcano as a small faint triangle; false: only those with activity now. */
  setVolcanoShowAll(all: boolean): void {
    this.volcanoShowAll = all
    if (this.volcanoes) this.volcanoes.showAll = all
    this.dirty = true
  }

  setHeat(rows: HeatSpot[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows || !earth) {
      this.heat?.dispose()
      this.heat = null
      this.dirty = true
      return
    }
    if (!this.heat) this.heat = new HeatLayer(earth.mesh)
    this.heat.setRows(rows)
    this.dirty = true
  }

  setLaunches(rows: Launch[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows || !earth) {
      this.launches?.dispose()
      this.launches = null
      if (this.launchSel !== null) {
        this.launchSel = null
        this.cb.onLaunchSelect?.(null)
      }
      this.dirty = true
      return
    }
    if (!this.launches) this.launches = new LaunchLayer(earth.mesh)
    this.launches.setRows(rows, Date.now())
    if (this.launchSel !== null && !rows.some((l) => l.id === this.launchSel)) {
      this.launchSel = null
      this.cb.onLaunchSelect?.(null)
    }
    this.dirty = true
  }

  setAqiStations(rows: AqiStation[] | null): void {
    const earth = this.entities.get('earth')
    if (!rows || !earth) {
      this.aqi?.dispose()
      this.aqi = null
      if (this.aqiSel !== null) {
        this.aqiSel = null
        this.cb.onAqiSelect?.(null)
      }
      this.dirty = true
      return
    }
    if (!this.aqi) this.aqi = new AqiLayer(earth.mesh)
    this.aqi.setRows(rows)
    if (this.aqiSel !== null && !rows.some((s) => s.id === this.aqiSel)) {
      this.aqiSel = null
      this.cb.onAqiSelect?.(null)
    }
    this.dirty = true
  }

  /** Ring one earthquake (by id) or volcano (by number); null: none. The label is set with setHazardLabel. */
  selectHazard(kind: 'quake' | 'volcano' | null, key?: string | number): void {
    this.hazardSel = kind && key !== undefined ? { kind, key } : null
    this.hazardLabelText = ''
    if (!this.hazardSel && this.hazardMarker) this.hazardMarker.visible = false
    this.dirty = true
  }

  setHazardLabel(text: string): void {
    this.hazardLabelText = text
    this.dirty = true
  }

  /** Look down on a place on the Earth from `altitudeKm`. */
  viewLatLon(latDeg: number, lonDeg: number, altitudeKm = 2500): void {
    const earth = this.entities.get('earth')
    if (!earth) return
    const la = latDeg * DEG
    const lo = lonDeg * DEG
    // the Earth's orientation now, from its rotation data (its mesh only takes it on the first drawn frame, which may not have happened yet)
    const q = new THREE.Quaternion()
    if (earth.rot) q.setFromRotationMatrix(this.tmpM.makeBasis(new THREE.Vector3(...earth.rot.prime), new THREE.Vector3(...earth.rot.east), new THREE.Vector3(...earth.rot.north)))
    else q.copy(earth.mesh.quaternion)
    const dir = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).applyQuaternion(q)
    this.focusOn('earth', { distance: earth.radiusAU + altitudeKm / KM_PER_AU, direction: [dir.x, dir.y, dir.z] })
  }

  // ---------- sharp close-up imagery ----------

  private onEarthWheel = (e: WheelEvent): void => {
    if (this.focusId !== 'earth' || this.mode !== 'orbit' || !this.controls.enabled || this.flight || this.satFollow || this.shipFollow !== null) return
    const earth = this.entities.get('earth')
    if (!earth) return
    const R = earth.radiusAU
    const dist = this.camera.position.length()
    const alt = dist - R
    const zoomIn = e.deltaY < 0
    if (alt > 2.5 * R || (!zoomIn && alt * 1.1 > 2.5 * R)) return // far out: the ordinary zoom
    e.preventDefault()
    e.stopPropagation()
    const scale = Math.pow(0.95, (e.shiftKey ? 6 : 1.3) * Math.min(Math.abs(e.deltaY), 400) * 0.01)
    const min = EARTH_MIN_ALT_KM / KM_PER_AU
    const next = Math.max(min, zoomIn ? alt * scale : alt / scale)
    this.camera.position.multiplyScalar((R + next) / dist)
    this.dirty = true
  }

  private ensureDetail(): EarthDetail | null {
    if (this.detail) return this.detail
    const earth = this.entities.get('earth')
    if (!earth) return null
    this.detail = new EarthDetail(
      earth.mesh,
      this.sunView,
      this.earthFull,
      (z, x, y) => `http://127.0.0.1:8765/deepspace/earth-tile/${z}/${x}/${y}`,
      this.renderer.capabilities.getMaxAnisotropy()
    )
    this.detail.maxZ = this.plan.earthMapLevel === 0 ? 11 : 13
    return this.detail
  }

  private layoutDetail(cam: THREE.PerspectiveCamera): void {
    const earth = this.entities.get('earth')
    if (!earth) return
    const R = earth.radiusAU
    const alt = earth.group.position.distanceTo(cam.position) / R - 1
    // dragging turns the globe by the distance the ground moves under the cursor, not by a fixed angle: slow near the ground
    const near = alt >= 2.5 ? 1 : Math.min(1, Math.max(0.0006, 0.22 * alt + 0.78 * smooth01((alt - 1) / 1.5)))
    this.controls.rotateSpeed = this.focusId === 'earth' && this.mode === 'orbit' ? 0.7 * near : 0.7
    if (alt > 0.7 || !earth.mesh.visible) {
      if (this.detail) this.detail.group.visible = false
      return
    }
    const d = this.ensureDetail()
    if (!d) return
    const local = earth.mesh.worldToLocal(this.tmpV.copy(cam.position))
    const H = this.container.clientHeight || 1
    const tanY = Math.tan((cam.fov * DEG) / 2)
    d.update(local, earth.mesh.matrixWorld, cam.matrixWorldInverse, R, H / 2 / tanY, tanY * cam.aspect, tanY)
    if (d.changed) {
      d.changed = false
      this.dirty = true
    }
  }

  private layoutHazards(cam: THREE.PerspectiveCamera): void {
    const earth = this.entities.get('earth')
    if (!earth || (!this.quakes && !this.volcanoes && !this.heat && !this.launches && !this.aqi)) return
    const hours = Math.abs(this.dateMs - Date.now()) / 3_600_000
    const dist = earth.group.position.distanceTo(cam.position)
    const pr = this.renderer.getPixelRatio()
    this.quakes?.layout(dist, hours, pr)
    this.volcanoes?.layout(dist, hours, pr)
    this.heat?.layout(dist, hours, pr)
    this.launches?.layout(dist, pr, performance.now() / 1000)
    this.aqi?.layout(dist, pr)
    const sel = this.hazardSel
    let where: THREE.Vector3 | null = null
    if (sel?.kind === 'quake' && this.quakes?.points.visible) {
      const i = this.quakes.rows.findIndex((q) => q.id === sel.key)
      if (i >= 0) where = this.quakes.local(i)
    } else if (sel?.kind === 'volcano' && this.volcanoes?.points.visible) {
      const i = this.volcanoes.rows.findIndex((v) => v.vnum === sel.key)
      if (i >= 0) where = this.volcanoes.local(i)
    }
    if (where && !this.hazardMarker) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.5 }))
      m.scale.setScalar(0.055)
      m.renderOrder = 3
      const div = document.createElement('div')
      div.style.cssText = 'padding-left:16px;font:bold 11px/1.2 system-ui,sans-serif;color:#ffe9c4;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none'
      const label = new CSS2DObject(div)
      m.add(label)
      earth.mesh.add(m)
      this.hazardMarker = m
      this.hazardLabel = label
    }
    if (!this.hazardMarker || !this.hazardLabel) return
    this.hazardMarker.visible = this.hazardLabel.visible = !!where
    if (where) {
      this.hazardMarker.position.copy(where)
      if (this.hazardLabel.element.textContent !== this.hazardLabelText) this.hazardLabel.element.textContent = this.hazardLabelText
    }
  }

  private pickHazard(px: number, py: number, w: number, h: number): { kind: 'quake' | 'volcano'; index: number } | null {
    const earth = this.entities.get('earth')
    if (!earth) return null
    const args = [px, py, w, h, this.camera, earth.group.position, earth.radiusAU, earth.mesh.matrixWorld] as const
    const v = this.volcanoes?.pick(...args) ?? null
    if (v !== null) return { kind: 'volcano', index: v }
    const q = this.quakes?.pick(...args) ?? null
    return q !== null ? { kind: 'quake', index: q } : null
  }

  // ---------- cities ----------

  /** The world's cities (rows: name, country, latitude, longitude, population, capital?), biggest first. Their names appear as you come down to the Earth. */
  setCities(rows: (string | number)[][] | null, townMode = false): void {
    if (this.cities) {
      this.cities.points.removeFromParent()
      this.cities.points.geometry.dispose()
      ;(this.cities.points.material as THREE.Material).dispose()
      for (const l of this.cities.pool) l.obj.removeFromParent()
      this.cities = null
    }
    const earth = this.entities.get('earth')
    this.dirty = true
    if (!rows?.length || !earth) return
    const n = rows.length
    const unit = new Float32Array(n * 3)
    const pop = new Float32Array(n)
    const capital = new Uint8Array(n)
    const names: string[] = []
    const countries: string[] = []
    const regions: string[] = []
    const pos = new Float32Array(n * 3)
    rows.forEach((r, i) => {
      const la = Number(r[2]) * DEG
      const lo = Number(r[3]) * DEG
      unit[3 * i] = Math.cos(la) * Math.cos(lo)
      unit[3 * i + 1] = Math.cos(la) * Math.sin(lo)
      unit[3 * i + 2] = Math.sin(la)
      pos[3 * i] = unit[3 * i] * 1.0006
      pos[3 * i + 1] = unit[3 * i + 1] * 1.0006
      pos[3 * i + 2] = unit[3 * i + 2] * 1.0006
      names.push(String(r[0]))
      countries.push(String(r[1]))
      regions.push(r[6] === undefined ? '' : String(r[6]))
      pop[i] = Number(r[4])
      capital[i] = Number(r[5]) ? 1 : 0
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setDrawRange(0, 0)
    const mat = new THREE.PointsMaterial({ size: 3.4, sizeAttenuation: false, color: 0xfff1b8, map: this.dot, transparent: true, depthWrite: false, opacity: 0, alphaTest: 0.01 })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    points.renderOrder = 3
    earth.mesh.add(points)
    const pool: CityLabel[] = []
    for (let k = 0; k < MAX_CITY_LABELS; k++) {
      const el = document.createElement('div')
      el.style.cssText = 'padding-left:9px;font:11px/1.2 system-ui,sans-serif;color:#fdf3cf;text-shadow:0 0 3px #000,0 0 3px #000,0 0 5px #000;white-space:nowrap;pointer-events:none'
      const obj = new CSS2DObject(el)
      obj.visible = false
      earth.mesh.add(obj)
      pool.push({ obj, el, idx: -1 })
    }
    this.cities = { names, countries, regions, townMode, unit, pop, capital, n, points, pool, at: 0, key: '' }
  }

  setCitiesVisible(on: boolean): void {
    this.citiesOn = on
    this.dirty = true
  }

  /** What is the smallest city worth a dot and a name at this height (in Earth radii above the surface)? */
  private cityThreshold(alt: number): number {
    if (alt > 2.5) return Infinity
    if (alt > 1.5) return 8e6
    if (alt > 0.9) return 3e6
    if (alt > 0.5) return 1.2e6
    if (alt > 0.25) return 4e5
    if (alt > 0.1) return 1.5e5
    if (alt > 0.04) return 5e4
    // with the towns of the world loaded, the smaller ones come in as you get lower still
    if (this.cities?.townMode) {
      if (alt > 0.02) return 2e4
      if (alt > 0.01) return 8e3
      if (alt > 0.004) return 3e3
    }
    return 0
  }

  /** The town or city under this pixel (the nearest of those within a few pixels), if its dot is showing. */
  private pickTown(px: number, py: number, width: number, height: number): TownHit | null {
    const c = this.cities
    const earth = this.entities.get('earth')
    if (!c || !earth || !this.citiesOn || !c.points.visible) return null
    const count = c.points.geometry.drawRange.count
    const distR = earth.group.position.distanceTo(this.camera.position) / earth.radiusAU
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(this.camera.position)).normalize()
    const horizon = nearSide(distR)
    const v = this.tmpV2
    let best = -1
    let bestD = 12 // pixels
    for (let i = 0; i < count; i++) {
      const ux = c.unit[3 * i]
      const uy = c.unit[3 * i + 1]
      const uz = c.unit[3 * i + 2]
      if (ux * camLocal.x + uy * camLocal.y + uz * camLocal.z < horizon) continue
      v.set(ux * 1.0006, uy * 1.0006, uz * 1.0006).applyMatrix4(earth.mesh.matrixWorld).project(this.camera)
      if (v.z > 1 || v.z < -1) continue
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      // nearer wins; between two about as near, the bigger place (the list is biggest-first, so the earlier)
      if (d < bestD - (best >= 0 ? 2 : 0)) {
        best = i
        bestD = d
      }
    }
    if (best < 0) return null
    return {
      name: c.names[best],
      country: c.countries[best],
      region: c.regions[best],
      population: c.pop[best],
      latDeg: Math.asin(Math.max(-1, Math.min(1, c.unit[3 * best + 2]))) / DEG,
      lonDeg: Math.atan2(c.unit[3 * best + 1], c.unit[3 * best]) / DEG,
      capital: !!c.capital[best]
    }
  }

  // ---------- my places ----------

  /** The user's own named places (null or empty removes them). */
  setMyPlaces(list: PlaceMark[] | null): void {
    const old = this.myPlaces
    if (old) {
      old.points.removeFromParent()
      old.points.geometry.dispose()
      ;(old.points.material as THREE.Material).dispose()
      for (const l of old.labels) {
        l.obj.removeFromParent()
        l.el.remove()
      }
      this.myPlaces = null
    }
    this.dirty = true
    const earth = this.entities.get('earth')
    if (!list?.length || !earth) return
    const n = list.length
    const unit = new Float32Array(n * 3)
    const pos = new Float32Array(n * 3)
    list.forEach((p, i) => {
      const la = p.lat * DEG
      const lo = p.lon * DEG
      unit[3 * i] = Math.cos(la) * Math.cos(lo)
      unit[3 * i + 1] = Math.cos(la) * Math.sin(lo)
      unit[3 * i + 2] = Math.sin(la)
      for (let k = 0; k < 3; k++) pos[3 * i + k] = unit[3 * i + k] * 1.0009
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, color: 0x4dd8ff, map: this.dot, transparent: true, depthWrite: false, opacity: 0.95, alphaTest: 0.01 })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    points.renderOrder = 7
    earth.mesh.add(points)
    const labels = list.map((p, i) => {
      const el = document.createElement('div')
      el.textContent = p.name
      el.style.cssText = 'padding-left:10px;font:bold 11px/1.2 system-ui,sans-serif;color:#9eeaff;text-shadow:0 0 3px #000,0 0 3px #000,0 0 5px #000;white-space:nowrap;pointer-events:none;user-select:none'
      const obj = new CSS2DObject(el)
      obj.position.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2])
      earth.mesh.add(obj)
      return { obj, el }
    })
    this.myPlaces = { list, unit, points, labels }
  }

  private layoutMyPlaces(cam: THREE.PerspectiveCamera): void {
    const mp = this.myPlaces
    const earth = this.entities.get('earth')
    if (!mp || !earth) return
    const distR = earth.group.position.distanceTo(cam.position) / earth.radiusAU
    const fade = earth.mesh.visible ? 1 - ramp(distR - 1, 20, 50) : 0
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(cam.position)).normalize()
    const horizon = nearSide(distR)
    mp.points.visible = fade > 0.02
    ;(mp.points.material as THREE.PointsMaterial).opacity = 0.95 * fade
    mp.list.forEach((_, i) => {
      const facing = mp.unit[3 * i] * camLocal.x + mp.unit[3 * i + 1] * camLocal.y + mp.unit[3 * i + 2] * camLocal.z >= horizon
      const l = mp.labels[i]
      l.obj.visible = fade > 0.02 && facing && distR - 1 < 12
      l.el.style.opacity = fade.toFixed(2)
    })
  }

  private pickMyPlace(px: number, py: number, width: number, height: number): string | null {
    const mp = this.myPlaces
    const earth = this.entities.get('earth')
    if (!mp || !earth || !mp.points.visible) return null
    const distR = earth.group.position.distanceTo(this.camera.position) / earth.radiusAU
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(this.camera.position)).normalize()
    const horizon = nearSide(distR)
    const v = this.tmpV2
    let best: string | null = null
    let bestD = 14
    mp.list.forEach((p, i) => {
      if (mp.unit[3 * i] * camLocal.x + mp.unit[3 * i + 1] * camLocal.y + mp.unit[3 * i + 2] * camLocal.z < horizon) return
      v.set(mp.unit[3 * i] * 1.0009, mp.unit[3 * i + 1] * 1.0009, mp.unit[3 * i + 2] * 1.0009).applyMatrix4(earth.mesh.matrixWorld).project(this.camera)
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      if (d < bestD) {
        bestD = d
        best = p.id
      }
    })
    return best
  }

  /** While on, the next click on the Earth reports where (for adding a place); the crosshair cursor shows it. */
  setPlacePicking(on: boolean): void {
    this.placePicking = on
    this.renderer.domElement.style.cursor = on ? 'crosshair' : ''
  }

  private layoutCities(cam: THREE.PerspectiveCamera): void {
    const c = this.cities
    const earth = this.entities.get('earth')
    if (!c || !earth) return
    const distR = earth.group.position.distanceTo(cam.position) / earth.radiusAU
    const alt = distR - 1
    const thr = this.citiesOn && earth.mesh.visible ? this.cityThreshold(alt) : Infinity
    const fade = 1 - ramp(alt, 1.8, 2.6)
    ;(c.points.material as THREE.PointsMaterial).opacity = 0.9 * fade
    if (!Number.isFinite(thr)) {
      c.points.visible = false
      for (const l of c.pool) l.obj.visible = false
      return
    }
    // the dots: the list is biggest-first, so "big enough" is a prefix of it
    let count = 0
    while (count < c.n && c.pop[count] >= thr) count++
    c.points.geometry.setDrawRange(0, count)
    c.points.visible = count > 0
    // the names: chosen a few times a second, and again whenever the view has moved
    const now = performance.now()
    const key = `${cam.position.x.toFixed(9)},${cam.position.y.toFixed(9)},${cam.position.z.toFixed(9)},${thr},${this.container.clientWidth}`
    if (key === c.key || now - c.at < 150) return
    c.key = key
    c.at = now
    const W = this.container.clientWidth || 1
    const H = this.container.clientHeight || 1
    const m = earth.mesh.matrixWorld
    const camLocal = earth.mesh.worldToLocal(this.tmpV.copy(cam.position)).normalize()
    const horizon = nearSide(distR) // a city is on the near side when its direction is this close to the camera's
    const v = this.tmpV2
    const placed: { x: number; y: number; w: number; h: number }[] = []
    let used = 0
    for (let i = 0; i < count && used < MAX_CITY_LABELS; i++) {
      const ux = c.unit[3 * i]
      const uy = c.unit[3 * i + 1]
      const uz = c.unit[3 * i + 2]
      if (ux * camLocal.x + uy * camLocal.y + uz * camLocal.z < horizon) continue
      v.set(ux * 1.0006, uy * 1.0006, uz * 1.0006).applyMatrix4(m).project(cam)
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.02) continue
      const sx = ((v.x + 1) / 2) * W
      const sy = ((1 - v.y) / 2) * H
      const w = c.names[i].length * 6.4 + 18
      const box = { x: sx - 2, y: sy - 8, w, h: 16 }
      if (placed.some((q) => box.x < q.x + q.w && box.x + box.w > q.x && box.y < q.y + q.h && box.y + box.h > q.y)) continue
      placed.push(box)
      const slot = c.pool[used++]
      if (slot.idx !== i) {
        slot.idx = i
        slot.obj.position.set(ux * 1.0006, uy * 1.0006, uz * 1.0006)
        slot.el.textContent = c.names[i]
        slot.el.style.fontWeight = c.capital[i] ? '700' : '400'
        slot.el.style.fontSize = c.pop[i] > 5e6 ? '12px' : '11px'
      }
      slot.el.style.opacity = fade.toFixed(2)
      slot.obj.visible = true
    }
    for (let k = used; k < c.pool.length; k++) {
      c.pool[k].obj.visible = false
      c.pool[k].idx = -1
    }
  }

  // ---------- aircraft ----------

  /** Every aircraft icon side by side (white with a dark outline, nose up); each aircraft's colour is applied by the shader. */
  private makePlaneIcon(): THREE.CanvasTexture {
    const cell = 64
    const c = document.createElement('canvas')
    c.width = cell * SHAPE_ORDER.length
    c.height = cell
    const g = c.getContext('2d')!
    SHAPE_ORDER.forEach((shape, i) => {
      g.save()
      g.translate(i * cell + cell / 2, cell / 2)
      g.scale(0.9, 0.9)
      g.lineJoin = 'round'
      g.lineWidth = 4
      g.strokeStyle = 'rgba(20,16,4,0.95)'
      g.fillStyle = '#ffffff'
      const paths = SHAPE_PATHS[shape].map((d) => new Path2D(d))
      for (const p of paths) g.stroke(p)
      for (const p of paths) g.fill(p)
      g.restore()
    })
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }

  /** Show these aircraft on the Earth as little planes pointing the way they fly, at their positions now (null removes them). They are real-time: they fade out when the scene's date is not now. */
  setAircraft(rows: Aircraft[] | null): void {
    if (this.planes) {
      this.planes.points.removeFromParent()
      this.planes.points.geometry.dispose()
      ;(this.planes.points.material as THREE.Material).dispose()
      this.planes = null
    }
    if (this.planeSelected !== null) {
      this.planeSelected = null
      this.cb.onAircraftSelect?.(null)
    }
    this.dirty = true
    const earth = this.entities.get('earth')
    if (!rows?.length || !earth) return
    if (!this.planeIcon) this.planeIcon = this.makePlaneIcon()
    this.planeUniforms.uTex.value = this.planeIcon
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(rows.length * 3)
    const dirs = new Float32Array(rows.length * 3)
    const vis = new Float32Array(rows.length)
    const shp = new Float32Array(rows.length)
    const col = new Float32Array(rows.length * 3)
    rows.forEach((r, i) => {
      shp[i] = Math.max(0, SHAPE_ORDER.indexOf(r.shape))
      // sRGB straight to the screen (the shader writes without colour conversion)
      const hex = parseInt(kindInfo(r.kind).colour.slice(1), 16)
      col[3 * i] = ((hex >> 16) & 255) / 255
      col[3 * i + 1] = ((hex >> 8) & 255) / 255
      col[3 * i + 2] = (hex & 255) / 255
    })
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('dir', new THREE.BufferAttribute(dirs, 3))
    geo.setAttribute('vis', new THREE.BufferAttribute(vis, 1))
    geo.setAttribute('shp', new THREE.BufferAttribute(shp, 1))
    geo.setAttribute('col', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: this.planeUniforms,
      // Each aeroplane is a point sprite turned to face the way it is heading *on the screen*: the vertex shader projects the
      // point and a spot a little way ahead of it along its track, and the fragment shader spins the picture to match.
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uSize;
        uniform float uAspect;
        attribute vec3 dir;
        attribute float vis;
        attribute float shp;
        attribute vec3 col;
        varying vec2 vDir;
        varying float vShape;
        varying vec3 vCol;
        void main() {
          vec4 c1 = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
          vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(position + dir * 0.006, 1.0));
          vec2 d = c2.xy / c2.w - c1.xy / c1.w;
          d.x *= uAspect;
          vDir = length(d) > 1e-9 ? normalize(d) : vec2(0.0, 1.0);
          vShape = shp;
          vCol = col;
          gl_PointSize = uSize * vis;
          gl_Position = vis > 0.5 ? c1 : vec4(2.0, 2.0, 2.0, 1.0); // filtered out: left outside the view
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D uTex;
        uniform float uOpacity;
        varying vec2 vDir;
        varying float vShape;
        varying vec3 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
          vec2 uv = vec2(dot(p, vec2(vDir.y, -vDir.x)), dot(p, vDir)) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          vec4 t = texture2D(uTex, vec2((vShape + uv.x) / ${SHAPE_ORDER.length}.0, uv.y));
          if (t.a < 0.05) discard;
          gl_FragColor = vec4(vCol * t.rgb, t.a * uOpacity);
        }`
    })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    points.renderOrder = 4
    this.ensureSkySurface(earth).add(points)
    this.planes = { rows, points, pos, dirs, vis, at: 0 }
    this.applyAircraftFilter()
    this.updateAircraft(true)
  }

  /** Show only these kinds of aircraft (the others are hidden and cannot be clicked). */
  setAircraftFilter(hidden: ReadonlySet<string>): void {
    this.planeHidden = hidden
    this.applyAircraftFilter()
  }

  private applyAircraftFilter(): void {
    const p = this.planes
    if (!p) return
    for (let i = 0; i < p.rows.length; i++) p.vis[i] = this.planeHidden.has(p.rows[i].kind) ? 0 : 1
    p.points.geometry.attributes.vis.needsUpdate = true
    if (this.planeSelected !== null && this.planeHidden.has(p.rows[this.planeSelected]?.kind)) {
      this.planeSelected = null
      this.cb.onAircraftSelect?.(null)
    }
    this.dirty = true
  }

  /** Move every aircraft along its track to the present moment. About once a second. */
  private updateAircraft(force = false): void {
    const p = this.planes
    const earth = this.entities.get('earth')
    if (!p || !earth) return
    const now = performance.now()
    if (!force && now - p.at < 1000) return
    const t = Date.now()
    const Rm = earth.def.radiusKm * 1000
    const { rows, pos, dirs } = p
    for (let i = 0; i < rows.length; i++) {
      const q = advanceAircraft(rows[i], t)
      const la = q.latDeg * DEG
      const lo = q.lonDeg * DEG
      const r = 1 + (q.altM / Rm) * 6 + 0.0004 // heights are exaggerated a little so they clear the surface
      const cla = Math.cos(la)
      const sla = Math.sin(la)
      const clo = Math.cos(lo)
      const slo = Math.sin(lo)
      pos[3 * i] = r * cla * clo
      pos[3 * i + 1] = r * cla * slo
      pos[3 * i + 2] = r * sla
      // the direction of travel at this spot on the globe: north and east components of the track
      const trk = rows[i].trackDeg * DEG
      const n = Math.cos(trk)
      const e = Math.sin(trk)
      dirs[3 * i] = -sla * clo * n - slo * e
      dirs[3 * i + 1] = -sla * slo * n + clo * e
      dirs[3 * i + 2] = cla * n
    }
    p.points.geometry.attributes.position.needsUpdate = true
    p.points.geometry.attributes.dir.needsUpdate = true
    p.at = now
    this.dirty = true
  }

  private layoutAircraft(cam: THREE.PerspectiveCamera): void {
    const p = this.planes
    const earth = this.entities.get('earth')
    if (!p || !earth) return
    // full strength within ~45,000 km of the Earth, gone by ~300,000 km; and only while the scene is showing (about) now
    const hours = Math.abs(this.dateMs - Date.now()) / 3_600_000
    const distAU = earth.group.position.distanceTo(cam.position)
    this.planeOpacity = (1 - ramp(distAU, 3e-4, 2e-3)) * (1 - ramp(hours, 3, 48))
    const u = this.planeUniforms
    u.uOpacity.value = 0.97 * this.planeOpacity
    // bigger as you come in (about 9 px from 45,000 km, 16 px on top of a city), in device pixels
    const alt = distAU / earth.radiusAU - 1
    u.uSize.value = (10 + 8 * (1 - ramp(alt, 0.05, 3))) * this.renderer.getPixelRatio()
    u.uAspect.value = (this.container.clientWidth || 1) / (this.container.clientHeight || 1)
    p.points.visible = this.planeOpacity > 0.02
    const i = this.planeSelected
    const show = i !== null && this.planeOpacity > 0.05
    if (show && !this.planeMarker) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot, color: 0xffffff, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, opacity: 0.55 }))
      m.scale.setScalar(0.045)
      m.renderOrder = 3
      const div = document.createElement('div')
      div.style.cssText = 'padding-left:14px;font:bold 11px/1.2 system-ui,sans-serif;color:#fff3c4;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none'
      const label = new CSS2DObject(div)
      m.add(label)
      this.ensureSkySurface(earth).add(m)
      this.planeMarker = m
      this.planeLabel = label
    }
    if (!this.planeMarker || !this.planeLabel) return
    this.planeMarker.visible = this.planeLabel.visible = show
    if (show && i !== null) {
      this.planeMarker.position.set(p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2])
      const row = p.rows[i]
      const name = row.callsign || row.hex.toUpperCase()
      if (this.planeLabel.element.textContent !== name) this.planeLabel.element.textContent = name
    }
  }

  /** The aircraft under a click (row index), or null. Ignores ones behind the Earth. */
  private pickAircraft(px: number, py: number, width: number, height: number): number | null {
    const p = this.planes
    const earth = this.entities.get('earth')
    if (!p || !earth || this.planeOpacity < 0.3 || !p.points.visible) return null
    const centre = earth.group.position
    const R = earth.radiusAU
    const cam = this.camera.position
    const v = this.tmpV
    const w = this.tmpV2
    const m = earth.mesh.matrixWorld
    let best: { i: number; d: number } | null = null
    for (let i = 0; i < p.rows.length; i++) {
      if (p.vis[i] < 0.5) continue
      w.set(p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2]).applyMatrix4(m)
      v.copy(w).project(this.camera)
      if (v.z > 1 || v.z < -1) continue
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      if (d > 10 || (best && d >= best.d)) continue
      const dx = w.x - cam.x
      const dy = w.y - cam.y
      const dz = w.z - cam.z
      const len2 = dx * dx + dy * dy + dz * dz
      const t = Math.max(0, Math.min(1, ((centre.x - cam.x) * dx + (centre.y - cam.y) * dy + (centre.z - cam.z) * dz) / len2))
      const cx = cam.x + dx * t - centre.x
      const cy = cam.y + dy * t - centre.y
      const cz = cam.z + dz * t - centre.z
      if (Math.hypot(cx, cy, cz) < R * 0.999) continue // behind the globe
      best = { i, d }
    }
    return best ? best.i : null
  }

  /** Every frame: where the Sun is as seen from the Earth (real, for the scene's date), and how much the live clouds still mean. */
  private updateEarthLight(): void {
    const sun = this.entities.get('sun')
    const earth = this.entities.get('earth')
    if (!sun || !earth) return
    this.sunWorld.value.copy(sun.group.position).sub(earth.group.position).normalize()
    this.camera.updateMatrixWorld()
    this.sunView.value.copy(this.sunWorld.value).transformDirection(this.camera.matrixWorldInverse)
    const nowMs = performance.now()
    if (this.cb.onSun && nowMs - this.sunReportedAt > 1000) {
      this.sunReportedAt = nowMs
      // the Sun's direction in the globe's own frame (+x prime meridian, +z north): its latitude and longitude are where it is overhead
      const local = this.tmpV.copy(this.sunWorld.value).applyQuaternion(earth.mesh.quaternion.clone().invert())
      this.cb.onSun({ latDeg: Math.asin(Math.max(-1, Math.min(1, local.z))) / DEG, lonDeg: Math.atan2(local.y, local.x) / DEG })
    }
    const cm = this.cloudMesh
    if (cm) {
      // the clouds are today's: fade them out as the scene's date moves a day or more away from now
      const hours = Math.abs(this.dateMs - Date.now()) / 3_600_000
      const a = 1 - ramp(hours, 3, 48)
      ;(cm.material as THREE.MeshStandardMaterial).opacity = a
      cm.visible = this.cloudsOn && !!(cm.material as THREE.MeshStandardMaterial).map && a > 0.02
    }
    if (this.beltsOn) this.belts?.update(decimalYear(this.dateMs), this.electronFlux)
    const win = this.eclipseWindow
    const moon = this.entities.get('moon')
    if (win && moon) {
      const t = this.dateMs
      if (t < win.startMs || t > win.endMs) {
        this.eclipse?.hideSolar()
        this.eclipse?.hideLunar()
      } else {
        const eclipseLayer = this.ensureEclipse()
        const inRamp = Math.max(0, win.peakMs - win.startMs) * 0.3
        const outRamp = Math.max(0, win.endMs - win.peakMs) * 0.3
        const alpha = Math.min(smooth(win.startMs, win.startMs + inRamp, t), 1 - smooth(win.endMs - outRamp, win.endMs, t))
        if (win.kind === 'solar') {
          eclipseLayer?.setSolar(sun.group.position, moon.group.position, earth.group.position, earth.radiusAU, 0.1 + 0.3 * win.magnitude, alpha)
          eclipseLayer?.hideLunar()
        } else {
          eclipseLayer?.setLunar(sun.group.position, earth.group.position, moon.group.position, moon.radiusAU, 0.3 + 1.3 * win.magnitude, alpha)
          eclipseLayer?.hideSolar()
        }
      }
    }
  }

  private buildRing(e: Entity): void {
    const g = new THREE.RingGeometry(SATURN_RING.inner, SATURN_RING.outer, 128, 1)
    // RingGeometry's UVs are planar; the ring texture is a radial strip.
    const pos = g.attributes.position
    const uv = g.attributes.uv
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - SATURN_RING.inner) / (SATURN_RING.outer - SATURN_RING.inner), 0.5)
    const ring = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xcbb98a, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }))
    e.mesh.add(ring)
    e.ring = ring
  }

  private applyTexture(e: Entity): void {
    const load = (key: string | undefined, apply: (t: THREE.Texture) => void): void => {
      const url = key ? this.textures[key] : undefined
      if (!url) return
      this.loader.load(
        `http://127.0.0.1:8765${url}`,
        (t) => {
          if (this.disposed) return t.dispose()
          t.colorSpace = THREE.SRGBColorSpace
          t.anisotropy = 4
          apply(t)
          this.dirty = true
        },
        undefined,
        () => undefined // no connection and not cached: keep the plain colour
      )
    }
    load(e.def.texture, (t) => {
      const m = e.mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
      m.map = t
      m.color.set(0xffffff)
      // The night side is not pitch black: a little starlight and airglow shows the continents.
      if (e.def.id === 'earth' && m instanceof THREE.MeshStandardMaterial && !this.earthNightReady) {
        m.emissiveMap = t
        m.emissive.set(this.earthFullTarget ? 0xc8ccd8 : 0x141a26)
      }
      m.needsUpdate = true
    })
    if (e.def.id === 'earth' && !this.earthHiResAsked) this.loadEarthHiRes()
    if (e.def.id === 'earth')
      load('earth_night', (t) => {
        // Real lighting: the night side shows the world's city lights (and only there, by the real Sun), the oceans catch the Sun's glint.
        const m = e.mesh.material as THREE.MeshStandardMaterial
        this.earthNightReady = true
        m.emissiveMap = t
        m.emissive.set(0xffffff)
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uSunView = this.sunView
          shader.uniforms.uFull = this.earthFull
          shader.uniforms.uMapHi = this.earthMapHi
          shader.uniforms.uNightHi = this.earthNightMapHi
          shader.uniforms.uHiDay = this.earthHiDay
          shader.uniforms.uHiNight = this.earthHiNight
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform float uFull;\nuniform sampler2D uMapHi;\nuniform sampler2D uNightHi;\nuniform float uHiDay;\nuniform float uHiNight;')
            .replace(
              '#include <map_fragment>',
              `#ifdef USE_MAP
              // the sharp map fades in over the small one as it arrives
              vec4 sampledDiffuseColor = texture2D(map, vMapUv);
              if (uHiDay > 0.0) sampledDiffuseColor = mix(sampledDiffuseColor, texture2D(uMapHi, vMapUv), uHiDay);
              diffuseColor *= sampledDiffuseColor;
              #endif`
            )
            .replace(
              '#include <color_fragment>',
              `#include <color_fragment>
              // sunrise and sunset: the ground along the day/night line is lit by a low, reddened Sun (not when the whole globe is shown in daylight)
              float duskSun = dot(normalize(vNormal), normalize(uSunView));
              float dusk = exp(-pow(duskSun / 0.11, 2.0)) * step(-0.02, duskSun) * (1.0 - uFull);
              diffuseColor.rgb *= mix(vec3(1.0), vec3(1.35, 0.66, 0.38), dusk * 0.75);`
            )
            .replace(
              '#include <roughnessmap_fragment>',
              `#include <roughnessmap_fragment>
              float oceanness = clamp((diffuseColor.b - max(diffuseColor.r, diffuseColor.g) * 1.12) * 7.0, 0.0, 1.0);
              roughnessFactor = mix(roughnessFactor, 0.30, oceanness);`
            )
            .replace(
              '#include <emissivemap_fragment>',
              `float sunDot = dot(normalize(vNormal), normalize(uSunView));
              float nightSide = 1.0 - smoothstep(-0.10, 0.08, sunDot);
              vec3 nightPix = texture2D(emissiveMap, vEmissiveMapUv).rgb;
              if (uHiNight > 0.0) nightPix = mix(nightPix, texture2D(uNightHi, vEmissiveMapUv).rgb, uHiNight);
              vec3 cityLights = max(nightPix - vec3(0.05, 0.05, 0.09), vec3(0.0));
              // full daylight: no city lights, and the ground is lit like the day side, fading in as the real light fades out so there is no seam
              float unlit = 1.0 - smoothstep(0.0, ${FULL_DAYLIGHT_RAMP}, sunDot);
              totalEmissiveRadiance = cityLights * vec3(5.0, 3.9, 2.5) * nightSide * (1.0 - uFull) + diffuseColor.rgb * vec3(0.010, 0.014, 0.026) + diffuseColor.rgb * ${FULL_DAYLIGHT_GAIN} * uFull * unlit;`
            )
        }
        m.customProgramCacheKey = () => 'earth-real-lighting'
        m.needsUpdate = true
        this.dirty = true
        // a sharp map that got here first waits for this (it is drawn through this shader)
        if (this.pendingHi.day) this.showHiMap('day', this.pendingHi.day)
        if (this.pendingHi.night) this.showHiMap('night', this.pendingHi.night)
        this.pendingHi = { day: null, night: null }
      })
    if (e.ring)
      load('saturn_ring', (t) => {
        const m = e.ring!.material as THREE.MeshStandardMaterial
        m.map = t
        m.color.set(0xffffff)
        m.opacity = 1
        m.needsUpdate = true
      })
  }

  /**
   * Bring in NASA's Blue Marble and Black Marble at the resolution this graphics setting allows (5120 or 10240 px wide). They are fetched at
   * app start (lib/earthPreload), so usually they are already here; they fade in over the small maps rather than replacing them.
   */
  private loadEarthHiRes(): void {
    this.earthHiResAsked = true
    const level = wantedEarthLevel(this.renderer.capabilities.maxTextureSize)
    if (!level) return
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    for (const kind of ['day', 'night'] as const)
      void earthMapTexture(kind, level, aniso).then((t) => {
        if (!t) return // no connection: the 2048 px map stays
        if (this.disposed) return t.dispose()
        if (this.earthNightReady) this.showHiMap(kind, t)
        else if (this.pendingHi[kind]) t.dispose()
        else this.pendingHi[kind] = t
      })
  }

  /** Start fading a sharp map in over the small one. */
  private showHiMap(kind: 'day' | 'night', t: THREE.Texture): void {
    const uniform = kind === 'day' ? this.earthMapHi : this.earthNightMapHi
    uniform.value?.dispose()
    uniform.value = t
    ;(kind === 'day' ? this.earthHiDay : this.earthHiNight).value = 0
    this.lastFadeAt = performance.now()
    this.dirty = true
  }

  /** Advance the fades (the sharp maps, the full-daylight switch). True while anything is still moving, so the frame is drawn. */
  private stepFades(now: number): boolean {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFadeAt) / 1000))
    this.lastFadeAt = now
    let moving = false
    for (const [u, tex] of [
      [this.earthHiDay, this.earthMapHi],
      [this.earthHiNight, this.earthNightMapHi]
    ] as const) {
      if (tex.value && u.value < 1) {
        u.value = Math.min(1, u.value + dt / HI_MAP_FADE_S)
        moving = true
      }
    }
    if (this.earthFull.value !== this.earthFullTarget) {
      const step = dt / FULL_DAYLIGHT_FADE_S
      this.earthFull.value = this.earthFull.value < this.earthFullTarget ? Math.min(this.earthFullTarget, this.earthFull.value + step) : Math.max(this.earthFullTarget, this.earthFull.value - step)
      moving = true
    }
    return moving
  }

  private buildOrbitLine(e: Entity): void {
    let pts: Vec3[] | null = null
    const date = new Date(this.dateMs)
    if (e.elements) pts = orbitPoints(e.elements, 256)
    else if (e.moon) pts = moonOrbit(e.moon, e.parent!.def.astro ?? '', date)
    else if (e.def.astro && e.def.astro !== 'Sun' && e.def.periodDays) pts = planetOrbit(e.def.astro, e.def.periodDays, date)
    if (!pts) return
    const color = e.moon ? 0x6a7690 : e.def.kind === 'comet' ? 0x5f9cc4 : e.elements ? 0x8a7a5a : 0x4f6fa8
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3))
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: e.moon ? 0.7 : 0.55, depthWrite: false }))
    line.frustumCulled = false
    e.orbit = line
    e.orbitEpochMs = this.dateMs
    if (e.moon) e.parent!.group.add(line) // relative to the planet, so it travels with it
    else {
      this.scene.add(line)
      this.worldLines.push(line)
    }
  }

  private rebuildOrbit(e: Entity): void {
    if (!e.orbit || e.elements) return
    const date = new Date(this.dateMs)
    const pts = e.moon ? moonOrbit(e.moon, e.parent!.def.astro ?? '', date) : planetOrbit(e.def.astro!, e.def.periodDays!, date)
    e.orbit.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3))
    e.orbitEpochMs = this.dateMs
  }

  // ---------- time and positions ----------

  private updatePositions(): void {
    const date = new Date(this.dateMs)
    const jd = julianDate(this.dateMs)
    this.years = (this.dateMs - Date.UTC(2000, 0, 1, 12)) / (365.25 * DAY_MS)
    this.updateStarMotion()
    this.updateSystem()
    // Far outside +-4000 years the planets are faded out, and computing them is slow (Pluto is integrated numerically).
    const solarLive = Math.abs(this.years) < SOLAR_OK_YEARS + SOLAR_FADE_YEARS
    for (const e of this.orderedEntities) {
      if (e.fixed) continue
      if (!solarLive && e.def.id !== 'sun') continue
      if (e.elements) e.pos = keplerPosition(e.elements, jd)
      else if (e.moon) {
        const off = moonOffset(e.moon, e.parent!.def.astro ?? '', date)
        e.pos = [e.parent!.pos[0] + off[0], e.parent!.pos[1] + off[1], e.parent!.pos[2] + off[2]]
      } else e.pos = helioPosition(e.def.astro ?? 'Sun', date)
      if (e.def.astro && !e.moon?.engine) e.rot = bodyFrame(e.def.astro, date)
      else if (e.def.id === 'moon') e.rot = bodyFrame('Moon', date)
    }
    this.updateSatellites()
    // Belts only need to move when the date has changed enough to see (about a day).
    if (solarLive && !(Math.abs(jd - this.cloudJd) < 0.5)) {
      this.cloudJd = jd
      for (const c of this.clouds) {
        c.cloud.positions(jd, c.buffer)
        c.points.geometry.attributes.position.needsUpdate = true
      }
    }
    if (solarLive && !(Math.abs(jd - this.meteorStreamJd) < 0.5)) {
      this.meteorStreamJd = jd
      this.meteorStream?.update(jd)
    }
  }

  private defaultDistance(e: Entity): number {
    if (e.def.id.startsWith('host:')) {
      const sys = this.systems?.[e.def.name]
      if (sys?.planets.length) return Math.max(0.05, Math.max(...sys.planets.map((p) => p[1] as number)) * 3.2)
    }
    if (e.far) return e.far.defaultDist
    if (e.def.id === 'sun') return 0.06
    if (e.def.id === 'saturn') return e.radiusAU * 10
    if (e.def.kind === 'planet' || e.def.kind === 'dwarf') return e.radiusAU * 7
    if (e.def.kind === 'moon') return e.radiusAU * 10
    return Math.max(e.radiusAU * 12, 4e-6)
  }

  private setFocusLimits(id: string): void {
    const e = this.entities.get(id)
    if (!e) return
    this.controls.minDistance = e.far ? e.far.minDist : id === 'earth' ? e.radiusAU + EARTH_MIN_ALT_KM / KM_PER_AU : Math.max(e.radiusAU * (id === 'saturn' ? 1.4 : 1.15), 1.5e-6)
  }

  // ---------- frame loop ----------

  private frame = (now: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    let draw = this.dirty
    if (this.stepFades(now)) draw = true
    this.updateAircraft()
    this.updateOrbitTrace()
    if (this.aurora?.glow.visible && now - this.auroraDrawnAt > 60) {
      this.auroraDrawnAt = now // the shimmer and the moving rays: about 16 pictures a second is smooth enough
      draw = true
    }
    if (this.magneto?.animating && now - this.magnetoDrawnAt > 50) {
      this.magnetoDrawnAt = now // shaking, pulsing lines
      draw = true
    }
    if (this.windLayer?.animating && now - this.windDrawnAt > 33) {
      this.windDrawnAt = now // the moving stream
      draw = true
    }
    if (this.trafficOn && this.traffic && this.traffic.placeCount > 0 && now - this.trafficDrawnAt > 33) {
      this.trafficDrawnAt = now // the scrolling code on the arcs
      draw = true
    }
    if ((this.flow.wind?.active || this.flow.currents?.active) && now - this.flowDrawnAt > 33) {
      this.flowDrawnAt = now // the moving streaks
      draw = true
    }
    if (this.home?.dot.visible && now - this.homeDrawnAt > 90) {
      this.homeDrawnAt = now // the breathing halo
      draw = true
    }
    if (this.lightning?.visible && now - this.lightningDrawnAt > 1000) {
      this.lightningDrawnAt = now // the age colours and the heat map move slowly: about once a second is enough when nothing is flashing
      draw = true
    }

    if (this.playing) {
      this.dateMs = Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, this.dateMs + this.speedDaysPerSec * dt * DAY_MS))
      // at about real time nothing on screen moves visibly from one frame to the next: redo the positions and the picture about 4 times a second
      const slow = Math.abs(this.speedDaysPerSec) * DAY_MS <= 2 * 1000 && this.satFollow === null && this.shipFollow === null && this.mode !== 'surface'
      if (!slow || now - this.lastLiveDraw > 250) {
        this.lastLiveDraw = now
        this.updatePositions()
        draw = true
      }
      if (now - this.lastTimeCb > TIME_CALLBACK_MS) {
        this.lastTimeCb = now
        this.cb.onTime?.(this.dateMs)
      }
    }

    const focus = this.entities.get(this.focusId)!
    const target = this.targetPos(focus)
    if (this.satFollow !== null || this.shipFollow !== null) draw = true // the satellite or ship moves under the camera every frame
    if (this.homeFollow && this.stepHomeFollow()) draw = true // the Earth turned: turn the camera with it
    if (this.quakes?.animating && now - this.hazardDrawnAt > 100) {
      this.hazardDrawnAt = now // the rings spreading from new earthquakes
      draw = true
    }
    if (this.ships?.points.visible && now - this.shipDrawnAt > 2000) {
      this.shipDrawnAt = now // the ships glide along their courses
      draw = true
    }
    if (this.mode === 'surface' && this.surface) {
      this.applySurfaceCamera()
      draw = true
    } else if (this.mode === 'fly') {
      this.stepFly(dt, now)
      draw = true
    } else if (this.flight) {
      const f = this.flight
      const k = easeInOut(Math.min(1, (now - f.start) / f.dur))
      this.origin = [0, 1, 2].map((i) => f.fromOrigin[i] + (target[i] - f.fromOrigin[i]) * k) as Vec3
      const lf = Math.log(f.fromDist)
      const lt = Math.log(f.toDist)
      // Rise and fall on a log scale, but never so low that the start and the destination are both
      // out of sight: keep the camera at least 0.7 of the way to the nearer of them from the centre
      // of view, so a long trip is an arc over the gap instead of a slide through empty space.
      const sep = Math.min(len3(sub3(this.origin, f.fromOrigin)), len3(sub3(this.origin, target)))
      const dist = Math.max(Math.exp(lf + (lt - lf) * k), 0.7 * sep)
      this.camera.position.copy(f.fromDir).lerp(f.toDir, k).normalize().multiplyScalar(dist)
      this.camera.lookAt(0, 0, 0)
      draw = true
      if (k >= 1) {
        this.flight = null
        this.controls.enabled = true
        this.controls.update()
        this.cb.onArrive?.(this.focusId)
      }
    } else {
      this.origin = [...target]
      if (this.playing) draw = true
    }
    if (this.mode === 'orbit' && this.controls.enabled && !this.flight && this.rollKeys.size && this.stepRoll(dt)) draw = true
    if (this.mode === 'orbit' && this.controls.enabled && this.controls.update()) draw = true
    const dView = this.camera.position.length()
    if (now - this.lastViewCb > 100 && (this.focusId !== this.lastViewFocus || !(Math.abs(Math.log(dView / this.lastViewD)) < 0.004))) {
      this.lastViewCb = now
      this.lastViewD = dView
      this.lastViewFocus = this.focusId
      this.cb.onView?.({ distanceAU: dView, focusId: this.focusId })
    }
    if (!draw) return
    this.dirty = false
    this.layout()
    this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
  }

  private layout(): void {
    const o = this.origin
    const cam = this.camera
    const H = this.renderer.domElement.clientHeight || 1
    const pxPerRad = H / 2 / Math.tan((cam.fov * DEG) / 2)
    const ex = this.tmpV
    const L = this.layers
    const A = scaleAlphas(cam.position.length())
    // Far from now the planets are extrapolated beyond what their theories are good for: fade them out.
    const over = (Math.abs(this.years) - SOLAR_OK_YEARS) / SOLAR_FADE_YEARS
    const validity = over <= 0 ? 1 : over >= 1 ? 0 : 1 - over * over * (3 - 2 * over)
    A.solar *= validity
    // The directional sky is the sky as seen from the Sun. Flying far from the Sun the stars must move against each other instead, so it fades and the 3D stars and galaxies take over.
    if (this.mode === 'fly') A.backdrop *= 1 - ramp(Math.hypot(o[0] + cam.position.x, o[1] + cam.position.y, o[2] + cam.position.z), 3e5, 3e6)

    for (const line of this.worldLines) line.position.set(-o[0], -o[1], -o[2])

    // The layers that are not entities: backdrop sky, 3D stars, hosts, the Milky Way.
    this.stars.position.copy(cam.position)
    this.stars.visible = A.backdrop > 0.01
    for (const c of this.stars.children) {
      const m = (c as THREE.Points).material as THREE.PointsMaterial
      m.opacity = ((m.userData.base as number) ?? 1) * A.backdrop
    }
    this.meteors?.layout(cam.position, A.backdrop)
    if (this.nearCloud) {
      this.nearCloud.points.visible = L.stars && A.starCloud > 0.01
      this.nearCloud.material.uniforms.uAlpha.value = A.starCloud
    }
    if (this.constel) {
      this.constel.lines.visible = L.constellations && A.starCloud > 0.01 && !this.activeSystem // lines crossing a planetary system are just clutter
      ;(this.constel.lines.material as THREE.LineBasicMaterial).opacity = 0.5 * A.starCloud
    }
    if (this.hostCloud) {
      this.hostCloud.points.visible = L.hosts && A.starCloud > 0.01
      this.hostCloud.material.opacity = 0.85 * A.starCloud
    }
    if (this.gxCat) this.gxCat.setAlpha(L.galaxies ? A.ext : 0, this.renderer.getPixelRatio())
    if (this.mwCloud) {
      this.mwCloud.points.visible = L.galaxies && A.milkyWay > 0.01
      this.mwCloud.material.opacity = MILKY_WAY_OPACITY * A.milkyWay
      this.mwCloud.diffuse.opacity = MILKY_WAY_GLOW_OPACITY * A.milkyWayGlow
      this.mwCloud.diffuse.visible = A.milkyWayGlow > 0.01
    }

    for (const e of this.orderedEntities) {
      e.group.position.set(e.pos[0] - o[0], e.pos[1] - o[1], e.pos[2] - o[2])
    }
    for (const e of this.orderedEntities) {
      const dist = Math.max(e.group.position.distanceTo(cam.position), 1e-12)
      const isFocus = e.def.id === this.focusId
      // How visible this thing is at the current zoom; the Sun always shows, and whatever the
      // camera is close to is drawn in full.
      let tierA = e.def.id === 'sun' ? 1 : A[e.tier]
      tierA = Math.max(tierA, 1 - ramp(dist, PROXIMITY_FULL_AU, PROXIMITY_FULL_AU * 10))
      if (e.tier === 'solar' && e.def.id !== 'sun') tierA *= validity
      let show = true
      if (e.tier === 'solar') {
        if (e.moon) show = L.moons && e.parent!.group.position.distanceTo(cam.position) < MOON_VISIBLE_AU
        else if (e.elements) show = L.minor
      } else if (e.def.id.startsWith('host:')) show = L.hosts
      else if (e.tier === 'star') show = L.stars
      else if (e.tier === 'dso') show = L.deepsky
      else show = L.galaxies
      const on = show && tierA > 0.02
      // A small rock you have flown up to is drawn oversize (about 2% of the way to the camera),
      // or it would never be more than a dot. Everywhere else it is a dot at its true size.
      const r = (e.def.kind === 'asteroid' || e.def.kind === 'comet') && isFocus ? Math.max(e.radiusAU, dist * 0.02) : e.radiusAU
      e.mesh.scale.setScalar(r)
      const screenR = (r / dist) * pxPerRad
      e.group.visible = on || isFocus
      const hasHalo = !!e.far?.halo
      e.mesh.visible = screenR > 0.4 && !(this.mode === 'surface' && e.def.id === 'earth' && (this.surface?.altitudeM ?? 0) < EARTH_MESH_MIN_ALT_M)
      e.marker.visible = screenR < (hasHalo ? HALO_MARKER_HIDE_PX : MARKER_HIDE_PX)
      e.marker.material.opacity = tierA
      e.label.visible = L.labels && on
      if (Math.abs(e.alpha - tierA) > 0.02) {
        e.alpha = tierA
        e.label.element.style.opacity = tierA.toFixed(2)
        this.labelShown.delete(e) // declutterLabels re-applies any fade from a body in front
      }
      if (hasHalo) {
        const halo = e.far!.halo!
        // Fade the glow out as you fly inside the object, or it would wash the whole screen.
        const inside = Math.min(1, Math.max(0, dist / e.radiusAU - 0.4) / 0.6)
        halo.visible = e.group.visible && screenR > HALO_MIN_PX
        halo.material.opacity = (e.far!.haloOpacity ?? 0.5) * tierA * inside
      }
      if (e.rot) {
        // Sphere local axes: +x = prime meridian, +y = 90 deg east, +z = north pole.
        this.tmpM.makeBasis(ex.set(...e.rot.prime), this.tmpV2.set(...e.rot.east), this.tmpV3.set(...e.rot.north))
        e.mesh.quaternion.setFromRotationMatrix(this.tmpM)
        // Clouds, aurora and aircraft keep turning (and stay the right size) even while the globe mesh itself
        // is hidden standing at ground level, since they live on this sibling rather than on the mesh.
        if (this.skySurface && e.def.id === 'earth') {
          this.skySurface.quaternion.copy(e.mesh.quaternion)
          this.skySurface.scale.copy(e.mesh.scale)
        }
      }
      if (e.orbit) {
        const stale = Math.abs(this.dateMs - e.orbitEpochMs) / DAY_MS > (e.moon ? MOON_ORBIT_STALE_DAYS : PLANET_ORBIT_STALE_DAYS)
        const mat = e.orbit.material as THREE.LineBasicMaterial
        mat.opacity = (isFocus ? 0.95 : e.moon ? 0.7 : e.def.kind === 'comet' ? 0.22 : e.elements ? 0.2 : 0.55) * A.solar
        e.orbit.visible = L.orbits && show && A.solar > 0.02 && (!e.moon || (e.parent!.group.position.distanceTo(cam.position) < MOON_VISIBLE_AU && this.focusId === e.parent!.def.id))
        if (stale && e.orbit.visible) this.rebuildOrbit(e)
      }
      if (e.tail) {
        const r2 = len3(e.pos)
        const tailOn = show && r2 < 3 && A.solar > 0.02
        e.tail.visible = tailOn
        if (tailOn) {
          const l = 0.2 / Math.max(r2, 0.3)
          const a = e.tail.geometry.attributes.position as THREE.BufferAttribute
          a.setXYZ(1, (e.pos[0] / r2) * l, (e.pos[1] / r2) * l, (e.pos[2] / r2) * l)
          a.needsUpdate = true
        }
      }
    }
    for (const c of this.clouds) {
      c.points.visible = L.belts && A.solar > 0.02
      ;(c.points.material as THREE.PointsMaterial).opacity = (((c.points.material as THREE.PointsMaterial).userData.base as number) ?? 0.6) * A.solar
    }
    if (this.meteorStream) this.meteorStream.layout(L.streams ? A.solar : 0)
    this.updateEarthLight()
    this.layoutSystem(cam, pxPerRad, L.labels)
    this.layoutSatellites(cam)
    this.layoutTrace(cam)
    this.layoutAircraft(cam)
    this.layoutCities(cam)
    this.layoutMyPlaces(cam)
    this.layoutLightning(cam)
    this.layoutTraffic(cam)
    this.layoutShips(cam)
    this.layoutHazards(cam)
    this.layoutDetail(cam)
    this.layoutFlow(cam, performance.now())
    this.layoutAurora(cam)
    this.layoutSun(cam)
    this.layoutMagneto(cam)
    this.layoutWind(cam)
    this.layoutHome(cam)
    this.layoutBillboard(cam)
    this.layoutGalaxyModels(cam, pxPerRad)
    this.hideBehindSolids()
    if (L.labels) this.declutterLabels()
  }

  private layoutSystem(cam: THREE.PerspectiveCamera, pxPerRad: number, labels: boolean): void {
    const s = this.activeSystem
    if (!s) return
    const w = this.tmpV
    for (const p of s.planets) {
      p.mesh.getWorldPosition(w)
      const dist = Math.max(w.distanceTo(cam.position), 1e-12)
      const screenR = (p.radiusAU / dist) * pxPerRad
      p.mesh.visible = screenR > 0.4
      p.marker.visible = screenR < MARKER_HIDE_PX
      p.label.visible = labels
    }
  }

  /** Fade the survey picture in as you approach its object, and out as you pass inside it. */
  private layoutBillboard(cam: THREE.PerspectiveCamera): void {
    const b = this.billboard
    if (!b) return
    const d = cam.position.length() // focus is at the origin
    // a photograph is only true from where it was taken: it fades as the camera leaves the line from the galaxy to us, where the 3D model takes over
    const owner = this.entities.get(b.owner)
    let side = 1
    if (owner?.far?.galaxy && d > 0) {
      const to = len3(owner.pos) || 1
      const align = -(cam.position.x * owner.pos[0] + cam.position.y * owner.pos[1] + cam.position.z * owner.pos[2]) / (d * to)
      side = Math.min(1, Math.max(0, (align - 0.55) / 0.35))
    }
    this.gxPhoto = owner?.far?.galaxy ? side * (1 - ramp(d / b.width, 12, 40)) : 0
    b.sprite.material.opacity = 0.9 * Math.min(1, Math.max(0, d / b.width - 0.25) / 0.6) * (1 - ramp(d / b.width, 40, 400)) * (owner?.far?.galaxy ? Math.max(0.12, side) : 1)
  }

  /** Hide labels that would land on top of a more important one, or off screen. */
  private declutterLabels(): void {
    const W = this.container.clientWidth || 1
    const H = this.container.clientHeight || 1
    const rank = (e: Entity): number => (e.def.id === this.focusId ? -1 : LABEL_RANK[e.def.kind])
    const cands = this.orderedEntities.filter((e) => e.label.visible).sort((a, b) => rank(a) - rank(b))
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const v = this.tmpV
    for (const e of cands) {
      v.copy(e.group.position).project(this.camera)
      const x = ((v.x + 1) / 2) * W
      const y = ((1 - v.y) / 2) * H
      const box = { x: x + 4, y: y - 8, w: e.def.name.length * 6.4 + 14, h: 16 }
      const visibility = this.behind.get(e) ?? 1
      const clash = visibility < 0.02 || v.z > 1 || x < -20 || x > W + 20 || y < -20 || y > H + 20 || placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)
      e.label.visible = !clash
      if (clash) continue
      placed.push(box)
      // fade in over the last few percent of a body's edge, so a name does not pop as its star clears the limb
      const want = e.alpha * visibility
      if (Math.abs((this.labelShown.get(e) ?? -1) - want) > 0.02) {
        this.labelShown.set(e, want)
        e.label.element.style.opacity = want.toFixed(2)
      }
    }
  }

  /**
   * Things on the far side of a planet, moon or the Sun are hidden. Markers are sprites drawn over everything and names are HTML
   * on top of the canvas, so the depth buffer cannot do this: without it a star or comet behind the Earth shows through it.
   */
  private hideBehindSolids(): void {
    const solids = this.orderedEntities.filter((e) => e.radiusAU > 0 && e.group.visible && (e.mesh.visible || e.def.id === 'earth') && (e.def.kind === 'planet' || e.def.kind === 'moon' || e.def.kind === 'dwarf' || e.def.id === 'sun'))
    if (!solids.length) return
    for (const e of this.orderedEntities) {
      if (!e.marker.visible && !e.label.visible) continue
      const vis = this.labelVisibility(e, solids)
      this.behind.set(e, vis)
      if (vis < 0.02) e.marker.visible = e.label.visible = false
      else if (vis < 1) e.marker.material.opacity *= vis
    }
  }

  /** 0 when a solid body sits between the camera and this entity, 1 when the view is clear, in between right at the body's edge. */
  private labelVisibility(e: Entity, solids: Entity[]): number {
    const cam = this.camera.position
    const ux = e.group.position.x - cam.x
    const uy = e.group.position.y - cam.y
    const uz = e.group.position.z - cam.z
    const dl = Math.hypot(ux, uy, uz)
    if (dl <= 0) return 1
    let vis = 1
    for (const s of solids) {
      if (s === e || s.def.id === e.def.id) continue
      const cx = s.group.position.x - cam.x
      const cy = s.group.position.y - cam.y
      const cz = s.group.position.z - cam.z
      const c2 = cx * cx + cy * cy + cz * cz
      const R = s.radiusAU
      if (c2 <= R * R) continue // the camera is inside it
      const t = (cx * ux + cy * uy + cz * uz) / dl // distance along the line of sight to the closest approach
      if (t <= 0) continue // behind the camera
      const perp = Math.sqrt(Math.max(0, c2 - t * t))
      if (perp >= R * 1.03) continue
      if (t - Math.sqrt(Math.max(0, R * R - perp * perp)) >= dl) continue // the label is in front of the body
      vis = Math.min(vis, Math.min(1, Math.max(0, (perp / R - 1) / 0.03)))
    }
    return vis
  }

  private resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labels.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.dirty = true
  }

  // ---------- satellites ----------

  /** Show these satellites around the Earth, at the simulation's time (null removes them). */
  setSatellites(records: SatRecord[] | null): void {
    if (this.sats) {
      this.sats.points.removeFromParent()
      this.sats.points.geometry.dispose()
      ;(this.sats.points.material as THREE.Material).dispose()
      this.sats = null
    }
    const earth = this.entities.get('earth')
    const followed = this.satFollow !== null
    this.satFollow = null
    if (followed) this.focusOn('earth')
    if (!records?.length || !earth) {
      this.dirty = true
      return
    }
    const n = records.length
    const base = new Float32Array(n * 3)
    const c = new THREE.Color()
    records.forEach((r, i) => {
      c.set(colorOf(r.flags))
      base.set([c.r, c.g, c.b], i * 3)
    })
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(n * 3)
    const col = new Float32Array(base)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, map: this.dot, transparent: true, depthWrite: false, opacity: 0, alphaTest: 0.01 })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false // its bounding sphere is the Earth's; the points move
    points.renderOrder = 4
    earth.group.add(points)
    this.sats = { records, index: new Map(records.map((r, i) => [r.norad, i])), points, pos, col, base, alive: new Uint8Array(n), at: 0, cost: 0 }
    this.updateSatellites(true)
  }

  /** Where every satellite is at the simulation's time. Redone at most every ~0.1 s, and less often when there are many. */
  private updateSatellites(force = false): void {
    const s = this.sats
    if (!s) return
    const now = performance.now()
    if (!force && now - s.at < Math.max(90, s.cost * 6)) return
    const date = new Date(this.dateMs)
    const conv = temeToEcliptic(julianDate(this.dateMs))
    const sun = sunEciAU(date)
    const k = 1 / KM_PER_AU
    const { records, pos, col, base, alive } = s
    for (let i = 0; i < records.length; i++) {
      const p = eciPosition(records[i], date)
      const j = 3 * i
      if (!p) {
        // no usable orbit for this moment: park it inside the Earth, where the globe hides it
        alive[i] = 0
        pos[j] = pos[j + 1] = pos[j + 2] = 0
        continue
      }
      alive[i] = 1
      const v = conv(p)
      pos[j] = v[0] * k
      pos[j + 1] = v[1] * k
      pos[j + 2] = v[2] * k
      // in Earth's shadow it would be dark: draw it dim
      const dim = shadowOf(p, sun) < 0.5 ? 1 : 0.28
      col[j] = base[j] * dim
      col[j + 1] = base[j + 1] * dim
      col[j + 2] = base[j + 2] * dim
    }
    s.points.geometry.attributes.position.needsUpdate = true
    s.points.geometry.attributes.color.needsUpdate = true
    s.at = performance.now()
    s.cost = s.at - now
    this.dirty = true
  }

  /** The followed satellite's position now, in AU from the Earth's centre: exact, not the last cloud update. */
  private followVector(): Vec3 | null {
    const s = this.sats
    if (!s || this.satFollow === null) return null
    const p = eciPosition(s.records[this.satFollow], new Date(this.dateMs))
    if (!p) return null
    const v = temeToEcliptic(julianDate(this.dateMs))(p)
    return [v[0] / KM_PER_AU, v[1] / KM_PER_AU, v[2] / KM_PER_AU]
  }

  /** Where the camera is centred: the focused body, or the satellite it follows. */
  private targetPos(focus: Entity): Vec3 {
    if (this.shipFollow !== null) {
      const v = this.shipVector()
      if (v) return v
      this.shipFollow = null // it is gone from the data: let go
      this.camera.near = 1e-7
      this.camera.updateProjectionMatrix()
      this.cb.onShipLost?.()
      return focus.pos
    }
    if (this.satFollow === null) return focus.pos
    const f = this.followVector()
    if (!f || !this.sats) {
      // its orbit data does not cover this moment: let go
      this.followSatellite(null)
      this.cb.onSatelliteLost?.()
      return focus.pos
    }
    const earth = this.entities.get('earth')!
    const s = this.sats
    const j = 3 * this.satFollow
    s.pos[j] = f[0]
    s.pos[j + 1] = f[1]
    s.pos[j + 2] = f[2]
    s.points.geometry.attributes.position.needsUpdate = true
    return [earth.pos[0] + f[0], earth.pos[1] + f[1], earth.pos[2] + f[2]]
  }

  /** Fly to a satellite and stay with it as it orbits (null: fly back out to the whole Earth). */
  followSatellite(norad: number | null): void {
    if (norad === null) {
      if (this.satFollow !== null) this.focusOn('earth') // clears the follow and flies out
      return
    }
    const s = this.sats
    const i = s?.index.get(norad)
    if (!s || i === undefined || !this.entities.get('earth')) return
    if (this.mode === 'surface') this.leaveSurface()
    if (this.mode === 'fly') this.exitFly()
    this.dropHomeFollow()
    this.satFollow = i
    this.satSelected = norad
    this.focusId = 'earth'
    this.controls.minDistance = 1.5e-6 // a few hundred km: close enough that the Earth is a wall beneath it
    const f = this.followVector()
    const radial = f ? new THREE.Vector3(...f).normalize() : new THREE.Vector3(0, 0, 1)
    const side = new THREE.Vector3(0, 0, 1).cross(radial)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    // from above and to one side, so the Earth curves away beneath it
    const toDir = radial.clone().multiplyScalar(0.55).add(side.normalize().multiplyScalar(0.8)).normalize()
    const fromDir = this.camera.position.clone().normalize()
    const fromDist = this.camera.position.length()
    const toDist = 900 / KM_PER_AU
    this.flight = {
      start: performance.now(),
      dur: Math.min(4800, FLIGHT_MS + 260 * Math.abs(Math.log10(toDist / fromDist))),
      fromOrigin: [...this.origin],
      fromDist,
      toDist,
      fromDir,
      toDir
    }
    this.controls.enabled = false
    this.dirty = true
  }

  /** NORAD number of the satellite the camera follows, if any. */
  followedSatellite(): number | null {
    return this.sats && this.satFollow !== null ? this.sats.records[this.satFollow].norad : null
  }

  /** Ring the picked satellite (null: none). */
  selectSatellite(norad: number | null): void {
    this.satSelected = norad
    this.dirty = true
  }

  /** What is known about a satellite at the simulation's time, or null when its orbit data does not cover it. */
  satelliteState(norad: number): SatGlobal | null {
    const s = this.sats
    const i = s?.index.get(norad)
    return s && i !== undefined ? globalState(s.records[i], new Date(this.dateMs)) : null
  }

  private ensureSatMarker(parent: THREE.Group): void {
    if (this.satMarker) return
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    g.strokeStyle = '#fde047'
    g.lineWidth = 5
    g.beginPath()
    g.arc(32, 32, 26, 0, Math.PI * 2)
    g.stroke()
    this.satMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }))
    this.satMarker.scale.setScalar(0.04)
    this.satMarker.renderOrder = 11
    parent.add(this.satMarker)
    const div = document.createElement('div')
    div.style.cssText = 'padding-left:16px;font:11px/1.2 system-ui,sans-serif;color:#fde047;text-shadow:0 0 3px #000,0 0 3px #000;white-space:nowrap;pointer-events:none;user-select:none'
    this.satLabel = new CSS2DObject(div)
    this.satLabel.center.set(0, 0.5)
    parent.add(this.satLabel)
  }

  /** Fade the satellites in as the camera nears the Earth, and put the ring and name on the picked one. */
  private layoutSatellites(cam: THREE.PerspectiveCamera): void {
    const s = this.sats
    if (!s) return
    const earth = this.entities.get('earth')!
    // full strength within ~60,000 km of the Earth, gone by ~600,000 km
    this.satOpacity = 1 - ramp(earth.group.position.distanceTo(cam.position), 4e-4, 4e-3)
    ;(s.points.material as THREE.PointsMaterial).opacity = 0.95 * this.satOpacity
    s.points.visible = this.satOpacity > 0.02
    const i = this.satSelected === null ? undefined : s.index.get(this.satSelected)
    const show = i !== undefined && !!s.alive[i] && this.satOpacity > 0.05
    if (show) this.ensureSatMarker(earth.group)
    if (!this.satMarker || !this.satLabel) return
    this.satMarker.visible = show
    this.satLabel.visible = show
    if (show && i !== undefined) {
      this.satMarker.position.set(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2])
      this.satLabel.position.copy(this.satMarker.position)
      const name = s.records[i].name
      if (this.satLabel.element.textContent !== name) this.satLabel.element.textContent = name
    }
  }

  /** The satellite under a click (its NORAD number), or null. Ignores ones behind the Earth. */
  private pickSatellite(px: number, py: number, width: number, height: number): number | null {
    const s = this.sats
    if (!s || this.satOpacity < 0.3 || !s.points.visible) return null
    const earth = this.entities.get('earth')!
    const centre = earth.group.position
    const R = earth.radiusAU
    const cam = this.camera.position
    const v = this.tmpV
    const w = this.tmpV2
    let best: { i: number; d: number } | null = null
    for (let i = 0; i < s.records.length; i++) {
      if (!s.alive[i]) continue
      w.set(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2])
      v.copy(w).add(centre).project(this.camera)
      if (v.z > 1 || v.z < -1) continue
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py)
      // the bright, named ones win close calls: thousands of dots can sit within a few pixels of each other
      const score = d - (isBright(s.records[i].flags) ? 4 : 0)
      if (d > 12 || (best && score >= best.d)) continue
      // behind the globe? the segment camera -> satellite crosses the Earth's sphere
      w.add(centre)
      const dx = w.x - cam.x
      const dy = w.y - cam.y
      const dz = w.z - cam.z
      const len2 = dx * dx + dy * dy + dz * dz
      const t = Math.max(0, Math.min(1, ((centre.x - cam.x) * dx + (centre.y - cam.y) * dy + (centre.z - cam.z) * dz) / len2))
      const cx = cam.x + dx * t - centre.x
      const cy = cam.y + dy * t - centre.y
      const cz = cam.z + dz * t - centre.z
      if (Math.hypot(cx, cy, cz) < R * 0.999) continue
      best = { i, d: score }
    }
    return best ? s.records[best.i].norad : null
  }

  // ---------- picking ----------

  private pickCme(px: number, py: number, width: number, height: number): Cme | null {
    return this.sunLayer && this.sunLayer.group.visible ? this.sunLayer.pick(px, py, width, height, this.camera) : null
  }

  private pickFlare(px: number, py: number, width: number, height: number): Flare | null {
    return this.sunLayer && this.sunLayer.group.visible ? this.sunLayer.pickFlare(px, py, width, height, this.camera) : null
  }

  private select(id: string): void {
    this.focusOn(id)
    this.cb.onSelect?.(id)
  }

  private onDown = (e: PointerEvent): void => {
    // Pointer capture (OrbitControls) redirects later events to the container, so read the label now.
    this.down = { x: e.clientX, y: e.clientY, id: (e.target as HTMLElement).dataset?.ssId ?? null }
  }

  /** Dragging the view (not a click, not the wheel) lets go of the followed place. */
  private onMoveHome = (e: PointerEvent): void => {
    const d = this.down
    if (d && this.homeFollow && !this.flight && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) this.dropHomeFollow()
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.down
    this.down = null
    if (this.mode !== 'orbit') return
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return
    if (d.id) return this.select(d.id)
    const rect = this.renderer.domElement.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (this.placePicking) {
      const spot = this.pickEarthLatLon(px, py, rect.width, rect.height)
      if (spot) return this.cb.onPlacePick?.(spot)
    }
    if (this.cb.onHomeClick && this.pickHome(px, py, rect.width, rect.height)) return this.cb.onHomeClick()
    const myPlace = this.pickMyPlace(px, py, rect.width, rect.height)
    if (myPlace !== null) return this.cb.onPlaceSelect?.(myPlace)
    const sat = this.pickSatellite(px, py, rect.width, rect.height)
    if (sat !== null) {
      this.satSelected = sat
      this.dirty = true
      return this.cb.onSatelliteSelect?.(sat)
    }
    const plane = this.pickAircraft(px, py, rect.width, rect.height)
    if (plane !== null && this.planes) {
      this.planeSelected = plane
      this.dirty = true
      const a = this.planes.rows[plane]
      const q = advanceAircraft(a, Date.now())
      return this.cb.onAircraftSelect?.({ hex: a.hex, callsign: a.callsign, reg: a.reg, type: a.type, latDeg: q.latDeg, lonDeg: q.lonDeg, altM: q.altM, speedMs: a.speedMs, trackDeg: a.trackDeg, vrateMs: a.vrateMs, kind: a.kind })
    }
    const shipEarth = this.entities.get('earth')
    const shipRow = this.ships && shipEarth ? this.ships.pick(px, py, rect.width, rect.height, this.camera, shipEarth.group.position, shipEarth.radiusAU, shipEarth.mesh.matrixWorld) : null
    if (shipRow !== null && this.ships) {
      const sh = this.ships.rows[shipRow]
      const q = advanceShip(sh, Date.now())
      this.shipSelected = sh.mmsi
      this.shipLabelText = ''
      this.dirty = true
      return this.cb.onShipSelect?.({ mmsi: sh.mmsi, latDeg: q.latDeg, lonDeg: q.lonDeg, sogKn: sh.sogKn, courseDeg: sh.courseDeg, cat: sh.cat })
    }
    if (this.shipSelected !== null && this.shipFollow === null) {
      this.shipSelected = null
      this.dirty = true
      this.cb.onShipSelect?.(null)
    }
    const town = this.cb.onTownSelect ? this.pickTown(px, py, rect.width, rect.height) : null
    if (town) {
      this.townSelected = true
      return this.cb.onTownSelect?.(town)
    }
    if (this.townSelected) {
      this.townSelected = false
      this.cb.onTownSelect?.(null)
    }
    const hit = this.pickHazard(px, py, rect.width, rect.height)
    if (hit) {
      this.dirty = true
      if (hit.kind === 'quake' && this.quakes) {
        const q = this.quakes.rows[hit.index]
        this.hazardSel = { kind: 'quake', key: q.id }
        this.hazardLabelText = ''
        this.cb.onVolcanoSelect?.(null)
        return this.cb.onQuakeSelect?.({ id: q.id, latDeg: q.latDeg, lonDeg: q.lonDeg, mag: q.mag })
      }
      if (hit.kind === 'volcano' && this.volcanoes) {
        const v = this.volcanoes.rows[hit.index]
        this.hazardSel = { kind: 'volcano', key: v.vnum }
        this.hazardLabelText = ''
        this.cb.onQuakeSelect?.(null)
        return this.cb.onVolcanoSelect?.({ vnum: v.vnum, latDeg: v.latDeg, lonDeg: v.lonDeg, level: v.level })
      }
    }
    if (this.hazardSel) {
      this.hazardSel = null
      this.dirty = true
      this.cb.onQuakeSelect?.(null)
      this.cb.onVolcanoSelect?.(null)
    }
    const launchIdx = this.launches && shipEarth ? this.launches.pick(px, py, rect.width, rect.height, this.camera, shipEarth.group.position, shipEarth.radiusAU, shipEarth.mesh.matrixWorld) : null
    if (launchIdx !== null && this.launches) {
      const l = this.launches.rows[launchIdx]
      this.launchSel = l.id
      this.dirty = true
      return this.cb.onLaunchSelect?.(l)
    }
    if (this.launchSel !== null) {
      this.launchSel = null
      this.dirty = true
      this.cb.onLaunchSelect?.(null)
    }
    const aqiIdx = this.aqi && shipEarth ? this.aqi.pick(px, py, rect.width, rect.height, this.camera, shipEarth.group.position, shipEarth.radiusAU, shipEarth.mesh.matrixWorld) : null
    if (aqiIdx !== null && this.aqi) {
      const s = this.aqi.rows[aqiIdx]
      this.aqiSel = s.id
      this.dirty = true
      return this.cb.onAqiSelect?.(s)
    }
    if (this.aqiSel !== null) {
      this.aqiSel = null
      this.dirty = true
      this.cb.onAqiSelect?.(null)
    }
    if ((this.flow.wind?.active || this.flow.currents?.active) && this.focusId === 'earth') {
      const spot = this.pickEarthLatLon(px, py, rect.width, rect.height)
      if (spot) {
        this.setFlowPick(spot)
        return this.cb.onEarthPick?.(spot)
      }
    }
    const earthNow = this.entities.get('earth')
    const trafficHit = this.traffic && earthNow ? this.traffic.pick(px, py, rect.width, rect.height, this.camera, earthNow.group.position, earthNow.radiusAU) : null
    if (trafficHit) {
      this.trafficSelected = true
      this.traffic!.select(trafficHit.id)
      this.dirty = true
      return this.cb.onTrafficSelect?.(trafficHit.id)
    }
    if (this.trafficSelected) {
      this.trafficSelected = false
      this.traffic?.select(null)
      this.dirty = true
      this.cb.onTrafficSelect?.(null)
    }
    const strike = this.lightning && earthNow ? this.lightning.pick(px, py, rect.width, rect.height, this.camera, earthNow.group.position, earthNow.radiusAU) : null
    if (strike) {
      this.strikeSelected = true
      this.dirty = true
      return this.cb.onStrikeSelect?.(strike)
    }
    if (this.strikeSelected) {
      this.strikeSelected = false
      this.lightning?.deselect()
      this.dirty = true
      this.cb.onStrikeSelect?.(null)
    }
    if (this.planeSelected !== null) {
      this.planeSelected = null
      this.dirty = true
      this.cb.onAircraftSelect?.(null)
    }
    const cme = this.pickCme(px, py, rect.width, rect.height)
    if (cme) {
      this.cmeSel = cme.id
      this.dirty = true
      return this.cb.onCmeSelect?.(cme)
    }
    if (this.cmeSel !== null) {
      this.cmeSel = null
      this.dirty = true
      this.cb.onCmeSelect?.(null)
    }
    const flare = this.pickFlare(px, py, rect.width, rect.height)
    if (flare) {
      this.flareSelected = true
      this.dirty = true
      return this.cb.onFlareSelect?.(flare)
    }
    if (this.flareSelected) {
      this.flareSelected = false
      this.dirty = true
      this.cb.onFlareSelect?.(null)
    }
    const meteor = this.meteors?.pick(px, py, rect.width, rect.height, this.camera) ?? null
    if (meteor) {
      this.meteorSel = meteor.code
      this.dirty = true
      return this.cb.onMeteorSelect?.(meteor)
    }
    if (this.meteorSel !== null) {
      this.meteorSel = null
      this.dirty = true
      this.cb.onMeteorSelect?.(null)
    }
    const H = rect.height
    const pxPerRad = H / 2 / Math.tan((this.camera.fov * DEG) / 2)
    let best: { id: string; score: number } | null = null
    const v = this.tmpV
    for (const en of this.orderedEntities) {
      if (!en.group.visible || !(en.marker.visible || en.mesh.visible)) continue
      v.copy(en.group.position).project(this.camera)
      if (v.z > 1 || v.z < -1) continue
      const sx = ((v.x + 1) / 2) * rect.width
      const sy = ((1 - v.y) / 2) * rect.height
      const dist = Math.max(en.group.position.distanceTo(this.camera.position), 1e-12)
      const reach = Math.max(14, (en.mesh.scale.x / dist) * pxPerRad)
      const dd = Math.hypot(sx - px, sy - py)
      if (dd <= reach && (!best || dd / reach < best.score)) best = { id: en.def.id, score: dd / reach }
    }
    if (best) this.select(best.id)
    else if (this.gxCat && this.gxCat.points.visible && this.layers.galaxies) {
      const k = this.gxCat.pick(px, py, rect.width, rect.height, this.camera, this.origin)
      if (k >= 0) this.selectCatalogueGalaxy(k)
    }
  }

  private smallDiameter(e: Entity): number | null {
    return e.def.radiusKm === DEFAULT_MINOR_RADIUS_KM ? null : e.def.radiusKm * 2
  }
}
