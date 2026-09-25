import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { initialImageId, rememberImage } from '@renderer/lib/lastImage'
import { api, previewUrl, type ImageRecord } from '@renderer/lib/api'
import * as S from '@renderer/lib/skyMath'
import { dsoGroup, loadCatalogue, precess, starLabel, starVec, type Catalogue } from '@renderer/lib/skyCatalogue'
import { solarSystem } from '@renderer/lib/skyEphemeris'
import { inAnyRegion, useBlockedAreas } from '@renderer/lib/blockedAreas'
import { DEFAULT_LAYERS, type Layers, type PairMark } from '@renderer/lib/skyRender'
import { SkyOverlayCanvas, type PickedStar, type SkyMode } from '@renderer/components/sky/SkyOverlayCanvas'
import type { SolveRequest, SolveResponse } from '@renderer/lib/plateSolve.worker'
import SolveWorker from '@renderer/lib/plateSolve.worker?worker'

interface SkyInit {
  width: number
  height: number
  projection: S.Projection
  fov_h_deg: number | null
  focal_mm: number | null
  lens_model: string | null
  camera_model: string | null
  observer: {
    latitude: number | null
    longitude: number | null
    utc: string | null
    local: string | null
    time_source: string | null
    exposure_s: number | null
  }
}

interface SavedAlignment {
  camera: Record<string, unknown> | null
  pairs: SavedPair[] | null
  observer: ObserverText | null
  layers: Partial<Layers> | null
}

interface SavedPair {
  x: number
  y: number
  ra: number
  dec: number
  label: string
}

interface ObserverText {
  lat: string
  lon: string
  utc: string // "YYYY-MM-DD HH:mm:ss", UTC
}

const DEG = Math.PI / 180
const SAVE_DEBOUNCE_MS = 700
const TIME_SOURCE_NOTE: Record<string, string> = {
  gps: 'from GPS time',
  offset: 'from the EXIF timezone offset',
  longitude: 'estimated from longitude — check it'
}

