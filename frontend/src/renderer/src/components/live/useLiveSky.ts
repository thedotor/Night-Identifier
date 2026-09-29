import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as S from '@renderer/lib/skyMath'
import { loadCatalogue, precess, starLabel, starVec, type Catalogue, type SkyView } from '@renderer/lib/skyCatalogue'
import { solarSystem, type Body } from '@renderer/lib/skyEphemeris'
import { autoMagLimit, DEFAULT_LAYERS, drawOverlay, nearbyStars, type Candidate, type Layers } from '@renderer/lib/skyRender'
import {
  alignmentInFrame,
  cameraAt,
  carryDirection,
  checkAlignment,
  type AlignmentCheck,
  DEFAULT_SKY_SETTINGS,
  parseNumber,
  siteFrom,
  type SkyAlignment,
  type SkySettings
} from '@renderer/lib/liveSky'
import { live, errorText } from '@renderer/lib/liveApi'
import { rememberPlace } from '@renderer/lib/location'
import { api } from '@renderer/lib/api'
import { buildPlaneFrame, parseAircraft, type Aircraft, type AircraftPayload, type PlaneFrame } from '@renderer/lib/aircraft'
import type { AircraftKind } from '@renderer/lib/aircraftIcons'
import { useAircraftKinds, type AircraftKindFilter } from '@renderer/components/aircraft/AircraftKinds'
import {
  buildPinned,
  buildSatFrame,
  elementAgeDays,
  EMPTY_STATS,
  medianEpochMs,
  recordsIn,
  sampleOne,
  SatTracker,
  statsOf,
  TrailCache,
  type SatCatalogue,
  type SatFrame,
  type SatOptions,
  type SatSample,
  type SatStats,
  type Site
} from '@renderer/lib/satellites'
import { useSatCatalogue, useSatOptions } from '@renderer/components/sky/useSatellites'
import { activeShowers } from '@renderer/lib/eventsSky'
import { MeteorStreakSpawner, type MeteorStreak } from '@renderer/lib/meteorStreaks'
import type { SolveRequest, SolveResponse } from '@renderer/lib/plateSolve.worker'
import SolveWorker from '@renderer/lib/plateSolve.worker?worker'
import type { SkyEdit, SkyLayer } from './FeedCanvas'

const DEG = Math.PI / 180
const SAVE_DEBOUNCE_MS = 300
const BODIES_EVERY_MS = 20_000
const PICK_RADIUS_CSS_PX = 36
const LOCATION_KEY = 'night-identifier:last-location' // shared with the Sky Overlay page
const SAT_PUBLISH_MS = 1000 // how often the panel and card are told about the satellites (the picture repaints more often)
const SAT_CLICK_RADIUS_CSS_PX = 14
const ISS_NORAD = 25544
const PLANE_RADIUS_NM = 150 // how far around the camera aircraft are fetched
const PLANE_POLL_MS = 5000

export type SkyMode = 'move' | 'pick'

export interface SkyPair {
  x: number // where the star was clicked, in the camera's own pixels
  y: number
  dir: S.Vec3 // catalogue direction in the session frame
  jd: number // when it was clicked: the sky has turned since
  label: string
}

export interface SkyCandidates {
  at: { x: number; y: number }
  screen: { x: number; y: number }
  list: (Candidate & { label: string })[]
}

/** Satellite controls and what the panel shows about them. */
export interface LiveSatellites {
  enabled: boolean
  setEnabled: (on: boolean) => void
  options: SatOptions
  setOptions: (patch: Partial<SatOptions>) => void
  view: { stats: SatStats; cat: SatCatalogue | null; loading: boolean; error: string | null; ageDays: number }
  /** what the satellites still need ('location') */
  missing: string[]
  lag: number
  setLag: (s: number) => void
  /** the picked satellite, for its card */
  card: { sample: SatSample; site: Site; date: Date } | null
  close: () => void
}

export interface LivePlanes {
  enabled: boolean
  setEnabled: (on: boolean) => void
  /** aircraft above the horizon in the last picture (after the kind filter) */
  count: number
  /** every aircraft above the horizon by kind, whether its kind is shown or not */
  counts: Partial<Record<AircraftKind, number>>
  kinds: AircraftKindFilter
  loading: boolean
  error: string | null
  credit: string | null
  /** ms since 1970 the data was fetched */
  fetchedAt: number | null
  missing: string[]
}

export interface LiveMeteors {
  enabled: boolean
  setEnabled: (on: boolean) => void
  /** whichever real meteor showers currently cover this place and date, with a rough rate */
  active: { name: string; rateNow: number }[]
  missing: string[]
}

