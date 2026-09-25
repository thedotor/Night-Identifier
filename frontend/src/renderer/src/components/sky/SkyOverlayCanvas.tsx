import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import * as S from '@renderer/lib/skyMath'
import { onArtLoaded, starLabel, type Catalogue, type SkyView } from '@renderer/lib/skyCatalogue'
import type { Body } from '@renderer/lib/skyEphemeris'
import { regionAt, type Region } from '@renderer/lib/blockedAreas'
import { autoMagLimit, drawOverlay, nearbyStars, type Candidate, type Layers, type PairMark } from '@renderer/lib/skyRender'
import { pickObjects, type SkyObjectRef } from '@renderer/lib/skyPick'
import { ObjectInfoCard } from '@renderer/components/deepspace/ObjectInfoCard'
import { surveyMatrix } from '@renderer/lib/skySurvey'
import { MAX_GROUND_FOV_DEG, stepAltitude, zoomForFov } from '@renderer/lib/skyLift'
import { SkyLiftLayer, type LiftStage } from './SkyLiftLayer'
import { SURVEY_CREDIT, useSurveyFade } from './useSurveyFade'

export type SkyMode = 'move' | 'pick' | 'block'

export interface PickedStar {
  x: number
  y: number
  starIndex: number
  label: string
}

interface Props {
  imageUrl: string
  camera: S.Camera
  catalogue: Catalogue | null
  view: SkyView | null
  layers: Layers
  observer: S.Observer | null
  mode: SkyMode
  /** overlay is frozen: the mouse only pans/zooms the view of the photo */
  locked: boolean
  /** sky direction (camera frame) to ring, e.g. a search result */
  highlight: S.Vec3 | null
  /** Sun, Moon and planets for the current observation time */
  bodies: Body[]
  /** pan the photo view so this image point is centred; `n` changes to re-trigger */
  viewTarget: { x: number; y: number; n: number } | null
  pairs: PairMark[]
  /** stars found by the detector, drawn as small marks to click on */
  detected: [number, number][]
  /** areas fenced off from detection; the Block mode adds/removes them */
  blocked: Region[]
  onBlockedAdd: (r: Region) => void
  onBlockedRemove: (index: number) => void
  onCameraChange: (cam: S.Camera) => void
  onPick: (pick: PickedStar) => void
  /** what the zoom-out to space still needs for this photo ('location', 'time'); empty when it has both */
  liftNeeds?: string[]
}

interface ViewXform {
  k: number // screen px per image px
  ox: number
  oy: number
}

const PICK_RADIUS_SCREEN_PX = 36
const CLICK_RADIUS_SCREEN_PX = 14 // how close a click must be to an object to select it
const NEAR_CENTRE_FRACTION = 0.18 // "Explore" is offered for objects this close to the view centre
const DRAG_THRESHOLD_PX = 4
const HANDLE_RADIUS_SCREEN_PX = 12
const CARD_W = 288
const FADE_STORAGE_KEY = 'sky-imagery-fade'