const parseUtc = (s: string): Date | null => {
  const m = s.trim().replace(' ', 'T')
  const d = new Date(/z$|[+-]\d\d:?\d\d$/i.test(m) ? m : `${m}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
const fmtUtc = (iso: string): string => iso.replace('T', ' ').slice(0, 19)
const num = (s: string): number | null => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null)

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="border-b border-border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</div>
      <div className="space-y-2 text-xs text-text">{children}</div>
    </div>
  )
}

/** Number box that commits on Enter/blur; re-syncs whenever the value changes underneath it. */
function NumField(props: {
  label: string
  value: number
  digits?: number
  onCommit: (v: number) => void
  suffix?: string
}): ReactElement {
  const shown = props.value.toFixed(props.digits ?? 2)
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{props.label}</span>
      <span className="flex items-center gap-1">
        <input
          key={shown}
          defaultValue={shown}
          onBlur={(e) => {
            const v = num(e.target.value)
            if (v !== null && v.toFixed(props.digits ?? 2) !== shown) props.onCommit(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="w-24 rounded border border-border bg-bg px-1 py-0.5 text-right text-text"
        />
        {props.suffix && <span className="w-3 text-text-muted">{props.suffix}</span>}
      </span>
    </label>
  )
}

const btn =
  'whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs font-medium text-text-muted hover:border-accent hover:text-text disabled:opacity-50'
interface SearchItem {
  label: string
  sub: string
  vec: S.Vec3
}

const DSO_LABEL = { nebulae: 'Nebula', galaxies: 'Galaxy', clusters: 'Star cluster' } as const

const lockKey = (id: number | null): string => `sky-overlay-locked-${id}`
const readLock = (id: number | null): boolean => {
  try {
    return localStorage.getItem(lockKey(id)) === '1'
  } catch {
    return false
  }
}
const writeLock = (id: number, on: boolean): void => {
  try {
    localStorage.setItem(lockKey(id), on ? '1' : '0')
  } catch {
    /* the lock just won't survive a reload */
  }
}
const btnPrimary = 'whitespace-nowrap rounded-md border border-accent bg-accent/20 px-2 py-1 text-xs font-medium text-text hover:bg-accent/30 disabled:opacity-50'

export function SkyOverlay(): ReactElement {
  const navigate = useNavigate()
  const [images, setImages] = useState<ImageRecord[]>([])
  const [imageId, setImageId] = useState<number | null>(null)
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [init, setInit] = useState<SkyInit | null>(null)
  const [camera, setCamera] = useState<S.Camera | null>(null)
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [observer, setObserver] = useState<ObserverText>({ lat: '', lon: '', utc: '' })
  const [pairs, setPairs] = useState<SavedPair[]>([])
  const [mode, setMode] = useState<SkyMode>('move')
  const blocked = useBlockedAreas(imageId)
  const [detected, setDetected] = useState<[number, number][]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<null | 'auto' | 'solve'>(null)
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [fitFov, setFitFov] = useState(true)
  const [fitK1, setFitK1] = useState(false)
  const [locked, setLocked] = useState(false)
  const [tzHours, setTzHours] = useState('0')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [highlight, setHighlight] = useState<S.Vec3 | null>(null)
  const [viewTarget, setViewTarget] = useState<{ x: number; y: number; n: number } | null>(null)
  const [aim, setAim] = useState({ alt: '35', az: '180', tilt: '0' })
  const workerRef = useRef<Worker | null>(null)
  const detectedFor = useRef<number | null>(null)

  // ---------- loading ----------
  useEffect(() => {
    api
      .get<ImageRecord[]>('/images')
      .then((imgs) => {
        setImages(imgs)
        setImageId(initialImageId(imgs))
      })
      .catch(() => setMessage({ kind: 'error', text: 'Could not load images from the backend.' }))
    loadCatalogue()
      .then(setCatalogue)
      .catch(() => setMessage({ kind: 'error', text: 'Could not load the sky catalogue.' }))
  }, [])

  useEffect(() => {
    setLoaded(false)
    setCamera(null)
    setInit(null)
    setPairs([])
    setDetected([])
    setLocked(readLock(imageId))
    detectedFor.current = null
    setMode('move')
    setMessage(null)
    if (imageId == null) return
    let cancelled = false
    Promise.all([
      api.get<SkyInit>(`/sky/${imageId}/init`),
      api.get<SavedAlignment>(`/sky/${imageId}/alignment`)
    ])
      .then(([i, saved]) => {
        if (cancelled) return
        setInit(i)
        const obsText: ObserverText = saved.observer ?? {
          lat: i.observer.latitude != null ? String(i.observer.latitude) : '',
          lon: i.observer.longitude != null ? String(i.observer.longitude) : '',
          utc: i.observer.utc ? fmtUtc(i.observer.utc) : ''
        }
        setObserver(obsText)
        const savedLayers = (saved.layers ?? {}) as Partial<Layers> & { dsos?: boolean }
        // Older saves had a single "deep-sky objects" switch; it now covers three.
        const dsoOff = savedLayers.dsos === false ? { nebulae: false, galaxies: false, clusters: false } : {}
        setLayers({ ...DEFAULT_LAYERS, ...dsoOff, ...savedLayers })
        setPairs(saved.pairs ?? [])
        const savedCam = S.cameraFromJson(saved.camera, i.width, i.height)
        if (savedCam) setCamera(savedCam)
        else setCamera(defaultCamera(i, obsText))
        setLoaded(true)
      })
      .catch(() => !cancelled && setMessage({ kind: 'error', text: 'Could not load this image’s sky data.' }))
    return () => {
      cancelled = true
    }
  }, [imageId])

  // Detected stars: hints while picking, and the input to auto-align.
  const fetchDetected = useCallback(async (): Promise<[number, number, number][]> => {
    if (imageId == null) return []
    detectedFor.current = imageId
    const r = await api.get<{ stars: [number, number, number][] }>(`/sky/${imageId}/stars`)
    setDetected(r.stars.map(([x, y]) => [x, y]))
    return r.stars
  }, [imageId])

  useEffect(() => {
    if (mode === 'pick' && imageId != null && detectedFor.current !== imageId) void fetchDetected().catch(() => undefined)
  }, [mode, imageId, fetchDetected])

  // ---------- derived sky state ----------
  const observerDate = useMemo(() => parseUtc(observer.utc), [observer.utc])
  // What the zoom-out to space needs and this photo lacks (most camera files carry no GPS).
  const liftNeeds = useMemo(() => {
    const lat = num(observer.lat)
    const lon = num(observer.lon)
    const out: string[] = []
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 360) out.push('location')
    if (!observerDate) out.push('time')
    return out
  }, [observer.lat, observer.lon, observerDate])

  // Remember the last location typed in, so the next photo without GPS can reuse it in one click.
  const [lastLocation, setLastLocation] = useState<{ lat: string; lon: string } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('night-identifier:last-location') ?? 'null')
    } catch {
      return null
    }
  })
  useEffect(() => {
    if (liftNeeds.includes('location')) return
    const here = { lat: observer.lat, lon: observer.lon }
    try {
      localStorage.setItem('night-identifier:last-location', JSON.stringify(here))
    } catch {
      /* not remembered */
    }
    setLastLocation(here)
  }, [liftNeeds, observer.lat, observer.lon])

  const observerObj = useMemo<S.Observer | null>(() => {
    const lat = num(observer.lat)
    const lon = num(observer.lon)
    if (lat === null || lon === null || !observerDate || Math.abs(lat) > 90) return null
    return { latDeg: lat, lonDeg: lon, date: observerDate }
  }, [observer.lat, observer.lon, observerDate])

  // The camera lives in the of-date frame; without a time, "now" is the best guess.
  const jd = useMemo(() => S.julianDate(observerDate ?? new Date()), [observerDate])
  const view = useMemo(() => (catalogue ? precess(catalogue, jd) : null), [catalogue, jd])
  // Sun, Moon and planets at the photo's time (the Moon is shifted for where the photo was taken).
  const bodies = useMemo(() => solarSystem(jd, observerObj), [jd, observerObj])

  const pairMarks = useMemo<PairMark[]>(() => {
    const m = S.precessionMatrix(jd)
    return pairs.map((p, i) => ({ n: i + 1, x: p.x, y: p.y, dir: S.applyMatrix(m, S.radecToVec(p.ra, p.dec)) }))
  }, [pairs, jd])

  const residuals = useMemo(
    () =>
      camera
        ? pairMarks.map((p) => {
            const q = S.project(camera, p.dir)
            return q ? Math.hypot(q.x - p.x, q.y - p.y) : null
          })
        : [],
    [camera, pairMarks]
  )

  const pointing = useMemo(() => (camera ? S.cameraPointing(camera) : null), [camera])
  const centreAltAz = useMemo(() => (camera && observerObj ? S.vecAltAz(camera.forward, observerObj) : null), [camera, observerObj])

  // ---------- persistence ----------
  useEffect(() => {
    if (!loaded || imageId == null || !camera) return
    const t = setTimeout(() => {
      api
        .put(`/sky/${imageId}/alignment`, { camera: S.cameraToJson(camera), pairs, observer, layers })
        .catch(() => setMessage({ kind: 'error', text: 'Could not save the alignment.' }))
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [loaded, imageId, camera, pairs, observer, layers])

  useEffect(() => {
    if (imageId != null) writeLock(imageId, locked)
  }, [imageId, locked])

  // The camera's clock time (EXIF DateTimeOriginal) has no timezone; UTC = local - offset,
  // taken at the middle of the exposure since the sky turns ~15 arcsec per second.
  const applyLocalTime = (): void => {
    const local = init?.observer.local
    const tz = num(tzHours)
    if (!local || tz === null) return
    const asUtc = parseUtc(local)
    if (!asUtc) return
    const half = ((init?.observer.exposure_s ?? 0) / 2) * 1000
    const utc = new Date(asUtc.getTime() - tz * 3600_000 + half)
    setObserver((o) => ({ ...o, utc: fmtUtc(utc.toISOString()) }))
  }

  // ---------- search ----------
  const searchItems = useMemo<SearchItem[]>(() => {
    if (!catalogue || !view) return []
    const items: SearchItem[] = catalogue.figures.map((f, i) => ({
      label: f.name,
      sub: f.kind === 'constellation' ? `Constellation · ${f.abbr}` : 'Asterism',
      vec: view.figureCentres[i]
    }))
    catalogue.names.forEach((name, i) =>
      items.push({ label: name, sub: `Star · mag ${catalogue.mag[i].toFixed(1)}`, vec: starVec(view, i) })
    )
    catalogue.dsos.forEach((d, i) =>
      items.push({ label: d.name ? `${d.id} ${d.name}` : d.id, sub: `${DSO_LABEL[dsoGroup(d.type)]} · ${d.type}`, vec: view.dsos[i] })
    )
    for (const b of bodies)
      items.push({ label: b.name, sub: b.kind === 'planet' ? 'Planet' : b.name === 'Sun' ? 'Star (the Sun)' : 'Moon', vec: b.vec })
    return items
  }, [catalogue, view, bodies])

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const starts: SearchItem[] = []
    const contains: SearchItem[] = []
    for (const it of searchItems) {
      const l = it.label.toLowerCase()
      if (l.startsWith(q)) starts.push(it)
      else if (l.includes(q) || it.sub.toLowerCase().startsWith(q)) contains.push(it)
    }
    return [...starts, ...contains].slice(0, 12)
  }, [query, searchItems])

  const goTo = (item: SearchItem): void => {
    if (!camera) return
    setSearchOpen(false)
    setQuery('')
    setHighlight(item.vec)
    const at = S.project(camera, item.vec)
    if (locked) {
      // Overlay is frozen: bring the object to the middle of the screen by panning the photo.
      if (!at) return setMessage({ kind: 'error', text: `${item.label} is outside what this lens can image.` })
      setViewTarget({ x: at.x, y: at.y, n: Date.now() })
    } else {
      // Aim the sky map so the object sits at the image centre, keeping its orientation.
      const centre = { x: camera.width / 2, y: camera.height / 2 }
      setCamera(at ? S.panCamera(camera, at, centre) : S.pointCamera(camera, S.vecToRadec(item.vec).ra, S.vecToRadec(item.vec).dec))
      setViewTarget({ ...centre, n: Date.now() })
    }
    setMessage({ kind: 'info', text: `${item.label} — ${item.sub}` })
  }

  // ---------- actions ----------
  const setLayer = <K extends keyof Layers>(k: K, v: Layers[K]): void => setLayers((l) => ({ ...l, [k]: v }))

  const onPick = (p: PickedStar): void => {
    if (!catalogue) return
    setPairs((prev) => [
      ...prev,
      { x: p.x, y: p.y, ra: catalogue.ra[p.starIndex], dec: catalogue.dec[p.starIndex], label: p.label }
    ])
  }

  const solveManual = (): void => {
    if (!camera || pairs.length < 2) return
    setBusy('solve')
    const m = S.precessionMatrix(jd)
    const obs = pairs.map((p) => ({ pixel: { x: p.x, y: p.y }, dir: S.applyMatrix(m, S.radecToVec(p.ra, p.dec)) }))
    const sol = S.solveCamera(camera, obs, { fitFov: fitFov && pairs.length >= 3, fitK1 })
    setBusy(null)
    if (!sol) return setMessage({ kind: 'error', text: 'Could not fit those pairs — check that two picks are not the same star.' })
    setCamera(sol.camera)
    setMessage({
      kind: 'info',
      text: `Fitted ${pairs.length} stars, RMS error ${sol.rmsPx.toFixed(1)} px${pairs.length < 3 ? ' (field of view kept from EXIF/current)' : ''}.`
    })
  }

  const autoAlign = async (): Promise<void> => {
    if (!camera || !catalogue || !init) return
    setBusy('auto')
    setMessage({ kind: 'info', text: 'Detecting stars…' })
    try {
      const stars = await fetchDetected()
      if (stars.length < 6) throw new Error(`Only ${stars.length} stars detected — too few to solve.`)
      setMessage({ kind: 'info', text: `Matching ${Math.min(stars.length, 45)} stars against the catalogue…` })
      workerRef.current?.terminate()
      const worker = new SolveWorker()
      workerRef.current = worker
      const req: SolveRequest = {
        ra: catalogue.ra,
        dec: catalogue.dec,
        mag: catalogue.mag,
        jd,
        detected: stars,
        camera,
        fovKnown: init.fov_h_deg != null,
        fitK1
      }
      const resp = await new Promise<SolveResponse>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<SolveResponse>) => resolve(e.data)
        worker.onerror = (e) => reject(new Error(e.message))
        worker.postMessage(req)
      })
      worker.terminate()
      if (!resp.ok) throw new Error(resp.error)
      if (!resp.result) {
        setMessage({
          kind: 'error',
          text: 'No confident match. Check the projection type (fisheye vs normal) and field of view, then try again — or align by hand with Pick stars.'
        })
        return
      }
      const r = resp.result
      setCamera(r.camera)
      setPairs(
        r.matches.map((mt) => ({
          x: mt.x,
          y: mt.y,
          ra: catalogue.ra[mt.star],
          dec: catalogue.dec[mt.star],
          label: starLabel(catalogue, mt.star)
        }))
      )
      setMessage({
        kind: 'info',
        text: `Solved: ${r.matches.length} of ${r.detectedInFrame} detected stars matched, RMS ${r.rmsPx.toFixed(1)} px, field of view ${(r.camera.fovH / DEG).toFixed(1)}°. Remove any wrong pairs and re-fit if needed.`
      })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Auto-align failed.' })
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => () => workerRef.current?.terminate(), [])

  const resetFromExif = (): void => {
    if (!init) return
    setPairs([])
    setCamera(defaultCamera(init, observer))
    setMessage({ kind: 'info', text: 'Reset to the EXIF lens and time. EXIF has no pointing direction, so aim the overlay or use Point by alt/az.' })
  }

  const applyAim = (): void => {
    if (!camera || !observerObj) return
    const alt = num(aim.alt)
    const az = num(aim.az)
    const tilt = num(aim.tilt) ?? 0
    if (alt === null || az === null) return
    setCamera(S.cameraFromAltAz(camera, alt, az, tilt, observerObj))
  }

  const changeProjection = (projection: S.Projection): void => {
    if (!camera) return
    const fov = Math.min(camera.fovH, S.maxFovH(projection) * 0.999)
    setCamera({ ...camera, projection, fovH: fov })
  }

  // ---------- render ----------
  const selected = images.find((i) => i.id === imageId) ?? null

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-44 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border p-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Images</div>
        <div className="flex-1 overflow-y-auto p-2">
          {images.length === 0 && <div className="mt-4 px-2 text-center text-xs text-text-muted">No images yet. Add some in Upload &amp; Watch Folder.</div>}
          {images.map((img) => (
            <button
              key={img.id}
              onClick={() => {
                setImageId(img.id)
                rememberImage(img.id)
              }}
              className={`mb-2 block w-full overflow-hidden rounded-md border text-left ${img.id === imageId ? 'border-accent' : 'border-border hover:border-accent/50'}`}
            >
              <img src={previewUrl(img.id)} alt={img.filename} className="h-20 w-full object-cover" />
              <div className="truncate px-1 py-0.5 text-[11px] text-text-muted">{img.filename}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <div className="flex overflow-hidden rounded-md border border-border text-xs">
            {(['move', 'pick', 'block'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`whitespace-nowrap px-3 py-1 font-medium ${mode === m ? 'bg-accent/25 text-text' : 'text-text-muted hover:text-text'}`}
              >
                {m === 'move' ? 'Move overlay' : m === 'pick' ? 'Pick stars' : 'Block areas'}
              </button>
            ))}
          </div>
          <button
            onClick={() => setLocked((v) => !v)}
            disabled={!camera}
            title={locked ? 'Unlock to edit the alignment again' : 'Freeze the overlay so it cannot be moved by accident'}
            className={locked ? 'rounded-md border border-warning bg-warning/20 px-2 py-1 text-xs font-medium text-text' : btn}
          >
            {locked ? '🔒 Locked' : '🔓 Lock overlay'}
          </button>
          <button onClick={() => void autoAlign()} disabled={!camera || !catalogue || busy !== null || locked} className={btnPrimary}>
            {busy === 'auto' ? 'Solving…' : 'Auto-align'}
          </button>
          <button onClick={resetFromExif} disabled={!init || locked} className={btn}>
            Reset from EXIF
          </button>
          <button
            onClick={() => navigate(`/deep-space?view=solar${observerDate ? `&t=${encodeURIComponent(observerDate.toISOString())}` : ''}`)}
            title="See where the planets were, in 3D, at the moment this photo was taken"
            className={btn}
          >
            Solar system ↗
          </button>
          <div className="relative ml-auto w-64 shrink-0">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSearchOpen(true)
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchResults[0]) goTo(searchResults[0])
                if (e.key === 'Escape') setSearchOpen(false)
              }}
              placeholder="Find constellation, star, object…"
              disabled={!camera}
              className="w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-text placeholder:text-text-muted"
            />
            {searchOpen && searchResults.length > 0 && (
              <div className="absolute right-0 top-full z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-xl">
                {searchResults.map((r, i) => (
                  <button
                    key={`${r.label}-${i}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(r)}
                    className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent/20"
                  >
                    <span className="text-text">{r.label}</span>
                    <span className="ml-2 text-text-muted">{r.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {message && (
            <span className={`min-w-0 max-w-[30%] shrink truncate text-xs ${message.kind === 'error' ? 'text-danger' : 'text-text-muted'}`} title={message.text}>
              {message.text}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {camera && selected ? (
            <SkyOverlayCanvas
              imageUrl={previewUrl(selected.id)}
              camera={camera}
              catalogue={catalogue}
              view={view}
              layers={layers}
              observer={observerObj}
              mode={mode}
              locked={locked}
              highlight={highlight}
              bodies={bodies}
              viewTarget={viewTarget}
              pairs={pairMarks}
              detected={detected.filter(([x, y]) => !inAnyRegion(x, y, blocked.regions))}
              blocked={blocked.regions}
              onBlockedAdd={blocked.add}
              onBlockedRemove={blocked.remove}
              onCameraChange={setCamera}
              onPick={onPick}
              liftNeeds={liftNeeds}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              {images.length ? 'Loading…' : 'Add an image to start.'}
            </div>
          )}
        </div>
      </div>

      <div className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface">
        {camera && pointing && (
          <>
            <fieldset disabled={locked} className={locked ? 'opacity-60' : ''}>
            <Section title="Camera">
              {init && (
                <div className="text-text-muted">
                  {init.lens_model || init.camera_model || 'Unknown lens'}
                  {init.focal_mm ? ` · ${init.focal_mm} mm` : ''}
                  {init.fov_h_deg == null && <div className="text-warning">No focal length in EXIF — set the field of view by hand or let Auto-align find it.</div>}
                </div>
              )}
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Lens</span>
                <select value={camera.projection} onChange={(e) => changeProjection(e.target.value as S.Projection)} className="w-40 rounded border border-border bg-bg px-1 py-0.5 text-text">
                  {S.PROJECTIONS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>
              <NumField label="Field of view (width)" value={camera.fovH / DEG} digits={2} suffix="°" onCommit={(v) => setCamera(S.scaleFov(camera, (v * DEG) / camera.fovH))} />
              <NumField label="Centre RA" value={pointing.ra} digits={3} suffix="°" onCommit={(v) => setCamera(S.pointCamera(camera, ((v % 360) + 360) % 360, pointing.dec, pointing.roll))} />
              <NumField label="Centre Dec" value={pointing.dec} digits={3} suffix="°" onCommit={(v) => setCamera(S.pointCamera(camera, pointing.ra, Math.max(-89.9, Math.min(89.9, v)), pointing.roll))} />
              <NumField label="Roll" value={pointing.roll} digits={2} suffix="°" onCommit={(v) => setCamera(S.pointCamera(camera, pointing.ra, pointing.dec, v))} />
              <label className="flex items-center justify-between gap-2" title="Radial lens distortion (Brown–Conrady k1). Leave at 0 unless stars near the frame edges drift off.">
                <span className="text-text-muted">Distortion k1</span>
                <input type="range" min={-0.3} max={0.3} step={0.005} value={camera.k1} onChange={(e) => setCamera({ ...camera, k1: Number(e.target.value) })} className="w-24" />
                <span className="w-10 text-right text-text-muted">{camera.k1.toFixed(3)}</span>
              </label>
              {centreAltAz && (
                <div className="text-text-muted">Centre is at altitude {centreAltAz.alt.toFixed(1)}°, azimuth {centreAltAz.az.toFixed(1)}°</div>
              )}
            </Section>

            <Section title="Observer">
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Latitude</span>
                <input value={observer.lat} onChange={(e) => setObserver({ ...observer, lat: e.target.value })} placeholder="e.g. 45.4" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Longitude</span>
                <input value={observer.lon} onChange={(e) => setObserver({ ...observer, lon: e.target.value })} placeholder="e.g. -75.7" className="w-28 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">UTC time</span>
                <input value={observer.utc} onChange={(e) => setObserver({ ...observer, utc: e.target.value })} placeholder="YYYY-MM-DD HH:mm:ss" className="w-40 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
              </label>
              {init?.observer.time_source && observer.utc === fmtUtc(init.observer.utc ?? '') && (
                <div className="text-text-muted">
                  Time {TIME_SOURCE_NOTE[init.observer.time_source] ?? init.observer.time_source}
                  {init.observer.exposure_s ? `, mid-exposure of ${init.observer.exposure_s}s` : ''}.
                </div>
              )}
              {init?.observer.local && (
                <div className="space-y-1 rounded border border-border p-2">
                  <div className="text-text-muted">
                    Photo taken <span className="text-text">{fmtUtc(init.observer.local)}</span> (camera clock, read from EXIF)
                    {init.observer.time_source ? '' : ' — no timezone stored, so enter it to get UTC.'}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-text-muted">
                      UTC offset (h)
                      <input value={tzHours} onChange={(e) => setTzHours(e.target.value)} className="w-14 rounded border border-border bg-bg px-1 py-0.5 text-right text-text" />
                    </label>
                    <button onClick={applyLocalTime} className={btn}>Use photo time</button>
                  </div>
                </div>
              )}
              {liftNeeds.includes('location') && lastLocation && (
                <button onClick={() => setObserver((o) => ({ ...o, lat: lastLocation.lat, lon: lastLocation.lon }))} className={btn}>
                  Use last location ({lastLocation.lat}, {lastLocation.lon})
                </button>
              )}
              {!observerObj && (
                <div className="text-text-muted">
                  Location and time are optional for aligning, but they draw the horizon, enable alt/az aiming, and are needed to zoom out of the photo into space
                  {liftNeeds.length ? ` (missing: ${liftNeeds.join(' and ')})` : ''}.
                </div>
              )}
              <div className="border-t border-border pt-2">
                <div className="mb-1 text-text-muted">Point by alt/az (compass bearing)</div>
                <div className="flex items-center gap-1">
                  {(['alt', 'az', 'tilt'] as const).map((k) => (
                    <label key={k} className="flex flex-1 flex-col gap-0.5 text-text-muted">
                      {k === 'alt' ? 'Altitude' : k === 'az' ? 'Azimuth' : 'Tilt'}
                      <input value={aim[k]} onChange={(e) => setAim({ ...aim, [k]: e.target.value })} className="w-full rounded border border-border bg-bg px-1 py-0.5 text-text" />
                    </label>
                  ))}
                </div>
                <button onClick={applyAim} disabled={!observerObj} className={`${btn} mt-1 w-full`}>Aim camera</button>
              </div>
            </Section>

            </fieldset>

            <Section title="Layers">
              {(
                [
                  ['stars', 'Stars'],
                  ['constellations', 'Constellation lines'],
                  ['art', 'Constellation artwork'],
                  ['asterisms', 'Asterisms'],
                  ['planets', 'Sun, Moon & planets'],
                  ['nebulae', 'Nebulae'],
                  ['galaxies', 'Galaxies'],
                  ['clusters', 'Star clusters'],
                  ['labels', 'Labels'],
                  ['horizon', 'Horizon']
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayer(k, e.target.checked)} />
                  {label}
                </label>
              ))}
              {layers.art && (
                <label className="flex items-center justify-between gap-2">
                  <span className="text-text-muted">Artwork opacity</span>
                  <input type="range" min={0.1} max={1} step={0.05} value={layers.artOpacity} onChange={(e) => setLayer('artOpacity', Number(e.target.value))} className="w-32" />
                </label>
              )}
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Opacity</span>
                <input type="range" min={0.2} max={1} step={0.05} value={layers.opacity} onChange={(e) => setLayer('opacity', Number(e.target.value))} className="w-32" />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-text-muted">Star density</span>
                <input type="range" min={-2} max={2} step={0.25} value={layers.magOffset} onChange={(e) => setLayer('magOffset', Number(e.target.value))} className="w-32" />
              </label>
            </Section>

            <fieldset disabled={locked} className={locked ? 'opacity-60' : ''}>
            <Section title={`Picked stars (${pairs.length})`}>
              <div className="text-text-muted">
                {pairs.length === 0
                  ? 'Switch to “Pick stars”, click a star in the photo, then choose its catalogue match. Two picks fix position and rotation; three or more also fit the field of view.'
                  : pairs.length < 2
                    ? 'One more pick needed.'
                    : ''}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {pairs.map((p, i) => (
                  <div key={i} className="flex items-center gap-1 rounded border border-border px-1.5 py-1">
                    <span className="w-4 font-semibold text-warning">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={p.label}>{p.label}</span>
                    <span className={`w-12 text-right ${(residuals[i] ?? 0) > 15 ? 'text-danger' : 'text-text-muted'}`}>{residuals[i] == null ? '—' : `${residuals[i]!.toFixed(1)}px`}</span>
                    <button onClick={() => setPairs(pairs.filter((_, j) => j !== i))} className="text-text-muted hover:text-danger" title="Remove">✕</button>
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2" title="With three or more picks, also solve for the field of view">
                <input type="checkbox" checked={fitFov} onChange={(e) => setFitFov(e.target.checked)} /> Fit field of view
              </label>
              <label className="flex items-center gap-2" title="Needs five or more picks spread across the frame">
                <input type="checkbox" checked={fitK1} onChange={(e) => setFitK1(e.target.checked)} /> Fit lens distortion
              </label>
              <div className="flex gap-2">
                <button onClick={solveManual} disabled={pairs.length < 2 || busy !== null} className={`${btnPrimary} flex-1`}>Fit camera</button>
                <button onClick={() => setPairs([])} disabled={!pairs.length} className={btn}>Clear</button>
              </div>
            </Section>
            </fieldset>

            <Section title={`Blocked areas (${blocked.regions.length})`}>
              <div className="text-text-muted">
                Fence off string lights, trees or reflections in <span className="text-text">Block areas</span> mode. Stars inside are
                ignored by Auto-align and star picking, and the trained models drop detections centred in them. Shared with Annotate and
                Constellations.
              </div>
              {blocked.error && <div className="text-danger">{blocked.error}</div>}
              <div className="flex gap-2">
                <button onClick={() => setMode('block')} className={`${btn} flex-1`}>Draw a blocked area</button>
                <button
                  onClick={() => window.confirm(`Remove all ${blocked.regions.length} blocked areas on this image?`) && blocked.clear()}
                  disabled={!blocked.regions.length}
                  className={btn}
                >
                  Clear
                </button>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Starting camera from EXIF. EXIF gives the lens and time but not where it was
 * pointing, so aim at a sensible sky position (south, halfway up) if the
 * observer is known; the user or Auto-align takes it from there.
 */
function defaultCamera(init: SkyInit, obs: ObserverText): S.Camera {
  const fov = init.fov_h_deg ?? (init.projection === 'rectilinear' ? 60 : 180)
  const base = S.makeCamera(0, 0, 0, fov, init.projection, init.width, init.height)
  const lat = num(obs.lat)
  const lon = num(obs.lon)
  const date = parseUtc(obs.utc)
  if (lat === null || lon === null || !date) return base
  return S.cameraFromAltAz(base, 45, lat >= 0 ? 180 : 0, 0, { latDeg: lat, lonDeg: lon, date })
}