export interface LiveSky {
  settings: SkySettings
  layers: Layers
  update: (patch: Partial<SkySettings>) => void
  setLayer: <K extends keyof Layers>(k: K, v: Layers[K]) => void
  ready: boolean
  aligned: boolean
  /** camera as it is now, or null before there is an alignment and a picture */
  camera: S.Camera | null
  observer: S.Observer | null
  centreAltAz: { alt: number; az: number } | null
  busy: 'auto' | 'fit' | null
  message: { kind: 'info' | 'error'; text: string } | null
  mode: SkyMode
  setMode: (m: SkyMode) => void
  pairs: SkyPair[]
  removePair: (i: number) => void
  clearPairs: () => void
  candidates: SkyCandidates | null
  choose: (c: Candidate) => void
  dismissCandidates: () => void
  autoAlign: () => Promise<void>
  fitPairs: (o: { fitFov: boolean; fitK1: boolean }) => void
  aim: (alt: number, az: number, tilt: number) => void
  setFov: (deg: number) => void
  setK1: (k1: number) => void
  setLens: (lens: S.Projection) => void
  reset: () => void
  setTracking: (on: boolean) => void
  /** a place typed for this camera only (the camera then stops following the app's saved location) */
  setPlace: (lat: string, lon: string) => void
  /** go back to the location saved for the whole app */
  followAppPlace: () => void
  /** whether the stored alignment still lines up with the stars; `stale` hides the overlay until the user decides */
  check: { busy: boolean; result: AlignmentCheck | null; stale: boolean }
  runCheck: () => Promise<void>
  keepAnyway: () => void
  /** for FeedCanvas: null while the overlay is off */
  skyLayer: SkyLayer | null
  /** for FeedCanvas: null unless the mouse should edit the alignment right now */
  skyEdit: SkyEdit | null
  sat: LiveSatellites
  planes: LivePlanes
  meteors: LiveMeteors
}

const storeKey = (camId: string): string => `live-view:sky:${camId}`

/** The location saved for the whole app (Dashboard, Sky Overlay, Deep Space), as text, or null. */
function savedPlace(): { lat: string; lon: string } | null {
  try {
    const last = JSON.parse(localStorage.getItem(LOCATION_KEY) ?? 'null') as { lat?: unknown; lon?: unknown } | null
    if (last && last.lat !== undefined && last.lon !== undefined && parseNumber(String(last.lat)) !== null && parseNumber(String(last.lon)) !== null) return { lat: String(last.lat), lon: String(last.lon) }
  } catch {
    /* none */
  }
  return null
}

function readSettings(camId: string): SkySettings {
  const base = { ...DEFAULT_SKY_SETTINGS }
  try {
    const raw = localStorage.getItem(storeKey(camId))
    const saved = raw ? (JSON.parse(raw) as Partial<SkySettings>) : null
    if (saved) Object.assign(base, saved)
    const app = savedPlace()
    // A camera saved before "own location" existed had a place typed in for it: keep that one if it differs from the app's.
    if (saved && saved.ownPlace === undefined && saved.lat && saved.lon && app && (saved.lat !== app.lat || saved.lon !== app.lon)) base.ownPlace = true
    if (app && !base.ownPlace) {
      base.lat = app.lat
      base.lon = app.lon
    }
  } catch {
    /* fall back to the defaults */
  }
  return base
}

/**
 * The star overlay for one camera in Live View: alignment (auto or manual), locking, and painting
 * the catalogue over the picture so that it follows the sky as it turns.
 */
