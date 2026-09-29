import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { live, type FrameHeader, type LiveCamera, type StretchSpec } from '@renderer/lib/liveApi'
import { FeedCanvas, type FeedHandle, type Overlays } from './FeedCanvas'
import { ControlsPanel } from './ControlsPanel'
import { HistogramPanel } from './HistogramPanel'
import { FocusPanel, type FocusSample } from './FocusPanel'
import { GuidesPanel } from './GuidesPanel'
import { CapturePanel } from './CapturePanel'
import { MonitorPanel } from './MonitorPanel'
import { SkyPanel } from './SkyPanel'
import { SatelliteCard } from '@renderer/components/sky/SatelliteCard'
import { useLiveSky } from './useLiveSky'
import { btn, btnActive, STATE_LABEL, stateDot } from './ui'
import { usePersisted } from './persist'

type Tab = 'controls' | 'histogram' | 'focus' | 'guides' | 'sky' | 'capture' | 'monitor'

const TABS: { id: Tab; label: string }[] = [
  { id: 'controls', label: 'Controls' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'focus', label: 'Focus' },
  { id: 'guides', label: 'Guides' },
  { id: 'sky', label: 'Sky' },
  { id: 'capture', label: 'Capture' },
  { id: 'monitor', label: 'Monitor' }
]

const HISTORY = 90

interface Props {
  camera: LiveCamera
  red: boolean
  overlays: Overlays
  onOverlays: (o: Overlays) => void
  onBack: () => void
  onToggleRed: () => void
  onChanged: () => void
  /** the tools panel (right) is folded to a thin strip */
  toolsCollapsed: boolean
  onToggleTools: () => void
  /** the camera fills the whole window; the bars fade away until the mouse moves */
  fullscreen: boolean
  onToggleFullscreen: () => void
}

/** What is remembered for each camera between visits and between launches: the tab, the stretch, full resolution, the focus point. */
interface Prefs {
  tab: Tab
  /** null: the camera's own default (auto for astro cameras, none otherwise) until the user chooses */
  stretch: StretchSpec | null
  fullRes: boolean
  bahtinov: boolean
  point: { fx: number; fy: number } | null
}

const DEFAULT_PREFS: Prefs = { tab: 'controls', stretch: null, fullRes: false, bahtinov: false, point: null }
const mergePrefs = (saved: unknown): Prefs => {
  const s = (saved ?? {}) as Partial<Prefs>
  return {
    tab: TABS.some((t) => t.id === s.tab) ? (s.tab as Tab) : DEFAULT_PREFS.tab,
    stretch: s.stretch && typeof s.stretch === 'object' ? s.stretch : null,
    fullRes: s.fullRes === true,
    bahtinov: s.bahtinov === true,
    point: s.point && typeof s.point.fx === 'number' && typeof s.point.fy === 'number' ? s.point : null
  }
}

const BAR_IDLE_MS = 2500

