import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import {
  api,
  ImageProperties,
  ImageRecord,
  ScanEvent,
  WatchFolderStatus,
  previewUrl,
  wsUrl
} from '@renderer/lib/api'
import { ContextMenu, ContextMenuItem } from '@renderer/components/ContextMenu'
import { PropertiesModal } from '@renderer/components/PropertiesModal'

const FEED_LIMIT = 12

export function UploadWatch(): ReactElement {
  const [images, setImages] = useState<ImageRecord[]>([])
  const [watchStatus, setWatchStatus] = useState<WatchFolderStatus | null>(null)
  const [feed, setFeed] = useState<{ id: number; text: string; kind: ScanEvent['type'] }[]>([])
  const [importing, setImporting] = useState(false)
  const [moveOnImport, setMoveOnImport] = useState(false)
  const [changingFolder, setChangingFolder] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; imageId: number } | null>(
    null
  )
  const [properties, setProperties] = useState<ImageProperties | null>(null)
  const feedIdRef = useRef(0)

  const pushFeed = (text: string, kind: ScanEvent['type']): void => {
    feedIdRef.current += 1
    setFeed((prev) => [{ id: feedIdRef.current, text, kind }, ...prev].slice(0, FEED_LIMIT))
  }

  useEffect(() => {
    api.get<ImageRecord[]>('/images').then(setImages).catch(() => setError('Could not load images.'))
    api
      .get<WatchFolderStatus>('/images/watch-folder')
      .then(setWatchStatus)
      .catch(() => setError('Could not load watch folder status.'))
  }, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/images/ws'))
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ScanEvent
      if (event.type === 'watch_status') {
        setWatchStatus({ watching: event.watching, watch_dir: event.watch_dir ?? '' })
      } else if (event.type === 'scanning') {
        pushFeed(`Scanning ${event.filename}...`, event.type)
      } else if (event.type === 'imported') {
        pushFeed(`Imported ${event.image.filename}`, event.type)
        setImages((prev) =>
          prev.some((i) => i.id === event.image.id) ? prev : [event.image, ...prev]
        )
      } else if (event.type === 'skipped') {
        pushFeed(`Skipped ${event.filename} (${event.reason})`, event.type)
      }
    }
    return () => ws.close()
  }, [])

  const importPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    setImporting(true)
    setError(null)
    try {
      const result = await api.post<{ imported: ImageRecord[]; skipped: string[] }>(
        '/images/import',
        { paths, move: moveOnImport }
      )
      setImages((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        return [...result.imported.filter((i) => !existingIds.has(i.id)), ...prev]
      })
      if (result.skipped.length > 0) {
        setError(`${result.skipped.length} file(s) could not be imported (unsupported format).`)
      }
    } catch {
      setError('Import failed.')
    } finally {
      setImporting(false)
    }
  }

  const handleAddImages = async (): Promise<void> => {
    const paths = await window.api.selectFiles()
    await importPaths(paths)
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setDragActive(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return window.api.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    await importPaths(paths)
  }

  const handleChangeFolder = async (): Promise<void> => {
    const dir = await window.api.selectDirectory()
    if (!dir) return
    setChangingFolder(true)
    setError(null)
    try {
      const status = await api.put<WatchFolderStatus>('/images/watch-folder', { path: dir })
      setWatchStatus(status)
    } catch {
      setError('Failed to change watch folder.')
    } finally {
      setChangingFolder(false)
    }
  }

  const openContextMenu = (e: ReactMouseEvent, imageId: number): void => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, imageId })
  }

  const buildContextItems = (imageId: number): ContextMenuItem[] => [
    {
      label: 'Open image',
      onClick: async () => {
        const props = await api.get<ImageProperties>(`/images/${imageId}/properties`)
        window.api.openPath(props.stored_path)
      }
    },
    {
      label: 'Open file location',
      onClick: async () => {
        const props = await api.get<ImageProperties>(`/images/${imageId}/properties`)
        window.api.showItemInFolder(props.stored_path)
      }
    },
    {
      label: 'Properties',
      onClick: async () => {
        const props = await api.get<ImageProperties>(`/images/${imageId}/properties`)
        setProperties(props)
      }
    }
  ]

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <h1 className="text-xl font-semibold text-text">Upload &amp; Watch Folder</h1>
      <p className="mt-2 max-w-2xl text-sm text-text-muted">
        Add images manually, or drop them into the watched folder to have them scanned in
        automatically.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Manual upload */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragActive ? 'border-accent bg-accent-muted/20' : 'border-border'
          }`}
        >
          <div className="text-sm text-text">Drag and drop images here</div>
          <div className="mt-1 text-xs text-text-muted">RAW, CR2, TIFF, JPEG, PNG and more</div>
          <button
            onClick={handleAddImages}
            disabled={importing}
            className="mt-4 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            {importing ? 'Importing...' : '+ Add images'}
          </button>
          <div className="mt-3 flex items-center gap-3 text-xs text-text-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="import-mode"
                checked={!moveOnImport}
                onChange={() => setMoveOnImport(false)}
              />
              Copy
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="import-mode"
                checked={moveOnImport}
                onChange={() => setMoveOnImport(true)}
              />
              Move (removes original)
            </label>
          </div>
        </div>

        {/* Watch folder */}
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-text">Watched folder</div>
            <span
              className={`flex items-center gap-1.5 text-xs ${
                watchStatus?.watching ? 'text-success' : 'text-text-muted'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  watchStatus?.watching ? 'bg-success' : 'bg-text-muted'
                }`}
              />
              {watchStatus?.watching ? 'Watching' : 'Idle'}
            </span>
          </div>
          <div className="mt-2 truncate rounded-md bg-bg px-3 py-2 font-mono text-xs text-text-muted">
            {watchStatus?.watch_dir ?? 'Loading...'}
          </div>
          <button
            onClick={handleChangeFolder}
            disabled={changingFolder}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:border-accent hover:text-text disabled:opacity-50"
          >
            Change folder
          </button>

          <div className="mt-4 max-h-32 overflow-y-auto rounded-md border border-border">
            {feed.length === 0 && (
              <div className="p-3 text-xs text-text-muted">
                No activity yet. New files dropped into the watched folder appear here.
              </div>
            )}
            {feed.map((f) => (
              <div
                key={f.id}
                className={`border-b border-border px-3 py-1.5 text-xs last:border-b-0 ${
                  f.kind === 'skipped' ? 'text-danger' : 'text-text-muted'
                }`}
              >
                {f.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Library ({images.length})
        </div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {images.map((img) => (
            <div
              key={img.id}
              onContextMenu={(e) => openContextMenu(e, img.id)}
              className="overflow-hidden rounded-md border border-border bg-surface"
            >
              <img
                src={previewUrl(img.id)}
                alt={img.filename}
                className="aspect-square w-full object-cover"
              />
              <div className="truncate px-2 py-1 text-[10px] text-text-muted">{img.filename}</div>
            </div>
          ))}
          {images.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
              No images yet.
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildContextItems(contextMenu.imageId)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {properties && <PropertiesModal properties={properties} onClose={() => setProperties(null)} />}
    </div>
  )
}
