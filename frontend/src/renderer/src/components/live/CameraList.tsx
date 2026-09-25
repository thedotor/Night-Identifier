import type { ReactElement } from 'react'
import type { LiveCamera } from '@renderer/lib/liveApi'
import { btnPrimary, stateDot, STATE_LABEL } from './ui'

interface Props {
  cameras: LiveCamera[]
  selectedId: string | null
  shown: Set<string>
  onSelect: (id: string) => void
  onToggleShown: (id: string) => void
  onEdit: (id: string) => void
  onAdd: () => void
}

const KIND_ICON: Record<string, string> = {
  uvc: '◙',
  rtsp: '⌁',
  mjpeg: '⌁',
  snapshot: '⌁',
  synthetic: '✦'
}

export function CameraList({ cameras, selectedId, shown, onSelect, onToggleShown, onEdit, onAdd }: Props): ReactElement {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between px-3 py-3">
        <h2 className="text-sm font-semibold text-text">Cameras</h2>
        <button onClick={onAdd} className={btnPrimary}>
          + Add camera
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {cameras.length === 0 && (
          <p className="px-2 py-4 text-xs leading-relaxed text-text-muted">
            No cameras yet. Click <span className="text-text">Add camera</span> to find webcams and astro cameras on this computer, or to enter the address of a network camera.
          </p>
        )}
        {cameras.map((c) => {
          const st = c.status
          const active = c.id === selectedId
          return (
            <div
              key={c.id}
              className={`group rounded-md border px-2 py-2 text-xs ${active ? 'border-accent bg-accent-muted/40' : 'border-transparent hover:bg-surface-raised'}`}
            >
              <div className="flex items-center gap-2">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(c.id)} title="Open single view">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${stateDot(st?.state)}`} />
                  <span className="w-3 shrink-0 text-center text-text-muted">{KIND_ICON[c.kind] ?? '◙'}</span>
                  <span className="truncate text-sm text-text">{c.name}</span>
                </button>
                <button
                  onClick={() => onToggleShown(c.id)}
                  title={shown.has(c.id) ? 'Shown in the grid (click to hide)' : 'Hidden from the grid (click to show)'}
                  className={`rounded px-1.5 py-0.5 ${shown.has(c.id) ? 'text-accent' : 'text-text-muted/50 hover:text-text'}`}
                >
                  {shown.has(c.id) ? '▣' : '▢'}
                </button>
                <button onClick={() => onEdit(c.id)} title="Camera settings" className="rounded px-1.5 py-0.5 text-text-muted hover:text-text">
                  ⚙
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between pl-6 text-[11px] text-text-muted">
                <span className="truncate">{st?.state === 'running' && st.width ? `${st.width}×${st.height} · ${st.fps} fps` : STATE_LABEL[st?.state ?? 'stopped']}</span>
                <span className="flex shrink-0 gap-1.5">
                  {st?.recording && <span className="text-danger" title="Recording">●</span>}
                  {st?.detecting && <span title="Watching for motion">◉</span>}
                  {c.background && <span title="Keeps running in the background">⏻</span>}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
