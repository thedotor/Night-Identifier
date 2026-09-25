import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTheme } from '@renderer/theme/ThemeContext'
import { CameraList } from '@renderer/components/live/CameraList'
import { CameraGrid, type GridLayout } from '@renderer/components/live/CameraGrid'
import { SingleView } from '@renderer/components/live/SingleView'
import { AddCameraDialog, EditCameraDialog } from '@renderer/components/live/CameraDialogs'
import { NO_OVERLAYS, type Overlays } from '@renderer/components/live/FeedCanvas'
import { useLiveCameras } from '@renderer/components/live/useLiveCameras'
import { btn, btnActive } from '@renderer/components/live/ui'

const SHOWN_KEY = 'live-view:hidden'
const LAYOUT_KEY = 'live-view:layout'
const RED_KEY = 'live-view:red'
const OVERLAY_KEY = 'live-view:overlays'

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* preferences just will not persist */
  }
}

const LAYOUTS: { id: GridLayout; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: '1', label: '1 col' },
  { id: '2', label: '2 cols' },
  { id: '3', label: '3 cols' }
]

export function LiveView(): ReactElement {
  const { cameras, loaded, error, refresh, connected } = useLiveCameras()
  const { theme } = useTheme()
  const [hidden, setHidden] = useState<string[]>(() => read(SHOWN_KEY, []))
  const [layout, setLayout] = useState<GridLayout>(() => read(LAYOUT_KEY, 'auto'))
  const [redPref, setRedPref] = useState<boolean | null>(() => read(RED_KEY, null))
  const [overlays, setOverlays] = useState<Overlays>(() => ({ ...NO_OVERLAYS, ...read<Partial<Overlays>>(OVERLAY_KEY, {}) }))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // The Red night-vision theme turns the picture red too, unless the user chose otherwise.
  const red = redPref ?? theme === 'red'
  const shown = useMemo(() => new Set(cameras.filter((c) => !hidden.includes(c.id)).map((c) => c.id)), [cameras, hidden])
  const gridCameras = useMemo(() => cameras.filter((c) => shown.has(c.id)).slice(0, 16), [cameras, shown])
  const selected = cameras.find((c) => c.id === selectedId) ?? null
  const editing = cameras.find((c) => c.id === editingId) ?? null

  useEffect(() => write(SHOWN_KEY, hidden), [hidden])
  useEffect(() => write(LAYOUT_KEY, layout), [layout])
  useEffect(() => write(RED_KEY, redPref), [redPref])
  useEffect(() => write(OVERLAY_KEY, overlays), [overlays])
  useEffect(() => {
    if (selectedId && loaded && !cameras.some((c) => c.id === selectedId)) setSelectedId(null)
  }, [cameras, loaded, selectedId])

  const toggleShown = (id: string): void => setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]))

  return (
    <div className="flex h-full">
      <CameraList
        cameras={cameras}
        selectedId={selectedId}
        shown={shown}
        onSelect={setSelectedId}
        onToggleShown={toggleShown}
        onEdit={setEditingId}
        onAdd={() => setAdding(true)}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <SingleView key={selected.id} camera={selected} red={red} overlays={overlays} onOverlays={setOverlays} onBack={() => setSelectedId(null)} onToggleRed={() => setRedPref(!red)} onChanged={() => void refresh()} />
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
              <h1 className="text-base font-semibold text-text">Live View</h1>
              {!connected && <span className="text-xs text-warning">Connecting to the backend…</span>}
              {error && <span className="text-xs text-danger">Could not load cameras: {error}</span>}
              <span className="flex-1" />
              <span className="text-xs text-text-muted">Layout</span>
              <div className="flex gap-1">
                {LAYOUTS.map((l) => (
                  <button key={l.id} className={layout === l.id ? btnActive : btn} onClick={() => setLayout(l.id)}>
                    {l.label}
                  </button>
                ))}
              </div>
              <button
                className={red ? btnActive : btn}
                onClick={() => setRedPref(!red)}
                title="Show the picture in red only, so it does not spoil your night vision"
              >
                Red filter
              </button>
            </div>
            <CameraGrid cameras={gridCameras} layout={layout} red={red} overlays={overlays} onOpen={setSelectedId} />
          </>
        )}
      </section>
      {adding && (
        <AddCameraDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            void refresh()
          }}
        />
      )}
      {editing && <EditCameraDialog camera={editing} onClose={() => setEditingId(null)} onChanged={() => void refresh()} />}
    </div>
  )
}
