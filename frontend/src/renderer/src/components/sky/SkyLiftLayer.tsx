// The merged zoom: zoom out of the photo and it cross-fades into the 3D sky seen from where the
// photo was taken, the horizon and the Earth beneath; keep zooming out and the camera rises off the
// ground, tilts to look down at the curving Earth, and carries on to the Moon, planets, stars and
// galaxy. This layer owns the 3D engine and follows the photo view while you are still on the
// ground; SkyOverlayCanvas owns the wheel and the photo zoom.

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import * as S from '@renderer/lib/skyMath'
import type { SkyView } from '@renderer/lib/skyCatalogue'
import { GALACTIC_NORTH_ECLIPTIC } from '@renderer/lib/galaxyMath'
import { ORBIT_ALTITUDE_M, MIN_ALTITUDE_M, liftFade, matchView, zenithEcliptic, type LiftView } from '@renderer/lib/skyLift'
import { useTheme } from '@renderer/theme/ThemeContext'
import { DEFAULT_LAYERS, SolarSystemEngine, type BodyInfo } from '@renderer/components/deepspace/solarSystemEngine'
import { ScaleRuler, type ScaleStop } from '@renderer/components/deepspace/ScaleRuler'
import { loadUniverse } from '@renderer/components/deepspace/universeLoader'

export type LiftStage = 'ground' | 'orbit' | 'descending'

interface Props {
  camera: S.Camera
  view: SkyView | null
  observer: S.Observer | null
  xf: { k: number; ox: number; oy: number }
  size: { w: number; h: number }
  fitK: number
  /** metres above the ground; 0 = standing on it. Owned by the canvas, which turns the wheel into it */
  altM: number
  onAltitude: (m: number) => void
  /** bring the photo back to fitting the window (animated) */
  onReturn: () => void
  onStage: (s: LiftStage) => void
}

const EARTH_RADIUS_AU = 6371 / 149_597_870.7
const ORBIT_AU = ORBIT_ALTITUDE_M / 1.495978707e11
/** Zooming in to within this of the handover altitude brings you back down to the photo. */
const DESCEND_BELOW_AU = EARTH_RADIUS_AU + ORBIT_AU * 0.8
const DESCEND_MS = 2800
const RED_NIGHT_FILTER = 'grayscale(1) sepia(1) hue-rotate(-50deg) saturate(6) brightness(0.85)'

const STOPS: ScaleStop[] = [
  { label: 'Earth', au: EARTH_RADIUS_AU + ORBIT_AU * 3, focus: 'earth', title: 'The Earth from orbit' },
  { label: 'Inner', au: 4, focus: 'sun', title: 'The Sun and Mercury to Mars' },
  { label: 'Outer', au: 45, focus: 'sun', title: 'Out to Neptune and Pluto' },
  { label: 'Stars', au: 2e6, focus: 'sun', title: 'The Sun and the stars around it, in 3D' },
  { label: 'Galaxy', au: 1.1e10, focus: 'milkyway', direction: [...GALACTIC_NORTH_ECLIPTIC], title: 'The Milky Way from above' },
  { label: 'Local Group', au: 6e11, focus: 'milkyway', direction: [0.35, -1, 0.7], title: 'The Milky Way, Andromeda and their neighbours' }
]

const fmtAltitude = (m: number): string => (m < 1000 ? `${Math.round(m)} m` : m < 1e6 ? `${(m / 1000).toFixed(m < 1e4 ? 1 : 0)} km` : `${Math.round(m / 1000).toLocaleString()} km`)