export function useLiveSky(camId: string, frameW: number | null, frameH: number | null): LiveSky {
  const [settings, setSettings] = useState<SkySettings>(() => readSettings(camId))
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  // The catalogue is precessed once, to the moment this view opened. Alignments are kept in that frame.
  const frameJd = useMemo(() => S.julianDate(new Date()), [])
  const [view, setView] = useState<SkyView | null>(null)
  const [bodies, setBodies] = useState<Body[]>([])
  const [pairs, setPairs] = useState<SkyPair[]>([])
  const [mode, setMode] = useState<SkyMode>('move')
  const [busy, setBusy] = useState<'auto' | 'fit' | null>(null)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [candidates, setCandidates] = useState<SkyCandidates | null>(null)
  const [rev, setRev] = useState(0)
  const worker = useRef<Worker | null>(null)
  const lastK = useRef(0.5)

  const { on, locked, tracking, alignment } = settings
  const hasFrame = !!frameW && !!frameH
  const layers = useMemo<Layers>(() => ({ ...DEFAULT_LAYERS, art: false, ...settings.layers }), [settings.layers])

  // ---------- satellites ----------
  const [satOptions, setSatOptions] = useSatOptions()
  const satSite = useMemo<Site | null>(() => {
    const la = parseNumber(settings.lat)
    const lo = parseNumber(settings.lon)
    return la !== null && lo !== null && Math.abs(la) <= 90 && Math.abs(lo) <= 360 ? { latDeg: la, lonDeg: lo } : null
  }, [settings.lat, settings.lon])
  const satOn = on && !!layers.satellites
  const satData = useSatCatalogue(satOptions.groups, satOn && !!satSite)
  const satRecords = useMemo(() => (satData.cat ? recordsIn(satData.cat, satOptions.groups) : []), [satData.cat, satOptions.groups])
  const satTracker = useMemo(() => new SatTracker(satRecords), [satRecords])
  const satMedian = useMemo(() => medianEpochMs(satRecords), [satRecords])
  const satTrails = useRef(new TrailCache())
  const [satSelected, setSatSelected] = useState<number | null>(null)
  const [satLive, setSatLive] = useState<{ stats: SatStats; selected: SatSample | null }>({ stats: EMPTY_STATS, selected: null })
  const satPainted = useRef<{ frame: SatFrame; cam: S.Camera } | null>(null)
  const satPublishedAt = useRef(0)
  const satReady = !!satData.cat

  // The ISS is always shown (its own tick box), even under the horizon or out of the frame.
  const pinOn = on && satOptions.pinIss && !!satSite
  const issData = useSatCatalogue(['iss'], pinOn)
  const issRec = useMemo(() => issData.cat?.records.find((r) => r.norad === ISS_NORAD) ?? null, [issData.cat])
  const pinTrails = useRef(new TrailCache())

  // Aircraft around the camera, refreshed every few seconds and moved along their tracks in between.
  const planesOn = on && settings.planes && !!satSite
  const planeRows = useRef<Aircraft[]>([])
  const [planeInfo, setPlaneInfo] = useState<{ loading: boolean; error: string | null; credit: string | null; fetchedAt: number | null }>({ loading: false, error: null, credit: null, fetchedAt: null })
  const [planeCount, setPlaneCount] = useState(0)
  const [planeCounts, setPlaneCounts] = useState<Partial<Record<AircraftKind, number>>>({})
  const planeKinds = useAircraftKinds()
  const siteLat = satSite?.latDeg
  const siteLon = satSite?.lonDeg
  useEffect(() => {
    if (!planesOn || siteLat === undefined || siteLon === undefined) {
      planeRows.current = []
      setPlaneCount(0)
      setPlaneCounts({})
      return
    }
    let live = true
    setPlaneInfo((p) => ({ ...p, loading: true }))
    const load = (): void => {
      api
        .get<AircraftPayload>(`/aircraft/nearby?lat=${siteLat}&lon=${siteLon}&radius_nm=${PLANE_RADIUS_NM}`)
        .then((d) => {
          if (!live) return
          planeRows.current = parseAircraft(d)
          setPlaneInfo({ loading: false, error: d.stale ? 'showing the last answer: the aircraft service is not answering' : null, credit: d.credit, fetchedAt: d.fetched_at * 1000 })
        })
        .catch((e) => live && setPlaneInfo((p) => ({ ...p, loading: false, error: e instanceof Error ? e.message.replace(/^\{"detail":"|"\}$/g, '') : 'could not load aircraft' })))
    }
    load()
    const t = window.setInterval(load, PLANE_POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [planesOn, siteLat, siteLon])
  const planeCountShown = useRef(0)
  const planeCountsShown = useRef('')

  // Meteor-shower streaks: brief moving/fading lines near a real radiant, spawned at roughly the
  // shower's real rate while its active date range covers this place. `active` is only for the panel;
  // the spawner itself is stepped fresh each paint (it needs the actual frame time, not a poll interval).
  const meteorsOn = on && settings.meteors && !!satSite
  const meteorSpawner = useRef(new MeteorStreakSpawner())
  const [meteorActive, setMeteorActive] = useState<{ name: string; rateNow: number }[]>([])
  useEffect(() => {
    if (!meteorsOn || siteLat === undefined || siteLon === undefined) {
      setMeteorActive([])
      return
    }
    const refresh = (): void => setMeteorActive(activeShowers(Date.now(), { latDeg: siteLat, lonDeg: siteLon }).map((r) => ({ name: r.shower.name, rateNow: r.rateNow })))
    refresh()
    const t = window.setInterval(refresh, 60_000)
    return () => window.clearInterval(t)
  }, [meteorsOn, siteLat, siteLon])

  // Everything the callbacks and the painter need, always current.
  const [check, setCheck] = useState<{ busy: boolean; result: AlignmentCheck | null; stale: boolean }>({ busy: false, result: null, stale: false })
  const latest = useRef({ settings, catalogue, view, bodies, pairs, layers, frameW, frameH, satOn, satSite, satOptions, satTracker, satSelected, satReady, pinOn, issRec, planesOn, meteorsOn, hiddenKinds: planeKinds.hidden, stale: check.stale })
  latest.current = { settings, catalogue, view, bodies, pairs, layers, frameW, frameH, satOn, satSite, satOptions, satTracker, satSelected, satReady, pinOn, issRec, planesOn, meteorsOn, hiddenKinds: planeKinds.hidden, stale: check.stale }

  const update = useCallback((patch: Partial<SkySettings>): void => setSettings((s) => ({ ...s, ...patch })), [])

  // ---------- loading ----------
  useEffect(() => {
    if (!on || catalogue) return
    let cancelled = false
    loadCatalogue()
      .then((c) => {
        if (cancelled) return
        setCatalogue(c)
        setView(precess(c, frameJd))
      })
      .catch(() => !cancelled && setMessage({ kind: 'error', text: 'Could not load the sky catalogue from the backend.' }))
    return () => {
      cancelled = true
    }
  }, [on, catalogue, frameJd])

  // A stored alignment may be from an earlier session, with the stars precessed to another date.
  useEffect(() => {
    if (!alignment || alignment.frameJd === frameJd) return
    const moved = alignmentInFrame(alignment, frameJd)
    if (moved) setSettings((s) => (s.alignment === alignment ? { ...s, alignment: moved } : s))
  }, [alignment, frameJd])

  // The Sun, Moon and planets move too, but slowly enough to refresh every so often.
  const observerNow = useMemo(() => siteFrom(settings.lat, settings.lon, new Date()), [settings.lat, settings.lon])
  useEffect(() => {
    if (!on) return
    const refresh = (): void => setBodies(solarSystem(S.julianDate(new Date()), siteFrom(latest.current.settings.lat, latest.current.settings.lon, new Date())))
    refresh()
    const t = setInterval(refresh, BODIES_EVERY_MS)
    return () => clearInterval(t)
  }, [on, settings.lat, settings.lon])

  // ---------- persistence ----------
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storeKey(camId), JSON.stringify(settings))
        // a place typed here becomes the app's place only when the app has none yet
        if (parseNumber(settings.lat) !== null && parseNumber(settings.lon) !== null && !savedPlace()) rememberPlace(settings.lat, settings.lon)
      } catch {
        /* the alignment just will not survive a restart */
      }
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [camId, settings])

  useEffect(() => () => worker.current?.terminate(), [])

  // ---------- where the camera is ----------
  // Unless a place was typed for this camera, it follows the location saved for the whole app (also when that is changed in another window).
  const { ownPlace } = settings
  useEffect(() => {
    if (ownPlace) return
    const sync = (): void => {
      const app = savedPlace()
      if (app) setSettings((s) => (s.ownPlace || (s.lat === app.lat && s.lon === app.lon) ? s : { ...s, lat: app.lat, lon: app.lon }))
    }
    sync()
    const onStorage = (e: StorageEvent): void => {
      if (e.key === LOCATION_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [ownPlace])
  /** A place typed for this camera only. */
  const setPlace = useCallback((lat: string, lon: string): void => setSettings((s) => ({ ...s, lat, lon, ownPlace: true })), [])
  /** Back to the location saved for the whole app. */
  const followAppPlace = useCallback((): void => {
    const app = savedPlace()
    setSettings((s) => ({ ...s, ownPlace: false, ...(app ?? {}) }))
  }, [])

  // ---------- is a stored alignment still right? ----------
  const checked = useRef(false)
  const runCheck = useCallback(
    async (quiet = false): Promise<void> => {
      const { catalogue: cat, view: sky, settings: st } = latest.current
      if (!cat || !sky || !st.alignment) return
      setCheck((c) => ({ ...c, busy: true }))
      try {
        const found = await live.stars(camId)
        const cam = cameraAt(st.alignment, S.julianDate(new Date(found.timestamp * 1000)), found.width, found.height, st.tracking)
        if (!cam) throw new Error('The stored alignment could not be read.')
        // where the catalogue stars should be in this picture
        const limit = autoMagLimit(cam.fovH / DEG) + 0.5
        const predicted: { x: number; y: number }[] = []
        for (let n = 0; n < cat.order.length; n++) {
          const i = cat.order[n]
          if (cat.mag[i] > limit) break
          const p = S.project(cam, starVec(sky, i))
          if (p && p.x >= 0 && p.y >= 0 && p.x <= found.width && p.y <= found.height) predicted.push(p)
        }
        const result = checkAlignment(found.stars, predicted, found.width, found.height)
        setCheck({ busy: false, result, stale: result.verdict === 'off' })
      } catch (err) {
        setCheck({ busy: false, result: null, stale: false })
        if (!quiet) setMessage({ kind: 'error', text: errorText(err) })
      }
    },
    [camId]
  )
  /** A new alignment was made just now: nothing to check. */
  const settled = useCallback((): void => {
    checked.current = true
    setCheck({ busy: false, result: null, stale: false })
  }, [])
  /** Once per visit: when the picture and the catalogue are there, see whether the stored alignment still lines up with the stars. */
  useEffect(() => {
    if (checked.current || !on || !alignment || alignment.how === 'guess' || alignment.frameJd !== frameJd || !catalogue || !view || !hasFrame) return
    const t = window.setTimeout(() => {
      if (checked.current) return
      checked.current = true
      void runCheck(true)
    }, 1500)
    return () => window.clearTimeout(t)
  }, [on, alignment, frameJd, catalogue, view, hasFrame, runCheck])
  const keepAnyway = useCallback((): void => setCheck((c) => ({ ...c, stale: false })), [])

  // ---------- the camera ----------
  const nowJd = (): number => S.julianDate(new Date())
  const cameraNow = useCallback((): S.Camera | null => {
    const { settings: st, frameW: w, frameH: h } = latest.current
    if (!st.alignment || !w || !h) return null
    return cameraAt(st.alignment, nowJd(), w, h, st.tracking)
  }, [])

  /** Make `cam` (true right now) the alignment. */
  const commit = useCallback(
    (cam: S.Camera, how: SkyAlignment['how'], extra?: { rmsPx?: number; matched?: number }): void => {
      update({ alignment: { camera: S.cameraToJson(cam), jd0: nowJd(), frameJd, how, ...extra } })
      settled()
    },
    [frameJd, update, settled]
  )

  const withCamera = useCallback(
    (fn: (cam: S.Camera) => S.Camera): void => {
      const cam = cameraNow()
      if (!cam) return
      commit(fn(cam), 'manual')
      setMessage((m) => (m ? null : m)) // "Aligned: 45 of 45 stars matched" no longer describes it
    },
    [cameraNow, commit]
  )

  const defaultCamera = useCallback((w: number, h: number): S.Camera => {
    const st = latest.current.settings
    const fov = parseNumber(st.fovDeg) ?? 60
    const base = S.makeCamera(0, 0, 0, Math.min(fov, S.maxFovH(st.lens) * 0.999 / DEG), st.lens, w, h)
    const site = siteFrom(st.lat, st.lon, new Date())
    return site ? S.cameraFromAltAz(base, 45, site.latDeg >= 0 ? 180 : 0, 0, site) : base
  }, [])

  // Turning the overlay on with nothing aligned yet: start from a sensible guess to drag from.
  useEffect(() => {
    if (on && !alignment && hasFrame && catalogue) {
      commit(defaultCamera(frameW!, frameH!), 'guess')
      setMessage({ kind: 'info', text: 'Not aligned yet: drag the sky onto the stars, or press Auto-align.' })
    }
  }, [on, alignment, hasFrame, catalogue, frameW, frameH, commit, defaultCamera])

  // ---------- auto-align ----------
  const autoAlign = useCallback(async (): Promise<void> => {
    const cat = latest.current.catalogue
    if (!cat || busy) return
    setBusy('auto')
    setCandidates(null)
    setMessage({ kind: 'info', text: 'Finding the stars in the picture…' })
    try {
      const found = await live.stars(camId)
      if (found.stars.length < 6)
        throw new Error(`Only ${found.stars.length} stars found in the picture, too few to solve. Try a longer exposure or more gain, and check the lens is not covered.`)
      const st = latest.current.settings
      // Start from whatever field of view the overlay has now (dragging and scaling may have improved on the typed guess).
      const now = cameraNow()
      const fov = Math.min(now ? now.fovH / DEG : (parseNumber(st.fovDeg) ?? 60), (S.maxFovH(st.lens) / DEG) * 0.999)
      const template = S.makeCamera(0, 0, 0, fov, st.lens, found.width, found.height)
      const frameTime = S.julianDate(new Date(found.timestamp * 1000))
      setMessage({ kind: 'info', text: `Matching ${Math.min(found.stars.length, 45)} stars against the catalogue…` })
      worker.current?.terminate()
      const w = new SolveWorker()
      worker.current = w
      const req: SolveRequest = {
        ra: cat.ra,
        dec: cat.dec,
        mag: cat.mag,
        jd: frameJd,
        detected: found.stars,
        camera: { ...template, k1: S.cameraFromJson(st.alignment?.camera, 1, 1)?.k1 ?? 0 },
        fovKnown: st.fovKnown,
        fitK1: false
      }
      const resp = await new Promise<SolveResponse>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<SolveResponse>) => resolve(e.data)
        w.onerror = (e) => reject(new Error(e.message))
        w.postMessage(req)
      })
      w.terminate()
      if (!resp.ok) throw new Error(resp.error)
      if (!resp.result) {
        setMessage({
          kind: 'error',
          text: 'No confident match. Check the lens type (fisheye vs normal) and the field of view, and that the sky is reasonably clear, then try again. Or align by hand.'
        })
        return
      }
      const r = resp.result
      // The picture the stars were found in is a moment old; the alignment is true for that moment.
      update({
        alignment: { camera: S.cameraToJson(r.camera), jd0: frameTime, frameJd, how: 'auto', rmsPx: r.rmsPx, matched: r.matches.length },
        fovDeg: (r.camera.fovH / DEG).toFixed(1),
        lens: r.camera.projection
      })
      settled()
      setPairs([])
      setMessage({
        kind: 'info',
        text: `Aligned: ${r.matches.length} of ${r.detectedInFrame} stars matched, RMS ${r.rmsPx.toFixed(1)} px, field of view ${(r.camera.fovH / DEG).toFixed(1)}°. Lock it once it looks right.`
      })
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }, [busy, camId, cameraNow, frameJd, update, settled])

  // ---------- manual: click stars, then fit ----------
  const pick = useCallback((at: { x: number; y: number }, screen: { x: number; y: number }): void => {
    const cam = cameraNow()
    const { catalogue: cat, view: sky, layers: lay } = latest.current
    if (!cam || !cat || !sky) return
    const radius = PICK_RADIUS_CSS_PX / (lastK.current || 0.5)
    const list = nearbyStars(cam, cat, sky, at.x, at.y, radius, autoMagLimit(cam.fovH / DEG, lay.magOffset) + 1.5).map((c) => ({ ...c, label: starLabel(cat, c.index) }))
    setCandidates({ at, screen, list })
  }, [cameraNow])

  const choose = useCallback(
    (c: Candidate): void => {
      const cat = latest.current.catalogue
      const sky = latest.current.view
      if (!candidates || !cat || !sky) return
      setPairs((p) => [...p, { x: candidates.at.x, y: candidates.at.y, dir: starVec(sky, c.index), jd: nowJd(), label: starLabel(cat, c.index) }])
      setCandidates(null)
    },
    [candidates]
  )

  const fitPairs = useCallback(
    (o: { fitFov: boolean; fitK1: boolean }): void => {
      const cam = cameraNow()
      const list = latest.current.pairs
      if (!cam || list.length < 2) return
      setBusy('fit')
      const jd = nowJd()
      // Stars clicked at different moments have turned with the sky since; bring each to now first.
      const sol = S.solveCamera(
        cam,
        list.map((p) => ({ pixel: { x: p.x, y: p.y }, dir: carryDirection(p.dir, p.jd, jd) })),
        { fitFov: o.fitFov && list.length >= 3, fitK1: o.fitK1 }
      )
      setBusy(null)
      if (!sol) return setMessage({ kind: 'error', text: 'Could not fit those stars: check that two of them are not the same star.' })
      commit(sol.camera, 'manual', { rmsPx: sol.rmsPx, matched: list.length })
      setMessage({ kind: 'info', text: `Fitted ${list.length} stars, RMS error ${sol.rmsPx.toFixed(1)} px.` })
    },
    [cameraNow, commit]
  )

  const aim = useCallback(
    (alt: number, az: number, tilt: number): void => {
      const site = siteFrom(latest.current.settings.lat, latest.current.settings.lon, new Date())
      if (!site) return setMessage({ kind: 'error', text: 'Enter your latitude and longitude to aim by altitude and azimuth.' })
      withCamera((cam) => S.cameraFromAltAz(cam, alt, az, tilt, site))
    },
    [withCamera]
  )

  const setFov = useCallback((deg: number): void => withCamera((cam) => S.scaleFov(cam, (deg * DEG) / cam.fovH)), [withCamera])
  const setK1 = useCallback((k1: number): void => withCamera((cam) => ({ ...cam, k1 })), [withCamera])

  const setLens = useCallback(
    (lens: S.Projection): void => {
      update({ lens })
      withCamera((cam) => ({ ...cam, projection: lens, fovH: Math.min(cam.fovH, S.maxFovH(lens) * 0.999) }))
    },
    [update, withCamera]
  )

  const reset = useCallback((): void => {
    const { frameW: w, frameH: h } = latest.current
    if (!w || !h) return
    setPairs([])
    commit(defaultCamera(w, h), 'guess')
    setMessage({ kind: 'info', text: 'Alignment reset. Drag the sky onto the stars, or press Auto-align.' })
  }, [commit, defaultCamera])

  // On a tracking mount the stars hold still in the picture, so the alignment must stop turning.
  // Re-anchor at the moment of the switch so the overlay does not jump.
  const setTracking = useCallback(
    (next: boolean): void => {
      const cam = cameraNow()
      setSettings((s) => ({ ...s, tracking: next }))
      if (cam) update({ alignment: { camera: S.cameraToJson(cam), jd0: nowJd(), frameJd, how: latest.current.settings.alignment?.how ?? 'manual' } })
    },
    [cameraNow, frameJd, update]
  )

  const setLayer = useCallback(<K extends keyof Layers>(k: K, v: Layers[K]): void => setSettings((s) => ({ ...s, layers: { ...s.layers, [k]: v } })), [])

  // ---------- painting ----------
  useEffect(() => {
    satPublishedAt.current = 0 // a change in what is picked or chosen is reported at the next paint
    setRev((n) => n + 1)
  }, [settings, catalogue, view, bodies, pairs, mode, satOptions, satReady, satSelected, satSite, planeKinds.hidden, check.stale])

  const paint = useCallback<SkyLayer['paint']>((ctx, m) => {
    const { settings: st, catalogue: cat, view: sky, bodies: bs, pairs: ps, layers: lay } = latest.current
    if (!cat || !sky || !st.alignment) return
    if (latest.current.stale) return // the stored alignment no longer lines up with the stars: draw nothing rather than something wrong
    lastK.current = m.k
    const date = new Date()
    const cam = cameraAt(st.alignment, S.julianDate(date), m.width, m.height, st.tracking)
    if (!cam) return

    // Satellites are evaluated where they were `satLag` seconds ago (the picture is that far behind the clock)
    // but converted to sky directions in the camera's frame at `date`, which is what the camera is drawn for.
    let sats: SatFrame | null = null
    const { satOn: satsOn, satSite: site, satOptions: opts, satTracker: tracker, satSelected: picked, satReady: ready } = latest.current
    if (satsOn && site && ready) {
      const satDate = new Date(date.getTime() - st.satLag * 1000)
      const samples = tracker.sample(satDate, site)
      sats = buildSatFrame({
        samples,
        frame: { latDeg: site.latDeg, lonDeg: site.lonDeg, date },
        site,
        date: satDate,
        opts,
        trailCache: satTrails.current,
        selected: picked
      })
      satPainted.current = { frame: sats, cam }
      const now = performance.now()
      if (now - satPublishedAt.current >= SAT_PUBLISH_MS) {
        satPublishedAt.current = now
        let sel: SatSample | null = null
        if (picked !== null) {
          sel = samples.find((x) => x.rec.norad === picked) ?? null
          if (!sel) {
            const rec = tracker.records.find((r) => r.norad === picked)
            sel = rec ? sampleOne(rec, satDate, site) : null
          }
        }
        setSatLive({ stats: statsOf(samples, sats.dots.length), selected: sel })
      }
    } else satPainted.current = null

    // the ISS, wherever it is (and even with the satellite layer off), and the aircraft
    const { pinOn: pin, issRec: iss, planesOn: planesShown } = latest.current
    if (pin && iss && site) {
      const satDate = new Date(date.getTime() - st.satLag * 1000)
      const pinned = buildPinned(iss, satDate, site, { latDeg: site.latDeg, lonDeg: site.lonDeg, date }, pinTrails.current)
      if (pinned) {
        sats = sats ?? { dots: [], trails: [], selected: null, labelAll: false }
        sats.pinned = pinned
      }
    }
    let planes: PlaneFrame | null = null
    if (planesShown && site) {
      planes = buildPlaneFrame(planeRows.current, date.getTime() - st.satLag * 1000, site, { latDeg: site.latDeg, lonDeg: site.lonDeg, date }, latest.current.hiddenKinds)
      if (planes.dots.length !== planeCountShown.current) {
        planeCountShown.current = planes.dots.length
        setPlaneCount(planes.dots.length)
      }
      const key = JSON.stringify(planes.counts)
      if (key !== planeCountsShown.current) {
        planeCountsShown.current = key
        setPlaneCounts(planes.counts)
      }
    }

    let meteors: MeteorStreak[] | null = null
    if (latest.current.meteorsOn && site) meteors = meteorSpawner.current.step(date.getTime(), { latDeg: site.latDeg, lonDeg: site.lonDeg })

    drawOverlay({ ctx, cam, cat, view: sky, layers: lay, k: m.k, observer: siteFrom(st.lat, st.lon, date), pairs: [], bodies: bs, sats, planes, meteors })
    // the stars picked for a fit, numbered where the overlay now puts them
    const px = 1 / m.k
    ctx.lineWidth = 1.5 * px
    ctx.strokeStyle = '#facc15'
    ctx.fillStyle = '#facc15'
    ctx.font = `bold ${12 * px}px sans-serif`
    ctx.textBaseline = 'middle'
    ps.forEach((p, i) => {
      const q = S.project(cam, p.dir)
      if (!q) return
      ctx.beginPath()
      ctx.arc(q.x, q.y, 9 * px, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillText(String(i + 1), q.x + 12 * px, q.y - 10 * px)
    })
  }, [])

  /** A click on the picture: pick the satellite under it, or let go of the picked one. */
  const click = useCallback<NonNullable<SkyLayer['click']>>((at, m) => {
    const painted = satPainted.current
    if (!painted) return false
    let best: { norad: number; d: number } | null = null
    for (const dot of painted.frame.dots) {
      const q = S.project(painted.cam, dot.dir)
      if (!q) continue
      const d = Math.hypot(q.x - at.x, q.y - at.y) * m.k
      if (d <= SAT_CLICK_RADIUS_CSS_PX && (!best || d < best.d)) best = { norad: dot.s.rec.norad, d }
    }
    if (best) {
      setSatSelected(best.norad)
      return true
    }
    if (latest.current.satSelected !== null) setSatSelected(null)
    return false
  }, [])

  const skyLayer = useMemo<SkyLayer | null>(
    () => (on && alignment ? { key: String(rev), paint, click, animate: !tracking || satOn || pinOn || planesOn || meteorsOn } : null),
    [on, alignment, rev, paint, click, tracking, satOn, pinOn, planesOn, meteorsOn]
  )

  const skyEdit = useMemo<SkyEdit | null>(
    () =>
      on && alignment && !locked && catalogue
        ? {
            mode,
            pan: (from, to) => withCamera((cam) => S.panCamera(cam, from, to)),
            roll: (deg) => withCamera((cam) => S.rollCamera(cam, deg)),
            scale: (factor, at) =>
              withCamera((cam) => {
                // scale about the cursor: the sky point under it stays put
                const under = S.unproject(cam, at.x, at.y)
                let next = S.scaleFov(cam, factor)
                const p = S.project(next, under)
                if (p) next = S.panCamera(next, p, at)
                return next
              }),
            pick
          }
        : null,
    [on, alignment, locked, catalogue, mode, withCamera, pick]
  )

  // ---------- what the panel shows ----------
  const camera = on && hasFrame ? cameraNow() : null
  const centreAltAz = camera && observerNow ? S.vecAltAz(camera.forward, { ...observerNow, date: new Date() }) : null

  return {
    settings,
    layers,
    update,
    setLayer,
    ready: !!catalogue && !!view,
    aligned: !!alignment && alignment.how !== 'guess',
    camera,
    observer: observerNow,
    centreAltAz,
    busy,
    message,
    mode,
    setMode,
    pairs,
    removePair: (i) => setPairs((p) => p.filter((_, j) => j !== i)),
    clearPairs: () => setPairs([]),
    candidates,
    choose,
    dismissCandidates: () => setCandidates(null),
    autoAlign,
    fitPairs,
    aim,
    setFov,
    setK1,
    setLens,
    reset,
    setTracking,
    setPlace,
    followAppPlace,
    check,
    runCheck: () => runCheck(false),
    keepAnyway,
    skyLayer,
    skyEdit,
    sat: {
      enabled: !!layers.satellites,
      setEnabled: (v) => setSettings((st) => ({ ...st, layers: { ...st.layers, satellites: v } })),
      options: satOptions,
      setOptions: setSatOptions,
      view: {
        stats: satLive.stats,
        cat: satData.cat,
        loading: satData.loading,
        error: satData.error,
        ageDays: elementAgeDays(satMedian, new Date(Date.now() - settings.satLag * 1000))
      },
      missing: satSite ? [] : ['location'],
      lag: settings.satLag,
      setLag: (v) => setSettings((st) => ({ ...st, satLag: v })),
      card:
        satOn && satSelected !== null && satSite && satLive.selected && satLive.selected.rec.norad === satSelected
          ? { sample: satLive.selected, site: satSite, date: new Date() }
          : null,
      close: () => setSatSelected(null)
    },
    planes: {
      enabled: settings.planes,
      setEnabled: (v) => setSettings((st) => ({ ...st, planes: v })),
      count: planeCount,
      counts: planeCounts,
      kinds: planeKinds,
      loading: planeInfo.loading,
      error: planeInfo.error,
      credit: planeInfo.credit,
      fetchedAt: planeInfo.fetchedAt,
      missing: satSite ? [] : ['location']
    },
    meteors: {
      enabled: settings.meteors,
      setEnabled: (v) => setSettings((st) => ({ ...st, meteors: v })),
      active: meteorActive,
      missing: satSite ? [] : ['location']
    }
  }
}
