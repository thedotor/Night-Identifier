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
import { getQualitySetting, planFor, probeGpuName, type QualityPlan } from '@renderer/lib/graphicsQuality'
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
const MAX_VIEW_AU = 3e13
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
  stars: boolean // the 3D star cloud and named stars
  hosts: boolean // stars with confirmed planets
  deepsky: boolean // nebulae and clusters at their true distance
  galaxies: boolean // the Milky Way, the Local Group and galaxies beyond
  constellations: boolean // constellation figures drawn between the stars at their true depths
}

export const DEFAULT_LAYERS: Layers = { orbits: true, labels: true, moons: true, minor: true, belts: true, stars: true, hosts: false, deepsky: true, galaxies: true, constellations: true }

export interface FocusOptions {
  /** camera distance from the body, AU */
  distance?: number
  /** view from this direction (ecliptic, from the body towards the camera) */
  direction?: Vec3
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
}

/** A camera standing on (or rising above) the Earth, seen from a photo's viewpoint. */
export interface SurfaceState {
  /** unit vector from the Earth's centre up through the observer, ecliptic J2000 */
  zenith: Vec3
  /** where the photo looks (ecliptic J2000), its roll and scale */
  view: LiftView
  altitudeM: number
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
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 1e-7, 2e14)
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
  private mode: 'orbit' | 'surface' = 'orbit'
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
  private readonly ro: ResizeObserver
  private disposed = false

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

    container.addEventListener('pointerdown', this.onDown)
    container.addEventListener('pointerup', this.onUp)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  // ---------- public API ----------

  setDate(ms: number): void {
    this.dateMs = Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms))
    this.updatePositions()
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
  getFocus(): string {
    return this.focusId
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
    this.dirty = true
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
        halo: null
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
          haloOpacity: 0.28
        }
      )
    }
    this.dedupeLocalGroup()
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
    const o: FocusOptions = typeof opts === 'number' ? { distance: opts } : (opts ?? {})
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
      dur: Math.min(4800, FLIGHT_MS + 260 * decades),
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
    this.camera.up.set(0, 0, 1)
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
      const facts = [{ label: 'Type', value: KIND_LABEL[e.def.kind] }, { label: 'Distance from the Sun', value: fmtFar(len3(e.pos)) }, ...f.facts]
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
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.container.removeEventListener('pointerdown', this.onDown)
    this.container.removeEventListener('pointerup', this.onUp)
    this.controls.dispose()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        ;(x as THREE.MeshStandardMaterial).map?.dispose()
        x.dispose()
      }
    })
    this.dot.dispose()
    this.glow.dispose()
    this.ring?.dispose()
    this.mwCloud?.glow.dispose()
    this.starGeo.dispose()
    this.ground?.geometry.dispose()
    ;(this.ground?.material as THREE.Material | undefined)?.dispose()
    for (const t of this.billboardTextures.values()) t.dispose()
    this.renderer.dispose()
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
    if (def.id === 'earth') this.buildAtmosphere(e)
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
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          #include <logdepthbuf_fragment>
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.2);
          gl_FragColor = vec4(0.30, 0.55, 1.0, clamp(f, 0.0, 1.0) * 0.85);
        }`
    })
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.028, 96, 48), material)
    shell.frustumCulled = false
    shell.renderOrder = 6
    e.mesh.add(shell) // a child of the globe, so it scales with it and hides with it near the ground
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
      if (e.def.id === 'earth' && m instanceof THREE.MeshStandardMaterial) {
        m.emissiveMap = t
        m.emissive.set(0x141a26)
      }
      m.needsUpdate = true
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
    // Belts only need to move when the date has changed enough to see (about a day).
    if (solarLive && !(Math.abs(jd - this.cloudJd) < 0.5)) {
      this.cloudJd = jd
      for (const c of this.clouds) {
        c.cloud.positions(jd, c.buffer)
        c.points.geometry.attributes.position.needsUpdate = true
      }
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
    this.controls.minDistance = e.far ? e.far.minDist : Math.max(e.radiusAU * (id === 'saturn' ? 1.4 : 1.15), 1.5e-6)
  }

  // ---------- frame loop ----------

  private frame = (now: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    let draw = this.dirty

    if (this.playing) {
      this.dateMs = Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, this.dateMs + this.speedDaysPerSec * dt * DAY_MS))
      this.updatePositions()
      draw = true
      if (now - this.lastTimeCb > TIME_CALLBACK_MS) {
        this.lastTimeCb = now
        this.cb.onTime?.(this.dateMs)
      }
    }

    const focus = this.entities.get(this.focusId)!
    if (this.mode === 'surface' && this.surface) {
      this.applySurfaceCamera()
      draw = true
    } else if (this.flight) {
      const f = this.flight
      const k = easeInOut(Math.min(1, (now - f.start) / f.dur))
      this.origin = [0, 1, 2].map((i) => f.fromOrigin[i] + (focus.pos[i] - f.fromOrigin[i]) * k) as Vec3
      const lf = Math.log(f.fromDist)
      const lt = Math.log(f.toDist)
      // Rise and fall on a log scale, but never so low that the start and the destination are both
      // out of sight: keep the camera at least 0.7 of the way to the nearer of them from the centre
      // of view, so a long trip is an arc over the gap instead of a slide through empty space.
      const sep = Math.min(len3(sub3(this.origin, f.fromOrigin)), len3(sub3(this.origin, focus.pos)))
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
      this.origin = [...focus.pos]
      if (this.playing) draw = true
    }
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

    for (const line of this.worldLines) line.position.set(-o[0], -o[1], -o[2])

    // The layers that are not entities: backdrop sky, 3D stars, hosts, the Milky Way.
    this.stars.position.copy(cam.position)
    this.stars.visible = A.backdrop > 0.01
    for (const c of this.stars.children) {
      const m = (c as THREE.Points).material as THREE.PointsMaterial
      m.opacity = ((m.userData.base as number) ?? 1) * A.backdrop
    }
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
      }
      if (hasHalo) {
        const halo = e.far!.halo!
        // Fade the glow out as you fly inside the object, or it would wash the whole screen.
        const inside = Math.min(1, Math.max(0, dist / e.radiusAU - 0.4) / 0.6)
        halo.visible = e.group.visible && screenR > HALO_MIN_PX
        halo.material.opacity = (e.far!.haloOpacity ?? 0.5) * tierA * inside
      }
      if (e.rot && e.mesh.visible) {
        // Sphere local axes: +x = prime meridian, +y = 90 deg east, +z = north pole.
        this.tmpM.makeBasis(ex.set(...e.rot.prime), this.tmpV2.set(...e.rot.east), this.tmpV3.set(...e.rot.north))
        e.mesh.quaternion.setFromRotationMatrix(this.tmpM)
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
    this.layoutSystem(cam, pxPerRad, L.labels)
    this.layoutBillboard(cam)
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
    b.sprite.material.opacity = 0.9 * Math.min(1, Math.max(0, d / b.width - 0.25) / 0.6) * (1 - ramp(d / b.width, 40, 400))
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
      const clash = v.z > 1 || x < -20 || x > W + 20 || y < -20 || y > H + 20 || placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)
      e.label.visible = !clash
      if (!clash) placed.push(box)
    }
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

  // ---------- picking ----------

  private select(id: string): void {
    this.focusOn(id)
    this.cb.onSelect?.(id)
  }

  private onDown = (e: PointerEvent): void => {
    // Pointer capture (OrbitControls) redirects later events to the container, so read the label now.
    this.down = { x: e.clientX, y: e.clientY, id: (e.target as HTMLElement).dataset?.ssId ?? null }
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.down
    this.down = null
    if (this.mode === 'surface') return
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return
    if (d.id) return this.select(d.id)
    const rect = this.renderer.domElement.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
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
  }

  private smallDiameter(e: Entity): number | null {
    return e.def.radiusKm === DEFAULT_MINOR_RADIUS_KM ? null : e.def.radiusKm * 2
  }
}
