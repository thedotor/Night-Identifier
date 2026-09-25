import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  api,
  ImageProperties,
  ObjectType,
  ResultImage,
  ResultsEvent,
  ResultsStatus,
  wsUrl
} from '@renderer/lib/api'
import { DetectionOverlayThumb } from '@renderer/components/results/DetectionOverlayThumb'
import { DetectionViewer } from '@renderer/components/results/DetectionViewer'
import { ContextMenu, ContextMenuItem } from '@renderer/components/ContextMenu'
import { PropertiesModal } from '@renderer/components/PropertiesModal'
import { previewUrl } from '@renderer/lib/api'

export function ResultsGallery(): ReactElement {
  const [status, setStatus] = useState<ResultsStatus | null>(null)
  const [results, setResults] = useState<ResultImage[]>([])
  const [objectTypes, setObjectTypes] = useState<ObjectType[]>([])
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewerImageId, setViewerImageId] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; imageId: number } | null>(
    null
  )
  const [properties, setProperties] = useState<ImageProperties | null>(null)
  const [sortNote, setSortNote] = useState<string | null>(null)

  const loadAll = (): void => {
    api.get<ResultsStatus>('/results/status').then(setStatus).catch(() => {})
    api.get<ResultImage[]>('/results/images').then(setResults).catch(() => {})
    api.get<ObjectType[]>('/objects?kind=all').then(setObjectTypes).catch(() => {})
  }

  useEffect(loadAll, [])

  useEffect(() => {
    const ws = new WebSocket(wsUrl('/results/ws'))
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as ResultsEvent
      if (event.type === 'start') {
        setProgress({ processed: 0, total: event.total })
      } else if (event.type === 'progress') {
        setProgress({ processed: event.processed, total: event.total })
      } else if (event.type === 'error') {
        setError(event.error)
        setProgress(null)
      } else if (event.type === 'completed' || event.type === 'stopped') {
        setProgress(null)
        loadAll()
      }
    }
    return () => ws.close()
  }, [])

  const objectTypesById = useMemo(() => new Map(objectTypes.map((o) => [o.id, o])), [objectTypes])

  const handleRun = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/results/run', {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start detection.')
    } finally {
      setBusy(false)
    }
  }

  const handleOrganise = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setSortNote(null)
    try {
      const r = await api.post<{ sorted: number; total: number }>('/results/organise')
      setSortNote(`Filed ${r.sorted} of ${r.total} identified photo${r.total === 1 ? '' : 's'} into their object folders.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sort the photos into folders.')
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.post('/results/stop')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop detection.')
    } finally {
      setBusy(false)
    }
  }

  const viewerEntry = results.find((r) => r.image.id === viewerImageId) ?? null

  const groupedResults = useMemo(() => {
    const groups = new Map<string, ResultImage[]>()
    for (const r of results) {
      const typeIds = new Set(r.detections.map((d) => d.object_type_id))
      const names =
        typeIds.size > 0
          ? [...typeIds].map((id) => objectTypesById.get(id)?.name ?? 'Unknown')
          : ['Unsorted']
      for (const name of names) {
        const bucket = groups.get(name)
        if (bucket) bucket.push(r)
        else groups.set(name, [r])
      }
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === 'Unsorted') return 1
      if (b === 'Unsorted') return -1
      return a.localeCompare(b)
    })
  }, [results, objectTypesById])

  const handleDeleteImage = async (imageId: number): Promise<void> => {
    if (!window.confirm('Delete this image? This cannot be undone.')) return
    const prev = results
    setResults((cur) => cur.filter((r) => r.image.id !== imageId))
    if (viewerImageId === imageId) setViewerImageId(null)
    try {
      await api.delete(`/images/${imageId}`)
    } catch {
      setResults(prev)
      setError('Failed to delete the image.')
    }
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
    },
    {
      label: 'Delete image',
      danger: true,
      onClick: () => handleDeleteImage(imageId)
    }
  ]

  return (
    <div className="flex h-full flex-col overflow-y-auto p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Results Gallery</h1>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            Run the trained model over your image library and browse the detected objects.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOrganise}
            disabled={busy || !!status?.is_running || results.length === 0}
            title="Move each identified photo into a folder named after the object found in it (this happens automatically for new detections)"
            className="rounded-md border border-border px-4 py-1.5 text-sm text-text hover:bg-surface disabled:opacity-50"
          >
            Sort into folders
          </button>
          {!status?.is_running ? (
            <button
              onClick={handleRun}
              disabled={busy || !status?.has_model}
              title={!status?.has_model ? 'Train a model first' : undefined}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
            >
              Run detection
            </button>
          ) : (
            <button
              onClick={handleStop}
              disabled={busy}
              className="rounded-md bg-danger px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {!status?.has_model && (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          No trained model yet &mdash; train one on the Train page first.
        </div>
      )}

      {sortNote && <div className="mt-4 text-sm text-text-muted">{sortNote}</div>}

      {progress && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-text-muted">
            <span>
              Processing {progress.processed} / {progress.total}
            </span>
            <span>{progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}%`
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-6">
        {groupedResults.map(([groupName, items]) => (
          <div key={groupName}>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {groupName} ({items.length})
            </div>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {items.map((r) => (
                <DetectionOverlayThumb
                  key={r.image.id}
                  image={r.image}
                  detections={r.detections}
                  onClick={() => setViewerImageId(r.image.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setContextMenu({ x: e.clientX, y: e.clientY, imageId: r.image.id })
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        {results.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            No processed images yet. Run detection to populate this gallery.
          </div>
        )}
      </div>

      {viewerEntry && (
        <DetectionViewer
          previewUrl={previewUrl(viewerEntry.image.id)}
          imageWidth={viewerEntry.image.width}
          imageHeight={viewerEntry.image.height}
          detections={viewerEntry.detections}
          objectTypesById={objectTypesById}
          onClose={() => setViewerImageId(null)}
        />
      )}

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