function readFadePref(): boolean {
  try {
    return localStorage.getItem(FADE_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function SkyOverlayCanvas(props: Props): ReactElement {
  const { camera, catalogue, view, layers, observer, mode, pairs, detected, locked, highlight, viewTarget, bodies, blocked } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [xf, setXf] = useState<ViewXform>({ k: 1, ox: 0, oy: 0 })
  const [lasso, setLasso] = useState<Region | null>(null)
  const [artTick, setArtTick] = useState(0) // bumps when a constellation drawing finishes loading
  const lassoRef = useRef<Region>([])
  const [candidates, setCandidates] = useState<{ at: { x: number; y: number }; screen: { x: number; y: number }; list: Candidate[] } | null>(null)
  const [card, setCard] = useState<{ objects: SkyObjectRef[]; screen: { x: number; y: number } } | null>(null)
  const [near, setNear] = useState<SkyObjectRef[]>([])
  const [deepFade, setDeepFade] = useState(readFadePref)
  const [altM, setAltM] = useState(0) // metres above the ground, once zoomed out past the widest ground view
  const [liftStage, setLiftStage] = useState<LiftStage>('ground')

  // Latest props for the native event handlers below.
  const live = useRef({ ...props, xf, size, altM: 0, kFov: 0.02, can3D: false })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => onArtLoaded(() => setArtTick((n) => n + 1)), [])

  useEffect(() => {
    setImg(null)
    const i = new Image()
    // No crossOrigin: we only draw the photo, never read its pixels, and requesting CORS
    // would fail against the copy the thumbnail list already cached without CORS headers.
    i.onload = () => setImg(i)
    i.src = props.imageUrl
  }, [props.imageUrl])

  const fit = useCallback((): void => {
    const k = Math.min(size.w / camera.width, size.h / camera.height) * 0.98
    setXf({ k, ox: (size.w - camera.width * k) / 2, oy: (size.h - camera.height * k) / 2 })
  }, [size.w, size.h, camera.width, camera.height])

  useEffect(fit, [fit, props.imageUrl])
  useEffect(() => {
    setAltM(0) // a different photo starts on the ground
    setLiftStage('ground')
  }, [props.imageUrl])
  const fitK = Math.min(size.w / camera.width, size.h / camera.height) * 0.98 || 1

  const fade = useSurveyFade({ enabled: deepFade, camera, view, xf, size, fitK })

  // The zoom-out to the 3D sky needs the photo's place and time; without them it stays a photo.
  const can3D = !!observer && !!view
  const kFov = zoomForFov(camera, size.h, MAX_GROUND_FOV_DEG)
  live.current = { ...props, xf, size, altM, kFov, can3D }

  const toggleFade = (): void => {
    setDeepFade((v) => {
      try {
        localStorage.setItem(FADE_STORAGE_KEY, v ? 'off' : 'on')
      } catch {
        // preference just won't persist
      }
      return !v
    })
  }

  // Once the photo has faded into survey imagery, offer the objects sitting at the view centre.
  const fadedIn = fade.t >= 0.5
  useEffect(() => {
    if (!fadedIn || !catalogue || !view) {
      setNear([])
      return
    }
    const timer = setTimeout(() => {
      const cx = (size.w / 2 - xf.ox) / xf.k
      const cy = (size.h / 2 - xf.oy) / xf.k
      setNear(pickObjects(camera, catalogue, view, props.bodies, layers, cx, cy, (NEAR_CENTRE_FRACTION * Math.min(size.w, size.h)) / xf.k, 3))
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadedIn, camera, catalogue, view, layers, xf, size])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCard(null)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  // ---------- drawing ----------
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr * xf.k, 0, 0, dpr * xf.k, dpr * xf.ox, dpr * xf.oy)
    if (img) ctx.drawImage(img, 0, 0, camera.width, camera.height)
    else {
      ctx.fillStyle = '#05070d'
      ctx.fillRect(0, 0, camera.width, camera.height)
    }

    // Zoomed in far enough, the photo cross-fades into survey imagery registered to the same camera.
    if (fade.survey && fade.t > 0 && view) {
      const m = surveyMatrix(camera, view.matrix, {
        ra: fade.survey.ra,
        dec: fade.survey.dec,
        fovDeg: fade.survey.fovDeg,
        width: fade.survey.img.naturalWidth,
        height: fade.survey.img.naturalHeight
      })
      if (m) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, camera.width, camera.height)
        ctx.clip()
        ctx.globalAlpha = fade.t
        ctx.imageSmoothingQuality = 'high'
        ctx.transform(...m)
        ctx.drawImage(fade.survey.img, 0, 0)
        ctx.restore()
      }
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, camera.width, camera.height)
    ctx.clip()
    if (catalogue && view)
      drawOverlay({ ctx, cam: camera, cat: catalogue, view, layers, k: xf.k, observer, pairs, bodies })
    if (blocked.length || lasso) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.22)'
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 1.5 / xf.k
      ctx.setLineDash([6 / xf.k, 4 / xf.k])
      for (const region of [...blocked, ...(lasso ? [lasso] : [])]) {
        ctx.beginPath()
        region.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
      ctx.setLineDash([])
    }
    if (mode === 'pick') {
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)'
      ctx.lineWidth = 1 / xf.k
      ctx.beginPath()
      for (const [x, y] of detected) {
        ctx.moveTo(x + 4 / xf.k, y)
        ctx.arc(x, y, 4 / xf.k, 0, Math.PI * 2)
      }
      ctx.stroke()
    }
    ctx.restore()

    if (highlight) {
      const hp = S.project(camera, highlight)
      if (hp) {
        ctx.strokeStyle = '#fde047'
        ctx.lineWidth = 2.5 / xf.k
        for (const r of [16, 30]) {
          ctx.beginPath()
          ctx.arc(hp.x, hp.y, r / xf.k, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }

    // Roll handle: fixed on screen at the top of the frame, rotates the overlay about the centre.
    const hx = camera.width / 2
    const hy = camera.height * 0.08
    if (!locked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)'
    ctx.lineWidth = 1.5 / xf.k
    ctx.beginPath()
    ctx.arc(hx, hy, HANDLE_RADIUS_SCREEN_PX / xf.k, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.font = `${14 / xf.k}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('↻', hx, hy)
    ctx.textAlign = 'start'
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1 / xf.k
    ctx.strokeRect(0, 0, camera.width, camera.height)
  }, [img, size, xf, camera, catalogue, view, layers, observer, mode, pairs, detected, locked, highlight, bodies, blocked, lasso, artTick, fade.survey, fade.t])

  // ---------- pointer interaction ----------
  const toImage = (sx: number, sy: number): S.Pixel => ({
    x: (sx - live.current.xf.ox) / live.current.xf.k,
    y: (sy - live.current.xf.oy) / live.current.xf.k
  })

  const drag = useRef<
    | { kind: 'overlay' | 'roll' | 'view' | 'lasso'; last: S.Pixel; lastScreen: S.Pixel; startScreen: S.Pixel; moved: boolean }
    | null
  >(null)
  const spaceDown = useRef(false)

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement))
        spaceDown.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceDown.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const rect = (): DOMRect => canvasRef.current!.getBoundingClientRect()

  const onPointerDown = (e: React.PointerEvent): void => {
    const r = rect()
    const s = { x: e.clientX - r.left, y: e.clientY - r.top }
    const p = toImage(s.x, s.y)
    setCandidates(null)
    setCard(null)
    const { camera: cam, mode: m, xf: v } = live.current
    const handle = { x: cam.width / 2, y: cam.height * 0.08 }
    const onHandle = !live.current.locked && m !== 'block' && Math.hypot(p.x - handle.x, p.y - handle.y) * v.k <= HANDLE_RADIUS_SCREEN_PX + 4
    let kind: 'overlay' | 'roll' | 'view' | 'lasso'
    if (e.button === 1 || spaceDown.current) kind = 'view'
    else if (m === 'block') {
      if (e.button !== 0) return
      kind = 'lasso' // works while locked: blocking areas never moves the overlay
      lassoRef.current = [[p.x, p.y]]
      setLasso(lassoRef.current)
    } else if (live.current.locked || (m === 'pick' && !onHandle)) kind = 'view'
    else if (e.button !== 0) return
    else if (onHandle || e.shiftKey) kind = 'roll'
    else kind = 'overlay'
    drag.current = { kind, last: p, lastScreen: s, startScreen: s, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const r = rect()
    const s = { x: e.clientX - r.left, y: e.clientY - r.top }
    if (Math.hypot(s.x - d.startScreen.x, s.y - d.startScreen.y) > DRAG_THRESHOLD_PX) d.moved = true
    if (!d.moved) return
    const { camera: cam, xf: v } = live.current
    const p = toImage(s.x, s.y)
    if (d.kind === 'lasso') {
      // Keep a point only once the pointer has moved a few screen pixels.
      if (Math.hypot(s.x - d.lastScreen.x, s.y - d.lastScreen.y) >= 4) {
        lassoRef.current = [...lassoRef.current, [p.x, p.y]]
        setLasso(lassoRef.current)
        d.lastScreen = s
      }
      d.last = p
      return
    }
    if (d.kind === 'view') {
      setXf({ ...v, ox: v.ox + s.x - d.lastScreen.x, oy: v.oy + s.y - d.lastScreen.y })
    } else if (d.kind === 'overlay') {
      props.onCameraChange(S.panCamera(cam, d.last, p))
    } else {
      // Roll about the image centre, with the overlay following the pointer.
      const cx = cam.width / 2
      const cy = cam.height / 2
      let da = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(d.last.y - cy, d.last.x - cx)
      da = Math.atan2(Math.sin(da), Math.cos(da))
      props.onCameraChange(S.rollCamera(cam, (-da * 180) / Math.PI))
    }
    d.last = p
    d.lastScreen = s
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'lasso') {
      const pts = lassoRef.current
      lassoRef.current = []
      setLasso(null)
      if (d.moved && pts.length >= 3) props.onBlockedAdd(pts)
      else if (!d.moved) {
        // A click, not a stroke: remove the blocked area under it.
        const hit = regionAt(d.last.x, d.last.y, live.current.blocked)
        if (hit >= 0) props.onBlockedRemove(hit)
      }
      return
    }
    if (d && !d.moved && e.button === 0 && !spaceDown.current && d.kind !== 'roll' && (live.current.mode === 'move' || (live.current.mode === 'pick' && live.current.locked))) {
      // A plain click on the sky: open the details card for whatever is under it.
      const { camera: cam, catalogue: cat, view: sky, xf: v, layers: lay, bodies: bs } = live.current
      if (cat && sky) {
        const list = pickObjects(cam, cat, sky, bs, lay, d.last.x, d.last.y, CLICK_RADIUS_SCREEN_PX / v.k)
        setCard(list.length ? { objects: list, screen: d.startScreen } : null)
      }
      return
    }
    if (!d || d.moved || d.kind !== 'view' || e.button !== 0 || live.current.mode !== 'pick' || live.current.locked) return
    // A click (not a drag) in pick mode: offer the catalogue stars near it.
    const { camera: cam, catalogue: cat, view: sky, xf: v, layers: lay } = live.current
    if (!cat || !sky) return
    const p = d.last
    const radius = PICK_RADIUS_SCREEN_PX / v.k
    const list = nearbyStars(cam, cat, sky, p.x, p.y, radius, autoMagLimit(cam.fovH / (Math.PI / 180), lay.magOffset) + 1.5)
    setCandidates({ at: p, screen: d.startScreen, list })
  }

  /** Zoom the view of the photo (not the overlay), keeping the point under (sx, sy) fixed. */
  const zoomAt = useCallback((sx: number, sy: number, factor: number): void => {
    setXf((v) => {
      const k = Math.min(60, Math.max(0.02, v.k * factor))
      const f = k / v.k
      return { k, ox: sx - (sx - v.ox) * f, oy: sy - (sy - v.oy) * f }
    })
  }, [])

  /** Zoom the photo; once it is as far out as the ground view goes, zooming out rises off the ground instead. */
  const zoomView = useCallback(
    (sx: number, sy: number, factor: number, deltaY: number): void => {
      const { xf: v, altM: a, kFov: kf, can3D: ok } = live.current
      if (ok && factor < 1 && (a > 0 || v.k * factor < kf)) {
        if (a === 0 && v.k > kf * 1.0001) return zoomAt(sx, sy, kf / v.k) // first to the widest ground view exactly
        setAltM(stepAltitude(a, Math.abs(deltaY)))
        return
      }
      if (ok && factor > 1 && a > 0) return setAltM(stepAltitude(a, -Math.abs(deltaY)))
      zoomAt(sx, sy, factor)
    },
    [zoomAt]
  )

  /** Ease the photo back to fitting the window (the 3D sky fades out as it grows). */
  const animateFit = useCallback((): void => {
    const { size: sz, camera: cam } = live.current
    const k1 = Math.min(sz.w / cam.width, sz.h / cam.height) * 0.98
    const target = { k: k1, ox: (sz.w - cam.width * k1) / 2, oy: (sz.h - cam.height * k1) / 2 }
    const from = live.current.xf
    const start = performance.now()
    const step = (now: number): void => {
      const u = Math.min(1, (now - start) / 1100)
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
      const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e)
      setXf({ k, ox: from.ox + (target.ox - from.ox) * e, oy: from.oy + (target.oy - from.oy) * e })
      if (u < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [])

  useEffect(() => {
    if (!viewTarget) return
    setXf((v) => ({ ...v, ox: size.w / 2 - viewTarget.x * v.k, oy: size.h / 2 - viewTarget.y * v.k }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewTarget?.n])

  const zoomCentre = (factor: number): void => zoomView(size.w / 2, size.h / 2, factor, 220)
  const actualSize = (): void => {
    // 1 photo pixel per screen pixel, around whatever is at the centre now.
    const cx = (size.w / 2 - xf.ox) / xf.k
    const cy = (size.h / 2 - xf.oy) / xf.k
    setXf({ k: 1, ox: size.w / 2 - cx, oy: size.h / 2 - cy })
  }

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { camera: cam, xf: v } = live.current
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      const factor = Math.exp(e.deltaY * 0.0012)
      if (e.ctrlKey || e.metaKey || live.current.locked || live.current.mode !== 'move') {
        zoomView(sx, sy, 1 / factor, e.deltaY)
        return
      }
      // Scale the overlay about the cursor: the sky point under it stays put.
      const p = { x: (sx - v.ox) / v.k, y: (sy - v.oy) / v.k }
      const under = S.unproject(cam, p.x, p.y)
      let next = S.scaleFov(cam, factor)
      const at = S.project(next, under)
      if (at) next = S.panCamera(next, at, p)
      live.current.onCameraChange(next)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomView])

  const choose = (c: Candidate): void => {
    if (!candidates || !catalogue) return
    props.onPick({ x: candidates.at.x, y: candidates.at.y, starIndex: c.index, label: starLabel(catalogue, c.index) })
    setCandidates(null)
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: mode === 'pick' ? 'crosshair' : 'grab', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <SkyLiftLayer
        key={props.imageUrl}
        camera={camera}
        view={view}
        observer={observer}
        xf={xf}
        size={size}
        fitK={fitK}
        altM={altM}
        onAltitude={setAltM}
        onReturn={animateFit}
        onStage={setLiftStage}
      />
      <div className="absolute left-2 top-2 flex items-center overflow-hidden rounded bg-black/60 text-xs text-white">
        <button onClick={() => zoomCentre(1 / 1.4)} title="Zoom out" className="px-2.5 py-1 text-base leading-none hover:bg-white/20">−</button>
        <span className="w-12 text-center tabular-nums text-white/80">{Math.round((xf.k / fitK) * 100)}%</span>
        <button onClick={() => zoomCentre(1.4)} title="Zoom in" className="px-2.5 py-1 text-base leading-none hover:bg-white/20">+</button>
        <button onClick={fit} title="Fit the whole photo in view" className="border-l border-white/20 px-2 py-1 hover:bg-white/20">Fit</button>
        <button onClick={actualSize} title="1 photo pixel = 1 screen pixel" className="border-l border-white/20 px-2 py-1 hover:bg-white/20">1:1</button>
        <button
          onClick={toggleFade}
          title="Zoom in far enough and the photo fades into real sky-survey imagery of the same patch of sky"
          className="border-l border-white/20 px-2 py-1 hover:bg-white/20"
        >
          {deepFade ? '◉' : '○'} Sky imagery
        </button>
      </div>
      {near.length > 0 && !card && (
        <div className="absolute left-1/2 top-2 flex -translate-x-1/2 gap-1">
          {near.map((o) => (
            <button
              key={`${o.kind}-${o.key}`}
              onClick={() => setCard({ objects: [o, ...near.filter((n) => n !== o)], screen: { x: size.w / 2, y: size.h / 2 } })}
              className="rounded bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-white/25"
            >
              Explore {o.label} →
            </button>
          ))}
        </div>
      )}
      {!can3D && xf.k < fitK * 0.8 && (
        <div className="absolute left-1/2 top-12 z-10 max-w-md -translate-x-1/2 rounded-md border border-warning/50 bg-black/80 px-3 py-2 text-center text-xs text-white">
          Zooming out into space needs this photo&apos;s {(props.liftNeeds?.length ? props.liftNeeds : ['location', 'time']).join(' and ')}, which the file does not contain.
          Enter {(props.liftNeeds?.length ? props.liftNeeds : ['location', 'time']).length > 1 ? 'them' : 'it'} in the Observer panel on the right.
        </div>
      )}
      {fade.t > 0.05 && (
        <div className="pointer-events-none absolute bottom-2 right-2 max-w-[45%] rounded bg-black/60 px-2 py-1 text-right text-[10px] text-white/80">
          {fade.status === 'error'
            ? 'Sky imagery unavailable (no connection?)'
            : fade.status === 'loading' && !fade.survey
              ? 'Loading sky imagery…'
              : fade.t > 0.3
                ? SURVEY_CREDIT
                : ''}
        </div>
      )}
      {card && (
        <ObjectInfoCard
          objects={card.objects}
          utc={observer?.date.toISOString()}
          onClose={() => setCard(null)}
          style={{
            left: Math.max(4, Math.min(card.screen.x + 12, size.w - CARD_W - 8)),
            top: Math.max(4, Math.min(card.screen.y + 12, size.h - 420)),
            maxHeight: size.h - 8,
            overflowY: 'auto'
          }}
        />
      )}
      {locked && (
        <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-warning">🔒 Overlay locked</div>
      )}
      <div className={`pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/80 ${liftStage === 'orbit' ? 'hidden' : ''}`}>
        {locked
          ? 'Overlay locked · Wheel or +/−: zoom photo · Drag: pan photo'
          : mode === 'block'
            ? 'Drag around lights, trees or anything to ignore · click a red area to remove it · wheel zooms the photo'
            : mode === 'move'
          ? 'Drag: move sky · Wheel: scale · Shift+drag or ↻: rotate · Ctrl+wheel / Space+drag: zoom / pan photo (zoom right out to leave the Earth) · Click an object for details'
          : 'Click a star in the photo, then choose which catalogue star it is · wheel zooms, drag pans the photo'}
      </div>
      {candidates && (
        <div
          className="absolute z-10 min-w-[220px] rounded-md border border-border bg-surface p-1 text-xs shadow-xl"
          style={{ left: Math.min(candidates.screen.x + 12, size.w - 240), top: Math.min(candidates.screen.y + 12, size.h - 220) }}
        >
          <div className="px-2 py-1 font-semibold text-text-muted">
            {candidates.list.length ? 'Which star is this?' : 'No catalogue stars near that point'}
          </div>
          {candidates.list.map((c) => (
            <button
              key={c.index}
              onClick={() => choose(c)}
              className="block w-full rounded px-2 py-1 text-left text-text hover:bg-accent/20"
            >
              {catalogue && starLabel(catalogue, c.index)} <span className="text-text-muted">· {(c.dist * live.current.xf.k).toFixed(0)} px away</span>
            </button>
          ))}
          <button onClick={() => setCandidates(null)} className="block w-full rounded px-2 py-1 text-left text-text-muted hover:bg-accent/20">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
