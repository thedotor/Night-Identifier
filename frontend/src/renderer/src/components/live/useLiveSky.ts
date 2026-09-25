import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as S from '@renderer/lib/skyMath'
import { loadCatalogue, precess, starLabel, starVec, type Catalogue, type SkyView } from '@renderer/lib/skyCatalogue'
import { solarSystem, type Body } from '@renderer/lib/skyEphemeris'
import { autoMagLimit, DEFAULT_LAYERS, drawOverlay, nearbyStars, type Candidate, type Layers } from '@renderer/lib/skyRender'
import {
  alignmentInFrame,
  cameraAt,
  carryDirection,
  DEFAULT_SKY_SETTINGS,
  parseNumber,
  siteFrom,
  type SkyAlignment,
  type SkySettings
} from '@renderer/lib/liveSky'
import { live, errorText } from '@renderer/lib/liveApi'
import type { SolveRequest, SolveResponse } from '@renderer/lib/plateSolve.worker'
import SolveWorker from '@renderer/lib/plateSolve.worker?worker'
import type { SkyEdit, SkyLayer } from './FeedCanvas'

const DEG = Math.PI / 180
const SAVE_DEBOUNCE_MS = 300
const BODIES_EVERY_MS = 20_000
const PICK_RADIUS_CSS_PX = 36
const LOCATION_KEY = 'night-identifier:last-location' // shared with the Sky Overlay page

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
  /** for FeedCanvas: null while the overlay is off */
  skyLayer: SkyLayer | null
  /** for FeedCanvas: null unless the mouse should edit the alignment right now */
  skyEdit: SkyEdit | null
}

const storeKey = (camId: string): string => `live-view:sky:${camId}`

function readSettings(camId: string): SkySettings {
  const base = { ...DEFAULT_SKY_SETTINGS }
  try {
    const raw = localStorage.getItem(storeKey(camId))
    if (raw) Object.assign(base, JSON.parse(raw) as Partial<SkySettings>)
    if (!raw || (!base.lat && !base.lon)) {
      const last = JSON.parse(localStorage.getItem(LOCATION_KEY) ?? 'null') as { lat?: string; lon?: string } | null
      if (last?.lat && last?.lon) {
        base.lat = last.lat
        base.lon = last.lon
      }
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

  // Everything the callbacks and the painter need, always current.
  const latest = useRef({ settings, catalogue, view, bodies, pairs, layers, frameW, frameH })
  latest.current = { settings, catalogue, view, bodies, pairs, layers, frameW, frameH }

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
        if (parseNumber(settings.lat) !== null && parseNumber(settings.lon) !== null)
          localStorage.setItem(LOCATION_KEY, JSON.stringify({ lat: settings.lat, lon: settings.lon }))
      } catch {
        /* the alignment just will not survive a restart */
      }
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [camId, settings])

  useEffect(() => () => worker.current?.terminate(), [])

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
    },
    [frameJd, update]
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
  }, [busy, camId, cameraNow, frameJd, update])

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
  useEffect(() => setRev((n) => n + 1), [settings, catalogue, view, bodies, pairs, mode])

  const paint = useCallback<SkyLayer['paint']>((ctx, m) => {
    const { settings: st, catalogue: cat, view: sky, bodies: bs, pairs: ps, layers: lay } = latest.current
    if (!cat || !sky || !st.alignment) return
    lastK.current = m.k
    const date = new Date()
    const cam = cameraAt(st.alignment, S.julianDate(date), m.width, m.height, st.tracking)
    if (!cam) return
    drawOverlay({ ctx, cam, cat, view: sky, layers: lay, k: m.k, observer: siteFrom(st.lat, st.lon, date), pairs: [], bodies: bs })
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

  const skyLayer = useMemo<SkyLayer | null>(
    () => (on && alignment ? { key: String(rev), paint, animate: !tracking } : null),
    [on, alignment, rev, paint, tracking]
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
    skyLayer,
    skyEdit
  }
}