export function SkyLiftLayer({ camera, view, observer, xf, size, fitK, altM, onAltitude, onReturn, onStage }: Props): ReactElement | null {
  const { theme } = useTheme()
  const navigate = useNavigate()
  const mount = useRef<HTMLDivElement>(null)
  const engine = useRef<SolarSystemEngine | null>(null)
  const [stage, setStageState] = useState<LiftStage>('ground')
  const [distAU, setDistAU] = useState(EARTH_RADIUS_AU + ORBIT_AU)
  const [selected, setSelected] = useState<string | null>(null)
  const [info, setInfo] = useState<BodyInfo | null>(null)
  const [credits, setCredits] = useState<string[]>([])
  const [glError, setGlError] = useState<string | null>(null)

  const t = altM > 0 || stage !== 'ground' ? 1 : liftFade(xf.k, fitK)
  const usable = !!observer && !!view
  const active = usable && (t > 0 || stage !== 'ground')

  // Everything the engine callbacks need, kept current without recreating the engine.
  const live = useRef({ stage, altM, view: null as LiftView | null, zenith: [0, 0, 1] as [number, number, number], onAltitude, onReturn })
  live.current.stage = stage
  live.current.altM = altM
  live.current.onAltitude = onAltitude
  live.current.onReturn = onReturn

  const setStage = (s: LiftStage): void => {
    live.current.stage = s
    setStageState(s)
    onStage(s)
  }

  // The photo's view and the observer's zenith, in the 3D scene's frame.
  const lv = usable ? matchView(camera, view.matrix, xf, size) : null
  const zenith = usable ? zenithEcliptic(view.matrix, observer) : null
  live.current.view = lv
  if (zenith) live.current.zenith = zenith

  // ---------- the engine, created the first time it is needed ----------
  useEffect(() => {
    if (!active || engine.current || !mount.current) return
    let eng: SolarSystemEngine
    try {
      eng = new SolarSystemEngine(mount.current, {
        onSelect: setSelected,
        onView: (v) => {
          setDistAU(v.distanceAU)
          if (live.current.stage === 'orbit' && v.focusId === 'earth' && v.distanceAU < DESCEND_BELOW_AU) descend()
        },
        onArrive: (id) => {
          if (id !== 'earth' || live.current.stage !== 'descending' || !live.current.view) return
          // Arrived above the observer: stand back on the ground, then sink to it. Start just under the
          // hand-over altitude, or the ground stage would see itself past it and go straight back up.
          const start = ORBIT_ALTITUDE_M * 0.98
          live.current.onAltitude(start)
          live.current.altM = start
          engine.current?.enterSurface({ zenith: live.current.zenith, view: live.current.view, altitudeM: start })
          setStage('ground')
          animateAltitude(start, 0, DESCEND_MS, () => live.current.onReturn())
        }
      })
    } catch (e) {
      setGlError(e instanceof Error ? e.message : 'WebGL is not available') // the photo view still works, it just can't lift off
      return
    }
    engine.current = eng
    loadUniverse(eng, {
      live: () => engine.current === eng,
      onCredit: (c) => setCredits((cs) => (c && !cs.includes(c) ? [...cs, c] : cs)),
      onMissing: () => undefined,
      onLoaded: () => undefined
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(
    () => () => {
      engine.current?.dispose()
      engine.current = null
    },
    []
  )

  // ---------- follow the photo while on the ground ----------
  const dateMs = observer?.date.getTime()
  useEffect(() => {
    if (dateMs !== undefined) engine.current?.setDate(dateMs)
  }, [dateMs, active])

  useEffect(() => {
    const eng = engine.current
    if (!eng) return
    // From the ground, orbits and belts are lines seen edge-on across the whole sky: only show them from space.
    const space = stage === 'orbit'
    eng.setLayers({ ...DEFAULT_LAYERS, hosts: false, labels: space, orbits: space, belts: space, minor: space })
  }, [stage, active])

  useEffect(() => {
    const eng = engine.current
    if (!eng || !lv || !zenith) return
    if (stage !== 'ground') return
    if (!active) {
      if (eng.isSurface()) eng.leaveSurface() // idle: no drawing while the photo is all you see
      return
    }
    if (altM >= ORBIT_ALTITUDE_M) {
      eng.enterSurface({ zenith, view: lv, altitudeM: ORBIT_ALTITUDE_M })
      eng.leaveSurface()
      setStage('orbit')
      return
    }
    eng.enterSurface({ zenith, view: lv, altitudeM: altM })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, view, observer, xf.k, xf.ox, xf.oy, size.w, size.h, altM, stage, active])

  // ---------- coming back down ----------
  const anim = useRef(0)
  function animateAltitude(from: number, to: number, ms: number, done: () => void): void {
    cancelAnimationFrame(anim.current)
    const start = performance.now()
    const lo = Math.max(MIN_ALTITUDE_M, Math.min(from, to || MIN_ALTITUDE_M))
    const step = (now: number): void => {
      const u = Math.min(1, (now - start) / ms)
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
      // log-space, so the last few hundred metres take as long as the first few hundred kilometres
      const alt = to === 0 ? Math.exp(Math.log(from) + (Math.log(lo) - Math.log(from)) * e) : from + (to - from) * e
      live.current.onAltitude(u >= 1 && to === 0 ? 0 : alt)
      if (u < 1) anim.current = requestAnimationFrame(step)
      else done()
    }
    anim.current = requestAnimationFrame(step)
  }

  function descend(): void {
    const eng = engine.current
    if (!eng || live.current.stage !== 'orbit') return
    setStage('descending')
    eng.focusOn('earth', { distance: EARTH_RADIUS_AU + ORBIT_AU, direction: live.current.zenith })
  }

  const back = (): void => {
    if (stage === 'orbit') return descend()
    if (stage === 'descending') return
    if (altM > 0) return animateAltitude(altM, 0, Math.min(DESCEND_MS, 900 + 300 * Math.log10(Math.max(altM, 10))), () => live.current.onReturn())
    live.current.onReturn()
  }

  useEffect(() => () => cancelAnimationFrame(anim.current), [])

  useEffect(() => setInfo(selected ? (engine.current?.describe(selected) ?? null) : null), [selected])

  if (!usable) return null

  const opacity = active ? t : 0
  const orbit = stage === 'orbit'

  return (
    <>
      <div
        className="absolute inset-0"
        style={{ opacity, pointerEvents: orbit ? 'auto' : 'none', visibility: opacity > 0.003 ? 'visible' : 'hidden', filter: theme === 'red' ? RED_NIGHT_FILTER : undefined }}
      >
        <div ref={mount} className="absolute inset-0 select-none" />
      </div>

      {glError && opacity > 0 && (
        <div className="absolute left-1/2 top-12 z-10 max-w-md -translate-x-1/2 rounded-md border border-danger/50 bg-black/80 px-3 py-2 text-center text-xs text-white">
          The 3D view could not start ({glError}). Check that hardware acceleration is enabled.
        </div>
      )}

      {opacity > 0.25 && !glError && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-2">
          {stage === 'ground' && altM > 0 && <span className="rounded bg-black/60 px-2 py-1 text-xs tabular-nums text-white/85">Altitude {fmtAltitude(altM)}</span>}
          <button onClick={back} disabled={stage === 'descending'} className="rounded bg-black/65 px-3 py-1 text-xs text-white hover:bg-white/25 disabled:opacity-50">
            {stage === 'descending' ? 'Descending…' : '↩ Back to the photo'}
          </button>
        </div>
      )}

      {orbit && (
        <div className="absolute inset-x-2 bottom-2 z-10">
          <ScaleRuler
            distanceAU={distAU}
            stops={STOPS}
            onStop={(s) => engine.current?.focusOn(s.focus ?? 'earth', { distance: s.au, direction: s.direction })}
            onDistance={(au) => engine.current?.focusOn(engine.current.getFocus(), { distance: au })}
          />
          <div className="mt-1 text-center text-[10px] text-white/60" title={credits.join(' · ')}>
            Zoom in to the Earth to come back down · click a body to fly to it
          </div>
        </div>
      )}

      {orbit && info && (
        <div className="absolute left-2 top-2 z-10 w-64 rounded-md border border-border bg-surface/95 p-3 text-xs shadow-xl">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-semibold text-text">{info.name}</div>
            <button onClick={() => setSelected(null)} className="text-base leading-none text-text-muted hover:text-text">
              ×
            </button>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {info.facts.slice(0, 5).map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-text-muted">{f.label}</dt>
                <dd className="text-right text-text">{f.value}</dd>
              </div>
            ))}
          </dl>
          <button
            onClick={() => navigate(`/deep-space?view=solar&focus=${encodeURIComponent(info.id)}${observer ? `&t=${encodeURIComponent(observer.date.toISOString())}` : ''}`)}
            className="mt-3 w-full rounded-md border border-border px-2 py-1 text-text hover:border-accent"
          >
            Open in Deep Space
          </button>
        </div>
      )}
    </>
  )
}
