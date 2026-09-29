import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { AddWidgetTray, DashboardGrid } from '@renderer/components/dashboard/DashboardGrid'
import { PlaceBar } from '@renderer/components/dashboard/SkyCards'
import { useDashboardLayout } from '@renderer/components/dashboard/useDashboardLayout'
import { useDashData } from '@renderer/components/dashboard/useDashData'
import { usePlace } from '@renderer/components/dashboard/usePlace'
import { MONITOR_LAYOUT } from '@renderer/components/dashboard/widgets'

const btn = 'rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text'
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * The second-monitor window: a dashboard of live monitoring cards with a layout of its own (the globe, the ISS, lightning, weather, aurora,
 * space weather, the Sun). It opens from the Dashboard or Settings and remembers which screen it was on.
 */
export function Monitor(): ReactElement {
  const { place, raw, save } = usePlace()
  const data = useDashData(place)
  const layout = useDashboardLayout({ key: 'night-identifier:monitor-layout', defaults: MONITOR_LAYOUT })
  const [editing, setEditing] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [now, setNow] = useState(() => new Date())
  /** true while the window is fullscreen only because a card asked for it (so it goes back when the card does) */
  const cardMadeFullscreen = useRef(false)
  const onCardFullscreen = (on: boolean): void => {
    window.api.monitor
      .state()
      .then((st) => {
        if (on && !st.fullscreen) {
          cardMadeFullscreen.current = true
          return window.api.monitor.toggleFullscreen().then(setFullscreen)
        }
        if (!on && cardMadeFullscreen.current && st.fullscreen) {
          cardMadeFullscreen.current = false
          return window.api.monitor.toggleFullscreen().then(setFullscreen)
        }
        if (!on) cardMadeFullscreen.current = false
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    window.api.monitor.state().then((s) => setFullscreen(s.fullscreen)).catch(() => undefined)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F11') return
      e.preventDefault()
      void window.api.monitor.toggleFullscreen().then(setFullscreen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3 pr-40 text-xs text-text-muted" style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
        <span className="font-medium text-text">Night Identifier · Monitor</span>
        <span className="tabular-nums">
          {now.toLocaleTimeString()} · {now.toISOString().slice(11, 19)} UTC
        </span>
        <span className="flex-1" />
        {editing && (
          <button
            className={btn}
            style={noDrag}
            onClick={() => {
              if (!confirmReset) return setConfirmReset(true)
              layout.reset()
              setConfirmReset(false)
            }}
            onBlur={() => setConfirmReset(false)}
          >
            {confirmReset ? 'Click again to reset' : 'Reset layout'}
          </button>
        )}
        <button className={editing ? 'rounded-md border border-accent bg-accent/20 px-2.5 py-1 text-xs text-text' : btn} style={noDrag} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done' : 'Customize'}
        </button>
        <button className={btn} style={noDrag} onClick={() => void window.api.monitor.toggleFullscreen().then(setFullscreen)} title="Fill this monitor (F11)">
          {fullscreen ? 'Leave fullscreen' : 'Fullscreen (F11)'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {(editing || !place) && (
          <div className="mb-4">
            <PlaceBar raw={raw} place={place} save={save} />
          </div>
        )}
        {editing && (
          <div className="mb-4">
            <AddWidgetTray hidden={layout.hidden} onAdd={layout.add} />
          </div>
        )}
        <DashboardGrid layout={layout} data={data} editing={editing} onFullscreen={onCardFullscreen} />
      </div>
    </div>
  )
}
