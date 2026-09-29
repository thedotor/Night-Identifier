import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { useParams } from 'react-router-dom'
import { PlaceBar } from '@renderer/components/dashboard/SkyCards'
import { useDashData } from '@renderer/components/dashboard/useDashData'
import { usePlace } from '@renderer/components/dashboard/usePlace'
import { WIDGET_BY_ID } from '@renderer/components/dashboard/widgets'

const btn = 'rounded-md border border-border px-2.5 py-1 text-xs text-text-muted hover:border-accent hover:text-text'
const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/**
 * One dashboard card in a window of its own (the pop-out button on a card opens it), for another monitor.
 * The window remembers its screen, size and position; F11 makes it fill the monitor.
 */
export function CardWindow(): ReactElement {
  const { id = '' } = useParams()
  const def = WIDGET_BY_ID.get(id)
  const { place, raw, save } = usePlace()
  const data = useDashData(place)
  const [fullscreen, setFullscreen] = useState(false)
  const [width, setWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    document.title = def?.title ?? 'Night Identifier'
    window.api.monitor.state().then((s) => setFullscreen(s.fullscreen)).catch(() => undefined)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F11') return
      e.preventDefault()
      void window.api.monitor.toggleFullscreen().then(setFullscreen)
    }
    const onSize = (): void => setWidth(window.innerWidth)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onSize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onSize)
    }
  }, [def])

  // The 3D views fill the window as they are; the other cards are enlarged in a big window so they read from across a room.
  const zoom = id.startsWith('earth-') ? 1 : Math.min(2.4, Math.max(1, width / 900))

  return (
    <div className="flex h-screen flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3 pr-40 text-xs text-text-muted" style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
        <span className="truncate font-medium text-text">{def?.title ?? 'Unknown card'}</span>
        <span className="flex-1" />
        <button className={btn} style={noDrag} onClick={() => void window.api.monitor.toggleFullscreen().then(setFullscreen)} title="Fill this monitor (F11)">
          {fullscreen ? 'Leave fullscreen' : 'Fullscreen (F11)'}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!def ? (
          <div className="text-sm text-text-muted">This card no longer exists.</div>
        ) : (
          <>
            {!place && (
              <div className="mb-3">
                <PlaceBar raw={raw} place={place} save={save} />
              </div>
            )}
            <div className="h-full [&>*]:min-h-full" style={zoom !== 1 ? ({ zoom } as CSSProperties) : undefined}>
              {def.render(data)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
