import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { live, type FrameHeader, type LiveCamera, type StretchSpec } from '@renderer/lib/liveApi'
import { FeedCanvas, type FeedHandle, type Overlays } from './FeedCanvas'
import { ControlsPanel } from './ControlsPanel'
import { HistogramPanel } from './HistogramPanel'
import { FocusPanel, type FocusSample } from './FocusPanel'
import { GuidesPanel } from './GuidesPanel'
import { CapturePanel } from './CapturePanel'
import { MonitorPanel } from './MonitorPanel'
import { SkyPanel } from './SkyPanel'
import { useLiveSky } from './useLiveSky'
import { btn, btnActive, STATE_LABEL, stateDot } from './ui'

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
}

export function SingleView({ camera, red, overlays, onOverlays, onBack, onToggleRed, onChanged }: Props): ReactElement {
  const st = camera.status
  const running = st?.state === 'running'
  const [tab, setTab] = useState<Tab>('controls')
  const [stretch, setStretch] = useState<StretchSpec>({ mode: st?.astro ? 'auto' : 'off', black: 0, white: 1, mid: 0.5 })
  const touched = useRef(false)
  const [fullRes, setFullRes] = useState(false)
  const [header, setHeader] = useState<FrameHeader | null>(null)
  const [history, setHistory] = useState<FocusSample[]>([])
  const [point, setPoint] = useState<{ fx: number; fy: number } | null>(null)
  const [bahtinov, setBahtinov] = useState(false)
  const [tick, setTick] = useState(0)
  const feed = useRef<FeedHandle>(null)
  const feedBox = useRef<HTMLDivElement>(null)
  const sky = useLiveSky(camera.id, header?.sw ?? null, header?.sh ?? null)
  const lastRender = useRef(0)
  const lastFocus = useRef(0)

  // Astro cameras default to the auto-stretch, everything else to the picture as delivered,
  // until the user chooses.
  useEffect(() => {
    if (!touched.current && st) setStretch((s) => ({ ...s, mode: st.astro ? 'auto' : 'off' }))
  }, [st?.astro]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHistory([])
    setHeader(null)
    setPoint(null)
    touched.current = false
  }, [camera.id])

  const onStretch = (s: StretchSpec): void => {
    touched.current = true
    setStretch(s)
  }

  const sub = useMemo(
    () => ({ width: fullRes ? null : 1920, fps: 15, stretch, hist: tab === 'histogram', focus: tab === 'focus' }),
    [fullRes, stretch, tab]
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

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-3 py-2 text-xs">
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
            className="h-full w-full"
          />
          </div>
          {sky.settings.on && (
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white/85">
              {!sky.aligned ? '★ Star overlay · not aligned yet' : sky.settings.locked ? '★ Star overlay · 🔒 locked' : '★ Star overlay · aligned'}
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

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-text-muted">
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

      <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex flex-wrap gap-1 border-b border-border p-2">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? btnActive : btn} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
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
    </div>
  )
}