export function SingleView({ camera, red, overlays, onOverlays, onBack, onToggleRed, onChanged, toolsCollapsed, onToggleTools, fullscreen, onToggleFullscreen }: Props): ReactElement {
  const st = camera.status
  const running = st?.state === 'running'
  const [prefs, setPrefs] = usePersisted<Prefs>(`live-view:cam:${camera.id}`, DEFAULT_PREFS, mergePrefs)
  const { tab, fullRes, bahtinov, point } = prefs
  const setTab = (t: Tab): void => setPrefs((p) => ({ ...p, tab: t }))
  const setFullRes = (v: boolean): void => setPrefs((p) => ({ ...p, fullRes: v }))
  const setBahtinov = (v: boolean): void => setPrefs((p) => ({ ...p, bahtinov: v }))
  const setPoint = (v: { fx: number; fy: number } | null): void => setPrefs((p) => ({ ...p, point: v }))
  // Astro cameras default to the auto-stretch, everything else to the picture as delivered, until the user chooses.
  const defaultStretch = useMemo<StretchSpec>(() => ({ mode: st?.astro ? 'auto' : 'off', black: 0, white: 1, mid: 0.5 }), [st?.astro])
  const stretch = prefs.stretch ?? defaultStretch
  const [header, setHeader] = useState<FrameHeader | null>(null)
  const [history, setHistory] = useState<FocusSample[]>([])
  const [tick, setTick] = useState(0)
  // fullscreen: the bars show while the mouse moves and fade after a moment
  const [barVisible, setBarVisible] = useState(true)
  const barTimer = useRef(0)
  const overBar = useRef(false)
  const wake = useCallback((): void => {
    setBarVisible(true)
    window.clearTimeout(barTimer.current)
    barTimer.current = window.setTimeout(() => !overBar.current && setBarVisible(false), BAR_IDLE_MS)
  }, [])
  useEffect(() => {
    if (fullscreen) wake()
    else window.clearTimeout(barTimer.current)
    return () => window.clearTimeout(barTimer.current)
  }, [fullscreen, wake])
  const barsShown = !fullscreen || barVisible
  const feed = useRef<FeedHandle>(null)
  const feedBox = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const sky = useLiveSky(camera.id, header?.sw ?? null, header?.sh ?? null)
  const lastRender = useRef(0)
  const lastFocus = useRef(0)

  const onStretch = (s: StretchSpec): void => setPrefs((p) => ({ ...p, stretch: s }))

  const sub = useMemo(
    () => ({ width: fullRes ? null : 1920, fps: 15, stretch, hist: !toolsCollapsed && tab === 'histogram', focus: !toolsCollapsed && tab === 'focus' }),
    [fullRes, stretch, tab, toolsCollapsed]
  )

  const onHeader = useCallback((h: FrameHeader) => {
    const now = performance.now()
    if (now - lastRender.current < 100) return
    lastRender.current = now
    setHeader(h)
    setTick((t) => t + 1)
    if (h.focus && now - lastFocus.current > 450) {
      lastFocus.current = now
      setHistory((hist) => [...hist.slice(-(HISTORY - 1)), { t: Date.now(), fwhm: h.focus!.fwhm, sharp: h.focus!.sharp }])
    }
  }, [])

  const getBitmap = useCallback(() => feed.current?.getBitmap() ?? null, [])

  const barFade = fullscreen ? `absolute inset-x-0 z-30 backdrop-blur transition-opacity duration-300 ${barVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}` : ''
  const barHover = fullscreen
    ? {
        onMouseEnter: (): void => {
          overBar.current = true
          wake()
        },
        onMouseLeave: (): void => {
          overBar.current = false
          wake()
        }
      }
    : {}

  return (
    <div className={`flex min-h-0 flex-1 ${fullscreen && !barsShown ? 'cursor-none' : ''}`} onMouseMove={fullscreen ? wake : undefined}>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className={`flex items-center gap-3 border-b border-border bg-surface px-3 py-2 text-xs ${fullscreen ? `${barFade} top-0 bg-surface/90` : ''}`} {...barHover}>
          <button className={btn} onClick={onBack}>
            ← Grid
          </button>
          <span className={`h-2 w-2 rounded-full ${stateDot(st?.state)}`} />
          <span className="truncate text-sm font-medium text-text">{camera.name}</span>
          <span className="text-text-muted">{STATE_LABEL[st?.state ?? 'stopped']}</span>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-text-muted" title="Send every pixel of the sensor. Sharper for focusing, but slower.">
            <input type="checkbox" checked={fullRes} onChange={(e) => setFullRes(e.target.checked)} />
            Full resolution
          </label>
          <button
            className={sky.settings.on ? btnActive : btn}
            onClick={() => {
              const next = !sky.settings.on
              sky.update({ on: next })
              if (next) setTab('sky')
            }}
            title="Draw the stars, constellations and planets over the picture, following the sky in real time"
          >
            ★ Star overlay
          </button>
          <button className={red ? btnActive : btn} onClick={onToggleRed} title="Show the picture in red only, to keep your night vision">
            Red filter
          </button>
          <button className={btn} onClick={() => feed.current?.resetView()} title="Scroll to zoom, drag to pan, double-click to reset">
            Reset zoom
          </button>
          <button className={btn} onClick={onToggleTools} title={toolsCollapsed ? 'Show the tools panel ( ] )' : 'Hide the tools panel ( ] )'}>
            {toolsCollapsed ? '◧ Tools' : '◨ Tools'}
          </button>
          <button className={fullscreen ? btnActive : btn} onClick={onToggleFullscreen} title={fullscreen ? 'Leave fullscreen (Esc or F11)' : 'Fill the whole screen with this camera (F11)'}>
            {fullscreen ? '⛶ Exit fullscreen' : '⛶ Fullscreen'}
          </button>
          {st?.state === 'stopped' || st?.state === 'error' || st?.state === 'unavailable' ? (
            <button className={btn} onClick={() => void live.start(camera.id)}>
              Start
            </button>
          ) : (
            <button className={btn} onClick={() => void live.stop(camera.id)}>
              Stop
            </button>
          )}
        </div>

        <div ref={feedBox} className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
          <FeedCanvas
            ref={feed}
            camId={camera.id}
            sub={sub}
            red={red}
            overlays={overlays}
            interactive
            onHeader={onHeader}
            onPick={tab === 'focus' ? (fx, fy) => setPoint({ fx, fy }) : undefined}
            marker={tab === 'focus' ? point : null}
            sky={sky.skyLayer}
            skyEdit={tab === 'sky' ? sky.skyEdit : null}
            viewKey={`live-view:view:${camera.id}`}
            className="h-full w-full"
          />
          </div>
          {sky.settings.on && (
            <div className={`pointer-events-none absolute left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/85 ${fullscreen ? 'top-14' : 'top-2'}`}>
              {!sky.aligned ? '★ Star overlay · not aligned yet' : sky.check.stale ? '★ Star overlay · hidden: no longer lines up' : sky.settings.locked ? '★ Star overlay · 🔒 locked' : '★ Star overlay · aligned'}
            </div>
          )}
          {sky.settings.on && sky.check.stale && (
            <div className="absolute inset-x-0 top-14 z-20 mx-auto w-fit max-w-md rounded-md border border-warning/60 bg-surface/95 p-3 text-xs shadow-xl">
              <div className="font-medium text-warning">The saved star alignment no longer lines up</div>
              <div className="mt-1 text-text-muted">
                Only {sky.check.result?.matched} of {sky.check.result?.tested} stars are where the overlay says they should be. The camera may have been moved or refocused, so the overlay is hidden.
              </div>
              <div className="mt-2 flex gap-2">
                <button className={btnActive} disabled={!running || sky.busy !== null} onClick={() => void sky.autoAlign()}>
                  {sky.busy === 'auto' ? 'Solving…' : 'Auto-align again'}
                </button>
                <button className={btn} onClick={sky.keepAnyway} title="Show the overlay from the stored alignment anyway">
                  Keep the old one
                </button>
              </div>
            </div>
          )}
          {sky.sat.card && (
            <div className="absolute right-2 top-2 z-10 max-h-[calc(100%-1rem)] overflow-y-auto rounded-md">
              <SatelliteCard sample={sky.sat.card.sample} site={sky.sat.card.site} date={sky.sat.card.date} onClose={sky.sat.close} onFollow={(n) => navigate(`/deep-space?view=solar&sat=${n}`)} />
            </div>
          )}
          {sky.candidates && (
            <div
              className="absolute z-10 min-w-[220px] rounded-md border border-border bg-surface p-1 text-xs shadow-xl"
              style={{
                left: Math.max(4, Math.min(sky.candidates.screen.x + 12, (feedBox.current?.clientWidth ?? 800) - 240)),
                top: Math.max(4, Math.min(sky.candidates.screen.y + 12, (feedBox.current?.clientHeight ?? 600) - 220))
              }}
            >
              <div className="px-2 py-1 font-semibold text-text-muted">{sky.candidates.list.length ? 'Which star is this?' : 'No catalogue stars near that point'}</div>
              {sky.candidates.list.map((c) => (
                <button key={c.index} onClick={() => sky.choose(c)} className="block w-full rounded px-2 py-1 text-left text-text hover:bg-accent/20">
                  {c.label}
                </button>
              ))}
              <button onClick={sky.dismissCandidates} className="block w-full rounded px-2 py-1 text-left text-text-muted hover:bg-accent/20">
                Cancel
              </button>
            </div>
          )}
          {!running && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-6 text-center">
              <span className="text-sm text-text">{STATE_LABEL[st?.state ?? 'connecting']}</span>
              {st?.error && <span className="max-w-md text-xs text-text-muted">{st.error}</span>}
            </div>
          )}
        </div>

        <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-text-muted ${fullscreen ? `${barFade} bottom-0 bg-surface/90` : ''}`} {...barHover}>
          {header && (
            <>
              <span>
                {header.sw}×{header.sh}
                {header.sw !== header.w ? ` (showing ${header.w}×${header.h})` : ''}
              </span>
              <span>{header.bits}-bit</span>
              <span>{header.fps} fps</span>
              {header.exp != null && <span>exposure {header.exp >= 1 ? `${header.exp.toFixed(1)} s` : `${Math.round(header.exp * 1000)} ms`}</span>}
              {header.temp != null && <span>sensor {header.temp.toFixed(1)} °C</span>}
            </>
          )}
          {st?.info?.model && <span className="ml-auto truncate">{st.info.model}</span>}
        </div>
      </div>

      {toolsCollapsed ? (
        <aside className="flex w-8 shrink-0 flex-col items-center border-l border-border bg-surface py-2">
          <button className="rounded px-1.5 py-1 text-sm leading-none text-text-muted hover:bg-accent/10 hover:text-text" onClick={onToggleTools} title="Show the tools panel ( ] )" aria-label="Show the tools panel">
            «
          </button>
          <span className="mt-3 text-[11px] uppercase tracking-widest text-text-muted [writing-mode:vertical-rl]">{TABS.find((t) => t.id === tab)?.label}</span>
        </aside>
      ) : (
      <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex items-start gap-1 border-b border-border p-2">
          <div className="flex flex-1 flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? btnActive : btn} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          </div>
          <button className="rounded px-1.5 py-1 text-sm leading-none text-text-muted hover:bg-accent/10 hover:text-text" onClick={onToggleTools} title="Hide the tools panel ( ] )" aria-label="Hide the tools panel">
            »
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'controls' && <ControlsPanel camId={camera.id} controls={st?.controls ?? []} />}
          {tab === 'histogram' && <HistogramPanel hist={header?.hist} bits={header?.bits} stretch={stretch} onStretch={onStretch} />}
          {tab === 'focus' && (
            <FocusPanel
              latest={header?.focus}
              history={history}
              onClear={() => setHistory([])}
              getBitmap={getBitmap}
              point={point}
              tick={tick}
              bahtinov={bahtinov}
              onBahtinov={setBahtinov}
            />
          )}
          {tab === 'guides' && <GuidesPanel overlays={overlays} onChange={onOverlays} />}
          {tab === 'sky' && <SkyPanel sky={sky} running={running} />}
          {tab === 'capture' && <CapturePanel camId={camera.id} status={st} stretch={stretch} />}
          {tab === 'monitor' && <MonitorPanel camera={camera} onChanged={onChanged} />}
        </div>
      </aside>
      )}
    </div>
  )
}
