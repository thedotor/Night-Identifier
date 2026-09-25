import { useMemo, type ReactElement } from 'react'
import type { LiveCamera } from '@renderer/lib/liveApi'
import { live } from '@renderer/lib/liveApi'
import { FeedCanvas, type Overlays } from './FeedCanvas'
import { btn, STATE_LABEL, stateDot } from './ui'

export type GridLayout = 'auto' | '1' | '2' | '3' | '4'

export function gridColumns(count: number, layout: GridLayout): number {
  if (layout !== 'auto') return Number(layout)
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

interface TileProps {
  camera: LiveCamera
  red: boolean
  overlays: Overlays
  cols: number
  onOpen: () => void
}

function Tile({ camera, red, overlays, cols, onOpen }: TileProps): ReactElement {
  const st = camera.status
  const running = st?.state === 'running'
  // A modest size and rate keep 9 tiles cheap; the single view asks for full detail.
  const sub = useMemo(() => ({ width: cols >= 3 ? 480 : 720, fps: cols >= 3 ? 6 : 10 }), [cols])
  const problem = st && st.state !== 'running' && st.state !== 'connecting'
  return (
    <div className="group relative flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-black">
      <div className="min-h-0 flex-1 cursor-pointer" onClick={onOpen} title="Open single view with tools">
        <FeedCanvas camId={camera.id} sub={sub} red={red} overlays={overlays} waitingText={null} className="h-full w-full" />
      </div>
      {(!st || st.state === 'connecting' || problem) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-4 text-center">
          <span className="text-xs text-text">{STATE_LABEL[st?.state ?? 'connecting']}</span>
          {st?.error && <span className="max-w-full text-[11px] leading-snug text-text-muted">{st.error}</span>}
          {problem && st?.state !== 'lost' && (
            <button className={`${btn} pointer-events-auto`} onClick={() => void live.start(camera.id)}>
              Try again
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border bg-surface px-2 py-1 text-[11px]">
        <span className={`h-2 w-2 rounded-full ${stateDot(st?.state)}`} />
        <span className="min-w-0 flex-1 truncate text-text">{camera.name}</span>
        {st?.recording && <span className="text-danger">● REC</span>}
        {running && <span className="text-text-muted">{st?.fps} fps</span>}
      </div>
    </div>
  )
}

export function CameraGrid({
  cameras,
  layout,
  red,
  overlays,
  onOpen
}: {
  cameras: LiveCamera[]
  layout: GridLayout
  red: boolean
  overlays: Overlays
  onOpen: (id: string) => void
}): ReactElement {
  const cols = gridColumns(cameras.length, layout)
  const rows = Math.max(1, Math.ceil(cameras.length / cols))
  if (cameras.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-muted">
        No cameras are shown in the grid. Add a camera, or click the ▢ box next to one in the list to show it here.
      </div>
    )
  }
  return (
    <div
      className="grid min-h-0 flex-1 gap-2 p-3"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {cameras.map((c) => (
        <Tile key={c.id} camera={c} red={red} overlays={overlays} cols={cols} onOpen={() => onOpen(c.id)} />
      ))}
    </div>
  )
}
