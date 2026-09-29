import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { nsKey } from '@renderer/lib/storeNs'
import { api } from '@renderer/lib/api'
import { loadCatalogue } from '@renderer/lib/skyCatalogue'
import { GALACTIC_NORTH_ECLIPTIC } from '@renderer/lib/galaxyMath'
import { KIND_LABEL, type BodyKind, type DistancesData, type HostsData, type LocalGroupData, type OrbitData, type StarsData, type TextureData } from '@renderer/lib/solarSystemData'
import { useTheme } from '@renderer/theme/ThemeContext'
import { useSatCatalogue, useSatOptions } from '@renderer/components/sky/useSatellites'
import { elementAgeDays, MAX_ELEMENT_AGE_DAYS, medianEpochMs, recordsIn, SAT_GROUPS, type SatGroupId } from '@renderer/lib/satellites'
import { DEFAULT_LAYERS, SolarSystemEngine, type AircraftInfo, type BodyInfo, type FlyHud, type Layers, type ListItem, type TownHit, type WeatherStatus } from './solarSystemEngine'
import { useMyPlaces } from '@renderer/lib/myPlaces'
import { heightWords, speedWords } from '@renderer/lib/fly'
import { countKinds, flightLevel, parseAircraft, type AircraftPayload } from '@renderer/lib/aircraft'
import { AIRCRAFT_KINDS, kindInfo, type AircraftKind } from '@renderer/lib/aircraftIcons'
import { AircraftIcon, AircraftKindRows, useAircraftKinds } from '@renderer/components/aircraft/AircraftKinds'
import { bearingDeg, compassOf, cssColour, ageColour, distanceKm, formatKm } from '@renderer/lib/lightning'
import { playThunder } from '@renderer/lib/thunder'
import { useTraffic } from '@renderer/lib/traffic'
import { TrafficDetailCard, TrafficHistoryView, TrafficLists, TrafficPrivacyNote } from '@renderer/components/traffic/TrafficBits'
import { useLightningFeed } from '@renderer/components/lightning/useLightningFeed'
import { parsePlace, tidyCoordinates, usePlace } from '@renderer/components/dashboard/usePlace'
import { useAuroraGrid, useSpaceWeather } from '@renderer/components/aurora/useAurora'
import { chanceAt, chanceVerdict, gScale } from '@renderer/lib/aurora'
import { sunAltitudeDeg } from '@renderer/lib/skyTonight'
import { useSunActivity, useSunPicture } from '@renderer/components/sun/useSun'
import { useFlowGrid, type FlowState } from '@renderer/components/space/useFlow'
import { useShips } from './useShips'
import { useHeat, useQuakes, useVolcanoes } from './useHazards'
import { useAsteroids } from './useAsteroids'
import { useLaunches } from './useLaunches'
import { isUpcoming, type Launch } from '@renderer/lib/launches'
import { useAqiStations } from './useAqi'
import { aqiColour, aqiLabel, type AqiStation } from '@renderer/lib/aqi'
import { useIonosphereGrid } from '@renderer/components/space/useIonosphere'
import { ago, magnitudeWords, VOLCANO_LEVELS, WINDOWS, type QuakeHit, type QuakeInfo, type VolcanoHit, type VolcanoInfo } from '@renderer/lib/hazards'
import { headingText, SHIP_CATS, speedText, type ShipHit, type ShipInfo } from '@renderer/lib/ships'
import { currentWords, flowCss, sampleFlow, speedMax, toKnots, WIND_LEVELS, windWords, type WindLevel } from '@renderer/lib/flow'
import { FieldWindOptions, readFw, saveFw, type FieldWindState } from '@renderer/components/space/FieldWindMenu'
import { FieldWindPanel } from '@renderer/components/space/FieldWindPanel'
import { useEnlilFrame, useSpaceEnv } from '@renderer/components/space/useSpaceEnv'
import { windMarkers } from '@renderer/lib/windMarkers'
import { decimalYear } from '@renderer/lib/geomag'
import { SunPanel } from '@renderer/components/sun/SunPanel'
import { cmeDirection, flareWords, radioBlackout, relativeTime, SURFACE_KINDS, type Cme, type Flare, type SurfaceKind } from '@renderer/lib/sun'
import { flareColour } from './sunLayer'
import { SpaceWeatherBadge } from './SpaceWeatherBadge'
import type { RadiantHit } from './meteorLayer'
import { activeShowers, currentEclipseWindow, inActiveRange, SHOWERS } from '@renderer/lib/eventsSky'
import type { LightningMode, PickedStrike } from './lightningLayer'
import { ScaleRuler, type ScaleStop } from './ScaleRuler'
import { MenuHeading, MenuRow, MenuSub, PanelHeader, ToolbarMenu } from './panelChrome'
import { PANELS, usePanels } from './usePanels'
import { readSolarSession, saveSolarSession, type SolarSlot } from './solarSession'
import { loadUniverse } from './universeLoader'

interface Props {
  /** simulation start time (ms since epoch), e.g. the moment a photo was taken */
  startMs: number
  /** true when startMs is a photo's time, so the bar can offer a way back to it */
  fromPhoto: boolean
  focus: string | null
  /** NORAD number of a satellite to fly to and follow (from the satellite card in Sky Overlay or Live View) */
  followSat?: number | null
  /** open looking down on a place on the Earth (from a click in the earthquake or volcano lists), with that layer switched on */
  viewAt?: { latDeg: number; lonDeg: number; show?: 'quakes' | 'volcanoes' } | null
  /** inside a dashboard card (the monitoring window): the Find list and the info column start folded, nothing navigates away, and the view is not remembered for the Deep Space page */
  compact?: boolean
  /** just the Earth: the same menus and switches, but no stars, galaxies or Find list (the planets, the Sun and the space weather stay) */
  earthOnly?: boolean
}

const DAY_MS = 86_400_000
const SLIDER_DAYS = 366
const SPEEDS: { label: string; days: number }[] = [
  { label: 'Real time', days: 1 / 86_400 },
  { label: '1 minute / s', days: 1 / 1440 },
  { label: '1 hour / s', days: 1 / 24 },
  { label: '1 day / s', days: 1 },
  { label: '1 week / s', days: 7 },
  { label: '1 month / s', days: 30.44 },
  { label: '1 year / s', days: 365.25 },
  { label: '10 years / s', days: 3652.5 },
  { label: '100 years / s', days: 36_525 },
  { label: '1,000 years / s', days: 365_250 },
  { label: '10,000 years / s', days: 3_652_500 },
  { label: '100,000 years / s', days: 36_525_000 }
]
const DEFAULT_SPEED_IDX = SPEEDS.findIndex((s) => s.days === 1)
const REAL_TIME_IDX = 0
const ALL_GROUPS: SatGroupId[] = ['iss', 'stations', 'visual', 'starlink', 'active']
const HOME_DIRECTION: [number, number, number] = [0.35, -1, 0.7]
/** One-click scales from a planet to the neighbouring galaxies. */
const STOPS: ScaleStop[] = [
  { label: 'Inner', au: 4, focus: 'sun', title: 'The Sun and Mercury to Mars' },
  { label: 'Outer', au: 45, focus: 'sun', title: 'Out to Neptune and Pluto' },
  { label: 'Full', au: 160, focus: 'sun', title: 'The Kuiper belt and the distant dwarf planets' },
  { label: 'Stars', au: 2e6, focus: 'sun', title: 'The Sun and the stars around it, in 3D' },
  { label: 'Galaxy', au: 1.1e10, focus: 'milkyway', direction: [...GALACTIC_NORTH_ECLIPTIC], title: 'The Milky Way from above' },
  { label: 'Local Group', au: 6e11, focus: 'milkyway', direction: HOME_DIRECTION, title: 'The Milky Way, Andromeda and their neighbours' },
  { label: 'Beyond', au: 5e12, focus: 'milkyway', direction: HOME_DIRECTION, title: 'Galaxies out to the Virgo Cluster' },
  { label: 'Cosmic web', au: 1.1e14, focus: 'sun', direction: HOME_DIRECTION, title: 'About 43,000 real galaxies out to 1.4 billion light-years: clusters, filaments and voids. Click one to fly to it.' }
]
/** The scale bar's jumps when only the Earth is wanted. */
const EARTH_STOPS: ScaleStop[] = [{ label: 'Earth', au: 1.5e-4, focus: 'earth', title: 'The whole Earth' }, ...STOPS.slice(0, 3)]
const LAYER_LABELS: { key: keyof Layers; label: string; title?: string }[] = [
  { key: 'orbits', label: 'Orbits' },
  { key: 'labels', label: 'Labels' },
  { key: 'moons', label: 'Moons' },
  { key: 'minor', label: 'Dwarfs, asteroids, comets' },
  { key: 'belts', label: 'Belts' },
  {
    key: 'streams',
    label: 'Meteoroid streams',
    title:
      "A scatter of debris riding each active meteor shower's parent comet or asteroid orbit, brightest near the point where Earth's own orbit actually crosses the stream. Speed up time to see it flow."
  },
  { key: 'stars', label: 'Stars' },
  { key: 'constellations', label: 'Constellations' },
  { key: 'hosts', label: 'Planet hosts' },
  { key: 'deepsky', label: 'Nebulae & clusters' },
  { key: 'galaxies', label: 'Galaxies' }
]
const GROUP_ORDER: { kind: BodyKind; label: string }[] = [
  { kind: 'star', label: 'Stars' },
  { kind: 'planet', label: 'Planets' },
  { kind: 'dwarf', label: 'Dwarf planets' },
  { kind: 'asteroid', label: 'Asteroids' },
  { kind: 'comet', label: 'Comets' },
  { kind: 'moon', label: 'Moons' },
  { kind: 'nebula', label: 'Nebulae' },
  { kind: 'cluster', label: 'Star clusters' },
  { kind: 'galaxy', label: 'Galaxies' },
  { kind: 'constellation', label: 'Constellations (3D)' }
]
/** Long groups show this many until you search or expand them. */
const GROUP_PREVIEW = 30

const RED_NIGHT_FILTER = 'grayscale(1) sepia(1) hue-rotate(-50deg) saturate(6) brightness(0.85)'
const J2000_MS = Date.UTC(2000, 0, 1, 12)
/** Beyond this many years from J2000 the planets are not computed (the stars keep moving). */
const PLANET_YEARS_OK = 2000
const yearsFromJ2000 = (ms: number): number => (ms - J2000_MS) / (365.25 * DAY_MS)
/** Value for a datetime-local box; blank when the year is outside what the box can show. */
const utcInput = (ms: number): string => {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  return y >= 1000 && y <= 9999 ? d.toISOString().slice(0, 19) : ''
}
const fmtYear = (ms: number): string => {
  const y = Math.round(2000 + yearsFromJ2000(ms))
  return y > 0 ? `year ${y.toLocaleString()} CE` : `${(1 - y).toLocaleString()} BCE`
}

const flag = (key: string, initial: boolean): boolean => {
  try {
    const v = localStorage.getItem(nsKey(key))
    return v === null ? initial : v === 'on'
  } catch {
    return initial
  }
}
const saveFlag = (key: string, on: boolean): void => {
  try {
    localStorage.setItem(nsKey(key), on ? 'on' : 'off')
  } catch {
    /* not remembered */
  }
}
const LIGHTNING_KEY = 'night-identifier:lightning'
const LIGHTNING_WINDOW_KEY = 'night-identifier:lightning-window'
const LIGHTNING_MODE_KEY = 'night-identifier:lightning-mode'
const THUNDER_KEY = 'night-identifier:lightning-thunder'
const TRAFFIC_ACK_KEY = 'night-identifier:traffic-ack'
const readWindow = (): number => {
  try {
    const v = Number(localStorage.getItem(nsKey(LIGHTNING_WINDOW_KEY)))
    return Number.isFinite(v) && v >= 1 && v <= 60 ? v : 10
  } catch {
    return 10
  }
}
const readMode = (): LightningMode => {
  try {
    const v = localStorage.getItem(nsKey(LIGHTNING_MODE_KEY))
    return v === 'flashes' || v === 'heat' || v === 'both' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
const AURORA_KEY = 'night-identifier:aurora'
const SUN_KEY = 'night-identifier:live-sun'
const HOME_KEY = 'night-identifier:home-dot'
const FULL_DAY_KEY = 'night-identifier:earth-full-daylight'
const SUN_CORONA_KEY = 'night-identifier:sun-corona'
const SUN_CMES_KEY = 'night-identifier:sun-cmes'
const SUN_SPOTS_KEY = 'night-identifier:sun-spots'
const SUN_FLARES_KEY = 'night-identifier:sun-flares'
const ASTEROIDS_KEY = 'night-identifier:asteroids'
const METEORS_KEY = 'night-identifier:meteors'
const ECLIPSE_KEY = 'night-identifier:eclipse-shadow'
const SUN_KIND_KEY = 'night-identifier:sun-surface'
const readSunKind = (): SurfaceKind => {
  try {
    const v = localStorage.getItem(nsKey(SUN_KIND_KEY))
    return SURFACE_KINDS.some((k) => k.kind === v) ? (v as SurfaceKind) : 'euv'
  } catch {
    return 'euv'
  }
}
const CITIES_KEY = 'night-identifier:city-names'
const TOWNS_KEY = 'night-identifier:town-names'

interface TownsPayload {
  countries: string[]
  regions: string[]
  rows: (string | number)[][]
}
const ISS_ORBIT_KEY = 'night-identifier:iss-orbit'
const LAUNCHES_KEY = 'night-identifier:launches'
const OZONE_KEY = 'night-identifier:ozone'
const RAIN_KEY = 'night-identifier:rain'
const AQI_KEY = 'night-identifier:aqi'
const IONO_KEY = 'night-identifier:ionosphere'
const AIRCRAFT_KEY = 'night-identifier:aircraft-3d'
const AIRCRAFT_REFRESH_MS = 5 * 60_000
const CLOUDS_KEY = 'night-identifier:live-clouds'
const readClouds = (): boolean => {
  try {
    return localStorage.getItem(nsKey(CLOUDS_KEY)) !== 'off'
  } catch {
    return true
  }
}
const SIDEBAR_KEY = 'night-identifier:solar-find-sidebar'
const INFO_KEY = 'night-identifier:solar-info-panel'
const SHIPS_KEY = 'night-identifier:ships-3d'
const QUAKES_KEY = 'night-identifier:quakes-3d'
const QUAKE_MIN_KEY = 'night-identifier:quake-min'
const QUAKE_HOURS_KEY = 'night-identifier:quake-hours'
const VOLCANOES_KEY = 'night-identifier:volcanoes-3d'
const VOLCANO_ALL_KEY = 'night-identifier:volcano-all'
const HEAT_KEY = 'night-identifier:heat-3d'
const readChoice = (key: string, allowed: number[], initial: number): number => {
  try {
    const v = Number(localStorage.getItem(nsKey(key)))
    return allowed.includes(v) ? v : initial
  } catch {
    return initial
  }
}
const QUAKE_MAGS = [1, 2, 2.5, 3, 4, 5, 6, 7]
const WIND_KEY = 'night-identifier:wind-3d'
const WIND_LEVEL_KEY = 'night-identifier:wind-level'
const CURRENTS_KEY = 'night-identifier:currents-3d'
const readWindLevel = (): WindLevel => {
  try {
    const v = localStorage.getItem(nsKey(WIND_LEVEL_KEY))
    return WIND_LEVELS.some((l) => l.id === v) ? (v as WindLevel) : '10m'
  } catch {
    return '10m'
  }
}
const dayClock = (ms: number): string => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
/** The line under a wind or currents switch: what is loaded, or why nothing is. */
const flowStatus = (st: FlowState, covers: string): string | undefined =>
  st.status === 'loading'
    ? 'Loading…'
    : st.status === 'nodata'
      ? `No data for this date: it covers ${covers}`
      : st.status === 'error'
        ? `${st.message ?? 'Could not load'}${st.grid ? ' (showing the last picture)' : ''}`
        : st.grid
          ? `Model time ${dayClock(st.grid.validMs)}`
          : undefined
/** A colour bar for one flow layer, in m/s and knots at the fast end. */
function FlowLegend({ label, max }: { label: string; max: number }): ReactElement {
  return (
    <div>
      <div className="flex justify-between text-[11px]">
        <span>{label}</span>
        <span className="tabular-nums">
          {max} m/s or more ({Math.round(toKnots(max) * (max < 5 ? 10 : 1)) / (max < 5 ? 10 : 1)} kt)
        </span>
      </div>
      <div className="h-2 rounded" style={{ background: flowCss() }} />
      <div className="flex justify-between text-[10px]">
        <span>calm</span>
        <span>fast</span>
      </div>
    </div>
  )
}
const SAT_KEY = 'night-identifier:satellites-3d'
const LAYERS_KEY = 'night-identifier:solar-layers'
const readLayers = (): Layers => {
  try {
    const raw = JSON.parse(localStorage.getItem(nsKey(LAYERS_KEY)) ?? 'null') as Partial<Layers> | null
    const out = { ...DEFAULT_LAYERS }
    if (raw) for (const k of Object.keys(out) as (keyof Layers)[]) if (typeof raw[k] === 'boolean') out[k] = raw[k]
    return out
  } catch {
    return DEFAULT_LAYERS
  }
}
const SOLAR_LAYERS: (keyof Layers)[] = ['orbits', 'labels', 'moons', 'minor', 'belts', 'streams']
const DEEP_LAYERS: (keyof Layers)[] = ['stars', 'constellations', 'hosts', 'deepsky', 'galaxies']
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const btn = 'rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-40'

/** The 3D solar system: orbit any body, fly to it, and scrub time from the photo's moment. */
export function SolarSystemView({ startMs, fromPhoto, focus, followSat = null, compact = false, viewAt = null, earthOnly = false }: Props): ReactElement {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const mount = useRef<HTMLDivElement>(null)
  const engine = useRef<SolarSystemEngine | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [items, setItems] = useState<ListItem[]>([])
  // Coming back from another page: put the view, the date and the speed back as they were left (unless a link asks for something).
  // The Earth page always asks for the Earth; that is its default, not a link, so it can still be put back as it was.
  const slot: SolarSlot = earthOnly ? 'earth' : 'solar'
  const linkFocus = earthOnly && focus === 'earth' ? null : focus
  const [restore] = useState(() => (!compact && !fromPhoto && !linkFocus && !viewAt && followSat === null ? readSolarSession(slot) : null))
  const [begin] = useState(() => (restore && !(restore.playing && !restore.reverse && restore.speedIdx === REAL_TIME_IDX) ? restore.ms : startMs))
  const [selected, setSelected] = useState(linkFocus ?? restore?.focus ?? focus ?? 'sun')
  const [info, setInfo] = useState<BodyInfo | null>(null)
  const [layers, setLayers] = useState<Layers>(readLayers)
  const [ms, setMs] = useState(begin)
  // A version of `ms` that only updates about once a second: scrubbing or fast playback can change `ms` every frame,
  // and a few things (meteor showers, eclipses) run real astronomy-engine searches too slow to redo that often.
  const msRef = useRef(ms)
  msRef.current = ms
  const [slowMs, setSlowMs] = useState(ms)
  useEffect(() => {
    const t = window.setInterval(() => setSlowMs(msRef.current), 1000)
    return () => window.clearInterval(t)
  }, [])
  const [sliderBase, setSliderBase] = useState(begin)
  // Opened on its own (not from a photo or a satellite), the scene runs on the real clock: the Sun, and so the day and night on the Earth, are where they really are.
  const [playing, setPlaying] = useState(restore ? restore.playing : !fromPhoto && followSat === null)
  const [speedIdx, setSpeedIdx] = useState(restore ? restore.speedIdx : fromPhoto || followSat !== null ? DEFAULT_SPEED_IDX : REAL_TIME_IDX)
  const [sun, setSun] = useState<{ latDeg: number; lonDeg: number } | null>(null)
  const [satOptions, setSatOptions] = useSatOptions()
  const [satOn, setSatOn] = useState(() => followSat !== null || restore?.sat != null || flag(SAT_KEY, false))
  const [wantAll, setWantAll] = useState(false) // a followed satellite may be in a group that is not switched on
  const [satSel, setSatSel] = useState<number | null>(null)
  const [following, setFollowing] = useState<number | null>(null)
  const [satNote, setSatNote] = useState<string | null>(null)
  const [clouds, setClouds] = useState(readClouds)
  const [ozoneOn, setOzoneOn] = useState(() => flag(OZONE_KEY, false))
  const [rainOn, setRainOn] = useState(() => flag(RAIN_KEY, false))
  const [ionoOn, setIonoOn] = useState(() => flag(IONO_KEY, false))
  const ionoGrid = useIonosphereGrid(ionoOn)
  const [weather, setWeather] = useState<WeatherStatus>({ state: 'off' })
  const [issOrbit, setIssOrbit] = useState(() => flag(ISS_ORBIT_KEY, true))
  const [launchesOn, setLaunchesOn] = useState(() => flag(LAUNCHES_KEY, false))
  const [launchHit, setLaunchHit] = useState<Launch | null>(null)
  const launchFeed = useLaunches(launchesOn)
  const [cityNames, setCityNames] = useState(() => flag(CITIES_KEY, true))
  const [townNames, setTownNames] = useState(() => flag(TOWNS_KEY, false))
  const [townsState, setTownsState] = useState<'off' | 'loading' | 'ready' | 'error'>('off')
  const [townHit, setTownHit] = useState<TownHit | null>(null)
  const cityRows = useRef<(string | number)[][] | null>(null)
  const townRows = useRef<(string | number)[][] | null>(null)
  const usingTowns = useRef(false)
  const { places: myPlaces, add: addMyPlace, remove: removeMyPlace, rename: renameMyPlace } = useMyPlaces()
  const [placeMode, setPlaceMode] = useState(false)
  const [placeSel, setPlaceSel] = useState<string | null>(null)
  const [placeDraft, setPlaceDraft] = useState<{ name: string; lat: string; lon: string } | null>(null)
  const [placeError, setPlaceError] = useState<string | null>(null)
  const [lightningOn, setLightningOn] = useState(() => flag(LIGHTNING_KEY, true))
  const [lightWindow, setLightWindow] = useState(readWindow)
  const [lightMode, setLightMode] = useState<LightningMode>(readMode)
  const [thunder, setThunder] = useState(() => flag(THUNDER_KEY, true))
  const [auroraOn, setAuroraOn] = useState(() => flag(AURORA_KEY, true))
  const [sunOn, setSunOn] = useState(() => flag(SUN_KEY, true))
  const [sunCorona, setSunCorona] = useState(() => flag(SUN_CORONA_KEY, true))
  const [sunCmes, setSunCmes] = useState(() => flag(SUN_CMES_KEY, true))
  const [sunSpots, setSunSpots] = useState(() => flag(SUN_SPOTS_KEY, true))
  const [sunFlares, setSunFlares] = useState(() => flag(SUN_FLARES_KEY, true))
  const [asteroidsOn, setAsteroidsOn] = useState(() => flag(ASTEROIDS_KEY, false))
  const asteroids = useAsteroids(asteroidsOn)
  const [meteorsOn, setMeteorsOn] = useState(() => flag(METEORS_KEY, true))
  const [meteorHit, setMeteorHit] = useState<RadiantHit | null>(null)
  const [eclipseOn, setEclipseOn] = useState(() => flag(ECLIPSE_KEY, true))
  const [sunKind, setSunKind] = useState<SurfaceKind>(readSunKind)
  const [strike, setStrike] = useState<PickedStrike | null>(null)
  const traffic = useTraffic()
  const [trafficSel, setTrafficSel] = useState<string | null>(null)
  const [trafficHistory, setTrafficHistory] = useState(false)
  const [windOn, setWindOn] = useState(() => flag(WIND_KEY, false))
  const [windLevel, setWindLevel] = useState<WindLevel>(readWindLevel)
  const [currentsOn, setCurrentsOn] = useState(() => flag(CURRENTS_KEY, false))
  const [flowPick, setFlowPick] = useState<{ latDeg: number; lonDeg: number } | null>(null)
  const { place, raw: rawPlace, save: savePlace } = usePlace()
  const [fw, setFw] = useState<FieldWindState>(readFw)
  const [fwTick, setFwTick] = useState(0)
  const [flyHud, setFlyHud] = useState<FlyHud | null>(null)
  const [homeOn, setHomeOn] = useState(() => flag(HOME_KEY, true))
  const [homeForm, setHomeForm] = useState<{ lat: string; lon: string } | null>(null)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [followingHome, setFollowingHome] = useState(false)
  const [fullDay, setFullDay] = useState(() => flag(FULL_DAY_KEY, false))
  const [planesOn, setPlanesOn] = useState(() => flag(AIRCRAFT_KEY, false))
  const [planeStatus, setPlaneStatus] = useState<{ state: 'off' | 'loading' | 'live' | 'error'; count?: number; fetchedAt?: number; message?: string; typesReady?: boolean }>({ state: 'off' })
  const [planeCounts, setPlaneCounts] = useState<Partial<Record<AircraftKind, number>>>({})
  const planeKinds = useAircraftKinds()
  const planeHidden = useRef(planeKinds.hidden)
  planeHidden.current = planeKinds.hidden
  const [plane, setPlane] = useState<AircraftInfo | null>(null)
  const [quakesOn, setQuakesOn] = useState(() => flag(QUAKES_KEY, true) || viewAt?.show === 'quakes')
  const [quakeMin, setQuakeMin] = useState(() => readChoice(QUAKE_MIN_KEY, QUAKE_MAGS, 2.5))
  const [quakeHours, setQuakeHours] = useState(() => readChoice(QUAKE_HOURS_KEY, WINDOWS.map((w) => w.hours), 24))
  const [volcanoesOn, setVolcanoesOn] = useState(() => flag(VOLCANOES_KEY, true) || viewAt?.show === 'volcanoes')
  const [volcanoAll, setVolcanoAll] = useState(() => flag(VOLCANO_ALL_KEY, true))
  const [heatOn, setHeatOn] = useState(() => flag(HEAT_KEY, false))
  const [aqiOn, setAqiOn] = useState(() => flag(AQI_KEY, false))
  const [aqiHit, setAqiHit] = useState<AqiStation | null>(null)
  const aqiFeed = useAqiStations(aqiOn)
  const [quakeHit, setQuakeHit] = useState<QuakeHit | null>(null)
  const [quakeInfo, setQuakeInfo] = useState<QuakeInfo | null>(null)
  const [volcanoHit, setVolcanoHit] = useState<VolcanoHit | null>(null)
  const [volcanoInfo, setVolcanoInfo] = useState<VolcanoInfo | null>(null)
  const [cmeHit, setCmeHit] = useState<Cme | null>(null)
  const [flareHit, setFlareHit] = useState<Flare | null>(null)
  const [shipsOn, setShipsOn] = useState(() => restore?.ship != null || flag(SHIPS_KEY, false))
  const [shipHit, setShipHit] = useState<ShipHit | null>(null)
  const [shipInfo, setShipInfo] = useState<ShipInfo | null>(null)
  const [followingShip, setFollowingShip] = useState<number | null>(null)
  const [shipResults, setShipResults] = useState<{ mmsi: number; name: string; cat: number }[]>([])
  const pendingShip = useRef<number | null>(restore?.ship ?? null)
  const followedOnce = useRef(false)
  const [reverse, setReverse] = useState(restore?.reverse ?? false)
  const live = playing && speedIdx === REAL_TIME_IDX && !reverse && Math.abs(ms - Date.now()) < 5000
  const [query, setQuery] = useState('')
  const [offline, setOffline] = useState<string[]>([])
  const [credits, setCredits] = useState<string[]>([])
  const [viewAU, setViewAU] = useState(14)
  const [expanded, setExpanded] = useState<Set<BodyKind>>(new Set())
  const [sideOpen, setSideOpen] = useState(() => flag(SIDEBAR_KEY, !compact))
  const [infoOpen, setInfoOpen] = useState(() => flag(INFO_KEY, !compact))
  const [menu, setMenu] = useState<string | null>(null)
  const { panels, update: updatePanel, setAllShown } = usePanels()
  const menuAt = (id: string): { open: boolean; onToggle: () => void; onClose: () => void } => ({
    open: menu === id,
    onToggle: () => setMenu((m) => (m === id ? null : id)),
    onClose: () => setMenu((m) => (m === id ? null : m))
  })

  // Latest values for the engine callbacks, which are created once.
  const startRef = useRef(begin)
  const restoreRef = useRef(restore)
  const viewAtRef = useRef(viewAt)
  // The speed and play state as of the latest render, for saving when the page is left.
  const clockRef = useRef({ speedIdx, reverse, playing })
  clockRef.current = { speedIdx, reverse, playing }
  const focusRef = useRef(restore ? null : focus)
  const flownRef = useRef(false)

  useEffect(() => {
    const el = mount.current
    if (!el) return
    let eng: SolarSystemEngine
    try {
      eng = new SolarSystemEngine(el, {
        onSelect: (id) => {
          setSelected(id)
          setSatSel(null)
        },
        onTime: setMs,
        onView: (v) => setViewAU(v.distanceAU),
        onSatelliteSelect: setSatSel,
        onWeather: setWeather,
        onAircraftSelect: setPlane,
        onShipSelect: setShipHit,
        onQuakeSelect: setQuakeHit,
        onVolcanoSelect: setVolcanoHit,
        onCmeSelect: setCmeHit,
        onFlareSelect: setFlareHit,
        onMeteorSelect: setMeteorHit,
        onLaunchSelect: setLaunchHit,
        onAqiSelect: setAqiHit,
        onShipLost: () => setFollowingShip(null),
        onHomeFollow: setFollowingHome,
        onHomeClick: () => eng.followHome(!eng.isFollowingHome()),
        onTownSelect: (t) => {
          setTownHit(t)
          if (t) setPlaceSel(null)
        },
        onPlaceSelect: (id) => {
          setPlaceSel(id)
          setTownHit(null)
        },
        onPlacePick: (spot) => {
          eng.setPlacePicking(false)
          setPlaceMode(false)
          setPlaceDraft({ name: '', lat: spot.latDeg.toFixed(4), lon: spot.lonDeg.toFixed(4) })
        },
        onSun: setSun,
        onStrikeSelect: setStrike,
        onTrafficSelect: setTrafficSel,
        onEarthPick: setFlowPick,
        onFly: setFlyHud,
        onSatelliteLost: () => {
          setFollowing(null)
          setSatNote('That satellite’s orbit data does not reach this moment, so the camera let go.')
        }
      })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'WebGL is not available')
      return
    }
    engine.current = eng
    // In development React mounts every page twice; this engine is a new one, so nothing has been flown to or followed yet.
    flownRef.current = false
    followedOnce.current = false
    restoredSat.current = false
    eng.setDate(startRef.current)

    let live = true
    // Datasets arrive one by one; the body a link points at may not exist until its data does.
    const refresh = (): void => {
      setItems(eng.list())
      if (focusRef.current && !flownRef.current && eng.list().some((i) => i.id === focusRef.current)) {
        flownRef.current = true
        eng.focusOn(focusRef.current)
      }
      if (viewAtRef.current && !flownRef.current) {
        flownRef.current = true
        eng.viewLatLon(viewAtRef.current.latDeg, viewAtRef.current.lonDeg, 1800)
      }
      const r = restoreRef.current
      if (r && !flownRef.current && eng.list().some((i) => i.id === r.focus)) {
        flownRef.current = true
        // following something: start over the Earth and let the follow (below) fly the last bit
        if (r.homeFollow || r.satFollowing || r.ship != null) eng.focusOn('earth', { distance: r.homeFollow ? r.distance : undefined, instant: true })
        else eng.focusOn(r.focus, { distance: r.distance, direction: r.direction, instant: true })
      }
    }
    refresh()
    loadUniverse(eng, {
      live: () => live,
      onCredit: (c) => setCredits((cs) => (c && !cs.includes(c) ? [...cs, c] : cs)),
      onMissing: (what) => setOffline((o) => (o.includes(what) ? o : [...o, what])),
      onLoaded: refresh
    })

    // Leaving the page, closing the app, and every few seconds in between (a closed window does not always get to say goodbye)
    let gone = false
    const save = (): void => {
      if (compact || gone) return
      // the saved view has not been put back yet (the data is still loading): saving now would overwrite it with the start-up view
      if (restoreRef.current && !flownRef.current) return
      saveSolarSession(slot, eng.viewState(), { ms: eng.getDate(), ...clockRef.current })
    }
    const timer = window.setInterval(save, 4000)
    window.addEventListener('pagehide', save)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener('pagehide', save)
      save()
      gone = true
      eng.dispose()
      engine.current = null
    }
  }, [])

  useEffect(() => {
    engine.current?.setLayers(earthOnly ? { ...layers, stars: false, constellations: false, hosts: false, deepsky: false, galaxies: false, minor: false, belts: false, streams: false } : layers)
    try {
      localStorage.setItem(nsKey(LAYERS_KEY), JSON.stringify(layers))
    } catch {
      /* not remembered */
    }
  }, [layers])
  useEffect(() => {
    if (earthOnly) engine.current?.setMaxDistanceAU(400) // out past Neptune and no further: there is nothing else to see
  }, [earthOnly])
  // Just the Earth: switching on the Sun's layers from a close view of the Earth flies out to where they can be seen (the Sun is 1 AU away).
  const sunPrev = useRef({ sunOn, sunCorona, sunCmes, sunSpots })
  useEffect(() => {
    const p = sunPrev.current
    sunPrev.current = { sunOn, sunCorona, sunCmes, sunSpots }
    if (!earthOnly) return
    const v = engine.current?.viewState()
    if (!v || v.focus !== 'earth' || v.distance > 0.01) return
    if ((sunCmes && !p.sunCmes) || (sunOn && !p.sunOn && sunCmes)) engine.current?.viewSunAndEarth()
    else if ((sunOn && !p.sunOn) || (sunCorona && !p.sunCorona) || (sunSpots && !p.sunSpots)) engine.current?.viewSunFromEarth(7)
  }, [earthOnly, sunOn, sunCorona, sunCmes, sunSpots])
  useEffect(() => saveFlag(SIDEBAR_KEY, sideOpen), [sideOpen])
  useEffect(() => saveFlag(INFO_KEY, infoOpen), [infoOpen])
  useEffect(() => {
    if (followSat === null) saveFlag(SAT_KEY, satOn)
  }, [satOn, followSat])
  useEffect(() => {
    engine.current?.setSpeed((reverse ? -1 : 1) * SPEEDS[speedIdx].days)
  }, [speedIdx, reverse])
  useEffect(() => engine.current?.setPlaying(playing), [playing])
  useEffect(() => {
    engine.current?.setLiveClouds(clouds)
    try {
      localStorage.setItem(nsKey(CLOUDS_KEY), clouds ? 'on' : 'off')
    } catch {
      /* not remembered */
    }
  }, [clouds])
  useEffect(() => {
    engine.current?.setOzoneLayer(ozoneOn)
    saveFlag(OZONE_KEY, ozoneOn)
  }, [ozoneOn])
  useEffect(() => {
    engine.current?.setRainLayer(rainOn)
    saveFlag(RAIN_KEY, rainOn)
  }, [rainOn])
  useEffect(() => {
    engine.current?.setIonosphereVisible(ionoOn)
    saveFlag(IONO_KEY, ionoOn)
  }, [ionoOn])
  useEffect(() => {
    if (ionoGrid.grid) engine.current?.setIonosphereGrid(ionoGrid.grid)
  }, [ionoGrid.grid])

  // ---------- aurora ----------
  const aurora = useAuroraGrid(auroraOn)
  const spaceWx = useSpaceWeather(true)
  useEffect(() => {
    if (aurora.grid) engine.current?.setAuroraGrid(aurora.grid)
  }, [aurora.grid])
  useEffect(() => {
    engine.current?.setAurora(auroraOn)
    saveFlag(AURORA_KEY, auroraOn)
  }, [auroraOn])
  const minuteKey = Math.floor(Date.now() / 60_000)
  const auroraHere = (() => {
    if (!aurora.grid || !place) return null
    const chance = chanceAt(aurora.grid, place.latDeg, place.lonDeg)
    return { chance, verdict: chanceVerdict(chance, sunAltitudeDeg(place, new Date(minuteKey * 60_000)), place.latDeg) }
  })()

  // ---------- fly-through ----------
  const toggleFly = (): void => {
    const e = engine.current
    if (!e) return
    if (e.isFly()) e.exitFly()
    else {
      e.enterFly()
      setFlyHud({ name: '', heightAU: 0, speedAUps: 0, mul: 1, boost: false, locked: false, touching: false })
    }
  }
  const toggleFlyRef = useRef(toggleFly)
  toggleFlyRef.current = toggleFly
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      toggleFlyRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    engine.current?.setFullDaylight(fullDay)
    saveFlag(FULL_DAY_KEY, fullDay)
  }, [fullDay])

  // ---------- my location ----------
  useEffect(() => {
    engine.current?.setHome(homeOn ? place : null)
    saveFlag(HOME_KEY, homeOn)
  }, [homeOn, place?.latDeg, place?.lonDeg]) // eslint-disable-line react-hooks/exhaustive-deps
  const submitHome = (): void => {
    if (!homeForm) return
    const t = tidyCoordinates(homeForm.lat, homeForm.lon)
    if (!parsePlace(t.lat, t.lon)) {
      setHomeError('Latitude is -90 to 90 and longitude -180 to 180, in degrees (west and south are negative, or add W / S).')
      return
    }
    savePlace(t.lat, t.lon)
    setHomeError(null)
    setHomeForm(null)
    setHomeOn(true)
    window.setTimeout(() => engine.current?.viewHome(), 60)
  }

  // ---------- the live Sun ----------
  const sunSurface = useSunPicture(sunKind, sunOn, ms, (b) => engine.current?.setSunSurface(sunKind, b))
  const sunC2 = useSunPicture('c2', sunOn && sunCorona, ms, (b) => engine.current?.setSunCorona('c2', b))
  useSunPicture('c3', sunOn && sunCorona, ms, (b) => engine.current?.setSunCorona('c3', b))
  const sunAct = useSunActivity(true, ms)

  // ---------- the magnetic field and the solar wind ----------
  const spaceEnv = useSpaceEnv(fw.on)
  const enlil = useEnlilFrame(fw.on && fw.sheet, fw.sheetPanel, ms, (b, au) => engine.current?.setWindSheet(b, au))
  useEffect(() => {
    engine.current?.setMagnetoFlags({ lines: fw.on && fw.lines, map: fw.on && fw.map, mapKind: fw.mapKind, surfaces: fw.on && fw.surfaces, stations: fw.on && fw.stations })
    engine.current?.setRadiationBelts(fw.on && fw.belts)
    engine.current?.setWindFlags({ stream: fw.on && fw.stream, markers: fw.on && fw.markers, sheet: fw.on && fw.sheet })
    saveFw(fw)
  }, [fw])
  const stationRows = useMemo(() => spaceEnv.stations?.stations.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, range_1h: s.range_1h, max_step: s.max_step, f: s.f, time: s.time })) ?? [], [spaceEnv.stations])
  const swNow = spaceWx.data?.solar_wind_now
  useEffect(() => {
    engine.current?.setMagnetoData({
      wind: { speed: swNow?.speed ?? null, density: swNow?.density ?? null, bz: swNow?.bz ?? null, bt: swNow?.bt ?? null, temperature: swNow?.temperature ?? null },
      kp: spaceWx.data?.kp_now ?? null,
      dst: spaceEnv.dst?.now?.[1] ?? null,
      stations: stationRows
    })
  }, [swNow?.speed, swNow?.density, swNow?.bz, swNow?.bt, swNow?.temperature, spaceWx.data?.kp_now, spaceEnv.dst, stationRows]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    engine.current?.setElectronFlux(spaceWx.data?.electron_flux_2mev?.flux ?? null)
  }, [spaceWx.data?.electron_flux_2mev?.flux])
  useEffect(() => {
    const t = window.setInterval(() => setFwTick((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (!fw.on) return
    engine.current?.setWindMarkers(windMarkers({ cmes: sunAct.data?.cmes ?? null, wind: spaceWx.data?.solar_wind ?? null, enlilRows: spaceEnv.enlilEarth?.rows ?? null }, Date.now()))
  }, [fw.on, sunAct.data, spaceWx.data, spaceEnv.enlilEarth, fwTick])
  useEffect(() => {
    engine.current?.setSunFlags({ surface: sunOn, corona: sunOn && sunCorona, cmes: sunOn && sunCmes, spots: sunOn && sunSpots, flares: sunOn && sunFlares })
    saveFlag(SUN_KEY, sunOn)
    saveFlag(SUN_CORONA_KEY, sunCorona)
    saveFlag(SUN_CMES_KEY, sunCmes)
    saveFlag(SUN_SPOTS_KEY, sunSpots)
    saveFlag(SUN_FLARES_KEY, sunFlares)
  }, [sunOn, sunCorona, sunCmes, sunSpots, sunFlares])
  useEffect(() => {
    if (sunAct.data) engine.current?.setSunActivity(sunAct.data.cmes, sunAct.data.regions, sunAct.data.flares)
  }, [sunAct.data])
  useEffect(() => {
    try {
      localStorage.setItem(nsKey(SUN_KIND_KEY), sunKind)
    } catch {
      /* not remembered */
    }
  }, [sunKind])

  // ---------- lightning ----------
  const thunderRef = useRef(thunder)
  thunderRef.current = thunder
  const feed = useLightningFeed({
    enabled: lightningOn,
    windowMin: lightWindow,
    place,
    onRows: (rows, reset) => engine.current?.addStrikes(rows, reset),
    onNear: (_s, km) => {
      if (thunderRef.current) playThunder(km)
    }
  })
  useEffect(() => {
    engine.current?.setLightning(lightningOn)
    saveFlag(LIGHTNING_KEY, lightningOn)
  }, [lightningOn])
  useEffect(() => {
    engine.current?.setLightningOptions({ windowMin: lightWindow, mode: lightMode })
    try {
      localStorage.setItem(nsKey(LIGHTNING_WINDOW_KEY), String(lightWindow))
      localStorage.setItem(nsKey(LIGHTNING_MODE_KEY), lightMode)
    } catch {
      /* not remembered */
    }
  }, [lightWindow, lightMode])
  useEffect(() => saveFlag(THUNDER_KEY, thunder), [thunder])

  // ---------- web traffic (one switch, kept by the backend and shared by every view) ----------
  useEffect(() => {
    engine.current?.setTraffic(traffic.enabled)
    if (!traffic.enabled) setTrafficSel(null)
  }, [traffic.enabled])
  useEffect(() => {
    engine.current?.setTrafficPlaces(traffic.live?.places ?? [])
  }, [traffic.live])
  useEffect(() => {
    engine.current?.setTrafficHome(place)
  }, [place])
  useEffect(() => {
    engine.current?.selectTraffic(trafficSel)
  }, [trafficSel])
  const trafficPlace = trafficSel ? traffic.live?.places.find((p) => p.id === trafficSel) ?? null : null
  const switchTraffic = (on: boolean): void => {
    if (on) {
      let told = false
      try {
        told = localStorage.getItem(TRAFFIC_ACK_KEY) === '1'
      } catch {
        /* asked again next time */
      }
      if (!told) {
        const ok = window.confirm(
          [
            'Show where your web traffic goes?',
            '',
            'This reads this PC’s own list of open internet connections (which program talks to which remote address). It never sees what is sent, and nothing is captured off the network.',
            '',
            'Places are worked out from a database on this PC, so no address is sent to anyone. What you see is kept in memory; an optional 7-day history (country, city and program name only) is stored encrypted and can be cleared at any time.'
          ].join('\n')
        )
        if (!ok) return
        try {
          localStorage.setItem(TRAFFIC_ACK_KEY, '1')
        } catch {
          /* asked again next time */
        }
      }
    }
    void traffic.setEnabled(on)
  }

  // ---------- city names ----------
  useEffect(() => {
    let live = true
    api
      .get<{ rows: (string | number)[][] }>('/deepspace/cities')
      .then((d) => {
        if (!live) return
        cityRows.current = d.rows
        if (!usingTowns.current) engine.current?.setCities(d.rows)
      })
      .catch(() => undefined) // offline the first time: no city names, everything else is unaffected
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    engine.current?.setCitiesVisible(cityNames)
    saveFlag(CITIES_KEY, cityNames)
  }, [cityNames])

  // ---------- town names (every town and village of 1,000 people or more: GeoNames, fetched once by the backend) ----------
  useEffect(() => {
    saveFlag(TOWNS_KEY, townNames)
    const eng = engine.current
    if (!townNames) {
      usingTowns.current = false
      setTownsState('off')
      setTownHit(null)
      if (cityRows.current) eng?.setCities(cityRows.current)
      return
    }
    let live = true
    const apply = (rows: (string | number)[][]): void => {
      usingTowns.current = true
      eng?.setCities(rows, true)
      setTownsState('ready')
    }
    if (townRows.current) {
      apply(townRows.current)
      return
    }
    setTownsState('loading')
    api
      .get<TownsPayload>('/deepspace/towns')
      .then((d) => {
        if (!live) return
        townRows.current = d.rows.map((r) => [r[0], d.countries[Number(r[1])] ?? '', r[2], r[3], r[4], r[5], Number(r[6]) >= 0 ? (d.regions[Number(r[6])] ?? '') : ''])
        apply(townRows.current)
      })
      .catch(() => live && setTownsState('error'))
    return () => {
      live = false
    }
  }, [townNames])

  // ---------- my places ----------
  useEffect(() => {
    engine.current?.setMyPlaces(myPlaces)
    if (placeSel && !myPlaces.some((p) => p.id === placeSel)) setPlaceSel(null)
  }, [myPlaces, placeSel])
  useEffect(() => engine.current?.setPlacePicking(placeMode), [placeMode])
  const saveDraft = (): void => {
    if (!placeDraft) return
    const t = tidyCoordinates(placeDraft.lat, placeDraft.lon)
    const spot = parsePlace(t.lat, t.lon)
    if (!spot) {
      setPlaceError('Latitude is -90 to 90 and longitude -180 to 180, in degrees (west and south are negative, or add W / S).')
      return
    }
    addMyPlace(placeDraft.name, spot.latDeg, spot.lonDeg)
    setPlaceError(null)
    setPlaceDraft(null)
    window.setTimeout(() => engine.current?.viewLatLon(spot.latDeg, spot.lonDeg, 600), 60)
  }

  // ---------- wind and sea currents ----------
  const wind = useFlowGrid('wind', windOn, windLevel, ms)
  const currents = useFlowGrid('currents', currentsOn, '10m', ms)
  useEffect(() => {
    engine.current?.setFlow('wind', windOn)
    saveFlag(WIND_KEY, windOn)
  }, [windOn])
  useEffect(() => {
    engine.current?.setFlow('currents', currentsOn)
    saveFlag(CURRENTS_KEY, currentsOn)
  }, [currentsOn])
  useEffect(() => {
    engine.current?.setFlowGrid('wind', windOn ? wind.grid : null, windLevel)
  }, [wind.grid, windOn, windLevel])
  useEffect(() => {
    engine.current?.setFlowGrid('currents', currentsOn ? currents.grid : null)
  }, [currents.grid, currentsOn])
  useEffect(() => {
    try {
      localStorage.setItem(nsKey(WIND_LEVEL_KEY), windLevel)
    } catch {
      /* not remembered */
    }
  }, [windLevel])
  useEffect(() => {
    if (!windOn && !currentsOn) {
      setFlowPick(null)
      engine.current?.setFlowPick(null)
    }
  }, [windOn, currentsOn])
  const windHere = useMemo(() => (windOn && wind.grid && flowPick ? sampleFlow(wind.grid, flowPick.latDeg, flowPick.lonDeg) : null), [windOn, wind.grid, flowPick])
  const currentHere = useMemo(() => (currentsOn && currents.grid && flowPick ? sampleFlow(currents.grid, flowPick.latDeg, flowPick.lonDeg) : null), [currentsOn, currents.grid, flowPick])

  // ---------- the ISS's orbit ----------
  const iss = useSatCatalogue(['iss'], issOrbit)
  const issRecord = useMemo(() => iss.cat?.records.find((r) => r.norad === 25544) ?? null, [iss.cat])
  useEffect(() => {
    engine.current?.setOrbitTrace(issOrbit ? issRecord : null)
    saveFlag(ISS_ORBIT_KEY, issOrbit)
  }, [issOrbit, issRecord])

  // ---------- earthquakes, volcanoes and heat spots ----------
  const quakeFeed = useQuakes(quakesOn)
  const volcanoFeed = useVolcanoes(volcanoesOn)
  const heatFeed = useHeat(heatOn)
  useEffect(() => {
    saveFlag(QUAKES_KEY, quakesOn)
    saveFlag(VOLCANOES_KEY, volcanoesOn)
    saveFlag(VOLCANO_ALL_KEY, volcanoAll)
    saveFlag(HEAT_KEY, heatOn)
    try {
      localStorage.setItem(nsKey(QUAKE_MIN_KEY), String(quakeMin))
      localStorage.setItem(nsKey(QUAKE_HOURS_KEY), String(quakeHours))
    } catch {
      /* not remembered */
    }
  }, [quakesOn, volcanoesOn, volcanoAll, heatOn, quakeMin, quakeHours])
  useEffect(() => {
    engine.current?.setQuakes(quakesOn ? quakeFeed.quakes : null)
  }, [quakesOn, quakeFeed.quakes])
  useEffect(() => {
    engine.current?.setQuakeFilter({ minMag: quakeMin, hours: quakeHours })
  }, [quakeMin, quakeHours, quakeFeed.quakes])
  useEffect(() => {
    engine.current?.setVolcanoes(volcanoesOn ? volcanoFeed.volcanoes : null)
  }, [volcanoesOn, volcanoFeed.volcanoes])
  useEffect(() => {
    engine.current?.setVolcanoShowAll(volcanoAll)
  }, [volcanoAll, volcanoFeed.volcanoes])
  useEffect(() => {
    engine.current?.setHeat(heatOn ? heatFeed.spots : null)
  }, [heatOn, heatFeed.spots])
  useEffect(() => {
    engine.current?.setLaunches(launchesOn ? launchFeed.launches : null)
  }, [launchesOn, launchFeed.launches])
  useEffect(() => {
    saveFlag(LAUNCHES_KEY, launchesOn)
    if (!launchesOn) setLaunchHit(null)
  }, [launchesOn])
  useEffect(() => {
    engine.current?.setAqiStations(aqiOn ? aqiFeed.stations : null)
  }, [aqiOn, aqiFeed.stations])
  useEffect(() => {
    saveFlag(AQI_KEY, aqiOn)
    if (!aqiOn) setAqiHit(null)
  }, [aqiOn])
  useEffect(() => {
    if (!quakesOn) setQuakeHit(null)
  }, [quakesOn])
  useEffect(() => {
    if (!volcanoesOn) setVolcanoHit(null)
  }, [volcanoesOn])
  useEffect(() => {
    if (!sunOn || !sunCmes) setCmeHit(null)
  }, [sunOn, sunCmes])
  useEffect(() => {
    if (!sunOn || !sunFlares) setFlareHit(null)
  }, [sunOn, sunFlares])
  useEffect(() => {
    if (!quakeHit) return setQuakeInfo(null)
    let live = true
    api
      .get<QuakeInfo>(`/hazards/quake/${encodeURIComponent(quakeHit.id)}`)
      .then((i) => {
        if (!live) return
        setQuakeInfo(i)
        engine.current?.setHazardLabel(`M ${i.mag.toFixed(1)} · ${i.place}`)
      })
      .catch(() => live && setQuakeInfo(null))
    return () => {
      live = false
    }
  }, [quakeHit?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!volcanoHit) return setVolcanoInfo(null)
    let live = true
    api
      .get<VolcanoInfo>(`/hazards/volcano/${volcanoHit.vnum}`)
      .then((i) => {
        if (!live) return
        setVolcanoInfo(i)
        engine.current?.setHazardLabel(i.name)
      })
      .catch(() => live && setVolcanoInfo(null))
    return () => {
      live = false
    }
  }, [volcanoHit?.vnum]) // eslint-disable-line react-hooks/exhaustive-deps
  const quakesShown = useMemo(() => {
    const cutoff = Date.now() - quakeHours * 3_600_000
    return quakeFeed.quakes?.filter((q) => q.mag >= quakeMin && q.tMs >= cutoff).length ?? 0
  }, [quakeFeed.quakes, quakeMin, quakeHours])

  useEffect(() => {
    saveFlag(ASTEROIDS_KEY, asteroidsOn)
  }, [asteroidsOn])

  useEffect(() => {
    saveFlag(METEORS_KEY, meteorsOn)
    if (!meteorsOn) setMeteorHit(null)
  }, [meteorsOn])
  useEffect(() => {
    if (!meteorsOn || earthOnly || !place) {
      engine.current?.setMeteorShowers([])
      return
    }
    engine.current?.setMeteorShowers(activeShowers(slowMs, place))
  }, [meteorsOn, earthOnly, place, slowMs])

  useEffect(() => {
    if (!layers.streams || earthOnly) {
      engine.current?.setMeteorStreamShowers([])
      return
    }
    const d = new Date(slowMs)
    const month = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    engine.current?.setMeteorStreamShowers(SHOWERS.filter((s) => inActiveRange(s.active, month, day)))
  }, [layers.streams, earthOnly, slowMs])

  useEffect(() => {
    saveFlag(ECLIPSE_KEY, eclipseOn)
  }, [eclipseOn])
  useEffect(() => {
    if (!eclipseOn || !place) {
      engine.current?.setEclipseWindow(null)
      return
    }
    engine.current?.setEclipseWindow(currentEclipseWindow(place, slowMs))
  }, [eclipseOn, place, slowMs])

  // ---------- ships ----------
  const shipFeed = useShips(shipsOn)
  useEffect(() => {
    saveFlag(SHIPS_KEY, shipsOn)
    if (!shipsOn) {
      setShipHit(null)
      setShipInfo(null)
      setFollowingShip(null)
    }
  }, [shipsOn])
  useEffect(() => {
    engine.current?.setShips(shipsOn ? shipFeed.ships : null)
    // a ship picked from the Find list before the layer was on: fly to it once it is there
    if (shipsOn && shipFeed.ships && pendingShip.current !== null) {
      const m = pendingShip.current
      if (shipFeed.ships.some((x) => x.mmsi === m)) {
        pendingShip.current = null
        engine.current?.followShip(m)
        setFollowingShip(m)
      }
    }
  }, [shipFeed.ships, shipsOn])
  useEffect(() => {
    if (!shipHit) {
      setShipInfo(null)
      return
    }
    let live = true
    api
      .get<ShipInfo>(`/ships/ship/${shipHit.mmsi}`)
      .then((i) => {
        if (!live) return
        setShipInfo(i)
        engine.current?.setShipLabel(i.name || String(i.mmsi))
      })
      .catch(() => live && setShipInfo(null))
    return () => {
      live = false
    }
  }, [shipHit?.mmsi]) // eslint-disable-line react-hooks/exhaustive-deps
  const followShip = (mmsi: number): void => {
    if (!shipsOn) {
      pendingShip.current = mmsi
      setShipsOn(true)
      return
    }
    engine.current?.followShip(mmsi)
    setFollowingShip(mmsi)
    setShipHit((h) => h ?? { mmsi, latDeg: 0, lonDeg: 0, sogKn: 0, courseDeg: 0, cat: 0 })
  }
  // ships whose name or MMSI matches what is typed in the Find box
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) {
      setShipResults([])
      return
    }
    let live = true
    const t = window.setTimeout(() => {
      api
        .get<{ mmsi: number; name: string; cat: number }[]>(`/ships/search?q=${encodeURIComponent(q)}`)
        .then((r) => live && setShipResults(r))
        .catch(() => live && setShipResults([]))
    }, 350)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [query])

  // ---------- aircraft ----------
  useEffect(() => {
    saveFlag(AIRCRAFT_KEY, planesOn)
    if (!planesOn) {
      engine.current?.setAircraft(null)
      setPlaneStatus({ state: 'off' })
      setPlaneCounts({})
      setPlane(null)
      return
    }
    let live = true
    setPlaneStatus((p) => (p.state === 'live' ? p : { state: 'loading' }))
    const load = (): void => {
      api
        .get<AircraftPayload>('/aircraft/world')
        .then((d) => {
          if (!live) return
          const rows = parseAircraft(d)
          engine.current?.setAircraftFilter(planeHidden.current)
          engine.current?.setAircraft(rows)
          setPlaneCounts(countKinds(rows))
          setPlaneStatus({ state: 'live', count: rows.length, fetchedAt: d.fetched_at * 1000, message: d.error ?? undefined, typesReady: d.types_ready })
        })
        .catch((e) => {
          if (!live) return
          const msg = e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load aircraft'
          setPlaneStatus((p) => (p.state === 'live' ? { ...p, message: msg } : { state: 'error', message: msg }))
        })
    }
    load()
    const t = window.setInterval(load, AIRCRAFT_REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [planesOn])
  useEffect(() => {
    engine.current?.setAircraftFilter(planeKinds.hidden)
  }, [planeKinds.hidden])

  // ---------- satellites ----------
  const satGroups = wantAll ? ALL_GROUPS : satOptions.groups
  const sat = useSatCatalogue(satGroups, satOn)
  const satRecords = useMemo(() => (sat.cat ? recordsIn(sat.cat, satGroups) : null), [sat.cat, satGroups])
  const satMedian = useMemo(() => (satRecords ? medianEpochMs(satRecords) : null), [satRecords])
  useEffect(() => {
    engine.current?.setSatellites(satOn ? satRecords : null)
    if (!satOn) {
      setSatSel(null)
      setFollowing(null)
    }
  }, [satOn, satRecords])

  // Arriving from a satellite card: switch satellites on, fly to it, and let time run.
  useEffect(() => {
    if (followSat === null || followedOnce.current || !satRecords || !engine.current) return
    if (!satRecords.some((r) => r.norad === followSat)) {
      if (!wantAll) setWantAll(true)
      else setSatNote(`Satellite ${followSat} is not in the orbit data.`)
      return
    }
    followedOnce.current = true
    engine.current.followSatellite(followSat)
    setSatSel(followSat)
    setFollowing(followSat)
    setSpeedIdx(REAL_TIME_IDX)
    setPlaying(true)
  }, [followSat, satRecords, wantAll])

  // Coming back to a satellite that was picked or followed: pick or follow it again once the orbit data is here.
  const restoredSat = useRef(false)
  useEffect(() => {
    const r = restoreRef.current
    const eng = engine.current
    if (!r || r.sat == null || restoredSat.current || !satRecords || !eng || !satRecords.some((x) => x.norad === r.sat)) return
    restoredSat.current = true
    if (r.satFollowing) {
      eng.followSatellite(r.sat)
      setFollowing(r.sat)
    } else eng.selectSatellite(r.sat)
    setSatSel(r.sat)
  }, [satRecords])

  // Coming back to the camera following your location: fly over it and follow again as soon as the Earth and the dot are there.
  useEffect(() => {
    const r = restoreRef.current
    if (!r?.homeFollow) return
    let tries = 0
    const t = window.setInterval(() => {
      const eng = engine.current
      if (!eng || ++tries > 40) return window.clearInterval(t)
      eng.followHome(true, { distanceAU: r.distance })
      if (eng.isFollowingHome()) window.clearInterval(t)
    }, 400)
    return () => window.clearInterval(t)
  }, [])

  const satState = useMemo(
    () => (satSel === null ? null : (engine.current?.satelliteState(satSel) ?? null)),
    // `ms` moves as time plays; `satRecords` when the set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [satSel, Math.floor(ms / 1000), satRecords]
  )
  const satAge = satMedian === null ? 0 : elementAgeDays(satMedian, new Date(ms))

  const toggleSatGroup = (id: SatGroupId, on: boolean): void =>
    setSatOptions({ groups: on ? [...satOptions.groups, id] : satOptions.groups.filter((g) => g !== id) })
  useEffect(() => setInfo(engine.current?.describe(selected) ?? null), [selected, ms, items])

  const setTime = (t: number, rebaseSlider = true): void => {
    engine.current?.setDate(t)
    setMs(t)
    if (rebaseSlider) setSliderBase(t)
  }

  const fly = (id: string, au?: number): void => {
    engine.current?.focusOn(id, au)
    setSelected(id)
    setFollowingShip(null)
  }

  const goStop = (s: ScaleStop): void => {
    const id = s.focus ?? engine.current?.getFocus() ?? 'sun'
    engine.current?.focusOn(id, { distance: s.au, direction: s.direction })
    setSelected(id)
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q))
    // Solar-system bodies keep their natural order (Mercury to Neptune); the many stars and galaxies go alphabetically.
    const order = (a: ListItem, b: ListItem): number => (a.tier === 'solar' && b.tier === 'solar' ? 0 : a.tier === 'solar' ? -1 : b.tier === 'solar' ? 1 : a.name.localeCompare(b.name))
    shown.sort(order)
    return GROUP_ORDER.map((g) => ({ ...g, rows: shown.filter((i) => i.kind === g.kind) })).filter((g) => g.rows.length)
  }, [items, query])
  const searching = query.trim() !== ''

  const cloudStatus =
    weather.state === 'loading'
      ? 'Loading…'
      : weather.state === 'live' && weather.fetchedAt
        ? `Map from ${hhmm(weather.fetchedAt)}${Math.abs(ms - Date.now()) > 86_400_000 ? ', not shown: scene date is not now' : ''}`
        : weather.state === 'error'
          ? (weather.message ?? 'Unavailable')
          : undefined
  const lightStatus = feed.state.error ? 'No connection' : feed.state.status ? (feed.state.status.connected ? `${feed.state.status.per_minute} strikes a minute` : 'Connecting…') : 'Loading…'
  const auroraStatus = aurora.error && !aurora.grid ? 'No connection' : spaceWx.data?.kp_now != null ? `Kp ${spaceWx.data.kp_now.toFixed(1)}` : 'Loading…'
  const sunStatus = sunSurface.loading && !sunSurface.time ? 'Loading…' : sunSurface.error && !sunSurface.time ? 'No connection' : undefined
  const planeShown = AIRCRAFT_KINDS.reduce((n, k) => n + (planeKinds.hidden.has(k.kind) ? 0 : (planeCounts[k.kind] ?? 0)), 0)
  const planeText =
    planeStatus.state === 'loading'
      ? 'Loading…'
      : planeStatus.state === 'live'
        ? `${planeShown.toLocaleString()}${planeShown === planeStatus.count ? '' : ` of ${planeStatus.count?.toLocaleString()}`} flying${planeStatus.message ? `, ${planeStatus.message}` : ''}`
        : planeStatus.state === 'error'
          ? planeStatus.message
          : undefined

  const sliderDays = Math.max(-SLIDER_DAYS, Math.min(SLIDER_DAYS, (ms - sliderBase) / DAY_MS))

  return (
    <div className="flex h-full min-h-0">
      {earthOnly ? null : sideOpen ? (
        <div className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex items-center gap-1 border-b border-border p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a body, star, galaxy…"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-muted"
            />
            <button onClick={() => setSideOpen(false)} className="rounded px-1.5 py-1 text-sm leading-none text-text-muted hover:bg-accent/10 hover:text-text" title="Hide the Find list" aria-label="Hide the Find list">
              ‹
            </button>
          </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {shipResults.length > 0 && (
            <div className="mb-2">
              <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Ships</div>
              {shipResults.map((r) => (
                <button key={r.mmsi} onClick={() => followShip(r.mmsi)} className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${followingShip === r.mmsi ? 'bg-accent/25 text-text' : 'text-text hover:bg-accent/10'}`} title={`MMSI ${r.mmsi}: fly to it and follow it`}>
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: SHIP_CATS.find((c) => c.id === r.cat)?.colour }} />
                  {r.name}
                </button>
              ))}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.kind} className="mb-2">
              <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{g.label}</div>
              {(searching || expanded.has(g.kind) ? g.rows : g.rows.slice(0, GROUP_PREVIEW)).map((i) => (
                <button
                  key={i.id}
                  onClick={() => fly(i.id)}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${selected === i.id ? 'bg-accent/25 text-text' : 'text-text hover:bg-accent/10'}`}
                >
                  {i.name}
                  {i.parent && <span className="ml-1 text-text-muted">· {items.find((p) => p.id === i.parent)?.name}</span>}
                </button>
              ))}
              {!searching && !expanded.has(g.kind) && g.rows.length > GROUP_PREVIEW && (
                <button onClick={() => setExpanded((x) => new Set(x).add(g.kind))} className="block w-full rounded px-2 py-1 text-left text-[11px] text-accent hover:underline">
                  Show all {g.rows.length}
                </button>
              )}
            </div>
          ))}
        </div>
        </div>
      ) : (
        <button
          onClick={() => setSideOpen(true)}
          className="flex w-7 shrink-0 flex-col items-center gap-3 border-r border-border bg-surface py-2 text-text-muted hover:bg-accent/10 hover:text-text"
          title="Show the Find list"
          aria-label="Show the Find list"
        >
          <span className="text-sm leading-none">›</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">Find</span>
        </button>
      )}

      <div className="relative min-w-0 flex-1 bg-black">
        <div ref={mount} className="absolute inset-0 select-none" style={theme === 'red' ? { filter: RED_NIGHT_FILTER } : undefined} />

        {failed && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-danger">
            The 3D view could not start ({failed}). Check that hardware acceleration is enabled.
          </div>
        )}

        <div className="absolute right-2 top-2 z-20 flex items-start gap-1.5">
          <ToolbarMenu
            label="Panels"
            count={PANELS.filter((p) => panels[p.id].shown).length}
            align="right"
            width="w-72"
            title="Show or hide the info boxes down the right side"
            {...menuAt('panels')}
          >
            {PANELS.map((p) => {
              const layerOn = { fieldwind: fw.on, sun: sunOn, aurora: auroraOn, lightning: lightningOn, traffic: traffic.enabled, overhead: true, asteroids: asteroidsOn, launches: launchesOn }[p.id]
              return (
                <MenuRow key={p.id} checked={panels[p.id].shown} onChange={(shown) => updatePanel(p.id, { shown })} status={layerOn ? undefined : 'Switched off in the menus above, so it is not showing yet'} statusTone="warn">
                  {p.label}
                </MenuRow>
              )
            })}
            <div className="flex items-center gap-1.5 px-1 pt-1">
              <button onClick={() => setAllShown(true)} className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text">
                Show all
              </button>
              <button onClick={() => setAllShown(false)} className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text">
                Hide all
              </button>
            </div>
            <div className="px-1 text-[10px]">Each box also folds down to its title: click the title line.</div>
          </ToolbarMenu>
          <button
            onClick={toggleFly}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${flyHud ? 'border-accent bg-accent/25 text-text' : 'border-border bg-surface/90 text-text-muted hover:border-accent hover:text-text'}`}
            title="Fly through space: W A S D move, Space up, Ctrl down, the mouse steers, Q and E roll, the wheel changes speed, Shift boosts, Esc leaves. Speed follows how close you are to the nearest planet or the Sun, and you stop at the surface."
          >
            🚀 {flyHud ? 'Flying (F or Esc to stop)' : 'Fly (F)'}
          </button>
          <SpaceWeatherBadge activity={sunAct.data} kp={spaceWx.data?.kp_now ?? null} />
        </div>

        {flyHud && (
          <>
            <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 opacity-70">
              <div className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-white" />
              <div className="absolute bottom-0 left-1/2 h-2 w-px -translate-x-1/2 bg-white" />
              <div className="absolute left-0 top-1/2 h-px w-2 -translate-y-1/2 bg-white" />
              <div className="absolute right-0 top-1/2 h-px w-2 -translate-y-1/2 bg-white" />
            </div>
            <div className="pointer-events-none absolute bottom-60 left-1/2 z-10 -translate-x-1/2 space-y-0.5 rounded-md border border-border bg-surface/85 px-3 py-1.5 text-center text-xs text-text-muted">
              <div>
                <span className="text-text">{flyHud.name || '…'}</span>
                {flyHud.name && (
                  <>
                    {' '}
                    · <span className="tabular-nums text-text">{flyHud.touching ? 'on the surface' : `${heightWords(flyHud.heightAU)} up`}</span>
                  </>
                )}{' '}
                · <span className="tabular-nums text-text">{speedWords(flyHud.speedAUps)}</span>
                <span className="tabular-nums"> · speed ×{flyHud.mul < 10 ? flyHud.mul.toFixed(2) : Math.round(flyHud.mul)}{flyHud.boost ? ' boost' : ''}</span>
              </div>
              <div className="text-[11px]">
                W A S D move · Space up · Ctrl down · {flyHud.locked ? 'mouse steers' : 'hold the left button and drag to steer'} · Q E roll · wheel: speed · Shift: boost · Esc: stop
              </div>
              <button
                className="pointer-events-auto rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text"
                onClick={() => engine.current?.resetRoll()}
              >
                Reset roll
              </button>
            </div>
          </>
        )}

        <div className="absolute left-2 right-56 top-2 z-20 flex flex-wrap items-start gap-1.5">
          <ToolbarMenu label="Solar system" count={SOLAR_LAYERS.filter((k) => layers[k]).length + (asteroidsOn ? 1 : 0) + (eclipseOn ? 1 : 0)} {...menuAt('solar')}>
            {LAYER_LABELS.filter((l) => SOLAR_LAYERS.includes(l.key)).map((l) => (
              <MenuRow key={l.key} checked={layers[l.key]} onChange={(on) => setLayers((x) => ({ ...x, [l.key]: on }))} title={l.title}>
                {l.label}
              </MenuRow>
            ))}
            <MenuRow checked={asteroidsOn} onChange={setAsteroidsOn} title="Near-Earth asteroids passing close by in the next week (NASA NeoWs): a list with distance, size and a countdown, not a 3D position (the data has no direction, only a distance).">
              Asteroids
            </MenuRow>
            <MenuRow checked={eclipseOn} onChange={setEclipseOn} title="During a solar or lunar eclipse, a soft dark shadow where the Moon's shadow falls on the Earth, or the Earth's shadow falls on the Moon. A schematic size, not a modelled shadow cone.">
              Eclipse shadow
            </MenuRow>
          </ToolbarMenu>

          {!earthOnly && (
          <ToolbarMenu label="Stars & galaxies" count={DEEP_LAYERS.filter((k) => layers[k]).length + (meteorsOn ? 1 : 0)} {...menuAt('deep')}>
            {LAYER_LABELS.filter((l) => DEEP_LAYERS.includes(l.key)).map((l) => (
              <MenuRow key={l.key} checked={layers[l.key]} onChange={(on) => setLayers((x) => ({ ...x, [l.key]: on }))}>
                {l.label}
              </MenuRow>
            ))}
            <MenuRow checked={meteorsOn} onChange={setMeteorsOn} title="Radiants of the major annual meteor showers (IMO working list), shown while each is active, with a rough current rate for your location. Click a radiant for details.">
              Meteor showers
            </MenuRow>
          </ToolbarMenu>
          )}

          <ToolbarMenu label="Earth" count={[lightningOn, traffic.enabled, auroraOn, cityNames, homeOn, fullDay].filter(Boolean).length} width="w-80" {...menuAt('earth')}>
            <MenuRow
              checked={lightningOn}
              onChange={setLightningOn}
              title="Real lightning strikes around the world as they happen (Blitzortung volunteer network): each flashes and fades from white through yellow and orange to red; a heat map shows where it is most frequent. Click a flash for details."
              status={lightningOn ? lightStatus : undefined}
              statusTone={feed.state.error || feed.state.status?.connected === false ? 'warn' : 'muted'}
            >
              ⚡ Lightning
            </MenuRow>
            {lightningOn && (
              <MenuSub>
                <label className="flex items-center gap-2" title="Automatic: the heat map when you are far from the Earth, the flashes as you come closer">
                  Show
                  <select value={lightMode} onChange={(e) => setLightMode(e.target.value as LightningMode)} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text">
                    <option value="auto">Auto</option>
                    <option value="flashes">Flashes</option>
                    <option value="heat">Heat map</option>
                    <option value="both">Both</option>
                  </select>
                </label>
                <label className="flex items-center gap-2" title="How long a strike stays on the globe, and the period the heat map covers">
                  Keep
                  <input type="range" min={1} max={60} step={1} value={lightWindow} onChange={(e) => setLightWindow(Number(e.target.value))} className="ml-auto w-28 accent-accent" />
                  <span className="w-12 tabular-nums text-text">{lightWindow} min</span>
                </label>
                <button
                  onClick={() => setThunder((t) => !t)}
                  className={`rounded border px-1.5 py-0.5 ${thunder ? 'border-accent text-text' : 'border-border text-text-muted'}`}
                  title={thunder ? 'A soft thunder sound plays for strikes within 50 km of your saved location: click to mute' : 'Muted: click for a soft thunder sound when lightning strikes within 50 km of your saved location'}
                >
                  {thunder ? '🔊 Thunder on' : '🔇 Thunder muted'}
                </button>
              </MenuSub>
            )}
            <MenuRow
              checked={traffic.enabled}
              onChange={switchTraffic}
              title="Where this PC's internet connections go, as arcs from your saved location: reads Windows' own list of open connections (never what is sent), places them with a database on this PC (no address leaves it) and shows them live. Click a dot for the country, city and programs. Off until you switch it on."
              status={traffic.enabled ? (traffic.live ? `${traffic.live.connections} connections` : 'Reading…') : undefined}
              statusTone={traffic.error || traffic.status?.database.available === false ? 'warn' : 'muted'}
            >
              🌐 Web traffic
            </MenuRow>
            <MenuRow
              checked={auroraOn}
              onChange={setAuroraOn}
              title="The aurora borealis and australis, live from NOAA's OVATION model (updated every 5 minutes): a shimmering glow over the poles that becomes standing curtains as you come close. Dimmed where the Sun is up, since aurora cannot be seen in daylight."
              status={auroraOn ? auroraStatus : undefined}
              statusTone={aurora.error && !aurora.grid ? 'warn' : 'muted'}
            >
              🌌 Aurora
            </MenuRow>
            <MenuRow
              checked={townNames}
              onChange={setTownNames}
              title="Names of every town and village of 1,000 people or more (GeoNames, CC BY 4.0), coming in as you get lower: the bigger ones first. Click a name for its country, region and population. Downloaded once, then kept."
              status={townsState === 'loading' ? 'Loading…' : townsState === 'error' ? 'Could not load' : undefined}
              statusTone={townsState === 'error' ? 'bad' : 'muted'}
            >
              Town names
            </MenuRow>
            <div className="ml-1 space-y-1 rounded border border-border bg-bg/40 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-text">My places</span>
                <span className="flex gap-1">
                  <button
                    onClick={() => setPlaceMode((m) => !m)}
                    className={placeMode ? 'rounded border border-accent bg-accent/20 px-1.5 py-0.5 text-text' : 'rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text'}
                    title="Then click the Earth where the place is"
                  >
                    {placeMode ? 'Click the Earth…' : 'Add by clicking'}
                  </button>
                  <button onClick={() => { setPlaceError(null); setPlaceDraft({ name: '', lat: '', lon: '' }) }} className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text" title="Type a name and coordinates">
                    Add…
                  </button>
                </span>
              </div>
              {myPlaces.length === 0 && <div className="text-[11px]">Name your own spots (an observing site, home): they show as cyan marks on the Earth.</div>}
              {myPlaces.map((pl) => (
                <div key={pl.id} className="flex items-center gap-1">
                  <button onClick={() => { setPlaceSel(pl.id); engine.current?.viewLatLon(pl.lat, pl.lon, 600) }} className="min-w-0 flex-1 truncate text-left text-text hover:underline" title="Fly there">
                    <span style={{ color: '#4dd8ff' }}>●</span> {pl.name}
                  </button>
                  <button onClick={() => removeMyPlace(pl.id)} className="text-text-muted hover:text-danger" title="Remove this place" aria-label={`Remove ${pl.name}`}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <MenuRow checked={cityNames} onChange={setCityNames} title="Names of the world's cities as you come down to the Earth: the biggest first, smaller ones as you get closer (Natural Earth, public domain).">
              City names
            </MenuRow>
            <MenuRow checked={fullDay} onChange={setFullDay} title="Light the whole Earth as if it were day everywhere: no night side and no city lights. Clouds, the ocean's glint, aurora and lightning stay as they are.">
              Full daylight (no night side)
            </MenuRow>
            <MenuRow
              checked={homeOn}
              onChange={setHomeOn}
              title="A green dot on the Earth at your saved location (the same place the Dashboard, Sky Overlay and Live View use)"
              status={homeOn ? (place ? `${place.latDeg.toFixed(2)}, ${place.lonDeg.toFixed(2)}` : 'Not set') : undefined}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: '#22e06a' }} />
              My location
            </MenuRow>
            <div className="ml-6 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => {
                  setHomeError(null)
                  setHomeForm((f) => (f ? null : { lat: rawPlace?.lat ?? '', lon: rawPlace?.lon ?? '' }))
                }}
                className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text"
                title="Type your latitude and longitude"
              >
                {homeForm ? 'Close' : place ? 'Change…' : 'Set…'}
              </button>
              {place && homeOn && (
                <button onClick={() => engine.current?.viewHome()} className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text" title="Fly down to your location">
                  Fly there
                </button>
              )}
              {place && homeOn && (
                <button
                  onClick={() => engine.current?.followHome(!followingHome)}
                  className={followingHome ? 'rounded border border-accent bg-accent/20 px-1.5 py-0.5 text-text' : 'rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text'}
                  title="Fly to your location and keep it in the middle of the screen as the Earth turns. Zoom as you like; dragging the view lets go. Clicking the green dot does the same."
                >
                  {followingHome ? 'Following: stop' : 'Follow'}
                </button>
              )}
            </div>
            {homeForm && (
              <form
                className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-bg/60 px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  submitHome()
                }}
              >
                <label className="flex items-center gap-1">
                  Latitude
                  <input value={homeForm.lat} onChange={(e) => setHomeForm({ ...homeForm, lat: e.target.value })} placeholder="51.5074" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-text" autoFocus />
                </label>
                <label className="flex items-center gap-1">
                  Longitude
                  <input value={homeForm.lon} onChange={(e) => setHomeForm({ ...homeForm, lon: e.target.value })} placeholder="-0.1278" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-text" />
                </label>
                <button type="submit" className="rounded border border-accent px-2 py-0.5 text-text hover:bg-accent/20">
                  Save and show
                </button>
                <span className="text-[11px]">Degrees, west and south negative (or add W / S). You can paste "51.5074, -0.1278" into the first box. Saved for the whole app.</span>
                {homeError && <span className="basis-full text-danger">{homeError}</span>}
              </form>
            )}
          </ToolbarMenu>

          <ToolbarMenu label="Weather" count={[clouds, windOn, currentsOn, ozoneOn, rainOn, ionoOn].filter(Boolean).length} width="w-80" {...menuAt('weather')}>
            <MenuRow
              checked={clouds}
              onChange={setClouds}
              title="The Earth's real clouds, from weather-satellite images, refreshed about every 3 hours. They are today's clouds, so they fade out when the scene's date is more than a day from now. Sunlight, night-side city lights and the ocean glint follow the real Sun for the scene's date."
              status={clouds ? cloudStatus : undefined}
              statusTone={weather.state === 'error' ? 'bad' : 'muted'}
            >
              Live clouds
            </MenuRow>
            <MenuRow checked={ozoneOn} onChange={setOzoneOn} title="Total column ozone (NASA OMPS), a translucent global layer refreshed every few hours.">
              🌐 Ozone layer
            </MenuRow>
            <MenuRow checked={rainOn} onChange={setRainOn} title="Live precipitation, from weather radar and satellite (RainViewer), refreshed every 10 minutes. Coverage follows real radar networks, so it is patchy over oceans and parts of the world without one.">
              🌧️ Rain
            </MenuRow>
            <MenuRow
              checked={ionoOn}
              onChange={setIonoOn}
              title="Global ionospheric total electron content (CODE, University of Bern): affects GPS and radio accuracy. This is CODE's reliable 'final' map, published about 5 days after the fact, not a live now-cast; shown hour-matched to the current time of day."
              status={ionoOn && ionoGrid.grid ? `${ionoGrid.grid.day}, hour ${ionoGrid.grid.hour}` : ionoOn && ionoGrid.error ? ionoGrid.error : undefined}
              statusTone={ionoGrid.error ? 'warn' : 'muted'}
            >
              📡 Ionosphere (TEC)
            </MenuRow>
            {ionoOn && (
              <div className="space-y-1 px-1 pt-1">
                <div className="flex items-center gap-2 text-[10px]">
                  <span>quiet</span>
                  <span className="h-1.5 flex-1 rounded" style={{ background: 'linear-gradient(90deg,#1a40d9,#26d9d9,#f2d926,#f23326)' }} />
                  <span>busy</span>
                </div>
                {ionoGrid.grid && <div className="text-[10px]">{ionoGrid.grid.credit}</div>}
              </div>
            )}
            <MenuRow
              checked={windOn}
              onChange={setWindOn}
              title="The real wind on the Earth as moving streaks, from NOAA's GFS weather model: the latest analysis now, and the forecast for up to 10 days if you move the date. Sped up so you can watch it. Click the Earth to read the wind at a spot."
              status={windOn ? flowStatus(wind, 'about now to 10 days ahead') : undefined}
              statusTone={wind.status === 'error' ? 'bad' : wind.status === 'nodata' ? 'warn' : 'muted'}
            >
              💨 Wind
            </MenuRow>
            {windOn && (
              <MenuSub>
                <label className="flex items-center gap-2" title={WIND_LEVELS.find((l) => l.id === windLevel)?.hint}>
                  Height
                  <select value={windLevel} onChange={(e) => setWindLevel(e.target.value as WindLevel)} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text">
                    {WIND_LEVELS.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
              </MenuSub>
            )}
            <MenuRow
              checked={currentsOn}
              onChange={setCurrentsOn}
              title="The surface currents of the oceans as moving streaks, from the HYCOM ocean model (which uses satellite and buoy measurements): hourly, from about 9 days back to 6 days ahead. Sped up a lot: the real currents crawl. Click the Earth to read the current at a spot."
              status={currentsOn ? flowStatus(currents, 'about 9 days back to 6 days ahead') : undefined}
              statusTone={currents.status === 'error' ? 'bad' : currents.status === 'nodata' ? 'warn' : 'muted'}
            >
              🌊 Sea currents
            </MenuRow>
            {(windOn || currentsOn) && (
              <div className="space-y-1.5 px-1 pt-1">
                {windOn && <FlowLegend label={`Wind, ${WIND_LEVELS.find((l) => l.id === windLevel)?.label.split(' (')[0] ?? ''}`} max={speedMax('wind', windLevel)} />}
                {currentsOn && <FlowLegend label="Sea currents" max={speedMax('currents')} />}
                <div className="text-[10px]">Click the Earth (while it is the body in focus) to read the values at that spot. The streaks move far faster than the real wind and water, to make the flow easy to follow.</div>
                {windOn && wind.grid && <div className="text-[10px]">{wind.grid.credit}</div>}
                {currentsOn && currents.grid && <div className="text-[10px]">{currents.grid.credit}</div>}
              </div>
            )}
          </ToolbarMenu>

          <ToolbarMenu label="Hazards" count={[quakesOn, volcanoesOn, heatOn, aqiOn].filter(Boolean).length} width="w-80" {...menuAt('hazards')}>
            <MenuRow
              checked={quakesOn}
              onChange={setQuakesOn}
              title="Earthquakes from the USGS, updated every minute. Each is a dot sized by its magnitude and coloured white (just now) to red (old), with a ring spreading from the newest. Zoom in to the Earth; click one for details."
              status={quakesOn ? (quakeFeed.status === 'loading' ? 'Loading…' : quakeFeed.status === 'error' ? (quakeFeed.message ?? 'Could not load') : `${quakesShown.toLocaleString()} shown, of ${(quakeFeed.quakes?.length ?? 0).toLocaleString()} in 30 days`) : undefined}
              statusTone={quakeFeed.status === 'error' ? 'bad' : 'muted'}
            >
              🌍 Earthquakes
            </MenuRow>
            {quakesOn && (
              <MenuSub>
                <label className="flex items-center gap-2" title="Quakes smaller than this are hidden">
                  Magnitude
                  <select value={quakeMin} onChange={(e) => setQuakeMin(Number(e.target.value))} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text">
                    {QUAKE_MAGS.map((m) => (
                      <option key={m} value={m}>
                        {m}+ ({magnitudeWords(m)})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2" title="How far back to show quakes">
                  Last
                  <select value={quakeHours} onChange={(e) => setQuakeHours(Number(e.target.value))} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text">
                    {WINDOWS.map((w) => (
                      <option key={w.hours} value={w.hours}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2 text-[10px]">
                  <span>new</span>
                  <span className="h-1.5 flex-1 rounded" style={{ background: 'linear-gradient(90deg,#fff,#ffe64d,#ff8026,#d92619)' }} />
                  <span>old</span>
                </div>
              </MenuSub>
            )}
            <MenuRow
              checked={volcanoesOn}
              onChange={setVolcanoesOn}
              title="About 1,400 volcanoes as triangles. Those erupting, in unrest or on alert are bigger and coloured by level, from the Smithsonian / USGS weekly report and the USGS alert levels. Click one for details."
              status={volcanoesOn ? (volcanoFeed.status === 'loading' ? 'Loading…' : volcanoFeed.status === 'error' ? (volcanoFeed.message ?? 'Could not load') : `${volcanoFeed.active.length} with activity now`) : undefined}
              statusTone={volcanoFeed.status === 'error' ? 'bad' : 'muted'}
            >
              🌋 Volcanoes
            </MenuRow>
            {volcanoesOn && (
              <MenuSub>
                <MenuRow checked={volcanoAll} onChange={setVolcanoAll} title="Off: only the volcanoes with activity now">
                  Show every volcano (faint)
                </MenuRow>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  {VOLCANO_LEVELS.map((l) => (
                    <span key={l.level} className="flex items-center gap-1">
                      <span className="h-2 w-2" style={{ background: l.colour, clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
                      {l.label}
                    </span>
                  ))}
                </div>
              </MenuSub>
            )}
            <MenuRow
              checked={heatOn}
              onChange={setHeatOn}
              title="NASA satellite heat detections of the last day: lava, hot vents and wildfires. Needs a free NASA FIRMS key (Settings)."
              status={heatOn ? (heatFeed.payload && !heatFeed.payload.has_key ? 'Needs a free NASA FIRMS key: add it in Settings' : heatFeed.status === 'loading' ? 'Loading…' : heatFeed.status === 'error' ? (heatFeed.message ?? 'Could not load') : heatFeed.payload?.status.error ? heatFeed.payload.status.error : heatFeed.spots ? `${heatFeed.spots.length.toLocaleString()} detections` : undefined) : undefined}
              statusTone={heatFeed.status === 'error' || heatFeed.payload?.status.error || (heatFeed.payload && !heatFeed.payload.has_key) ? 'warn' : 'muted'}
            >
              🔥 Heat spots
            </MenuRow>
            <MenuRow
              checked={aqiOn}
              onChange={setAqiOn}
              title="Air quality stations (PM2.5, as the US EPA Air Quality Index) from OpenAQ, refreshed every 45 minutes. Needs a free OpenAQ key (Settings)."
              status={aqiOn ? (aqiFeed.payload && !aqiFeed.payload.has_key ? 'Needs a free OpenAQ key: add it in Settings' : aqiFeed.status === 'loading' ? 'Loading…' : aqiFeed.status === 'error' ? (aqiFeed.message ?? 'Could not load') : aqiFeed.stations ? `${aqiFeed.stations.length.toLocaleString()} stations` : undefined) : undefined}
              statusTone={aqiFeed.status === 'error' || (aqiFeed.payload && !aqiFeed.payload.has_key) ? 'warn' : 'muted'}
            >
              🏭 Air quality
            </MenuRow>
            <div className="space-y-0.5 px-1 pt-1 text-[10px]">
              {quakesOn && quakeFeed.payload && <div>{quakeFeed.payload.credit}</div>}
              {volcanoesOn && volcanoFeed.payload && <div>{volcanoFeed.payload.credit}</div>}
              {heatOn && heatFeed.payload?.has_key && <div>{heatFeed.payload.credit}</div>}
              {aqiOn && aqiFeed.payload?.has_key && <div>{aqiFeed.payload.credit}</div>}
            </div>
          </ToolbarMenu>

          <ToolbarMenu label="☀ Sun" count={sunOn ? [true, sunCorona, sunCmes, sunSpots, sunFlares].filter(Boolean).length : 0} width="w-80" {...menuAt('sun')}>
            <MenuRow
              checked={sunOn}
              onChange={setSunOn}
              title="The Sun as it really looks today: a live picture of its surface from NASA's Solar Dynamics Observatory, the corona and streamers from the SOHO coronagraphs, coronal mass ejections travelling outward, and numbered sunspot groups. Scrub the date to see the Sun as it was."
              status={sunOn ? sunStatus : undefined}
              statusTone={sunAct.error && !sunAct.data ? 'warn' : 'muted'}
            >
              Live Sun
            </MenuRow>
            {sunOn && (
              <MenuSub>
                <label className="flex items-center gap-2" title={SURFACE_KINDS.find((k) => k.kind === sunKind)?.help}>
                  Picture
                  <select value={sunKind} onChange={(e) => setSunKind(e.target.value as SurfaceKind)} className="ml-auto rounded border border-border bg-bg px-1 py-0.5 text-text">
                    {SURFACE_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <button onClick={() => engine.current?.viewSunFromEarth()} className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text" title="Fly to the Sun and look at it from the Earth's side, the way the solar telescopes see it">
                    🌍 View from Earth
                  </button>
                </div>
                <MenuRow checked={sunCorona} onChange={setSunCorona} title="The corona and its streamers (SOHO coronagraphs), on sheets that turn to face you">
                  Corona
                </MenuRow>
                <MenuRow checked={sunCmes} onChange={setSunCmes} title="Coronal mass ejections from NASA's catalogue, travelling out along their measured direction at their measured speed. Orange ones head for Earth.">
                  CMEs
                </MenuRow>
                <MenuRow checked={sunSpots} onChange={setSunSpots} title="NOAA's numbered sunspot groups (AR numbers), labelled on the surface when you are close">
                  Sunspots
                </MenuRow>
                <MenuRow checked={sunFlares} onChange={setSunFlares} title="Solar flares from NOAA's GOES X-ray sensor: a brief glow on the sunspot region it came from, coloured by class (C=yellow, M=orange, X=red), fading over a few hours after it peaks.">
                  Flares
                </MenuRow>
              </MenuSub>
            )}
          </ToolbarMenu>

          <ToolbarMenu
            label="🧲 Field & wind"
            count={fw.on ? [fw.lines, fw.map, fw.surfaces, fw.stations, fw.belts, fw.stream, fw.markers, fw.sheet].filter(Boolean).length : 0}
            width="w-80"
            {...menuAt('field')}
          >
            <FieldWindOptions state={fw} set={setFw} year={decimalYear(ms)} />
          </ToolbarMenu>

          <ToolbarMenu label="Traffic" count={[issOrbit, planesOn, shipsOn, satOn, launchesOn].filter(Boolean).length} width="w-80" {...menuAt('traffic')}>
            <MenuRow
              checked={issOrbit}
              onChange={setIssOrbit}
              title="The path the International Space Station flies around the Earth (the ring), its track over the ground (last 45 minutes, next 90) and where it is now. Zoom in to the Earth to see it."
              status={issOrbit && iss.error ? 'No orbit data' : undefined}
              statusTone="bad"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: '#ff5c5c' }} />
              ISS orbit
            </MenuRow>
            <MenuRow
              checked={planesOn}
              onChange={setPlanesOn}
              title="Every aircraft that reports its position (ADS-B), from the OpenSky Network, refreshed every 5 minutes and moved along their tracks in between. Zoom in to the Earth; click one for details. Shown only while the scene's date is near now."
              status={planesOn ? planeText : undefined}
              statusTone={planeStatus.state === 'error' ? 'bad' : planeStatus.message ? 'warn' : 'muted'}
            >
              Aircraft
            </MenuRow>
            {planesOn && planeStatus.state === 'live' && (
              <MenuSub>
                <AircraftKindRows filter={planeKinds} counts={planeCounts} compact />
                {planeStatus.typesReady === false && (
                  <div className="text-[10px]">Downloading the aircraft database: until it arrives, business jets, small planes, military and cargo are mostly counted as unidentified.</div>
                )}
              </MenuSub>
            )}
            <MenuRow
              checked={shipsOn}
              onChange={setShipsOn}
              title="Ships from their AIS transponders, moved along their courses between updates. Zoom in to the Earth; click one for details, or search a name or MMSI in the Find box. Shown only while the scene's date is near now."
              status={
                shipsOn
                  ? shipFeed.status === 'loading'
                    ? 'Loading…'
                    : shipFeed.status === 'error'
                      ? (shipFeed.message ?? 'Could not load ships')
                      : shipFeed.ships
                        ? `${shipFeed.ships.length.toLocaleString()} ships${shipFeed.payload?.has_key ? '' : ', Baltic Sea only'}${shipFeed.payload?.sources.aisstream.error ? ` (aisstream.io: ${shipFeed.payload.sources.aisstream.error})` : ''}`
                        : undefined
                  : undefined
              }
              statusTone={shipFeed.status === 'error' || shipFeed.payload?.sources.aisstream.error ? 'warn' : 'muted'}
            >
              🚢 Ships
            </MenuRow>
            {shipsOn && (
              <MenuSub>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  {SHIP_CATS.map((c) => (
                    <span key={c.id} className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: c.colour }} />
                      {c.label}
                    </span>
                  ))}
                </div>
                {shipFeed.payload && !shipFeed.payload.has_key && <div className="text-[10px]">Only the Baltic Sea is covered without a key. A free aisstream.io key in Settings adds the whole world.</div>}
                {shipFeed.payload && <div className="text-[10px]">{shipFeed.payload.credit}</div>}
              </MenuSub>
            )}
            <MenuRow checked={satOn} onChange={setSatOn} title="Satellites around the Earth: zoom in to the Earth to see them">
              Satellites
            </MenuRow>
            {satOn && (
              <MenuSub>
                {SAT_GROUPS.map((g) => (
                  <MenuRow key={g.id} checked={satGroups.includes(g.id)} disabled={wantAll} onChange={(on) => toggleSatGroup(g.id, on)} title={g.hint}>
                    <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
                    {g.label}
                  </MenuRow>
                ))}
              </MenuSub>
            )}
            <MenuRow
              checked={launchesOn}
              onChange={setLaunchesOn}
              title="Upcoming and recently completed orbital rocket launches (Launch Library 2), shown at their pad. Click one for details."
              status={launchesOn && launchFeed.status === 'error' ? (launchFeed.message ?? 'Could not load launches') : undefined}
              statusTone="warn"
            >
              🚀 Launches
            </MenuRow>
          </ToolbarMenu>

          <ToolbarMenu label="ⓘ Controls" align="right" width="w-80" {...menuAt('help')}>
            <MenuHeading>Mouse</MenuHeading>
            <p className="px-1 py-0.5">Drag to orbit the camera · wheel to zoom · click a body, satellite, ship, aircraft, radiant or traffic dot to see it in the side panel · click a body again (or "Fly to it") to go there.</p>
            <MenuHeading>Keyboard</MenuHeading>
            <p className="px-1 py-0.5">F: enter/leave free-flight · R: reset camera roll.</p>
            <p className="px-1 py-0.5">While flying: W A S D + Space/Ctrl to move, the mouse to steer, Q E to roll, the wheel to change speed, Shift to boost.</p>
            <MenuHeading>Time</MenuHeading>
            <p className="px-1 py-0.5">Play/Pause and the speed controls at the bottom move the scene's date; the presets jump to a useful zoom level.</p>
            <MenuHeading>Toolbar</MenuHeading>
            <p className="px-1 py-0.5">Each button above turns a group of layers on or off — hover any switch inside for what it shows. Use "Find a body, star, galaxy…" to jump straight to one.</p>
          </ToolbarMenu>
        </div>

        {Math.abs(yearsFromJ2000(ms)) > PLANET_YEARS_OK && (
          <div className="absolute right-2 top-16 z-10 max-w-xs rounded-md border border-warning/40 bg-surface/90 px-3 py-1.5 text-xs text-text">
            Planet and moon positions are only computed for roughly the years 0 to 4000 CE, so they fade out here. The stars keep moving on their measured motions (sideways only: Hipparcos has no radial velocities).
          </div>
        )}

        {satOn && (sat.loading || sat.error || satAge > MAX_ELEMENT_AGE_DAYS || satNote || (sat.cat && sat.cat.missing.length > 0)) && (
          <div className="absolute right-2 top-28 z-10 max-w-xs space-y-1 rounded-md border border-warning/40 bg-surface/90 px-3 py-1.5 text-xs text-text">
            {sat.loading && <div>Loading satellite orbit data…</div>}
            {sat.error && <div className="text-danger">Could not load satellites: {sat.error}</div>}
            {sat.cat && sat.cat.missing.length > 0 && <div>No orbit data for {sat.cat.missing.join(', ')}{Object.values(sat.cat.errors)[0] ? `: ${Object.values(sat.cat.errors)[0]}` : ' (offline?)'}.</div>}
            {satAge > MAX_ELEMENT_AGE_DAYS && <div>The orbit data is {Math.round(satAge)} days from this time, and orbits change too fast for that: no satellites are shown. Move time closer to now.</div>}
            {satNote && <div>{satNote}</div>}
          </div>
        )}

        <div className={`absolute bottom-56 right-2 z-10 flex max-h-[calc(100%-26rem)] flex-col items-end gap-2 overflow-y-auto ${flyHud ? 'hidden' : ''}`}>
        {fw.on && panels.fieldwind.shown && (
          <FieldWindPanel
            sw={spaceWx.data}
            dst={spaceEnv.dst}
            stations={spaceEnv.stations}
            enlilEarth={spaceEnv.enlilEarth}
            sun={sunAct.data}
            frame={enlil}
            showFlow={fw.sheet}
            live={Math.abs(ms - Date.now()) < 45 * 60_000}
            year={decimalYear(ms)}
            open={panels.fieldwind.open}
            onToggle={() => updatePanel('fieldwind', { open: !panels.fieldwind.open })}
          />
        )}
        {sunOn && panels.sun.shown && (
          <SunPanel
            activity={sunAct.data}
            error={sunAct.error}
            sceneMs={ms}
            kind={sunKind}
            surfaceTime={sunSurface.time}
            coronaTime={sunC2.time}
            loading={sunAct.loading}
            open={panels.sun.open}
            onToggle={() => updatePanel('sun', { open: !panels.sun.open })}
          />
        )}
        {auroraOn && aurora.grid && panels.aurora.shown && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
            <PanelHeader open={panels.aurora.open} onToggle={() => updatePanel('aurora', { open: !panels.aurora.open })}>
              🌌 Aurora: peak chance <span className="tabular-nums text-text">{aurora.grid.max}%</span>
              {spaceWx.data?.kp_now != null && (
                <span>
                  {' '}
                  · Kp <span className="tabular-nums text-text">{spaceWx.data.kp_now.toFixed(1)}</span>
                  {gScale(spaceWx.data.kp_now) ? ` (${gScale(spaceWx.data.kp_now)} storm)` : ''}
                </span>
              )}
            </PanelHeader>
            {panels.aurora.open && (
              <>
                {auroraHere ? (
                  <div>
                    At your location: <span className="tabular-nums text-text">{Math.round(auroraHere.chance)}%</span>. {auroraHere.verdict.text}
                  </div>
                ) : (
                  <div>Set your location on the Dashboard for your own chance</div>
                )}
                <div className="text-[10px]">{aurora.grid.credit}. A model of where aurora is likely, not a camera view: cloud and moonlight decide what you would see.</div>
              </>
            )}
          </div>
        )}
        {lightningOn && feed.state.status && panels.lightning.shown && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
            <PanelHeader open={panels.lightning.open} onToggle={() => updatePanel('lightning', { open: !panels.lightning.open })}>
              ⚡ <span className="tabular-nums text-text">{feed.state.status.per_minute}</span> strikes in the last minute, worldwide
              <span className="ml-1 tabular-nums">({feed.state.status.per_minute_5m}/min over 5 min)</span>
            </PanelHeader>
            {panels.lightning.open && (
              <>
                <div>
                  <span className="tabular-nums text-text">{feed.state.inWindow.toLocaleString()}</span> on the globe now (last {lightWindow} min)
                </div>
                {place ? (
                  feed.state.storm?.nearest ? (
                    <div>
                      Nearest to you: <span className="tabular-nums text-text">{formatKm(feed.state.storm.nearest.km)} {compassOf(feed.state.storm.nearest.bearing)}</span>,{' '}
                      {Math.max(0, Math.round((Date.now() - feed.state.storm.nearest.strike.tMs) / 60_000))} min ago
                      {feed.state.storm.within100 > 0 && <span> · {feed.state.storm.within100} within 100 km</span>}
                    </div>
                  ) : (
                    <div>No lightning detected near you in the last 15 minutes</div>
                  )
                ) : (
                  <div>Set your location on the Dashboard for the nearest storm</div>
                )}
                <div className="text-[10px]">Lightning: Blitzortung.org contributors. Coverage is thinner over oceans and parts of Africa.</div>
              </>
            )}
          </div>
        )}
        {traffic.enabled && panels.traffic.shown && (
          <div className="max-w-xs space-y-1 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
            <PanelHeader open={panels.traffic.open} onToggle={() => updatePanel('traffic', { open: !panels.traffic.open })}>
              🌐 Web traffic:{' '}
              <span className="tabular-nums text-text">{traffic.live?.connections ?? 0}</span> connections to{' '}
              <span className="tabular-nums text-text">{traffic.live?.places.filter((p) => p.n > 0).length ?? 0}</span> places
            </PanelHeader>
            {panels.traffic.open && (
              <>
                {traffic.live && <TrafficLists live={traffic.live} max={5} />}
                {!place && <div className="text-warning">Set your location on the Dashboard to draw arcs from it: without it only the destinations show.</div>}
                {traffic.status?.database.available === false && <div className="text-warning">The IP location database is missing, so no places can be shown.</div>}
                {(traffic.live?.error || traffic.error) && <div className="text-warning">{traffic.live?.error ?? traffic.error}</div>}
                <button className="text-[11px] underline-offset-2 hover:text-text hover:underline" onClick={() => setTrafficHistory((h) => !h)}>
                  {trafficHistory ? 'Hide history' : 'History (last 7 days)'}
                </button>
                {trafficHistory && <TrafficHistoryView traffic={traffic} />}
                {!trafficHistory && <TrafficPrivacyNote />}
                <div className="text-[10px]">{traffic.status?.credit}. A place is where an address is registered, not proof of where a server or a person is.</div>
              </>
            )}
          </div>
        )}
        {sun && panels.overhead.shown && (
          <div className="rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted" title="The point on the Earth where the Sun is straight overhead, for the scene's time">
            <span style={{ color: '#ffd966' }}>●</span> Sun overhead:{' '}
            <span className="tabular-nums text-text">
              {Math.abs(sun.latDeg).toFixed(1)}° {sun.latDeg >= 0 ? 'N' : 'S'}, {Math.abs(sun.lonDeg).toFixed(1)}° {sun.lonDeg >= 0 ? 'E' : 'W'}
            </span>
            {live && <span className="ml-2 text-success">live</span>}
          </div>
        )}
        {asteroidsOn && asteroids.asteroids && panels.asteroids.shown && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
            <PanelHeader open={panels.asteroids.open} onToggle={() => updatePanel('asteroids', { open: !panels.asteroids.open })}>
              ☄ {asteroids.asteroids.length} approach{asteroids.asteroids.length === 1 ? '' : 'es'} in the next 7 days
              {asteroids.asteroids[0] && <span> · closest {relativeTime(asteroids.asteroids[0].close_approach_time, Date.now())}</span>}
            </PanelHeader>
            {panels.asteroids.open && (
              <>
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {asteroids.asteroids.slice(0, 8).map((a) => (
                    <div key={a.id} className="border-t border-border pt-1 first:border-0 first:pt-0">
                      <div className="text-text">
                        {a.is_hazardous && <span className="text-warning">⚠ </span>}
                        {a.name}
                      </div>
                      <div className="tabular-nums">
                        {relativeTime(a.close_approach_time, Date.now())} · {a.miss_distance_ld.toFixed(1)} LD · ~{Math.round(a.diameter_min_m)}-{Math.round(a.diameter_max_m)} m
                      </div>
                      {a.jpl_url && (
                        <button className="text-accent hover:underline" onClick={() => window.open(a.jpl_url!, '_blank')}>
                          JPL details
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="text-[10px]">{asteroids.payload?.credit ?? 'Near-Earth object data: NASA/JPL NeoWs.'} Distance and time only, not a 3D position: the data has no direction.</div>
              </>
            )}
          </div>
        )}
        {launchesOn && launchFeed.launches && launchFeed.launches.some(isUpcoming) && panels.launches.shown && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-1.5 text-xs text-text-muted">
            <PanelHeader open={panels.launches.open} onToggle={() => updatePanel('launches', { open: !panels.launches.open })}>
              🚀 Next launch {relativeTime(launchFeed.launches.find(isUpcoming)!.netMs ?? Date.now(), Date.now())}
            </PanelHeader>
            {panels.launches.open && (
              <>
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {launchFeed.launches.filter(isUpcoming).slice(0, 8).map((l) => (
                    <div key={l.id} className="border-t border-border pt-1 first:border-0 first:pt-0">
                      {l.lat != null && l.lon != null ? (
                        <button className="text-left text-text hover:text-accent hover:underline" onClick={() => engine.current?.viewLatLon(l.lat!, l.lon!)} title="Fly to the launch pad">
                          {l.name}
                        </button>
                      ) : (
                        <div className="text-text">{l.name}</div>
                      )}
                      <div className="tabular-nums">{l.netMs ? relativeTime(l.netMs, Date.now()) : 'time TBD'}{l.padName ? ` · ${l.padName}` : ''}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px]">{launchFeed.credit ?? 'Launch data: Launch Library 2.'}</div>
              </>
            )}
          </div>
        )}
        </div>

        <div className={`absolute bottom-56 left-2 z-10 flex flex-col gap-2 ${flyHud ? 'hidden' : ''}`}>
        {flowPick && (windOn || currentsOn) && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{windOn && currentsOn ? '💨🌊 Wind and currents' : windOn ? '💨 Wind' : '🌊 Sea current'} here</span>
              <button
                className="text-text-muted hover:text-text"
                onClick={() => {
                  setFlowPick(null)
                  engine.current?.setFlowPick(null)
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="tabular-nums text-text-muted">
              {Math.abs(flowPick.latDeg).toFixed(2)}° {flowPick.latDeg >= 0 ? 'N' : 'S'}, {Math.abs(flowPick.lonDeg).toFixed(2)}° {flowPick.lonDeg >= 0 ? 'E' : 'W'}
            </div>
            {windOn && (
              <div>
                <span className="text-text-muted">Wind ({WIND_LEVELS.find((l) => l.id === windLevel)?.label.split(' (')[0]}): </span>
                {windHere ? windWords(windHere.u, windHere.v) : 'no data'}
              </div>
            )}
            {currentsOn && (
              <div>
                <span className="text-text-muted">Sea current: </span>
                {currentHere ? currentWords(currentHere.u, currentHere.v) : 'none here (land, ice or no data)'}
              </div>
            )}
            <div className="text-[10px] text-text-muted">Model values for {dayClock((windOn ? wind.grid : currents.grid)?.validMs ?? Date.now())}, not a measurement at this spot.</div>
          </div>
        )}
        {traffic.enabled && trafficPlace && <TrafficDetailCard place={trafficPlace} onClose={() => setTrafficSel(null)} />}
        {strike && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: cssColour(ageColour(Math.min(1, strike.ageMs / (lightWindow * 60_000)))) }}>⚡</span> Lightning strike
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setStrike(null)} aria-label="Close strike">
                ✕
              </button>
            </div>
            <div className="tabular-nums text-text-muted">
              {new Date(strike.tMs).toLocaleTimeString()} ({Math.round(strike.ageMs / 1000)} s before you clicked)
            </div>
            <div className="tabular-nums">
              {Math.abs(strike.lat).toFixed(3)}° {strike.lat >= 0 ? 'N' : 'S'}, {Math.abs(strike.lon).toFixed(3)}° {strike.lon >= 0 ? 'E' : 'W'}
            </div>
            <div className="text-text-muted">
              heard by {strike.stations} receivers · position good to about {strike.accuracyM >= 1000 ? `${(strike.accuracyM / 1000).toFixed(1)} km` : `${strike.accuracyM} m`}
            </div>
            {place && (
              <div className="tabular-nums text-text-muted">
                {formatKm(distanceKm(place.latDeg, place.lonDeg, strike.lat, strike.lon))} {compassOf(bearingDeg(place.latDeg, place.lonDeg, strike.lat, strike.lon))} of your saved location
              </div>
            )}
          </div>
        )}
        {townHit && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                {townHit.capital ? '★ ' : ''}
                {townHit.name}
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setTownHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="text-text-muted">{[townHit.region, townHit.country].filter(Boolean).join(', ')}</div>
            <div className="tabular-nums text-text-muted">
              {townHit.population > 0 ? `${townHit.population.toLocaleString()} people · ` : ''}
              {townHit.latDeg.toFixed(3)}°, {townHit.lonDeg.toFixed(3)}°
            </div>
            <div className="flex gap-2 pt-1">
              <button className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text" onClick={() => setPlaceDraft({ name: townHit.name, lat: townHit.latDeg.toFixed(4), lon: townHit.lonDeg.toFixed(4) })}>
                Save as my place
              </button>
              <button className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text" onClick={() => engine.current?.viewLatLon(townHit.latDeg, townHit.lonDeg, 300)}>
                Fly there
              </button>
            </div>
          </div>
        )}
        {placeSel && myPlaces.find((pl) => pl.id === placeSel) && (
          <div className="max-w-xs space-y-1 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: '#4dd8ff' }}>●</span> {myPlaces.find((pl) => pl.id === placeSel)!.name}
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setPlaceSel(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="tabular-nums text-text-muted">
              {myPlaces.find((pl) => pl.id === placeSel)!.lat.toFixed(4)}°, {myPlaces.find((pl) => pl.id === placeSel)!.lon.toFixed(4)}° · one of my places
            </div>
            <div className="flex gap-2 pt-1">
              <button
                className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text"
                onClick={() => {
                  const cur = myPlaces.find((pl) => pl.id === placeSel)!
                  const name = window.prompt('Name for this place', cur.name)
                  if (name !== null) renameMyPlace(cur.id, name)
                }}
              >
                Rename
              </button>
              <button className="rounded border border-border px-2 py-0.5 hover:border-danger hover:text-danger" onClick={() => removeMyPlace(placeSel)}>
                Remove
              </button>
            </div>
          </div>
        )}
        {placeDraft && (
          <form
            className="max-w-xs space-y-1.5 rounded-md border border-accent bg-surface/95 px-3 py-2 text-xs text-text"
            onSubmit={(e) => {
              e.preventDefault()
              saveDraft()
            }}
          >
            <div className="text-sm font-semibold">New place</div>
            <input value={placeDraft.name} onChange={(e) => setPlaceDraft({ ...placeDraft, name: e.target.value })} placeholder="Name (e.g. Dark-sky field)" className="w-full rounded border border-border bg-bg px-1.5 py-1 text-text" autoFocus />
            <div className="flex gap-1.5">
              <input value={placeDraft.lat} onChange={(e) => setPlaceDraft({ ...placeDraft, lat: e.target.value })} placeholder="Latitude" className="w-1/2 rounded border border-border bg-bg px-1.5 py-1 text-text" />
              <input value={placeDraft.lon} onChange={(e) => setPlaceDraft({ ...placeDraft, lon: e.target.value })} placeholder="Longitude" className="w-1/2 rounded border border-border bg-bg px-1.5 py-1 text-text" />
            </div>
            {placeError && <div className="text-danger">{placeError}</div>}
            <div className="flex gap-2">
              <button type="submit" className="rounded border border-accent px-2 py-0.5 text-text hover:bg-accent/20">
                Save
              </button>
              <button type="button" className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text" onClick={() => { setPlaceDraft(null); setPlaceError(null) }}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {quakeHit && quakesOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: quakeHit.mag >= 6 ? '#ff5050' : quakeHit.mag >= 4.5 ? '#ff9a3d' : '#ffd84d' }}>●</span> Magnitude {quakeHit.mag.toFixed(1)} earthquake
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => { setQuakeHit(null); engine.current?.selectHazard(null) }} aria-label="Close">
                ✕
              </button>
            </div>
            {quakeInfo ? (
              <>
                <div className="text-text-muted">{quakeInfo.place || 'Location not named'}</div>
                <div className="tabular-nums">
                  {new Date(quakeInfo.t).toLocaleString()} <span className="text-text-muted">({ago(quakeInfo.t)})</span>
                </div>
                <div className="tabular-nums text-text-muted">
                  {magnitudeWords(quakeInfo.mag)} · depth {quakeInfo.depth.toFixed(0)} km{quakeInfo.mag_type ? ` · magnitude type ${quakeInfo.mag_type}` : ''}
                </div>
                {place && <div className="tabular-nums text-text-muted">{Math.round(distanceKm(place.latDeg, place.lonDeg, quakeInfo.lat, quakeInfo.lon)).toLocaleString()} km from your saved location</div>}
                {quakeInfo.tsunami === 1 && <div className="font-semibold text-danger">Tsunami warning issued (see tsunami.gov)</div>}
                {quakeInfo.alert && <div className="text-text-muted">USGS PAGER alert: {quakeInfo.alert}</div>}
                {quakeInfo.felt ? <div className="text-text-muted">{quakeInfo.felt.toLocaleString()} people reported feeling it</div> : null}
                {quakeInfo.url && (
                  <button className="pt-1 text-accent hover:underline" onClick={() => window.open(quakeInfo.url, '_blank')}>
                    USGS event page
                  </button>
                )}
              </>
            ) : (
              <div className="text-text-muted">Loading…</div>
            )}
          </div>
        )}
        {volcanoHit && volcanoesOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: VOLCANO_LEVELS[Math.max(0, Math.min(3, volcanoInfo?.level ?? volcanoHit.level))].colour }}>▲</span> {volcanoInfo?.name ?? 'Volcano'}
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => { setVolcanoHit(null); engine.current?.selectHazard(null) }} aria-label="Close">
                ✕
              </button>
            </div>
            {volcanoInfo ? (
              <>
                <div className="text-text-muted">
                  {[volcanoInfo.country, volcanoInfo.type, volcanoInfo.elevation != null ? `${volcanoInfo.elevation.toLocaleString()} m` : ''].filter(Boolean).join(' · ')}
                </div>
                <div style={{ color: VOLCANO_LEVELS[volcanoInfo.level].colour }}>{volcanoInfo.level_words}</div>
                <div className="text-text-muted">Last known eruption: {volcanoInfo.last_eruption}</div>
                {volcanoInfo.category && (
                  <div className="text-text-muted">
                    Weekly report ({volcanoInfo.report}): {volcanoInfo.category}
                  </div>
                )}
                {volcanoInfo.usgs_level && (
                  <div className="text-text-muted">
                    USGS alert level: {volcanoInfo.usgs_color} / {volcanoInfo.usgs_level}
                  </div>
                )}
                {volcanoInfo.heat_within_5km !== null && <div className="text-text-muted">{volcanoInfo.heat_within_5km} satellite heat detections within 5 km in the last day</div>}
                {volcanoInfo.summary && <div className="max-h-32 overflow-y-auto pt-1 text-[11px] leading-snug text-text-muted">{volcanoInfo.summary}</div>}
                <button className="pt-1 text-accent hover:underline" onClick={() => window.open(volcanoInfo.url, '_blank')}>
                  Smithsonian volcano page
                </button>
              </>
            ) : (
              <div className="text-text-muted">Loading…</div>
            )}
          </div>
        )}
        {cmeHit && sunOn && sunCmes && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: cmeHit.earth_directed ? '#ff6a3d' : '#6ad0ff' }}>●</span> Coronal mass ejection
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setCmeHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="tabular-nums">
              {Math.round(cmeHit.speed)} km/s · {cmeDirection(cmeHit)}
            </div>
            <div className="tabular-nums text-text-muted">
              Cone half-angle {Math.round(cmeHit.half_angle)}°{cmeHit.source ? ` · source ${cmeHit.source}` : ''}
            </div>
            {cmeHit.earth_directed && cmeHit.arrival && (
              <div className="text-warning">
                Arrives Earth {relativeTime(cmeHit.arrival, Date.now())} ({new Date(cmeHit.arrival).toLocaleString()})
                {cmeHit.arrival_source ? ` · ${cmeHit.arrival_source}` : ''}
              </div>
            )}
            {cmeHit.note && <div className="max-h-24 overflow-y-auto pt-1 text-[11px] leading-snug text-text-muted">{cmeHit.note}</div>}
          </div>
        )}
        {flareHit && sunOn && sunFlares && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: `#${flareColour(flareHit.class).getHexString()}` }}>●</span> {flareHit.class} flare
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setFlareHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            {flareHit.region && <div className="text-text-muted">Region AR{flareHit.region}</div>}
            <div className="tabular-nums text-text-muted">
              Began {new Date(flareHit.begin).toLocaleTimeString()} · peaked {new Date(flareHit.peak).toLocaleTimeString()}
              {flareHit.end ? ` · ended ${new Date(flareHit.end).toLocaleTimeString()}` : ''}
            </div>
            <div className="text-text-muted">{flareWords(flareHit.class)}</div>
            {radioBlackout(flareHit.class) && <div className="text-text-muted">Radio blackout: {radioBlackout(flareHit.class)}</div>}
          </div>
        )}
        {meteorHit && meteorsOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">☄ {meteorHit.name}</span>
              <button className="text-text-muted hover:text-text" onClick={() => setMeteorHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="tabular-nums text-text-muted">
              Up to {meteorHit.zhr}/hr under perfect skies{meteorHit.rateNow > 0 ? ` · ~${meteorHit.rateNow}/hr now, from here` : ' · not currently visible from here'}
            </div>
            <div className="text-text-muted">{meteorHit.note}</div>
          </div>
        )}
        {launchHit && launchesOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">🚀 {launchHit.name}</span>
              <button className="text-text-muted hover:text-text" onClick={() => setLaunchHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="text-text-muted">
              {[launchHit.provider, launchHit.rocketName].filter(Boolean).join(' · ')}
            </div>
            {launchHit.mission && <div className="text-text-muted">Mission: {launchHit.mission}</div>}
            {launchHit.padName && <div className="text-text-muted">{launchHit.padName}</div>}
            {launchHit.netMs && (
              <div className="tabular-nums">
                {relativeTime(launchHit.netMs, Date.now())} ({new Date(launchHit.netMs).toLocaleString()})
              </div>
            )}
            {launchHit.statusName && <div className="text-text-muted">{launchHit.statusName}</div>}
          </div>
        )}
        {aqiHit && aqiOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: aqiColour(aqiHit.aqi) }}>●</span> {aqiHit.name}
              </span>
              <button className="text-text-muted hover:text-text" onClick={() => setAqiHit(null)} aria-label="Close">
                ✕
              </button>
            </div>
            {aqiHit.country && <div className="text-text-muted">{aqiHit.country}</div>}
            <div className="tabular-nums">
              AQI <span style={{ color: aqiColour(aqiHit.aqi) }}>{Math.round(aqiHit.aqi)}</span> · {aqiLabel(aqiHit.aqi)}
            </div>
            <div className="tabular-nums text-text-muted">PM2.5: {aqiHit.pm25.toFixed(1)} µg/m³</div>
            {aqiHit.measuredAt && <div className="text-text-muted">Measured {relativeTime(aqiHit.measuredAt, Date.now())}</div>}
          </div>
        )}
        {shipHit && shipsOn && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                <span style={{ color: SHIP_CATS.find((c) => c.id === (shipInfo?.cat ?? shipHit.cat))?.colour }}>●</span> {shipInfo?.name || shipHit.mmsi}
              </span>
              <button
                className="text-text-muted hover:text-text"
                onClick={() => {
                  setShipHit(null)
                  engine.current?.selectShip(null)
                  if (followingShip !== null) {
                    engine.current?.followShip(null)
                    setFollowingShip(null)
                  }
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="text-text-muted">{[shipInfo?.type_words, shipInfo?.flag].filter(Boolean).join(' · ') || 'Vessel'}</div>
            {(() => {
              const sog = shipInfo?.sog_kn ?? shipHit.sogKn
              const course = shipInfo?.heading ?? shipInfo?.cog ?? shipHit.courseDeg
              return (
                <div className="tabular-nums">
                  {sog < 0.5 ? 'Not moving' : speedText(sog)}
                  {sog >= 0.5 && course != null ? ` · heading ${headingText(course)}` : ''}
                </div>
              )
            })()}
            {shipInfo?.destination && <div className="text-text-muted">Bound for {shipInfo.destination}</div>}
            {(shipInfo?.length_m || shipInfo?.draught_m) && (
              <div className="tabular-nums text-text-muted">
                {shipInfo.length_m ? `${shipInfo.length_m} m long${shipInfo.beam_m ? `, ${shipInfo.beam_m} m wide` : ''}` : ''}
                {shipInfo.draught_m ? `${shipInfo.length_m ? ' · ' : ''}draught ${shipInfo.draught_m} m` : ''}
              </div>
            )}
            <div className="tabular-nums text-text-muted">
              MMSI {shipHit.mmsi}
              {shipInfo?.imo ? ` · IMO ${shipInfo.imo}` : ''}
              {shipInfo?.callsign ? ` · ${shipInfo.callsign}` : ''}
            </div>
            <div className="pt-1">
              {followingShip === shipHit.mmsi ? (
                <button
                  className="rounded border border-accent px-2 py-0.5 text-text"
                  onClick={() => {
                    engine.current?.followShip(null)
                    setFollowingShip(null)
                  }}
                >
                  Stop following
                </button>
              ) : (
                <button className="rounded border border-border px-2 py-0.5 hover:border-accent hover:text-text" onClick={() => followShip(shipHit.mmsi)}>
                  Follow this ship
                </button>
              )}
            </div>
          </div>
        )}
        {plane && (
          <div className="max-w-xs space-y-0.5 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs text-text">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{plane.callsign || plane.hex.toUpperCase()}</span>
              <button className="text-text-muted hover:text-text" onClick={() => setPlane(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="flex items-center gap-1.5 text-text-muted">
              <AircraftIcon shape={kindInfo(plane.kind).shape} colour={kindInfo(plane.kind).colour} size={14} />
              {[kindInfo(plane.kind).label, plane.type, plane.reg].filter(Boolean).join(' · ')}
            </div>
            <div className="tabular-nums">
              {flightLevel(plane.altM)} ({Math.round(plane.altM).toLocaleString()} m) · {Math.round(plane.speedMs * 1.943844)} kt ({Math.round(plane.speedMs * 3.6)} km/h)
            </div>
            <div className="tabular-nums text-text-muted">
              heading {Math.round(plane.trackDeg)}° · {plane.vrateMs > 1 ? 'climbing' : plane.vrateMs < -1 ? 'descending' : 'level'}
            </div>
            <div className="tabular-nums text-text-muted">
              over {Math.abs(plane.latDeg).toFixed(2)}° {plane.latDeg >= 0 ? 'N' : 'S'}, {Math.abs(plane.lonDeg).toFixed(2)}° {plane.lonDeg >= 0 ? 'E' : 'W'}
            </div>
          </div>
        )}
        </div>

        {offline.length > 0 && (
          <div className="absolute left-2 top-16 z-10 max-w-md rounded-md border border-warning/40 bg-surface/90 px-3 py-1.5 text-xs text-text">
            Not available yet: {offline.join(', ')}. They need a connection the first time (or the offline pack in Settings); everything else is shown.
          </div>
        )}

        <div className="absolute inset-x-2 bottom-2 z-10 flex flex-col gap-2">
          <ScaleRuler distanceAU={viewAU} stops={earthOnly ? EARTH_STOPS : STOPS} onStop={goStop} onDistance={(au) => engine.current?.focusOn(engine.current.getFocus(), { distance: au })} />
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface/90 px-3 py-2 text-xs">
          <button onClick={() => setPlaying((p) => !p)} className={`${btn} w-[5.5rem] whitespace-nowrap`} title={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button
            onClick={() => {
              // like Play / Pause: while time runs backwards the button offers "Forward"; while paused it starts time running backwards
              if (!playing) {
                setReverse(true)
                setPlaying(true)
              } else setReverse((r) => !r)
            }}
            className={`${btn} w-[5.5rem] whitespace-nowrap ${playing && reverse ? '!border-accent !text-text' : ''}`}
            title={playing && reverse ? 'Time is running backwards: click to run it forwards' : 'Run time backwards'}
          >
            {playing && reverse ? '⏩ Forward' : '⏪ Reverse'}
          </button>
          <select value={speedIdx} onChange={(e) => setSpeedIdx(Number(e.target.value))} className="rounded-md border border-border bg-bg px-1.5 py-1 text-text">
            {SPEEDS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={-SLIDER_DAYS}
            max={SLIDER_DAYS}
            step={0.25}
            value={sliderDays}
            onChange={(e) => setTime(sliderBase + Number(e.target.value) * DAY_MS, false)}
            className="min-w-[8rem] flex-1 accent-accent"
            title="Scrub ±1 year around the last date you set"
          />
          <input
            type="datetime-local"
            step={1}
            value={utcInput(ms)}
            onChange={(e) => {
              const t = Date.parse(`${e.target.value}Z`)
              if (Number.isFinite(t)) setTime(t)
            }}
            className="rounded-md border border-border bg-bg px-1.5 py-1 text-text"
          />
          <span className="text-text-muted">{utcInput(ms) === '' ? fmtYear(ms) : 'UTC'}</span>
          {fromPhoto && (
            <button onClick={() => setTime(startMs)} className={btn} title="Back to the moment the photo was taken">
              Photo time
            </button>
          )}
          <button
            onClick={() => {
              setTime(Date.now())
              setSpeedIdx(REAL_TIME_IDX)
              setReverse(false)
              setPlaying(true)
            }}
            className={live ? `${btn} !border-accent !text-text` : btn}
            title="Follow the real clock: the Sun, the day and night line and the clouds are where they are right now"
          >
            {live ? '● Live' : 'Go live'}
          </button>
        </div>
        </div>
      </div>

      {infoOpen ? (
      <div className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface p-4">
        <button onClick={() => setInfoOpen(false)} className="float-right -mr-2 -mt-2 rounded px-1.5 py-0.5 text-sm leading-none text-text-muted hover:bg-accent/10 hover:text-text" title="Hide the information panel" aria-label="Hide the information panel">
          ›
        </button>
        {satSel !== null && satState ? (
          <>
            <div className="flex items-start justify-between gap-2">
              <h2 className="min-w-0 truncate text-lg font-semibold text-text" title={satState.rec.name}>{satState.rec.name}</h2>
              <button onClick={() => { setSatSel(null); engine.current?.selectSatellite(null) }} title="Close" className="shrink-0 px-1 text-lg leading-none text-text-muted hover:text-text">×</button>
            </div>
            <div className="text-xs text-text-muted">Satellite · NORAD {satState.rec.norad}{satState.rec.intl ? ` · ${satState.rec.intl}` : ''}</div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-text-muted">Altitude</dt>
              <dd className="text-right text-text">{Math.round(satState.heightKm).toLocaleString()} km</dd>
              <dt className="text-text-muted">Speed</dt>
              <dd className="text-right text-text">{satState.speedKmS.toFixed(2)} km/s</dd>
              <dt className="text-text-muted">Over</dt>
              <dd className="text-right text-text">{Math.abs(satState.latDeg).toFixed(1)}° {satState.latDeg >= 0 ? 'N' : 'S'}, {Math.abs(satState.lonDeg).toFixed(1)}° {satState.lonDeg >= 0 ? 'E' : 'W'}</dd>
              <dt className="text-text-muted">Lighting</dt>
              <dd className="text-right text-text">{satState.sunlit ? 'Sunlit' : 'In Earth’s shadow'}</dd>
              <dt className="text-text-muted">Period</dt>
              <dd className="text-right text-text">{((2 * Math.PI) / satState.rec.rec.no).toFixed(1)} min</dd>
            </dl>
            <div className="mt-4 flex gap-2">
              {following === satState.rec.norad ? (
                <button onClick={() => { engine.current?.followSatellite(null); setFollowing(null) }} className="flex-1 rounded-md border border-accent px-3 py-1.5 text-sm font-medium text-text">Stop following</button>
              ) : (
                <button
                  onClick={() => {
                    engine.current?.followSatellite(satState.rec.norad)
                    setFollowing(satState.rec.norad)
                    setSatNote(null)
                  }}
                  className="flex-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
                >
                  Follow it
                </button>
              )}
            </div>
            {following === satState.rec.norad && <p className="mt-2 text-[11px] leading-snug text-text-muted">The camera stays with it as it orbits: press Play with “Real time” to watch it go round. Drag to look around it, wheel to move closer.</p>}
            <p className="mt-3 text-[11px] leading-snug text-text-muted">Position computed from CelesTrak orbit data with SGP4 (accurate to a few km near the data’s date).</p>
          </>
        ) : info ? (
          <>
            <h2 className="text-lg font-semibold text-text">{info.name}</h2>
            <div className="text-xs text-text-muted">{KIND_LABEL[info.kind]}</div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {info.facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-text-muted">{f.label}</dt>
                  <dd className="text-right text-text">{f.value}</dd>
                </div>
              ))}
            </dl>
            {info.note && <p className="mt-3 text-[11px] leading-snug text-text-muted">{info.note}</p>}
            {info.detail && !compact && (
              <button
                onClick={() => navigate(`/deep-space?kind=${info.detail!.kind}&key=${encodeURIComponent(info.detail!.key)}`)}
                className="mt-4 w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg"
              >
                Photos &amp; description
              </button>
            )}
          </>
        ) : (
          <div className="text-sm text-text-muted">Click a body, or pick one from the list.</div>
        )}
        <div className="mt-6 space-y-1 border-t border-border pt-3 text-[10px] leading-snug text-text-muted">
          <p>
            Drag to orbit · wheel to zoom · Q E to roll · click a body to fly to it.{' '}
            <button className="rounded border border-border px-1.5 py-0.5 hover:border-accent hover:text-text" onClick={() => engine.current?.resetRoll()}>
              Reset roll (R)
            </button>
          </p>
          <p>Planet, Moon and Galilean-moon positions: astronomy-engine. Sky backdrop: Hipparcos (d3-celestial). The Milky Way's spiral arms are a schematic model.</p>
          {credits.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      </div>
      ) : (
        <button
          onClick={() => setInfoOpen(true)}
          className="flex w-7 shrink-0 flex-col items-center gap-3 border-l border-border bg-surface py-2 text-text-muted hover:bg-accent/10 hover:text-text"
          title="Show the information panel"
          aria-label="Show the information panel"
        >
          <span className="text-sm leading-none">‹</span>
          <span className="text-[10px] font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">{satSel !== null && satState ? satState.rec.name : (info?.name ?? 'Info')}</span>
        </button>
      )}
    </div>
  )
}
